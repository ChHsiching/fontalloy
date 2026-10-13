"""Seam 1 tests: normalization onto the base font's metrics (issue #8,
ADR-0003 — the grid school by default, the optical ratio as the knob,
transform only and never reshape).

The oracle is the built font read back with fontTools: grafted ink is the
donor's ink scaled about the shared baseline (zero vertical displacement),
advances land on the terminal grid per UAX #11 (Fullwidth/Wide two cells,
everything else one), and the base font's line-height contract (hhea, OS/2
typo) passes through untouched while usWinAscent/Descent grow only to
prevent clipping. Every expectation below is written in base-font units.

Expected scales for the synthetic fixtures (advance 600, typo span 800 +
200 = 1000, upem 1000 unless stated):

- a donor whose Han sample heights are [400, 500] has H_ink = p90 = 490,
  so k = min(2*600/1000, 0.95*1000/490) = min(1.2, 1.9388) = 1.2 — the
  grid school binds and the guard does not;
- a 2048-upem donor multiplies in s0 = 1000/2048 first: s = 0.5859375.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fontTools.pens.boundsPen import BoundsPen
from fontTools.ttLib import TTFont, newTable
from fontTools.ttLib.tables.ttProgram import Program

from conftest import BASE_CODEPOINTS, synth_font
from fontalloy_core import build
from fontalloy_core.recipe import load_recipe


def _bounds(font: TTFont, name: str) -> tuple[int, int, int, int] | None:
    pen = BoundsPen(font.getGlyphSet())
    font.getGlyphSet()[name].draw(pen)
    return pen.bounds


def _advance(font: TTFont, codepoint: int) -> int:
    return font["hmtx"][font.getBestCmap()[codepoint]][0]


def _write_recipe(tmp_path: Path, base: Path, donor: Path, extra: str = "") -> Path:
    recipe = tmp_path / "recipe.yaml"
    recipe.write_text(
        f"base: {base.name}\ndonors:\n  - {donor.name}\n{extra}",
        encoding="utf-8",
    )
    return recipe


# --- recipe switches -------------------------------------------------------


class TestNormalizationSwitches:
    """The recipe gains normalization-switch fields (issue #1: "the
    recipe declares ... normalization switches")."""

    def test_absent_normalization_means_the_documented_defaults(
        self, tmp_path: Path, synth_font_factory
    ):
        base = synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=BASE_CODEPOINTS
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf", family="SynthDonor", codepoints=(0x4E2D,)
        )
        recipe = _write_recipe(tmp_path, base, donor)

        parsed = load_recipe(recipe).normalization

        assert parsed.mode == "grid"
        assert parsed.optical_ratio == pytest.approx(1.23)
        assert parsed.quote_dash_width == "halfwidth"
        assert parsed.width_factor == pytest.approx(2.0)

    def test_explicit_switch_values_parse(self, tmp_path: Path, synth_font_factory):
        base = synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=BASE_CODEPOINTS
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf", family="SynthDonor", codepoints=(0x4E2D,)
        )
        recipe = _write_recipe(
            tmp_path,
            base,
            donor,
            extra=(
                "normalization:\n"
                "  mode: optical\n"
                "  optical_ratio: 1.4\n"
                "  quote_dash_width: fullwidth\n"
                "  width_factor: 1.8\n"
            ),
        )

        parsed = load_recipe(recipe).normalization

        assert parsed.mode == "optical"
        assert parsed.optical_ratio == pytest.approx(1.4)
        assert parsed.quote_dash_width == "fullwidth"
        assert parsed.width_factor == pytest.approx(1.8)

    def test_unknown_normalization_field_is_rejected(
        self, tmp_path: Path, base_font: Path, donor_font: Path
    ):
        recipe = _write_recipe(
            tmp_path,
            base_font,
            donor_font,
            extra="normalization:\n  warp: 3.0\n",
        )

        from fontalloy_core.errors import RecipeError

        with pytest.raises(RecipeError, match="normalization"):
            build(recipe, tmp_path / "out.ttf")

    def test_unknown_mode_is_rejected(self, tmp_path: Path, base_font: Path,
                                      donor_font: Path):
        recipe = _write_recipe(
            tmp_path, base_font, donor_font, extra="normalization:\n  mode: fuzzy\n"
        )

        from fontalloy_core.errors import RecipeError

        with pytest.raises(RecipeError, match="mode"):
            build(recipe, tmp_path / "out.ttf")

    @pytest.mark.parametrize("ratio", [0, -1.2, "wide", True])
    def test_non_positive_optical_ratio_is_rejected(
        self, tmp_path: Path, base_font: Path, donor_font: Path, ratio
    ):
        rendered = f"{ratio}" if not isinstance(ratio, str) else f'"{ratio}"'
        recipe = _write_recipe(
            tmp_path,
            base_font,
            donor_font,
            extra=f"normalization:\n  optical_ratio: {rendered}\n",
        )

        from fontalloy_core.errors import RecipeError

        with pytest.raises(RecipeError, match="optical_ratio"):
            build(recipe, tmp_path / "out.ttf")

    def test_unknown_quote_dash_policy_is_rejected(
        self, tmp_path: Path, base_font: Path, donor_font: Path
    ):
        recipe = _write_recipe(
            tmp_path,
            base_font,
            donor_font,
            extra="normalization:\n  quote_dash_width: widest\n",
        )

        from fontalloy_core.errors import RecipeError

        with pytest.raises(RecipeError, match="quote_dash_width"):
            build(recipe, tmp_path / "out.ttf")


# --- upem unification and the scale ----------------------------------------


class TestUpemUnification:
    """Donor glyphs land on the base font's upem: s0 = U/u, then k."""

    def test_a_2048_upem_donor_lands_scaled_on_the_1000_upem_base(
        self, tmp_path: Path, synth_font_factory
    ):
        base = synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=BASE_CODEPOINTS
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf",
            family="SynthDonor",
            codepoints=(0x4E2D, 0x56FD),
            upem=2048,
        )
        recipe = _write_recipe(tmp_path, base, donor)

        result = build(recipe, tmp_path / "out.ttf")

        out = TTFont(result.font_path)
        assert out["head"].unitsPerEm == 1000  # the base is the container

        # s = (1000/2048) * 1.2 = 0.5859375; the donor's ink (40, 0, 560,
        # 400) scales about the baseline — pure scale, zero displacement.
        cmap = out.getBestCmap()
        assert _bounds(out, cmap[0x4E2D]) == (23, 0, 328, 234)
        assert _bounds(out, cmap[0x56FD]) == (23, 0, 328, 293)
        # The side bearing rides the same scale; the advance re-grids.
        assert out["hmtx"][cmap[0x4E2D]][1] == 23  # round(40 * 0.5859375)

    def test_the_scale_never_translates_vertically(
        self, tmp_path: Path, synth_font_factory
    ):
        # Ink straddling the baseline proves dy = 0 (the CJK em box keeps
        # its [−0.12em, +0.88em] convention: no top alignment, no
        # centering, one shared baseline).
        base = synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=BASE_CODEPOINTS
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf",
            family="SynthDonor",
            codepoints=(0x4E2D,),
            ink_dy=-100,
        )
        recipe = _write_recipe(tmp_path, base, donor)

        result = build(recipe, tmp_path / "out.ttf")

        out = TTFont(result.font_path)
        # Donor ink (40, -100, 560, 300) * 1.2 — exactly, no dy.
        assert _bounds(out, out.getBestCmap()[0x4E2D]) == (48, -120, 672, 360)


class TestNonHanDonor:
    """A donor with no Han sample has no H_ink, so no k applies: its
    glyphs carry the upem scale s0 alone (still transform-only)."""

    def test_a_symbols_donor_lands_at_the_upem_scale_only(
        self, tmp_path: Path, synth_font_factory
    ):
        base = synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=BASE_CODEPOINTS
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf",
            family="SynthSymbols",
            codepoints=(0x2603, 0x2190),  # neutral + ambiguous, no Han
            upem=2048,
        )
        recipe = _write_recipe(tmp_path, base, donor)

        result = build(recipe, tmp_path / "out.ttf")

        out = TTFont(result.font_path)
        cmap = out.getBestCmap()
        # s0 = 1000/2048 = 0.48828125 — NOT multiplied by 1.2.
        assert _bounds(out, cmap[0x2603]) == (20, 0, 273, 195)
        assert _advance(out, 0x2603) == 600  # one cell


# --- the grid school and UAX #11 advances -----------------------------------


class TestGridAdvances:
    """CJK advance = exactly 2x the Latin advance; UAX #11 classes decide."""

    def test_fullwidth_and_wide_take_two_cells_every_else_one(
        self, tmp_path: Path, synth_font_factory
    ):
        base = synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=BASE_CODEPOINTS
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf",
            family="SynthDonor",
            codepoints=(0x4E2D, 0xFF01, 0xFF61, 0x201C, 0x00E9),
            # Wide (CJK), Fullwidth (!), Halfwidth (｡), Ambiguous (“), Narrow (é)
        )
        recipe = _write_recipe(tmp_path, base, donor)

        result = build(recipe, tmp_path / "out.ttf")

        out = TTFont(result.font_path)
        latin = _advance(out, 0x41)  # the base font's own Latin advance
        assert latin == 600
        assert _advance(out, 0x4E2D) == 2 * latin  # W
        assert _advance(out, 0xFF01) == 2 * latin  # F
        assert _advance(out, 0xFF61) == latin  # H
        assert _advance(out, 0x201C) == latin  # A
        assert _advance(out, 0x00E9) == latin  # Na

    def test_an_ambiguous_codepoint_the_base_covers_stays_with_the_base(
        self, tmp_path: Path, synth_font_factory
    ):
        base = synth_font_factory(
            tmp_path / "base.ttf",
            family="SynthBase",
            codepoints=(0x41, 0x201C, 0x2013),  # covers “ and –
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf",
            family="SynthDonor",
            codepoints=(0x201C, 0x2013, 0x4E2D),
            advance=700,
        )
        recipe = _write_recipe(tmp_path, base, donor)

        result = build(recipe, tmp_path / "out.ttf")

        out = TTFont(result.font_path)
        report = json.loads(result.report_path.read_text(encoding="utf-8"))
        entries = {e["codepoint"]: e for e in report["provenance"]}

        # Absence never overrides: the base keeps both ambiguous slots...
        for cp in (0x201C, 0x2013):
            assert entries[cp]["winner"] == "base"
            assert out.getBestCmap()[cp] == TTFont(base).getBestCmap()[cp]
            assert _advance(out, cp) == 600  # the base's own single cell
        # ...while the donor still fills the slot the base lacks.
        assert _advance(out, 0x4E2D) == 1200

    @pytest.mark.parametrize("factor, expected", [(1.8, 1080), (1.5, 900)])
    def test_the_width_factor_knob_compacts_the_wide_advance(
        self, tmp_path: Path, synth_font_factory, factor, expected
    ):
        """The prototype's 1.8x/1.5x settings are real pipeline behavior:
        on a 1000-upem base whose Latin advance is 600, a wide glyph
        takes width_factor x 600 and the ink scales by the same factor's
        grid target (k = width_factor*A/U under the guard)."""
        base = synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=BASE_CODEPOINTS
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf", family="SynthDonor", codepoints=(0x4E2D,)
        )
        recipe = _write_recipe(
            tmp_path,
            base,
            donor,
            extra=f"normalization:\n  width_factor: {factor}\n",
        )

        result = build(recipe, tmp_path / "out.ttf")

        out = TTFont(result.font_path)
        latin = _advance(out, 0x41)
        assert latin == 600
        assert _advance(out, 0x4E2D) == expected

        # The scale target follows the same factor: k = factor*600/1000
        # (0.95*typoSpan/H_ink = 1.9388 does not bind; see the module
        # docstring's fixture arithmetic). The synthetic glyph's ink
        # bounds scale accordingly about the shared baseline.
        donor_font = TTFont(donor)
        donor_name = donor_font.getBestCmap()[0x4E2D]
        donor_bounds = _bounds(donor_font, donor_name)
        out_bounds = _bounds(out, out.getBestCmap()[0x4E2D])
        assert donor_bounds is not None and out_bounds is not None
        k = factor * 600 / 1000
        assert out_bounds[1] == pytest.approx(donor_bounds[1] * k, abs=1.0)
        assert out_bounds[3] == pytest.approx(donor_bounds[3] * k, abs=1.0)

    @pytest.mark.parametrize("factor", [0, -1.5, 2.5, "wide", True])
    def test_out_of_range_width_factor_is_rejected(
        self, tmp_path: Path, base_font: Path, donor_font: Path, factor
    ):
        rendered = f"{factor}" if not isinstance(factor, str) else f'"{factor}"'
        recipe = _write_recipe(
            tmp_path,
            base_font,
            donor_font,
            extra=f"normalization:\n  width_factor: {rendered}\n",
        )

        from fontalloy_core.errors import RecipeError

        with pytest.raises(RecipeError, match="width_factor"):
            build(recipe, tmp_path / "out.ttf")


class TestQuoteDashWidthPolicy:
    """Fullwidth quote and dash width is a recipe option (locale knob).

    Under ``fullwidth`` the option is an effective override: the base's
    halfwidth forms lose the quote/dash set to the donor's fullwidth
    glyphs at the wide advance, because the merged font must carry the
    locale's forms, not the base's latin ones. Under ``halfwidth`` (the
    default) the base's own forms and advances pass through untouched.
    """

    def test_fullwidth_policy_supplies_the_donor_glyph_at_two_cells(
        self, tmp_path: Path, synth_font_factory
    ):
        """The defect this pins: the base covers U+201C with a halfwidth
        latin form, so absence-never-overrides alone would keep it — the
        policy must override that keep, grafting the donor's glyph with
        the wide advance (glyph identity, not just the advance)."""
        base = synth_font_factory(
            tmp_path / "base.ttf",
            family="SynthBase",
            codepoints=(0x41, 0x201C, 0x201D, 0x2014),
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf",
            family="SynthDonor",
            codepoints=(0x201C, 0x201D, 0x2014),
            advance=700,  # a wider donor cell makes the ink traceable
        )
        recipe = _write_recipe(
            tmp_path,
            base,
            donor,
            extra="normalization:\n  quote_dash_width: fullwidth\n",
        )

        result = build(recipe, tmp_path / "out.ttf")

        out = TTFont(result.font_path)
        cmap = out.getBestCmap()
        # The donor supplies the glyph: the grafted namespace, never the
        # base's own name.
        for cp in (0x201C, 0x201D, 0x2014):
            assert cmap[cp] == f"d0.uni{cp:04X}"
            assert _advance(out, cp) == 1200  # 2A, the wide advance
        # Glyph identity via bounds: the donor's ink (40, 0, 660, 400)
        # lands unscaled (no Han sample, so scale = s0 = 1) — the base's
        # own glyph for the same codepoint boxes at xMax 560.
        assert _bounds(out, cmap[0x201C]) == (40, 0, 660, 400)
        base_cmap = TTFont(base).getBestCmap()
        assert _bounds(out, base_cmap[0x201C]) == (40, 0, 560, 500)
        assert cmap[0x201C] != base_cmap[0x201C]

    def test_halfwidth_default_keeps_the_base_form_untouched(
        self, tmp_path: Path, synth_font_factory
    ):
        base = synth_font_factory(
            tmp_path / "base.ttf",
            family="SynthBase",
            codepoints=(0x41, 0x201C, 0x201D, 0x2014),
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf",
            family="SynthDonor",
            codepoints=(0x201C, 0x201D, 0x2014),
            advance=700,
        )
        recipe = _write_recipe(tmp_path, base, donor)  # default: halfwidth

        result = build(recipe, tmp_path / "out.ttf")

        out, base_font = TTFont(result.font_path), TTFont(base)
        base_cmap = base_font.getBestCmap()
        for cp in (0x201C, 0x201D, 0x2014):
            assert out.getBestCmap()[cp] == base_cmap[cp]  # the base glyph
            assert _advance(out, cp) == 600  # the base's single cell

    @pytest.mark.parametrize(
        "cp",
        [
            0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015,  # dashes
            0x2018, 0x2019, 0x201A, 0x201B, 0x201C, 0x201D, 0x201E,
            0x201F,  # quotes (U+201E/201F once fell outside the set)
            0x2026,  # horizontal ellipsis
        ],
    )
    def test_the_whole_quote_dash_set_is_covered(
        self, tmp_path: Path, synth_font_factory, cp
    ):
        """Dashes U+2010-U+2015, quotes U+2018-U+201F, ellipsis U+2026 —
        the ambiguous set CJK fonts conventionally draw fullwidth."""
        base = synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=(0x41, cp)
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf", family="SynthDonor", codepoints=(cp,)
        )
        recipe = _write_recipe(
            tmp_path,
            base,
            donor,
            extra="normalization:\n  quote_dash_width: fullwidth\n",
        )

        result = build(recipe, tmp_path / "out.ttf")

        out = TTFont(result.font_path)
        assert out.getBestCmap()[cp] == f"d0.uni{cp:04X}"
        assert _advance(out, cp) == 1200

    def test_absence_keeps_the_base_form_and_the_report_states_it(
        self, tmp_path: Path, synth_font_factory
    ):
        """A quote codepoint no donor holds keeps the base's halfwidth
        form — absence never overrides, and the report says so."""
        base = synth_font_factory(
            tmp_path / "base.ttf",
            family="SynthBase",
            codepoints=(0x41, 0x201C, 0x201D),
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf", family="SynthDonor", codepoints=(0x201C,)
        )
        recipe = _write_recipe(
            tmp_path,
            base,
            donor,
            extra="normalization:\n  quote_dash_width: fullwidth\n",
        )

        result = build(recipe, tmp_path / "out.ttf")

        out, base_font = TTFont(result.font_path), TTFont(base)
        # The donor-backed quote goes fullwidth...
        assert out.getBestCmap()[0x201C] == "d0.uni201C"
        assert _advance(out, 0x201C) == 1200
        # ...the absent one keeps the base glyph and its single cell.
        assert out.getBestCmap()[0x201D] == base_font.getBestCmap()[0x201D]
        assert _advance(out, 0x201D) == 600

        report = json.loads(result.report_path.read_text(encoding="utf-8"))
        entries = {e["codepoint"]: e for e in report["provenance"]}
        assert entries[0x201C]["winner"] == "donor-0"
        assert entries[0x201C]["via"] == "policy"
        assert entries[0x201C]["kind"] == "override"
        assert entries[0x201D]["winner"] == "base"
        assert entries[0x201D]["via"] == "default"
        assert entries[0x201D]["kind"] == "base"

    def test_the_reports_accounting_reflects_the_policy(
        self, tmp_path: Path, synth_font_factory
    ):
        base = synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=(0x41, 0x201C)
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf", family="SynthDonor", codepoints=(0x201C,)
        )
        recipe = _write_recipe(
            tmp_path,
            base,
            donor,
            extra="normalization:\n  quote_dash_width: fullwidth\n",
        )

        result = build(recipe, tmp_path / "out.ttf")

        report = json.loads(result.report_path.read_text(encoding="utf-8"))
        # The override the policy created is counted, never hidden.
        assert report["precedence"]["counts"] == {
            "base": 1,  # 0x41
            "fill": 0,
            "override": 1,  # 0x201C via the policy
        }
        assert report["summary"]["from_donors"] == 1

    def test_an_explicit_rule_beats_the_policy(
        self, tmp_path: Path, synth_font_factory
    ):
        """A declared rule's decision stands: pinning one quote to the
        base keeps its halfwidth form even under fullwidth."""
        base = synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=(0x41, 0x201C)
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf", family="SynthDonor", codepoints=(0x201C,)
        )
        recipe = _write_recipe(
            tmp_path,
            base,
            donor,
            extra=(
                "normalization:\n"
                "  quote_dash_width: fullwidth\n"
                "rules:\n"
                "  - codepoint: 0x201C\n"
                "    fonts: [base]\n"
            ),
        )

        result = build(recipe, tmp_path / "out.ttf")

        out, base_font = TTFont(result.font_path), TTFont(base)
        assert out.getBestCmap()[0x201C] == base_font.getBestCmap()[0x201C]
        assert _advance(out, 0x201C) == 600

        report = json.loads(result.report_path.read_text(encoding="utf-8"))
        entries = {e["codepoint"]: e for e in report["provenance"]}
        assert entries[0x201C]["via"] == "rule-0"
        assert entries[0x201C]["kind"] == "base"

    def test_quotes_dashes_and_ellipsis_default_to_one_cell(
        self, tmp_path: Path, synth_font_factory
    ):
        base = synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=BASE_CODEPOINTS
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf",
            family="SynthDonor",
            codepoints=(0x2018, 0x2013, 0x2026, 0x4E2D),
        )
        recipe = _write_recipe(tmp_path, base, donor)

        result = build(recipe, tmp_path / "out.ttf")

        out = TTFont(result.font_path)
        for cp in (0x2018, 0x2013, 0x2026):
            assert _advance(out, cp) == 600
        assert _advance(out, 0x4E2D) == 1200  # wide CJK unaffected

    def test_the_fullwidth_policy_makes_them_two_cells(
        self, tmp_path: Path, synth_font_factory
    ):
        base = synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=BASE_CODEPOINTS
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf",
            family="SynthDonor",
            codepoints=(0x2018, 0x2013, 0x2026, 0x4E2D, 0x00E9),
        )
        recipe = _write_recipe(
            tmp_path,
            base,
            donor,
            extra="normalization:\n  quote_dash_width: fullwidth\n",
        )

        result = build(recipe, tmp_path / "out.ttf")

        out = TTFont(result.font_path)
        for cp in (0x2018, 0x2013, 0x2026):
            assert _advance(out, cp) == 1200
        # The policy touches only quotes/dashes: narrow stays one cell.
        assert _advance(out, 0x00E9) == 600


# --- the k formula: grid term, optical knob, overflow guard -----------------


class TestScaleFormula:
    """k = min(k_target, 0.95*(typoAsc + |typoDesc|)/H_ink) with the grid
    term 2A/U as the default target and the optical ratio as the knob."""

    def test_the_grid_school_binds_by_default(self, tmp_path: Path,
                                              synth_font_factory):
        # Donor Han heights [400, 500] -> H_ink = p90 = 490; the guard
        # 0.95*1000/490 = 1.94 does not bind, so k = 2*600/1000 = 1.2.
        base = synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=BASE_CODEPOINTS
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf", family="SynthDonor", codepoints=(0x4E2D,)
        )
        recipe = _write_recipe(tmp_path, base, donor)

        result = build(recipe, tmp_path / "out.ttf")

        out = TTFont(result.font_path)
        # Ink height 400 * 1.2 = 480; the advance is the grid's 2A.
        assert _bounds(out, out.getBestCmap()[0x4E2D]) == (48, 0, 672, 480)
        assert _advance(out, 0x4E2D) == 1200

    def test_the_overflow_guard_caps_k(self, tmp_path: Path, synth_font_factory):
        # Han heights [400..900] (6 codepoints) -> H_ink = p90 = 850;
        # guard = 0.95*1000/850 = 1.1176 < 1.2, so the guard binds and
        # ink lands at 0.95 of the base's typo span.
        base = synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=BASE_CODEPOINTS
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf",
            family="SynthDonor",
            codepoints=tuple(range(0x4E00, 0x4E06)),
        )
        recipe = _write_recipe(tmp_path, base, donor)

        result = build(recipe, tmp_path / "out.ttf")

        out = TTFont(result.font_path)
        glyph = out.getBestCmap()[0x4E00]
        # 400 * (950/850) = 447.06 -> 447 (would be 480 if k were 1.2).
        assert _bounds(out, glyph)[3] == 447
        # The grid advance holds even when the guard caps the ink.
        assert _advance(out, 0x4E00) == 1200

    def test_han_ink_is_a_percentile_not_the_extremes(
        self, tmp_path: Path, synth_font_factory
    ):
        # Han heights [400..2300] (20 codepoints): H_ink = p90 = 2110, not
        # the 2300 maximum. k = 950/2110 = 0.4502, so the shortest glyph's
        # ink is round(400 * 0.4502) = 180 (it would be 165 at the extreme).
        base = synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=BASE_CODEPOINTS
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf",
            family="SynthDonor",
            codepoints=tuple(range(0x4E00, 0x4E14)),
        )
        recipe = _write_recipe(tmp_path, base, donor)

        result = build(recipe, tmp_path / "out.ttf")

        out = TTFont(result.font_path)
        assert _bounds(out, out.getBestCmap()[0x4E00])[3] == 180

    def test_the_optical_knob_rescales_relative_to_cap_height(
        self, tmp_path: Path, synth_font_factory
    ):
        # The base covers 'H' (ink height 600 -> cap height); donor Han
        # heights [400, 500] -> H_ink = 490. Default ratio 1.23:
        # k = 1.23*600/490 = 1.5061 (guard 1.94 does not bind).
        base = synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=(0x41, 0x42, 0x48)
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf", family="SynthDonor", codepoints=(0x4E2D, 0x56FD)
        )
        recipe = _write_recipe(
            tmp_path, base, donor, extra="normalization:\n  mode: optical\n"
        )

        result = build(recipe, tmp_path / "out.ttf")

        out = TTFont(result.font_path)
        # Ink height 400 * 1.50612 = 602.45 -> 602.
        assert _bounds(out, out.getBestCmap()[0x4E2D])[3] == 602
        # Optical mode still lands on the grid advance.
        assert _advance(out, 0x4E2D) == 1200

    def test_the_optical_ratio_is_the_adjustable_knob(
        self, tmp_path: Path, synth_font_factory
    ):
        base = synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=(0x41, 0x42, 0x48)
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf", family="SynthDonor", codepoints=(0x4E2D, 0x56FD)
        )
        recipe = _write_recipe(
            tmp_path,
            base,
            donor,
            extra=(
                "normalization:\n  mode: optical\n  optical_ratio: 1.5\n"
            ),
        )

        result = build(recipe, tmp_path / "out.ttf")

        out = TTFont(result.font_path)
        # k = 1.5*600/490 = 1.8367 -> ink 400*k = 734.69 -> 735.
        assert _bounds(out, out.getBestCmap()[0x4E2D])[3] == 735

    def test_optical_mode_requires_a_measurable_han_sample(
        self, tmp_path: Path, synth_font_factory
    ):
        base = synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=BASE_CODEPOINTS
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf", family="SynthSymbols", codepoints=(0x2603,)
        )
        recipe = _write_recipe(
            tmp_path, base, donor, extra="normalization:\n  mode: optical\n"
        )

        from fontalloy_core.errors import BuildError

        with pytest.raises(BuildError, match="Han"):
            build(recipe, tmp_path / "out.ttf")


# --- vertical metrics: inherit the base, grow usWin only ---------------------


class TestLineHeightInheritance:
    """hhea and OS/2 typo pass through; usWinAscent/Descent grow only to
    prevent clipping — and only ever grow."""

    def test_hhea_and_typo_pass_through_untouched(
        self, tmp_path: Path, synth_font_factory
    ):
        base = synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=BASE_CODEPOINTS
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf", family="SynthDonor", codepoints=(0x4E2D,)
        )
        recipe = _write_recipe(tmp_path, base, donor)

        result = build(recipe, tmp_path / "out.ttf")

        out, base_font = TTFont(result.font_path), TTFont(base)
        for attr in ("ascent", "descent", "lineGap"):
            assert getattr(out["hhea"], attr) == getattr(base_font["hhea"], attr)
        for attr in ("sTypoAscender", "sTypoDescender", "sTypoLineGap"):
            assert getattr(out["OS/2"], attr) == getattr(base_font["OS/2"], attr)

    def test_uswin_grows_exactly_to_cover_the_merged_ink(
        self, tmp_path: Path, synth_font_factory
    ):
        # Han heights [400..900], guard k = 1.1176: the tallest ink is
        # round(900 * 950/850) = 1006 > the base's 900 win ascent.
        base = synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=BASE_CODEPOINTS
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf",
            family="SynthDonor",
            codepoints=tuple(range(0x4E00, 0x4E06)),
        )
        recipe = _write_recipe(tmp_path, base, donor)

        result = build(recipe, tmp_path / "out.ttf")

        out, base_font = TTFont(result.font_path), TTFont(base)
        assert out["OS/2"].usWinAscent == 1006
        assert out["OS/2"].usWinDescent == 300  # ink never dips below 0

    def test_uswin_descent_grows_for_below_baseline_ink(
        self, tmp_path: Path, synth_font_factory
    ):
        # Guard-capped donor (H_ink = 850, k = 1.1176) with ink dipping
        # to -400: round(400 * 950/850) = 447 > the base's 300.
        base = synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=BASE_CODEPOINTS
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf",
            family="SynthDonor",
            codepoints=tuple(range(0x4E00, 0x4E06)),
            ink_dy=-400,
        )
        recipe = _write_recipe(tmp_path, base, donor)

        result = build(recipe, tmp_path / "out.ttf")

        out = TTFont(result.font_path)
        assert out["OS/2"].usWinDescent == 447
        assert out["OS/2"].usWinAscent == 900  # top ink still fits

    def test_uswin_never_shrinks_and_short_ink_changes_nothing(
        self, tmp_path: Path, synth_font_factory
    ):
        base = synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=BASE_CODEPOINTS
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf", family="SynthDonor", codepoints=(0x4E2D,)
        )
        recipe = _write_recipe(tmp_path, base, donor)

        result = build(recipe, tmp_path / "out.ttf")

        out, base_font = TTFont(result.font_path), TTFont(base)
        assert out["OS/2"].usWinAscent == base_font["OS/2"].usWinAscent == 900
        assert out["OS/2"].usWinDescent == base_font["OS/2"].usWinDescent == 300


# --- donor hinting and layout never reach the output -------------------------


class TestDonorHintingAndLayoutDropped:
    """Donor hinting and GPOS/kerning are dropped; the base keeps its own.
    The graft reads only glyf/hmtx/cmap from the donor, so no donor table
    can leak — this verifies that structurally, glyph programs included."""

    @staticmethod
    def _hinted(path: Path, bytecode: bytes, cvt_value: int) -> Path:
        """Re-save a synthetic font with per-glyph instructions plus fpgm
        and cvt tables, all carrying the given content."""
        import array

        font = TTFont(path)
        for name in font.getGlyphOrder():
            program = Program()
            program.fromBytecode(bytecode)
            font["glyf"][name].program = program
        fpgm = newTable("fpgm")
        fpgm.program = Program()
        fpgm.program.fromBytecode(bytecode)
        font["fpgm"] = fpgm
        cvt = newTable("cvt ")
        cvt.values = array.array("h", [cvt_value])
        font["cvt "] = cvt
        font.save(path)
        return path

    def test_grafted_glyphs_carry_no_instructions_and_no_donor_tables(
        self, tmp_path: Path, synth_font_factory
    ):
        base = self._hinted(
            synth_font_factory(
                tmp_path / "base.ttf",
                family="SynthBase",
                codepoints=BASE_CODEPOINTS,
            ),
            b"\x00\x01",  # SVTCA[y], SVTCA[x] — the base's own hinting
            cvt_value=42,
        )
        donor = self._hinted(
            synth_font_factory(
                tmp_path / "donor.ttf",
                family="SynthDonor",
                codepoints=(0x4E2D,),
            ),
            b"\x01\x02\x03",
            cvt_value=99,
        )
        recipe = _write_recipe(tmp_path, base, donor)

        result = build(recipe, tmp_path / "out.ttf")

        out = TTFont(result.font_path)
        grafted = out.getBestCmap()[0x4E2D]
        # Donor instructions never ride along with a grafted glyph.
        program = getattr(out["glyf"][grafted], "program", None)
        assert not program or not program.getBytecode()

        # The base keeps its own hinting machinery, untouched.
        assert out["fpgm"].program.getBytecode() == b"\x00\x01"
        for name in ("A", "B"):
            base_glyph = TTFont(base).getBestCmap()[ord(name)]
            assert out["glyf"][base_glyph].program.getBytecode() == b"\x00\x01"
        # Donor tables never enter the container: the output's cvt is
        # the base's own, not the donor's.
        assert list(out["cvt "].values) == [42]


# --- CFF donors ride the same normalization ---------------------------------


class TestCFFNormalization:
    """The OTF-in route (cu2qu conversion) carries the same scale."""

    def test_a_cff_donor_lands_scaled_and_gridded(
        self, tmp_path: Path, synth_font_factory
    ):
        from conftest import synth_cff_font

        base = synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=BASE_CODEPOINTS
        )
        donor = synth_cff_font(tmp_path / "donor.otf", family="SynthDonorCFF")
        recipe = _write_recipe(tmp_path, base, donor)

        result = build(recipe, tmp_path / "out.ttf")

        out = TTFont(result.font_path)
        cmap = out.getBestCmap()
        # Han heights [400, 500] -> k = 1.2: ink (40, 0, 560, 400) * 1.2.
        assert _bounds(out, cmap[0x4E2D]) == (48, 0, 672, 480)
        assert out["hmtx"][cmap[0x4E2D]] == (1200, 48)
        assert _advance(out, 0x56FD) == 1200


# --- determinism ------------------------------------------------------------


class TestNormalizationIsDeterministic:
    def test_two_builds_are_byte_identical(self, tmp_path: Path,
                                           synth_font_factory):
        base = synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=BASE_CODEPOINTS
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf",
            family="SynthDonor",
            codepoints=tuple(range(0x4E00, 0x4E0A)),
            upem=2048,
        )
        recipe = _write_recipe(
            tmp_path,
            base,
            donor,
            extra="normalization:\n  quote_dash_width: fullwidth\n",
        )
        output = tmp_path / "out.ttf"

        build(recipe, output)
        first = output.read_bytes()
        build(recipe, output)
        assert output.read_bytes() == first
