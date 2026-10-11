"""Build the FontAlloy sidecar binary for the CURRENT platform.

The GUI's Tauri shell bundles the core as a per-platform external
binary (``bundle.externalBin`` in tauri.conf.json): the file must exist
as ``src-tauri/binaries/fontalloy-<target-triple>`` (plus ``.exe`` on
Windows) before ``cargo check`` / ``tauri dev`` / ``tauri build`` run.
This script produces exactly that file with PyInstaller:

    python gui/scripts/build-sidecar.py [--triple <triple>] [--out <dir>]

Why PyInstaller and not shiv/zipapp: a zipapp still requires a Python
interpreter on the target machine, which violates the spec's "merges
run natively without a Python install" (story 46). PyInstaller freezes
the interpreter plus fontTools plus fontalloy into one self-contained
executable; ``--onefile`` matches externalBin's single-file naming, and
``--collect-submodules`` counters fontTools' lazy imports (PyInstaller
cannot see what fontTools imports dynamically).

Run from the repo root through uv so the project environment (core +
cli + fontTools) is what gets frozen:

    uv run --with pyinstaller python gui/scripts/build-sidecar.py

Cross-builds (macOS/Linux binaries for the same tree) are CI-side:
each platform builds its own binary on its native runner. See
.github/workflows/sidecar.yml — never checked in, only produced.
"""

from __future__ import annotations

import argparse
import platform
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
ENTRY = Path(__file__).resolve().parent / "sidecar_entry.py"


def host_triple() -> str:
    """The Rust target triple of this machine (rustc knows best)."""
    try:
        info = subprocess.run(
            ["rustc", "-Vv"], capture_output=True, text=True, check=True
        ).stdout
        for line in info.splitlines():
            if line.startswith("host: "):
                return line[len("host: ") :].strip()
    except (OSError, subprocess.CalledProcessError):
        pass
    # Fallback: the two triples this repo actually ships.
    machine = platform.machine().lower()
    if sys.platform == "win32":
        return "x86_64-pc-windows-msvc" if machine in ("amd64", "x86_64") else "aarch64-pc-windows-msvc"
    if sys.platform == "darwin":
        return "aarch64-apple-darwin" if machine == "arm64" else "x86_64-apple-darwin"
    return "x86_64-unknown-linux-gnu"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--triple",
        default=host_triple(),
        help="target triple the binary is named for (default: this host)",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=REPO_ROOT / "gui" / "src-tauri" / "binaries",
        help="output directory (default: gui/src-tauri/binaries)",
    )
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="fontalloy-sidecar-") as tmp:
        dist = Path(tmp) / "dist"
        command = [
            sys.executable,
            "-m",
            "PyInstaller",
            "--noconfirm",
            "--clean",
            "--onefile",
            "--console",
            "--name",
            "fontalloy",
            "--distpath",
            str(dist),
            "--workpath",
            str(Path(tmp) / "work"),
            "--specpath",
            str(Path(tmp) / "spec",
            ),
            # fontTools imports most submodules lazily — collect them all
            # or the frozen build dies at runtime on a missing module.
            "--collect-submodules",
            "fontTools",
            "--collect-submodules",
            "fontalloy_core",
            "--collect-submodules",
            "fontalloy_cli",
            # Package DATA, not just code: the core's fc-lang corpus
            # (data/fc-lang/*.orth) is what BUILTIN_NAMED_SETS parses.
            # Without it the frozen serve silently ships an EMPTY preset
            # registry and every recipe with a named set dies at submit
            # ("references the unknown named set 'zh_cn'") — the round-5
            # P0. The core now also refuses to import without it.
            "--collect-data",
            "fontalloy_core",
            str(ENTRY),
        ]
        print(" ".join(command), flush=True)
        subprocess.run(command, check=True, cwd=REPO_ROOT)

        args.out.mkdir(parents=True, exist_ok=True)
        # PyInstaller names the artifact after the HOST (fontalloy.exe on
        # Windows, fontalloy elsewhere); local builds are always for the
        # host triple anyway (cross-builds are CI-side, on their own
        # runners, so their names line up naturally).
        source = dist / ("fontalloy.exe" if sys.platform == "win32" else "fontalloy")
        if not source.is_file():
            candidates = list(dist.glob("fontalloy*"))
            if not candidates:
                raise SystemExit(f"pyinstaller produced no binary in {dist}")
            source = candidates[0]
        suffix = ".exe" if args.triple.endswith("windows-msvc") else ""
        target = args.out / f"fontalloy-{args.triple}{suffix}"
        shutil.copy2(source, target)
        print(f"sidecar binary: {target} ({target.stat().st_size / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
