"""Ticket #43's materializer: the fetched-layout contract, unit-level.

The e2e suites never pass ``--catalog-manifest-origin`` (only the desktop
shell does), so the mechanism's own contract — per-entry zips land under
``<catalog>/fonts/``, each extracts to ``<fonts>/<stem>/``, the written
manifest's pins match the bytes on disk, and a second run downloads
nothing — is pinned here against a real local HTTP origin.
"""

from __future__ import annotations

import http.server
import json
import threading
import zipfile
from pathlib import Path
from typing import Any

from fontalloy_core.catalog_materialize import materialize


def _write_zip(path: Path, faces: dict[str, bytes]) -> None:
    with zipfile.ZipFile(path, "w") as archive:
        for name, body in faces.items():
            archive.writestr(name, body)


class _Origin(http.server.BaseHTTPRequestHandler):
    """Serves /manifest.json, /entry/<file>, /licenses/<name> from a root.

    Records every entry request so the idempotence assertion can prove a
    warm run re-downloads nothing.
    """

    root: Path
    entry_hits: list[str]

    def do_GET(self) -> None:  # noqa: N802 - http.server API
        name = self.path.split("?", 1)[0].lstrip("/")
        if name == "manifest.json":
            body = (self.root / "manifest.json").read_bytes()
            self._send(body, "application/json")
            return
        if name.startswith("entry/"):
            artifact = name[len("entry/") :]
            self.entry_hits.append(artifact)
            target = self.root / "entry" / artifact
            if target.is_file():
                self._send(target.read_bytes(), "application/zip")
            else:
                self.send_error(404)
            return
        if name.startswith("licenses/"):
            target = self.root / "licenses" / name[len("licenses/") :]
            if target.is_file():
                self._send(target.read_bytes(), "text/plain")
            else:
                self.send_error(404)
            return
        self.send_error(404)

    def _send(self, body: bytes, content_type: str) -> None:
        self.send_response(200)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args: Any) -> None:
        return


def _make_origin(root: Path) -> tuple[str, list[str]]:
    handler = type(
        "Origin",
        (_Origin,),
        {"root": root, "entry_hits": []},
    )
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return f"http://127.0.0.1:{server.server_address[1]}", handler.entry_hits


def test_materialize_lands_extracts_pins_and_skips_warm(tmp_path: Path) -> None:
    origin_root = tmp_path / "origin"
    (origin_root / "entry").mkdir(parents=True)
    (origin_root / "licenses").mkdir()
    faces_a = {
        "FamilyA-Regular.ttf": b"family-a-regular-bytes",
        "FamilyA-Bold.ttf": b"family-a-bold-bytes",
    }
    _write_zip(origin_root / "entry" / "FamilyA.zip", faces_a)
    faces_b = {"FamilyB-NF-CN-Regular.ttf": b"family-b-bytes"}
    _write_zip(origin_root / "entry" / "FamilyB-NF-CN.zip", faces_b)
    (origin_root / "licenses" / "OFL-1.1.txt").write_text("fake ofl", "utf-8")
    manifest = {
        "schema": "fontalloy/font-catalog@v1",
        "families": [
            {
                "family": "FamilyA",
                "variant": "Regular",
                "file": "FamilyA.zip",
                "sha256": "0" * 64,  # the PRODUCTION pin — must be replaced
                "license_file": "licenses/OFL-1.1.txt",
            },
            {
                "family": "FamilyB",
                "variant": "NF-CN",
                "file": "FamilyB-NF-CN.zip",
                "sha256": "0" * 64,
                "license_file": "licenses/OFL-1.1.txt",
            },
        ],
    }
    (origin_root / "manifest.json").write_text(
        json.dumps(manifest), "utf-8"
    )

    origin, entry_hits = _make_origin(origin_root)
    catalog_dir = tmp_path / "catalog"

    assert materialize(origin, catalog_dir) is True

    fonts = catalog_dir / "fonts"
    assert (fonts / "FamilyA.zip").is_file()
    assert (fonts / "FamilyB-NF-CN.zip").is_file()
    # The fetched layout's extraction: faces beside the zips.
    assert (fonts / "FamilyA" / "FamilyA-Regular.ttf").read_bytes() == (
        b"family-a-regular-bytes"
    )
    # The license lands where the manifest's path resolves.
    assert (catalog_dir / "licenses" / "OFL-1.1.txt").is_file()

    written = json.loads(
        (catalog_dir / "fonts.manifest.json").read_text("utf-8")
    )
    import hashlib

    for entry in written["families"]:
        digest = hashlib.sha256(
            (fonts / entry["file"]).read_bytes()
        ).hexdigest()
        assert entry["sha256"] == digest, entry["file"]

    # Idempotence: a warm run re-downloads NO entry artifact.
    hits_before = len(entry_hits)
    assert materialize(origin, catalog_dir) is True
    assert len(entry_hits) == hits_before
