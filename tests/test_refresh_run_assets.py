"""The run-assets refresh tool (spec #25's final batch, ticket #37).

The journeys' ``FONTALLOY_RUN_ASSETS`` layout at ``fontalloy-run``
predates the typed-axes manifest schema, so ``variant_cuts`` collapses
multi-cut families (MapleMono NF/NF-CN) and J11.3's chip never renders.
The refresh tool materializes a NEW layout from the CURRENT manifest,
reusing the old layout's already-verified bytes (no re-download of what
the pins never moved) — these tests pin that contract at tiny-fixture
scale: reuse never touches the network, only genuine gaps download,
the output carries the current manifest + its licenses, and the source
is read-only throughout.
"""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import zipfile
from pathlib import Path
from types import ModuleType

import pytest

from fontalloy_core.catalog import load_manifest

REPO_ROOT = Path(__file__).resolve().parent.parent
TOOL_PATH = REPO_ROOT / "scripts" / "refresh_run_assets.py"

FAKE_OFL = "Fake OFL 1.1 license text for the run-assets refresh.\n"


def load_tool() -> ModuleType:
    """Import scripts/refresh_run_assets.py (not a package member)."""
    spec = importlib.util.spec_from_file_location("refresh_run_assets", TOOL_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha_of(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def zip_of(members: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        for name, payload in members.items():
            zf.writestr(name, payload)
    return buffer.getvalue()


def write_manifest(path: Path, entries: list[dict]) -> Path:
    path.write_text(
        json.dumps({"schema": "fontalloy/font-catalog@v1", "families": entries}, indent=1),
        encoding="utf-8",
    )
    return path


def make_entry(
    *,
    family: str,
    file: str,
    sha: str,
    url: str,
    axes: dict | None = None,
    variant: str = "Nerd Font",
) -> dict:
    return {
        "family": family,
        "variant": variant,
        "file": file,
        "version": "v1",
        "upstream_url": url,
        "sha256": sha,
        "license_spdx": "OFL-1.1",
        "rfn": False,
        "rfn_names": [],
        "copyright": None,
        "license_file": "licenses/OFL-1.1.txt",
        "checksum_source": "self-computed",
        **({} if axes is None else {"axes": axes}),
    }


class TestRefreshRunAssets:
    def test_reuses_cached_bytes_downloads_only_gaps(self, tmp_path: Path):
        tool = load_tool()
        # The CURRENT manifest: MapleMono NF (artifact already in the old
        # layout) + NF-CN (a genuine gap, fetchable from a file:// origin).
        nf_zip = zip_of({"MapleMono-NF-Regular.ttf": b"fake nf regular"})
        nfcn_zip = zip_of({"MapleMono-NF-CN-Regular.ttf": b"fake nfcn regular"})
        origin = tmp_path / "origin"
        origin.mkdir()
        (origin / "MapleMono-NF-CN.zip").write_bytes(nfcn_zip)

        current = tmp_path / "current"
        (current / "licenses").mkdir(parents=True)
        (current / "licenses" / "OFL-1.1.txt").write_text(FAKE_OFL, encoding="utf-8")
        manifest = write_manifest(
            current / "fonts.manifest.json",
            [
                make_entry(
                    family="MapleMono",
                    file="MapleMono-NF.zip",
                    sha=sha_of(nf_zip),
                    # Unroutable: reuse must never touch this URL.
                    url="file:///nowhere-at-all/MapleMono-NF.zip",
                    axes={"icons": "nf"},
                    variant="NF",
                ),
                make_entry(
                    family="MapleMono",
                    file="MapleMono-NF-CN.zip",
                    sha=sha_of(nfcn_zip),
                    url=(origin / "MapleMono-NF-CN.zip").as_uri(),
                    axes={"icons": "nf", "region": "SC"},
                    variant="NF-CN",
                ),
            ],
        )

        # The OLD layout: the NF artifact (pin unchanged) + a stale
        # 8ec6223-era manifest (no axes) the tool must ignore.
        source = tmp_path / "old-run" / "assets"
        (source / "fonts").mkdir(parents=True)
        (source / "fonts" / "MapleMono-NF.zip").write_bytes(nf_zip)
        write_manifest(
            source / "fonts.manifest.json",
            [
                make_entry(
                    family="MapleMono",
                    file="MapleMono-NF.zip",
                    sha=sha_of(nf_zip),
                    url="https://example.invalid/MapleMono-NF.zip",
                )
            ],
        )
        source_before = sorted(
            (p.relative_to(source), p.read_bytes())
            for p in source.rglob("*")
            if p.is_file()
        )

        output = tmp_path / "fresh-run-assets"
        summary = tool.refresh_run_assets(
            source=source, output=output, manifest_path=manifest
        )

        # The output manifest IS the current (typed-axes) manifest.
        assert (
            output / "fonts.manifest.json"
        ).read_bytes() == manifest.read_bytes()
        catalog = load_manifest(output / "fonts.manifest.json")
        # The typed axes ride through verbatim — the whole point of the
        # refresh (the old layout's manifest lacked them, collapsing the
        # cuts in variant_cuts).
        assert {e.file: dict(e.axes) for e in catalog.entries} == {
            "MapleMono-NF.zip": {"icons": "nf"},
            "MapleMono-NF-CN.zip": {"icons": "nf", "region": "SC"},
        }
        # Reuse: the NF artifact was COPIED, not downloaded (its URL is
        # unroutable — a download attempt would have failed the run).
        assert (output / "fonts" / "MapleMono-NF.zip").read_bytes() == nf_zip
        assert summary["reused"] == 1
        assert summary["downloaded"] == 1
        # The gap downloaded from the file:// origin and extracted its faces.
        assert (output / "fonts" / "MapleMono-NF-CN.zip").is_file()
        assert (output / "fonts" / "MapleMono-NF-CN" / "MapleMono-NF-CN-Regular.ttf").is_file()
        # The current manifest's license tree rides along.
        assert (output / "licenses" / "OFL-1.1.txt").read_text(encoding="utf-8") == FAKE_OFL
        # The source layout is byte-for-byte untouched.
        source_after = sorted(
            (p.relative_to(source), p.read_bytes())
            for p in source.rglob("*")
            if p.is_file()
        )
        assert source_after == source_before

    def test_offline_reports_gaps_instead_of_downloading(self, tmp_path: Path):
        tool = load_tool()
        nf_zip = zip_of({"MapleMono-NF-Regular.ttf": b"fake nf regular"})
        current = tmp_path / "current"
        (current / "licenses").mkdir(parents=True)
        (current / "licenses" / "OFL-1.1.txt").write_text(FAKE_OFL, encoding="utf-8")
        manifest = write_manifest(
            current / "fonts.manifest.json",
            [
                make_entry(
                    family="MapleMono",
                    file="MapleMono-NF.zip",
                    sha=sha_of(nf_zip),
                    url="file:///nowhere-at-all/MapleMono-NF.zip",
                ),
                make_entry(
                    family="GhostFamily",
                    file="Ghost.zip",
                    sha="0" * 64,
                    url="file:///nowhere-at-all/Ghost.zip",
                ),
            ],
        )
        source = tmp_path / "old-run" / "assets"
        (source / "fonts").mkdir(parents=True)
        (source / "fonts" / "MapleMono-NF.zip").write_bytes(nf_zip)
        output = tmp_path / "audit-output"

        with pytest.raises(SystemExit) as excinfo:
            tool.main(
                [
                    "--source",
                    str(source),
                    "--output",
                    str(output),
                    "--manifest",
                    str(manifest),
                    "--offline",
                ]
            )
        assert excinfo.value.code == 2
        # The audit names the gap and downloads nothing: the reused
        # artifact landed, the gap did not.
        assert (output / "fonts" / "MapleMono-NF.zip").is_file()
        assert not (output / "fonts" / "Ghost.zip").exists()

    def test_refuses_unsafe_outputs(self, tmp_path: Path):
        tool = load_tool()
        source = tmp_path / "old-run" / "assets"
        (source / "fonts").mkdir(parents=True)
        manifest = write_manifest(tmp_path / "m.json", [])
        # Output inside the source layout: refused.
        with pytest.raises(ValueError, match="overlap the source"):
            tool.refresh_run_assets(
                source=source,
                output=source / "nested-output",
                manifest_path=manifest,
            )
        # Non-empty output: refused (a refresh writes a NEW directory).
        occupied = tmp_path / "occupied"
        occupied.mkdir()
        (occupied / "stale.txt").write_text("x", encoding="utf-8")
        with pytest.raises(ValueError, match="empty"):
            tool.refresh_run_assets(
                source=source, output=occupied, manifest_path=manifest
            )
