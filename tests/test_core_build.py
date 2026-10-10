"""Seam 1 tests: the core build API.

Recipe + font files in, built font + verification report out. Per the
testing decisions in issue #1, the whole pipeline is exercised through the
single public entry point ``fontalloy_core.build``; nothing here touches
private functions or internal structure. Fixture fonts are synthetic fonts
generated with fontTools — never catalog binaries.
"""

from __future__ import annotations

import pytest

from fontalloy_core import RecipeError, build


class TestRecipeValidation:
    """A recipe is parsed strictly and every failure names the field."""

    def test_missing_recipe_file_is_a_clear_error(self, tmp_path):
        missing = tmp_path / "no-such-recipe.yaml"

        with pytest.raises(RecipeError, match="no-such-recipe.yaml"):
            build(missing, tmp_path / "out.ttf")

    def test_recipe_that_is_not_yaml_is_a_clear_error(self, tmp_path):
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text("base: [unclosed\n", encoding="utf-8")

        with pytest.raises(RecipeError, match="YAML"):
            build(recipe, tmp_path / "out.ttf")

    def test_recipe_without_base_is_a_clear_error(self, tmp_path):
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text("donors:\n  - donor.ttf\n", encoding="utf-8")

        with pytest.raises(RecipeError, match="base"):
            build(recipe, tmp_path / "out.ttf")

    def test_recipe_without_donors_is_a_clear_error(self, tmp_path):
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text("base: base.ttf\n", encoding="utf-8")

        with pytest.raises(RecipeError, match="donors"):
            build(recipe, tmp_path / "out.ttf")

    def test_unknown_recipe_field_is_rejected(self, tmp_path):
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            "base: base.ttf\ndonors:\n  - donor.ttf\nbogus: true\n",
            encoding="utf-8",
        )

        with pytest.raises(RecipeError, match="bogus"):
            build(recipe, tmp_path / "out.ttf")

    def test_non_string_base_is_a_clear_error(self, tmp_path):
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text("base: 42\ndonors: []\n", encoding="utf-8")

        with pytest.raises(RecipeError, match="base"):
            build(recipe, tmp_path / "out.ttf")

    def test_non_list_donors_is_a_clear_error(self, tmp_path):
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text("base: base.ttf\ndonors: base.ttf\n", encoding="utf-8")

        with pytest.raises(RecipeError, match="donors"):
            build(recipe, tmp_path / "out.ttf")

    def test_non_string_donor_entry_is_a_clear_error(self, tmp_path):
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text("base: base.ttf\ndonors:\n  - 7\n", encoding="utf-8")

        with pytest.raises(RecipeError, match=r"donors\[0\]"):
            build(recipe, tmp_path / "out.ttf")
