# FontAlloy WebApp

The static build target of the shared frontend — and since the
design-fidelity repair round 2, it mounts the SAME workspace app the
Tauri GUI mounts: the same top bar (GitHub link, font pair tags, output
font name, theme toggle, 合成字体), the same rail (font pickers,
language presets, custom rules, synthesis settings), the same character
map / scene stage and status bar. The WebApp is not a second UI; the
only differences are platform mechanics:

- **catalog source** — the desktop app downloads the release catalog
  into its app-data directory; the WebApp (dev server and `vite
  preview`) bootstraps the local dev catalog served at `/dev-catalog/`
  (the repo manifest's families, zipped from a local fonts directory —
  see `gui/scripts/dev-catalog.mjs`). A deployed static bundle stays
  catalog-free unless an injected config names an origin.
- **the merge service** — the desktop app starts its bundled sidecar;
  the WebApp probes a local `fontalloy serve` on load (issue #22): the
  `?serve=` query parameter, defaulting to `http://127.0.0.1:7777`:

  ```
  fontalloy serve --port 7777 --allow-origin <this site's origin>
  # then open:  <site-url>/?serve=http://127.0.0.1:7777   (or just the
  #             site URL — 7777 is the default probe target)
  ```

  `--allow-origin` must name the origin the page is served from (the
  CORS allowlist is the whole point). A refused connection, a timeout,
  or a CORS block is a handled state: clicking 合成字体 opens the
  workspace's no-service panel — the absorbed recipe-builder flow —
  offering the recipe YAML (built from the same picks/rules/settings
  the service flow would submit) as a download plus the copyable
  `fontalloy build` command that reproduces the same merge.
- **saving artifacts** — round 12's output-directory save becomes a
  browser download on this target (the browser manages where downloads
  land, so the 设置 → 输出目录 entry does not render here); 另存为 is a
  second download of the same bytes. The build panel renders the run's
  progress and verification report identically on both targets.

## One codebase, two build targets

The WebApp is not a second frontend. `gui/src/` is the shared frontend
source and compiles into both targets:

```
gui/                     target 1: the Tauri 2 desktop shell
  index.html             GUI entry -> src/main.ts (the workspace)
  src/                   THE shared frontend source
    state.ts             createStore (generic) + the workspace store
    platform/            environment adapter (tauri | web) — the only
                         place that sniffs the runtime (config seams:
                         catalog bootstrap, serve address, artifact saver)
    recipe/              recipe model + validation mirror + YAML/JSON writers
    data/                generated static JSON (committed; see below)
  tests/                 seam-3 Playwright suite (GUI target)

web/                     target 2: the static site
  index.html             WebApp entry -> ../gui/src/main.ts (the SAME
                         workspace entry the GUI uses)
  vite.config.ts         base "./", the dev-catalog plugin (dev + preview),
                         VITE_WEB_CATALOG=1 (the built bundle boots the
                         local catalog under vite preview)
  playwright.config.ts   seam-3 suite against the BUILT site
  tests/                 the WebApp specs (drive the workspace)
  scripts/render-static-data.py   regenerates gui/src/data/*.json
```

The entry point is the only per-target file; everything else is shared
source typechecked once by the GUI target's `tsc -b`. The two npm
packages (`gui/`, `web/`) each install their own dev toolchain so
neither target's lockfile constrains the other.

## Static data

`gui/src/data/catalog.json` and `presets.json` are committed snapshots
rendered from the repo's own truth — no live serve dependency:

- catalog: `assets/fonts.manifest.json` (family, variant, version, the
  `fontalloy assets fetch` path hint, SPDX id, RFN flag);
- presets: `fontalloy_core.presets` — every fc-lang language with its
  codepoint count and sub-block structure (zh_hk = zh_tw +
  zh_hk_supplement), plus the standalone selectable sets.

`gui/src/data/curated-meta.json` overlays the prototype's curated
display data (GitHub stars, Chinese trait tags) onto the picker rows.
Regenerate the snapshots after changing the manifest or the corpus:

```bash
python web/scripts/render-static-data.py   # or: uv run python …
```

Deterministic (sorted, no timestamps), so regeneration is a no-op diff
until the inputs change.

## Commands

```bash
cd web
npm install
npm run build        # vite build -> dist/ (relative paths, any host)
npm run preview      # serve dist/ (http://localhost:4173) + /dev-catalog
npm run test:e2e     # seam-3 Playwright suite (builds, then previews)
npm run dev          # dev server (http://localhost:5174) + /dev-catalog
```

## Testing (seam 3)

`tests/` drives the built WORKSPACE through Playwright with the spec's
mandatory conventions (real pointer events + elementFromPoint guards,
DOM textContent assertions, zero-JS-errors gate; see
`gui/tests/helpers.ts` for the shared rationale — `web/tests/helpers.ts`
mirrors them per target). The no-service panel's YAML is asserted
semantically (parsed and compared against the workspace state) and its
JSON twin — the body the live flow POSTs — stays pinned by
`tests/fixtures/sample-recipe.json` against the core loader
(`tests/test_webapp_recipe.py` in the repo root).

The live-merge tests (`tests/live-merge.spec.ts`) run against a REAL
`fontalloy serve` instance: `tests/serve.ts` spawns it through the
project env (`uv run fontalloy serve`, ephemeral port, the ready URL
read from stdout) with synthetic fixture fonts from
`scripts/make-serve-fixture-fonts.py`, and the assertions cover the
`?serve=` detection, the submitted JSON body verbatim, the build
panel's journal and report rendering, the browser-download artifact,
inline failures, and both sides of the CORS boundary. The
zero-JS-errors gate has a benign-error policy: the browser's own
console line for an intentionally refused/blocked probe is declared
per test (`allowProbeRefusal`), never silently excused.

## Deploying

The build is a pure static bundle with relative asset URLs (`base:
"./"`), so any static host works without configuration.

- **GitHub Pages** (the committed path): `.github/workflows/webapp.yml`
  builds `web/` and deploys `web/dist` on pushes to `main` that touch
  the shared source or the WebApp target. Pages must be set to
  "GitHub Actions" as the build source (repo Settings → Pages) — a
  one-time manual step.
- **Vercel** (alternative, no file needed): set the project root to
  `web/`, build command `npm run build`, output directory `dist`.
  Relative paths make preview URLs work as-is.
