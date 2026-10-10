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
