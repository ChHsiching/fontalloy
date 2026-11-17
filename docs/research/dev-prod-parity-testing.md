# Dev/prod parity: testing the packaged artifact, not just the source tree

Research notes (2026-11-17). Question: what are the established patterns for
"test what you ship" — making a PyInstaller-packaged/Tauri-sidecar
application's PACKAGED binary carry the same automated coverage as the source
tree, so a dev-green build can never diverge from production behavior?

Our gap: `ci.yml` runs `uv run pytest` against the source venv on every PR;
`sidecar.yml` builds the frozen sidecar and runs `gui/scripts/sidecar-smoke.py`
(spawn + `/health` + one build roundtrip) but only on `push` to `main` with
path filters — never on PRs. A frozen-only bug (worker spawn died with `-m`
argv) reached the owner through this gap. Ruled decision: dev and production
behavior must not diverge; tests must drive the packaged artifact.

---

## 1. PyInstaller official guidance on testing frozen apps

**There is no official "how to test your frozen app" page.** The docs never
prescribe a post-build verification procedure or a smoke framework. What the
official docs DO provide is (a) a catalog of ways frozen behavior diverges from
dev, and (b) — in PyInstaller's own repository — the de-facto standard harness
for build-then-run testing.

### 1a. Documented frozen-vs-dev divergences (why source-green ≠ artifact-green)

Source: <https://pyinstaller.org/en/stable/common-issues-and-pitfalls.html>

- **Multiprocessing / spawn**: frozen apps must call
  `multiprocessing.freeze_support()`. "A typical symptom of failing to call
  [it] is an endless spawn loop of your application process." This is exactly
  the bug class we shipped (worker spawn with `-m`-style argv semantics that
  only exist for a real `python` interpreter).
- **Library search paths**: frozen apps "prefer bundled copies of shared
  libraries over the copies that might be available on the target system",
  which changes behavior of code that launches or loads external components.
- **`sys.executable` / subprocess semantics**: since PyInstaller 6.9,
  processes spawned via `sys.executable` are assumed to be reusable frozen
  workers; self-restart requires setting `PYINSTALLER_RESET_ENVIRONMENT=1`.
  A source-tree test suite cannot observe any of this.
- **macOS launch environment**: Finder-launched apps run with a reduced
  `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), so subprocess resolution differs
  from any dev shell or CI shell.
- **`--noconsole` (Windows)**: standard streams are `None`, a frozen-only
  crash mode.

Python itself documents the spawn contract our bug violated:
<https://docs.python.org/3/library/multiprocessing.html> — `freeze_support()`
"Add[s] support for when a program which uses multiprocessing has been frozen
to produce an executable. (Has been tested with py2exe, PyInstaller and
cx_Freeze.)"; "If the `freeze_support()` line is omitted then trying to run
the frozen executable will raise `RuntimeError`"; it is a **no-op in the
unfrozen program** — i.e. the failure mode is invisible to every source-tree
test by construction. Also: "The 'spawn' and 'forkserver' start methods
generally cannot be used with 'frozen' executables ... on POSIX systems."

### 1b. The de-facto standard: PyInstaller's own functional-test harness

Sources: <https://github.com/pyinstaller/pyinstaller/blob/develop/PyInstaller/utils/conftest.py>
and `tests/functional/conftest.py` in the same repo.

The community-standard pattern is PyInstaller's `pyi_builder` pytest fixture
(imported into `tests/functional/conftest.py` via
`from PyInstaller.utils.conftest import *`):

- `pyi_builder` is **parametrized over `['onedir', 'onefile']`**, so every
  functional test runs against both frozen layouts.
- `builder.test_source(...)` / `test_script(...)` wrap "all phases of testing
  a Python script": build via `pyi_main.run(...)` with `--debug=bootloader
  --noupx`; fail the test if the build fails; locate the built executables
  (`_find_executables()`, asserting `exes != []` — "No executable file was
  found."); then **execute the frozen exe** (`_run_executable()`, in a
  scrubbed minimal-`PATH` environment, `psutil`-monitored, 3-minute timeout
  `_EXE_TIMEOUT = 3 * 60` with child-tree cleanup).
- Assertions: return code must equal the expected value (default 0) —
  `if retcode != kwargs.get('retcode', 0): pytest.fail(...)`; timeout raises
  `RuntimeError`; stdout/stderr are captured and surfaced on failure; an
  optional `.toc` check regex-verifies archive contents.

Takeaway: the reference implementation of "test the frozen app" is *build in
a temp dir → run the artifact → assert exit code/output/timeout*, executed by
the same pytest run that covers everything else, on all three OSes. There is
no separate sanctioned "smoke framework"; projects either adopt this harness
shape (borg, Zircolite below) or hand-roll the same steps.

## 2. Real projects that CI-test their frozen binaries

### 2a. pyinstaller/pyinstaller — PR-gated, full 3-OS matrix, build+run

- Workflow: `.github/workflows/ci.yml`
  (<https://github.com/pyinstaller/pyinstaller/blob/develop/.github/workflows/ci.yml>)
  — triggered by `pull_request` (branches: `develop`) and `workflow_dispatch`.
- The `tests` job runs on `windows-latest`, `ubuntu-24.04`, `macos-15-intel`,
  `macos-15` across Python 3.8–3.15: compiles the bootloader, builds wheels,
  installs, then `pytest -n 5 --maxfail 3 --durations 10 tests/unit
  tests/functional` — i.e. **every PR freezes sample apps and executes the
  frozen exes** via the `pyi_builder` machinery above. Additional jobs cover
  Alpine/msys2/Cygwin/Termux/BSD.
- Why: for a packager, the artifact IS the product, so artifact correctness is
  gated at the earliest and cheapest point — the PR.

### 2b. Nuitka/Nuitka — PR-gated compile-and-run of onefile artifacts

- Workflow: `.github/workflows/testing.yml`
  (<https://github.com/Nuitka/Nuitka/blob/develop/.github/workflows/testing.yml>)
  — `on: pull_request` + `push`.
- Jobs on Ubuntu, macOS, Windows run e.g.:
  `python -m nuitka --mode=onefile --show-scons --run ... tests/basics/EmptyModuleTest.py`
  plus `tests/run-tests` — compile a program into a standalone onefile binary
  and execute it, per PR, per OS.

### 2c. marcelotduarte/cx_Freeze — PR-gated pytest suite that builds and runs frozen exes

- Workflow: `.github/workflows/ci.yml`
  (<https://github.com/marcelotduarte/cx_Freeze/blob/main/.github/workflows/ci.yml>)
  — `on: pull_request` + `push`, OS matrix (Linux/macOS/Windows).
- `tests/test_executables.py`
  (<https://github.com/marcelotduarte/cx_Freeze/blob/main/tests/test_executables.py>)
  defines sample projects inline (`print("Hello from cx_Freeze")`), freezes
  them (`cxfreeze build_exe`, onefile and onedir variants), then asserts
  `executable.is_file()` and **runs the frozen exe**
  (`result = tmp_package.run(executable)`), asserting on its stdout lines.

### 2d. borgbackup/borg — application example: tag-gated frozen build, full suite through the frozen binary

- Workflow: `.github/workflows/ci.yml`
  (<https://github.com/borgbackup/borg/blob/master/.github/workflows/ci.yml>)
  — `on: push` (master) + `pull_request` (master). The `native_tests` job uses
  a **conditional matrix**: PRs get a cheap source-only matrix; non-PR events
  add `binary` entries (Linux x64/arm64, macOS arm64/x86_64).
- On `binary` matrix entries at tag refs:
  `pip install -r requirements.d/pyinstaller.txt && ./scripts/build-borg-using-pyinstaller.sh`
  builds both onefile and onedir binaries. Step "Smoke-test the built binary"
  runs `./borg.exe -V` for **both** layouts, and — the interesting bit — the
  subsequent "run tox env" step does:
  `# Ensure locally built binary in ./dist/binary/borg-dir is found during tests`
  `export PATH="$GITHUB_WORKSPACE/dist/binary/borg-dir:$PATH"` so the **entire
  pytest/tox suite executes with the frozen `borg` binary first in PATH** —
  the full functional suite, not just a smoke, drives the artifact that ships.
- Why: borg treats PR time as source-time (fast feedback, free of packaging
  cost) and moves the expensive 4-target frozen build + frozen-binary test
  run to the tag/release boundary, where every shipped binary is produced and
  exercised before attestation (`actions/attest-build-provenance`) and upload.

### 2e. wagga40/Zircolite — application example: PR "canary" leg + full matrix on tag/manual + weekly cron, pytest against the frozen exe

- Workflows: `.github/workflows/build_pyinstaller.yml` (GitHub, 5-target
  matrix) and `.forgejo/workflows/build_pyinstaller.yml` (self-hosted mirror,
  linux-x64 leg) in <https://github.com/wagga40/Zircolite>.
- Triggers: path-filtered `push`, `pull_request`, weekly `cron: "23 4 * * 1"`,
  and `workflow_dispatch`. The matrix is conditional:
  `target: ${{ fromJSON((github.event_name == 'pull_request' || ...branch push) && '["linux-x64"]' || '["linux-x64","linux-arm64","macos-arm64","windows-x64","windows-arm64"]') }}`
  — i.e. **PRs and branch pushes build and test ONE canary target** (linux-x64
  in a manylinux container); tags/manual runs build and test all five.
- What they assert against the built binary: the pytest suite includes
  `tests/test_frozen_binary.py` and `tests/test_e2e_regression.py`, run with
  `ZIRCOLITE_BINARY=dist/...` pointing at the PyInstaller output
  (Taskfile: `pyinstaller Zircolite.spec` then `pytest
  tests/test_frozen_binary.py tests/test_e2e_regression.py`). The job then
  unpacks the packaged archive, runs `./Zircolite --version`, a real parse of
  a fixture EVTX with rules, `--package`, checks the produced zip's manifest
  entries, and diffs detections output against a golden JSON file.

### 2f. Counter-examples (the gap we currently have, at scale)

- **mitmproxy/mitmproxy** `.github/workflows/main.yml`
  (<https://github.com/mitmproxy/mitmproxy/blob/main/.github/workflows/main.yml>):
  `on: push '**'`, `pull_request`, `merge_group` — the `build` job builds
  standalone PyInstaller binaries on macOS arm64/x64, Windows, Linux x64/arm64
  **on every PR**, but nothing ever executes them; tests (`tox -e py...`)
  run against source. Packaging breakage is caught at build time only;
  runtime frozen bugs are not caught at all.
- **Tribler/tribler** `.github/workflows/build.yml`
  (<https://github.com/Tribler/tribler/blob/main/.github/workflows/build.yml>):
  `on: workflow_dispatch` only; six OS/arch legs build installers; the only
  post-build check is `timeout 10s tribler -s || true` on the Debian legs — a
  smoke whose failures are explicitly tolerated (`|| true`), and the Windows
  .exe / macOS .dmg artifacts are uploaded without ever being launched.

## 3. Tauri official position: sidecars, tauri-action, and e2e against a built app

- **Sidecar embedding** (<https://tauri.app/develop/sidecar/>): binaries go in
  `bundle.externalBin`, each with a `-$TARGET_TRIPLE` suffix; spawned from Rust
  via `app.shell().sidecar(name)` (name only, no path) or from JS via
  `Command.sidecar(...)` gated by `shell:allow-execute`/`shell:allow-spawn`
  capabilities, where call-time args must "match[] EXACTLY what is specified
  in `capabilities/default.json`" (validators constrain dynamic args). The
  docs contain **no sidecar testing guidance** — the contract that matters
  (triple-suffixed name, spawn argv surface, stdout/stderr `CommandEvent`
  stream) is exactly what our tests must pin.
- **tauri-action** (<https://github.com/tauri-apps/tauri-action>): builds the
  app "as a native binary for macOS, Linux and Windows and optionally upload
  it to a GitHub Release". Its stated use cases include "test the build
  pipeline of your Tauri app"; omitting `tagName`/`releaseName`/`releaseId`
  yields a build-only run suitable for `actions/upload-artifact`. It is a
  build/release tool — **it runs no tests**; verification is left to whatever
  steps the workflow adds around it.
- **Sanctioned testing model** (<https://tauri.app/develop/tests/> and
  <https://tauri.app/develop/tests/webdriver/>): Rust-side unit/integration
  tests use Tauri's **mock runtime** ("native webview libraries are not
  executed"). End-to-end, "Tauri also provides support for end-to-end testing
  utilizing the WebDriver protocol": WebdriverIO with `@wdio/tauri-service`
  ("supports Windows, Linux, and macOS"; `driverProvider: 'embedded'`), or
  `tauri-driver` driven directly ("only Windows and Linux are supported on
  desktop, as macOS provides no desktop WebDriver client"). The service takes
  an explicit `appBinaryPath` (docs example: `'./src-tauri/target/release/
  my-tauri-app'`) — i.e. **tests drive a built binary, not a dev server**. A
  browser mode runs the frontend "in plain Chrome against a Vite dev server"
  with mocked `invoke()` for renderer-only tests.
- Practical consequence for us: our Playwright suite can keep covering the
  web renderer in PRs (that is Playwright's lane), but Playwright cannot
  attach to a Tauri shell (system WebView2/WKWebView, not Chromium). Any
  "packaged app" GUI e2e must go through the WebDriver path against a built
  binary — which is precisely the artifact-parity layer.

## 4. Pattern trade-offs — what real projects pick

| Pattern | Who does it | What it asserts | Cost / risk |
| --- | --- | --- | --- |
| (a) PR-gated full artifact build + functional test | pyinstaller, Nuitka, cx_Freeze; Zircolite (single canary leg per PR) | The exact artifact shape ships green; frozen-only bugs block the PR | Highest PR-minute cost (build per PR per OS); packagers accept it because the artifact is the product |
| (b) Tag/merge/nightly-gated artifact tests; PR = source tests | borg (tag-gated frozen build + full suite through frozen binary; PR = reduced source matrix); Zircolite (full 5-target matrix only on tag/manual + weekly cron); jupyterlab-desktop (PR e2e on dev Electron build, publish-time "Verify the snap can actually launch") | Every shipped binary is exercised before release; PRs stay fast | A frozen-only regression can land on `main` between releases and is caught only at tag/nightly — acceptable if releases cut from tested tags |
| (c) Local mandatory pre-release gate script | Zircolite (Taskfile wraps pyinstaller + `pytest tests/test_frozen_binary.py`); our `gui/scripts/sidecar-smoke.py` today | Owner-facing handoff checklist | Not enforceable; depends on discipline; pure defense-in-depth |
| (d) Contract tests pinning the spawn/CLI interface | Python docs (`freeze_support` contract); PyInstaller common-issues (spawn loop symptom); realized in practice as frozen-binary tests asserting the CLI surface (`--version`, entry forms) — pyi_builder's return-code assertions, Zircolite's `--version` + arg-driven run | Cheapest layer: catches interface drift (argv forms, entry points) before any artifact is built | Cannot catch bundling/runtime-data bugs; must be paired with artifact execution |

Observed synthesis: nobody who ships frozen binaries relies on source tests
alone at the release boundary — the reliable projects either gate the
artifact test on the PR (packagers; Zircolite's canary) or on the tag/release
plus a periodic refresh (borg; Zircolite cron). Counter-examples (mitmproxy,
Tribler) show the two failure modes of partial adoption: build-only gating
misses runtime frozen bugs; tolerated smoke (`|| true`) isn't a gate at all.

## RECOMMENDATION

Layered setup for FontAlloy (GitHub Actions, uv + PyInstaller onefile sidecar,
Playwright GUI suite, 3-platform matrix). Principle: every layer must drive
the shipped interface; the cheapest layer that can fail runs earliest.

1. **PR-time contract tests (source, Linux, `ci.yml`)** — cheap, always on.
   Pin the spawn interface the Tauri shell depends on:
   - unit test that `gui/scripts/sidecar_entry.py` calls
     `multiprocessing.freeze_support()` right after the main guard (static
     AST check — the failure is a no-op in source runs, per Python docs);
   - source-mode spawn test: launch the worker exactly the way the frozen
     bootloader does (spawn entry with the frozen argv form) and assert it
     comes up — this is the regression test for the `-m` argv bug;
   - serve-contract tests already exist in the core suite; keep them.
   Cost: seconds; no artifact build. Catches interface drift before any
   packaging step runs.

2. **PR-time artifact functional test (`sidecar.yml`)** — gate the merge.
   Add `pull_request:` with the same path filters already present
   (`core/**`, `cli/**`, sidecar scripts, the workflow file), keep
   `fail-fast: false`, keep the 3-triple matrix, and run the existing
   `sidecar-smoke.py` against each freshly built binary (it already asserts
   startup line, `/health`, one full build roundtrip, report summary, and
   tree-kills the bootloader's child — keep that). Extend it minimally with
   the frozen spawn exercise (spawn a worker via the binary the way the GUI
   does) so layer 1's contract is verified on the real artifact. Use
   `concurrency: cancel-in-progress: true` on PRs to kill superseded builds.
   Cost estimate per PR (only PRs touching core/cli/sidecar pay):
   per leg ~5–10 min wall (uv sync cached ≈ 1–2 min, PyInstaller onefile
   ≈ 3–7 min, smoke ≈ 1 min), three legs in parallel. In billed minutes
   (private repo; Linux 1x, Windows 2x, macOS 10x —
   <https://docs.github.com/en/billing/managing-billing-for-github-actions/about-billing-for-github-actions>,
   <https://docs.github.com/en/billing/reference/actions-runner-pricing>):
   ~8 min/leg ≈ 8 + 16 + 80 ≈ 104 min/PR. On a public repo the same run is
   free (wall-clock only). If macOS minutes dominate, Zircolite's canary
   split is the fallback: PR gates linux-x64 only; macOS/Windows legs run on
   merge to `main` and on tags.

3. **Merge/tag-time full-stack artifact test** — keep `sidecar.yml`'s push to
   `main`, and at release time build the actual `tauri build` bundle with the
   three sidecars via tauri-action (build-only, no `tagName`, then
   `upload-artifact`) and run a WebDriver e2e leg: WebdriverIO
   `@wdio/tauri-service` with `appBinaryPath` pointing at the built app, one
   smoke that launches the packaged shell, waits for the sidecar handshake,
   and drives one font build through the real GUI. This is the only sanctioned
   way to e2e a Tauri shell (Playwright cannot attach to WebView2/WKWebView),
   per <https://tauri.app/develop/tests/webdriver/>. Keep the Playwright
   suite as the fast renderer loop; it complements rather than replaces this.

4. **Local pre-handoff gate** — wrap what CI does into one script
   (`scripts/gate-release.py` or a make target): build sidecar for the host
   triple, run `sidecar-smoke.py`, run the spawn contract test, run the
   Playwright suite. Same code paths as CI (reuse the same scripts), so a
   local green means a CI green. Document it as mandatory before handing a
   build to the owner; it is defense-in-depth, never the only gate
   (Tribler's `|| true` shows what tolerated gates are worth).

Cost reasoning summary: layer 1 is free; layer 2 costs ~100 billable minutes
only on PRs that touch the Python core (path filters keep GUI/docs PRs at
zero), which at Pro-plan included minutes is a handful of core PRs per month;
layer 3 runs once per merge/tag (three tauri builds ≈ 15–25 min/leg); layer 4
is developer time only. That is the same bet pyinstaller/Nuitka/cx_Freeze
make for every PR, scaled down: canary-on-PR (all 3 triples while the repo is
small; drop to linux canary if minutes pinch), full artifact + bundled-app
e2e at the release boundary, and a pinned spawn contract test so the `-m`
class of bug is caught in seconds, not at handoff.

---

### Source index

- PyInstaller common issues & pitfalls: <https://pyinstaller.org/en/stable/common-issues-and-pitfalls.html>
- PyInstaller functional-test harness: <https://github.com/pyinstaller/pyinstaller/blob/develop/PyInstaller/utils/conftest.py>, `tests/functional/conftest.py`
- PyInstaller CI: <https://github.com/pyinstaller/pyinstaller/blob/develop/.github/workflows/ci.yml>
- Python `multiprocessing` / `freeze_support`: <https://docs.python.org/3/library/multiprocessing.html>
- Nuitka CI: <https://github.com/Nuitka/Nuitka/blob/develop/.github/workflows/testing.yml>
- cx_Freeze CI + functional tests: <https://github.com/marcelotduarte/cx_Freeze/blob/main/.github/workflows/ci.yml>, `tests/test_executables.py`
- borg frozen-binary CI: <https://github.com/borgbackup/borg/blob/master/.github/workflows/ci.yml>
- Zircolite frozen-binary tests: <https://github.com/wagga40/Zircolite> — `.github/workflows/build_pyinstaller.yml`, `.forgejo/workflows/build_pyinstaller.yml`, `tests/test_frozen_binary.py`, `tests/test_e2e_regression.py`
- mitmproxy (build-only counter-example): <https://github.com/mitmproxy/mitmproxy/blob/main/.github/workflows/main.yml>
- Tribler (tolerated-smoke counter-example): <https://github.com/Tribler/tribler/blob/main/.github/workflows/build.yml>
- jupyterlab-desktop e2e layering: <https://github.com/jupyterlab/jupyterlab-desktop/blob/master/.github/workflows/e2e.yml>, `.github/workflows/publish.yml`
- Tauri sidecar: <https://tauri.app/develop/sidecar/>
- Tauri testing overview: <https://tauri.app/develop/tests/>
- Tauri WebDriver e2e: <https://tauri.app/develop/tests/webdriver/>
- tauri-action: <https://github.com/tauri-apps/tauri-action>
- GitHub Actions billing/multipliers: <https://docs.github.com/en/billing/managing-billing-for-github-actions/about-billing-for-github-actions>, <https://docs.github.com/en/billing/reference/actions-runner-pricing>
