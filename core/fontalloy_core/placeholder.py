"""The placeholder-glyph detection (round 18, rules fixed round 19).

Some fonts draw a placeholder glyph — a box, a boxed X, a question
face — at codepoints they do not really cover. Left undetected, those
mappings poison coverage counts (the font looks bigger than it is) and,
worse, graft tofu into builds as if it were a real glyph. This module
is the single detection point every coverage consumer goes through,
and it follows the OpenType conventions alone (round 19 — the owner
rejected the concentration thresholds; a real shared glyph, however
many codepoints it absorbs, is coverage):

- Rule 1: a codepoint mapped to glyph 0 (``.notdef``) is absent by
  convention — the font is saying nothing there, so it is neither
  coverage nor a placeholder.
- Rule 2: a codepoint whose mapped glyph has the SAME OUTLINE as the
  font's own ``.notdef`` glyph is a suspected placeholder — the font
  drew its tofu box under another name. Outline equality is geometric
  (the recorded drawing), never nominal: name, advance, and hinting are
  not part of it.

The outline compare is kept cheap: a fast pre-filter (same contour
count + same bounding box + same point count) rejects the overwhelming
majority of a face's glyphs before any pen work, and only the survivors
are drawn. The pre-filter reads the raw glyf record header (the glyph
stays lazily compiled — memory and time both), falling back to the
decompiled attributes when a glyph was already expanded. CFF faces have
no such header: the charstring byte length is the pre-filter there
(equal recorded ops imply equal length), and survivors are decomposed
and compared as recorded charstring ops. An EMPTY ``.notdef`` outline
carries no box evidence — rule 2 never fires for it, so a font with a
blank ``.notdef`` does not flag its blank glyphs (space, ZWSP).

The GUI preview path (``gui/src/fonts/sfnt.ts``) mirrors both rules so
the live coverage numbers match the report's.

The result feeds every downstream stage through
:func:`fontalloy_core.build`'s coverage seam: codepoints in the
placeholder set count as NOT covered (coverage and missing statistics,
never eligible as donor fill — the effective table never contains them,
so a placeholder is never grafted) and the report's per-source records
state how many each source carried (``placeholder_codepoints``).
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.ttLib import TTFont


@dataclass(frozen=True)
class FaceCoverage:
    """One face's honest coverage, placeholder detection included.

    ``codepoints`` is the cmap minus glyph-0 mappings minus suspected
    placeholder mappings — the set every coverage decision uses.
    ``placeholders`` is the suspected-placeholder set itself (a subset
    of the raw cmap, disjoint from ``codepoints``); the report surfaces
    its size per source.
    """

    codepoints: frozenset[int]
    placeholders: frozenset[int]


def face_coverage(font: TTFont) -> FaceCoverage:
    """Compute one face's effective coverage and placeholder set.

    Rule 1 drops glyph-0 mappings first; rule 2 then tests every
    DISTINCT glyph the effective cmap names against the face's own
    ``.notdef`` outline.
    """
    order = font.getGlyphOrder()
    if not order:
        return FaceCoverage(codepoints=frozenset(), placeholders=frozenset())
    zero = order[0]
    effective = {
        codepoint: name
        for codepoint, name in font.getBestCmap().items()
        if name != zero
    }
    if not effective:
        return FaceCoverage(codepoints=frozenset(), placeholders=frozenset())

    suspects = _notdef_outline_suspects(font, zero, set(effective.values()))
    if not suspects:
        return FaceCoverage(
            codepoints=frozenset(effective), placeholders=frozenset()
        )
    return FaceCoverage(
        codepoints=frozenset(
            codepoint
            for codepoint, name in effective.items()
            if name not in suspects
        ),
        placeholders=frozenset(
            codepoint
            for codepoint, name in effective.items()
            if name in suspects
        ),
    )


# --- rule 2: the .notdef-outline compare ---------------------------------

#: The raw glyf record header: contour count + bounding box.
_GLYPH_HEADER = struct.Struct(">hhhhh")

#: Marks an unknown pre-filter point count (composites must decompose).
_UNKNOWN = -1


def _notdef_outline_suspects(
    font: TTFont, notdef: str, names: set[str]
) -> set[str]:
    """Which of ``names`` draw the same outline as the ``.notdef`` glyph.

    Empty set when the face carries no ``glyf``/``CFF `` outlines or its
    ``.notdef`` outline is empty (no box evidence — nothing is flagged).
    """
    if "glyf" in font:
        return _glyf_suspects(font, font["glyf"], notdef, names)
    charstrings = (
        font["CFF "].cff.topDictIndex[0].CharStrings
        if "CFF " in font
        else None
    )
    if charstrings is None:
        return set()
    return _cff_suspects(font, charstrings, notdef, names)


def _glyf_shape_key(glyf, name: str) -> tuple[int, int, int, int, int, int]:
    """The cheap pre-filter key: contours, bbox, and point count.

    Identical outlines necessarily share the key, so key inequality is
    a sound rejection. The point count is unavailable for composites
    without decomposing them (``_UNKNOWN``); a composite can never be
    key-equal to a simple ``.notdef`` because the contour counts differ
    in kind, and composite-vs-composite survivors fall through to the
    full decomposed compare.
    """
    glyph = glyf.glyphs[name]
    data = getattr(glyph, "data", None)
    if data is None:
        # Already expanded elsewhere: read the decompiled attributes. An
        # expanded EMPTY glyph carries only numberOfContours == 0 (the
        # expand short-circuit unpacks no header for it).
        contours = getattr(glyph, "numberOfContours", 0)
        if contours == 0:
            return (0, 0, 0, 0, 0, 0)
        bbox = (glyph.xMin, glyph.yMin, glyph.xMax, glyph.yMax)
        if contours < 0:
            return (contours, *bbox, _UNKNOWN)
        return (contours, *bbox, len(glyph.coordinates))
    if not data:
        return (0, 0, 0, 0, 0, 0)
    contours, x_min, y_min, x_max, y_max = _GLYPH_HEADER.unpack_from(data)
    if contours < 0:
        return (contours, x_min, y_min, x_max, y_max, _UNKNOWN)
    if contours == 0:
        return (0, x_min, y_min, x_max, y_max, 0)
    # The last end point + 1 is the glyph's point count — read straight
    # from the raw record, coordinates and flags untouched.
    last_end = struct.unpack_from(f">{contours}H", data, _GLYPH_HEADER.size)[-1]
    return (contours, x_min, y_min, x_max, y_max, last_end + 1)


def _glyf_suspects(font: TTFont, glyf, notdef: str, names: set[str]) -> set[str]:
    notdef_key = _glyf_shape_key(glyf, notdef)
    if notdef_key[0] <= 0:
        # An empty (or composite) .notdef carries no simple box
        # evidence — an empty one would flag every blank glyph (space,
        # ZWSP) of a blank-.notdef font, so rule 2 stays off. A
        # composite .notdef falls back to the decomposed compare.
        if notdef_key[0] == 0:
            return set()
        return _decomposed_suspects(font, notdef, names)
    glyph_set = font.getGlyphSet()
    notdef_ops: tuple | None = None
    suspects: set[str] = set()
    for name in names:
        if _glyf_shape_key(glyf, name) != notdef_key:
            continue
        if notdef_ops is None:
            notdef_ops = _recorded_outline(glyph_set, notdef)
            if not notdef_ops:
                return set()
        if _recorded_outline(glyph_set, name) == notdef_ops:
            suspects.add(name)
    return suspects


def _cff_suspects(font: TTFont, charstrings, notdef: str, names: set[str]):
    try:
        notdef_length = len(_charstring_bytes(charstrings[notdef]))
    except (KeyError, TypeError):
        return set()
    glyph_set = font.getGlyphSet()
    notdef_ops: tuple | None = None
    suspects: set[str] = set()
    for name in names:
        if name == notdef:
            continue
        raw = _charstring_bytes(charstrings[name])
        if raw is None or len(raw) != notdef_length:
            continue
        if notdef_ops is None:
            notdef_ops = _recorded_outline(glyph_set, notdef)
            if not notdef_ops:
                return set()
        if _recorded_outline(glyph_set, name) == notdef_ops:
            suspects.add(name)
    return suspects


def _decomposed_suspects(font: TTFont, notdef: str, names: set[str]) -> set[str]:
    """The no-prefilter fallback: decompose .notdef and compare ops."""
    glyph_set = font.getGlyphSet()
    notdef_ops = _recorded_outline(glyph_set, notdef)
    if not notdef_ops:
        return set()
    return {
        name for name in names if _recorded_outline(glyph_set, name) == notdef_ops
    }


def _recorded_outline(glyph_set, name: str) -> tuple:
    """The glyph's drawing as recorded pen operations (components
    decomposed), the geometric identity rule 2 compares."""
    pen = DecomposingRecordingPen(glyph_set)
    glyph_set[name].draw(pen)
    return pen.value


def _charstring_bytes(program) -> bytes | None:
    """The charstring's compiled bytecode, when still available."""
    return getattr(program, "bytecode", None)
