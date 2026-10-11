"""Recipe-release packaging (issue #23).

``package_recipe_release`` stages what CI attaches to the storefront
release: one self-contained zip per recipe (font + both report forms +
notices), a SHA256SUMS covering everything, no wall clock anywhere —
so the same builds stage identical bytes on any machine.
"""

from __future__ import annotations

import zipfile
from pathlib import Path

import pytest

from conftest import base_font, donor_font, run_cli  # noqa: F401

from fontalloy_core.errors import ReleaseError
from fontalloy_core.recipe_release import package_recipe_release

NOTICES = "# Third-party notices (fixture)\n"


def _build(
    exe: Path, recipe: Path, out: Path, cwd: Path
) -> subprocess.CompletedProcess[str]:
    return run_cli(exe, "build", str(recipe), "--output", str(out), cwd=cwd)


@pytest.fixture
def built_pair(
    tmp_path: Path,
    base_font: Path,  # noqa: F401
    donor_font: Path,  # noqa: F401
    fontalloy_exe: Path,
) -> Path:
    """A builds directory holding two finished recipe builds."""
    builds = tmp_path / "build"
    builds.mkdir()
    recipe = tmp_path / "one.yaml"
    recipe.write_text(
        f"base: {base_font.name}\ndonors:\n  - {donor_font.name}\n",
        encoding="utf-8",
    )
    two = tmp_path / "two.yaml"
    two.write_text(
        f"base: {base_font.name}\ndonors:\n  - {donor_font.name}\n",
        encoding="utf-8",
    )
    for stem in ("one", "two"):
        result = _build(fontalloy_exe, tmp_path / f"{stem}.yaml", builds / f"{stem}.ttf", cwd=tmp_path)
        assert result.returncode == 0, result.stderr
    notices = tmp_path / "THIRD-PARTY-NOTICES.md"
    notices.write_text(NOTICES, encoding="utf-8")
    return builds


def test_packaging_writes_one_self_contained_zip_per_recipe(
    tmp_path: Path, built_pair: Path
):
    import hashlib

    notices = built_pair.parent / "THIRD-PARTY-NOTICES.md"
    out = tmp_path / "dist"
    package = package_recipe_release(
        [built_pair.parent / "one.yaml", built_pair.parent / "two.yaml"],
        built_pair,
        out,
        notices=notices,
    )
    assert package.recipes == 2
    assert sorted(p.name for p in out.iterdir()) == [
        "SHA256SUMS",
        "THIRD-PARTY-NOTICES.md",
        "one.zip",
        "two.zip",
    ]
    with zipfile.ZipFile(out / "one.zip") as zf:
        assert zf.namelist() == [
            "THIRD-PARTY-NOTICES.md",
            "one.report.html",
            "one.report.json",
            "one.ttf",
        ]
    # The sums file is sha256sum -c format and verifies, staged names only.
    staged = {p.name for p in out.iterdir()}
    for line in (out / "SHA256SUMS").read_text(encoding="utf-8").splitlines():
        digest, name = line.split("  ", 1)
        assert name in staged - {"SHA256SUMS"}
        assert hashlib.sha256((out / name).read_bytes()).hexdigest() == digest


def test_packaging_is_byte_reproducible(tmp_path: Path, built_pair: Path):
    notices = built_pair.parent / "THIRD-PARTY-NOTICES.md"
    recipes = [built_pair.parent / "one.yaml"]
    first = tmp_path / "dist1"
    second = tmp_path / "dist2"
    package_recipe_release(recipes, built_pair, first, notices=notices)
    package_recipe_release(recipes, built_pair, second, notices=notices)
    for name in ("one.zip", "SHA256SUMS", "THIRD-PARTY-NOTICES.md"):
        assert (first / name).read_bytes() == (second / name).read_bytes(), name


def test_packaging_without_a_build_names_the_recipe(tmp_path: Path, built_pair: Path):
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(ReleaseError, match="no built font"):
        package_recipe_release(
            [built_pair.parent / "one.yaml"], empty, tmp_path / "dist"
        )


def test_packaging_without_reports_names_what_is_missing(
    tmp_path: Path, built_pair: Path
):
    (built_pair / "one.report.json").unlink()
    with pytest.raises(ReleaseError, match="one.report.json"):
        package_recipe_release(
            [built_pair.parent / "one.yaml"],
            built_pair,
            tmp_path / "dist",
        )


def test_packaging_rejects_colliding_built_formats(
    tmp_path: Path, built_pair: Path
):
    (built_pair / "one.ttc").write_bytes(b"pretend ttc")
    with pytest.raises(ReleaseError, match="collide"):
        package_recipe_release(
            [built_pair.parent / "one.yaml"], built_pair, tmp_path / "dist"
        )


def test_packaging_requires_a_recipe(tmp_path: Path, built_pair: Path):
    with pytest.raises(ReleaseError, match="at least one recipe"):
        package_recipe_release([], built_pair, tmp_path / "dist")
