"""PyInstaller entry point for the FontAlloy sidecar binary.

The GUI bundles this as the per-platform ``fontalloy`` external binary
(issue #16 / ADR-0002). It is the same console program the installed
``fontalloy`` script runs — the typer app from ``fontalloy_cli.main``
(the CLI holds no logic of its own) — frozen with its dependencies so
the desktop app needs no Python install (spec story 46).

It is ALSO the quota worker's re-entry point (ADR-0008): under a frozen
build ``sys.executable`` is the bootloader, not Python, so the serve
cannot spawn ``python -m fontalloy_core.font_worker``. It spawns this
exe with :data:`WORKER_SENTINEL` instead, and the dispatch below runs
the worker module BEFORE typer/click parse anything — the flag is not a
CLI option, never appears in ``--help``, and the job-file contract of
ADR-0007 rides unchanged.
"""

from __future__ import annotations

import sys

#: The quota worker's re-entry flag (must equal
#: :data:`fontalloy_core.quota.WORKER_SENTINEL`; duplicated so the
#: packaged entry never imports the core at startup just to check argv).
WORKER_SENTINEL = "--fontalloy-worker"


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == [WORKER_SENTINEL]:
        from fontalloy_core.font_worker import main as worker_main

        return worker_main(argv[1:])
    from fontalloy_cli.main import app

    app(prog_name="fontalloy")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
