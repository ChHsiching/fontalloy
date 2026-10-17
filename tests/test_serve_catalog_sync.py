"""Seam 2 tests: the serve-side catalog sync lifecycle (issue #26).

The serve owns the catalog (spec #25): at startup — and on
``POST /catalog/sync`` — it loads the catalog release document, fills
the configured cache directory with every family (streaming sha256-
verified downloads through the ordered origin list, zip AND 7z
extraction with per-face parse validation), writes complete markers
only after full validation, and heals corrupt or partial families on
later runs. Everything here is asserted the way the frontends see it:
the real ``fontalloy`` executable as a subprocess, real HTTP, and the
on-disk outcomes — never the sync service's internals.

The origins are local directories addressed via ``file://`` URLs (the
offline-suite convention of the assets suites); the faces inside the
family archives are real synthetic fonts, because extraction
parse-validates every face.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import time
import zipfile
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import py7zr
import pytest

from conftest import fontalloy_exe, synth_font  # noqa: F401
from test_cli_serve import running_service

RELEASE_SCHEMA = "fontalloy/catalog-release@v1"
TAG = "font-catalog-v1"

#: Stretch the sync's per-family yield so a run observably spans
#: seconds — the responsiveness test needs /health and /catalog/status
#: to answer INSIDE a run, deterministically (the system-fonts suite's
#: delay-seam trick).
SYNC_DELAY_ENV = "FONTALLOY_CATALOG_SYNC_DELAY"


def _sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


@dataclass
class FamilySpec:
    """One family of the fixture release: its archive name and faces."""

    family: str
    archive: str  # bare filename, ".zip" or ".7z"
    faces: dict[str, bytes] = field(default_factory=dict)


@dataclass
class CatalogSite:
    """A local catalog-release origin addressed via file:// URLs."""

    origin_dir: Path
    families: list[FamilySpec]
    origins: list[dict[str, str]] = field(default_factory=list)

    @property
    def release_origin(self) -> str:
        """The base URL serving the release DOCUMENT (the primary —
        family archives fall back through the whole ordered list)."""
        for origin in self.origins:
            if origin["id"] == "primary":
                return origin["base_url"]
        raise AssertionError("the site's document was written without a primary origin")

    def spec(self, family: str) -> FamilySpec:
        for spec in self.families:
            if spec.family == family:
                return spec
        raise KeyError(family)

    def withhold(self) -> None:
        """Remove every family archive (the doc stays): all origins fail."""
        for spec in self.families:
            (self.origin_dir / spec.archive).unlink()


def build_site(
    root: Path,
    *,
    families: list[tuple[str, str]],
    extra_origins: list[Path] = (),
) -> CatalogSite:
    """Build a catalog-release origin with real font faces in archives.

    ``families`` pairs (family name, archive suffix) — ".zip" and ".7z"
    both exercised. ``extra_origins`` prepend EMPTY directories before
    the serving origin (dead-first and stale-first fallback orders are
    built by the caller writing bytes into them).
    """
    origin_dir = root / "origin"
    origin_dir.mkdir(parents=True)
    staging = root / "staging"
    staging.mkdir()

    specs: list[FamilySpec] = []
    for family, suffix in families:
        spec = FamilySpec(family=family, archive=f"{family}{suffix}")
        for weight, style in ((400, "Regular"), (700, "Bold")):
            face_path = staging / f"{family}-{style}.ttf"
            synth_font(
                face_path,
                family=family,
                # Bold covers one codepoint further out, so a restored
                # face is distinguishable from a stale one by bytes.
                codepoints=(0x41 + (weight == 700), 0x4E2D),
                weight=weight,
            )
            spec.faces[face_path.name] = face_path.read_bytes()
        # A non-font member: extraction must skip it (the assets rule).
        (staging / "readme.md").write_text(
            "not a font; extraction must skip this", encoding="utf-8"
        )
        archive_path = origin_dir / spec.archive
        if suffix == ".7z":
            with py7zr.SevenZipFile(archive_path, "w") as sz:
                sz.writeall(staging, family)
        else:
            with zipfile.ZipFile(archive_path, "w") as zf:
                for name, payload in spec.faces.items():
                    zf.writestr(f"{family}/{name}", payload)
                zf.writestr(
                    f"{family}/readme.md",
                    (staging / "readme.md").read_text(encoding="utf-8"),
                )
        specs.append(spec)
        # staging is reused per family; drop the per-family members.
        for member in staging.iterdir():
            member.unlink()

    origins: list[dict[str, str]] = [
        {"id": f"extra-{index}", "base_url": directory.as_uri()}
        for index, directory in enumerate(extra_origins)
    ]
    origins.append({"id": "primary", "base_url": origin_dir.as_uri()})

    document = {
        "schema": RELEASE_SCHEMA,
        "tag": TAG,
        "origins": origins,
        "families": [
            {
                "family": spec.family,
                "zip": spec.archive,
                "sha256": _sha256_bytes((origin_dir / spec.archive).read_bytes()),
                "files": [
                    {"file": name, "sha256": _sha256_bytes(payload)}
                    for name, payload in sorted(spec.faces.items())
                ],
            }
            for spec in specs
        ],
    }
    (origin_dir / "catalog-release.json").write_text(
        json.dumps(document, indent=1) + "\n", encoding="utf-8"
    )
    return CatalogSite(origin_dir=origin_dir, families=specs, origins=origins)


def sync_args(release_origin: str, catalog_dir: Path, work_dir: Path) -> list[str]:
    """Serve arguments activating the catalog sync for one origin."""
    return [
        "--port",
        "0",
        "--catalog-release-origin",
        release_origin,
        "--catalog-dir",
        str(catalog_dir),
        "--work-dir",
        str(work_dir),
    ]


def wait_for_terminal(client, timeout: float = 60.0) -> dict[str, Any]:
    """Poll /catalog/status until the state machine settles."""
    deadline = time.monotonic() + timeout
    last: dict[str, Any] = {}
    while time.monotonic() < deadline:
        last = client.get("/catalog/status").json()
        if last["state"] in ("ready", "unavailable"):
            return last
        time.sleep(0.02)
    raise TimeoutError(f"catalog sync never settled: {last}")


@pytest.fixture
def work_dir(tmp_path: Path) -> Path:
    work = tmp_path / "work"
    work.mkdir()
    return work


@pytest.fixture
def catalog_dir(tmp_path: Path) -> Path:
    return tmp_path / "catalog"


@pytest.fixture
def site(tmp_path: Path) -> CatalogSite:
    """Three families: two zip, one 7z — both archive formats synced."""
    return build_site(
        tmp_path,
        families=[("FakeCode", ".zip"), ("FakeBright", ".7z"), ("FakeMono", ".zip")],
    )


@pytest.fixture
def plain_service(fontalloy_exe, work_dir, tmp_path) -> Iterator[Any]:
    """A serve with no catalog sync configured (local-fonts-only)."""
    with running_service(
        fontalloy_exe, ["--port", "0", "--work-dir", str(work_dir)], cwd=tmp_path
    ) as (client, _):
        yield client


class TestStatusContract:
    """GET /catalog/status — the state machine any frontend polls."""

    def test_unconfigured_serve_reports_a_quiescent_catalog(self, plain_service):
        response = plain_service.get("/catalog/status")
        assert response.status == 200
        doc = response.json()
        assert doc == {
            "state": "ready",
            "configured": False,
            "error": None,
            "tag": None,
            "catalog_dir": None,
            "families": [],
        }

    def test_a_half_configured_sync_is_unavailable_with_a_clear_error(
        self, fontalloy_exe, work_dir, tmp_path
    ):
        """The origin and the cache directory activate the sync together;
        naming only one is a configuration error the picker can show."""
        site = build_site(tmp_path / "site", families=[("FakeCode", ".zip")])
        with running_service(
            fontalloy_exe,
            [
                "--port",
                "0",
                "--catalog-release-origin",
                site.release_origin,
                "--work-dir",
                str(work_dir),
            ],
            cwd=tmp_path,
        ) as (client, _):
            doc = wait_for_terminal(client)
            assert doc["state"] == "unavailable"
            assert "--catalog-dir" in doc["error"]
            assert doc["families"] == []

    def test_catalog_status_rejects_non_get(self, plain_service):
        response = plain_service.request("PUT", "/catalog/status")
        assert response.status == 405
        assert "GET" in response.headers.get("Allow", "")

    def test_catalog_sync_rejects_non_post(self, plain_service):
        response = plain_service.get("/catalog/sync")
        assert response.status == 405
        assert "POST" in response.headers.get("Allow", "")


class TestStartupSync:
    def test_startup_sync_downloads_extracts_and_marks_complete(
        self, fontalloy_exe, site, catalog_dir, work_dir, tmp_path
    ):
        with running_service(
            fontalloy_exe,
            sync_args(site.release_origin, catalog_dir, work_dir),
            cwd=tmp_path,
        ) as (client, _):
            doc = wait_for_terminal(client)
            assert doc["state"] == "ready", doc.get("error")
            assert doc["configured"] is True
            assert doc["error"] is None
            assert doc["tag"] == TAG
            progress = {entry["family"]: entry for entry in doc["families"]}
            assert set(progress) == {"FakeCode", "FakeBright", "FakeMono"}
            for entry in progress.values():
                assert entry["state"] == "done"
                assert entry["error"] is None

        # On-disk outcomes: verified archives, extracted faces, markers.
        for spec in site.families:
            archive = catalog_dir / spec.archive
            assert archive.is_file(), archive
            assert _sha256_bytes(archive.read_bytes()) == _sha256_bytes(
                (site.origin_dir / spec.archive).read_bytes()
            )
            extracted = catalog_dir / spec.family
            for name, payload in spec.faces.items():
                assert (extracted / name).read_bytes() == payload
            assert not (extracted / "readme.md").exists()
            marker = catalog_dir / (spec.archive + ".complete")
            assert marker.read_text(encoding="utf-8").strip() == TAG
        assert list(catalog_dir.glob("*.part")) == []

    def test_health_and_status_answer_while_the_sync_runs(
        self, fontalloy_exe, site, catalog_dir, work_dir, tmp_path
    ):
        """The sync runs on its own thread; request handlers never wait
        on it (the round-25 starvation lesson). With the per-family
        yield stretched, the run spans seconds — /health and
        /catalog/status must answer well inside it, and the state
        machine must be observably ``bootstrapping`` mid-run.
        """
        os.environ[SYNC_DELAY_ENV] = "0.3"  # 3 families -> a >=0.9s run
        try:
            with running_service(
                fontalloy_exe,
                sync_args(site.release_origin, catalog_dir, work_dir),
                cwd=tmp_path,
            ) as (client, _):
                saw_bootstrapping = False
                deadline = time.monotonic() + 30
                while time.monotonic() < deadline:
                    started = time.monotonic()
                    doc = client.get("/catalog/status").json()
                    elapsed = time.monotonic() - started
                    assert elapsed < 1.0, (
                        f"/catalog/status took {elapsed:.2f}s mid-sync"
                    )
                    if doc["state"] == "bootstrapping":
                        saw_bootstrapping = True
                        started = time.monotonic()
                        health = client.get("/health").json()
                        elapsed = time.monotonic() - started
                        assert health["service"] == "fontalloy"
                        assert elapsed < 1.0, f"/health took {elapsed:.2f}s mid-sync"
                    if doc["state"] in ("ready", "unavailable"):
                        break
                assert saw_bootstrapping, "the sync settled before any poll saw it run"
                doc = wait_for_terminal(client)
                assert doc["state"] == "ready", doc.get("error")
        finally:
            os.environ.pop(SYNC_DELAY_ENV, None)

    def test_post_sync_rechecks_and_repairs_corrupt_families(
        self, fontalloy_exe, site, catalog_dir, work_dir, tmp_path
    ):
        with running_service(
            fontalloy_exe,
            sync_args(site.release_origin, catalog_dir, work_dir),
            cwd=tmp_path,
        ) as (client, _):
            wait_for_terminal(client)

            # A corrupted face with the serve still running: the on-demand
            # sync must re-extract it from the verified archive.
            face = catalog_dir / "FakeCode" / "FakeCode-Regular.ttf"
            face.write_bytes(b"corrupted mid-run")
            response = client.post("/catalog/sync", {})
            assert response.status == 202
            doc = wait_for_terminal(client)
            assert doc["state"] == "ready", doc.get("error")
            assert face.read_bytes() == site.spec("FakeCode").faces[
                "FakeCode-Regular.ttf"
            ]


class TestHealing:
    """Interrupted and corrupt states heal on a later run."""

    def test_a_killed_download_leaves_no_false_complete_and_heals(
        self, fontalloy_exe, site, catalog_dir, work_dir, tmp_path
    ):
        args = sync_args(site.release_origin, catalog_dir, work_dir)
        with running_service(fontalloy_exe, args, cwd=tmp_path) as (client, _):
            wait_for_terminal(client)

        # Simulate the kill mid-download: the archive, its extraction,
        # and its marker are gone (none were written), and a garbage
        # .part temp is all the run left behind.
        (catalog_dir / "FakeCode.zip").unlink()
        shutil.rmtree(catalog_dir / "FakeCode")
        (catalog_dir / "FakeCode.zip.complete").unlink()
        (catalog_dir / "FakeCode.zip.part").write_bytes(b"partial garbage")
        # The invariant the kill must leave: nothing falsely complete.
        assert not (catalog_dir / "FakeCode.zip.complete").exists()

        with running_service(fontalloy_exe, args, cwd=tmp_path) as (client, _):
            doc = wait_for_terminal(client)
            assert doc["state"] == "ready", doc.get("error")
            # The stray temp is cleaned, and the family is whole again —
            # the partial bytes never became the archive.
            assert not (catalog_dir / "FakeCode.zip.part").exists()
            assert _sha256_bytes((catalog_dir / "FakeCode.zip").read_bytes()) == (
                _sha256_bytes((site.origin_dir / "FakeCode.zip").read_bytes())
            )
            for name, payload in site.spec("FakeCode").faces.items():
                assert (catalog_dir / "FakeCode" / name).read_bytes() == payload

    def test_a_corrupt_extracted_face_is_rebuilt_on_restart(
        self, fontalloy_exe, site, catalog_dir, work_dir, tmp_path
    ):
        args = sync_args(site.release_origin, catalog_dir, work_dir)
        with running_service(fontalloy_exe, args, cwd=tmp_path) as (client, _):
            wait_for_terminal(client)

        face = catalog_dir / "FakeBright" / "FakeBright-Regular.ttf"
        face.write_bytes(b"truncated face bytes")

        with running_service(fontalloy_exe, args, cwd=tmp_path) as (client, _):
            doc = wait_for_terminal(client)
            assert doc["state"] == "ready", doc.get("error")
            assert face.read_bytes() == site.spec("FakeBright").faces[
                "FakeBright-Regular.ttf"
            ]

    def test_a_corrupt_archive_is_refetched_on_restart(
        self, fontalloy_exe, site, catalog_dir, work_dir, tmp_path
    ):
        """A corrupted archive with its marker still present: the fast
        path re-hashes, a mismatch cannot be canonized by the marker,
        and the family is re-fetched from the origins.
        """
        args = sync_args(site.release_origin, catalog_dir, work_dir)
        with running_service(fontalloy_exe, args, cwd=tmp_path) as (client, _):
            wait_for_terminal(client)

        (catalog_dir / "FakeMono.zip").write_bytes(b"garbage zip bytes")

        with running_service(fontalloy_exe, args, cwd=tmp_path) as (client, _):
            doc = wait_for_terminal(client)
            assert doc["state"] == "ready", doc.get("error")
            assert _sha256_bytes((catalog_dir / "FakeMono.zip").read_bytes()) == (
                _sha256_bytes((site.origin_dir / "FakeMono.zip").read_bytes())
            )
            for name, payload in site.spec("FakeMono").faces.items():
                assert (catalog_dir / "FakeMono" / name).read_bytes() == payload


class TestOrigins:
    def test_dead_then_stale_origins_fall_through_in_order(
        self, fontalloy_exe, catalog_dir, work_dir, tmp_path
    ):
        dead = tmp_path / "dead"
        dead.mkdir()
        stale = tmp_path / "stale"
        stale.mkdir()
        site = build_site(
            tmp_path / "site",
            families=[("FakeCode", ".zip")],
            extra_origins=[dead, stale],
        )
        # The stale origin serves WRONG bytes (a mirror lagging behind).
        (stale / "FakeCode.zip").write_bytes(b"stale mirror bytes")

        with running_service(
            fontalloy_exe,
            sync_args(site.release_origin, catalog_dir, work_dir),
            cwd=tmp_path,
        ) as (client, _):
            doc = wait_for_terminal(client)
            assert doc["state"] == "ready", doc.get("error")
        # The landed archive is the primary's, not the stale mirror's.
        assert _sha256_bytes((catalog_dir / "FakeCode.zip").read_bytes()) == (
            _sha256_bytes((site.origin_dir / "FakeCode.zip").read_bytes())
        )

    def test_unavailable_names_the_failure_then_a_restart_retries(
        self, fontalloy_exe, catalog_dir, work_dir, tmp_path
    ):
        """Every origin fails (the doc is served, the archives are
        withheld): the state machine lands ``unavailable`` with an
        error string naming the family — and a restart after the origin
        heals retries the family to ``ready`` (the ADR-0005 promise).
        """
        site = build_site(tmp_path / "site", families=[("FakeCode", ".zip")])
        backup = tmp_path / "backup"
        backup.mkdir()
        shutil.copy(site.origin_dir / "FakeCode.zip", backup / "FakeCode.zip")
        site.withhold()

        args = sync_args(site.release_origin, catalog_dir, work_dir)
        with running_service(fontalloy_exe, args, cwd=tmp_path) as (client, _):
            doc = wait_for_terminal(client)
            assert doc["state"] == "unavailable"
            assert "FakeCode" in doc["error"]
            assert "every origin failed" in doc["error"]
            progress = {entry["family"]: entry for entry in doc["families"]}
            assert progress["FakeCode"]["state"] == "failed"
            assert progress["FakeCode"]["error"]

        # The origin heals (the release publishes the archive); the next
        # launch retries the missing family to whole.
        shutil.copy(backup / "FakeCode.zip", site.origin_dir / "FakeCode.zip")
        with running_service(fontalloy_exe, args, cwd=tmp_path) as (client, _):
            doc = wait_for_terminal(client)
            assert doc["state"] == "ready", doc.get("error")
            for name, payload in site.spec("FakeCode").faces.items():
                assert (catalog_dir / "FakeCode" / name).read_bytes() == payload

    def test_offline_launch_uses_the_cached_document(
        self, fontalloy_exe, site, catalog_dir, work_dir, tmp_path
    ):
        """A synced catalog keeps working offline: with the origin gone
        entirely, the cached release document plus the complete families
        land ``ready`` with no error.
        """
        args = sync_args(site.release_origin, catalog_dir, work_dir)
        with running_service(fontalloy_exe, args, cwd=tmp_path) as (client, _):
            wait_for_terminal(client)

        shutil.rmtree(site.origin_dir)

        with running_service(fontalloy_exe, args, cwd=tmp_path) as (client, _):
            doc = wait_for_terminal(client)
            assert doc["state"] == "ready"
            assert doc["error"] is None

    def test_a_missing_release_document_with_no_cache_is_unavailable(
        self, fontalloy_exe, catalog_dir, work_dir, tmp_path
    ):
        nowhere = (tmp_path / "nowhere").as_uri()
        with running_service(
            fontalloy_exe, sync_args(nowhere, catalog_dir, work_dir), cwd=tmp_path
        ) as (client, _):
            doc = wait_for_terminal(client)
            assert doc["state"] == "unavailable"
            assert "catalog-release" in doc["error"]
            assert doc["families"] == []
