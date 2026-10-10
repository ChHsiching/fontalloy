"""Seam 1 tests: real-world input kinds through the build API.

Stage 1 of the pipeline (issue #4): TTC collections select by face,
variable fonts are detected and instantiated to static, woff2 is decoded.
All of it is observed through ``fontalloy_core.build`` — the output font
and the verification report are the only windows, per the testing
decisions in issue #1. Fixtures are synthetic (tiny TTC, tiny variable
font, tiny woff2), generated in-test; the repo tracks no font binaries.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fontTools.ttLib import TTFont

from conftest import BASE_CODEPOINTS, synth_font, synth_ttc, synth_variable_font
from fontalloy_core import BuildError, build


def _load_report(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


class TestCollectionInput:
    """A TTC collection enters the merge through an explicit face pick."""

    @pytest.fixture
    def collection(self, tmp_path: Path) -> Path:
        """A two-face TTC: Regular covers Latin-1, Bold covers CJK."""
        return synth_ttc(
            tmp_path / "coll.ttc",
            faces=[
                {"family": "SynthTTC", "weight": 400, "codepoints": (0x61,)},
                {
                    "family": "SynthTTC",
                    "weight": 700,
                    "codepoints": (0x4E2D, 0x56FD),
                    "subfamily": "Bold",
                },
            ],
        )

    def test_collection_base_builds_the_selected_face(
        self, tmp_path, collection
    ):
        donor = synth_font(
            tmp_path / "donor.ttf", family="SynthDonor", codepoints=(0x4E60,)
        )
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            "base:\n  path: coll.ttc\n  face: 1\n"
            f"donors:\n  - {donor.name}\n",
            encoding="utf-8",
        )

        result = build(recipe, tmp_path / "out.ttf")

        # v0 passes the base through: the output IS the selected face.
        font = TTFont(result.font_path)
        assert set(font.getBestCmap()) == {0x4E2D, 0x56FD}
        assert font["OS/2"].usWeightClass == 700

    def test_collection_donor_contributes_the_selected_faces_coverage(
        self, tmp_path, collection
    ):
        base = synth_font(
            tmp_path / "base.ttf", family="SynthBase", codepoints=BASE_CODEPOINTS
        )
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base: {base.name}\n"
            "donors:\n  - path: coll.ttc\n    face: 1\n",
            encoding="utf-8",
        )

        result = build(recipe, tmp_path / "out.ttf")

        # Face 1's coverage (CJK), not face 0's (Latin-1), enters the merge.
        report = _load_report(result.report_path)
        winners = {e["codepoint"]: e["winner"] for e in report["provenance"]}
        assert winners[0x4E2D] == "donor-0"
        assert winners[0x56FD] == "donor-0"
        assert 0x61 not in winners  # face 0 was never loaded

    def test_string_face_fragment_selects_the_face(
        self, tmp_path, collection
    ):
        base = synth_font(
            tmp_path / "base.ttf", family="SynthBase", codepoints=BASE_CODEPOINTS
        )
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base: {base.name}\n"
            "donors:\n  - coll.ttc#1\n",
            encoding="utf-8",
        )

        result = build(recipe, tmp_path / "out.ttf")

        report = _load_report(result.report_path)
        winners = {e["codepoint"]: e["winner"] for e in report["provenance"]}
        assert winners[0x4E2D] == "donor-0"

    def test_face_zero_on_a_plain_font_builds(self, tmp_path, base_font):
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base:\n  path: {base_font.name}\n  face: 0\ndonors: []\n",
            encoding="utf-8",
        )

        result = build(recipe, tmp_path / "out.ttf")

        assert set(TTFont(result.font_path).getBestCmap()) == set(BASE_CODEPOINTS)

    def test_collection_without_a_face_selection_is_a_clear_error(
        self, tmp_path, collection
    ):
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text("base: coll.ttc\ndonors: []\n", encoding="utf-8")

        with pytest.raises(BuildError, match=r"collection.*2 faces"):
            build(recipe, tmp_path / "out.ttf")

    def test_face_index_out_of_range_is_a_clear_error(self, tmp_path, collection):
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            "base:\n  path: coll.ttc\n  face: 2\ndonors: []\n", encoding="utf-8"
        )

        with pytest.raises(BuildError, match="face 2"):
            build(recipe, tmp_path / "out.ttf")


class TestVariableInput:
    """A variable font is detected and instantiated to a static face.

    The base font passes through to the output, so instantiation is
    observable directly in the output: no fvar, weight class matching
    the pinned (or default) instance, geometry interpolated.
    """

    VAR_CODEPOINTS = (0x41, 0x4E2D)

    @pytest.fixture
    def variable_font(self, tmp_path: Path) -> Path:
        return synth_variable_font(
            tmp_path / "var.ttf",
            family="SynthVar",
            codepoints=self.VAR_CODEPOINTS,
            axes=(("wght", 100, 400, 900),),
        )

    def test_variable_base_defaults_to_the_default_instance(
        self, tmp_path, variable_font
    ):
        donor = synth_font(
            tmp_path / "donor.ttf", family="SynthDonor", codepoints=(0x56FD,)
        )
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base: {variable_font.name}\ndonors:\n  - {donor.name}\n",
            encoding="utf-8",
        )

        result = build(recipe, tmp_path / "out.ttf")

        font = TTFont(result.font_path)
        assert "fvar" not in font  # instantiated to static, not merged as variable
        assert "gvar" not in font
        assert font["OS/2"].usWeightClass == 400  # the axis default
        assert set(font.getBestCmap()) == set(self.VAR_CODEPOINTS)

    def test_recipe_pinned_instance_values_are_applied(
        self, tmp_path, variable_font
    ):
        donor = synth_font(
            tmp_path / "donor.ttf", family="SynthDonor", codepoints=(0x56FD,)
        )
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base:\n  path: {variable_font.name}\n"
            "  instance:\n    wght: 700\n"
            f"donors:\n  - {donor.name}\n",
            encoding="utf-8",
        )

        result = build(recipe, tmp_path / "out.ttf")

        font = TTFont(result.font_path)
        assert "fvar" not in font
        assert font["OS/2"].usWeightClass == 700
        # The gvar grows glyphs toward wght=900; at 700 the geometry sits
        # between the default and the maximum.
        glyph = font["glyf"]["uni0041"]
        assert glyph.yMax > 400  # default ink height is 400 for the first codepoint
        assert glyph.yMax < 700  # the wght=900 ink height is 400 + 300

    def test_unpinned_axes_take_their_defaults(self, tmp_path):
        variable = synth_variable_font(
            tmp_path / "var.ttf",
            family="SynthVar",
            codepoints=self.VAR_CODEPOINTS,
            axes=(("wght", 100, 400, 900), ("wdth", 50, 100, 200)),
        )
        donor = synth_font(
            tmp_path / "donor.ttf", family="SynthDonor", codepoints=(0x56FD,)
        )
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base:\n  path: {variable.name}\n"
            "  instance:\n    wght: 700\n"
            f"donors:\n  - {donor.name}\n",
            encoding="utf-8",
        )

        result = build(recipe, tmp_path / "out.ttf")

        font = TTFont(result.font_path)
        assert "fvar" not in font  # fully static: unpinned axes took defaults
        assert font["OS/2"].usWeightClass == 700

    def test_variable_donor_with_pinned_instance_builds(
        self, tmp_path, base_font, variable_font
    ):
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base: {base_font.name}\n"
            f"donors:\n  - path: {variable_font.name}\n    instance:\n      wght: 900\n",
            encoding="utf-8",
        )

        result = build(recipe, tmp_path / "out.ttf")

        report = _load_report(result.report_path)
        winners = {e["codepoint"]: e["winner"] for e in report["provenance"]}
        assert winners[0x4E2D] == "donor-0"  # instantiated donor still fills CJK
        assert set(TTFont(result.font_path).getBestCmap()) == set(BASE_CODEPOINTS)

    def test_pinning_an_axis_the_font_does_not_have_is_a_clear_error(
        self, tmp_path, base_font, variable_font
    ):
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base: {base_font.name}\n"
            f"donors:\n  - path: {variable_font.name}\n    instance:\n      slnt: -10\n",
            encoding="utf-8",
        )

        with pytest.raises(BuildError, match="slnt"):
            build(recipe, tmp_path / "out.ttf")

    def test_pinning_a_value_outside_the_axis_range_is_a_clear_error(
        self, tmp_path, base_font, variable_font
    ):
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base: {base_font.name}\n"
            f"donors:\n  - path: {variable_font.name}\n    instance:\n      wght: 950\n",
            encoding="utf-8",
        )

        with pytest.raises(BuildError, match="wght"):
            build(recipe, tmp_path / "out.ttf")

    def test_variable_builds_are_byte_deterministic(
        self, tmp_path, variable_font
    ):
        donor = synth_font(
            tmp_path / "donor.ttf", family="SynthDonor", codepoints=(0x56FD,)
        )
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base:\n  path: {variable_font.name}\n  instance:\n    wght: 700\n"
            f"donors:\n  - {donor.name}\n",
            encoding="utf-8",
        )
        output = tmp_path / "out.ttf"
        report_path = tmp_path / "out.report.json"

        build(recipe, output, report_path=report_path)
        font_bytes = output.read_bytes()
        report_bytes = report_path.read_bytes()

        build(recipe, output, report_path=report_path)
        assert output.read_bytes() == font_bytes
        assert report_path.read_bytes() == report_bytes
