"""The catalog scope contract (ADR-0010).

"choose" downloads NOTHING until POST /catalog/scope records the
choice; "on-demand" presets the listing and delivers a family's bytes
only per explicit POST /catalog/families/<family>/fetch (in-flight
requests are singletons, unknown families 404); the choice persists in
<catalog>/scope.json and a later serve honors it. "full" (the default
everywhere else) is the classic sync — covered by the sync suite.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest

from conftest import fontalloy_exe  # noqa: F401
from test_cli_serve import running_service
from test_serve_catalog_sync import build_site, sync_args

FAMILIES = [("FakeCode", ".zip"), ("FakeBright", ".zip")]


def _choose_args(release_origin: str, catalog_dir: Path, work_dir: Path) -> list[str]:
    return sync_args(release_origin, catalog_dir, work_dir) + [
        "--catalog-scope",
        "choose",
    ]


def _status(client) -> dict:
    return client.get("/catalog/status").json()


def _wait_terminal(client, timeout: float = 30.0) -> dict:
    deadline = time.monotonic() + timeout
    last: dict = {}
    while time.monotonic() < deadline:
        last = _status(client)
        if last["state"] in ("ready", "unavailable"):
            return last
        time.sleep(0.02)
    raise AssertionError(f"catalog sync never settled: {last}")


def _wait_family(client, family: str, timeout: float = 30.0) -> dict:
    deadline = time.monotonic() + timeout
    last: dict = {}
    while time.monotonic() < deadline:
        last = _status(client)
        entry = next(
            (f for f in last["families"] if f["family"] == family), None
        )
        if entry and entry["state"] in ("done", "failed"):
            assert entry["state"] == "done", entry
            return last
        time.sleep(0.02)
    raise AssertionError(f"{family} never fetched: {last}")


def _downloaded(catalog_dir: Path) -> list[str]:
    return sorted(
        p.name
        for p in catalog_dir.glob("*.zip*")
        if not p.name.endswith(".part")
    )


class TestChooseMode:
    def test_no_byte_moves_until_the_scope_lands(
        self, fontalloy_exe, tmp_path
    ):
        site = build_site(tmp_path / "site", families=FAMILIES)
        catalog_dir = tmp_path / "catalog"
        work_dir = tmp_path / "work"
        with running_service(
            fontalloy_exe,
            _choose_args(site.release_origin, catalog_dir, work_dir),
            cwd=tmp_path,
        ) as (client, _):
            doc = _status(client)
            assert doc["state"] == "bootstrapping", doc
            assert doc["scope"] is None, doc
            assert doc["families"] == [], doc
            # The choice screen can sit here for good: a grace beat
            # proves nothing downloads on its own.
            time.sleep(0.8)
            assert _downloaded(catalog_dir) == [], _downloaded(catalog_dir)

            reply = client.post("/catalog/scope", {"mode": "on-demand"}).json()
            assert reply["scope"] == "on-demand", reply
            terminal = _wait_terminal(client)
            assert terminal["state"] == "ready", terminal.get("error")
            # The listing is live; the bytes are not.
            names = [f["family"] for f in terminal["families"]]
            assert names == ["FakeCode", "FakeBright"], names
            assert all(
                f["state"] == "pending" for f in terminal["families"]
            ), terminal["families"]
            assert _downloaded(catalog_dir) == [], _downloaded(catalog_dir)
            assert json.loads(
                (catalog_dir / "scope.json").read_text(encoding="utf-8")
            ) == {"mode": "on-demand"}


class TestOnDemandFetch:
    def test_one_family_fetch_delivers_exactly_that_family(
        self, fontalloy_exe, tmp_path
    ):
        site = build_site(tmp_path / "site", families=FAMILIES)
        catalog_dir = tmp_path / "catalog"
        work_dir = tmp_path / "work"
        with running_service(
            fontalloy_exe,
            _choose_args(site.release_origin, catalog_dir, work_dir),
            cwd=tmp_path,
        ) as (client, _):
            client.post("/catalog/scope", {"mode": "on-demand"})
            _wait_terminal(client)

            accepted = client.post("/catalog/families/FakeCode/fetch", {})
            assert accepted.status == 202, accepted.json()
            terminal = _wait_family(client, "FakeCode")
            others = [
                f for f in terminal["families"] if f["family"] != "FakeCode"
            ]
            assert all(f["state"] == "pending" for f in others), terminal
            assert _downloaded(catalog_dir) == ["FakeCode.zip", "FakeCode.zip.complete"]

            # Unknown family -> 404; a completed fetch re-accepts (202,
            # the repair idempotence — the family is already whole).
            missing = client.post("/catalog/families/Nope/fetch", {})
            assert missing.status == 404, missing.json()

    def test_in_flight_fetch_is_a_singleton(
        self, fontalloy_exe, tmp_path, monkeypatch
    ):
        monkeypatch.setenv("FONTALLOY_CATALOG_SYNC_DELAY", "0.5")
        site = build_site(tmp_path / "site", families=FAMILIES)
        catalog_dir = tmp_path / "catalog"
        work_dir = tmp_path / "work"
        with running_service(
            fontalloy_exe,
            _choose_args(site.release_origin, catalog_dir, work_dir),
            cwd=tmp_path,
        ) as (client, _):
            client.post("/catalog/scope", {"mode": "on-demand"})
            _wait_terminal(client)
            assert (
                client.post("/catalog/families/FakeCode/fetch", {}).status
                == 202
            )
            assert (
                client.post("/catalog/families/FakeCode/fetch", {}).status
                == 409
            )
            _wait_family(client, "FakeCode", timeout=15)


class TestFullChoice:
    def test_full_choice_walks_the_whole_catalog(
        self, fontalloy_exe, tmp_path
    ):
        site = build_site(tmp_path / "site", families=FAMILIES)
        catalog_dir = tmp_path / "catalog"
        work_dir = tmp_path / "work"
        with running_service(
            fontalloy_exe,
            _choose_args(site.release_origin, catalog_dir, work_dir),
            cwd=tmp_path,
        ) as (client, _):
            reply = client.post("/catalog/scope", {"mode": "full"}).json()
            assert reply["scope"] == "full", reply
            terminal = _wait_terminal(client)
            assert terminal["state"] == "ready", terminal.get("error")
            assert all(
                f["state"] == "done" for f in terminal["families"]
            ), terminal["families"]
            assert _downloaded(catalog_dir) == [
                "FakeBright.zip",
                "FakeBright.zip.complete",
                "FakeCode.zip",
                "FakeCode.zip.complete",
            ]


class TestScopePersistence:
    def test_a_later_serve_honors_the_recorded_scope(
        self, fontalloy_exe, tmp_path
    ):
        site = build_site(tmp_path / "site", families=FAMILIES)
        catalog_dir = tmp_path / "catalog"
        work_dir = tmp_path / "work"
        with running_service(
            fontalloy_exe,
            _choose_args(site.release_origin, catalog_dir, work_dir),
            cwd=tmp_path,
        ) as (client, _):
            client.post("/catalog/scope", {"mode": "on-demand"})
            _wait_terminal(client)
        # A BARE serve (no --catalog-scope): scope.json still rules —
        # the listing presets, nothing downloads.
        with running_service(
            fontalloy_exe,
            sync_args(site.release_origin, catalog_dir, work_dir),
            cwd=tmp_path,
        ) as (client, _):
            terminal = _wait_terminal(client)
            assert terminal["state"] == "ready", terminal.get("error")
            assert terminal["scope"] == "on-demand", terminal
            assert all(
                f["state"] == "pending" for f in terminal["families"]
            ), terminal["families"]
            assert _downloaded(catalog_dir) == [], _downloaded(catalog_dir)
