"""System font discovery (round 24, owner item 3; round 25 rebuild).

Classification rule — Latin coverage lists in the EN picker, CJK
coverage in the CJK picker, a face with both belongs in BOTH. The
round-25 rules under test here: the scan is incremental against its
disk cache (unchanged files never re-parse) and the SERVE stays
responsive while a scan is in flight (the wedge: the first
implementation starved every request on the GIL for minutes).
"""

from __future__ import annotations

import json
import os
import time
import urllib.request
from pathlib import Path

import pytest

from fontalloy_core.serve import ServeOptions, make_serve_server
from fontalloy_core.systemfonts import (
    SCAN_DELAY_ENV,
    load_cache,
    save_cache,
    scan_system_fonts,
    scan_system_fonts_sync,
    system_font_dirs,
)

from conftest import synth_font, synth_ttc


def _latin(path: Path) -> Path:
    return synth_font(path, family="AlloyEN", codepoints=(0x41, 0x61))


def _cjk(path: Path) -> Path:
    return synth_font(path, family="AlloyCJK", codepoints=(0x4E2D,))


def _both(path: Path) -> Path:
    return synth_font(path, family="AlloyBoth", codepoints=(0x41, 0x4E2D))


def test_classification_rides_coverage_both_ways(tmp_path: Path):
    _latin(tmp_path / "AlloyEN-Regular.ttf")
    _cjk(tmp_path / "AlloyCJK-Regular.ttf")
    _both(tmp_path / "AlloyBoth-Regular.ttf")

    faces = {
        (face.file, face.face): face
        for face in scan_system_fonts_sync((tmp_path,))
    }

    assert faces["AlloyEN-Regular.ttf", 0].latin is True
    assert faces["AlloyEN-Regular.ttf", 0].cjk is False

    assert faces["AlloyCJK-Regular.ttf", 0].latin is False
    assert faces["AlloyCJK-Regular.ttf", 0].cjk is True

    # The owner's ruling: a face covering both lists in BOTH pickers —
    # 微软雅黑's Chinese is a legitimate standalone CJK pick.
    assert faces["AlloyBoth-Regular.ttf", 0].latin is True
    assert faces["AlloyBoth-Regular.ttf", 0].cjk is True


def test_collections_contribute_every_face(tmp_path: Path):
    synth_ttc(
        tmp_path / "AlloySys.ttc",
        faces=[
            dict(family="AlloySysA", weight=400, codepoints=(0x41,)),
            dict(family="AlloySysB", weight=700, codepoints=(0x4E2D,)),
        ],
    )

    faces = {
        (face.file, face.face): face
        for face in scan_system_fonts_sync((tmp_path,))
    }

    assert faces["AlloySys.ttc", 0].family == "AlloySysA"
    assert faces["AlloySys.ttc", 0].latin is True
    assert faces["AlloySys.ttc", 1].family == "AlloySysB"
    assert faces["AlloySys.ttc", 1].cjk is True


def test_stray_files_are_skipped_not_fatal(tmp_path: Path):
    _latin(tmp_path / "AlloyEN-Regular.ttf")
    (tmp_path / "not-a-font.ttf").write_bytes(b"nope")
    (tmp_path / "readme.txt").write_text("hello", encoding="utf-8")

    faces = scan_system_fonts_sync((tmp_path,))

    assert [face.file for face in faces] == ["AlloyEN-Regular.ttf"]


def test_missing_directories_scan_empty(tmp_path: Path):
    assert scan_system_fonts_sync((tmp_path / "nowhere",)) == []


def test_platform_directories_are_non_empty():
    # Smoke: the running platform always names at least one standard
    # font directory; whether it exists is the scan's business.
    assert len(system_font_dirs()) >= 1


def test_cache_round_trip_and_incremental_scan(tmp_path: Path):
    _latin(tmp_path / "AlloyEN-Regular.ttf")
    cache_file = tmp_path / "cache" / "system-fonts-cache.json"

    first = scan_system_fonts((tmp_path,), cache_file=cache_file)
    assert len(first.faces) == 1
    assert cache_file.is_file()

    # The persisted cache reloads intact.
    loaded = load_cache(cache_file)
    assert loaded is not None
    assert [face.family for face in loaded.faces] == ["AlloyEN"]

    # A steady-state re-scan keeps the cached faces (nothing re-parses:
    # the result is identical and the fingerprints match).
    again = scan_system_fonts((tmp_path,), previous=loaded, cache_file=cache_file)
    assert [face.family for face in again.faces] == ["AlloyEN"]
    assert again.fingerprints == loaded.fingerprints

    # A NEW file joins incrementally; the cached one keeps its face.
    _cjk(tmp_path / "AlloyCJK-Regular.ttf")
    third = scan_system_fonts((tmp_path,), previous=again, cache_file=cache_file)
    assert sorted(face.family for face in third.faces) == [
        "AlloyCJK",
        "AlloyEN",
    ]

    # A stale cache version is ignored wholesale.
    document = json.loads(cache_file.read_text(encoding="utf-8"))
    document["version"] = 0
    cache_file.write_text(json.dumps(document), encoding="utf-8")
    assert load_cache(cache_file) is None


def _get(url: str, timeout: float = 5.0) -> object:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def test_serve_stays_responsive_while_the_scan_runs(tmp_path: Path):
    """The round-25 wedge regression: /health answers mid-scan.

    The first implementation parsed the whole directory inside the
    request handler under the global lock — /health starved for the
    whole scan. Now the scan runs on a background thread that yields
    the GIL between files; with the test delay seam stretching each
    file, /health must answer well inside the scan's total runtime.
    """
    for index in range(6):
        synth_font(
            tmp_path / f"AlloySys{index}-Regular.ttf",
            family=f"AlloySys{index}",
            codepoints=(0x41,),
        )
    os.environ[SCAN_DELAY_ENV] = "0.4"  # 6 files ≈ 2.4s of scanning
    try:
        server = make_serve_server(
            ServeOptions(
                port=0,
                system_font_dirs=(tmp_path,),
            )
        )
        thread = None
        try:
            port = server.server_address[1]
            thread = serve_thread(server)
            # The scan is in flight: health answers fast.
            started = time.monotonic()
            health = _get(f"http://127.0.0.1:{port}/health")
            elapsed = time.monotonic() - started
            assert health["service"] == "fontalloy"
            assert elapsed < 1.0, f"/health took {elapsed:.2f}s mid-scan"

            # And the enumeration reports not-ready until it lands,
            # then the faces.
            deadline = time.monotonic() + 10
            doc = None
            while time.monotonic() < deadline:
                doc = _get(f"http://127.0.0.1:{port}/system-fonts")
                if doc["ready"]:
                    break
                time.sleep(0.1)
            assert doc is not None and doc["ready"] is True
            assert sorted(
                face["family"] for face in doc["faces"]
            ) == [f"AlloySys{index}" for index in range(6)]
        finally:
            server.shutdown()
            if thread is not None:
                thread.join(timeout=5)
    finally:
        os.environ.pop(SCAN_DELAY_ENV, None)


def serve_thread(server):  # type: ignore[no-untyped-def]
    import threading

    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return thread
