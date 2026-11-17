# Test what you ship: packaged-artifact parity gates at every boundary

Status: accepted (P0 — the r31v2 acceptance incident: source-green, frozen-red, shipped to the owner)

Every automated suite (pytest, GUI seam-3 Playwright, webapp e2e) drove the core from the uv source venv. The only workflow that builds the PyInstaller sidecar (`sidecar.yml`) runs on pushes to `main` and `workflow_dispatch` — never on PRs — and its smoke exercises `serve` + `/health` + one build roundtrip, never the catalog worker path. A frozen-only defect (ADR-0008) therefore passed every gate it could see. Dev behavior and production behavior diverged because nothing tested production's artifact at the boundary where it is decided.

## Decision

Four layers, matching the de-facto standard of reliable frozen-binary shippers (PyInstaller's own `pyi_builder` PR harness; Nuitka, cx_Freeze, borg, Zircolite precedents — sources in the research note):

1. **PR-time contract tests** (ci.yml, cheap, always): pin the spawn interface — the packaged exe accepts `--fontalloy-worker` and exits with worker semantics; the source path runs `python -m`. This is the exact `-m` bug class, caught in minutes.
2. **PR-time artifact tests** (sidecar.yml gains `pull_request` + the existing path filters): build all three triples, run the extended `sidecar-smoke.py` — spawn the exe's worker directly on a small job AND assert `/catalog/families` documents carry non-empty cuts with faces through the worker path. Public-repo runners are free; the Linux-only canary split is the fallback if minutes pinch.
3. **Merge/tag-time packaged-shell smoke**: tauri bundle + WebdriverIO `@wdio/tauri-service` against the built app (tauri-driver; Playwright cannot drive the system WebView).
4. **Local pre-handoff gate**: one script wrapping the same build + smoke + the owner-scenario serve probe; mandatory before any build is handed to the owner for manual acceptance.

Source-mode e2e stays for iteration speed — but the release boundary never trusts source tests alone. The counter-examples (mitmproxy, Tribler tolerate `|| true` smoke) are explicitly rejected as our model.

## Consequences

- The handoff claim "the sidecar binary is current with this core" becomes a checked fact (the gate rebuilds or verifies the binary), never an assertion.
- The r31v2 stale-binary failure mode (owner tested a Nov-1 exe missing Nov-3 fixes) is structurally closed by the same gate: no handoff with an older binary than the tree.
- Sourced analysis: `docs/research/dev-prod-parity-testing.md`.
