# FontAlloy WebApp

The static build target of the shared frontend: the recipe builder
(issue #21). Build a `fontalloy` recipe in the browser — base/donor
selection from the catalog, precedence rules including the fc-lang
language presets, output naming — and walk away with a downloadable
recipe YAML plus a copyable `fontalloy build` command that reproduces
the same merge. Live merging needs the local service (`fontalloy
serve`, ticket #22 wires the probe); until then the copy-CLI fallback
is the default rendering.

## One codebase, two build targets

The WebApp is not a second frontend. `gui/src/` is the shared frontend
source and compiles into both targets:

```
gui/                     target 1: the Tauri 2 desktop shell
  index.html             GUI entry -> src/main.ts (split-pane workspace)
  src/                   THE shared frontend source
    state.ts             createStore (generic) + the GUI workspace store
    platform/            environment adapter (tauri | web) — the only
                         place that sniffs the runtime
    recipe/              recipe model + validation mirror + YAML writer
    webapp/              the WebApp feature (builder, listbox, result,
                         service notice) — web-only, GUI never imports it
    data/                generated static JSON (committed; see below)
  tests/                 seam-3 Playwright suite (GUI target)

web/                     target 2: the static site
  index.html             WebApp entry -> ../gui/src/webapp/main.ts
  vite.config.ts         base "./" (relative asset URLs), root = web/
  playwright.config.ts   seam-3 suite against the BUILT site
  tests/                 the WebApp specs (+ fixtures/sample-recipe.yaml)
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

Regenerate after changing the manifest or the corpus:

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
npm run preview      # serve dist/ (http://localhost:4173)
npm run test:e2e     # seam-3 Playwright suite (builds, then previews)
npm run dev          # dev server (http://localhost:5174)
```

## Testing (seam 3)

`tests/` drives the built site through Playwright with the spec's
mandatory conventions (real pointer events + elementFromPoint guards,
DOM textContent assertions, zero-JS-errors gate; see
`gui/tests/helpers.ts` for the shared rationale — `web/tests/helpers.ts`
mirrors them per target). The generated YAML is asserted semantically:
the test parses it (`yaml`) and compares against the builder state —
including preset rules — and against `tests/fixtures/sample-recipe.yaml`,
which the core suite (`tests/test_webapp_recipe.py` in the repo root)
proves parses through the strict `fontalloy_core.load_recipe`. Same
builder state, same merge: page ⇔ fixture ⇔ core loader.

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
