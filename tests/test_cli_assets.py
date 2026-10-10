"""Seam 2 tests: ``fontalloy assets`` — catalog fetch and notices generation.

Per the testing decisions in issue #1, assets fetch is exercised against a
LOCAL file origin (a tmp directory standing in for upstream releases), so
the suite never touches the network. The manifest fixtures are real
manifest documents with the same schema as the committed catalog.
"""

from __future__ import annotations

import hashlib
import json
import zipfile
from pathlib import Path

import pytest

from conftest import fontalloy_exe, run_cli  # noqa: F401

MANIFEST_SCHEMA = "fontalloy/font-catalog@v1"

FAKE_OFL = (
    "Copyright 2026 The Fake Code Project Authors (example.com)\n\n"
    "This Font Software is licensed under the SIL Open Font License, "
    "Version 1.1.\n"
)


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def entry(
    *,
    family: str,
    file: str,
    url: str,
    sha256: str | None,
    variant: str = "Nerd Font",
    license_spdx: str = "OFL-1.1-RFN",
    rfn: bool = True,
    rfn_names: tuple[str, ...] = (),
    copyright: str | None = "Copyright 2026 The Fake Code Project Authors",
    checksum_source: str = "self-computed",
) -> dict:
    return {
        "family": family,
        "variant": variant,
        "file": file,
        "version": "v1.0",
        "upstream_url": url,
        "sha256": sha256,
        "license_spdx": license_spdx,
        "rfn": rfn,
        "rfn_names": list(rfn_names),
        "copyright": copyright,
        "license_file": "licenses/OFL-1.1.txt",
        "checksum_source": checksum_source,
    }


def write_manifest(path: Path, entries: list[dict]) -> Path:
    path.write_text(
        json.dumps(
            {"schema": MANIFEST_SCHEMA, "families": entries},
            ensure_ascii=False,
            indent=1,
        )
        + "\n",
        encoding="utf-8",
    )
    return path


@pytest.fixture
def local_origin(tmp_path: Path) -> Path:
    """A local stand-in for upstream releases, addressed via file:// URLs.

    Contains one zipped family (with a font face plus a readme that must
    NOT be extracted) and one bare-TTF family. The shared license file the
    manifest references sits beside the manifest, like the committed one.
    """
    origin = tmp_path / "origin"
    origin.mkdir(parents=True)
    licenses = tmp_path / "licenses"
    licenses.mkdir()
    (licenses / "OFL-1.1.txt").write_text(FAKE_OFL, encoding="utf-8")

    face = origin / "FakeCodeNerdFont-Regular.ttf"
    face.write_bytes(b"fake ttf bytes for the zip face")
    with zipfile.ZipFile(origin / "FakeCode.zip", "w") as zf:
        zf.writestr("FakeCodeNerdFont-Regular.ttf", face.read_bytes())
        zf.writestr("readme.md", "not a font; extraction must skip this")
    face.unlink()

    (origin / "FakeCJK-Regular.ttf").write_bytes(b"fake bare ttf bytes")
    return origin


@pytest.fixture
def fetch_manifest(tmp_path: Path, local_origin: Path) -> Path:
    """A two-entry manifest pointing at the local origin."""
    return write_manifest(
        tmp_path / "catalog.json",
        [
            entry(
                family="FakeCode",
                file="FakeCode.zip",
                url=(local_origin / "FakeCode.zip").as_uri(),
                sha256=sha256_of(local_origin / "FakeCode.zip"),
                rfn_names=("Fake Code",),
            ),
            entry(
                family="FakeCJK",
                file="FakeCJK-Regular.ttf",
                variant="",
                url=(local_origin / "FakeCJK-Regular.ttf").as_uri(),
                sha256=sha256_of(local_origin / "FakeCJK-Regular.ttf"),
                license_spdx="OFL-1.1-no-RFN",
                rfn=False,
            ),
        ],
    )


class TestAssetsFetch:
    def test_fetch_downloads_verifies_and_extracts(
        self, fontalloy_exe, fetch_manifest, tmp_path
    ):
        result = run_cli(
            fontalloy_exe,
            "assets",
            "fetch",
            "--manifest",
            fetch_manifest.name,
            "--dest",
            "fonts",
            cwd=tmp_path,
        )

        assert result.returncode == 0, result.stderr
        dest = tmp_path / "fonts"
        # the sha-verified artifacts of record land in the destination
        assert sha256_of(dest / "FakeCode.zip") == sha256_of(
            fetch_manifest.parent / "origin" / "FakeCode.zip"
        )
        assert (dest / "FakeCJK-Regular.ttf").is_file()
        # zip faces are extracted beside the artifact; non-fonts are not
        assert (dest / "FakeCode" / "FakeCodeNerdFont-Regular.ttf").is_file()
        assert not (dest / "FakeCode" / "readme.md").exists()
        assert "FakeCode" in result.stdout
        assert "FakeCJK" in result.stdout

    def test_fetch_rejects_a_sha256_mismatch_loudly(
        self, fontalloy_exe, local_origin, tmp_path
    ):
        manifest = write_manifest(
            tmp_path / "catalog.json",
            [
                entry(
                    family="Tampered",
                    file="FakeCJK-Regular.ttf",
                    url=(local_origin / "FakeCJK-Regular.ttf").as_uri(),
                    sha256="0" * 64,
                )
            ],
        )

        result = run_cli(
            fontalloy_exe,
            "assets",
            "fetch",
            "--manifest",
            manifest.name,
            cwd=tmp_path,
        )

        assert result.returncode != 0
        assert "Tampered" in result.stderr
        assert "sha256" in result.stderr.lower()
        # the unverifiable artifact must not be left in the destination
        assert not (tmp_path / "fonts" / "FakeCJK-Regular.ttf").exists()

    def test_fetch_skips_entries_already_verified(
        self, fontalloy_exe, fetch_manifest, local_origin, tmp_path
    ):
        first = run_cli(
            fontalloy_exe,
            "assets",
            "fetch",
            "--manifest",
            fetch_manifest.name,
            cwd=tmp_path,
        )
        assert first.returncode == 0, first.stderr

        # the origin going away proves the second run downloads nothing
        (local_origin / "FakeCode.zip").unlink()
        second = run_cli(
            fontalloy_exe,
            "assets",
            "fetch",
            "--manifest",
            fetch_manifest.name,
            cwd=tmp_path,
        )

        assert second.returncode == 0, second.stderr
        assert "FakeCode" in second.stdout

    def test_fetch_fails_loudly_when_an_entry_has_no_pinned_checksum(
        self, fontalloy_exe, local_origin, tmp_path
    ):
        manifest = write_manifest(
            tmp_path / "catalog.json",
            [
                entry(
                    family="Pending",
                    file="FakeCJK-Regular.ttf",
                    url=(local_origin / "FakeCJK-Regular.ttf").as_uri(),
                    sha256=None,
                    checksum_source="pending",
                )
            ],
        )

        result = run_cli(
            fontalloy_exe, "assets", "fetch", "--manifest", manifest.name, cwd=tmp_path
        )

        assert result.returncode != 0
        assert "Pending" in result.stderr

    def test_fetch_reports_an_unreachable_origin(
        self, fontalloy_exe, local_origin, tmp_path
    ):
        missing = tmp_path / "origin" / "missing.ttf"
        manifest = write_manifest(
            tmp_path / "catalog.json",
            [
                entry(
                    family="Ghost",
                    file="missing.ttf",
                    url=missing.as_uri(),
                    sha256="0" * 64,
                )
            ],
        )

        result = run_cli(
            fontalloy_exe, "assets", "fetch", "--manifest", manifest.name, cwd=tmp_path
        )

        assert result.returncode != 0
        assert "Ghost" in result.stderr

    def test_fetch_rejects_a_manifest_with_a_malformed_sha256(
        self, fontalloy_exe, local_origin, tmp_path
    ):
        manifest = write_manifest(
            tmp_path / "catalog.json",
            [
                entry(
                    family="BadHash",
                    file="FakeCJK-Regular.ttf",
                    url=(local_origin / "FakeCJK-Regular.ttf").as_uri(),
                    sha256="not-hex",
                )
            ],
        )

        result = run_cli(
            fontalloy_exe, "assets", "fetch", "--manifest", manifest.name, cwd=tmp_path
        )

        assert result.returncode != 0
        assert "BadHash" in result.stderr
        assert "sha256" in result.stderr.lower()

    def test_fetch_rejects_a_manifest_missing_a_required_field(
        self, fontalloy_exe, tmp_path
    ):
        manifest = write_manifest(
            tmp_path / "catalog.json",
            [
                {
                    "family": "NoLicense",
                    "variant": "",
                    "file": "x.ttf",
                    "version": "v1",
                    "upstream_url": "https://example.com/x.ttf",
                    "sha256": "0" * 64,
                    "rfn": False,
                }
            ],
        )

        result = run_cli(
            fontalloy_exe, "assets", "fetch", "--manifest", manifest.name, cwd=tmp_path
        )

        assert result.returncode != 0
        assert "license_spdx" in result.stderr

    def test_fetch_rejects_a_manifest_with_a_broken_license_file_reference(
        self, fontalloy_exe, local_origin, tmp_path
    ):
        manifest = write_manifest(
            tmp_path / "catalog.json",
            [
                entry(
                    family="NoLicenseFile",
                    file="FakeCJK-Regular.ttf",
                    url=(local_origin / "FakeCJK-Regular.ttf").as_uri(),
                    sha256=sha256_of(local_origin / "FakeCJK-Regular.ttf"),
                )
            ],
        )
        manifest.write_text(
            manifest.read_text(encoding="utf-8").replace(
                "licenses/OFL-1.1.txt", "licenses/gone.txt"
            ),
            encoding="utf-8",
        )

        result = run_cli(
            fontalloy_exe, "assets", "fetch", "--manifest", manifest.name, cwd=tmp_path
        )

        assert result.returncode != 0
        assert "gone.txt" in result.stderr


class TestAssetsNotices:
    def test_notices_generate_from_the_manifest(
        self, fontalloy_exe, fetch_manifest, tmp_path
    ):
        result = run_cli(
            fontalloy_exe,
            "assets",
            "notices",
            "--manifest",
            fetch_manifest.name,
            cwd=tmp_path,
        )

        assert result.returncode == 0, result.stderr
        notices = tmp_path / "THIRD-PARTY-NOTICES.md"
        text = notices.read_text(encoding="utf-8")
        # per-family blocks: family, copyright, license, upstream pin
        assert "FakeCode" in text
        assert "Copyright 2026 The Fake Code Project Authors" in text
        assert "OFL-1.1-RFN" in text
        assert (fetch_manifest.parent / "origin" / "FakeCode.zip").as_uri() in text
        assert "v1.0" in text
        # RFN families carry the merged-output naming warning with their names
        assert "Reserved Font Name" in text
        assert "Fake Code" in text
        # the full license text travels with the notices
        assert "SIL Open Font License, Version 1.1" in text
        # regenerated output is byte-identical (no timestamps, stable order)
        first = notices.read_bytes()
        rerun = run_cli(
            fontalloy_exe,
            "assets",
            "notices",
            "--manifest",
            fetch_manifest.name,
            cwd=tmp_path,
        )
        assert rerun.returncode == 0, rerun.stderr
        assert notices.read_bytes() == first

    def test_notices_honor_the_output_option(
        self, fontalloy_exe, fetch_manifest, tmp_path
    ):
        result = run_cli(
            fontalloy_exe,
            "assets",
            "notices",
            "--manifest",
            fetch_manifest.name,
            "--output",
            "NOTICES.md",
            cwd=tmp_path,
        )

        assert result.returncode == 0, result.stderr
        assert (tmp_path / "NOTICES.md").is_file()
        assert not (tmp_path / "THIRD-PARTY-NOTICES.md").exists()
