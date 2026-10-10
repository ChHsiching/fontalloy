"""Seam 2 tests: the recipes surface of the ``fontalloy`` CLI (issue #23).

``fontalloy recipes families`` (the fetch filter CI composes),
``fontalloy recipes package`` (the release staging), the filtered
``assets fetch``/``assets notices`` switches, and ``build --manifest``
resolving catalog-family references — all offline, against local
file:// origins and synthetic fonts, exactly like the other seam-2
assets tests.
"""

from __future__ import annotations

import hashlib
import json
import zipfile
from pathlib import Path

import pytest

from conftest import (
    base_font,  # noqa: F401
    donor_font,  # noqa: F401
    fontalloy_exe,
    run_cli,
    synth_font,
    synth_variable_font,
)

MANIFEST_SCHEMA = "fontalloy/font-catalog@v1"
FAKE_OFL = (
    "Copyright 2026 The Fake Code Project Authors (example.com)\n\n"
    "This Font Software is licensed under the SIL Open Font License, "
    "Version 1.1.\n"
)

BASE_CODEPOINTS = (0x0041, 0x0062)
DONOR_CODEPOINTS = (0x4E2D, 0x56FD)


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.fixture
def site(tmp_path: Path) -> Path:
    """A mini catalog: an origin directory, a manifest, recipes, fonts.

    Two families over file:// origins — a zipped family with two weight
    faces and a bare variable-TTF family — plus recipes referencing
    them (one official-shaped, one community-shaped) under ``recipes``.
    """
    origin = tmp_path / "origin"
    origin.mkdir()
    licenses = tmp_path / "licenses"
    licenses.mkdir()
    (licenses / "OFL-1.1.txt").write_text(FAKE_OFL, encoding="utf-8")

    faces = origin / "faces"
    faces.mkdir()
    synth_font(
        faces / "FakeCodeNerdFont-Regular.ttf",
        family="FakeCode Nerd Font",
        codepoints=BASE_CODEPOINTS,
        weight=400,
    )
    synth_font(
        faces / "FakeCodeNerdFont-Bold.ttf",
        family="FakeCode Nerd Font",
        codepoints=BASE_CODEPOINTS,
        weight=700,
    )
    with zipfile.ZipFile(origin / "FakeCode.zip", "w") as zf:
        for name in sorted(p.name for p in faces.iterdir()):
            zf.writestr(name, (faces / name).read_bytes())
    synth_variable_font(
        origin / "FakeCJK[wght].ttf",
        family="FakeCJK",
        codepoints=DONOR_CODEPOINTS,
    )

    entries = [
        {
            "family": "FakeCode",
            "variant": "Nerd Font",
            "file": "FakeCode.zip",
            "version": "v1.0",
            "upstream_url": (origin / "FakeCode.zip").as_uri(),
            "sha256": _sha256(origin / "FakeCode.zip"),
            "license_spdx": "OFL-1.1-no-RFN",
            "rfn": False,
            "rfn_names": [],
            "copyright": "Copyright 2026 The Fake Code Project Authors",
            "license_file": "licenses/OFL-1.1.txt",
            "checksum_source": "self-computed",
        },
        {
            "family": "FakeCJK",
            "variant": "Variable",
            "file": "FakeCJK[wght].ttf",
            "version": "v1.0",
            "upstream_url": (origin / "FakeCJK[wght].ttf").as_uri(),
            "sha256": _sha256(origin / "FakeCJK[wght].ttf"),
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

    recipes = tmp_path / "recipes"
    recipes.mkdir()
    (recipes / "official.yaml").write_text(
        "base:\n"
        "  family: FakeCode\n"
        '  pattern: "FakeCodeNerdFont-*.ttf"\n'
        "donors:\n"
        "  - family: FakeCJK\n"
        "    variant: Variable\n"
        "    instance:\n"
        "      wght: 400\n"
        "rules:\n"
        "  - set: zh_cn\n"
        "    fonts: [donor-0]\n"
        "weights:\n"
        "  - weight: 400\n"
        "output:\n"
        "  family: Fake-Chhsich\n",
        encoding="utf-8",
    )
    community = recipes / "community"
    community.mkdir()
    (community / "community.yaml").write_text(
        "base:\n"
        "  family: FakeCode\n"
        '  pattern: "FakeCodeNerdFont-Regular.ttf"\n'
        "donors:\n"
        "  - family: FakeCJK\n"
        "    variant: Variable\n"
        "output:\n"
        "  family: Fake-Community\n",
        encoding="utf-8",
    )
    return tmp_path


def test_recipes_families_lists_the_union_recursively(
    site: Path, fontalloy_exe: Path
):
    result = run_cli(
        fontalloy_exe, "recipes", "families", "--recipes", "recipes", cwd=site
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == ["FakeCJK", "FakeCode"]


def test_recipes_families_fails_loudly_on_a_broken_recipe(
    site: Path, fontalloy_exe: Path
):
    (site / "recipes" / "broken.yaml").write_text(
        "base:\n  family: FakeCode\n", encoding="utf-8"  # no donors
    )
    result = run_cli(
        fontalloy_exe, "recipes", "families", "--recipes", "recipes", cwd=site
    )
    assert result.returncode == 2
    assert "donors" in result.stderr


def test_assets_fetch_family_downloads_only_that_family(
    site: Path, fontalloy_exe: Path
):
    result = run_cli(
        fontalloy_exe,
        "assets",
        "fetch",
        "--manifest",
        "fonts.manifest.json",
        "--dest",
        "fonts",
        "--family",
        "FakeCJK",
        cwd=site,
    )
    assert result.returncode == 0, result.stderr
    assert (site / "fonts" / "FakeCJK[wght].ttf").is_file()
    assert not (site / "fonts" / "FakeCode.zip").exists()


def test_assets_fetch_recipes_fetches_the_referenced_union(
    site: Path, fontalloy_exe: Path
):
    result = run_cli(
        fontalloy_exe,
        "assets",
        "fetch",
        "--manifest",
        "fonts.manifest.json",
        "--dest",
        "fonts",
        "--recipes",
        "recipes",
        cwd=site,
    )
    assert result.returncode == 0, result.stderr
    assert (site / "fonts" / "FakeCode.zip").is_file()
    assert (site / "fonts" / "FakeCode" / "FakeCodeNerdFont-Regular.ttf").is_file()
    assert (site / "fonts" / "FakeCJK[wght].ttf").is_file()


def test_assets_fetch_rejects_an_unknown_family(
    site: Path, fontalloy_exe: Path
):
    result = run_cli(
        fontalloy_exe,
        "assets",
        "fetch",
        "--manifest",
        "fonts.manifest.json",
        "--dest",
        "fonts",
        "--family",
        "Nope",
        cwd=site,
    )
    assert result.returncode == 2
    assert "unknown family" in result.stderr


def test_assets_notices_family_covers_only_that_family(
    site: Path, fontalloy_exe: Path
):
    result = run_cli(
        fontalloy_exe,
        "assets",
        "notices",
        "--manifest",
        "fonts.manifest.json",
        "--family",
        "FakeCJK",
        "--output",
        "notices.md",
        cwd=site,
    )
    assert result.returncode == 0, result.stderr
    text = (site / "notices.md").read_text(encoding="utf-8")
    assert "FakeCJK" in text
    assert "FakeCode" not in text


def test_assets_notices_recipes_covers_the_referenced_union(
    site: Path, fontalloy_exe: Path
):
    result = run_cli(
        fontalloy_exe,
        "assets",
        "notices",
        "--manifest",
        "fonts.manifest.json",
        "--recipes",
        "recipes",
        "--output",
        "notices.md",
        cwd=site,
    )
    assert result.returncode == 0, result.stderr
    text = (site / "notices.md").read_text(encoding="utf-8")
    assert "FakeCJK" in text and "FakeCode" in text


def test_build_manifest_resolves_catalog_references_end_to_end(
    site: Path, fontalloy_exe: Path
):
    fetch = run_cli(
        fontalloy_exe,
        "assets",
        "fetch",
        "--manifest",
        "fonts.manifest.json",
        "--dest",
        "fonts",
        "--recipes",
        "recipes",
        cwd=site,
    )
    assert fetch.returncode == 0, fetch.stderr
    (site / "build").mkdir()
    result = run_cli(
        fontalloy_exe,
        "build",
        "recipes/official.yaml",
        "--manifest",
        "fonts.manifest.json",
        "--fonts-dir",
        "fonts",
        "--output",
        "build/official.ttf",
        cwd=site,
    )
    assert result.returncode == 0, result.stderr
    assert (site / "build" / "official.ttf").is_file()
    assert (site / "build" / "official.report.json").is_file()
    assert (site / "build" / "official.report.html").is_file()
    report = json.loads(
        (site / "build" / "official.report.json").read_text(encoding="utf-8")
    )
    assert report["schema"] == "fontalloy/verification-report@v2"
    assert [s["id"] for s in report["sources"]] == ["base", "donor-0"]
    assert report["sources"][0]["path"].endswith("FakeCode.zip")


def test_build_reports_the_error_when_assets_are_missing(
    site: Path, fontalloy_exe: Path
):
    result = run_cli(
        fontalloy_exe,
        "build",
        "recipes/official.yaml",
        "--manifest",
        "fonts.manifest.json",
        "--fonts-dir",
        "fonts",
        "--output",
        "build/official.ttf",
        cwd=site,
    )
    assert result.returncode == 2
    assert "assets fetch" in result.stderr


def test_recipes_package_stages_the_release(
    site: Path, fontalloy_exe: Path
):
    fetch = run_cli(
        fontalloy_exe,
        "assets",
        "fetch",
        "--manifest",
        "fonts.manifest.json",
        "--dest",
        "fonts",
        "--recipes",
        "recipes",
        cwd=site,
    )
    assert fetch.returncode == 0, fetch.stderr
    (site / "build").mkdir()
    for stem in ("official", "community"):
        build = run_cli(
            fontalloy_exe,
            "build",
            f"recipes/{'community/community' if stem == 'community' else stem}.yaml",
            "--manifest",
            "fonts.manifest.json",
            "--fonts-dir",
            "fonts",
            "--output",
            f"build/{stem}.ttf",
            cwd=site,
        )
        assert build.returncode == 0, build.stderr
    notices = run_cli(
        fontalloy_exe,
        "assets",
        "notices",
        "--manifest",
        "fonts.manifest.json",
        "--recipes",
        "recipes",
        "--output",
        "dist/THIRD-PARTY-NOTICES.md",
        cwd=site,
    )
    assert notices.returncode == 0, notices.stderr
    result = run_cli(
        fontalloy_exe,
        "recipes",
        "package",
        "recipes/official.yaml",
        "recipes/community/community.yaml",
        "--builds",
        "build",
        "--out",
        "dist",
        "--notices",
        "dist/THIRD-PARTY-NOTICES.md",
        cwd=site,
    )
    assert result.returncode == 0, result.stderr
    dist = site / "dist"
    assert sorted(p.name for p in dist.iterdir()) == [
        "SHA256SUMS",
        "THIRD-PARTY-NOTICES.md",
        "community.zip",
        "official.zip",
    ]
