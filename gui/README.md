# FontAlloy GUI

The desktop client: a [Tauri 2](https://v2.tauri.app) shell around the shared
FontAlloy frontend (the same source the WebApp will build from — see
`docs/DESIGN.md`, "Architecture"). Implements GitHub issue #15 (the
split-pane workspace of ADR-0004, local font loading through
`FontFace(arrayBuffer)`, the character map), issue #17 (the first-run
catalog download with self-rendering font pickers), and issue #16 (the
core bundled as a binary sidecar — the synthesize action drives real
merges over the serve contract, saves the output into the configured
output directory (round 12: dialog-free, with a 另存为 affordance for
the native dialog), and renders the verification report).

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
  The merge capability is a core binary sidecar (`fontalloy serve`, issue
  #16): the shell spawns it with an ephemeral port, the webview talks the
  localhost HTTP contract (seam 2's tested surface), and the catalog the
  webview downloads is the same `--font-dir` the service enumerates.

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
    platform/artifacts.ts        artifact saver (native dialog / injected)
    platform/localfonts.ts       native font dialog with real paths (Tauri)
    service/client.ts            the serve HTTP client (typed, seam 2)
    service/synthesize.ts        connect + submit + poll + save + report
    recipe/json.ts               draft -> recipe-shaped JSON (POST /builds)
    unicode/blocks.ts            curated block hierarchy + "all" aggregate
    ui/                          topbar, rail, pickers, charmap, statsbar
    ui/buildpanel.ts             synthesis progress + report (non-modal)
  src-tauri/                     Tauri 2 shell (config, capabilities, icons,
                                 sidecar spawn + dialog/IPC commands)
  src-tauri/binaries/            the built sidecar (gitignored, per-triple)
  scripts/make-icons.mjs         placeholder icon generator (no deps)
  scripts/e2e_fonts.py           synthetic fixtures for the synthesize e2e
  scripts/build-sidecar.py       PyInstaller build of the sidecar binary
  scripts/sidecar_entry.py       the frozen entry (the typer CLI app)
  scripts/sidecar-smoke.py       serve round trip through the built binary
  tests/serve.ts                 spawns the REAL service for the e2e suite
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

## The sidecar and synthesis (issue #16)

The desktop app's merge capability is the bundled `fontalloy` binary run
as `fontalloy serve` — the localhost HTTP service whose contract seam 2
pins (`tests/test_cli_serve.py`). Nothing about merging lives in the
frontend: it submits recipe-shaped JSON, polls `GET /builds/{id}`, and
downloads the artifact + report.

### Packaging: PyInstaller, per platform

`bundle.externalBin: ["binaries/fontalloy"]` in `tauri.conf.json` means
`src-tauri/binaries/fontalloy-<target-triple>[.exe]` must exist before
`cargo check`, `tauri dev`, or `tauri build`. Build it for the host:

```bash
uv run --with pyinstaller python gui/scripts/build-sidecar.py
# -> gui/src-tauri/binaries/fontalloy-<host-triple>[.exe]  (~17 MB)
python gui/scripts/sidecar-smoke.py gui/src-tauri/binaries/fontalloy-*.exe
```

Why PyInstaller over shiv/zipapp: a zipapp still needs a Python on the
target machine, violating the spec's "merges run natively without a
Python install" (story 46). PyInstaller freezes the interpreter +
fontTools + fontalloy into one self-contained executable; `--onefile`
matches externalBin's single-file naming, and `--collect-submodules`
counters fontTools' lazy imports. Binaries are gitignored — CI
(`.github/workflows/sidecar.yml`) builds the three shipped triples
(x86_64-pc-windows-msvc, aarch64-apple-darwin,
x86_64-unknown-linux-gnu) on their native runners, smoke-tests each,
and uploads them as artifacts for the desktop release job.

### What the shell does at startup

`src-tauri/src/lib.rs` spawns the sidecar as
`serve --port 0 --font-dir {appDataDir}/catalog/families --allow-origin
<webview origins>`; the bound URL is parsed from the startup stdout line
(`http://127.0.0.1:<port>`, ticket #11's discovery contract) and handed
to the frontend through the `serve_url` command (plus a `serve-ready`
event); the child is killed on app exit. A spawn failure degrades to
"service unavailable" — the app stays usable. The shell also owns the
native dialogs (`pick_font_files` / `prepare_save` / `pick_output_dir`)
and the raw-IPC byte pipes (`read_font_file` / `save_artifact`) so
recipes get real absolute paths and saved artifacts never serialize
megabytes through JSON. `default_output_dir` resolves the round-12
output directory (`<OS Downloads>/fontalloy`, the app-data fonts dir
as the headless fallback) and `park_save_path` joins the dialog-free
save target.

### The synthesize flow

1. **Connect** (`src/service/synthesize.ts`): resolve the service URL —
   injected config first, then the Tauri shell — probe `/health`, index
   `/fonts`. The top bar shows the state as text (本地服务：已连接).
2. **Enable**: the 合成 action unlocks when the service is connected AND
   both the EN (base) and CJK (donor) fonts are picked; otherwise it
   stays `aria-disabled` with a click-reachable reason.
3. **Submit**: the recipe is built from the GUI state through the shared
   recipe modules (#21) and `recipe/json.ts`; font paths are the
   platform's own (catalog storage, native dialog) or resolved against
   the service's `/fonts` listing (basename match). Unresolvable fonts
   fail inline before any build exists.
4. **Progress**: the build panel (fixed, non-modal, bottom-right) shows
   a stage stepper (读取字体 … 生成报告) fed by 250ms polling (1Hz while
   queued). The workspace stays fully interactive; clicking 合成 again
   queues another build (the service serializes them, `queue_position`
   is displayed).
5. **Save + report**: on completion the artifact goes through the
   platform's DEFAULT-PATH saver (round 12) — the configured output
   directory (设置 → 输出目录; default `<OS Downloads>/fontalloy`),
   no dialog anywhere in the path; the completed row shows the full
   path and carries a 另存为 button (the native dialog on demand,
   falling back to the default directory with a plain notice when the
   dialog cannot open). The verification report renders from the
   machine JSON (sources, coverage summary, precedence counts, weight
   borrows, plus the raw JSON under 原始报告). Failures — resolution,
   HTTP 400, a pipeline failure — surface as inline panel text; there
   are no modal dialogs anywhere in the flow.

### Dev and e2e without Tauri

The Playwright suite runs the same frontend against the Vite dev server,
so the "sidecar" is a REAL `fontalloy serve` subprocess spawned by the
test bootstrap (`tests/serve.ts`) with the same flags the shell passes —
ephemeral port, `--allow-origin http://localhost:5173`, `--font-dir`
pointing at generated fixture fonts (`scripts/e2e_fonts.py`; the donor
carries ~30k glyphs so a build takes ~2s and progress is observable
mid-flight). The address is injected through the same
`window.__FONTALLOY_CONFIG__` bootstrap the shell's `serve_url` feeds,
and the artifact saver is injected the same way (backed by
`page.exposeFunction`, so the test parses the actual saved file: sfnt
magic, output family `ChHsich`, merged coverage from the cmap).

### Contract decisions from ticket #11's open points

- **No source-font-bytes endpoint added.** The webview reads font bytes
  through its own platform paths (catalog storage, native dialog, the
  raw-IPC command); serve's `/fonts` stays a metadata listing. The
  WebApp ticket (#22) may revisit for in-browser preview.
- **No resolve-only endpoint added.** #16 needs build + report only;
  the preview grid's precedence resolution is client-side (issue #18).

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

- `npm run test:e2e` — full seam-3 suite (37 tests: the #15/#17 suites
  plus the five synthesize tests of #16, driven against a REAL
  `fontalloy serve` subprocess) against the Vite dev server.
- `npm run build` — TypeScript strict compile + production bundle.
- `cargo check` in `src-tauri/` — the Tauri 2 shell with the fs, shell,
  and dialog plugins, the sidecar spawn, and the capability set compiles
  (tauri 2.12, WebView2 backend). The externalBin presence check in
  build.rs passes with the built binary in place.
- The PyInstaller sidecar binary builds (16.7 MB) and passes the serve
  smoke round trip (`scripts/sidecar-smoke.py`: startup line, /health,
  a real merge, artifact magic bytes, report summary).

NOT verified here:

- `npm run tauri dev` / `tauri build` end to end (the runtime sidecar
  spawn, the native dialogs, and the raw-IPC save path compile and
  follow the documented plugin APIs, but no interactive desktop run
  happened in this environment).
- macOS / Linux sidecar binaries (cross-builds are CI-side;
  `.github/workflows/sidecar.yml` has not had a run yet).
- The real ~375 MB catalog download (the release tag has no assets yet —
  the workflow from #14 has not run; the downloader is exercised against
  the simulated origin only).
- The GitHub Actions workflows (`gui-e2e.yml` now sets up uv for the
  serve subprocess; `sidecar.yml` is new) — the branch is local-only;
  neither has had a CI run yet.

## Scope notes

- The recipe the synthesize flow submits is the GUI pair (EN base, CJK
  donor) with the fixed brand output name; custom rules, presets, and
  normalization switches land with the rail editors (issue #18) and will
  feed the same `recipe/json.ts` serializer.
- The catalog downloads entirely from the webview layer; the sidecar only
  READS the same storage layout through `--font-dir`.
- TTC collections parse for metadata; the FontFace decoder may still reject
  them, which surfaces as an inline error message.
- The preview grid renders the loaded fonts through a CSS font stack; it is
  not yet the effective merged result (that needs the merge pipeline).
