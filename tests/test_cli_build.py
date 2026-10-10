"""Seam 2 tests: the real ``fontalloy`` executable, driven as a subprocess.

Per the testing decisions in issue #1, the executable surface is exercised
exactly the way external consumers see it: build a recipe file, invoke the
installed console script, read the output files back.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fontTools.ttLib import TTFont

from conftest import BASE_CODEPOINTS, fontalloy_exe, run_cli  # noqa: F401

pytest.register_assert_rewrite("conftest")


class TestCliBuild:
    def test_build_writes_font_and_report(self, fontalloy_exe, recipe_file):
        result = run_cli(fontalloy_exe, "build", recipe_file.name, cwd=recipe_file.parent)

        assert result.returncode == 0, result.stderr
        output = recipe_file.parent / "recipe.ttf"
        assert set(TTFont(output).getBestCmap()) == set(BASE_CODEPOINTS)
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
        assert report["summary"]["output_codepoints"] == len(BASE_CODEPOINTS)
        assert not (recipe_file.parent / "recipe.ttf").exists()

    def test_recipe_error_exits_nonzero_with_a_clear_message(
        self, fontalloy_exe, tmp_path
    ):
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text("donors: []\n", encoding="utf-8")

        result = run_cli(fontalloy_exe, "build", recipe.name, cwd=tmp_path)

        assert result.returncode != 0
        assert "base" in result.stderr
