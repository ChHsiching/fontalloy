"""Seam 1 tests: the core build API.

Recipe + font files in, built font + verification report out. Per the
testing decisions in issue #1, the whole pipeline is exercised through the
single public entry point ``fontalloy_core.build``; nothing here touches
private functions or internal structure. Fixture fonts are synthetic fonts
generated with fontTools — never catalog binaries.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
from fontTools.ttLib import TTFont

from conftest import BASE_CODEPOINTS, DONOR_CODEPOINTS
from fontalloy_core import BuildError, RecipeError, build


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


class TestFontReferences:
    """A font reference is a path string or a mapping with face/instance.

    Plain strings keep working (backward compatible); mappings select a
    TTC face and pin variable-font instance values.
    """

    def test_base_as_a_mapping_with_a_path_builds(self, tmp_path, base_font, donor_font):
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base:\n  path: {base_font.name}\ndonors:\n  - {donor_font.name}\n",
            encoding="utf-8",
        )

        result = build(recipe, tmp_path / "out.ttf")

        # Grafted output: the mapping-form font reference builds the
        # same merged union as the plain-string form.
        assert set(TTFont(result.font_path).getBestCmap()) == {
            *BASE_CODEPOINTS,
            *DONOR_CODEPOINTS,
        }

    def test_donor_as_a_mapping_with_a_path_builds(
        self, tmp_path, base_font, donor_font
    ):
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base: {base_font.name}\ndonors:\n  - path: {donor_font.name}\n",
            encoding="utf-8",
        )

        result = build(recipe, tmp_path / "out.ttf")

        report = _load_report(result.report_path)
        assert report["summary"]["from_donors"] == len(DONOR_CODEPOINTS)

    def test_mapping_without_a_path_is_a_clear_error(self, tmp_path, base_font):
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base:\n  face: 0\ndonors:\n  - {base_font.name}\n", encoding="utf-8"
        )

        with pytest.raises(RecipeError, match="path"):
            build(recipe, tmp_path / "out.ttf")

    def test_unknown_reference_key_is_rejected(self, tmp_path, base_font, donor_font):
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base: {base_font.name}\ndonors:\n  - path: {donor_font.name}\n"
            "    bogus: true\n",
            encoding="utf-8",
        )

        with pytest.raises(RecipeError, match="bogus"):
            build(recipe, tmp_path / "out.ttf")

    def test_non_integer_face_is_a_clear_error(self, tmp_path, base_font, donor_font):
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base: {base_font.name}\ndonors:\n  - path: {donor_font.name}\n"
            "    face: zero\n",
            encoding="utf-8",
        )

        with pytest.raises(RecipeError, match="face"):
            build(recipe, tmp_path / "out.ttf")

    def test_negative_face_is_a_clear_error(self, tmp_path, base_font, donor_font):
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base: {base_font.name}\ndonors:\n  - path: {donor_font.name}\n"
            "    face: -1\n",
            encoding="utf-8",
        )

        with pytest.raises(RecipeError, match="face"):
            build(recipe, tmp_path / "out.ttf")

    def test_non_mapping_instance_is_a_clear_error(self, tmp_path, base_font, donor_font):
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base: {base_font.name}\ndonors:\n  - path: {donor_font.name}\n"
            "    instance: bold\n",
            encoding="utf-8",
        )

        with pytest.raises(RecipeError, match="instance"):
            build(recipe, tmp_path / "out.ttf")

    def test_non_numeric_instance_value_is_a_clear_error(
        self, tmp_path, base_font, donor_font
    ):
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base: {base_font.name}\ndonors:\n  - path: {donor_font.name}\n"
            "    instance:\n      wght: bold\n",
            encoding="utf-8",
        )

        with pytest.raises(RecipeError, match="wght"):
            build(recipe, tmp_path / "out.ttf")

    def test_non_string_instance_axis_is_a_clear_error(
        self, tmp_path, base_font, donor_font
    ):
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base: {base_font.name}\ndonors:\n  - path: {donor_font.name}\n"
            "    instance:\n      7: 700\n",
            encoding="utf-8",
        )

        with pytest.raises(RecipeError, match="instance"):
            build(recipe, tmp_path / "out.ttf")


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _load_report(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


class TestSourcePinning:
    """A path-form font reference may pin its source file's sha256.

    The catalog form pins through the manifest (issue #23); the path
    form pins the file directly: the build verifies the pin when it
    loads the file, and a mismatch fails naming the reference and both
    hashes. A reference without a pin builds as before — the report
    still records the file's hash.
    """

    def test_matching_pins_build_and_report_the_pinned_hashes(
        self, tmp_path, base_font, donor_font
    ):
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base:\n  path: {base_font.name}\n"
            f"  sha256: {_sha256(base_font)}\n"
            f"donors:\n  - path: {donor_font.name}\n"
            f"    sha256: {_sha256(donor_font)}\n",
            encoding="utf-8",
        )

        result = build(recipe, tmp_path / "out.ttf")

        report = _load_report(result.report_path)
        assert report["summary"]["from_donors"] == len(DONOR_CODEPOINTS)
        by_id = {source["id"]: source for source in report["sources"]}
        assert by_id["base"]["sha256"] == _sha256(base_font)
        assert by_id["donor-0"]["sha256"] == _sha256(donor_font)

    def test_a_mismatched_base_pin_is_rejected_naming_both_hashes(
        self, tmp_path, base_font, donor_font
    ):
        # "a" * 64, not "0" * 64: a run of zeros is YAML-parsed as the
        # integer 0 and would hit the malformed-pin branch instead.
        wrong = "a" * 64
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base:\n  path: {base_font.name}\n  sha256: {wrong}\n"
            f"donors:\n  - {donor_font.name}\n",
            encoding="utf-8",
        )

        with pytest.raises(BuildError) as exc_info:
            build(recipe, tmp_path / "out.ttf")

        message = str(exc_info.value)
        assert "base" in message
        assert wrong in message
        assert _sha256(base_font) in message

    def test_a_mismatched_donor_pin_names_the_donor(
        self, tmp_path, base_font, donor_font
    ):
        wrong = "f" * 64
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base: {base_font.name}\n"
            f"donors:\n  - path: {donor_font.name}\n    sha256: {wrong}\n",
            encoding="utf-8",
        )

        with pytest.raises(BuildError, match=r"donor-0.*sha256 mismatch"):
            build(recipe, tmp_path / "out.ttf")

    def test_a_missing_pinned_file_is_a_clear_error(self, tmp_path, base_font):
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base:\n  path: vanished.ttf\n  sha256: {_sha256(base_font)}\n"
            "donors: []\n",
            encoding="utf-8",
        )

        with pytest.raises(BuildError, match=r"base file not found.*vanished"):
            build(recipe, tmp_path / "out.ttf")

    def test_a_malformed_pin_is_rejected_at_parse(
        self, tmp_path, base_font, donor_font
    ):
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base:\n  path: {base_font.name}\n  sha256: deadbeef\n"
            f"donors:\n  - {donor_font.name}\n",
            encoding="utf-8",
        )

        with pytest.raises(RecipeError, match="sha256"):
            build(recipe, tmp_path / "out.ttf")

    def test_a_pin_on_a_catalog_family_reference_is_rejected(
        self, tmp_path, base_font
    ):
        # sha256 is the path form's pin; a family reference pins through
        # the manifest, so the two must not mix.
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            "base:\n  family: MapleMono\n"
            f"  sha256: {'a' * 64}\n"
            "donors: []\n",
            encoding="utf-8",
        )

        with pytest.raises(RecipeError, match=r"sha256.*path"):
            build(recipe, tmp_path / "out.ttf")


class TestBuild:
    """The tracer bullet: recipe + fonts in, valid TTF + report v0 out."""

    def test_output_is_a_valid_ttf_with_grafted_glyphs(self, recipe_file, tmp_path):
        output = tmp_path / "out.ttf"

        result = build(recipe_file, output)

        font = TTFont(result.font_path)  # reloads cleanly in fontTools
        assert font["head"].unitsPerEm == 1000  # the base is the container
        # Grafting has landed: the output covers the union of the
        # effective table, donor glyphs included.
        assert set(font.getBestCmap()) == {*BASE_CODEPOINTS, *DONOR_CODEPOINTS}

    def test_every_build_emits_a_report_with_provenance(self, recipe_file, tmp_path):
        output = tmp_path / "out.ttf"

        result = build(recipe_file, output)

        assert result.report_path == tmp_path / "out.report.json"
        report = _load_report(result.report_path)
        entries = {entry["codepoint"]: entry for entry in report["provenance"]}
        assert entries[0x41]["winner"] == "base"
        assert entries[0x41]["in_output"] is True
        # The donor's disjoint coverage is attributed to the donor, and
        # since grafting landed the glyph is genuinely in the output.
        assert entries[0x4E2D]["winner"] == "donor-0"
        assert entries[0x4E2D]["in_output"] is True
        assert report["summary"] == {
            "codepoints_total": 4,
            "from_base": 2,
            "from_donors": 2,
            "output_codepoints": 4,
        }

    def test_report_records_source_font_hashes(self, recipe_file, tmp_path,
                                               base_font, donor_font):
        result = build(recipe_file, tmp_path / "out.ttf")

        report = _load_report(result.report_path)
        sources = {record["id"]: record for record in report["sources"]}
        assert sources["base"]["sha256"] == _sha256(base_font)
        assert sources["donor-0"]["sha256"] == _sha256(donor_font)

    def test_repeated_builds_are_byte_identical(self, recipe_file, tmp_path):
        output = tmp_path / "out.ttf"
        report_path = tmp_path / "out.report.json"

        build(recipe_file, output, report_path=report_path)
        font_bytes = output.read_bytes()
        report_bytes = report_path.read_bytes()

        build(recipe_file, output, report_path=report_path)
        assert output.read_bytes() == font_bytes
        assert report_path.read_bytes() == report_bytes

    def test_rebuild_in_a_separate_process_is_byte_identical(
        self, recipe_file, tmp_path
    ):
        """The merged-pipeline output survives process and hash-seed changes.

        The second build runs as a real subprocess with a different
        ``PYTHONHASHSEED`` after the clock has ticked past the one-second
        timestamp granularity — so a restamped ``head.modified`` or any
        hash-order leakage in our own code would show up as a diff.
        """
        import os
        import subprocess
        import sys
        import time

        first = tmp_path / "first.ttf"
        build(recipe_file, first)
        font_bytes = first.read_bytes()

        time.sleep(1.1)  # cross the timestamp granularity; pinning must hold
        second = tmp_path / "second.ttf"
        env = dict(os.environ, PYTHONHASHSEED="1")
        subprocess.run(
            [
                sys.executable,
                "-c",
                "import sys; from fontalloy_core import build;"
                " build(sys.argv[1], sys.argv[2])",
                str(recipe_file),
                str(second),
            ],
            env=env,
            check=True,
            timeout=120,
        )

        assert second.read_bytes() == font_bytes

    def test_recipe_paths_resolve_against_the_recipe_file(
        self, tmp_path, synth_font_factory, monkeypatch
    ):
        shared = tmp_path / "shared"
        shared.mkdir()
        synth_font_factory(
            shared / "base.ttf", family="SynthBase", codepoints=BASE_CODEPOINTS
        )
        synth_font_factory(
            shared / "donor.ttf", family="SynthDonor", codepoints=DONOR_CODEPOINTS
        )
        (shared / "recipe.yaml").write_text(
            "base: base.ttf\ndonors:\n  - donor.ttf\n", encoding="utf-8"
        )
        monkeypatch.chdir(tmp_path)  # run from elsewhere: cwd must not matter

        result = build(shared / "recipe.yaml", tmp_path / "out.ttf")

        assert set(TTFont(result.font_path).getBestCmap()) == {
            *BASE_CODEPOINTS,
            *DONOR_CODEPOINTS,
        }

    def test_missing_donor_file_is_a_clear_error(self, tmp_path, base_font):
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base: {base_font.name}\ndonors:\n  - nope.ttf\n", encoding="utf-8"
        )

        with pytest.raises(BuildError, match="nope.ttf"):
            build(recipe, tmp_path / "out.ttf")

    def test_donor_that_is_not_a_font_is_a_clear_error(self, tmp_path, base_font):
        junk = tmp_path / "junk.txt"
        junk.write_text("this is not a font", encoding="utf-8")
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base: {base_font.name}\ndonors:\n  - {junk.name}\n", encoding="utf-8"
        )

        with pytest.raises(BuildError, match="font"):
            build(recipe, tmp_path / "out.ttf")

    def test_base_without_unicode_coverage_is_a_clear_error(self, tmp_path):
        junk = tmp_path / "junk.txt"
        junk.write_text("not a font either", encoding="utf-8")
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(f"base: {junk.name}\ndonors: []\n", encoding="utf-8")

        with pytest.raises(BuildError, match="font"):
            build(recipe, tmp_path / "out.ttf")

    def test_empty_donor_list_builds_the_base_alone(self, tmp_path, base_font):
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(f"base: {base_font.name}\ndonors: []\n", encoding="utf-8")

        result = build(recipe, tmp_path / "out.ttf")

        report = _load_report(result.report_path)
        assert all(entry["winner"] == "base" for entry in report["provenance"])
        assert report["summary"]["from_donors"] == 0
        assert set(TTFont(result.font_path).getBestCmap()) == set(BASE_CODEPOINTS)

    def test_default_precedence_base_first_then_donors_in_join_order(
        self, tmp_path, synth_font_factory
    ):
        base = synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=BASE_CODEPOINTS
        )
        # donor-0 shares 0x41 with the base and owns 0x4E2D;
        # donor-1 owns 0x4E2D and 0x56FD.
        donor0 = synth_font_factory(
            tmp_path / "donor0.ttf",
            family="SynthDonorZero",
            codepoints=(0x41, 0x4E2D),
        )
        donor1 = synth_font_factory(
            tmp_path / "donor1.ttf",
            family="SynthDonorOne",
            codepoints=(0x4E2D, 0x56FD),
        )
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base: {base.name}\ndonors:\n  - {donor0.name}\n  - {donor1.name}\n",
            encoding="utf-8",
        )

        result = build(recipe, tmp_path / "out.ttf")

        report = _load_report(result.report_path)
        winners = {entry["codepoint"]: entry["winner"] for entry in report["provenance"]}
        # The base is never displaced without an explicit rule.
        assert winners[0x41] == "base"
        # Donors fill in join order...
        assert winners[0x4E2D] == "donor-0"
        # ...and absence never overrides: donor-1 wins only what donor-0 lacks.
        assert winners[0x56FD] == "donor-1"


class TestBuildProgress:
    """The progress callback reports the pipeline's stages in order."""

    def test_build_reports_each_stage_as_it_is_entered(
        self, recipe_file, tmp_path
    ):
        stages: list[str] = []

        result = build(
            recipe_file,
            tmp_path / "out.ttf",
            progress=stages.append,
        )

        assert stages == [
            "loading",
            "planning",
            "resolving",
            "grafting",
            "rewriting",
            "saving",
            "reporting",
        ]
        assert result.font_path.is_file()

    def test_progress_is_optional_and_changes_nothing(self, recipe_file, tmp_path):
        quiet = build(recipe_file, tmp_path / "quiet.ttf")
        loud = build(
            recipe_file, tmp_path / "loud.ttf", progress=lambda stage: None
        )

        # Byte-reproducible builds hold with or without an observer.
        assert quiet.font_path.read_bytes() == loud.font_path.read_bytes()
