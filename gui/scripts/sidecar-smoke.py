"""Smoke-test the frozen sidecar binary end to end.

Spawns ``<binary> serve --port 0``, reads the startup line, drives one
merge over the HTTP contract, and asserts the artifact — the same
round trip the Tauri shell and the e2e suite perform, through the
binary the GUI actually bundles.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # scripts/
from e2e_fonts import synth_font  # noqa: E402

BINARY = Path(sys.argv[1])

with tempfile.TemporaryDirectory(prefix="sidecar-smoke-") as tmp:
    root = Path(tmp)
    fonts = root / "fonts"
    fonts.mkdir()
    synth_font(fonts / "base.ttf", family="SmokeBase", codepoints=tuple(range(0x41, 0x5B)))
    synth_font(fonts / "donor.ttf", family="SmokeDonor", codepoints=(0x4E2D, 0x56FD))
    work = root / "work"

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
        line = child.stdout.readline().strip()
        assert line.startswith("http://127.0.0.1:"), f"bad startup line: {line!r}"
        base = line

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
            doc = json.load(
                urllib.request.urlopen(f"{base}/builds/{submitted['id']}")
            )
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
        print(f"SMOKE OK: {BINARY.name} served {doc['font']['filename']} "
              f"({doc['font']['size']} bytes) + report")
    finally:
        # A onefile PyInstaller binary is a bootloader with a child: a
        # plain terminate() kills only the bootloader and leaks the real
        # server (which then holds the exe file itself). Kill the TREE.
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
