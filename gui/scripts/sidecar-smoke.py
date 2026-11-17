"""Smoke-test the frozen sidecar binary end to end.

Three rounds against the binary the GUI actually bundles:

1. ``serve`` + one merge over the HTTP contract (the round trip the
   Tauri shell and the e2e suite perform);
2. the quota worker's sentinel re-entry (ADR-0008): the exe runs a real
   ``scan-local-files`` job when invoked as ``<exe> --fontalloy-worker``;
3. the catalog path through the FROZEN worker (the seam whose absence
   shipped the r31v2 incident): a one-family release served from a local
   origin, synced by ``serve --catalog-release-origin``, whose family
   document must land with non-empty cut faces — computed by the quota'd
   child, which only works if the frozen spawn form is correct.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import zipfile
from functools import partial
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # scripts/
from e2e_fonts import synth_font  # noqa: E402

BINARY = Path(sys.argv[1])


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def kill_tree(child: subprocess.Popen) -> None:
    """A onefile PyInstaller binary is a bootloader with a child: a
    plain terminate() kills only the bootloader and leaks the real
    server (which then holds the exe file itself). Kill the TREE."""
    if sys.platform == "win32":
        subprocess.run(
            ["taskkill", "/pid", str(child.pid), "/T", "/F"],
            capture_output=True,
        )
    else:
        child.terminate()
    try:
        child.wait(timeout=10)
    except subprocess.TimeoutExpired:
        child.kill()


def wait_line(child: subprocess.Popen) -> str:
    line = child.stdout.readline().strip()
    assert line.startswith("http://127.0.0.1:"), f"bad startup line: {line!r}"
    return line


with tempfile.TemporaryDirectory(prefix="sidecar-smoke-") as tmp:
    root = Path(tmp)
    fonts = root / "fonts"
    fonts.mkdir()
    synth_font(fonts / "base.ttf", family="SmokeBase", codepoints=tuple(range(0x41, 0x5B)))
    synth_font(fonts / "donor.ttf", family="SmokeDonor", codepoints=(0x4E2D, 0x56FD))
    work = root / "work"

    # -- 1. the merge round trip ------------------------------------------
    child = subprocess.Popen(
        [
            str(BINARY),
            "serve",
            "--port",
            "0",
            "--allow-origin",
            "http://tauri.localhost",
            "--font-dir",
            str(fonts),
            "--work-dir",
            str(work),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )
    try:
        base = wait_line(child)
        health = json.load(urllib.request.urlopen(f"{base}/health"))
        assert health["service"] == "fontalloy", health
        body = json.dumps(
            {
                "base": str(fonts / "base.ttf"),
                "donors": [{"path": str(fonts / "donor.ttf")}],
                "output": {"format": "ttf", "family": "ChHsich"},
            }
        ).encode()
        req = urllib.request.Request(
            f"{base}/builds", data=body, headers={"Content-Type": "application/json"}
        )
        submitted = json.load(urllib.request.urlopen(req))
        for _ in range(100):
            doc = json.load(urllib.request.urlopen(f"{base}/builds/{submitted['id']}"))
            if doc["status"] in ("done", "failed"):
                break
            time.sleep(0.1)
        assert doc["status"] == "done", doc
        font_bytes = urllib.request.urlopen(
            f"{base}/builds/{submitted['id']}/font"
        ).read()
        report = json.load(
            urllib.request.urlopen(f"{base}/builds/{submitted['id']}/report")
        )
        assert font_bytes[:4] == b"\x00\x01\x00\x00", font_bytes[:4]
        assert report["summary"] == {
            "codepoints_total": 28,
            "from_base": 26,
            "from_donors": 2,
            "output_codepoints": 28,
        }, report["summary"]
        print(f"SMOKE 1 OK: {BINARY.name} served {doc['font']['filename']} "
              f"({doc['font']['size']} bytes) + report")
    finally:
        kill_tree(child)

    # -- 2. the sentinel worker re-entry ----------------------------------
    job = root / "worker-job.json"
    out = root / "worker-out.json"
    job.write_text(
        json.dumps({"command": "scan-local-files", "paths": [str(fonts / "base.ttf")], "out": str(out)}),
        encoding="utf-8",
    )
    proc = subprocess.run(
        [str(BINARY), "--fontalloy-worker", str(job)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=300,
    )
    assert proc.returncode == 0, (proc.returncode, proc.stderr[-2000:])
    verdict = json.loads(out.read_text(encoding="utf-8"))
    assert verdict["files"][str(fonts / "base.ttf")], verdict
    print(f"SMOKE 2 OK: sentinel worker scanned {(fonts / 'base.ttf').name} "
          f"({len(verdict['files'][str(fonts / 'base.ttf')])} faces)")

    # -- 3. the catalog document through the frozen worker ----------------
    origin_dir = root / "origin"
    origin_dir.mkdir()
    cat = root / "cat"
    cat.mkdir()
    face = origin_dir / "SmokeCatalog-Regular.ttf"
    synth_font(face, family="SmokeCatalog", codepoints=tuple(range(0x41, 0x5B)))
    zip_path = origin_dir / "SmokeCatalog.zip"
    with zipfile.ZipFile(zip_path, "w") as bundle:
        bundle.write(face, arcname=face.name)
    handler = partial(SimpleHTTPRequestHandler, directory=str(origin_dir))
    httpd = HTTPServer(("127.0.0.1", 0), handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    # The release document must exist BEFORE the serve's first fetch.
    (origin_dir / "catalog-release.json").write_text(
        json.dumps(
            {
                "schema": "fontalloy/catalog-release@v1",
                "tag": "smoke-catalog-v1",
                "origins": [{"id": "smoke", "base_url": f"http://127.0.0.1:{port}"}],
                "families": [
                    {
                        "family": "SmokeCatalog",
                        "zip": zip_path.name,
                        "sha256": sha256_file(zip_path),
                        "files": [{"file": face.name, "sha256": sha256_file(face)}],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    child = subprocess.Popen(
        [
            str(BINARY),
            "serve",
            "--port",
            "0",
            "--allow-origin",
            "http://tauri.localhost",
            "--font-dir",
            str(cat),
            "--catalog-dir",
            str(cat),
            "--catalog-release-origin",
            f"http://127.0.0.1:{port}",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )
    try:
        base = wait_line(child)
        doc = None
        for _ in range(600):  # sync + the quota'd document computation
            try:
                doc = json.load(urllib.request.urlopen(f"{base}/catalog/families", timeout=5))
            except Exception:
                doc = None
            if doc:
                entry = next(
                    (f for f in doc.get("families", []) if f.get("family") == "SmokeCatalog"),
                    None,
                )
                if entry and any(c.get("faces") for c in entry.get("cuts", [])):
                    break
            time.sleep(0.3)
        assert doc is not None, "no /catalog/families answer in 180s"
        entry = next(
            (f for f in doc.get("families", []) if f.get("family") == "SmokeCatalog"),
            None,
        )
        assert entry is not None, doc
        faces = [len(c.get("faces", [])) for c in entry.get("cuts", [])]
        assert any(n > 0 for n in faces), f"zero-faced stub served: {entry}"
        err = entry.get("error")
        assert not err, f"family carried a worker error: {err}"
        print(f"SMOKE 3 OK: catalog family document landed with faces {faces} "
              "through the frozen quota worker")
    finally:
        kill_tree(child)
        httpd.shutdown()
