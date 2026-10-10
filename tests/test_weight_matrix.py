"""Seam 1 tests: the weight and style matrix with borrow reporting (issue #9).

One recipe yields the complete family: the requested weight/style slots
come from the base font file's faces (a recipe ``weights`` section
selects a subset), each donor family matches its nearest-weight face per
slot (explicit per-weight overrides win), and every borrow — which donor
weight landed in which output weight — is stated in the report.

Nothing is ever synthesized or interpolated: an italic slot whose donor
family has no italic borrows the donor's upright face (the terminal
convention), and the grafted outlines stay byte-for-byte the donor's own.

Packaging reconciles with issue #10's format machinery: a multi-slot
matrix lands as one TTC (one merged face per slot); a single-slot build
keeps every format. The matrix subsumes the TTC rule — an unpinned
collection base under ``format: ttc`` selects all faces, exactly as
before, now explained as "the default requested matrix".
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fontTools.ttLib import TTCollection, TTFont

from conftest import BASE_CODEPOINTS, synth_font, synth_ttc
from fontalloy_core import BuildError, RecipeError, build

MERGED_AT_400 = {*BASE_CODEPOINTS, 0x4E2D, 0x56FD}


@pytest.fixture
def matrix_base(tmp_path: Path) -> Path:
    """A three-face base collection: Regular, Bold, Italic.

    Every face covers the same Latin codepoints, so per-slot assertions
    isolate the weight/style identity (the slot's own OS/2 values) from
    coverage.
    """
    return synth_ttc(
        tmp_path / "base-family.ttc",
        faces=[
            dict(family="SynthBase", codepoints=BASE_CODEPOINTS, weight=400),
            dict(
                family="SynthBase",
                codepoints=BASE_CODEPOINTS,
                weight=700,
                subfamily="Bold",
            ),
            dict(
                family="SynthBase",
                codepoints=BASE_CODEPOINTS,
                weight=400,
                subfamily="Italic",
                italic=True,
            ),
        ],
    )


@pytest.fixture
def weighty_donor(tmp_path: Path) -> Path:
    """A three-weight CJK donor family: 300, 400, 600.

    Each weight carries a distinguishing extra codepoint, so which
    donor face landed in an output is observable in the output cmap,
    not just in the report.
    """
    return synth_ttc(
        tmp_path / "cjk-family.ttc",
        faces=[
            dict(family="SynthCJK", weight=300, codepoints=(0x4E2D, 0x3000)),
            dict(family="SynthCJK", weight=400, codepoints=(0x4E2D, 0x56FD)),
            dict(family="SynthCJK", weight=600, codepoints=(0x4E2D, 0x6000)),
        ],
    )


def _recipe(tmp_path: Path, body: str) -> Path:
    recipe = tmp_path / "recipe.yaml"
    recipe.write_text(body, encoding="utf-8")
    return recipe


def _load_report(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _assert_merged_face(
    font: TTFont, expected_coverage: set[int], *, weight: int, italic: bool
) -> None:
    """The seam-1 assertions every output face must pass, matrix or not."""
    assert set(font.getBestCmap()) == expected_coverage
    assert font["head"].unitsPerEm == 1000  # the base is the container
    assert font["OS/2"].usWeightClass == weight
    assert bool(font["OS/2"].fsSelection & 0x01) is italic


def _glyph_coordinates(font: TTFont, codepoint: int) -> tuple:
    """The outline coordinates of the glyph mapped at ``codepoint``."""
    name = font.getBestCmap()[codepoint]
    coords, _, _ = font["glyf"][name].getCoordinates(font.getGlyphSet())
    return coords


def _r(value: float) -> int:
    """fontTools' otRound (half away from zero), for scaled expectations."""
    return int((value + 0.5) if value >= 0 else (value - 0.5))


def _name(font: TTFont, name_id: int) -> str | None:
    """One identity record, preferring the Windows encoding."""
    records = [r for r in font["name"].names if r.nameID == name_id]
    for record in records:
        if (record.platformID, record.platEncID, record.langID) == (3, 1, 0x409):
            return record.toUnicode()
    return records[0].toUnicode() if records else None


class TestWeightsRecipe:
    """The recipe gains a ``weights`` section, parsed strictly."""

    def _weights_recipe(self, tmp_path, body: str) -> Path:
        return _recipe(
            tmp_path,
            "base: base.ttf\ndonors:\n  - donor.ttf\nweights:\n" + body,
        )

    def test_weights_must_be_a_list(self, tmp_path, base_font, donor_font):
        recipe = _recipe(
            tmp_path,
            f"base: {base_font.name}\ndonors:\n  - {donor_font.name}\n"
            "weights: 400\n",
        )

        with pytest.raises(RecipeError, match="weights"):
            build(recipe, tmp_path / "out.ttf")

    def test_weights_must_not_be_empty(self, tmp_path, base_font, donor_font):
        recipe = _recipe(
            tmp_path,
            f"base: {base_font.name}\ndonors:\n  - {donor_font.name}\n"
            "weights: []\n",
        )

        with pytest.raises(RecipeError, match="non-empty"):
            build(recipe, tmp_path / "out.ttf")

    def test_weight_is_required(self, tmp_path, base_font, donor_font):
        recipe = self._weights_recipe(tmp_path, "  - style: italic\n")

        with pytest.raises(RecipeError, match="weight"):
            build(recipe, tmp_path / "out.ttf")

    def test_unknown_entry_field_is_rejected(self, tmp_path, base_font, donor_font):
        recipe = self._weights_recipe(tmp_path, "  - weight: 400\n    bogus: 1\n")

        with pytest.raises(RecipeError, match="bogus"):
            build(recipe, tmp_path / "out.ttf")

    def test_weight_must_be_a_us_weight_class(self, tmp_path, base_font, donor_font):
        recipe = self._weights_recipe(tmp_path, "  - weight: bold\n")

        with pytest.raises(RecipeError, match="1 to 1000"):
            build(recipe, tmp_path / "out.ttf")

    def test_style_must_be_upright_or_italic(self, tmp_path, base_font, donor_font):
        recipe = self._weights_recipe(tmp_path, "  - weight: 400\n    style: oblique\n")

        with pytest.raises(RecipeError, match="oblique"):
            build(recipe, tmp_path / "out.ttf")

    def test_override_must_reference_a_real_donor(self, tmp_path, base_font, donor_font):
        recipe = self._weights_recipe(
            tmp_path, "  - weight: 400\n    donors:\n        donor-9: 300\n"
        )

        with pytest.raises(RecipeError, match="donor-9"):
            build(recipe, tmp_path / "out.ttf")

    def test_override_weight_must_be_a_us_weight_class(
        self, tmp_path, base_font, donor_font
    ):
        recipe = self._weights_recipe(
            tmp_path, "  - weight: 400\n    donors:\n        donor-0: heavy\n"
        )

        with pytest.raises(RecipeError, match="1 to 1000"):
            build(recipe, tmp_path / "out.ttf")

    def test_duplicate_slot_is_rejected(self, tmp_path, base_font, donor_font):
        recipe = self._weights_recipe(
            tmp_path, "  - weight: 400\n  - weight: 400\n"
        )

        with pytest.raises(RecipeError, match="more than once"):
            build(recipe, tmp_path / "out.ttf")

    def test_style_is_what_distinguishes_duplicate_weights(
        self, tmp_path, base_font, donor_font
    ):
        recipe = self._weights_recipe(
            tmp_path, "  - weight: 400\n  - weight: 400\n    style: italic\n"
        )

        # Parses (the slots differ by style); the build fails later on
        # the base font not carrying an italic face — not on the recipe.
        with pytest.raises(BuildError, match="italic"):
            build(recipe, tmp_path / "out.ttf")


class TestRequestedMatrix:
    """The requested set comes from the base's faces; recipes may select."""

    def test_the_default_matrix_is_every_base_face(self, tmp_path, matrix_base, weighty_donor):
        recipe = _recipe(
            tmp_path,
            f"base: {matrix_base.name}\ndonors:\n  - {weighty_donor.name}\n"
            "output:\n  format: ttc\n",
        )

        result = build(recipe, tmp_path / "out.ttc")

        faces = TTCollection(result.font_path).fonts
        assert len(faces) == 3
        # Slot order is the base file's face order, whatever the recipe
        # would have listed: Regular, Bold, Italic.
        _assert_merged_face(faces[0], MERGED_AT_400, weight=400, italic=False)
        _assert_merged_face(faces[1], {*BASE_CODEPOINTS, 0x4E2D, 0x6000}, weight=700, italic=False)
        _assert_merged_face(faces[2], MERGED_AT_400, weight=400, italic=True)

    def test_a_selection_subsets_the_matrix_in_base_face_order(
        self, tmp_path, matrix_base, weighty_donor
    ):
        recipe = _recipe(
            tmp_path,
            f"base: {matrix_base.name}\ndonors:\n  - {weighty_donor.name}\n"
            "output:\n  format: ttc\n"
            "weights:\n  - weight: 400\n    style: italic\n  - weight: 700\n",
        )

        result = build(recipe, tmp_path / "out.ttc")

        faces = TTCollection(result.font_path).fonts
        # The recipe listed italic first; the output keeps base face order.
        assert [face["OS/2"].usWeightClass for face in faces] == [700, 400]
        assert not faces[0]["OS/2"].fsSelection & 0x01
        assert faces[1]["OS/2"].fsSelection & 0x01

    def test_a_single_selected_slot_builds_as_a_plain_ttf(
        self, tmp_path, matrix_base, weighty_donor
    ):
        recipe = _recipe(
            tmp_path,
            f"base: {matrix_base.name}\ndonors:\n  - {weighty_donor.name}\n"
            "weights:\n  - weight: 700\n",
        )

        result = build(recipe, tmp_path / "out.ttf")

        _assert_merged_face(
            TTFont(result.font_path), {*BASE_CODEPOINTS, 0x4E2D, 0x6000},
            weight=700, italic=False,
        )

    def test_a_multi_slot_selection_with_ttf_output_is_a_clear_error(
        self, tmp_path, matrix_base, weighty_donor
    ):
        recipe = _recipe(
            tmp_path,
            f"base: {matrix_base.name}\ndonors:\n  - {weighty_donor.name}\n"
            "weights:\n  - weight: 400\n  - weight: 700\n",
        )

        with pytest.raises(BuildError, match="ttc"):
            build(recipe, tmp_path / "out.ttf")

    def test_a_selection_the_base_cannot_satisfy_is_a_clear_error(
        self, tmp_path, matrix_base, weighty_donor
    ):
        recipe = _recipe(
            tmp_path,
            f"base: {matrix_base.name}\ndonors:\n  - {weighty_donor.name}\n"
            "weights:\n  - weight: 500\n",
        )

        with pytest.raises(BuildError, match="500"):
            build(recipe, tmp_path / "out.ttf")

    def test_an_italic_request_without_a_base_italic_face_is_a_clear_error(
        self, tmp_path, weighty_donor
    ):
        # A base without italic never gets a synthesized italic slot:
        # the upright output serves the style by the terminal convention.
        base = synth_font(
            tmp_path / "upright-base.ttf",
            family="SynthBase",
            codepoints=BASE_CODEPOINTS,
        )
        recipe = _recipe(
            tmp_path,
            f"base: {base.name}\ndonors:\n  - {weighty_donor.name}\n"
            "weights:\n  - weight: 400\n    style: italic\n",
        )

        with pytest.raises(BuildError, match="italic"):
            build(recipe, tmp_path / "out.ttf")

    def test_a_pinned_base_face_limits_the_available_slots(
        self, tmp_path, matrix_base, weighty_donor
    ):
        recipe = _recipe(
            tmp_path,
            f"base:\n  path: {matrix_base.name}\n  face: 1\n"
            f"donors:\n  - {weighty_donor.name}\n"
            "weights:\n  - weight: 400\n",
        )

        with pytest.raises(BuildError, match="700"):
            build(recipe, tmp_path / "out.ttf")

    def test_an_unpinned_collection_base_still_requires_selection_for_ttf(
        self, tmp_path, matrix_base, weighty_donor
    ):
        recipe = _recipe(
            tmp_path,
            f"base: {matrix_base.name}\ndonors:\n  - {weighty_donor.name}\n",
        )

        with pytest.raises(BuildError, match=r"collection.*3 faces"):
            build(recipe, tmp_path / "out.ttf")


class TestNearestMatch:
    """Donors match their nearest OS/2 usWeightClass per output weight."""

    def test_exact_and_nearest_borrows_land_per_slot(
        self, tmp_path, matrix_base, weighty_donor
    ):
        recipe = _recipe(
            tmp_path,
            f"base: {matrix_base.name}\ndonors:\n  - {weighty_donor.name}\n"
            "output:\n  format: ttc\n",
        )

        result = build(recipe, tmp_path / "out.ttc")

        borrows = {
            (slot["weight"], slot["style"]): slot["borrows"][0]
            for slot in _load_report(result.report_path)["weights"]
        }
        # Slot 400 borrows the donor's exact 400 face...
        assert borrows[(400, "upright")]["weight"] == 400
        # ...slot 700 borrows the nearest (600, not 300: |100| < |300|).
        assert borrows[(700, "upright")]["weight"] == 600
        assert borrows[(400, "upright")]["via"] == "nearest"
        # The distinguishing codepoints prove the faces actually landed.
        faces = TTCollection(result.font_path).fonts
        assert 0x56FD in faces[0].getBestCmap()  # the 400 face's extra
        assert 0x6000 in faces[1].getBestCmap()  # the 600 face's extra
        assert 0x3000 not in faces[0].getBestCmap()

    def test_a_tie_prefers_the_lighter_face(self, tmp_path, base_font):
        donor = synth_ttc(
            tmp_path / "tie.ttc",
            faces=[
                dict(family="SynthTie", weight=300, codepoints=(0x4E2D, 0x3000)),
                dict(family="SynthTie", weight=500, codepoints=(0x4E2D, 0x56FD)),
            ],
        )
        recipe = _recipe(
            tmp_path, f"base: {base_font.name}\ndonors:\n  - {donor.name}\n"
        )

        result = build(recipe, tmp_path / "out.ttf")

        # 400 is equidistant from 300 and 500: the lighter face wins.
        font = TTFont(result.font_path)
        assert 0x3000 in font.getBestCmap()
        assert 0x56FD not in font.getBestCmap()
        assert _load_report(result.report_path)["weights"][0]["borrows"][0]["weight"] == 300

    def test_a_pinned_donor_face_serves_every_slot(self, tmp_path, matrix_base, weighty_donor):
        recipe = _recipe(
            tmp_path,
            f"base: {matrix_base.name}\n"
            "donors:\n  - path: cjk-family.ttc\n    face: 0\n"
            "output:\n  format: ttc\n",
        )

        result = build(recipe, tmp_path / "out.ttc")

        weights = _load_report(result.report_path)["weights"]
        for slot in weights:
            assert slot["borrows"][0]["via"] == "pinned"
            assert slot["borrows"][0]["weight"] == 300
        for face in TTCollection(result.font_path).fonts:
            assert 0x3000 in face.getBestCmap()  # the pinned 300 face's extra

    def test_a_plain_donor_file_matches_its_single_face(
        self, tmp_path, base_font, donor_font
    ):
        recipe = _recipe(
            tmp_path, f"base: {base_font.name}\ndonors:\n  - {donor_font.name}\n"
        )

        result = build(recipe, tmp_path / "out.ttf")

        borrow = _load_report(result.report_path)["weights"][0]["borrows"][0]
        assert (borrow["donor"], borrow["weight"], borrow["via"]) == (
            "donor-0",
            400,
            "nearest",
        )

    def test_a_donor_file_of_several_families_is_a_clear_error(
        self, tmp_path, base_font
    ):
        mixed = synth_ttc(
            tmp_path / "mixed.ttc",
            faces=[
                dict(family="FamilyA", weight=400, codepoints=(0x4E2D,)),
                dict(family="FamilyB", weight=400, codepoints=(0x4E2D,)),
            ],
        )
        recipe = _recipe(
            tmp_path, f"base: {base_font.name}\ndonors:\n  - {mixed.name}\n"
        )

        with pytest.raises(BuildError, match="FamilyA.*FamilyB"):
            build(recipe, tmp_path / "out.ttf")


class TestWeightOverrides:
    """A recipe may rewrite the weight mapping per weight."""

    def test_an_override_beats_the_nearest_match(self, tmp_path, base_font, weighty_donor):
        recipe = _recipe(
            tmp_path,
            f"base: {base_font.name}\ndonors:\n  - {weighty_donor.name}\n"
            "weights:\n  - weight: 400\n    donors:\n        donor-0: 300\n",
        )

        result = build(recipe, tmp_path / "out.ttf")

        # The donor has an exact 400 face, but the recipe demands 300.
        font = TTFont(result.font_path)
        assert 0x3000 in font.getBestCmap()
        assert 0x56FD not in font.getBestCmap()
        borrow = _load_report(result.report_path)["weights"][0]["borrows"][0]
        assert (borrow["weight"], borrow["via"]) == (300, "override")

    def test_an_override_for_a_weight_the_donor_lacks_is_a_clear_error(
        self, tmp_path, base_font, weighty_donor
    ):
        recipe = _recipe(
            tmp_path,
            f"base: {base_font.name}\ndonors:\n  - {weighty_donor.name}\n"
            "weights:\n  - weight: 400\n    donors:\n        donor-0: 500\n",
        )

        with pytest.raises(BuildError, match="500"):
            build(recipe, tmp_path / "out.ttf")

    def test_overrides_are_per_slot(self, tmp_path, matrix_base, weighty_donor):
        recipe = _recipe(
            tmp_path,
            f"base: {matrix_base.name}\ndonors:\n  - {weighty_donor.name}\n"
            "output:\n  format: ttc\n"
            "weights:\n  - weight: 400\n    donors:\n        donor-0: 300\n"
            "  - weight: 700\n",
        )

        result = build(recipe, tmp_path / "out.ttc")

        borrows = {
            slot["weight"]: slot["borrows"][0]
            for slot in _load_report(result.report_path)["weights"]
        }
        assert (borrows[400]["weight"], borrows[400]["via"]) == (300, "override")
        assert (borrows[700]["weight"], borrows[700]["via"]) == (600, "nearest")


class TestItalicFallback:
    """No italic in the donor: upright lands, stated, never synthesized."""

    @pytest.fixture
    def upright_donor(self, tmp_path: Path) -> Path:
        return synth_font(
            tmp_path / "upright-cjk.ttf",
            family="SynthCJK",
            codepoints=(0x4E2D, 0x56FD),
            weight=400,
        )

    def test_an_italic_slot_borrows_the_donor_upright_face(
        self, tmp_path, upright_donor
    ):
        base = synth_ttc(
            tmp_path / "base.ttc",
            faces=[
                dict(family="SynthBase", codepoints=BASE_CODEPOINTS, weight=400),
                dict(
                    family="SynthBase",
                    codepoints=BASE_CODEPOINTS,
                    weight=400,
                    subfamily="Italic",
                    italic=True,
                ),
            ],
        )
        recipe = _recipe(
            tmp_path,
            f"base: {base.name}\ndonors:\n  - {upright_donor.name}\n"
            "output:\n  format: ttc\n",
        )

        result = build(recipe, tmp_path / "out.ttc")

        weights = _load_report(result.report_path)["weights"]
        upright, italic = weights[0], weights[1]
        assert upright["style"] == "upright"
        assert upright["borrows"][0]["style_fallback"] is False
        assert italic["style"] == "italic"
        # The borrow states the fallback: upright CJK in an italic slot.
        assert italic["borrows"][0]["style"] == "upright"
        assert italic["borrows"][0]["style_fallback"] is True

    def test_nothing_is_synthesized_for_the_italic_style(
        self, tmp_path, upright_donor
    ):
        """The italic slot's donor outlines are the upright donor's own.

        The transform-only rule (ADR-0003) forbids any style synthesis:
        the grafted glyph must be the donor file's upright glyph under
        the normalization's uniform scale — one factor for x and y
        about the baseline, so no slant, no interpolation, no
        instancing — and identical to the upright slot's copy.
        """
        base = synth_ttc(
            tmp_path / "base.ttc",
            faces=[
                dict(family="SynthBase", codepoints=BASE_CODEPOINTS, weight=400),
                dict(
                    family="SynthBase",
                    codepoints=BASE_CODEPOINTS,
                    weight=400,
                    subfamily="Italic",
                    italic=True,
                ),
            ],
        )
        recipe = _recipe(
            tmp_path,
            f"base: {base.name}\ndonors:\n  - {upright_donor.name}\n"
            "output:\n  format: ttc\n",
        )

        result = build(recipe, tmp_path / "out.ttc")

        faces = TTCollection(result.font_path).fonts
        donor_own = _glyph_coordinates(TTFont(upright_donor), 0x4E2D)
        # This fixture pair's normalization scale: the base's latin cell
        # is 600 at 1000 upem, so the grid school k = 2*600/1000 = 1.2
        # (ADR-0003). A uniform factor about the baseline — nothing else
        # may move (a slant would mix y into x; instancing would bend
        # the factor).
        normalized = tuple((_r(x * 1.2), _r(y * 1.2)) for x, y in donor_own)
        assert tuple(_glyph_coordinates(faces[0], 0x4E2D)) == normalized
        assert tuple(_glyph_coordinates(faces[1], 0x4E2D)) == normalized
        # The italic identity is the base's own (the container), not a
        # synthesized one: the slot keeps its italic selection bit.
        assert bool(faces[1]["OS/2"].fsSelection & 0x01) is True
        assert bool(faces[0]["OS/2"].fsSelection & 0x01) is False


class TestBorrowReporting:
    """Every borrow is stated in the report, matrix or single build."""

    def test_the_weights_section_states_the_full_matrix(self, tmp_path, matrix_base, weighty_donor):
        recipe = _recipe(
            tmp_path,
            f"base: {matrix_base.name}\ndonors:\n  - {weighty_donor.name}\n"
            "output:\n  format: ttc\n",
        )

        result = build(recipe, tmp_path / "out.ttc")

        weights = _load_report(result.report_path)["weights"]
        assert weights == [
            {
                "index": 0,
                "weight": 400,
                "style": "upright",
                "base_face": 0,
                "borrows": [
                    {
                        "donor": "donor-0",
                        "face": 1,
                        "weight": 400,
                        "style": "upright",
                        "via": "nearest",
                        "style_fallback": False,
                    }
                ],
            },
            {
                "index": 1,
                "weight": 700,
                "style": "upright",
                "base_face": 1,
                "borrows": [
                    {
                        "donor": "donor-0",
                        "face": 2,
                        "weight": 600,
                        "style": "upright",
                        "via": "nearest",
                        "style_fallback": False,
                    }
                ],
            },
            {
                "index": 2,
                "weight": 400,
                "style": "italic",
                "base_face": 2,
                "borrows": [
                    {
                        "donor": "donor-0",
                        "face": 1,
                        "weight": 400,
                        "style": "upright",
                        "via": "nearest",
                        "style_fallback": True,
                    }
                ],
            },
        ]

    def test_a_build_with_no_donors_states_an_empty_borrow_table(
        self, tmp_path, base_font
    ):
        recipe = _recipe(tmp_path, f"base: {base_font.name}\ndonors: []\n")

        result = build(recipe, tmp_path / "out.ttf")

        weights = _load_report(result.report_path)["weights"]
        assert weights == [
            {
                "index": 0,
                "weight": 400,
                "style": "upright",
                "base_face": 0,
                "borrows": [],
            }
        ]


class TestMatrixPackaging:
    """The matrix lands through the format machinery; nothing regresses."""

    def test_matrix_builds_are_byte_reproducible(
        self, tmp_path, matrix_base, weighty_donor
    ):
        recipe = _recipe(
            tmp_path,
            f"base: {matrix_base.name}\ndonors:\n  - {weighty_donor.name}\n"
            "output:\n  format: ttc\n",
        )
        output = tmp_path / "out.ttc"
        report_path = tmp_path / "out.report.json"

        build(recipe, output, report_path=report_path)
        font_bytes = output.read_bytes()
        report_bytes = report_path.read_bytes()

        build(recipe, output, report_path=report_path)
        assert output.read_bytes() == font_bytes
        assert report_path.read_bytes() == report_bytes

    def test_every_face_passes_the_single_build_assertions(
        self, tmp_path, matrix_base, weighty_donor
    ):
        """Each slot's output reloads as a valid font with its own identity."""
        recipe = _recipe(
            tmp_path,
            f"base: {matrix_base.name}\ndonors:\n  - {weighty_donor.name}\n"
            "output:\n  format: ttc\n",
        )

        result = build(recipe, tmp_path / "out.ttc")

        # TTCollection reload is the validity gate; per-face assertions
        # mirror what a single build of that face would satisfy.
        faces = TTCollection(result.font_path).fonts
        _assert_merged_face(faces[0], MERGED_AT_400, weight=400, italic=False)
        _assert_merged_face(
            faces[1], {*BASE_CODEPOINTS, 0x4E2D, 0x6000}, weight=700, italic=False
        )
        _assert_merged_face(faces[2], MERGED_AT_400, weight=400, italic=True)

    def test_a_single_face_base_builds_exactly_as_before(
        self, tmp_path, base_font, weighty_donor
    ):
        """No weights section, plain base: the matrix is invisible."""
        recipe = _recipe(
            tmp_path, f"base: {base_font.name}\ndonors:\n  - {weighty_donor.name}\n"
        )

        result = build(recipe, tmp_path / "out.ttf")

        _assert_merged_face(
            TTFont(result.font_path), MERGED_AT_400, weight=400, italic=False
        )

    def test_each_slot_names_as_an_output_family_variant(
        self, tmp_path, weighty_donor
    ):
        """Per-weight output naming composes the matrix with stage 6.

        The identity rewrite reads each slot container's own subfamily,
        so the matrix's slots become the output family's weight/style
        variants: RIBBI slots keep family + subfamily split, and a
        non-RIBBI weight (Medium) splits into the legacy
        "ChHsich Medium" pair plus the typographic 16/17 pair.
        """
        base = synth_ttc(
            tmp_path / "base.ttc",
            faces=[
                dict(family="SynthBase", codepoints=BASE_CODEPOINTS, weight=400),
                dict(
                    family="SynthBase",
                    codepoints=BASE_CODEPOINTS,
                    weight=500,
                    subfamily="Medium",
                ),
            ],
        )
        recipe = _recipe(
            tmp_path,
            f"base: {base.name}\ndonors:\n  - {weighty_donor.name}\n"
            "output:\n  format: ttc\n",
        )

        result = build(recipe, tmp_path / "out.ttc")

        faces = TTCollection(result.font_path).fonts
        regular, medium = faces[0], faces[1]
        # RIBBI slot: family/subfamily split, no typographic pair.
        assert _name(regular, 1) == "ChHsich"
        assert _name(regular, 2) == "Regular"
        assert _name(regular, 4) == "ChHsich Regular"
        assert _name(regular, 16) is None
        # Non-RIBBI slot: the weight joins the legacy family, the
        # typographic pair keeps the split.
        assert _name(medium, 1) == "ChHsich Medium"
        assert _name(medium, 2) == "Regular"
        assert _name(medium, 4) == "ChHsich Medium"
        assert _name(medium, 6) == "ChHsich-Medium"
        assert (_name(medium, 16), _name(medium, 17)) == ("ChHsich", "Medium")

    def test_selected_slot_ttc_report_keeps_the_face_records(
        self, tmp_path, matrix_base, weighty_donor
    ):
        recipe = _recipe(
            tmp_path,
            f"base: {matrix_base.name}\ndonors:\n  - {weighty_donor.name}\n"
            "output:\n  format: ttc\n"
            "weights:\n  - weight: 700\n",
        )

        result = build(recipe, tmp_path / "out.ttc")

        report = _load_report(result.report_path)
        # The face record keeps its documented meaning: the base file's
        # face index the output face was merged in.
        assert [
            (face["index"], face["subfamily"], face["weight"])
            for face in report["output"]["faces"]
        ] == [(1, "Bold", 700)]
        assert report["weights"][0]["base_face"] == 1
