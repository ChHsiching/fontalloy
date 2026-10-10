"""Pipeline stage 4: normalize donor glyphs onto the base's metrics.

ADR-0003 — transform only, never reshape, grid school by default:

- **upem unified**: every donor scales by s0 = U/u (the base's upem over
  the donor's) so all grafted geometry lives in the base's units;
- **the scale** k = min(k_target, 0.95*(typoAsc + |typoDesc|)/H_ink) where
  the target is the grid term 2A/U by default (CJK advance = exactly 2x
  the Latin advance — the terminal-grid school) or the optical term
  ratio * capHeight / H_ink (Han ink ~= 1.23x cap height, the Noto
  native pairing) when the recipe turns that knob;
- **H_ink** is the 90th-percentile ink height over the donor's coverage
  of the U+4E00-9FFF common Han block — a percentile, never the header
  extremes; a donor with no Han there has no H_ink, hence no k (its
  glyphs carry the upem scale alone), and optical mode is an error;
- **zero vertical displacement**: the scale is about the shared baseline
  (dy = 0) — the CJK ideographic em box keeps its [-0.12em, +0.88em]
  convention, no top alignment, no centering;
- **advances follow UAX #11**: Fullwidth/Wide take two cells, everything
  else takes one (Python's ``unicodedata.east_asian_width``, no vendored
  data). An ambiguous codepoint the base font already covers stays with
  the base — a corollary of absence-never-overrides, enforced by the
  precedence resolver, not here. Fullwidth quotes/dashes/ellipsis are a
  recipe option (``quote_dash_width``) for locale conventions;
- **line height inherits the base**: this module never touches hhea or
  the OS/2 typo metrics; only usWinAscent/usWinDescent grow afterwards,
  and only to prevent clipping (never to shrink).

The plan this module produces is applied by the graft (stage 5) — the
same glyph-level surgery, now carrying a scale and an advance target.
"""

from __future__ import annotations

import math
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass

from fontTools.misc.fixedTools import otRound
from fontTools.pens.boundsPen import BoundsPen
from fontTools.ttLib import TTFont

from fontalloy_core.errors import BuildError

#: Normalization schools.
GRID = "grid"
OPTICAL = "optical"
MODES = (GRID, OPTICAL)

#: Fullwidth quote/dash width policies.
HALFWIDTH = "halfwidth"
FULLWIDTH = "fullwidth"
QUOTE_DASH_POLICIES = (HALFWIDTH, FULLWIDTH)

#: The optical school's default Han-ink-to-cap-height ratio (the Noto
#: native pairing; the recipe's adjustable knob).
DEFAULT_OPTICAL_RATIO = 1.23

#: The U+4E00-9FFF block: the common Han characters H_ink is measured
#: over (never the CJK-extension extremes).
HAN_COMMON_FIRST = 0x4E00
HAN_COMMON_LAST = 0x9FFF

#: Which percentile of the Han ink heights H_ink is (never the maximum).
INK_PERCENTILE = 90

#: The quote/dash codepoints the fullwidth policy covers: dashes
#: U+2010-U+2015, quotes U+2018-U+201F, and the horizontal ellipsis
#: U+2026 — the ambiguous set CJK fonts conventionally draw fullwidth.
QUOTE_DASH_CODEPOINTS = frozenset(
    [*range(0x2010, 0x2016), *range(0x2018, 0x201E), 0x2026]
)

#: East Asian Width classes that occupy two terminal cells.
_WIDE_CLASSES = frozenset(("F", "W"))


@dataclass(frozen=True)
class NormalizationOptions:
    """The recipe's normalization switches (issue #8).

    ``mode`` picks the school: ``grid`` (default — the terminal 2:1 grid)
    or ``optical`` (Han ink at ``optical_ratio`` times the base's cap
    height). ``quote_dash_width`` decides whether the ambiguous quotes,
    dashes, and ellipsis a donor supplies land on two cells
    (``fullwidth``, the CJK locale convention) or one (``halfwidth``,
    the UAX #11 default).
    """

    mode: str = GRID
    optical_ratio: float = DEFAULT_OPTICAL_RATIO
    quote_dash_width: str = HALFWIDTH


@dataclass(frozen=True)
class DonorScale:
    """How one donor lands on the base font's metrics."""

    donor_id: str
    upem_scale: float  # s0 = U/u
    han_ink_height: float | None  # H_ink in donor units (None: no Han)
    k: float | None  # None when H_ink is unmeasurable
    scale: float  # s0 * (k or 1) — the per-glyph transform factor


@dataclass(frozen=True)
class NormalizationPlan:
    """Everything the graft needs to land donors on the base's metrics."""

    latin_advance: int  # A: the base font's single-cell advance
    cap_height: float  # the base's cap height (the optical knob's anchor)
    typo_span: float  # typoAsc + |typoDesc| of the base
    options: NormalizationOptions
    donor_scales: Mapping[str, DonorScale]

    def scale_for(self, donor_id: str) -> float:
        """The outline scale applied to every glyph from ``donor_id``."""
        return self.donor_scales[donor_id].scale

    def advance_for(self, codepoint: int) -> int:
        """The output advance for a donor-supplied ``codepoint``.

        Fullwidth/Wide take two cells; everything else takes one. The
        fullwidth policy additionally widens the quotes, dashes, and
        ellipsis UAX #11 leaves ambiguous.
        """
        if (
            self.options.quote_dash_width == FULLWIDTH
            and codepoint in QUOTE_DASH_CODEPOINTS
        ):
            return 2 * self.latin_advance
        wide = unicodedata.east_asian_width(chr(codepoint)) in _WIDE_CLASSES
        return (2 if wide else 1) * self.latin_advance


def plan_normalization(
    base: TTFont,
    donors: Mapping[str, TTFont],
    options: NormalizationOptions,
) -> NormalizationPlan:
    """Compute the normalization plan for one build.

    ``donors`` maps donor ids ("donor-<index>") to loaded fonts. The base
    font is only read, never modified.
    """
    upem = base["head"].unitsPerEm
    latin_advance = _latin_advance(base)
    cap_height = _cap_height(base)
    typo_span = _typo_span(base)

    donor_scales = {
        donor_id: _donor_scale(
            donor_id, donor, base, options,
            upem=upem,
            latin_advance=latin_advance,
            cap_height=cap_height,
            typo_span=typo_span,
        )
        for donor_id, donor in donors.items()
    }
    return NormalizationPlan(
        latin_advance=latin_advance,
        cap_height=cap_height,
        typo_span=typo_span,
        options=options,
        donor_scales=donor_scales,
    )


def _donor_scale(
    donor_id: str,
    donor: TTFont,
    base: TTFont,
    options: NormalizationOptions,
    *,
    upem: int,
    latin_advance: int,
    cap_height: float,
    typo_span: float,
) -> DonorScale:
    """Scale one donor by s0 = U/u and (when measurable) by k."""
    donor_upem = donor["head"].unitsPerEm
    s0 = upem / donor_upem
    han_ink = _han_ink_height(donor)

    if han_ink is None:
        if options.mode == OPTICAL:
            raise BuildError(
                f"donor {donor_id} has no glyphs in the common Han block "
                f"U+{HAN_COMMON_FIRST:04X}-U+{HAN_COMMON_LAST:04X}, so its Han "
                "ink height cannot be measured and the optical school "
                "cannot apply (the grid school would leave it at the upem "
                "scale alone)"
            )
        return DonorScale(
            donor_id=donor_id, upem_scale=s0, han_ink_height=None,
            k=None, scale=s0,
        )

    # H_ink measured in donor units; the guard and the targets are all
    # in base units, so bring the ink across first.
    han_ink_in_base = han_ink * s0
    guard = 0.95 * typo_span / han_ink_in_base
    if options.mode == OPTICAL:
        target = options.optical_ratio * cap_height / han_ink_in_base
    else:
        target = 2 * latin_advance / upem
    k = min(target, guard)
    return DonorScale(
        donor_id=donor_id,
        upem_scale=s0,
        han_ink_height=han_ink,
        k=k,
        scale=s0 * k,
    )


def _latin_advance(base: TTFont) -> int:
    """A: the base font's single-cell advance.

    The most frequent advance over the base's covered printable ASCII
    (0x21-0x7E); ties resolve to the smaller advance. A monospaced base
    has exactly one such advance (JetBrains Mono: 600 at 1000 upem). A
    base covering no ASCII at all falls back to half an em.
    """
    cmap = base.getBestCmap()
    counts: dict[int, int] = {}
    for codepoint in range(0x21, 0x7F):
        name = cmap.get(codepoint)
        if name is not None:
            advance = base["hmtx"][name][0]
            counts[advance] = counts.get(advance, 0) + 1
    if not counts:
        return base["head"].unitsPerEm // 2
    return max(counts.items(), key=lambda item: (item[1], -item[0]))[0]


def _cap_height(base: TTFont) -> float:
    """The base's cap height: OS/2 sCapHeight when set, else the ink
    height of 'H', else the 0.7em fallback."""
    os2 = base.get("OS/2")
    if os2 is not None and getattr(os2, "sCapHeight", 0):
        return float(os2.sCapHeight)
    name = base.getBestCmap().get(0x48)
    if name is not None:
        glyph = base["glyf"][name]
        y_max = getattr(glyph, "yMax", None)
        y_min = getattr(glyph, "yMin", None)
        if y_max is not None and y_min is not None:
            return float(y_max - y_min)
    return 0.7 * base["head"].unitsPerEm


def _typo_span(base: TTFont) -> float:
    """typoAsc + |typoDesc| — the line box the ink must fit inside.

    OS/2 typo metrics, falling back to hhea when a font has no OS/2.
    """
    os2 = base.get("OS/2")
    if os2 is not None and (os2.sTypoAscender or os2.sTypoDescender):
        return float(os2.sTypoAscender + abs(os2.sTypoDescender))
    hhea = base["hhea"]
    return float(hhea.ascent + abs(hhea.descent))


def _han_ink_height(donor: TTFont) -> float | None:
    """H_ink: the 90th-percentile ink height over the donor's coverage
    of the common Han block (donor units, None when there is no sample).
    """
    cmap = donor.getBestCmap()
    glyf = donor.get("glyf")
    heights: list[int] = []
    for codepoint in sorted(cmap):
        if not HAN_COMMON_FIRST <= codepoint <= HAN_COMMON_LAST:
            continue
        name = cmap[codepoint]
        if glyf is not None:
            glyph = glyf[name]
            if glyph.numberOfContours == 0:
                continue  # empty outlines carry no ink
            y_max, y_min = getattr(glyph, "yMax", None), getattr(glyph, "yMin", None)
            if y_max is None or y_min is None:
                continue
            heights.append(y_max - y_min)
        else:  # CFF donor: measure through the glyph set
            pen = BoundsPen(donor.getGlyphSet())
            donor.getGlyphSet()[name].draw(pen)
            if pen.bounds is not None:
                _x_min, y_min, _x_max, y_max = pen.bounds
                heights.append(otRound(y_max - y_min))
    if not heights:
        return None
    return _percentile(heights, INK_PERCENTILE)


def _percentile(values: list[int], percent: float) -> float:
    """Linear-interpolation percentile (the numpy 'linear' method)."""
    ordered = sorted(values)
    if len(ordered) == 1:
        return float(ordered[0])
    rank = (len(ordered) - 1) * percent / 100.0
    low = math.floor(rank)
    high = math.ceil(rank)
    if low == high:
        return float(ordered[low])
    weight = rank - low
    return ordered[low] + (ordered[high] - ordered[low]) * weight
