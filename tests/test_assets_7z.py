"""7z archive support in the fetch pipeline (LxgwBright-Code's format).

LxgwBright-Code ships its releases as ``.7z`` only — the one Tier-S
family the catalog expansion skipped for exactly that reason. The fetch
engine treats a 7z artifact exactly like a zip: download, verify the
pinned sha256, extract the font faces beside the verified archive, and
fail loudly when the archive cannot be decoded. These tests run offline
against a tiny fixture ``.7z`` built in-test with py7zr itself (the
same reader the pipeline uses), mirroring the zip tests in
``test_cli_assets.py`` / ``test_catalog_refs.py``.
"""

from __future__ import annotations

import json
import shutil
import zipfile
from pathlib import Path

import py7zr
import pytest

from conftest import fontalloy_exe, run_cli, synth_font  # noqa: F401

from fontalloy_core.assets import fetch_catalog, resolve_recipe_fonts
from fontalloy_core.errors import AssetsError
from fontalloy_core.recipe import load_recipe

MANIFEST_SCHEMA = "fontalloy/font-catalog@v1"

FAKE_OFL = (
    "Copyright 2026 The Fake Bright Project Authors (example.com)\n\n"
    "This Font Software is licensed under the SIL Open Font License, "
    "Version 1.1.\n"
)

#: Latin pair for the synthetic faces (a coding-font stand-in).
FACE_CODEPOINTS = (0x0041, 0x0062)


def _sha256(path: Path) -> str:
    import hashlib

    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.fixture
def seven_zip_site(tmp_path: Path) -> Path:
    """A local stand-in for a 7z-only upstream, addressed via file://.

    The archive nests its faces one directory deep (upstream layout),
    and carries a readme plus a dotfile that extraction must skip. The
    manifest entry mirrors the committed LxgwBrightCode rows: a pinned
    7z artifact, self-computed checksum.
    """
    origin = tmp_path / "origin"
    origin.mkdir(parents=True)
    licenses = tmp_path / "licenses"
    licenses.mkdir()
    (licenses / "OFL-1.1.txt").write_text(FAKE_OFL, encoding="utf-8")

    staging = tmp_path / "staging" / "Bright"
    staging.mkdir(parents=True)
    synth_font(
        staging / "FakeBright-Regular.ttf",
        family="Fake Bright",
        codepoints=FACE_CODEPOINTS,
        weight=400,
    )
    synth_font(
        staging / "FakeBright-Light.ttf",
        family="Fake Bright",
        codepoints=FACE_CODEPOINTS,
        weight=300,
    )
    (staging / "readme.md").write_text("not a font; extraction must skip this")
    (staging / ".hidden.ttf").write_bytes(b"a dotfile font; also skipped")
    with py7zr.SevenZipFile(origin / "FakeBright.7z", "w") as sz:
        sz.writeall(staging, "Bright")

    entry = {
        "family": "FakeBright",
        "variant": "Standard",
        "file": "FakeBright.7z",
        "version": "v1.0",
        "upstream_url": (origin / "FakeBright.7z").as_uri(),
        "sha256": _sha256(origin / "FakeBright.7z"),
        "license_spdx": "OFL-1.1-RFN",
        "rfn": True,
        "rfn_names": ["Fake Bright"],
        "copyright": "Copyright 2026 The Fake Bright Project Authors",
        "license_file": "licenses/OFL-1.1.txt",
        "checksum_source": "self-computed",
    }
    (tmp_path / "fonts.manifest.json").write_text(
        json.dumps({"schema": MANIFEST_SCHEMA, "families": [entry]}, indent=1)
        + "\n",
        encoding="utf-8",
    )
    return tmp_path


class TestFetch7z:
    def test_fetch_downloads_verifies_and_extracts_a_7z(
        self, fontalloy_exe, seven_zip_site, tmp_path
    ):
        result = run_cli(
            fontalloy_exe,
            "assets",
            "fetch",
            "--manifest",
            str(seven_zip_site / "fonts.manifest.json"),
            cwd=tmp_path,
        )

        assert result.returncode == 0, result.stderr
        # dest defaults to a fonts directory beside the manifest
        fonts = seven_zip_site / "fonts"
        assert _sha256(fonts / "FakeBright.7z") == _sha256(
            seven_zip_site / "origin" / "FakeBright.7z"
        )
        # the faces extract beside the verified archive; nested member
        # paths flatten to bare filenames; non-fonts stay inside
        assert (fonts / "FakeBright" / "FakeBright-Regular.ttf").is_file()
        assert (fonts / "FakeBright" / "FakeBright-Light.ttf").is_file()
        assert not (fonts / "FakeBright" / "readme.md").exists()
        assert not (fonts / "FakeBright" / ".hidden.ttf").exists()
        assert "FakeBright.7z" in result.stdout

    def test_a_verified_7z_with_a_vanished_extraction_is_reextracted(
        self, seven_zip_site
    ):
        """The zip repair rule (issue #23) holds for 7z too: a verified
        artifact whose extracted faces vanished re-extracts without
        re-downloading."""
        fonts = seven_zip_site / "fonts"
        first = fetch_catalog(seven_zip_site / "fonts.manifest.json", fonts)
        assert first.downloaded == 1
        shutil.rmtree(fonts / "FakeBright")

        # the origin going away proves the repair path downloads nothing
        (seven_zip_site / "origin" / "FakeBright.7z").unlink()
        second = fetch_catalog(seven_zip_site / "fonts.manifest.json", fonts)
        assert second.downloaded == 0
        assert second.skipped == 1
        assert (fonts / "FakeBright" / "FakeBright-Regular.ttf").is_file()

    def test_an_undecodable_7z_fails_loudly(
        self, fontalloy_exe, seven_zip_site, tmp_path
    ):
        """A sha-verified artifact py7zr cannot decode (here: valid 7z
        magic, garbage body) is a loud error, never a silent layout."""
        bad = seven_zip_site / "origin" / "Broken.7z"
        bad.write_bytes(b"7z\xbc\xaf\x27\x1c" + b"garbage" * 64)
        manifest = seven_zip_site / "broken-manifest.json"
        data = json.loads(
            (seven_zip_site / "fonts.manifest.json").read_text(encoding="utf-8")
        )
        data["families"][0]["file"] = "Broken.7z"
        data["families"][0]["upstream_url"] = bad.as_uri()
        data["families"][0]["sha256"] = _sha256(bad)
        manifest.write_text(json.dumps(data), encoding="utf-8")

        result = run_cli(
            fontalloy_exe,
            "assets",
            "fetch",
            "--manifest",
            str(manifest),
            cwd=tmp_path,
        )

        assert result.returncode != 0
        assert "Broken.7z" in result.stderr
        assert "7z extraction failed" in result.stderr
        # the verified artifact of record stays; nothing was extracted
        assert (seven_zip_site / "fonts" / "Broken.7z").is_file()
        assert not (seven_zip_site / "fonts" / "Broken").is_dir()

    def test_a_misnamed_7z_still_extracts(self, seven_zip_site):
        """Format detection reads content, not the manifest's filename:
        upstream is free to name the artifact anything."""
        fonts = seven_zip_site / "fonts"
        renamed = seven_zip_site / "origin" / "FakeBright-download.bin"
        shutil.copy2(seven_zip_site / "origin" / "FakeBright.7z", renamed)
        manifest = seven_zip_site / "renamed-manifest.json"
        data = json.loads(
            (seven_zip_site / "fonts.manifest.json").read_text(encoding="utf-8")
        )
        data["families"][0]["file"] = renamed.name
        data["families"][0]["upstream_url"] = renamed.as_uri()
        data["families"][0]["sha256"] = _sha256(renamed)
        manifest.write_text(json.dumps(data), encoding="utf-8")

        summary = fetch_catalog(manifest, fonts)

        assert summary.downloaded == 1
        # extraction dir is the artifact stem, extraction works anyway
        assert (fonts / "FakeBright-download" / "FakeBright-Regular.ttf").is_file()

    def test_fetch_still_handles_zips_alongside_7z(self, seven_zip_site):
        """One manifest, both archive formats: the engine dispatches per
        artifact, not per manifest."""
        fonts = seven_zip_site / "fonts"
        with zipfile.ZipFile(seven_zip_site / "origin" / "Zipped.zip", "w") as zf:
            zf.writestr("ZippedCode-Regular.ttf", b"zip face bytes")
        manifest = seven_zip_site / "mixed-manifest.json"
        data = json.loads(
            (seven_zip_site / "fonts.manifest.json").read_text(encoding="utf-8")
        )
        data["families"].append(
            {
                "family": "ZippedCode",
                "variant": "",
                "file": "Zipped.zip",
                "version": "v1.0",
                "upstream_url": (seven_zip_site / "origin" / "Zipped.zip").as_uri(),
                "sha256": _sha256(seven_zip_site / "origin" / "Zipped.zip"),
                "license_spdx": "OFL-1.1-no-RFN",
                "rfn": False,
                "rfn_names": [],
                "copyright": "Copyright 2026 Zipped",
                "license_file": "licenses/OFL-1.1.txt",
                "checksum_source": "self-computed",
            }
        )
        manifest.write_text(json.dumps(data), encoding="utf-8")

        summary = fetch_catalog(manifest, fonts)

        assert summary.downloaded == 2
        assert (fonts / "FakeBright" / "FakeBright-Regular.ttf").is_file()
        assert (fonts / "Zipped" / "ZippedCode-Regular.ttf").is_file()


class TestRecipeReferencesIntoA7z:
    def test_a_recipe_reference_resolves_into_a_7z_family(
        self, seven_zip_site
    ):
        """The family class 7z unlocks: a recipe names the family, the
        assets machinery re-verifies the artifact and hands the build
        the extracted faces — pattern narrowing included."""
        fetch_catalog(
            seven_zip_site / "fonts.manifest.json", seven_zip_site / "fonts"
        )
        recipe_path = seven_zip_site / "recipe.yaml"
        recipe_path.write_text(
            "base:\n"
            "  family: FakeBright\n"
            '  pattern: "FakeBright-Regular.ttf"\n'
            "donors:\n"
            "  - family: FakeBright\n"
            '    pattern: "FakeBright-Light.ttf"\n',
            encoding="utf-8",
        )
        recipe = load_recipe(recipe_path)

        resolved = resolve_recipe_fonts(
            recipe, seven_zip_site / "fonts.manifest.json"
        )

        assert [p.name for p in resolved.base.paths] == ["FakeBright-Regular.ttf"]
        assert resolved.base.artifact == (
            seven_zip_site / "fonts" / "FakeBright.7z"
        )
        assert [p.name for p in resolved.donors[0].paths] == [
            "FakeBright-Light.ttf"
        ]

    def test_resolution_rejects_a_7z_family_whose_extraction_vanished(
        self, seven_zip_site
    ):
        fetch_catalog(
            seven_zip_site / "fonts.manifest.json", seven_zip_site / "fonts"
        )
        shutil.rmtree(seven_zip_site / "fonts" / "FakeBright")
        recipe_path = seven_zip_site / "recipe.yaml"
        recipe_path.write_text(
            "base:\n  family: FakeBright\ndonors:\n  - d.ttf\n",
            encoding="utf-8",
        )
        recipe = load_recipe(recipe_path)

        with pytest.raises(AssetsError, match="assets fetch"):
            resolve_recipe_fonts(
                recipe, seven_zip_site / "fonts.manifest.json"
            )
