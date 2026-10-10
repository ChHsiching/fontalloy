# FontAlloy

> Merge multiple fonts into one, driven by codepoint rules.

**FontAlloy** solves the CJK font pain for people who code: give an English coding font (e.g. JetBrains Mono NF) its own Chinese glyphs (e.g. Maple's CJK), so terminal users stop fighting font fallback configuration. Pick a base font, a donor, and the language coverage — get one font file out.

## Status

Design is settled ([docs/DESIGN.md](docs/DESIGN.md)); implementation has started at the core. The three sentences that matter:

1. Everything is a "codepoint range → ordered font list"; language presets are just ranges chosen for the user in advance.
2. Absence never overrides presence — one invariant that replaces all special-case protection logic.
3. `core` is the only capability layer; CLI / GUI / Web are all consumers of it. Merge logic exists exactly once.

What works today: the core skeleton, the precedence engine, glyph grafting, normalization, the output identity rewrite, the weight/style matrix, and the verification report — `fontalloy build <recipe.yaml>` loads and validates the base and donor fonts, resolves layered precedence rules (single codepoint > custom range > named set > global default; last declared wins within a layer; absence never overrides) into the effective table, grafts the donor glyphs into the base font per that table (composite closure included, CFF donors converted to TrueType outlines) with a rebuilt cmap — each donor glyph normalized onto the base face's metrics (upem unified, the terminal 2:1 grid by default with the optical ratio as a recipe knob, UAX #11 advances, usWin grown only to prevent clipping) — rewrites the name table (the full record set on both platform encodings, nameID 16/17 consistent with 1/2, the fixed brand default `ChHsich` unless the recipe overrides `output.family`) and corrects OS/2 (xAvgCharWidth per the OpenType a–z formula, weight class inherited from the base, the PANOSE mono digits), and emits the verification report (`fontalloy/verification-report@v2`): per-codepoint provenance (which font won, through which rule, as a fill or an override; `in_output` read back from the built font), the rule declarations, the same-layer conflict list, the codepoint coverage with explicit per-rule gaps, the weight borrow table (which donor weight landed in which output weight, chosen how), and the before/after metric comparison with the untouched-line-height proof — as a machine-readable JSON plus a rendered human-readable HTML beside it, with the terminal form printed on the CLI. Recipes accept `rules`, `sets`, `normalization`, and `output` on top of `base`/`donors`, plus `weights` to select the requested weight/style matrix (the base file's faces by default; donor families match their nearest OS/2 usWeightClass per slot, per-weight overrides win, a multi-slot matrix packages as one TTC); language presets are bundled from fontconfig's fc-lang corpus as named-set data — every fc-lang language is selectable by name (zh_hk presents Traditional Chinese plus its supplement as toggleable sub-blocks).

## Development setup

Requirements: Python 3.11+ and [uv](https://docs.astral.sh/uv/).

```console
uv sync                                   # create .venv and install core, cli, and dev tools
uv run pytest                             # run the full test suite
uv run fontalloy build <recipe.yaml>      # run the CLI from the worktree
uv run fontalloy assets fetch             # download the catalog into assets/fonts (sha256-verified)
```

The repository is a uv workspace: `core/` (distribution `fontalloy-core`) and `cli/` (distribution `fontalloy`) are built and installed together from one lockfile. Test fixture fonts are small synthetic fonts generated in-test with fontTools — the repo never contains font binaries.

## Layout

```
core/          pure-Python library (fontTools pipeline), the only capability layer
cli/           thin shell (typer), calls core directly
gui/           Tauri 2 desktop app (Windows / macOS / Linux)
web/           pure static site (github.io / vercel, shares frontend components with gui)
data/presets/  language charset presets (fc-lang .orth)
recipes/       official recipes (output font = recipe × pinned source fonts, CI-reproducible)
```

`fontalloy serve` runs a localhost HTTP service (bound to 127.0.0.1 only); both the desktop GUI and the WebApp consume it. When the WebApp cannot reach the service, it degrades to a "copy CLI command" button.

The validated GUI prototype (split-pane workspace) lives on the `prototype/gui` branch, not on `main` — see [docs/adr/0004-gui-split-pane-workspace.md](docs/adr/0004-gui-split-pane-workspace.md).

## Fonts

This repo ships no font binaries — the catalog is data. A committed manifest ([assets/fonts.manifest.json](assets/fonts.manifest.json)) pins every family (upstream version, URL, sha256, SPDX license, reserved-name flag); `fontalloy assets fetch` downloads and verifies it into the gitignored `assets/fonts/` directory (zip faces are extracted beside the verified archives), and `fontalloy assets notices` regenerates [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) from the manifest. The per-family license audit lives in [docs/catalog/license-audit.md](docs/catalog/license-audit.md). Installers bundle no fonts: the app downloads the full catalog on first run and retries missing families on later launches. Merged-output fonts default to a fixed name (`ChHsich`), never derived from source font names. See [docs/adr/0005-font-catalog-manifest-first-run-download.md](docs/adr/0005-font-catalog-manifest-first-run-download.md) and [docs/research/font-assets-strategy.md](docs/research/font-assets-strategy.md).

### Catalog release

CI republishes the consolidated catalog to a dedicated release tag ([`font-catalog-v1`](https://github.com/ChHsiching/fontalloy/releases/tag/font-catalog-v1)), which is the app's download origin — upstream URLs stay recorded as provenance in the manifest. The [catalog-release workflow](.github/workflows/catalog-release.yml) runs only when the catalog data changes (a push to `main` touching the manifest, the license files, or the workflow itself) or on manual dispatch — never on every push. It fetches per the manifest (sha256-verified), stages the release with `fontalloy assets package` — one zip per family (all faces plus the license file), a `SHA256SUMS` file, `catalog-release.json` metadata, and the generated notices — and uploads everything to the tag. `catalog-release.json` carries the ordered download origin list; v1 ships exactly one origin (GitHub Releases), so adding a China mirror later is a metadata edit, not a code change. Packaging writes no wall clock, so the release is byte-reproducible from a clean checkout (see the release notes).

## Documentation

- [docs/DESIGN.md](docs/DESIGN.md) — design consensus (handoff: architecture, domain model, pipeline, normalization spec)
- [GLOSSARY.md](GLOSSARY.md) — domain glossary
- [docs/adr/](docs/adr/) — decision records (merge strategy / tech architecture / normalization defaults / GUI)

## License

- Tool code: **AGPL-3.0**
- Output fonts are not affected by the tool's license: a produced font follows only the licenses of its source fonts (e.g. OFL).

Storefront repo: [chhsich-nerd-font](https://github.com/ChHsiching/chhsich-nerd-font) (marketing page, released font binaries).
