"""Pipeline stages 3 and 5: extract donor glyphs, graft, rebuild cmap.

The base font is the container (ADR-0001): donor glyphs move in per the
effective table, glyph by glyph — never a whole-table merge. The verified
route (see the fontTools research note) is direct ``glyf`` surgery:

- Every grafted glyph gets a per-donor namespace prefix (``d0.name``) so
  it can never silently attach to a base glyph of the same name; private
  copies are always taken, even when the base has no such name.
- Composite (compound) glyphs bring their components along: the closure
  walks ``glyf`` components recursively, and each component reference is
  re-pointed at the prefixed private copy. In the binary, components
  reference glyph indices, so pre-save renaming is safe.
- ``hmtx`` entries (advance, side bearing) copy verbatim — scaling is
  stage 4 (normalization, a later ticket); at this stage nothing is
  scaled.
- The cmap is rebuilt from the effective table, never merged table-wise:
  a format 4 subtable (Windows Unicode BMP) plus a format 12 subtable
  (Windows UCS-4) whenever an astral codepoint is present — mirroring
  what fontTools' own fontBuilder emits.
- Glyph names only survive save/load through a ``post`` format 2.0
  table written in the same save: the base's post values are kept and
  the format upgraded, so the grafted names persist in the output and
  provenance stays readable from the built font.

A donor whose winning glyph set is empty grafts nothing, and a build
where no donor wins any codepoint leaves the base font untouched
(the v0 pass-through bytes).
"""

from __future__ import annotations

import copy
import struct
from collections.abc import Mapping, Sequence

from fontTools.fontBuilder import buildCmapSubTable
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont, newTable

from fontalloy_core.errors import BuildError
from fontalloy_core.precedence import EffectiveEntry

#: Prefix separating the donor index from the donor's own glyph name.
_DONOR_SEPARATOR = "."


def graft_effective_glyphs(
    base: TTFont,
    donors: Mapping[str, TTFont],
    effective_table: Sequence[EffectiveEntry],
) -> None:
    """Graft donor glyphs into ``base`` per the effective table, in place.

    ``donors`` maps donor ids (``"donor-<index>"``) to loaded fonts, in
    join order. Base-won codepoints keep the base font's own glyphs and
    cmap mappings; donor-won codepoints map to freshly grafted glyphs.
    """
    base_cmap = dict(base.getBestCmap())
    # Per donor, the glyph names to graft (winning glyphs plus composite
    # closure), in first-encounter order — the effective table is sorted
    # by codepoint, so the order is deterministic.
    closure: dict[str, list[str]] = {}
    seen: dict[str, set[str]] = {}
    for entry in effective_table:
        if entry.winner == "base":
            continue
        donor = donors[entry.winner]
        names = closure.setdefault(entry.winner, [])
        known = seen.setdefault(entry.winner, set())
        donor_name = _donor_glyph_for(donor, entry.codepoint)
        if donor_name not in known:
            _collect_with_components(donor, donor_name, names, known)

    if not any(closure.values()):
        return  # nothing to graft: the base passes through untouched

    order = list(base.getGlyphOrder())
    for donor_id, donor in donors.items():  # join order
        for name in closure.get(donor_id, ()):
            out_name = _prefixed(donor_id, name)
            order.append(out_name)
            _copy_glyph(base, donor, donor_id, name, out_name)
    base.setGlyphOrder(order)

    mapping = {
        entry.codepoint: (
            base_cmap[entry.codepoint]
            if entry.winner == "base"
            else _prefixed(entry.winner, _donor_glyph_for(donors[entry.winner], entry.codepoint))
        )
        for entry in effective_table
    }
    _rebuild_cmap(base, mapping)
    _persist_glyph_names(base)


def _donor_glyph_for(donor: TTFont, codepoint: int) -> str:
    """The donor's glyph mapped at ``codepoint`` (the resolver guarantees presence)."""
    try:
        return donor.getBestCmap()[codepoint]
    except KeyError:  # pragma: no cover — the effective table spans coverage
        raise BuildError(
            f"donor glyph lookup failed at codepoint {codepoint:#x}"
        ) from None


def _collect_with_components(
    donor: TTFont, name: str, names: list[str], known: set[str]
) -> None:
    """Append ``name`` and its composite-component closure (depth first)."""
    known.add(name)
    names.append(name)
    if "glyf" not in donor:  # CFF outlines have no composite references
        return
    glyph = donor["glyf"][name]
    for component in getattr(glyph, "components", None) or ():
        if component.glyphName not in known:
            _collect_with_components(donor, component.glyphName, names, known)


def _copy_glyph(
    base: TTFont, donor: TTFont, donor_id: str, name: str, out_name: str
) -> None:
    """Copy one donor glyph (outlines, components, metrics) into ``base``.

    The donor's glyph object is deep-copied before its components are
    re-pointed: a TTC-output build grafts the same donor face into every
    base face, and re-pointing a shared object twice would double the
    prefix (``d0.d0.…``) and break the component lookup. The copy also
    keeps the donor's in-memory tables pristine for the next face.
    """
    if "glyf" in donor:
        glyph = copy.deepcopy(donor["glyf"][name])
        # Re-point composite components at the prefixed private copies;
        # the reference is by name in-session and by index once compiled.
        for component in getattr(glyph, "components", None) or ():
            component.glyphName = _prefixed(donor_id, component.glyphName)
        base["glyf"][out_name] = glyph
    elif "CFF " in donor or "CFF2" in donor:
        base["glyf"][out_name] = _convert_cff_glyph(donor, name)
    else:
        raise BuildError(
            f"donor glyph {name!r} has no graftable outlines "
            "(neither glyf nor CFF)"
        )
    base["hmtx"][out_name] = tuple(donor["hmtx"][name])


def _convert_cff_glyph(donor: TTFont, name: str):
    """Draw a CFF glyph into quadratic TrueType outlines (OTF in, TTF out)."""
    max_err = donor["head"].unitsPerEm / 1000  # ~1 unit at 1000 upem
    pen = TTGlyphPen(None)
    donor.getGlyphSet()[name].draw(
        Cu2QuPen(pen, max_err, reverse_direction=True)
    )
    return pen.glyph()


def _rebuild_cmap(font: TTFont, mapping: dict[int, str]) -> None:
    """Replace the cmap with the effective mapping (format 4 + format 12)."""
    subtables = []
    if max(mapping, default=0) > 0xFFFF:
        # UCS-4 subtable carries the complete mapping; the BMP subtable
        # carries its subset (getBestCmap prefers the UCS-4 one).
        subtables.append(buildCmapSubTable(dict(mapping), 12, 3, 10))
        bmp = {cp: glyph for cp, glyph in mapping.items() if cp < 0x10000}
    else:
        bmp = dict(mapping)

    format_ = 4
    windows = buildCmapSubTable(bmp, format_, 3, 1)
    try:
        windows.compile(font)  # probe: format 4 cannot exceed 65535 segments
    except struct.error:
        format_ = 12
        windows = buildCmapSubTable(bmp, format_, 3, 1)
    subtables.append(windows)
    subtables.append(buildCmapSubTable(bmp, format_, 0, 3))

    cmap = newTable("cmap")
    cmap.tableVersion = 0
    cmap.tables = subtables
    font["cmap"] = cmap


#: post-table defaults for a base font that shipped without a post table.
_POST_DEFAULTS = {
    "italicAngle": 0.0,
    "underlinePosition": 0,
    "underlineThickness": 0,
    "isFixedPitch": 0,
    "minMemType42": 0,
    "maxMemType42": 0,
    "minMemType1": 0,
    "maxMemType1": 0,
}


def _persist_glyph_names(font: TTFont) -> None:
    """Upgrade post to format 2.0 so glyph names survive the save.

    The base font's own post values (italic angle, underline metrics)
    pass through; only the format changes, because names round-trip
    through post 2.0 and nothing else. Without it, getGlyphOrder()
    after a reload falls back to cmap-derived names and the grafted
    namespace is lost.
    """
    if "post" in font:
        post = font["post"]
    else:
        post = newTable("post")
        for key, value in _POST_DEFAULTS.items():
            setattr(post, key, value)
        font["post"] = post
    post.formatType = 2.0
    post.extraNames = []
    post.mapping = {}


def _prefixed(donor_id: str, name: str) -> str:
    """A grafted glyph's name: ``donor-0`` + ``uni4E2D`` → ``d0.uni4E2D``."""
    index = donor_id.split("-", 1)[1]
    return f"d{index}{_DONOR_SEPARATOR}{name}"
