"""Seam 1 tests: output formats and byte-reproducible builds (issue #10).

The output side of the v1 format tiers, exercised through the one public
entry point ``fontalloy_core.build``:

- Required tier: TTF/OTF in, TTF out — always, the default.
- Expected tier: TTC out — one merged face per selected face of the base
  font file, packaged with shared-table dedup so the collection is
  measurably smaller than the sum of equivalent standalone TTF builds.
- Optional tier: woff2 out — written only behind an explicit format
  choice (recipe ``output.format`` or the ``output_format`` argument).

Reproducibility: two builds from identical pinned inputs produce
byte-identical fonts (and, at the same output path, byte-identical
reports). The save boundary pins ``head.created``/``head.modified`` and
disables timestamp recalculation, so no wall clock ever reaches the
output; ordering is deterministic by construction.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fontTools.ttLib import TTCollection, TTFont

from conftest import (
    BASE_CODEPOINTS,
    DONOR_CODEPOINTS,
    synth_cff_font,
    synth_composite_font,
    synth_ttc,
)
from fontalloy_core import BuildError, RecipeError, build

#: The sfnt flavors a build can write, by leading magic bytes.
TTF_MAGIC = b"\x00\x01\x00\x00"
TTC_MAGIC = b"ttcf"
WOFF2_MAGIC = b"wOF2"

MERGED_COVERAGE = {*BASE_CODEPOINTS, *DONOR_CODEPOINTS}


def _load_report(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.fixture
def two_face_base(tmp_path: Path) -> Path:
    """A two-face base collection: same family and glyph bytes, two styles.

    The faces cover the same codepoints with identical outlines (they
    differ only in subfamily and weight), so their merged builds share
    every table that does not carry style identity — the shape the
    shared-table dedup is for.
    """
    return synth_ttc(
        tmp_path / "family.ttc",
        faces=[
            dict(family="SynthFamily", codepoints=BASE_CODEPOINTS, weight=400),
            dict(
                family="SynthFamily",
                codepoints=BASE_CODEPOINTS,
                weight=700,
                subfamily="Bold",
            ),
        ],
    )


def _recipe(tmp_path: Path, body: str) -> Path:
    recipe = tmp_path / "recipe.yaml"
    recipe.write_text(body, encoding="utf-8")
    return recipe


class TestOutputFormatRecipe:
    """The recipe gains an ``output`` section with a ``format`` field."""

    def test_format_defaults_to_ttf(self, recipe_file, tmp_path):
        result = build(recipe_file, tmp_path / "out.ttf")

        assert result.font_path.read_bytes()[:4] == TTF_MAGIC
        assert _load_report(result.report_path)["output"]["format"] == "ttf"

    @pytest.mark.parametrize("fmt", ["ttf", "ttc", "woff2"])
    def test_every_format_value_parses_and_builds(self, fmt, tmp_path, base_font, donor_font):
        recipe = _recipe(
            tmp_path,
            f"base: {base_font.name}\ndonors:\n  - {donor_font.name}\n"
            f"output:\n  format: {fmt}\n",
        )

        result = build(recipe, tmp_path / f"out.{fmt}")

        assert _load_report(result.report_path)["output"]["format"] == fmt
        # Every format reloads through fontTools with the merged coverage.
        if fmt == "ttc":
            faces = TTCollection(result.font_path).fonts
        else:
            faces = [TTFont(result.font_path)]
        assert len(faces) == 1  # a plain base contributes one face
        for face in faces:
            assert set(face.getBestCmap()) == MERGED_COVERAGE

    def test_unknown_output_key_is_rejected(self, tmp_path, base_font, donor_font):
        recipe = _recipe(
            tmp_path,
            f"base: {base_font.name}\ndonors:\n  - {donor_font.name}\n"
            "output:\n  format: ttf\n  bogus: true\n",
        )

        with pytest.raises(RecipeError, match="bogus"):
            build(recipe, tmp_path / "out.ttf")

    def test_invalid_format_value_is_rejected(self, tmp_path, base_font, donor_font):
        recipe = _recipe(
            tmp_path,
            f"base: {base_font.name}\ndonors:\n  - {donor_font.name}\n"
            "output:\n  format: cff\n",
        )

        with pytest.raises(RecipeError, match="woff2"):
            build(recipe, tmp_path / "out.ttf")

    def test_output_must_be_a_mapping(self, tmp_path, base_font, donor_font):
        recipe = _recipe(
            tmp_path,
            f"base: {base_font.name}\ndonors:\n  - {donor_font.name}\n"
            "output: ttc\n",
        )

        with pytest.raises(RecipeError, match="output"):
            build(recipe, tmp_path / "out.ttf")

    def test_unknown_format_argument_is_a_clear_error(self, recipe_file, tmp_path):
        with pytest.raises(BuildError, match="woff2"):
            build(recipe_file, tmp_path / "out.bin", output_format="cff")


class TestTTCOutput:
    """The expected tier: TTC out with shared-table dedup."""

    def test_every_base_face_is_merged_and_packaged(
        self, tmp_path, two_face_base, donor_font
    ):
        recipe = _recipe(
            tmp_path,
            f"base: {two_face_base.name}\ndonors:\n  - {donor_font.name}\n"
            "output:\n  format: ttc\n",
        )

        result = build(recipe, tmp_path / "out.ttc")

        assert result.font_path.read_bytes()[:4] == TTC_MAGIC
        faces = TTCollection(result.font_path).fonts
        assert len(faces) == 2
        for face in faces:
            # Each face is the same merge over its own container: the
            # base coverage plus the grafted donor coverage.
            assert set(face.getBestCmap()) == MERGED_COVERAGE
            assert face["head"].unitsPerEm == 1000

    def test_report_records_the_faces_and_their_summaries(
        self, tmp_path, two_face_base, donor_font
    ):
        recipe = _recipe(
            tmp_path,
            f"base: {two_face_base.name}\ndonors:\n  - {donor_font.name}\n"
            "output:\n  format: ttc\n",
        )

        result = build(recipe, tmp_path / "out.ttc")

        report = _load_report(result.report_path)
        assert report["output"]["format"] == "ttc"
        faces = report["output"]["faces"]
        assert [(face["index"], face["subfamily"], face["weight"]) for face in faces] == [
            (0, "Regular", 400),
            (1, "Bold", 700),
        ]
        for face in faces:
            assert face["summary"] == {
                "codepoints_total": len(MERGED_COVERAGE),
                "from_base": len(BASE_CODEPOINTS),
                "from_donors": len(DONOR_CODEPOINTS),
                "output_codepoints": len(MERGED_COVERAGE),
            }
        # The flat provenance describes face 0 (documented report shape).
        assert report["summary"]["codepoints_total"] == len(MERGED_COVERAGE)

    def test_shared_tables_dedupe_below_the_standalone_sum(
        self, tmp_path, two_face_base, donor_font
    ):
        """The dedup must measurably pay: TTC < the sum of its TTF builds."""
        donor_line = f"donors:\n  - {donor_font.name}\n"
        standalone = 0
        for face in (0, 1):
            recipe = _recipe(
                tmp_path,
                f"base:\n  path: {two_face_base.name}\n  face: {face}\n{donor_line}",
            )
            built = build(recipe, tmp_path / f"standalone-{face}.ttf")
            standalone += built.font_path.stat().st_size

        recipe = _recipe(
            tmp_path,
            f"base: {two_face_base.name}\n{donor_line}output:\n  format: ttc\n",
        )
        collection = build(recipe, tmp_path / "out.ttc")

        assert collection.font_path.stat().st_size < standalone

    def test_pinned_base_face_packages_that_single_face(
        self, tmp_path, two_face_base, donor_font
    ):
        recipe = _recipe(
            tmp_path,
            f"base:\n  path: {two_face_base.name}\n  face: 1\n"
            f"donors:\n  - {donor_font.name}\noutput:\n  format: ttc\n",
        )

        result = build(recipe, tmp_path / "out.ttc")

        faces = TTCollection(result.font_path).fonts
        assert len(faces) == 1
        assert set(faces[0].getBestCmap()) == MERGED_COVERAGE
        # The packaged face is the pinned one: Bold, weight 700.
        face = _load_report(result.report_path)["output"]["faces"][0]
        assert (face["subfamily"], face["weight"]) == ("Bold", 700)

    def test_collection_base_without_a_face_pin_is_still_an_error_for_ttf(
        self, tmp_path, two_face_base, donor_font
    ):
        recipe = _recipe(
            tmp_path, f"base: {two_face_base.name}\ndonors:\n  - {donor_font.name}\n"
        )

        with pytest.raises(BuildError, match=r"collection.*2 faces"):
            build(recipe, tmp_path / "out.ttf")

    def test_repeated_builds_are_byte_identical(self, tmp_path, two_face_base, donor_font):
        recipe = _recipe(
            tmp_path,
            f"base: {two_face_base.name}\ndonors:\n  - {donor_font.name}\n"
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

    def test_no_wall_clock_reaches_the_output(self, tmp_path, two_face_base, donor_font):
        """The pinned head timestamps come from the base font, not the clock."""
        recipe = _recipe(
            tmp_path,
            f"base: {two_face_base.name}\ndonors:\n  - {donor_font.name}\n"
            "output:\n  format: ttc\n",
        )

        result = build(recipe, tmp_path / "out.ttc")

        pin = TTFont(two_face_base, fontNumber=0)["head"].created
        for face in TTCollection(result.font_path).fonts:
            assert face["head"].created == pin
            assert face["head"].modified == pin

    def test_a_composite_donor_grafts_into_every_face(
        self, tmp_path, two_face_base
    ):
        """One donor object feeds every base face; composites must survive.

        The mapped glyph 0x4E09 is a nested composite; grafting the same
        donor face into a second base container must not double-prefix
        its component references (the donor's own tables stay pristine).
        """
        donor = synth_composite_font(tmp_path / "donor.ttf", family="SynthComp")
        recipe = _recipe(
            tmp_path,
            f"base: {two_face_base.name}\ndonors:\n  - {donor.name}\n"
            "output:\n  format: ttc\n",
        )

        result = build(recipe, tmp_path / "out.ttc")

        for face in TTCollection(result.font_path).fonts:
            assert set(face.getBestCmap()) == {0x41, 0x42, 0x4E09}
            glyph = face["glyf"][face.getBestCmap()[0x4E09]]
            assert glyph.components[0].glyphName == "d0.uni4E8C"


class TestWoff2Output:
    """The optional tier: woff2 out, only behind an explicit format choice."""

    def test_woff2_is_written_only_behind_the_format(self, recipe_file, tmp_path):
        default = build(recipe_file, tmp_path / "default.ttf")
        assert default.font_path.read_bytes()[:4] == TTF_MAGIC

        opted_in = build(recipe_file, tmp_path / "opted.woff2", output_format="woff2")
        assert opted_in.font_path.read_bytes()[:4] == WOFF2_MAGIC
        font = TTFont(opted_in.font_path)  # flavor auto-detected on reload
        assert font.flavor == "woff2"
        assert set(font.getBestCmap()) == MERGED_COVERAGE

    def test_report_records_the_format(self, recipe_file, tmp_path):
        result = build(recipe_file, tmp_path / "out.woff2", output_format="woff2")

        assert _load_report(result.report_path)["output"]["format"] == "woff2"

    def test_repeated_builds_are_byte_identical_under_the_pinned_brotli(
        self, recipe_file, tmp_path
    ):
        """Same-environment woff2 reproducibility, honestly scoped.

        brotli's output is deterministic for a fixed input and a fixed
        brotli build, but cross-version byte-stability is NOT guaranteed;
        the lockfile pins brotli (a direct dependency since woff2 became
        an output path), which is the scope this test can honestly pin.
        The byte-identical acceptance gate itself covers TTF and TTC.
        """
        output = tmp_path / "out.woff2"

        build(recipe_file, output, output_format="woff2")
        first = output.read_bytes()

        build(recipe_file, output, output_format="woff2")
        assert output.read_bytes() == first


class TestFormatTierCoverage:
    """The v1 format tiers, as one auditable statement per tier."""

    def test_required_ttf_in_ttf_out(self, recipe_file, tmp_path):
        result = build(recipe_file, tmp_path / "out.ttf")

        font = TTFont(result.font_path)
        assert font.sfntVersion == "\x00\x01\x00\x00"  # TrueType outlines out
        assert set(font.getBestCmap()) == MERGED_COVERAGE

    def test_required_otf_in_ttf_out(self, tmp_path, base_font):
        """A CFF donor grafts into the TrueType container — still TTF out."""
        donor = synth_cff_font(tmp_path / "donor.otf", family="SynthCFF")
        recipe = _recipe(
            tmp_path, f"base: {base_font.name}\ndonors:\n  - {donor.name}\n"
        )

        result = build(recipe, tmp_path / "out.ttf")

        font = TTFont(result.font_path)
        assert font.sfntVersion == "\x00\x01\x00\x00"
        assert "glyf" in font and "CFF " not in font
        assert set(font.getBestCmap()) == MERGED_COVERAGE

    def test_expected_ttc_in_face_selected_ttf_out(self, tmp_path, two_face_base, donor_font):
        recipe = _recipe(
            tmp_path,
            f"base:\n  path: {two_face_base.name}\n  face: 0\n"
            f"donors:\n  - {donor_font.name}\n",
        )

        result = build(recipe, tmp_path / "out.ttf")

        font = TTFont(result.font_path)
        assert font.sfntVersion == "\x00\x01\x00\x00"
        assert set(font.getBestCmap()) == MERGED_COVERAGE

    def test_expected_ttc_out(self, tmp_path, base_font, donor_font):
        recipe = _recipe(
            tmp_path,
            f"base: {base_font.name}\ndonors:\n  - {donor_font.name}\n"
            "output:\n  format: ttc\n",
        )

        result = build(recipe, tmp_path / "out.ttc")

        assert result.font_path.read_bytes()[:4] == TTC_MAGIC
        assert len(TTCollection(result.font_path).fonts) == 1
