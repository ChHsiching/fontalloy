"""Seam 2 tests: ``fontalloy assets package`` — the CI catalog-release job.

The release job's local steps (repackage per-family zips, write
SHA256SUMS, render catalog-release metadata) run offline against a tiny
local manifest fetched from a ``file://`` origin, the same way the CI
workflow runs them against the committed catalog. The live
upload-to-Release step is CI-side and cannot run here.
"""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

from conftest import fontalloy_exe, run_cli  # noqa: F401
from fontalloy_core import load_catalog_release
from test_cli_assets import FAKE_OFL, entry, sha256_of, write_manifest

#: Fixed zip member timestamp (2026-01-01, matching the fixture fonts):
#: packaging carries no wall clock, so it is byte-reproducible.
FIXED_ZIP_TIMESTAMP = (2026, 1, 1, 0, 0, 0)

LIGHT_FACE = b"fake lxgw light ttf bytes"
REGULAR_FACE = b"fake lxgw regular ttf bytes"
NF_FACE = b"fake nerd font ttf bytes"


def make_catalog(tmp_path: Path) -> Path:
    """A local origin plus a three-entry, two-family manifest.

    ``FakeCode`` is a zip artifact (with a readme that must not reach the
    release zip); ``LXGWTest`` is one family pinned as two bare-TTF
    entries, proving per-family grouping of multi-entry families.
    """
    origin = tmp_path / "origin"
    origin.mkdir(parents=True)
    licenses = tmp_path / "licenses"
    licenses.mkdir()
    (licenses / "OFL-1.1.txt").write_text(FAKE_OFL, encoding="utf-8")

    (origin / "FakeCode.zip").write_bytes(_zip_of({"FakeCodeNerdFont-Regular.ttf": NF_FACE, "readme.md": b"skip me"}))
    (origin / "LXGWTest-Light.ttf").write_bytes(LIGHT_FACE)
    (origin / "LXGWTest-Regular.ttf").write_bytes(REGULAR_FACE)

    return write_manifest(
        tmp_path / "catalog.json",
        [
            entry(
                family="FakeCode",
                file="FakeCode.zip",
                url=(origin / "FakeCode.zip").as_uri(),
                sha256=sha256_of(origin / "FakeCode.zip"),
            ),
            entry(
                family="LXGWTest",
                file="LXGWTest-Light.ttf",
                variant="Light",
                url=(origin / "LXGWTest-Light.ttf").as_uri(),
                sha256=sha256_of(origin / "LXGWTest-Light.ttf"),
            ),
            entry(
                family="LXGWTest",
                file="LXGWTest-Regular.ttf",
                variant="Regular",
                url=(origin / "LXGWTest-Regular.ttf").as_uri(),
                sha256=sha256_of(origin / "LXGWTest-Regular.ttf"),
            ),
        ],
    )


def _zip_of(members: dict[str, bytes]) -> bytes:
    import io

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        for name, payload in members.items():
            zf.writestr(name, payload)
    return buffer.getvalue()


def fetch_and_package(fontalloy_exe, tmp_path: Path, *, out: str = "dist") -> object:
    """The workflow's local chain: fetch, notices, then package."""
    manifest = make_catalog(tmp_path)
    for args in (
        ("assets", "fetch", "--manifest", manifest.name),
        ("assets", "notices", "--manifest", manifest.name, "--output", f"{out}/THIRD-PARTY-NOTICES.md"),
        (
            "assets",
            "package",
            "--manifest",
            manifest.name,
            "--out",
            out,
            "--repo",
            "ChHsiching/fontalloy",
            "--tag",
            "font-catalog-v1",
            "--include",
            f"{out}/THIRD-PARTY-NOTICES.md",
            "--extra-origin",
            "china-mirror=https://mirror.example.com/fontalloy/v1",
        ),
    ):
        result = run_cli(fontalloy_exe, *args, cwd=tmp_path)
        assert result.returncode == 0, f"{args}: {result.stderr}"
    return result


class TestAssetsPackage:
    def test_package_builds_per_family_zips_checksums_and_metadata(
        self, fontalloy_exe, tmp_path
    ):
        fetch_and_package(fontalloy_exe, tmp_path)
        dist = tmp_path / "dist"

        # one variant-addressable zip per family (multi-entry families group)
        assert sorted(p.name for p in dist.iterdir()) == [
            "FakeCode.zip",
            "LXGWTest.zip",
            "SHA256SUMS",
            "THIRD-PARTY-NOTICES.md",
            "catalog-release.json",
        ]

        # SHA256SUMS covers every attached artifact, sha256sum -c format
        sums = {}
        for line in (dist / "SHA256SUMS").read_text(encoding="utf-8").splitlines():
            digest, name = line.split("  ", 1)
            sums[name] = digest
        assert set(sums) == {
            "FakeCode.zip",
            "LXGWTest.zip",
            "THIRD-PARTY-NOTICES.md",
            "catalog-release.json",
        }
        for name, digest in sums.items():
            assert digest == sha256_of(dist / name), name

        # metadata parses through the public contract and round-trips origins
        release = load_catalog_release(dist / "catalog-release.json")
        assert release.tag == "font-catalog-v1"
        assert [(o.id, o.base_url) for o in release.origins] == [
            (
                "github-releases",
                "https://github.com/ChHsiching/fontalloy/releases/download/font-catalog-v1",
            ),
            ("china-mirror", "https://mirror.example.com/fontalloy/v1"),
        ]
        families = {f.family: f for f in release.families}
        assert set(families) == {"FakeCode", "LXGWTest"}
        # each family's zip checksum matches the artifact on disk
        for family in families.values():
            assert family.sha256 == sha256_of(dist / family.zip)
        light = families["LXGWTest"].files
        assert {f.file: f.sha256 for f in light} == {
            "LXGWTest-Light.ttf": sha256_of_bytes(LIGHT_FACE),
            "LXGWTest-Regular.ttf": sha256_of_bytes(REGULAR_FACE),
        }
        assert [f.file for f in families["FakeCode"].files] == [
            "FakeCodeNerdFont-Regular.ttf"
        ]

        # zip contents: every face plus the license file, never a readme
        with zipfile.ZipFile(dist / "LXGWTest.zip") as zf:
            assert zf.namelist() == [
                "LXGWTest-Light.ttf",
                "LXGWTest-Regular.ttf",
                "OFL-1.1.txt",
            ]
            assert zf.read("LXGWTest-Light.ttf") == LIGHT_FACE
            # the license file travels byte-for-byte as committed
            assert zf.read("OFL-1.1.txt") == (tmp_path / "licenses" / "OFL-1.1.txt").read_bytes()
            assert all(
                info.date_time == FIXED_ZIP_TIMESTAMP for info in zf.infolist()
            )
        with zipfile.ZipFile(dist / "FakeCode.zip") as zf:
            assert zf.namelist() == [
                "FakeCodeNerdFont-Regular.ttf",
                "OFL-1.1.txt",
            ]

    def test_packaging_is_byte_reproducible(self, fontalloy_exe, tmp_path):
        make_catalog(tmp_path)
        assert run_cli(fontalloy_exe, "assets", "fetch", "--manifest", "catalog.json", cwd=tmp_path).returncode == 0
        for out in ("dist-a", "dist-b"):
            result = run_cli(
                fontalloy_exe,
                "assets",
                "package",
                "--manifest",
                "catalog.json",
                "--out",
                out,
                cwd=tmp_path,
            )
            assert result.returncode == 0, result.stderr

        produced_a = sorted(p.name for p in (tmp_path / "dist-a").iterdir())
        produced_b = sorted(p.name for p in (tmp_path / "dist-b").iterdir())
        assert produced_a == produced_b == ["FakeCode.zip", "LXGWTest.zip", "SHA256SUMS", "catalog-release.json"]
        for name in produced_a:
            assert (tmp_path / "dist-a" / name).read_bytes() == (tmp_path / "dist-b" / name).read_bytes(), name

    def test_package_fails_loudly_when_the_catalog_was_never_fetched(
        self, fontalloy_exe, tmp_path
    ):
        make_catalog(tmp_path)

        result = run_cli(
            fontalloy_exe, "assets", "package", "--manifest", "catalog.json", cwd=tmp_path
        )

        assert result.returncode == 2
        assert "FakeCode" in result.stderr
        assert "fetch" in result.stderr
        assert not (tmp_path / "fonts" / "FakeCode.zip").exists()


def sha256_of_bytes(payload: bytes) -> str:
    import hashlib

    return hashlib.sha256(payload).hexdigest()
