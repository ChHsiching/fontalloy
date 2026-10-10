# FontAlloy GUI

The desktop client: a [Tauri 2](https://v2.tauri.app) shell around the shared
FontAlloy frontend (the same source the WebApp will build from — see
`docs/DESIGN.md`, "Architecture"). Implements GitHub issue #15: the
split-pane workspace (ADR-0004), local font loading through
`FontFace(arrayBuffer)`, and the character map.

## Stack, and why

- **Vite + TypeScript, no UI framework.** ADR-0004's carried constraints are
  all about precise DOM control: the picker popup node must survive
  re-renders (rows rebuild only), entrance animations must not leave
  stacking contexts, and open/close run through `allow-discrete` +
  `@starting-style` transitions. A virtual-DOM framework adds re-render
  semantics we would constantly fight; a small store plus region-scoped
  render functions (`src/state.ts`, `src/ui/*`) gives the exact node
  control the ADR demands, and keeps the future static WebApp build light.
- **Tauri 2** for the desktop shell on Windows/macOS/Linux, per ADR-0002.
  The merge capability will arrive as a core binary sidecar (later ticket);
  this shell only hosts the window.

## Layout

```
gui/
  index.html, vite.config.ts     Vite entry (the shared frontend)
  src/                           Frontend source (GUI + future WebApp)
    state.ts                     tiny store; region-scoped re-render
    fonts/sfnt.ts                minimal sfnt reader (name + cmap coverage)
    fonts/registry.ts            FontFace(arrayBuffer) local loading path
    unicode/blocks.ts            curated block hierarchy + "all" aggregate
    ui/                          topbar, rail, pickers, charmap, statsbar
  src-tauri/                     Tauri 2 shell (config, capabilities, icons)
  scripts/make-icons.mjs         placeholder icon generator (no deps)
  tests/                         seam-3 Playwright suite (see below)
```

## Commands

```bash
npm install          # once
npm run dev          # frontend dev server (http://localhost:5173)
npm run test:e2e     # seam-3 Playwright suite (starts the dev server itself)
npm run build        # tsc -b && vite build -> dist/
npm run tauri dev    # desktop shell in dev mode (needs Rust + WebView2)
npm run tauri build  # installers (needs Rust + platform SDKs)
node scripts/make-icons.mjs   # regenerate the placeholder icons
```

## Testing (seam 3)

`tests/` drives the real UI through Playwright with the rules fixed by the
spec (issue #1, "Testing Decisions"):

- real pointer/mouse events, guarded by `elementFromPoint` hit tests before
  every click (see `tests/helpers.ts`);
- assertions read DOM text content and geometry, never pixels;
- screenshots must capture open-overlay states (`tests/screenshots.spec.ts`
  opens a picker popup before capturing);
- a zero-JS-errors gate wraps every test;
- `document.fonts.ready` is awaited before asserting rendered text.

The suite needs **two distinct real font files** on the host (font binaries
never enter git). It picks the first two of: `FONTALLOY_TEST_FONT_1` /
`FONTALLOY_TEST_FONT_2` env overrides, then a list of common system font
paths (Windows/Linux/macOS). The two files must cover U+0041; every candidate
does. On a machine without those fonts, set the env overrides.

## Verification status (this ticket)

Verified in this environment (Windows, Git Bash):

- `npm run test:e2e` — full seam-3 suite against the Vite dev server.
- `npm run build` — TypeScript strict compile + production bundle.
- `cargo check` and `cargo build` in `src-tauri/` — the Tauri 2 shell
  compiles and links a debug binary (tauri 2.12, WebView2 backend).
- Launch smoke test: with the Vite dev server running, the debug
  `fontalloy-gui.exe` starts, spawns its WebView2 children, and stays
  alive (process-level evidence; the window contents were not captured
  natively — visual verification went through the Playwright suite).

NOT verified here:

- `npm run tauri build` installers, and macOS / Linux builds (no
  toolchains for those targets in this environment).
- The GitHub Actions workflow (`.github/workflows/gui-e2e.yml`) — the
  branch is local-only; the workflow has not had a CI run yet.

## Scope notes

- The synthesize action is present but `aria-disabled`; clicking it shows a
  plain-text notice. Real synthesis arrives with the sidecar ticket.
- Font loading is user-local files only (the catalog download is a later
  ticket). TTC collections parse for metadata; the FontFace decoder may
  still reject them, which surfaces as an inline error message.
- The preview grid renders the loaded fonts through a CSS font stack; it is
  not yet the effective merged result (that needs the merge pipeline).
