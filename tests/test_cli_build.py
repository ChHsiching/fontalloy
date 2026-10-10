"""Seam 2 tests: the real ``fontalloy`` executable, driven as a subprocess.

Per the testing decisions in issue #1, the executable surface is exercised
exactly the way external consumers see it: build a recipe file, invoke the
installed console script, read the output files back.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fontTools.ttLib import TTCollection, TTFont

from conftest import (  # noqa: F401
    BASE_CODEPOINTS,
    DONOR_CODEPOINTS,
    fontalloy_exe,
    run_cli,
)

pytest.register_assert_rewrite("conftest")


class TestCliBuild:
    def test_build_writes_font_and_report(self, fontalloy_exe, recipe_file):
        result = run_cli(fontalloy_exe, "build", recipe_file.name, cwd=recipe_file.parent)

        assert result.returncode == 0, result.stderr
        output = recipe_file.parent / "recipe.ttf"
        # Grafted output: the union of the effective table (base + donor).
        assert set(TTFont(output).getBestCmap()) == {
            *BASE_CODEPOINTS,
            *DONOR_CODEPOINTS,
        }
        report = json.loads(
            (recipe_file.parent / "recipe.report.json").read_text(encoding="utf-8")
        )
        winners = {entry["codepoint"]: entry["winner"] for entry in report["provenance"]}
        assert winners[0x41] == "base"
        assert winners[0x4E2D] == "donor-0"
        assert "recipe.ttf" in result.stdout

    def test_build_honors_output_and_report_options(self, fontalloy_exe, recipe_file):
        result = run_cli(
            fontalloy_exe,
            "build",
            recipe_file.name,
            "--output",
            "merged.ttf",
            "--report",
            "merged-report.json",
            cwd=recipe_file.parent,
        )

        assert result.returncode == 0, result.stderr
        assert TTFont(recipe_file.parent / "merged.ttf")["head"].unitsPerEm == 1000
        report = json.loads(
            (recipe_file.parent / "merged-report.json").read_text(encoding="utf-8")
        )
        assert report["summary"]["output_codepoints"] == len(
            BASE_CODEPOINTS
        ) + len(DONOR_CODEPOINTS)
        assert not (recipe_file.parent / "recipe.ttf").exists()

    def test_recipe_error_exits_nonzero_with_a_clear_message(
        self, fontalloy_exe, tmp_path
    ):
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text("donors: []\n", encoding="utf-8")

        result = run_cli(fontalloy_exe, "build", recipe.name, cwd=tmp_path)

        assert result.returncode != 0
        assert "base" in result.stderr


class TestCliBuildFormat:
    """The output format is a CLI switch over the same core build."""

    def test_format_ttc_packages_every_base_face(
        self, fontalloy_exe, tmp_path, synth_ttc_factory, donor_font
    ):
        synth_ttc_factory(
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
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base: family.ttc\ndonors:\n  - {donor_font.name}\n", encoding="utf-8"
        )

        result = run_cli(fontalloy_exe, "build", recipe.name, "--format", "ttc", cwd=tmp_path)

        assert result.returncode == 0, result.stderr
        output = tmp_path / "recipe.ttc"  # the default suffix follows the format
        assert output.read_bytes()[:4] == b"ttcf"
        assert len(TTCollection(output).fonts) == 2
        for face in TTCollection(output).fonts:
            assert set(face.getBestCmap()) == {*BASE_CODEPOINTS, *DONOR_CODEPOINTS}

    def test_format_woff2_writes_a_woff2(self, fontalloy_exe, recipe_file):
        result = run_cli(
            fontalloy_exe, "build", recipe_file.name, "--format", "woff2", cwd=recipe_file.parent
        )

        assert result.returncode == 0, result.stderr
        output = recipe_file.parent / "recipe.woff2"
        assert output.read_bytes()[:4] == b"wOF2"
        assert TTFont(output).flavor == "woff2"

    def test_unknown_format_is_a_clear_error(self, fontalloy_exe, recipe_file):
        result = run_cli(
            fontalloy_exe, "build", recipe_file.name, "--format", "cff", cwd=recipe_file.parent
        )

        assert result.returncode != 0
        assert "woff2" in result.stderr
