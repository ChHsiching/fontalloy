"""The verification report in final form (issue #12): coverage, borrow
table, metric comparison — machine-readable JSON plus the deterministic
human renderings every consumer displays.

Everything here goes through the seam-1 entry point ``build``: the
report is an observable output of a build, asserted as the JSON a
consumer reads back from disk (and, for the renderings, the strings the
core exports). Fixture values the metric assertions pin:

- the default base covers 0x41/0x42 at advance 600 (upem 1000, hhea
  800/-200/0, typo 800/-200, win 900/300);
- the default donor covers 0x4E2D/0x56FD with ink heights 400/500, so
  H_ink (p90, linear interpolation) = 490 and the grid school's k =
  min(2*600/1000, 0.95*1000/490) = 1.2.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fontTools.ttLib import TTFont

from conftest import (  # noqa: F401
    BASE_CODEPOINTS,
    DONOR_CODEPOINTS,
    fontalloy_exe,
    recipe_file,
    run_cli,
    synth_font_factory,
)
from fontalloy_core import build, render_html, render_text

SCHEMA_V2 = "fontalloy/verification-report@v2"


def _load_report(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


class TestSchemaV2:
    """The report shape carries the coverage and metrics sections."""

    def test_the_report_declares_schema_v2(self, recipe_file, tmp_path):
        result = build(recipe_file, tmp_path / "out.ttf")

        report = _load_report(result.report_path)
        assert report["schema"] == SCHEMA_V2
        # The new sections are always present, like the weights section.
        assert "coverage" in report
        assert "metrics" in report


class TestCodepointCoverage:
    """Per rule: requested target vs the effective result, gaps explicit."""

    def test_overall_coverage_matches_the_effective_table(
        self, recipe_file, tmp_path
    ):
        result = build(recipe_file, tmp_path / "out.ttf")

        coverage = _load_report(result.report_path)["coverage"]
        # The whole-build scope: the union of all source coverages (the
        # effective table), all of it landed in the output.
        assert coverage["overall"] == {
            "requested": 4,
            "covered": 4,
            "missing": [],
            "missing_total": 0,
            "missing_truncated": False,
        }

    def test_a_rule_that_nobody_can_supply_lists_its_gaps(
        self, tmp_path, base_font, donor_font
    ):
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base: {base_font.name}\ndonors:\n  - {donor_font.name}\n"
            "rules:\n  - range: 0x2100-0x2103\n    fonts: [donor-0]\n",
            encoding="utf-8",
        )

        result = build(recipe, tmp_path / "out.ttf")

        [rule] = _load_report(result.report_path)["coverage"]["rules"]
        assert rule["rule"] == "rule-0"
        assert rule["granularity"] == "range"
        assert rule["target"] == "0x2100-0x2103"
        assert rule["requested"] == 4
        assert rule["covered"] == 0
        assert rule["missing"] == ["0x2100", "0x2101", "0x2102", "0x2103"]
        assert rule["missing_total"] == 4
        assert rule["missing_truncated"] is False

    def test_a_partially_supplied_range_lists_only_the_real_gaps(
        self, tmp_path, base_font, synth_font_factory
    ):
        donor = synth_font_factory(
            tmp_path / "donor.ttf",
            family="SynthDonor",
            codepoints=(0x4E2D, 0x2100, 0x2102),
        )
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base: {base_font.name}\ndonors:\n  - {donor.name}\n"
            "rules:\n  - range: 0x2100-0x2103\n    fonts: [donor-0]\n",
            encoding="utf-8",
        )

        result = build(recipe, tmp_path / "out.ttf")

        [rule] = _load_report(result.report_path)["coverage"]["rules"]
        assert rule["requested"] == 4
        assert rule["covered"] == 2
        assert rule["missing"] == ["0x2101", "0x2103"]
        assert rule["missing_total"] == 2

    def test_a_fully_covered_rule_states_no_gaps(self, tmp_path, base_font, donor_font):
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base: {base_font.name}\ndonors:\n  - {donor_font.name}\n"
            "rules:\n  - codepoint: 0x4E2D\n    fonts: [donor-0]\n",
            encoding="utf-8",
        )

        result = build(recipe, tmp_path / "out.ttf")

        [rule] = _load_report(result.report_path)["coverage"]["rules"]
        assert rule["granularity"] == "codepoint"
        assert rule["target"] == "0x4E2D"
        assert (rule["requested"], rule["covered"], rule["missing_total"]) == (1, 1, 0)
        assert rule["missing"] == []

    def test_preset_gap_lists_are_bounded_with_totals(
        self, tmp_path, base_font, donor_font
    ):
        """A preset where no font holds most codepoints: the gap list is
        capped, the totals stay exact."""
        from fontalloy_core.presets import PRESETS

        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base: {base_font.name}\ndonors:\n  - {donor_font.name}\n"
            "rules:\n  - set: ja\n    fonts: [donor-0]\n",
            encoding="utf-8",
        )

        result = build(recipe, tmp_path / "out.ttf")

        [rule] = _load_report(result.report_path)["coverage"]["rules"]
        assert rule["granularity"] == "set"
        assert rule["target"] == "ja"
        requested = len(PRESETS["ja"].codepoints)
        assert rule["requested"] == requested
        # 中 and 国 are common Japanese kanji: the donor supplies exactly
        # the two fixture codepoints.
        assert rule["covered"] == 2
        assert rule["missing_total"] == requested - 2
        assert rule["missing_truncated"] is True
        assert len(rule["missing"]) == 256  # the bounded representation
        # The listed gaps are real gaps, ascending.
        listed = [int(label, 16) for label in rule["missing"]]
        assert listed == sorted(listed)
        output_cmap = set(TTFont(result.font_path).getBestCmap())
        assert all(codepoint not in output_cmap for codepoint in listed)


class TestWeightBorrowFamily:
    """The borrow table is self-contained: every borrow names the family."""

    def test_a_borrow_records_the_donor_family(self, recipe_file, tmp_path):
        result = build(recipe_file, tmp_path / "out.ttf")

        [borrow] = _load_report(result.report_path)["weights"][0]["borrows"]
        assert borrow["donor"] == "donor-0"
        assert borrow["family"] == "SynthDonor"


class TestMetricComparison:
    """Before/after per output face — and the untouched-line-height proof."""

    def test_the_grid_school_metrics_are_compared_against_the_base(
        self, recipe_file, tmp_path
    ):
        result = build(recipe_file, tmp_path / "out.ttf")

        [face] = _load_report(result.report_path)["metrics"]["faces"]
        assert face["slot"] == 0
        assert face["style"] == "upright"
        # upem unified: the base is the container.
        assert face["upem"] == {"base": 1000, "output": 1000}
        # A = 600 before and after; the CJK advance re-grids to 2A.
        assert face["latin_advance"] == {"base": 600, "output": 600}
        assert face["cjk_advance"] == {"base": None, "output": 1200}
        assert face["grid_ratio"] == 2.0
        # Vertical metrics: hhea/typo/win, base -> output.
        assert face["ascents"] == {
            "hhea": {"base": 800, "output": 800},
            "typo": {"base": 800, "output": 800},
            "us_win": {"base": 900, "output": 900},
        }
        assert face["descents"] == {
            "hhea": {"base": -200, "output": -200},
            "typo": {"base": -200, "output": -200},
            "us_win": {"base": 300, "output": 300},
        }
        # The proof the line-height contract held: hhea and typo are
        # structurally identical to the base face's.
        assert face["line_height_untouched"] == {"hhea": True, "typo": True}

    def test_k_and_s0_actually_applied_are_stated_per_donor(
        self, recipe_file, tmp_path
    ):
        result = build(recipe_file, tmp_path / "out.ttf")

        [face] = _load_report(result.report_path)["metrics"]["faces"]
        [donor] = face["normalization"]
        assert donor["donor"] == "donor-0"
        assert donor["upem"] == 1000
        assert donor["s0"] == pytest.approx(1.0)
        assert donor["han_ink_height"] == pytest.approx(490.0)
        assert donor["k"] == pytest.approx(1.2)
        assert donor["scale"] == pytest.approx(1.2)

    def test_a_donor_at_another_upem_states_its_s0(
        self, tmp_path, base_font, synth_font_factory
    ):
        donor = synth_font_factory(
            tmp_path / "donor.ttf",
            family="SynthDonor",
            codepoints=DONOR_CODEPOINTS,
            upem=2048,
        )
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base: {base_font.name}\ndonors:\n  - {donor.name}\n", encoding="utf-8"
        )

        result = build(recipe, tmp_path / "out.ttf")

        [face] = _load_report(result.report_path)["metrics"]["faces"]
        [record] = face["normalization"]
        assert record["upem"] == 2048
        assert record["s0"] == pytest.approx(1000 / 2048)
        # scale = s0 * k up to the JSON's fixed 6-decimal rounding.
        assert record["scale"] == pytest.approx(
            record["s0"] * record["k"], abs=1e-5
        )

    def test_usWin_grows_only_to_prevent_clipping(
        self, tmp_path, base_font, synth_font_factory
    ):
        # Donor ink above the base's usWinAscent (900): the graft must
        # grow win ascent, and only win ascent.
        donor = synth_font_factory(
            tmp_path / "donor.ttf",
            family="SynthDonor",
            codepoints=DONOR_CODEPOINTS,
            ink_dy=600,
        )
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base: {base_font.name}\ndonors:\n  - {donor.name}\n"
            "normalization:\n  mode: auto\n",
            encoding="utf-8"
        )

        result = build(recipe, tmp_path / "out.ttf")

        [face] = _load_report(result.report_path)["metrics"]["faces"]
        # Tallest grafted ink: (600 + 500) * 1.2 = 1320.
        assert face["ascents"]["us_win"] == {"base": 900, "output": 1320}
        assert face["descents"]["us_win"] == {"base": 300, "output": 300}
        # ...while the inherited line height stays untouched.
        assert face["line_height_untouched"] == {"hhea": True, "typo": True}
        assert face["ascents"]["typo"] == {"base": 800, "output": 800}

    def test_every_slot_of_a_collection_carries_its_own_metrics(
        self, tmp_path, synth_ttc_factory, synth_font_factory
    ):
        synth_ttc_factory(
            tmp_path / "family.ttc",
            faces=[
                dict(family="SynthBase", codepoints=BASE_CODEPOINTS, weight=400),
                dict(
                    family="SynthBase",
                    codepoints=BASE_CODEPOINTS,
                    weight=700,
                    subfamily="Bold",
                ),
            ],
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf", family="SynthDonor", codepoints=DONOR_CODEPOINTS
        )
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base: family.ttc\ndonors:\n  - {donor.name}\n"
            "normalization:\n  mode: auto\n"
            "output:\n  format: ttc\n",
            encoding="utf-8",
        )

        result = build(recipe, tmp_path / "out.ttc")

        faces = _load_report(result.report_path)["metrics"]["faces"]
        assert [face["slot"] for face in faces] == [0, 1]
        assert [face["weight"] for face in faces] == [400, 700]
        for face in faces:
            assert face["latin_advance"]["output"] == 600
            assert face["cjk_advance"]["output"] == 1200
            assert face["line_height_untouched"] == {"hhea": True, "typo": True}


class TestRenderedForms:
    """One generator, both consumers: text for the terminal, a
    self-contained HTML the GUI/WebApp display. Both deterministic."""

    def test_render_text_states_every_section(self, recipe_file, tmp_path):
        result = build(recipe_file, tmp_path / "out.ttf")

        text = render_text(result.report)
        assert SCHEMA_V2 in text
        assert "coverage" in text
        assert "weights" in text
        assert "metrics" in text
        assert "line height untouched" in text
        # The borrow line the interface has always stated (issue #9).
        assert "weight 400 upright: donor-0 from 400 (nearest)" in text
        # The normalization facts a human audits.
        assert "s0" in text and "k" in text

    def test_render_text_lists_gaps_bounded(self, tmp_path, base_font, donor_font):
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base: {base_font.name}\ndonors:\n  - {donor_font.name}\n"
            "rules:\n  - set: ja\n    fonts: [donor-0]\n",
            encoding="utf-8",
        )
        result = build(recipe, tmp_path / "out.ttf")

        text = render_text(result.report)
        assert "missing" in text
        # Bounded: the text shows a handful of gap labels plus the total,
        # never a two-thousand-line dump.
        gap_lines = [line for line in text.splitlines() if "0x" in line]
        assert max(len(line) for line in gap_lines) < 400
        assert text.count("0x4E2D") <= 1  # the covered one never floods

    def test_render_html_is_self_contained(self, recipe_file, tmp_path):
        result = build(recipe_file, tmp_path / "out.ttf")

        html = render_html(result.report)
        assert html.startswith("<!DOCTYPE html>")
        assert "<style>" in html  # the styling is embedded, not external
        assert 'src="http' not in html and 'href="http' not in html
        assert SCHEMA_V2 in html
        for section in ("coverage", "weights", "metrics", "Normalization"):
            assert section in html

    def test_both_renderings_are_deterministic(self, recipe_file, tmp_path):
        # Same pinned inputs rebuilt to the same paths: the renderings
        # are byte-identical with the report they render (the report
        # records the output path, so "identical inputs" means the same
        # destination — the reproducibility gate's own semantics).
        first = build(recipe_file, tmp_path / "out.ttf")
        text, page = render_text(first.report), render_html(first.report)
        assert render_text(first.report) == text  # pure: rerenders agree

        second = build(recipe_file, tmp_path / "out.ttf")

        assert render_text(second.report) == text
        assert render_html(second.report) == page

    def test_build_writes_the_human_form_beside_the_report(
        self, recipe_file, tmp_path
    ):
        result = build(recipe_file, tmp_path / "out.ttf")

        assert result.report_html_path == tmp_path / "out.report.html"
        html = result.report_html_path.read_text(encoding="utf-8")
        assert html.startswith("<!DOCTYPE html>")
        # Rebuilds are byte-identical over all three artifacts.
        first = (
            result.font_path.read_bytes(),
            result.report_path.read_bytes(),
            result.report_html_path.read_bytes(),
        )
        again = build(recipe_file, tmp_path / "out.ttf")
        second = (
            again.font_path.read_bytes(),
            again.report_path.read_bytes(),
            again.report_html_path.read_bytes(),
        )
        assert first == second

    def test_an_explicit_report_path_derives_its_html(self, recipe_file, tmp_path):
        result = build(recipe_file, tmp_path / "o.ttf", report_path=tmp_path / "r.json")

        assert result.report_html_path == tmp_path / "r.html"
        assert result.report_html_path.is_file()


class TestCliRendersTheReport:
    """The CLI build prints the terminal-friendly rendering."""

    def test_build_stdout_carries_the_rendered_report(
        self, fontalloy_exe, recipe_file
    ):
        result = run_cli(fontalloy_exe, "build", recipe_file.name, cwd=recipe_file.parent)

        assert result.returncode == 0, result.stderr
        assert "coverage" in result.stdout
        assert "metrics" in result.stdout
        assert "line height untouched" in result.stdout
        # The borrow lines stay stated on stdout (issue #9's contract).
        assert "weight 400 upright: donor-0 from 400 (nearest)" in result.stdout
