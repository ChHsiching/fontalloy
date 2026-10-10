# FontAlloy GUI

The desktop client: a [Tauri 2](https://v2.tauri.app) shell around the shared
FontAlloy frontend (the same source the WebApp will build from — see
`docs/DESIGN.md`, "Architecture"). Implements GitHub issue #15 (the
split-pane workspace of ADR-0004, local font loading through
`FontFace(arrayBuffer)`, the character map) and issue #17 (the first-run
catalog download with self-rendering font pickers).

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
  this shell hosts the window and the catalog storage.

## Layout

```
gui/
  index.html, vite.config.ts     Vite entry (the shared frontend)
  src/                           Frontend source (GUI + future WebApp)
    state.ts                     tiny store; region-scoped re-render
    fonts/sfnt.ts                minimal sfnt reader (name + cmap coverage)
    fonts/registry.ts            shared FontFace(arrayBuffer) registration
    catalog/release.ts           catalog-release@v1 metadata parser (strict)
    catalog/zip.ts               minimal zip reader (stored + deflate)
    catalog/manager.ts           first-run downloader + face registration
    catalog/screen.ts            first-run progress screen (dismissable)
    platform/config.ts           runtime config (bootstrap URL injection)
    platform/storage.ts          injectable blob storage (IDB / appDataDir)
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

## Catalog download (issue #17)

On every launch the app (when a bootstrap origin is configured — see below)
fetches `catalog-release.json` — the delivery-truth document from #14 —
and reconciles it against storage:

- A family counts as **verified** when its `.complete` marker and every
  face file are present. Verified families are skipped; only missing ones
  download. That single mechanism is both the first-run download and the
  retry-on-later-launches behavior.
- Each family zip is fetched through the **ordered origin list**
  (zip sha256 verified), extracted, every face verified against its pinned
  sha256 **in memory**, and only then written. A mid-write crash leaves no
  marker, so the next launch re-downloads that family.
- **Failures never block startup**: the workspace is mounted and usable
  before any download starts; the progress screen is dismissable (跳过) and
  closes itself when the run settles; failed families show as 未下载 rows
  in the pickers and retry next launch.
- Verified families register their primary face (Regular preferred) as a
  **lazy** `FontFace(arrayBuffer)` — the same path as local files — so
  picker rows self-render in their own font while the browser loads each
  face only when something actually renders in it.

### Storage layout

```
{appDataDir}/catalog/catalog-release.json            bootstrap copy
{appDataDir}/catalog/families/<family>/<face>.ttf    extracted, verified faces
{appDataDir}/catalog/families/<family>/.complete     written LAST (see above)
```

`<family>` is percent-encoded, so a key never contains separators from
metadata. Under Tauri the root is `appDataDir()` written through the fs
plugin (scope: `$APPDATA/catalog/**` only — see
`src-tauri/capabilities/default.json`); this is the layout the core sidecar
will read. In plain-browser builds the same keys live in IndexedDB
(`fontalloy-storage`), which is what the Playwright suite exercises.

### Bootstrap configuration

`src/platform/config.ts` decides where `catalog-release.json` comes from:

- **Tauri** (`__TAURI_INTERNALS__` present): the GitHub release tag
  `font-catalog-v1` on `ChHsiching/fontalloy`.
- **Plain browser**: **no bootstrap by default** — a dev page must never
  start downloading the real ~375 MB catalog. Tests and future WebApp
  builds inject an origin before the app boots:

```ts
await page.addInitScript(() => {
  window.__FONTALLOY_CONFIG__ = { catalogBootstrapUrl: "https://…" });
});
```

## Testing (seam 3)

`tests/` drives the real UI through Playwright with the rules fixed by the
spec (issue #1, "Testing Decisions"):

- real pointer/mouse events, guarded by `elementFromPoint` hit tests before
  every click (see `tests/helpers.ts`);
- assertions read DOM text content and geometry, never pixels;
- screenshots must capture open-overlay states (`tests/screenshots.spec.ts`
  opens a picker popup and the first-run catalog screen before capturing);
- a zero-JS-errors gate wraps every test;
- `document.fonts.ready` is awaited before asserting rendered text.

The suite needs **two distinct real font files** on the host (font binaries
never enter git). It picks the first two of: `FONTALLOY_TEST_FONT_1` /
`FONTALLOY_TEST_FONT_2` env overrides, then a list of common system font
paths (Windows/Linux/macOS). The two files must cover U+0041; every candidate
does. On a machine without those fonts, set the env overrides.

The catalog tests (`tests/catalog.spec.ts`) simulate the origin with
`page.route` interception over the real metadata schema
(`tests/catalog-fixtures.ts` builds actual zips — stored and deflate — with
pinned sha256s). Per-family failure modes, deferred gates, and request
counters make the first-run flow deterministic; because storage persists
across `page.reload()` within a test context, a reload is a genuine later
launch. Tests that deliberately abort requests declare the resulting
`net::ERR_*` console lines as expected (the §6 benign-error policy); every
other error still fails the gate.

## Verification status (this ticket)

Verified in this environment (Windows, Git Bash):

- `npm run test:e2e` — full seam-3 suite (31 tests: 21 from #15 + the
  catalog flow, retry, offline, and picker tests from #17) against the
  Vite dev server.
- `npm run build` — TypeScript strict compile + production bundle.
- `cargo check` in `src-tauri/` — the Tauri 2 shell with the fs plugin
  and the catalog-scope capability compiles (tauri 2.12, WebView2 backend).

NOT verified here:

- The real ~375 MB catalog download (the release tag has no assets yet —
  the workflow from #14 has not run; the downloader is exercised against
  the simulated origin only).
- `npm run tauri build` installers, and macOS / Linux builds (no
  toolchains for those targets in this environment).
- The GitHub Actions workflow (`.github/workflows/gui-e2e.yml`) — the
  branch is local-only; the workflow has not had a CI run yet.

## Scope notes

- The synthesize action is present but `aria-disabled`; clicking it shows a
  plain-text notice. Real synthesis arrives with the sidecar ticket (#16).
- The catalog downloads entirely from the webview layer; the sidecar does
  not participate yet (#16 wires it and reads the same storage layout).
- TTC collections parse for metadata; the FontFace decoder may still reject
  them, which surfaces as an inline error message.
- The preview grid renders the loaded fonts through a CSS font stack; it is
  not yet the effective merged result (that needs the merge pipeline).
