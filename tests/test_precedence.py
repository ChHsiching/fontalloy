"""Seam 1 tests: the precedence engine and the effective table.

Layered precedence rules go into a recipe; the effective merged result —
which font wins each codepoint, through which rule, as a fill or an
override — is read back from the build report. Per the testing decisions
in issue #1, everything is observed through the single public entry point
``fontalloy_core.build``; fixture fonts are synthetic.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from fontalloy_core import RecipeError, build


def _recipe(tmp_path: Path, text: str) -> Path:
    path = tmp_path / "recipe.yaml"
    path.write_text(text, encoding="utf-8")
    return path


def _report(result) -> dict:
    return json.loads(result.report_path.read_text(encoding="utf-8"))


def _entries(report: dict) -> dict[int, dict]:
    return {entry["codepoint"]: entry for entry in report["provenance"]}


class TestRuleParsing:
    """Rules and named sets parse strictly; every failure names the spot."""

    def test_rule_referencing_an_unknown_font_is_rejected(self, tmp_path):
        recipe = _recipe(
            tmp_path,
            "base: base.ttf\n"
            "donors:\n"
            "  - donor0.ttf\n"
            "rules:\n"
            "  - range: 0x4E00-0x4E02\n"
            "    fonts: [donor-1]\n",
        )

        with pytest.raises(RecipeError, match="donor-1"):
            build(recipe, tmp_path / "out.ttf")

    def test_rule_font_list_may_not_repeat_a_font(self, tmp_path):
        recipe = _recipe(
            tmp_path,
            "base: base.ttf\n"
            "donors:\n"
            "  - donor0.ttf\n"
            "rules:\n"
            "  - codepoint: 0x4E2D\n"
            "    fonts: [donor-0, donor-0]\n",
        )

        with pytest.raises(RecipeError, match="donor-0"):
            build(recipe, tmp_path / "out.ttf")

    def test_rule_without_a_font_list_is_rejected(self, tmp_path):
        recipe = _recipe(
            tmp_path,
            "base: base.ttf\n"
            "donors:\n"
            "  - donor0.ttf\n"
            "rules:\n"
            "  - range: 0x4E00-0x4E02\n",
        )

        with pytest.raises(RecipeError, match="fonts"):
            build(recipe, tmp_path / "out.ttf")

    def test_rule_with_an_empty_font_list_is_rejected(self, tmp_path):
        recipe = _recipe(
            tmp_path,
            "base: base.ttf\n"
            "donors:\n"
            "  - donor0.ttf\n"
            "rules:\n"
            "  - range: 0x4E00-0x4E02\n"
            "    fonts: []\n",
        )

        with pytest.raises(RecipeError, match="fonts"):
            build(recipe, tmp_path / "out.ttf")

    def test_rule_font_list_must_be_a_list(self, tmp_path):
        recipe = _recipe(
            tmp_path,
            "base: base.ttf\n"
            "donors:\n"
            "  - donor0.ttf\n"
            "rules:\n"
            "  - range: 0x4E00-0x4E02\n"
            "    fonts: donor-0\n",
        )

        with pytest.raises(RecipeError, match="fonts"):
            build(recipe, tmp_path / "out.ttf")

    def test_rule_without_a_target_is_rejected(self, tmp_path):
        recipe = _recipe(
            tmp_path,
            "base: base.ttf\n"
            "donors:\n"
            "  - donor0.ttf\n"
            "rules:\n"
            "  - fonts: [donor-0]\n",
        )

        with pytest.raises(RecipeError, match="rules\\[0\\]"):
            build(recipe, tmp_path / "out.ttf")

    def test_rule_with_two_targets_is_rejected(self, tmp_path):
        recipe = _recipe(
            tmp_path,
            "base: base.ttf\n"
            "donors:\n"
            "  - donor0.ttf\n"
            "rules:\n"
            "  - codepoint: 0x4E2D\n"
            "    range: 0x4E00-0x4E02\n"
            "    fonts: [donor-0]\n",
        )

        with pytest.raises(RecipeError, match="rules\\[0\\]"):
            build(recipe, tmp_path / "out.ttf")

    def test_rule_with_an_unknown_field_is_rejected(self, tmp_path):
        recipe = _recipe(
            tmp_path,
            "base: base.ttf\n"
            "donors:\n"
            "  - donor0.ttf\n"
            "rules:\n"
            "  - range: 0x4E00-0x4E02\n"
            "    fonts: [donor-0]\n"
            "    fond: [base]\n",
        )

        with pytest.raises(RecipeError, match="fond"):
            build(recipe, tmp_path / "out.ttf")

    @pytest.mark.parametrize("value", [0x110000, 0xD800, -1, "0x41", True])
    def test_codepoint_target_must_be_a_unicode_scalar(self, tmp_path, value):
        recipe = _recipe(
            tmp_path,
            "base: base.ttf\n"
            "donors:\n"
            "  - donor0.ttf\n"
            "rules:\n"
            f"  - codepoint: {value!r}\n"
            "    fonts: [donor-0]\n",
        )

        with pytest.raises(RecipeError, match="codepoint"):
            build(recipe, tmp_path / "out.ttf")

    @pytest.mark.parametrize("value", ["0x9-0x2", "junk", "0x4E00", 42])
    def test_range_target_must_be_a_well_formed_interval_string(self, tmp_path, value):
        recipe = _recipe(
            tmp_path,
            "base: base.ttf\n"
            "donors:\n"
            "  - donor0.ttf\n"
            "rules:\n"
            f"  - range: {value!r}\n"
            "    fonts: [donor-0]\n",
        )

        with pytest.raises(RecipeError, match="range"):
            build(recipe, tmp_path / "out.ttf")

    def test_rule_referencing_an_undeclared_named_set_is_rejected(self, tmp_path):
        recipe = _recipe(
            tmp_path,
            "base: base.ttf\n"
            "donors:\n"
            "  - donor0.ttf\n"
            "rules:\n"
            "  - set: han\n"
            "    fonts: [donor-0]\n",
        )

        with pytest.raises(RecipeError, match="han"):
            build(recipe, tmp_path / "out.ttf")

    @pytest.mark.parametrize(
        "sets_body",
        [
            "  han: junk\n",
            "  han: []\n",
            "  han: [7, junk]\n",
            "  han: {a: 1}\n",
        ],
    )
    def test_named_set_definitions_are_validated(self, tmp_path, sets_body):
        recipe = _recipe(
            tmp_path,
            "base: base.ttf\n"
            "donors:\n"
            "  - donor0.ttf\n"
            "sets:\n" + sets_body +
            "rules:\n"
            "  - set: han\n"
            "    fonts: [donor-0]\n",
        )

        with pytest.raises(RecipeError, match="han"):
            build(recipe, tmp_path / "out.ttf")

    def test_sets_must_be_a_mapping(self, tmp_path):
        recipe = _recipe(
            tmp_path,
            "base: base.ttf\n"
            "donors:\n"
            "  - donor0.ttf\n"
            "sets: [han]\n",
        )

        with pytest.raises(RecipeError, match="sets"):
            build(recipe, tmp_path / "out.ttf")

    def test_rules_must_be_a_list(self, tmp_path):
        recipe = _recipe(
            tmp_path,
            "base: base.ttf\n"
            "donors:\n"
            "  - donor0.ttf\n"
            "rules: 7\n",
        )

        with pytest.raises(RecipeError, match="rules"):
            build(recipe, tmp_path / "out.ttf")

    def test_empty_rules_and_sets_build_like_a_v0_recipe(
        self, tmp_path, synth_font_factory
    ):
        base = synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=(0x41,)
        )
        donor = synth_font_factory(
            tmp_path / "donor0.ttf", family="SynthDonor", codepoints=(0x4E2D,)
        )
        recipe = _recipe(
            tmp_path,
            f"base: {base.name}\n"
            f"donors:\n  - {donor.name}\n"
            "sets: {}\n"
            "rules: []\n",
        )

        result = build(recipe, tmp_path / "out.ttf")

        entries = _entries(_report(result))
        assert entries[0x41]["winner"] == "base"
        assert entries[0x4E2D]["winner"] == "donor-0"


class TestEffectiveTable:
    """The resolver expands layered rules to codepoint level.

    Every provenance entry says which font won the codepoint, through
    which precedence (``via``: "default" or the winning rule's id), and
    how the glyph got there (``kind``: "base", "fill", or "override").
    """

    def test_rule_less_recipes_resolve_through_the_default_precedence(
        self, recipe_file, tmp_path
    ):
        result = build(recipe_file, tmp_path / "out.ttf")

        entries = _entries(_report(result))
        assert entries[0x41] == {
            "codepoint": 0x41,
            "winner": "base",
            "in_output": True,
            "via": "default",
            "kind": "base",
        }
        assert entries[0x4E2D] == {
            "codepoint": 0x4E2D,
            "winner": "donor-0",
            "in_output": True,
            "via": "default",
            "kind": "fill",
        }

    def test_the_narrowest_granularity_wins(self, tmp_path, synth_font_factory):
        # base owns 0x41; the donors carve up the 0x4E00 block so each
        # codepoint is assertable per layer.
        synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=(0x41,)
        )
        synth_font_factory(
            tmp_path / "donor0.ttf",
            family="SynthDonorZero",
            codepoints=(0x4E00, 0x4E01, 0x4E02),
        )
        synth_font_factory(
            tmp_path / "donor1.ttf", family="SynthDonorOne", codepoints=(0x4E00, 0x4E01)
        )
        synth_font_factory(
            tmp_path / "donor2.ttf", family="SynthDonorTwo", codepoints=(0x4E00, 0x30FB)
        )
        recipe = _recipe(
            tmp_path,
            "base: base.ttf\n"
            "donors:\n"
            "  - donor0.ttf\n"
            "  - donor1.ttf\n"
            "  - donor2.ttf\n"
            "sets:\n"
            "  block: 0x4E00-0x4E02\n"
            "rules:\n"
            "  - set: block\n"
            "    fonts: [donor-0]\n"
            "  - range: 0x4E00-0x4E01\n"
            "    fonts: [donor-1]\n"
            "  - codepoint: 0x4E00\n"
            "    fonts: [donor-2]\n",
        )

        result = build(recipe, tmp_path / "out.ttf")

        entries = _entries(_report(result))
        # A single codepoint beats the custom range...
        assert (entries[0x4E00]["winner"], entries[0x4E00]["via"]) == (
            "donor-2",
            "rule-2",
        )
        # ...which beats the named set, even though the set rule was
        # declared first and the range later.
        assert (entries[0x4E01]["winner"], entries[0x4E01]["via"]) == (
            "donor-1",
            "rule-1",
        )
        assert (entries[0x4E02]["winner"], entries[0x4E02]["via"]) == (
            "donor-0",
            "rule-0",
        )
        # An uncovered codepoint fills through the global default.
        assert (entries[0x30FB]["winner"], entries[0x30FB]["via"]) == (
            "donor-2",
            "default",
        )
        assert (entries[0x41]["winner"], entries[0x41]["via"]) == ("base", "default")

    def test_overlapping_custom_ranges_resolve_to_the_last_declared(
        self, tmp_path, synth_font_factory
    ):
        synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=(0x41,)
        )
        synth_font_factory(
            tmp_path / "donor0.ttf",
            family="SynthDonorZero",
            codepoints=(0x4E00, 0x4E01, 0x4E02),
        )
        synth_font_factory(
            tmp_path / "donor1.ttf",
            family="SynthDonorOne",
            codepoints=(0x4E01, 0x4E02, 0x4E03),
        )
        recipe = _recipe(
            tmp_path,
            "base: base.ttf\n"
            "donors:\n"
            "  - donor0.ttf\n"
            "  - donor1.ttf\n"
            "rules:\n"
            "  - range: 0x4E00-0x4E02\n"
            "    fonts: [donor-0]\n"
            "  - range: 0x4E01-0x4E03\n"
            "    fonts: [donor-1]\n",
        )

        result = build(recipe, tmp_path / "out.ttf")

        entries = _entries(_report(result))
        assert (entries[0x4E00]["winner"], entries[0x4E00]["via"]) == (
            "donor-0",
            "rule-0",
        )
        for codepoint in (0x4E01, 0x4E02, 0x4E03):
            assert (entries[codepoint]["winner"], entries[codepoint]["via"]) == (
                "donor-1",
                "rule-1",
            )

    def test_overlapping_named_sets_resolve_to_the_last_declared(
        self, tmp_path, synth_font_factory
    ):
        synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=(0x41,)
        )
        synth_font_factory(
            tmp_path / "donor0.ttf", family="SynthDonorZero", codepoints=(0x4E00, 0x4E01)
        )
        synth_font_factory(
            tmp_path / "donor1.ttf", family="SynthDonorOne", codepoints=(0x4E01,)
        )
        recipe = _recipe(
            tmp_path,
            "base: base.ttf\n"
            "donors:\n"
            "  - donor0.ttf\n"
            "  - donor1.ttf\n"
            "sets:\n"
            "  alpha: 0x4E00-0x4E01\n"
            "  beta: 0x4E01\n"
            "rules:\n"
            "  - set: alpha\n"
            "    fonts: [donor-0]\n"
            "  - set: beta\n"
            "    fonts: [donor-1]\n",
        )

        result = build(recipe, tmp_path / "out.ttf")

        entries = _entries(_report(result))
        assert (entries[0x4E00]["winner"], entries[0x4E00]["via"]) == (
            "donor-0",
            "rule-0",
        )
        assert (entries[0x4E01]["winner"], entries[0x4E01]["via"]) == (
            "donor-1",
            "rule-1",
        )

    def test_absence_never_overrides_within_a_rule_font_list(
        self, tmp_path, synth_font_factory
    ):
        # donor-0 heads the list but holds only 0x4E01; donor-1 fills the
        # rest of the range through the same rule.
        synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=(0x41,)
        )
        synth_font_factory(
            tmp_path / "donor0.ttf", family="SynthDonorZero", codepoints=(0x4E01,)
        )
        synth_font_factory(
            tmp_path / "donor1.ttf",
            family="SynthDonorOne",
            codepoints=(0x4E00, 0x4E02),
        )
        recipe = _recipe(
            tmp_path,
            "base: base.ttf\n"
            "donors:\n"
            "  - donor0.ttf\n"
            "  - donor1.ttf\n"
            "rules:\n"
            "  - range: 0x4E00-0x4E02\n"
            "    fonts: [donor-0, donor-1]\n",
        )

        result = build(recipe, tmp_path / "out.ttf")

        entries = _entries(_report(result))
        assert (entries[0x4E01]["winner"], entries[0x4E01]["via"]) == (
            "donor-0",
            "rule-0",
        )
        for codepoint in (0x4E00, 0x4E02):
            assert (entries[codepoint]["winner"], entries[codepoint]["via"]) == (
                "donor-1",
                "rule-0",
            )

    def test_a_rule_whose_fonts_all_lack_the_codepoint_falls_back_to_the_default(
        self, tmp_path, synth_font_factory
    ):
        # The rule claims 0x4E00-0x4E01 for donor-0, which holds neither;
        # the base has 0x4E00 and keeps it through the default precedence.
        synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=(0x41, 0x4E00)
        )
        synth_font_factory(
            tmp_path / "donor0.ttf", family="SynthDonorZero", codepoints=(0x30FB,)
        )
        recipe = _recipe(
            tmp_path,
            "base: base.ttf\n"
            "donors:\n"
            "  - donor0.ttf\n"
            "rules:\n"
            "  - range: 0x4E00-0x4E01\n"
            "    fonts: [donor-0]\n",
        )

        result = build(recipe, tmp_path / "out.ttf")

        entries = _entries(_report(result))
        assert (entries[0x4E00]["winner"], entries[0x4E00]["via"]) == (
            "base",
            "default",
        )
        assert entries[0x4E00]["kind"] == "base"
        # No font holds 0x4E01, so it is not in the effective table at all.
        assert 0x4E01 not in entries

    def test_rules_classify_base_keeps_fills_and_overrides(
        self, tmp_path, synth_font_factory
    ):
        # rule-0 lists no base font: it displaces the base glyph at 0x41
        # (override) and fills 0x42. rule-1 lists base first: the base
        # keeps its glyph at 0x4E2D through an explicit rule, and donor-1
        # only fills what the base lacks.
        synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=(0x41, 0x4E2D)
        )
        synth_font_factory(
            tmp_path / "donor0.ttf", family="SynthDonorZero", codepoints=(0x41, 0x42)
        )
        synth_font_factory(
            tmp_path / "donor1.ttf", family="SynthDonorOne", codepoints=(0x4E2D, 0x4E2E)
        )
        recipe = _recipe(
            tmp_path,
            "base: base.ttf\n"
            "donors:\n"
            "  - donor0.ttf\n"
            "  - donor1.ttf\n"
            "rules:\n"
            "  - range: 0x41-0x42\n"
            "    fonts: [donor-0]\n"
            "  - range: 0x4E2D-0x4E2E\n"
            "    fonts: [base, donor-1]\n",
        )

        result = build(recipe, tmp_path / "out.ttf")

        entries = _entries(_report(result))
        assert (entries[0x41]["winner"], entries[0x41]["kind"]) == (
            "donor-0",
            "override",
        )
        assert (entries[0x42]["winner"], entries[0x42]["kind"]) == ("donor-0", "fill")
        assert (entries[0x4E2D]["winner"], entries[0x4E2D]["kind"]) == ("base", "base")
        assert (entries[0x4E2E]["winner"], entries[0x4E2E]["kind"]) == (
            "donor-1",
            "fill",
        )


class TestConflictAndFillReport:
    """The report distinguishes fills, overrides, and same-layer conflicts."""

    def test_rule_less_recipes_report_no_conflicts_and_no_rules(
        self, recipe_file, tmp_path
    ):
        result = build(recipe_file, tmp_path / "out.ttf")

        report = _report(result)
        assert report["rules"] == []
        assert report["precedence"] == {
            "counts": {"base": 2, "fill": 2, "override": 0},
            "same_layer_conflicts": [],
        }

    def test_the_report_counts_fills_overrides_and_base_keeps(
        self, tmp_path, synth_font_factory
    ):
        # The fill/override scenario: one override (0x41), two fills
        # (0x42, 0x4E2E), one base keep through an explicit rule (0x4E2D).
        synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=(0x41, 0x4E2D)
        )
        synth_font_factory(
            tmp_path / "donor0.ttf", family="SynthDonorZero", codepoints=(0x41, 0x42)
        )
        synth_font_factory(
            tmp_path / "donor1.ttf", family="SynthDonorOne", codepoints=(0x4E2D, 0x4E2E)
        )
        recipe = _recipe(
            tmp_path,
            "base: base.ttf\n"
            "donors:\n"
            "  - donor0.ttf\n"
            "  - donor1.ttf\n"
            "rules:\n"
            "  - range: 0x41-0x42\n"
            "    fonts: [donor-0]\n"
            "  - range: 0x4E2D-0x4E2E\n"
            "    fonts: [base, donor-1]\n",
        )

        result = build(recipe, tmp_path / "out.ttf")

        report = _report(result)
        assert report["precedence"]["counts"] == {
            "base": 1,
            "fill": 2,
            "override": 1,
        }

    def test_overlapping_custom_ranges_report_their_overlap(
        self, tmp_path, synth_font_factory
    ):
        synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=(0x41,)
        )
        synth_font_factory(
            tmp_path / "donor0.ttf",
            family="SynthDonorZero",
            codepoints=(0x4E00, 0x4E01, 0x4E02),
        )
        synth_font_factory(
            tmp_path / "donor1.ttf",
            family="SynthDonorOne",
            codepoints=(0x4E01, 0x4E02, 0x4E03),
        )
        recipe = _recipe(
            tmp_path,
            "base: base.ttf\n"
            "donors:\n"
            "  - donor0.ttf\n"
            "  - donor1.ttf\n"
            "rules:\n"
            "  - range: 0x4E00-0x4E02\n"
            "    fonts: [donor-0]\n"
            "  - range: 0x4E01-0x4E03\n"
            "    fonts: [donor-1]\n",
        )

        result = build(recipe, tmp_path / "out.ttf")

        assert _report(result)["precedence"]["same_layer_conflicts"] == [
            {
                "granularity": "range",
                "shadowed": "rule-0",
                "winner": "rule-1",
                "overlap": ["0x4E01-0x4E02"],
                "codepoints": 2,
            }
        ]

    def test_overlapping_named_sets_report_a_set_granularity_conflict(
        self, tmp_path, synth_font_factory
    ):
        synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=(0x41,)
        )
        synth_font_factory(
            tmp_path / "donor0.ttf", family="SynthDonorZero", codepoints=(0x4E00, 0x4E01)
        )
        synth_font_factory(
            tmp_path / "donor1.ttf", family="SynthDonorOne", codepoints=(0x4E01,)
        )
        recipe = _recipe(
            tmp_path,
            "base: base.ttf\n"
            "donors:\n"
            "  - donor0.ttf\n"
            "  - donor1.ttf\n"
            "sets:\n"
            "  alpha: 0x4E00-0x4E01\n"
            "  beta: 0x4E01\n"
            "rules:\n"
            "  - set: alpha\n"
            "    fonts: [donor-0]\n"
            "  - set: beta\n"
            "    fonts: [donor-1]\n",
        )

        result = build(recipe, tmp_path / "out.ttf")

        assert _report(result)["precedence"]["same_layer_conflicts"] == [
            {
                "granularity": "set",
                "shadowed": "rule-0",
                "winner": "rule-1",
                "overlap": ["0x4E01-0x4E01"],
                "codepoints": 1,
            }
        ]

    def test_overlaps_across_granularity_layers_are_not_conflicts(
        self, tmp_path, synth_font_factory
    ):
        # A custom range overlapping a named set resolves by granularity,
        # not by declaration order — that is a layering decision, not a
        # same-layer conflict.
        synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=(0x41,)
        )
        synth_font_factory(
            tmp_path / "donor0.ttf", family="SynthDonorZero", codepoints=(0x4E00, 0x4E01)
        )
        synth_font_factory(
            tmp_path / "donor1.ttf", family="SynthDonorOne", codepoints=(0x4E01,)
        )
        recipe = _recipe(
            tmp_path,
            "base: base.ttf\n"
            "donors:\n"
            "  - donor0.ttf\n"
            "  - donor1.ttf\n"
            "sets:\n"
            "  alpha: 0x4E00-0x4E01\n"
            "rules:\n"
            "  - set: alpha\n"
            "    fonts: [donor-0]\n"
            "  - range: 0x4E01-0x4E01\n"
            "    fonts: [donor-1]\n",
        )

        result = build(recipe, tmp_path / "out.ttf")

        report = _report(result)
        assert report["precedence"]["same_layer_conflicts"] == []
        assert (entries := _entries(report))[0x4E01]["via"] == "rule-1"

    def test_the_report_lists_the_rule_declarations(
        self, tmp_path, synth_font_factory
    ):
        synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=(0x41,)
        )
        synth_font_factory(
            tmp_path / "donor0.ttf", family="SynthDonorZero", codepoints=(0x4E00,)
        )
        recipe = _recipe(
            tmp_path,
            "base: base.ttf\n"
            "donors:\n"
            "  - donor0.ttf\n"
            "sets:\n"
            "  alpha:\n"
            "    - 0x4E00\n"
            "    - 0x2100-0x2101\n"
            "rules:\n"
            "  - range: 0x2100-0x214F\n"
            "    fonts: [donor-0, base]\n"
            "  - set: alpha\n"
            "    fonts: [donor-0]\n"
            "  - codepoint: 0x4E00\n"
            "    fonts: [donor-0]\n",
        )

        result = build(recipe, tmp_path / "out.ttf")

        assert _report(result)["rules"] == [
            {
                "id": "rule-0",
                "granularity": "range",
                "target": "0x2100-0x214F",
                "fonts": ["donor-0", "base"],
            },
            {
                "id": "rule-1",
                "granularity": "set",
                "target": "alpha",
                "fonts": ["donor-0"],
            },
            {
                "id": "rule-2",
                "granularity": "codepoint",
                "target": "0x4E00",
                "fonts": ["donor-0"],
            },
        ]
