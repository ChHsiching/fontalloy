"""PyInstaller entry point for the FontAlloy sidecar binary.

The GUI bundles this as the per-platform ``fontalloy`` external binary
(issue #16 / ADR-0002). It is the same console program the installed
``fontalloy`` script runs — the typer app from ``fontalloy_cli.main``
(the CLI holds no logic of its own) — frozen with its dependencies so
the desktop app needs no Python install (spec story 46).
"""

from __future__ import annotations

from fontalloy_cli.main import app

if __name__ == "__main__":
    app(prog_name="fontalloy")
