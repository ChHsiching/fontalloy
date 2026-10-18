"""Seam 2 tests: local fonts by path (issue #31, spec #25).

The serve indexes local font files the consumer names by absolute
path: ``POST /local-fonts`` returns family documents in the same shape
as ``GET /catalog/families`` (cuts/faces with weight, style, coverage
summary, placeholder flag, and file references), with TTC collections
expanded server-side — one face per (weight, style) slot per the
style-slot rule, side-cut drops stated in the response — and every
face serves by URL (``GET /local-fonts/face``) with the byte-serving
cache discipline, so the frontend never transfers font bytes over IPC
(the successor of the frontend's ``ttc.ts`` face surgery and
``registry.ts`` byte registration).

Everything is asserted the way the frontends see it: the real
``fontalloy`` executable as a subprocess over real HTTP.
"""

from __future__ import annotations

import io
import json
import threading
import time
import urllib.parse
from pathlib import Path
from typing import Any

import pytest
from fontTools.ttLib import TTFont

from conftest import synth_font, synth_ttc
from test_cli_serve import running_service

#: Test seam: stretches the scan's per-file yield so a scan observably
#: spans time — the responsiveness test needs /health to answer INSIDE
#: a running scan.
SCAN_DELAY_ENV = "FONTALLOY_LOCAL_FONTS_DELAY"

#: The family-document keys GET /catalog/families serves (issue #38) —
#: a local family document must carry the same shape.
FAMILY_KEYS = {
    "family",
    "readiness",
    "error",
    "scanned",
    "display_name",
    "display_names",
    "preview",
    "cuts",
}

CUT_KEYS = {
    "variant",
    "def",
    "label",
    "file",
    "version",
    "sha256",
    "axes",
    "upstream_url",
    "display_name",
    "representative",
    "faces",
}

FACE_KEYS = {
    "file",
    "face_index",
    "sha256",
    "href",
    "family",
    "subfamily",
    "weight",
    "italic",
    "variable",
    "coverage",
    "placeholder",
    # Ticket #34: the face's own glyph count — the consumer's load
    # outcome 字形 figure.
    "glyphs",
}

_LATIN = (0x41, 0x42)


def scan(client, paths: list[Path | str]) -> Any:
    """POST the paths; returns the decoded response."""
    return client.post(
        "/local-fonts",
        {"paths": [str(path) for path in paths]},
    )


def face_url(face: dict[str, Any]) -> str:
    return face["href"]


@pytest.fixture
def work_dir(tmp_path: Path) -> Path:
    work = tmp_path / "work"
    work.mkdir()
    return work


@pytest.fixture
def service(fontalloy_exe, work_dir, tmp_path):
    """A plain local-fonts-only serve (no catalog, no font dirs)."""
    with running_service(
        fontalloy_exe, ["--port", "0", "--work-dir", str(work_dir)], cwd=tmp_path
    ) as (client, _):
        yield client


class TestScanHappyPath:
    """POST /local-fonts — family documents for named paths."""

    def test_two_files_two_families_with_full_document_shape(
        self, service, tmp_path
    ):
        fonts = tmp_path / "fonts"
        fonts.mkdir()
        synth_font(
            fonts / "Alpha.ttf", family="LocalAlpha", codepoints=_LATIN
        )
        synth_font(
            fonts / "Beta-Bold.ttf",
            family="LocalBeta",
            codepoints=_LATIN,
            weight=700,
            subfamily="Bold",
        )
        response = scan(service, [fonts / "Alpha.ttf", fonts / "Beta-Bold.ttf"])
        assert response.status == 200, response.data
        document = response.json()
        assert document["skipped"] == []
        families = {family["family"]: family for family in document["families"]}
        assert set(families) == {"LocalAlpha", "LocalBeta"}

        alpha = families["LocalAlpha"]
        assert set(alpha) == FAMILY_KEYS | {"dropped"}
        assert alpha["readiness"] == "done"
        assert alpha["scanned"] is True
        assert alpha["error"] is None
        assert alpha["display_name"] == "LocalAlpha"
        assert alpha["display_names"] == ["LocalAlpha"]
        assert alpha["preview"] is None
        assert alpha["dropped"] == []
        assert len(alpha["cuts"]) == 1
        cut = alpha["cuts"][0]
        assert set(cut) == CUT_KEYS
        assert cut["def"] is True
        assert cut["display_name"] == "LocalAlpha"
        assert cut["representative"] == "Alpha.ttf"
        assert len(cut["faces"]) == 1
        face = cut["faces"][0]
        assert set(face) == FACE_KEYS | {"path"}
        assert face["file"] == "Alpha.ttf"
        assert face["path"] == str((fonts / "Alpha.ttf").resolve())
        assert face["face_index"] == 0
        assert face["family"] == "LocalAlpha"
        assert face["subfamily"] == "Regular"
        assert face["weight"] == 400
        assert face["italic"] is False
        assert face["variable"] is False
        assert face["placeholder"] is False
        assert face["coverage"]["codepoints"] == 2
        assert face["coverage"]["placeholders"] == 0
        assert face["coverage"]["latin"] is True
        assert face["coverage"]["cjk"] is False
        assert face["glyphs"] >= 1
        assert face["href"].startswith("/local-fonts/face?")

        # The sibling weight pools into ONE family (the aggregation the
        # frontend's directory sweep used to do page-side).
        beta_faces = families["LocalBeta"]["cuts"][0]["faces"]
        assert [face["weight"] for face in beta_faces] == [700]

    def test_same_weight_siblings_of_one_family_pool(
        self, service, tmp_path
    ):
        """Files of one family submitted together aggregate into that
        family's weight matrix, in (weight, italic) order."""
        fonts = tmp_path / "fonts"
        fonts.mkdir()
        synth_font(fonts / "F-Light.ttf", family="Pooled", codepoints=_LATIN, weight=300, subfamily="Light")
        synth_font(fonts / "F-Regular.ttf", family="Pooled", codepoints=_LATIN)
        synth_font(fonts / "F-Bold.ttf", family="Pooled", codepoints=_LATIN, weight=700, subfamily="Bold")
        response = scan(
            service,
            [fonts / "F-Bold.ttf", fonts / "F-Light.ttf", fonts / "F-Regular.ttf"],
        )
        assert response.status == 200
        family = response.json()["families"][0]
        assert family["family"] == "Pooled"
        faces = family["cuts"][0]["faces"]
        assert [face["weight"] for face in faces] == [300, 400, 700]
        assert family["display_names"] == ["Pooled"]

    def test_placeholder_faces_are_flagged(self, service, tmp_path):
        from conftest import synth_placeholder_font

        fonts = tmp_path / "fonts"
        fonts.mkdir()
        synth_placeholder_font(
            fonts / "Tox.ttf",
            family="LocalTox",
            codepoints=(0x41, 0x42),
            placeholder_codepoints=tuple(range(0x4E00, 0x4E00 + 40)),
        )
        response = scan(service, [fonts / "Tox.ttf"])
        assert response.status == 200
        face = response.json()["families"][0]["cuts"][0]["faces"][0]
        assert face["placeholder"] is True
        assert face["coverage"]["codepoints"] == 2
        assert face["coverage"]["placeholders"] == 40
        assert face["coverage"]["cjk"] is False

    def test_empty_path_list_is_an_empty_document(self, service):
        response = scan(service, [])
        assert response.status == 200
        assert response.json() == {"families": [], "skipped": []}

    def test_unreadable_files_are_skipped_not_fatal(self, service, tmp_path):
        fonts = tmp_path / "fonts"
        fonts.mkdir()
        synth_font(fonts / "Good.ttf", family="LocalGood", codepoints=_LATIN)
        junk = fonts / "Junk.ttf"
        junk.write_bytes(b"this is not a font at all")
        response = scan(service, [junk, fonts / "Good.ttf"])
        assert response.status == 200
        document = response.json()
        assert [entry["path"] for entry in document["skipped"]] == [
            str(junk.resolve())
        ]
        assert document["skipped"][0]["error"]
        assert [family["family"] for family in document["families"]] == [
            "LocalGood"
        ]

    def test_duplicate_paths_scan_once(self, service, tmp_path):
        fonts = tmp_path / "fonts"
        fonts.mkdir()
        synth_font(fonts / "Solo.ttf", family="LocalSolo", codepoints=_LATIN)
        response = scan(
            service, [fonts / "Solo.ttf", fonts / "Solo.ttf"]
        )
        assert response.status == 200
        family = response.json()["families"][0]
        assert [face["file"] for face in family["cuts"][0]["faces"]] == [
            "Solo.ttf"
        ]


class TestTTCExpansion:
    """TTC collections expand server-side, one face per slot."""

    def test_a_ttc_expands_into_per_face_documents(self, service, tmp_path):
        fonts = tmp_path / "fonts"
        fonts.mkdir()
        synth_ttc(
            fonts / "Collect.ttc",
            faces=[
                {"family": "LocalTTC", "codepoints": _LATIN, "weight": 300, "subfamily": "Light"},
                {"family": "LocalTTC", "codepoints": _LATIN, "weight": 400},
                {"family": "LocalTTC", "codepoints": _LATIN, "weight": 700, "subfamily": "Bold"},
                {
                    "family": "LocalTTC",
                    "codepoints": _LATIN,
                    "weight": 700,
                    "subfamily": "Bold Italic",
                    "italic": True,
                },
            ],
        )
        response = scan(service, [fonts / "Collect.ttc"])
        assert response.status == 200, response.data
        document = response.json()
        assert document["skipped"] == []
        assert len(document["families"]) == 1
        family = document["families"][0]
        assert family["family"] == "LocalTTC"
        faces = family["cuts"][0]["faces"]
        assert len(faces) == 4
        by_slot = {(face["weight"], face["italic"]): face for face in faces}
        assert set(by_slot) == {(300, False), (400, False), (700, False), (700, True)}
        for index, face in enumerate(faces):
            assert face["file"] == "Collect.ttc"
            assert face["face_index"] == index
            assert face["path"] == str((fonts / "Collect.ttc").resolve())

    def test_each_ttc_face_serves_as_a_standalone_font(self, service, tmp_path):
        """The face URL returns the extracted standalone sfnt — the
        server-side successor of the frontend's ttc.ts surgery. Each
        face's bytes parse as their own font carrying that face's
        identity, NOT the collection."""
        fonts = tmp_path / "fonts"
        fonts.mkdir()
        synth_ttc(
            fonts / "Split.ttc",
            faces=[
                {"family": "LocalSplit", "codepoints": _LATIN, "weight": 400},
                {"family": "LocalSplit", "codepoints": (0x61, 0x62), "weight": 700, "subfamily": "Bold"},
            ],
        )
        response = scan(service, [fonts / "Split.ttc"])
        faces = response.json()["families"][0]["cuts"][0]["faces"]
        served = {}
        for face in faces:
            served[face["face_index"]] = service.get(face_url(face))
        assert all(r.status == 200 for r in served.values())
        for index, result in served.items():
            font = TTFont(io.BytesIO(result.data))
            assert font.getBestCmap()  # a loadable font, not a collection blob
            cmap = set(font.getBestCmap())
            if index == 0:
                assert cmap == set(_LATIN)
                assert font["OS/2"].usWeightClass == 400
            else:
                assert cmap == {0x61, 0x62}
                assert font["OS/2"].usWeightClass == 700
            assert result.headers.get("Content-Type") == "font/ttf"
            assert "immutable" in result.headers.get("Cache-Control", "")
            assert result.headers.get("ETag")
        # The two faces' bytes differ (real extraction, one blob each).
        assert served[0].data != served[1].data


class TestStyleSlotRule:
    """One face per (weight, style) slot; side-cut drops stated."""

    @staticmethod
    def _side_cut_dir(tmp_path: Path) -> Path:
        """The round-29 layout: an umbrella typographic family whose
        publisher side-cuts duplicate the plain slots."""
        fonts = tmp_path / "cut"
        fonts.mkdir()
        synth_font(
            fonts / "NF-Regular.ttf",
            family="Synth NF",
            typographic_family="Local Umbrella",
            codepoints=_LATIN,
        )
        synth_font(
            fonts / "NF-Italic.ttf",
            family="Synth NF",
            typographic_family="Local Umbrella",
            codepoints=_LATIN,
            subfamily="Italic",
            italic=True,
            italic_angle=-15.0,
        )
        synth_font(
            fonts / "NF-RegularOblique.ttf",
            family="Synth NF Obl",
            typographic_family="Local Umbrella",
            codepoints=_LATIN,
            subfamily="Regular Oblique",
            italic_angle=-15.0,
        )
        synth_font(
            fonts / "NF-ItalicUpright.ttf",
            family="Synth NF Upright",
            typographic_family="Local Umbrella",
            codepoints=_LATIN,
            subfamily="Italic Upright",
            italic=True,
        )
        return fonts

    def test_one_face_per_slot_and_drops_reported(self, service, tmp_path):
        fonts = self._side_cut_dir(tmp_path)
        response = scan(service, sorted(fonts.glob("NF-*.ttf")))
        assert response.status == 200
        document = response.json()
        assert len(document["families"]) == 1
        family = document["families"][0]
        assert family["family"] == "Local Umbrella"
        faces = family["cuts"][0]["faces"]
        slots = {(face["weight"], face["italic"]) for face in faces}
        assert slots == {(400, False), (400, True)}
        assert [face["file"] for face in sorted(faces, key=lambda f: f["file"])] == [
            "NF-Italic.ttf",
            "NF-Regular.ttf",
        ]
        # The dropped side-cuts are stated, never silent.
        dropped = family["dropped"]
        assert {drop["file"] for drop in dropped} == {
            "NF-RegularOblique.ttf",
            "NF-ItalicUpright.ttf",
        }
        for drop in dropped:
            assert set(drop) == {
                "file",
                "path",
                "face_index",
                "weight",
                "italic",
                "subfamily",
                "reason",
            }
            assert drop["weight"] == 400
            assert drop["italic"] is True
            assert "duplicate 400 italic slot" in drop["reason"]

    def test_dropped_faces_do_not_serve(self, service, tmp_path):
        """A dropped side-cut is not among the picker's faces, and its
        (file, index) never becomes a servable byte source."""
        fonts = self._side_cut_dir(tmp_path)
        response = scan(service, sorted(fonts.glob("NF-*.ttf")))
        faces = response.json()["families"][0]["cuts"][0]["faces"]
        servable = {face["href"] for face in faces}
        oblique = str((fonts / "NF-RegularOblique.ttf").resolve())
        query = urllib.parse.urlencode({"path": oblique, "index": 0})
        assert f"/local-fonts/face?{query}" not in servable
        # Every scanned face of the FILE is still listed under the
        # family that won the slot — the drop removes the face, not
        # the file, from the picker; the oblique file's only face was
        # dropped, so it serves nothing.
        assert service.get(f"/local-fonts/face?{query}").status == 404


class TestPathValidation:
    """Absolute existing font paths only — everything else is a 400."""

    def test_relative_paths_are_rejected(self, service, tmp_path):
        response = scan(service, ["fonts/Alpha.ttf"])
        assert response.status == 400
        error = response.json()["error"]
        assert "fonts/Alpha.ttf" in error
        assert "absolute" in error

    def test_traversal_shapes_are_rejected(self, service, tmp_path):
        fonts = tmp_path / "fonts"
        fonts.mkdir()
        good = fonts / "Alpha.ttf"
        synth_font(good, family="LocalAlpha", codepoints=_LATIN)
        relative = "../../etc/passwd"
        response = scan(service, [str(good), relative])
        assert response.status == 400
        assert relative in response.json()["error"]

    def test_missing_files_are_rejected(self, service, tmp_path):
        missing = tmp_path / "Nope.ttf"
        response = scan(service, [missing])
        assert response.status == 400
        assert "Nope.ttf" in response.json()["error"]

    def test_directories_are_rejected(self, service, tmp_path):
        directory = tmp_path / "dir.ttf"
        directory.mkdir()
        response = scan(service, [directory])
        assert response.status == 400

    def test_non_font_suffixes_are_rejected(self, service, tmp_path):
        text = tmp_path / "notes.txt"
        text.write_text("not a font", encoding="utf-8")
        response = scan(service, [text])
        assert response.status == 400
        assert "notes.txt" in response.json()["error"]

    def test_non_string_entries_are_rejected(self, service, tmp_path):
        response = service.post("/local-fonts", {"paths": [42]})
        assert response.status == 400

    def test_malformed_bodies_are_rejected(self, service):
        assert service.post("/local-fonts", {"nope": 1}).status == 400
        assert service.post("/local-fonts", {"paths": "not-a-list"}).status == 400
        raw = service.request(
            "POST", "/local-fonts", headers={"Content-Type": "application/json"}
        )
        assert raw.status == 400


class TestMtimeCache:
    """The index is cached per path + mtime + size."""

    def test_rescan_returns_the_cached_document(self, service, tmp_path):
        fonts = tmp_path / "fonts"
        fonts.mkdir()
        font_path = fonts / "Cache.ttf"
        synth_font(font_path, family="LocalCache", codepoints=_LATIN)
        first = scan(service, [font_path])
        assert first.status == 200
        second = scan(service, [font_path])
        assert second.status == 200
        assert second.json() == first.json()

    def test_a_changed_file_rescans_by_mtime(self, service, tmp_path):
        fonts = tmp_path / "fonts"
        fonts.mkdir()
        font_path = fonts / "Rewrite.ttf"
        synth_font(font_path, family="LocalRewrite", codepoints=_LATIN)
        assert scan(service, [font_path]).status == 200
        # Rewrite with a new weight AND a distinct mtime (the cache key
        # is path + mtime + size — a same-stamp rewrite must not fool it).
        stat = font_path.stat()
        synth_font(
            font_path,
            family="LocalRewrite",
            codepoints=_LATIN,
            weight=700,
            subfamily="Bold",
        )
        import os

        os.utime(font_path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
        document = scan(service, [font_path]).json()
        face = document["families"][0]["cuts"][0]["faces"][0]
        assert face["weight"] == 700

    def test_a_same_mtime_size_change_rescans_by_size(self, service, tmp_path):
        """A rewrite that restores the mtime still rescans when the
        size differs — both halves of the identity key are load-bearing."""
        import os

        fonts = tmp_path / "fonts"
        fonts.mkdir()
        font_path = fonts / "Resize.ttf"
        synth_font(font_path, family="LocalResize", codepoints=_LATIN)
        assert scan(service, [font_path]).status == 200
        stat = font_path.stat()
        synth_font(
            font_path, family="LocalResize", codepoints=_LATIN + (0x43, 0x44)
        )
        os.utime(font_path, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        assert font_path.stat().st_size != stat.st_size
        document = scan(service, [font_path]).json()
        face = document["families"][0]["cuts"][0]["faces"][0]
        assert face["coverage"]["codepoints"] == 4

    def test_a_stale_face_url_refuses_after_the_file_changes(
        self, service, tmp_path
    ):
        """The byte source serves the scanned identity only — a file
        that changed since the scan no longer serves under the old URL
        truth (the picker re-scans, getting new identity headers)."""
        import os

        fonts = tmp_path / "fonts"
        fonts.mkdir()
        font_path = fonts / "Stale.ttf"
        synth_font(font_path, family="LocalStale", codepoints=_LATIN)
        document = scan(service, [font_path]).json()
        face = document["families"][0]["cuts"][0]["faces"][0]
        assert service.get(face_url(face)).status == 200
        stat = font_path.stat()
        synth_font(
            font_path, family="LocalStale", codepoints=_LATIN + (0x43,)
        )
        os.utime(font_path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
        assert service.get(face_url(face)).status == 404


class TestFaceBytes:
    """GET /local-fonts/face — the URL byte source with cache truth."""

    def test_plain_files_serve_exact_bytes_with_cache_headers(
        self, service, tmp_path
    ):
        fonts = tmp_path / "fonts"
        fonts.mkdir()
        otf = fonts / "Real.otf"
        from conftest import synth_cff_font

        synth_cff_font(otf, family="LocalCFF")
        document = scan(service, [otf]).json()
        face = document["families"][0]["cuts"][0]["faces"][0]
        response = service.get(face_url(face))
        assert response.status == 200
        assert response.data == otf.read_bytes()  # byte-exact, no re-encode
        assert response.headers.get("Content-Type") == "font/otf"
        assert response.headers.get("Content-Length") == str(len(response.data))
        assert "immutable" in response.headers.get("Cache-Control", "")
        etag = response.headers.get("ETag")
        assert etag

        # A matching If-None-Match revalidates to 304 (no body).
        again = service.get(face_url(face), headers={"If-None-Match": etag})
        assert again.status == 304
        assert again.data == b""

    def test_only_scanned_paths_serve(self, service, tmp_path):
        fonts = tmp_path / "fonts"
        fonts.mkdir()
        never_scanned = fonts / "Stranger.ttf"
        synth_font(never_scanned, family="Stranger", codepoints=_LATIN)
        query = urllib.parse.urlencode(
            {"path": str(never_scanned.resolve()), "index": 0}
        )
        assert service.get(f"/local-fonts/face?{query}").status == 404
        assert service.get("/local-fonts/face").status == 400
        assert service.get("/local-fonts/face?index=0").status == 400

    def test_face_index_out_of_range_is_refused(self, service, tmp_path):
        fonts = tmp_path / "fonts"
        fonts.mkdir()
        font_path = fonts / "Single.ttf"
        synth_font(font_path, family="LocalSingle", codepoints=_LATIN)
        document = scan(service, [font_path]).json()
        face = document["families"][0]["cuts"][0]["faces"][0]
        base = face_url(face)
        assert service.get(base.replace("index=0", "index=5")).status == 404

    def test_traversal_in_the_query_is_refused(self, service, tmp_path):
        for raw in (
            "../../etc/passwd",
            "fonts/Relative.ttf",
            "not absolute",
        ):
            query = urllib.parse.urlencode({"path": raw, "index": 0})
            assert service.get(f"/local-fonts/face?{query}").status in (
                400,
                404,
            )


class TestResponsiveness:
    """Scans are bounded per file and yield; handlers stay live."""

    def test_health_answers_while_a_scan_runs(self, service, tmp_path):
        import os

        fonts = tmp_path / "many"
        fonts.mkdir()
        for index in range(8):
            synth_font(
                fonts / f"Many-{index}.ttf",
                family=f"LocalMany{index}",
                codepoints=_LATIN,
            )
        os.environ[SCAN_DELAY_ENV] = "0.3"
        try:
            result: dict[str, Any] = {}
            errors: list[str] = []

            def run_scan():
                try:
                    result["response"] = scan(service, sorted(fonts.glob("*.ttf")))
                except Exception as exc:  # pragma: no cover - failure report
                    errors.append(repr(exc))

            thread = threading.Thread(target=run_scan)
            thread.start()
            try:
                deadline = time.monotonic() + 30
                answered_mid_scan = False
                while time.monotonic() < deadline:
                    started = time.monotonic()
                    health = service.get("/health")
                    elapsed = time.monotonic() - started
                    assert health.status == 200
                    if thread.is_alive():
                        answered_mid_scan = True
                        assert elapsed < 1.0, (
                            f"/health took {elapsed:.2f}s mid-scan"
                        )
                    if not thread.is_alive():
                        break
                    time.sleep(0.02)
                assert answered_mid_scan, "the scan finished before any poll"
            finally:
                thread.join(timeout=60)
            assert not errors, errors
            assert result["response"].status == 200
            assert len(result["response"].json()["families"]) == 8
        finally:
            os.environ.pop(SCAN_DELAY_ENV, None)


class TestWorstFixtureTiming:
    """The measured cost of the worst fixture (reported, then pinned)."""

    def test_a_16_face_ttc_scan_is_bounded_and_documented(
        self, service, tmp_path
    ):
        """A 16-face TTC (the owner's real local-collection shape, e.g.
        AnnotationMono): the scan is measured and reported, every face
        lands in the document, and one face's URL serves standalone
        bytes in a bounded time."""
        fonts = tmp_path / "worst"
        fonts.mkdir()
        weights = [100, 200, 300, 400, 500, 600, 700, 800] * 2
        synth_ttc(
            fonts / "Worst16.ttc",
            faces=[
                {
                    "family": "LocalWorst",
                    "codepoints": _LATIN,
                    "weight": weight,
                    "subfamily": f"W{weight}",
                }
                for weight in weights
            ],
        )
        started = time.monotonic()
        response = scan(service, [fonts / "Worst16.ttc"])
        elapsed = time.monotonic() - started
        assert response.status == 200
        faces = response.json()["families"][0]["cuts"][0]["faces"]
        # 16 faces, 8 unique (weight, italic) slots after the style-slot
        # rule; the duplicated weights are side-cut drops, stated.
        assert len(faces) == 8
        dropped = response.json()["families"][0]["dropped"]
        assert len(dropped) == 8
        print(
            f"\nworst-fixture 16-face TTC scan: {elapsed:.2f}s "
            f"({len(weights)} faces, 8 slots)"
        )
        # Bounded work, pinned generously: the scan parses 16 faces'
        # identity + coverage, never something that scales with the
        # whole collection's byte mass.
        assert elapsed < 30.0, f"16-face TTC scan took {elapsed:.2f}s"
        started = time.monotonic()
        served = service.get(face_url(faces[-1]))
        elapsed = time.monotonic() - started
        print(f"worst-fixture face extraction: {elapsed:.2f}s")
        assert elapsed < 10.0, f"face extraction took {elapsed:.2f}s"
        assert served.status == 200
        assert TTFont(io.BytesIO(served.data))["OS/2"].usWeightClass == 800


class TestEndpointHygiene:
    """Method discipline and the existing surface untouched."""

    def test_get_on_the_scan_endpoint_is_refused(self, service):
        assert service.get("/local-fonts").status == 405

    def test_post_on_the_face_endpoint_is_refused(self, service, tmp_path):
        assert service.post("/local-fonts/face", {}).status == 405

    def test_the_ignored_endpoints_still_answer(self, service):
        assert service.get("/health").status == 200
        assert service.get("/catalog/families").status == 200
