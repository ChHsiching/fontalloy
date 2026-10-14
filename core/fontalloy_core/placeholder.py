"""The placeholder-glyph heuristic (round 18, owner item 2b).

Some fonts draw a placeholder glyph — a box, a boxed X, a question
face — at codepoints they do not really cover. Left undetected, those
mappings poison coverage counts (the font looks bigger than it is) and,
worse, graft tofu into builds as if it were a real glyph. This module
is the single detection point every coverage consumer goes through:

- A codepoint mapped to glyph 0 (``.notdef``) is absent by convention —
  the font is saying nothing there, so it is neither coverage nor a
  placeholder.
- Concentration: one glyph NAME absorbing an implausible number of
  codepoints is a suspected placeholder. Real shared glyphs (space, the
  big-parenthesis pieces, digits in some layouts) stay tiny; a font
  faking a whole block funnels hundreds or thousands of codepoints into
  one box. A glyph is suspected once it absorbs at least
  :data:`PLACEHOLDER_MIN_CODEPOINTS` codepoints AND at least
  :data:`PLACEHOLDER_MIN_SHARE` of the font's effective cmap.

Both thresholds were calibrated against every face of the shipped
catalog and the GUI prototype fonts (213 faces): the observed maximum
is 5 codepoints on one glyph (the LXGW WenKai big-parenthesis piece,
0.01% of its cmap), so the 64-codepoint count arm clears the catalog's
worst by better than an order of magnitude, and the worst observed
share (about 0.00025) clears the 5% line by two. The GUI preview path
(``gui/src/fonts/sfnt.ts``) carries the same heuristic and the same
constants — the live coverage numbers must match the report's.

The result feeds every downstream stage through
:func:`fontalloy_core.build`'s coverage seam: codepoints in the
placeholder set count as NOT covered (coverage and missing statistics,
never eligible as donor fill — the effective table never contains them,
so a placeholder is never grafted) and the report's per-source records
state how many each source carried (``placeholder_codepoints``).
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass

from fontTools.ttLib import TTFont

#: The count arm: a glyph must absorb at least this many codepoints to
#: read as a placeholder (the shipped catalog's observed maximum is 5).
PLACEHOLDER_MIN_CODEPOINTS = 64

#: The share arm: those codepoints must be at least this fraction of
#: the font's effective cmap (the shipped catalog's observed maximum
#: is about 0.00025 — two orders of magnitude below the line).
PLACEHOLDER_MIN_SHARE = 0.05


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

    The concentration check runs over the effective cmap (glyph-0
    mappings dropped first), so a font that also pads its cmap with
    ``.notdef`` rows cannot dilute — or inflate — the share arm.
    """
    zero = glyph_zero_name(font)
    effective = {
        codepoint: name
        for codepoint, name in font.getBestCmap().items()
        if name != zero
    }
    total = len(effective)
    if total == 0:
        return FaceCoverage(codepoints=frozenset(), placeholders=frozenset())

    suspects: set[str] = set()
    for name, count in Counter(effective.values()).items():
        if (
            count >= PLACEHOLDER_MIN_CODEPOINTS
            and count / total >= PLACEHOLDER_MIN_SHARE
        ):
            suspects.add(name)
    if not suspects:
        return FaceCoverage(
            codepoints=frozenset(effective), placeholders=frozenset()
        )
    placeholders = frozenset(
        codepoint
        for codepoint, name in effective.items()
        if name in suspects
    )
    return FaceCoverage(
        codepoints=frozenset(
            codepoint
            for codepoint, name in effective.items()
            if name not in suspects
        ),
        placeholders=placeholders,
    )


def glyph_zero_name(font: TTFont) -> str:
    """The name of glyph 0 — ``.notdef`` by the TrueType convention."""
    order = font.getGlyphOrder()
    return order[0] if order else ".notdef"
