# FontAlloy

> Merge multiple fonts into one, driven by codepoint rules.

**FontAlloy** solves the CJK font pain for people who code: give an English coding font (e.g. JetBrains Mono NF) its own Chinese glyphs (e.g. Maple's CJK), so terminal users stop fighting font fallback configuration. Pick a base font, a donor, and the language coverage — get one font file out.

## Status

Design is settled; implementation has not started. The full design consensus lives in [docs/DESIGN.md](docs/DESIGN.md). The three sentences that matter:

1. Everything is a "codepoint range → ordered font list"; language presets are just ranges chosen for the user in advance.
2. Absence never overrides presence — one invariant that replaces all special-case protection logic.
3. `core` is the only capability layer; CLI / GUI / Web are all consumers of it. Merge logic exists exactly once.

## Planned layout

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

This repo ships no font binaries — the catalog is data. A committed manifest pins every family (upstream version, URL, sha256, SPDX license, reserved-name flag); `fontalloy assets fetch` downloads and verifies it, and CI republishes the consolidated catalog to GitHub Releases as the app's download origin. Installers bundle no fonts: the app downloads the full catalog on first run and retries missing families on later launches. Merged-output fonts default to a fixed name (`ChHsich`), never derived from source font names. See [docs/adr/0005-font-catalog-manifest-first-run-download.md](docs/adr/0005-font-catalog-manifest-first-run-download.md) and [docs/research/font-assets-strategy.md](docs/research/font-assets-strategy.md).

## Documentation

- [docs/DESIGN.md](docs/DESIGN.md) — design consensus (handoff: architecture, domain model, pipeline, normalization spec)
- [GLOSSARY.md](GLOSSARY.md) — domain glossary
- [docs/adr/](docs/adr/) — decision records (merge strategy / tech architecture / normalization defaults / GUI)

## License

- Tool code: **AGPL-3.0**
- Output fonts are not affected by the tool's license: a produced font follows only the licenses of its source fonts (e.g. OFL).

Storefront repo: [chhsich-nerd-font](https://github.com/ChHsiching/chhsich-nerd-font) (marketing page, released font binaries).
