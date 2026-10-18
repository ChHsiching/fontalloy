"""System font discovery (round 24, owner item 3; round 25 rebuild).

Classification rule — Latin coverage lists in the EN picker, CJK
coverage in the CJK picker, a face with both belongs in BOTH. The
round-25 rules under test here: the scan is incremental against its
disk cache (unchanged files never re-parse) and the SERVE stays
responsive while a scan is in flight (the wedge: the first
implementation starved every request on the GIL for minutes).
"""

from __future__ import annotations

import io
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import pytest
from fontTools.ttLib import TTFont

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


def test_placeholder_and_glyph0_mappings_report_honest_coverage(tmp_path: Path):
    """The intervals ride :func:`fontalloy_core.placeholder.face_coverage`
    exactly like the family-docs and local-font scans — a system face
    that maps a codepoint onto glyph 0 (absent by convention) or onto a
    suspected placeholder box must report neither as coverage, and the
    latin/cjk flags ride the honest set too, never the raw cmap."""
    from fontTools.fontBuilder import FontBuilder
    from fontTools.pens.ttGlyphPen import TTGlyphPen

    def box(x_min, y_min, x_max, y_max):  # type: ignore[no-untyped-def]
        pen = TTGlyphPen(None)
        pen.moveTo((x_min, y_min))
        pen.lineTo((x_max, y_min))
        pen.lineTo((x_max, y_max))
        pen.lineTo((x_min, y_max))
        pen.closePath()
        return pen.glyph()

    glyph_names = [".notdef", "placeholderBox", "uni4E2D"]
    builder = FontBuilder(unitsPerEm=1000, isTTF=True)
    builder.setupGlyphOrder(glyph_names)
    # placeholderBox draws .notdef's exact outline (the rule-2 shape).
    builder.setupGlyf(
        {".notdef": box(0, 0, 500, 700), "placeholderBox": box(0, 0, 500, 700), "uni4E2D": box(40, 0, 560, 400)}
    )  # type: ignore[arg-type]
    builder.setupHorizontalMetrics({name: (600, 40) for name in glyph_names})
    builder.setupCharacterMap(
        {
            0x41: ".notdef",  # glyph-0 mapping: absent by convention (rule 1)
            0x61: "placeholderBox",  # the tofu box under another name (rule 2)
            0x4E2D: "uni4E2D",  # the one real mapping
        }
    )
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    builder.setupOS2(
        sTypoAscender=800,
        sTypoDescender=-200,
        usWinAscent=900,
        usWinDescent=300,
        usWeightClass=400,
    )
    builder.setupNameTable({"familyName": "AlloyHonest", "styleName": "Regular"})
    builder.setupPost()
    builder.font.save(tmp_path / "AlloyHonest-Regular.ttf")

    faces = scan_system_fonts_sync((tmp_path,))
    assert len(faces) == 1
    face = faces[0]

    # Honest intervals: the CJK mark alone. The raw cmap would read
    # [[0x41,0x41],[0x4E2D,0x4E2D],[0x61,0x61]].
    assert face.intervals == ((0x4E2D, 0x4E2D),)
    # The flags ride the honest set: neither latin marker really covers.
    assert face.latin is False
    assert face.cjk is True


def _get(url: str, timeout: float = 5.0) -> object:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _get_status(url: str, timeout: float = 5.0) -> tuple[int, bytes | None]:
    """One GET's (status, body); HTTP errors return their raw payload."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def _wait_ready(port: int, timeout: float = 10.0) -> dict:
    """Poll /system-fonts until the background scan lands."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        doc = _get(f"http://127.0.0.1:{port}/system-fonts")
        assert isinstance(doc, dict)
        if doc["ready"]:
            return doc
        time.sleep(0.05)
    raise AssertionError("the system-font scan never answered ready")


def test_families_group_in_the_enumeration_document(tmp_path: Path):
    """Ticket #34: the GROUPING is the serve's, not the frontend's.

    ``/system-fonts`` answers a ``families`` list — one entry per
    name-table family, representative first (400-upright preferred,
    else the scan's first face), with the family's latin/cjk flags
    riding its faces' ACTUAL coverage (any face covering Latin marks
    the family Latin; the owner's 微软雅黑 ruling) — and every face
    carries the ``href`` its bytes serve at.
    """
    synth_font(
        tmp_path / "AlloyGroup-Bold.ttf",
        family="AlloyGroup",
        weight=700,
        codepoints=(0x41,),
    )
    synth_font(
        tmp_path / "AlloyGroup-Regular.ttf",
        family="AlloyGroup",
        weight=400,
        codepoints=(0x4E2D,),
    )
    synth_font(
        tmp_path / "AlloySoloEN-Regular.ttf",
        family="AlloySoloEN",
        codepoints=(0x41, 0x61),
    )

    server = make_serve_server(
        ServeOptions(port=0, system_font_dirs=(tmp_path,))
    )
    thread = None
    try:
        port = server.server_address[1]
        thread = serve_thread(server)
        doc = _wait_ready(port)
        families = {family["family"]: family for family in doc["families"]}

        # Scan order puts Bold first on disk; the 400-upright Regular is
        # still the representative (faces[0]).
        group = families["AlloyGroup"]
        assert [face["weight"] for face in group["faces"]] == [400, 700]
        # The family's flags ride its faces' ACTUAL coverage: Regular
        # covers CJK only, Bold Latin only — the family is BOTH.
        assert group["latin"] is True
        assert group["cjk"] is True

        solo = families["AlloySoloEN"]
        assert solo["latin"] is True
        assert solo["cjk"] is False
        assert [face["file"] for face in solo["faces"]] == [
            "AlloySoloEN-Regular.ttf"
        ]

        # Every face carries its byte-source href (and, ticket #36,
        # its coverage as run-length intervals — the counters' data).
        for family in doc["families"]:
            for face in family["faces"]:
                assert face["href"].startswith("/system-fonts/file?path=")
                assert "index=" in face["href"]
        assert families["AlloyGroup"]["faces"][0]["intervals"] == [
            [0x4E2D, 0x4E2D]
        ]
        assert families["AlloyGroup"]["faces"][1]["intervals"] == [
            [0x41, 0x41]
        ]
        assert families["AlloySoloEN"]["faces"][0]["intervals"] == [
            [0x41, 0x41],
            [0x61, 0x61],
        ]
    finally:
        server.shutdown()
        if thread is not None:
            thread.join(timeout=5)


def test_the_file_endpoint_serves_per_face_by_index(tmp_path: Path):
    """Ticket #34: system faces serve by URL, one face per index.

    A plain font streams its exact disk bytes; a collection face
    serves its EXTRACTED standalone sfnt (never the collection blob —
    the 428 MB non-transfer rule), with the scan's fingerprint as the
    ETag so cache truth and scan truth are one string. Only scanned
    (path, index) pairs answer; the index is required.
    """
    plain = _latin(tmp_path / "AlloyPlain-Regular.ttf")
    synth_ttc(
        tmp_path / "AlloySysTTC.ttc",
        faces=[
            dict(family="AlloySysA", weight=400, codepoints=(0x41,)),
            dict(family="AlloySysB", weight=700, codepoints=(0x4E2D,)),
        ],
    )

    server = make_serve_server(
        ServeOptions(port=0, system_font_dirs=(tmp_path,))
    )
    thread = None
    try:
        port = server.server_address[1]
        thread = serve_thread(server)
        doc = _wait_ready(port)
        faces = {(face["file"], face["face"]): face for face in doc["faces"]}
        base = f"http://127.0.0.1:{port}"

        # A plain font: the exact disk bytes, ETagged.
        plain_href = faces["AlloyPlain-Regular.ttf", 0]["href"]
        status, body = _get_status(f"{base}{plain_href}")
        assert status == 200
        assert body == plain.read_bytes()

        # A collection face: the extracted standalone font — a plain
        # sfnt, never 'ttcf', opening as exactly that face.
        face_href = faces["AlloySysTTC.ttc", 1]["href"]
        status, body = _get_status(f"{base}{face_href}")
        assert status == 200
        assert body[:4] != b"ttcf"
        extracted = TTFont(io.BytesIO(body))
        try:
            assert extracted["name"].getDebugName(1) == "AlloySysB"
        finally:
            extracted.close()

        # The gate: no index is a 400, an unscanned path and an
        # out-of-range index are 404s.
        status, _ = _get_status(
            f"{base}/system-fonts/file?path={urllib.parse.quote(str(plain))}"
        )
        assert status == 400
        status, _ = _get_status(f"{base}/system-fonts/file?path=C%3A%5Cnope.ttf&index=0")
        assert status == 404
        status, _ = _get_status(
            f"{base}/system-fonts/file"
            f"?path={urllib.parse.quote(str(tmp_path / 'AlloySysTTC.ttc'))}&index=9"
        )
        assert status == 404
    finally:
        server.shutdown()
        if thread is not None:
            thread.join(timeout=5)


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
