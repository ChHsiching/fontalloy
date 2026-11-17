"""The local pre-handoff packaged gate (ADR-0009, layer 4).

One command before any build is handed to the owner for manual
acceptance:

    uv run python scripts/packaged-gate.py

It guarantees the two failure modes of the r31v2 handoff cannot recur:
a STALE sidecar binary (the owner tested a Nov-1 exe missing Nov-3
fixes — the handoff claimed it was current) and a BROKEN frozen spawn
path (source-green, frozen-red). The gate rebuilds the binary whenever
any core/cli/entry source is newer than it, then drives the packaged
smoke: the merge round trip, the sentinel worker, and the catalog
family document through the frozen quota worker. Exit 0 = safe to
hand off.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
BUILD_SCRIPT = REPO_ROOT / "gui" / "scripts" / "build-sidecar.py"
SMOKE_SCRIPT = REPO_ROOT / "gui" / "scripts" / "sidecar-smoke.py"


def host_binary() -> Path:
    """The sidecar binary for this host's triple (mirrors build-sidecar)."""
    exe = ".exe" if sys.platform == "win32" else ""
    try:
        info = subprocess.run(
            ["rustc", "-Vv"], capture_output=True, text=True, check=True
        ).stdout
        triple = next(
            line[len("host: ") :].strip()
            for line in info.splitlines()
            if line.startswith("host: ")
        )
    except (OSError, subprocess.CalledProcessError, StopIteration):
        triple = "x86_64-pc-windows-msvc"  # the dev-machine default
    return REPO_ROOT / "gui" / "src-tauri" / "binaries" / f"fontalloy-{triple}{exe}"


def newest_source_mtime() -> float:
    """The newest mtime among everything the freeze bundles."""
    roots = [
        REPO_ROOT / "core",
        REPO_ROOT / "cli",
        REPO_ROOT / "gui" / "scripts" / "sidecar_entry.py",
        REPO_ROOT / "gui" / "scripts" / "build-sidecar.py",
        REPO_ROOT / "pyproject.toml",
        REPO_ROOT / "uv.lock",
    ]
    newest = 0.0
    for root in roots:
        paths = root.rglob("*") if root.is_dir() else [root]
        for path in paths:
            if path.is_file() and "__pycache__" not in path.parts:
                newest = max(newest, path.stat().st_mtime)
    return newest


def main() -> int:
    binary = host_binary()
    stale = not binary.is_file() or binary.stat().st_mtime < newest_source_mtime()
    if stale:
        print(f"[gate] binary stale or missing: {binary}")
        print("[gate] rebuilding (uv run --with pyinstaller)…")
        subprocess.run(
            [sys.executable, str(BUILD_SCRIPT)], check=True, cwd=REPO_ROOT
        )
    else:
        print(f"[gate] binary current: {binary}")

    print("[gate] running the packaged smoke…")
    result = subprocess.run(
        [sys.executable, str(SMOKE_SCRIPT), str(binary)], cwd=REPO_ROOT
    )
    if result.returncode != 0:
        print("[gate] FAIL — do not hand this build to the owner")
        return result.returncode
    print("[gate] PASS — packaged artifact verified (merge, sentinel worker, catalog doc)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
