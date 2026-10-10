"""Catalog-family font references in recipes (issue #23).

A recipe is the share unit, and an official recipe must never carry a
loose URL: its font references name catalog *families* pinned by the
committed manifest, and the assets machinery resolves them against the
fetched catalog — the same sha256-verified files ``fontalloy assets
fetch`` fills. These tests exercise the reference schema (the strict
loader), the resolution (family/variant lookup, pattern narrowing,
checksum enforcement), and that a catalog-reference recipe builds
through the ordinary seam-1 entry point with the artifact recorded as
the build's source provenance.
"""

from __future__ import annotations

import json
import shutil
import zipfile
from dataclasses import replace
from pathlib import Path

import pytest

from conftest import synth_font, synth_variable_font

from fontalloy_core.assets import (
    fetch_catalog,
    recipe_catalog_families,
    resolve_recipe_fonts,
)
from fontalloy_core.build import build
from fontalloy_core.errors import AssetsError, RecipeError
from fontalloy_core.recipe import load_recipe, parse_recipe

MANIFEST_SCHEMA = "fontalloy/font-catalog@v1"

FAKE_OFL = (
    "Copyright 2026 The Fake Code Project Authors (example.com)\n\n"
    "This Font Software is licensed under the SIL Open Font License, "
    "Version 1.1.\n"
)

#: The synthetic base family's Latin pair and the donor's CJK pair.
BASE_CODEPOINTS = (0x0041, 0x0062)
DONOR_CODEPOINTS = (0x4E2D, 0x56FD)


def _sha256(path: Path) -> str:
    import hashlib

    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.fixture
def catalog_site(tmp_path: Path) -> Path:
    """A fetched-catalog stand-in: manifest + fonts directory.

    Layout exactly as ``fontalloy assets fetch`` fills it: one zipped
    family with two weight faces extracted beside the verified archive,
    one bare-TTF family, and a second variant of the bare family so a
    family-only reference is genuinely ambiguous. The manifest's URLs
    are file:// origins over the same artifacts, so filtered fetches
    run offline like the rest of the suite.
    """
    fonts = tmp_path / "fonts"
    fonts.mkdir()
    licenses = tmp_path / "licenses"
    licenses.mkdir()
    (licenses / "OFL-1.1.txt").write_text(FAKE_OFL, encoding="utf-8")

    faces_dir = fonts / "FakeCode"
    faces_dir.mkdir()
    synth_font(
        faces_dir / "FakeCodeNerdFont-Regular.ttf",
        family="FakeCode Nerd Font",
        codepoints=BASE_CODEPOINTS,
        weight=400,
    )
    synth_font(
        faces_dir / "FakeCodeNerdFont-Bold.ttf",
        family="FakeCode Nerd Font",
        codepoints=BASE_CODEPOINTS,
        weight=700,
    )
    with zipfile.ZipFile(fonts / "FakeCode.zip", "w") as zf:
        zf.writestr(
            "FakeCodeNerdFont-Regular.ttf",
            (faces_dir / "FakeCodeNerdFont-Regular.ttf").read_bytes(),
        )
        zf.writestr(
            "FakeCodeNerdFont-Bold.ttf",
            (faces_dir / "FakeCodeNerdFont-Bold.ttf").read_bytes(),
        )
        zf.writestr("readme.md", "not a font")

    synth_font(
        fonts / "FakeCJK-Regular.ttf",
        family="FakeCJK",
        codepoints=DONOR_CODEPOINTS,
        weight=400,
    )
    synth_variable_font(
        fonts / "FakeCJKPro-Regular.ttf",
        family="FakeCJK Pro",
        codepoints=DONOR_CODEPOINTS,
    )

    entries = [
        {
            "family": "FakeCode",
            "variant": "Nerd Font",
            "file": "FakeCode.zip",
            "version": "v1.0",
            "upstream_url": (fonts / "FakeCode.zip").as_uri(),
            "sha256": _sha256(fonts / "FakeCode.zip"),
            "license_spdx": "OFL-1.1-RFN",
            "rfn": True,
            "rfn_names": ["Fake Code"],
            "copyright": "Copyright 2026 The Fake Code Project Authors",
            "license_file": "licenses/OFL-1.1.txt",
            "checksum_source": "self-computed",
        },
        {
            "family": "FakeCJK",
            "variant": "",
            "file": "FakeCJK-Regular.ttf",
            "version": "v1.0",
            "upstream_url": (fonts / "FakeCJK-Regular.ttf").as_uri(),
            "sha256": _sha256(fonts / "FakeCJK-Regular.ttf"),
            "license_spdx": "OFL-1.1-no-RFN",
            "rfn": False,
            "rfn_names": [],
            "copyright": "Copyright 2026 The FakeCJK Project Authors",
            "license_file": "licenses/OFL-1.1.txt",
            "checksum_source": "self-computed",
        },
        {
            "family": "FakeCJK",
            "variant": "Pro",
            "file": "FakeCJKPro-Regular.ttf",
            "version": "v1.0",
            "upstream_url": (fonts / "FakeCJKPro-Regular.ttf").as_uri(),
            "sha256": _sha256(fonts / "FakeCJKPro-Regular.ttf"),
            "license_spdx": "OFL-1.1-no-RFN",
            "rfn": False,
            "rfn_names": [],
            "copyright": "Copyright 2026 The FakeCJK Project Authors",
            "license_file": "licenses/OFL-1.1.txt",
            "checksum_source": "self-computed",
        },
    ]
    (tmp_path / "fonts.manifest.json").write_text(
        json.dumps({"schema": MANIFEST_SCHEMA, "families": entries}, indent=1)
        + "\n",
        encoding="utf-8",
    )
    return tmp_path


def _recipe(tmp_path: Path, body: str) -> Path:
    path = tmp_path / "recipe.yaml"
    path.write_text(body, encoding="utf-8")
    return path


# --- the reference schema (the strict loader) ------------------------------


def test_a_catalog_reference_parses_with_family_variant_and_pattern():
    recipe = load_recipe(
        _recipe(
            Path("."),
            "base:\n"
            "  family: FakeCode\n"
            "  variant: Nerd Font\n"
            '  pattern: "FakeCodeNerdFont-*.ttf"\n'
            "donors:\n"
            "  - family: FakeCJK\n"
            "    variant: Pro\n"
            "    instance:\n"
            "      wght: 400\n",
        )
    )
    assert recipe.base.family == "FakeCode"
    assert recipe.base.variant == "Nerd Font"
    assert recipe.base.pattern == "FakeCodeNerdFont-*.ttf"
    assert recipe.base.face is None
    assert recipe.donors[0].family == "FakeCJK"
    assert recipe.donors[0].instance == (("wght", 400),)
    # A catalog reference carries no path until the assets machinery
    # resolves it; a plain path reference still does.
    assert recipe.base.path is None
    assert recipe.donors[0].path is None


def test_a_path_reference_still_parses_unchanged(tmp_path: Path):
    recipe = load_recipe(
        _recipe(tmp_path, "base: base.ttf\ndonors:\n  - donor.ttf\n")
    )
    assert recipe.base.path == (tmp_path / "base.ttf").resolve()
    assert recipe.base.family is None
    assert recipe.base.paths == (recipe.base.path,)


def test_a_reference_cannot_mix_path_and_family(tmp_path: Path):
    with pytest.raises(RecipeError, match="both 'path' and 'family'"):
        load_recipe(
            _recipe(
                tmp_path,
                "base:\n  path: base.ttf\n  family: FakeCode\ndonors:\n  - d.ttf\n",
            )
        )


def test_variant_and_pattern_require_family(tmp_path: Path):
    with pytest.raises(RecipeError, match="requires 'family'"):
        load_recipe(
            _recipe(
                tmp_path,
                "base:\n  path: base.ttf\ndonors:\n  - variant: Pro\n",
            )
        )
    with pytest.raises(RecipeError, match="requires 'family'"):
        load_recipe(
            _recipe(
                tmp_path,
                "base:\n  path: base.ttf\ndonors:\n  - pattern: \"*.ttf\"\n",
            )
        )


def test_a_pattern_must_be_a_bare_filename_glob(tmp_path: Path):
    with pytest.raises(RecipeError, match="bare filename glob"):
        load_recipe(
            _recipe(
                tmp_path,
                'base:\n  family: FakeCode\n  pattern: "sub/*.ttf"\n'
                "donors:\n  - d.ttf\n",
            )
        )


# --- resolution against the fetched catalog --------------------------------


def test_resolution_expands_a_family_to_the_fetched_faces(catalog_site: Path):
    recipe = load_recipe(
        _recipe(
            catalog_site,
            "base:\n  family: FakeCode\ndonors:\n  - family: FakeCJK\n"
            "    variant: Pro\n",
        )
    )
    resolved = resolve_recipe_fonts(recipe, catalog_site / "fonts.manifest.json")
    assert [p.name for p in resolved.base.paths] == [
        "FakeCodeNerdFont-Bold.ttf",
        "FakeCodeNerdFont-Regular.ttf",
    ]
    assert resolved.base.artifact == catalog_site / "fonts" / "FakeCode.zip"
    assert [p.name for p in resolved.donors[0].paths] == ["FakeCJKPro-Regular.ttf"]
    assert resolved.donors[0].artifact == (
        catalog_site / "fonts" / "FakeCJKPro-Regular.ttf"
    )


def test_a_pattern_narrows_a_multi_file_family(catalog_site: Path):
    recipe = load_recipe(
        _recipe(
            catalog_site,
            'base:\n  family: FakeCode\n  pattern: "*Regular.ttf"\n'
            "donors:\n  - family: FakeCJK\n    variant: Pro\n",
        )
    )
    resolved = resolve_recipe_fonts(recipe, catalog_site / "fonts.manifest.json")
    assert [p.name for p in resolved.base.paths] == ["FakeCodeNerdFont-Regular.ttf"]


def test_a_pattern_that_matches_nothing_names_what_is_there(
    catalog_site: Path,
):
    recipe = load_recipe(
        _recipe(
            catalog_site,
            'base:\n  family: FakeCode\n  pattern: "Nope-*.ttf"\n'
            "donors:\n  - family: FakeCJK\n    variant: Pro\n",
        )
    )
    with pytest.raises(AssetsError, match="FakeCodeNerdFont-Regular.ttf"):
        resolve_recipe_fonts(recipe, catalog_site / "fonts.manifest.json")


def test_an_ambiguous_family_without_variant_lists_the_variants(
    catalog_site: Path,
):
    recipe = load_recipe(
        _recipe(
            catalog_site, "base:\n  family: FakeCJK\ndonors:\n  - d.ttf\n"
        )
    )
    with pytest.raises(AssetsError, match="variant.*Pro"):
        resolve_recipe_fonts(recipe, catalog_site / "fonts.manifest.json")


def test_an_unknown_family_is_a_clear_error(catalog_site: Path):
    recipe = load_recipe(
        _recipe(
            catalog_site, "base:\n  family: Nope\ndonors:\n  - d.ttf\n"
        )
    )
    with pytest.raises(AssetsError, match="unknown catalog family 'Nope'"):
        resolve_recipe_fonts(recipe, catalog_site / "fonts.manifest.json")


def test_an_unfetched_family_points_at_the_fetch_command(catalog_site: Path):
    (catalog_site / "fonts" / "FakeCJKPro-Regular.ttf").unlink()
    recipe = load_recipe(
        _recipe(
            catalog_site,
            "base:\n  family: FakeCJK\n  variant: Pro\ndonors:\n  - d.ttf\n",
        )
    )
    with pytest.raises(AssetsError, match="assets fetch"):
        resolve_recipe_fonts(recipe, catalog_site / "fonts.manifest.json")


def test_a_drifted_artifact_fails_resolution_loudly(catalog_site: Path):
    # Re-pin the manifest to a checksum the file no longer matches.
    manifest_path = catalog_site / "fonts.manifest.json"
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    for entry in data["families"]:
        if entry["file"] == "FakeCJKPro-Regular.ttf":
            entry["sha256"] = "0" * 64
    manifest_path.write_text(json.dumps(data), encoding="utf-8")
    recipe = load_recipe(
        _recipe(
            catalog_site,
            "base:\n  family: FakeCJK\n  variant: Pro\ndonors:\n  - d.ttf\n",
        )
    )
    with pytest.raises(AssetsError, match="sha256 mismatch"):
        resolve_recipe_fonts(recipe, manifest_path)


def test_recipe_catalog_families_collects_every_reference(catalog_site: Path):
    recipe = load_recipe(
        _recipe(
            catalog_site,
            "base:\n  family: FakeCode\ndonors:\n  - family: FakeCJK\n"
            "    variant: Pro\n",
        )
    )
    assert recipe_catalog_families(recipe) == ("FakeCJK", "FakeCode")


# --- building through the catalog ------------------------------------------


def test_a_catalog_recipe_builds_and_pins_the_artifact_as_its_source(
    catalog_site: Path, tmp_path_factory: pytest.TempPathFactory
):
    out_dir = tmp_path_factory.mktemp("catalog-build")
    recipe_path = _recipe(
        catalog_site,
        "base:\n  family: FakeCode\ndonors:\n  - family: FakeCJK\n"
        "    variant: Pro\n    instance:\n      wght: 400\n"
        "weights:\n  - weight: 400\n",
    )
    result = build(
        recipe_path,
        out_dir / "merged.ttf",
        manifest=catalog_site / "fonts.manifest.json",
    )
    from fontTools.ttLib import TTFont

    font = TTFont(result.font_path)
    cmap = font.getBestCmap()
    assert set(cmap) >= set(BASE_CODEPOINTS) | set(DONOR_CODEPOINTS)
    # The source records name the manifest-pinned artifact, not the
    # extracted face: the build's provenance is the pin itself.
    base_source = result.report.sources[0]
    assert base_source.path == catalog_site / "fonts" / "FakeCode.zip"
    assert base_source.sha256 == _sha256(catalog_site / "fonts" / "FakeCode.zip")
    donor_source = result.report.sources[1]
    assert donor_source.path == catalog_site / "fonts" / "FakeCJKPro-Regular.ttf"


def test_a_catalog_recipe_rebuilds_byte_identically(
    catalog_site: Path, tmp_path_factory: pytest.TempPathFactory
):
    out_dir = tmp_path_factory.mktemp("catalog-rebuild")
    recipe_path = _recipe(
        catalog_site,
        "base:\n  family: FakeCode\ndonors:\n  - family: FakeCJK\n"
        "    variant: Pro\nweights:\n  - weight: 400\n",
    )
    manifest = catalog_site / "fonts.manifest.json"
    first = build(recipe_path, out_dir / "merged.ttf", manifest=manifest)
    second = build(recipe_path, out_dir / "merged.ttf", manifest=manifest)
    assert first.font_path.read_bytes() == second.font_path.read_bytes()
    assert first.report_path.read_bytes() == second.report_path.read_bytes()
    assert (
        first.report_html_path.read_bytes()
        == second.report_html_path.read_bytes()
    )


def test_an_unresolved_catalog_ref_names_the_manifest_problem(
    catalog_site: Path, tmp_path_factory: pytest.TempPathFactory
):
    out_dir = tmp_path_factory.mktemp("catalog-noresolve")
    recipe_path = _recipe(
        catalog_site,
        "base:\n  family: FakeCode\ndonors:\n  - family: FakeCJK\n"
        "    variant: Pro\n",
    )
    with pytest.raises(Exception, match="manifest"):
        build(recipe_path, out_dir / "merged.ttf", manifest=None)


# --- filtered fetch ---------------------------------------------------------


def test_fetch_catalog_filters_to_requested_families(catalog_site: Path):
    dest = catalog_site / "filtered"
    # Move the artifacts away so the fetch truly downloads (the file://
    # origin is a copy under out-of-origin/); the fonts/ layout the
    # resolution tests use stays untouched.
    origin = catalog_site / "out-of-origin"
    origin.mkdir()
    for name in ("FakeCode.zip", "FakeCJK-Regular.ttf", "FakeCJKPro-Regular.ttf"):
        shutil.copy2(catalog_site / "fonts" / name, origin / name)
    manifest_path = catalog_site / "filtered-manifest.json"
    data = json.loads((catalog_site / "fonts.manifest.json").read_text(encoding="utf-8"))
    for entry in data["families"]:
        entry["upstream_url"] = (origin / entry["file"]).as_uri()
    manifest_path.write_text(json.dumps(data), encoding="utf-8")

    summary = fetch_catalog(manifest_path, dest, families=("FakeCJK",))
    assert summary.downloaded == 2  # both FakeCJK variants, one family
    assert (dest / "FakeCJK-Regular.ttf").is_file()
    assert (dest / "FakeCJKPro-Regular.ttf").is_file()
    assert not (dest / "FakeCode.zip").exists()


def test_fetch_catalog_rejects_an_unknown_family(catalog_site: Path):
    with pytest.raises(AssetsError, match="unknown family 'Nope'"):
        fetch_catalog(
            catalog_site / "fonts.manifest.json",
            catalog_site / "filtered",
            families=("Nope",),
        )
