"""The worker invocation contract (ADR-0008).

Source runs spawn ``python -m fontalloy_core.font_worker``; frozen runs
re-enter the packaged exe through the ``--fontalloy-worker`` sentinel;
the packaged ENTRY dispatches the sentinel before Click parses anything
(and never advertises it). The incident this pins: the frozen spawn kept
the source argv form, Click answered ``No such option: -m``, every
family document died at spawn, and every catalog pick failed with
「目录中尚无该字体的可用字面」 while every source-mode suite stayed green.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from fontalloy_core import quota

REPO_ROOT = Path(__file__).resolve().parents[1]
ENTRY = REPO_ROOT / "gui" / "scripts" / "sidecar_entry.py"

FAKE_EXECUTABLE = "/fake/fontalloy-or-python"


def _capture_spawn(monkeypatch, *, frozen: bool) -> list[list[str]]:
    calls: list[list[str]] = []

    def fake_spawn(argv, limit_mb, timeout):  # noqa: ANN001
        calls.append(list(argv))
        return quota.WorkerOutcome(returncode=0, stderr_tail="")

    monkeypatch.setattr(quota, "_spawn_and_wait", fake_spawn)
    monkeypatch.setattr(sys, "executable", FAKE_EXECUTABLE)
    monkeypatch.setattr(sys, "frozen", frozen, raising=False)
    return calls


def test_source_run_spawns_python_dash_m(monkeypatch, tmp_path):
    calls = _capture_spawn(monkeypatch, frozen=False)
    quota.run_worker({"command": "scan-local-files", "paths": [], "out": str(tmp_path / "o")})
    (argv,) = calls
    assert argv[0] == FAKE_EXECUTABLE
    assert argv[1:3] == ["-m", quota.WORKER_MODULE]
    assert Path(argv[3]).name.startswith("fontalloy-worker-")


def test_frozen_run_spawns_sentinel(monkeypatch, tmp_path):
    calls = _capture_spawn(monkeypatch, frozen=True)
    quota.run_worker({"command": "scan-local-files", "paths": [], "out": str(tmp_path / "o")})
    (argv,) = calls
    assert argv[0] == FAKE_EXECUTABLE
    assert argv[1] == quota.WORKER_SENTINEL
    assert "-m" not in argv
    assert Path(argv[2]).name.startswith("fontalloy-worker-")


def test_entry_sentinel_constant_matches_quota():
    text = ENTRY.read_text(encoding="utf-8")
    assert f'WORKER_SENTINEL = "{quota.WORKER_SENTINEL}"' in text


def test_entry_dispatches_worker_sentinel_before_click(tmp_path):
    job = tmp_path / "job.json"
    job.write_text(json.dumps({"command": "bogus"}), encoding="utf-8")
    proc = subprocess.run(
        [sys.executable, str(ENTRY), quota.WORKER_SENTINEL, str(job)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
    )
    # The worker's own usage error (exit 2, "unknown command") — NOT
    # Click's boxed option rejection.
    assert proc.returncode == 2, (proc.returncode, proc.stderr)
    assert "unknown command" in proc.stderr, proc.stderr
    assert "No such option" not in proc.stderr, proc.stderr


def test_entry_sentinel_hidden_from_help():
    proc = subprocess.run(
        [sys.executable, str(ENTRY), "--help"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
    )
    assert proc.returncode == 0, (proc.returncode, proc.stderr)
    assert quota.WORKER_SENTINEL not in proc.stdout
    assert quota.WORKER_SENTINEL not in proc.stderr
