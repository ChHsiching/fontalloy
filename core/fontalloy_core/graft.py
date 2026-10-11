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
- Normalization (ADR-0003, issue #8) rides the same surgery: each donor
  glyph scales by the donor's planned factor about the shared baseline
  (zero vertical displacement — coordinates and composite offsets scale,
  component 2x2 matrices do not, exactly what ``scale_upem`` does
  font-wide), the advance re-grids per UAX #11 (Fullwidth/Wide two
  cells, everything else one), and the side bearing rides the same
  scale. CFF donors carry the scale through the cu2qu pen chain.
- Donor hinting never survives the graft: per-glyph instructions are
  stripped (a scaled outline with unscaled hinting would misrender, and
  ADR-0003 drops donor hinting outright). No other donor table is read,
  so donor kern/GPOS/GDEF cannot enter the container — the base keeps
  its own.
- The cmap is rebuilt from the effective table, never merged table-wise:
  a format 4 subtable (Windows Unicode BMP) plus a format 12 subtable
  (Windows UCS-4) whenever an astral codepoint is present — mirroring
  what fontTools' own fontBuilder emits.
- After the graft, ``usWinAscent``/``usWinDescent`` grow — only ever
  grow, and only over the grafted ink — to prevent clipping (the base's
  own glyphs keep their shipped clipping behavior). hhea and the
  OS/2 typo metrics are never touched here: line height fully inherits
  the base font.
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
from fontTools.misc.fixedTools import otRound
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.transformPen import TransformPen
from fontTools.misc.transform import Transform
from fontTools.ttLib import TTFont, newTable

from fontalloy_core.errors import BuildError
from fontalloy_core.normalize import NormalizationPlan
from fontalloy_core.precedence import EffectiveEntry

#: Prefix separating the donor index from the donor's own glyph name.
_DONOR_SEPARATOR = "."


def graft_effective_glyphs(
    base: TTFont,
    donors: Mapping[str, TTFont],
    effective_table: Sequence[EffectiveEntry],
    plan: NormalizationPlan,
) -> None:
    """Graft donor glyphs into ``base`` per the effective table, in place.

    ``donors`` maps donor ids (``"donor-<index>"``) to loaded fonts, in
    join order. Base-won codepoints keep the base font's own glyphs and
    cmap mappings; donor-won codepoints map to freshly grafted glyphs,
    each normalized onto the base's metrics per ``plan`` (ADR-0003).
    """
    base_cmap = dict(base.getBestCmap())
    # Per donor, the glyph names to graft (winning glyphs plus composite
    # closure), in first-encounter order — the effective table is sorted
    # by codepoint, so the order is deterministic.
    closure: dict[str, list[str]] = {}
    seen: dict[str, set[str]] = {}
    # The first winning codepoint each mapped donor glyph serves (a donor
    # glyph can be mapped at several codepoints of different UAX #11
    # classes; the lowest codepoint's class wins, deterministically).
    mapped_at: dict[str, dict[str, int]] = {}
    for entry in effective_table:
        if entry.winner == "base":
            continue
        donor = donors[entry.winner]
        names = closure.setdefault(entry.winner, [])
        known = seen.setdefault(entry.winner, set())
        donor_name = _donor_glyph_for(donor, entry.codepoint)
        mapped_at.setdefault(entry.winner, {}).setdefault(donor_name, entry.codepoint)
        if donor_name not in known:
            _collect_with_components(donor, donor_name, names, known)

    if not any(closure.values()):
        return  # nothing to graft: the base passes through untouched

    order = list(base.getGlyphOrder())
    for donor_id, donor in donors.items():  # join order
        scale = plan.scale_for(donor_id)
        for name in closure.get(donor_id, ()):
            out_name = _prefixed(donor_id, name)
            order.append(out_name)
            codepoint = mapped_at.get(donor_id, {}).get(name)
            _copy_glyph(base, donor, donor_id, name, out_name, scale, plan, codepoint)
    base.setGlyphOrder(order)

    mapping = {
        entry.codepoint: (
            base_cmap[entry.codepoint]
            if entry.winner == "base"
            else _prefixed(
                entry.winner,
                _donor_glyph_for(donors[entry.winner], entry.codepoint),
            )
        )
        for entry in effective_table
    }
    _rebuild_cmap(base, mapping)
    grafted_names = [
        _prefixed(donor_id, name)
        for donor_id in donors  # join order
        for name in closure.get(donor_id, ())
    ]
    _grow_win_metrics(base, grafted_names)
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
    base: TTFont,
    donor: TTFont,
    donor_id: str,
    name: str,
    out_name: str,
    scale: float,
    plan: NormalizationPlan,
    codepoint: int | None,
) -> None:
    """Copy one donor glyph into ``base``, normalized (ADR-0003).

    The outline scales by ``scale`` about the shared baseline; a mapped
    winner's advance re-grids per UAX #11 through ``plan`` (an unmapped
    composite component keeps its own scaled advance); the side bearing
    rides the outline scale; donor hinting is stripped.

    The donor's glyph object is deep-copied before its components are
    re-pointed and its outline scaled: a TTC-output build grafts the
    same donor face into every base face, and mutating a shared object
    twice would double the prefix (``d0.d0.…``) and double the scale.
    The copy also keeps the donor's in-memory tables pristine for the
    next face.
    """
    donor_advance, donor_lsb = donor["hmtx"][name]
    if "glyf" in donor:
        glyph = copy.deepcopy(donor["glyf"][name])
        # Re-point composite components at the prefixed private copies;
        # the reference is by name in-session and by index once compiled.
        for component in getattr(glyph, "components", None) or ():
            component.glyphName = _prefixed(donor_id, component.glyphName)
        _scale_glyf_glyph(glyph, scale)
        # Donor hinting never enters: the donor's instructions describe
        # its unscaled outline (ADR-0003 drops donor hinting outright).
        glyph.removeHinting()
        base["glyf"][out_name] = glyph
    elif "CFF " in donor or "CFF2" in donor:
        base["glyf"][out_name] = _convert_cff_glyph(donor, name, scale)
    else:
        raise BuildError(
            f"donor glyph {name!r} has no graftable outlines "
            "(neither glyf nor CFF)"
        )
    advance = (
        plan.advance_for(codepoint)
        if codepoint is not None
        else otRound(donor_advance * scale)
    )
    base["hmtx"][out_name] = (advance, otRound(donor_lsb * scale))


def _scale_glyf_glyph(glyph, scale: float) -> None:
    """Scale one TrueType glyph by ``scale`` about the origin, in place.

    Exactly what ``fontTools.ttLib.scaleUpem`` does font-wide: simple
    glyphs scale their coordinates, composites scale their component
    offsets (the referenced glyphs scale individually — the same closure
    — so the assembled ink scales once), and component 2x2 matrices stay
    untouched. No translation: zero vertical displacement (ADR-0003).
    """
    if glyph.isComposite():
        for component in glyph.components:
            component.x = otRound(component.x * scale)
            component.y = otRound(component.y * scale)
    elif getattr(glyph, "coordinates", None) is not None:
        coordinates = glyph.coordinates
        for index, (x, y) in enumerate(coordinates):
            coordinates[index] = otRound(x * scale), otRound(y * scale)
    for attr in ("xMin", "yMin", "xMax", "yMax"):
        value = getattr(glyph, attr, None)
        if value is not None:
            setattr(glyph, attr, otRound(value * scale))


def _convert_cff_glyph(donor: TTFont, name: str, scale: float):
    """Draw a CFF glyph into scaled quadratic TrueType outlines
    (OTF in, TTF out); the stage-4 scale rides the pen chain."""
    max_err = donor["head"].unitsPerEm / 1000  # ~1 unit at 1000 upem
    pen = TTGlyphPen(None)
    donor.getGlyphSet()[name].draw(
        TransformPen(
            Cu2QuPen(pen, max_err, reverse_direction=True),
            Transform().scale(scale, scale),
        )
    )
    return pen.glyph()


def _grow_win_metrics(base: TTFont, grafted_names: Sequence[str]) -> None:
    """Grow usWinAscent/usWinDescent to cover the grafted ink (only ever
    grow — ADR-0003: prevent clipping, change nothing else).

    Only what normalization added is considered: the base font's own
    glyphs keep whatever clipping behavior they shipped with — that is
    part of the inherited line-height contract (a Nerd-Font base's tall
    PUA icons routinely exceed its own win metrics by design, and the
    anchor build must be zero table changes). hhea and the OS/2 typo
    metrics are never touched here.
    """
    os2 = base.get("OS/2")
    if os2 is None:
        return
    glyf = base["glyf"]
    y_max, y_min = 0, 0
    for name in grafted_names:
        glyph = glyf[name]  # glyph access expands lazy glyph data
        if glyph.numberOfContours == 0:
            continue  # empty outlines carry no ink
        glyph.recalcBounds(glyf)
        if glyph.yMax > y_max:
            y_max = glyph.yMax
        if glyph.yMin < y_min:
            y_min = glyph.yMin
    os2.usWinAscent = max(os2.usWinAscent, y_max)
    os2.usWinDescent = max(os2.usWinDescent, -y_min)


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
