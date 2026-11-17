# Frozen sidecar invokes workers via the `--fontalloy-worker` sentinel

Status: accepted (P0 — unblocks every catalog pick in packaged builds; discharges the bundling constraint ADR-0007 recorded but never exercised)

The quota'd worker child (ADR-0007) is spawned as `[sys.executable, "-m", "fontalloy_core.font_worker", job.json]`. Under a source run `sys.executable` is a real `python.exe` and this works — every r31v2 test and vision pass ran this way. Under the PyInstaller onefile sidecar, `sys.executable` is the bootloader, not Python (PyInstaller runtime-information docs), so `-m` reaches the Click CLI as an unknown option and the child dies `exit 2` with the boxed `No such option: -m` — reproduced minimally with one command against the shipped exe. The serve then served every family as a zero-faced stub and every catalog pick failed with 「目录中尚无该字体的可用字面」. ADR-0007's own consequence line — "the future PyInstaller sidecar must ship the worker module and a spawnable interpreter … recorded here, not yet exercised" — is exactly the constraint that was never discharged.

## Decision

- **Frozen branch spawns `[sys.executable, "--fontalloy-worker", job.json]`.** A pre-Click argv-sentinel dispatch in the sidecar entry recognizes the flag and runs the worker module directly; it never reaches Click, stays out of `--help`, and exits with the worker's own codes. This is the pattern PyInstaller's docs prescribe for non-multiprocessing frameworks and what Tribler (`--core`), qutebrowser (self-exe spawn), and calibre (`--pipe-worker`) all ship (sources in the research note).
- **Source branch keeps `python -m fontalloy_core.font_worker`.** Identical behavior, two argv forms; `run_worker` picks by `getattr(sys, "frozen", False)`.
- **PyInstaller is pinned ≥ 6.10.** From 6.10 a child spawned via `sys.executable` is a first-class "worker sub-process": it reuses the parent's unpacked onefile `_MEI` directory (no per-worker extraction storm) and runs as one process, so the Windows Job Object wraps the real Python worker PID.
- **The quota mechanics of ADR-0007 are untouched** (Job Object commit limit / RLIMIT_AS around the child). `multiprocessing.freeze_support()` is rejected: it would swap the job-file/result-files contract for pickle/pipe IPC and remove the Popen seams the quota depends on (reasoning and citations in the research note).

## Consequences

- The spawn interface is a pinned contract: PR-time tests assert the packaged exe accepts the sentinel and completes a real job (ADR-0009 carries the layering).
- Version drift risk on the PyInstaller floor (docs say 6.9, changelog says 6.10.0 — the changelog wins) is recorded in the research note; the pin is enforced in the build script, not by convention.
- Sourced analysis: `docs/research/pyinstaller-worker-spawn.md`.
