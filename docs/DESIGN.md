# FontAlloy — Design Consensus (handoff)

> Ratified 2026-10 in a design session at the chhsich-nerd-font repo. This file, `GLOSSARY.md`, and `docs/adr/` are the basis for all work in `~/Git/fontalloy`.

**FontAlloy** merges multiple fonts into one by codepoint rules. Flagship scenario: an English coding font (e.g. JetBrains Mono NF) gains its own Chinese glyphs (e.g. Maple's CJK), so Linux users stop fighting font fallback configuration.

- Repo: `~/Git/fontalloy` — a monorepo, AGPL-3.0. The tool's license never reaches output fonts: built fonts follow their source fonts' licenses only.
- Storefront: chhsich-nerd-font — the README carries the WebApp link plus CLI/GUI install guides, Releases publish built fonts, the About link points at the WebApp.

## Architecture

```
core/   pure Python library (fontTools pipeline) — the only capability layer, no UI
cli/    thin shell (typer), calls core directly
gui/    Tauri 2 desktop app — native windows on all three platforms, core bundled as a binary sidecar
web/    pure static site (github.io / vercel), shares its frontend components with gui/
```

`gui/src/kit` is the component library abstracted from the validated prototype; gui and web screens assemble kit components only. The prototype (`gui/prototype/index.html`) remains the design contract: the kit extracts its design language verbatim (palettes, spacing, chrome, copy, theme lists, interaction architecture — see `gui/src/kit/README.md`) while all code is rewritten typed and prop-driven in the shared no-framework stack.

- `fontalloy serve` runs the core as a localhost HTTP service (127.0.0.1 only; CORS allows just the WebApp origin). The WebApp drives real merges when it detects the service and degrades to a "copy CLI command" button otherwise.
- The GUI's end state is Tauri (the user asked for the best result); a serve-plus-browser loop may validate the core API first.
- CLI installs via pipx / brew / scoop.

## Domain model (definitions in GLOSSARY.md)

Everything is a precedence rule: a codepoint range mapped to an ordered font list.

1. Ranges come from language presets (pre-researched) or user-defined intervals.
2. The narrowest applicable rule wins: single codepoint > custom range > preset/script > global default (global default = base font first, donors in join order).
3. Within the winning list, fonts without a glyph at the codepoint are skipped (absence never overrides); the first font holding the glyph wins.
4. Overlapping custom ranges at the same layer: last declared wins.
5. Empty slots fill automatically (the default); a glyph the base font already has is overridden only by an explicit rule.

The preview grid is the GUI/WebApp's core interaction: one cell per codepoint rendering the effective result; click a cell or type a codepoint to set precedence. The preview always renders the effective result — however complex the rules, it never lies.

Language preset data: bundle fontconfig's fc-lang `.orth` files (permissive license) — zh_cn 6,765 / zh_tw 13,063 / ja 2,314 / ko 2,442 / zh_hk 1,083 codepoints, plus the rest of fc-lang (any language with a well-defined codepoint set is selectable). zh_hk (and zh_mo, whose file includes zh_hk's) is a supplementary set that presupposes Traditional Chinese, so its preset presents zh_tw plus the supplement, with the supplement as its own toggleable sub-block; the raw fc-lang set stays selectable alongside. Language charsets are a coverage question, not a partition (zh_cn and ja overlap by 1,391 codepoints, measured from the bundled fc-lang data). Region-specific donors (MapleMono-CN, Source Han SC) already carry the correct default variants — no `locl` handling needed.

## Merge pipeline (core, seven stages)

1. **Load and detect**: TTC selects by face; variable fonts are detected and instantiated to static; woff2 is decoded; faces aggregate by family into weights and styles.
2. **Resolve rules**: precedence rules expand to codepoint level, producing the effective table ("which glyph from which font, per codepoint") plus a conflict/fill report.
3. **Subset donors**: extract the needed glyphs from each donor per the effective table (fontTools subset).
4. **Normalize** (transform only, never reshape — ADR-0003):
   - **Plain is the default (round 26, owner ruling)**: direct combination — the donor's glyphs land verbatim (unit conversion aside) and keep the donor's own advances. The preview renders the source fonts as they are, so WYSIWYG holds by construction. The harmonization schools below are opt-in recipe/interface knobs.
   - Unify upem: scale the donor by s₀ = U/u (always, plain included — unit conversion, not shaping).
   - Harmonization schools (opt-in since round 26): scale by k = min(school term, 0.95·(typoAsc + |typoDesc|)/H_ink) — the **auto** school: the grid term 2A/U capped by the optical term 1.23·cap/H_ink, so the Han ink stays inside the Noto-school zone (≈1.05–1.3× the Latin cap height; Noto Sans SC's own pairing measures 906/733 = 1.236). The bare grid school (CJK ink fills the em the 2-cell advance bought — the Maple Mono CN / Sarasa convention) and the bare optical school (Han ink pinned at the ratio). The interface's 直接组合（不调整） is plain (default), 自动对齐 is auto, 底边一样高 is grid, 缩小一点更匀称 is optical.
   - Measure the Han ink height over the U+4E00–9FFF common characters (a percentile, never the header extremes).
   - Zero vertical displacement: one shared baseline; the CJK em box sits at [−0.12em, +0.88em] by convention; no top alignment.
   - Line height fully inherits the base font (hhea/typo untouched); only usWinAscent/Descent grow, to prevent clipping.
   - Advances follow UAX #11: Fullwidth/Wide take two cells; Halfwidth/Narrow and Ambiguous take one (an ambiguous codepoint the base font already covers stays with the base — absence never overrides). Width policy for fullwidth quotes and dashes is a recipe option.
   - Drop donor hinting and kern/GPOS (the base font keeps its own).
5. **Graft glyphs**: the base font stays the container; move donor glyphs in per the effective table and rebuild cmap (ADR-0001 — never `fontTools.merge` whole-table).
6. **Rewrite tables**: the full name record set (including nameID 16/17 — a trap the old storefront hit) and OS/2 (xAvgCharWidth, weight class, the PANOSE mono bit).
7. **Output and verify**: TTF required; TTC packaging with shared-table dedup expected (the old repo's 284 MB lesson); woff2 optional. Every build ships a verification report: codepoint coverage, weight borrow table, metric comparison.

Measured anchor — JetBrains Mono × Noto/Source Han (both 1000 upem): A = 600, k = 0.9988 (the auto school's optical term; the grid term 1.2 would put the ink at 1.48× the cap height), Han ink spans [−68, +830] = 1.23× the cap height, entirely inside the base font's existing metrics; zero table changes. The same measurement on JetBrains Mono × LXGW WenKai Mono (round 20's verdict pair): grid 1.515× (the reported "CJK visibly taller" defect) → auto 1.230×.

## Weight and style mapping

Nearest match by default (by OS/2 usWeightClass), and every borrow is stated explicitly — in the interface and the build report. A recipe may rewrite the mapping per weight. When the base font has no italic, CJK falls back to upright (the terminal convention). Interpolation and synthesis stay out: they violate transform-only.

## Output naming

The default output name is the fixed brand default `ChHsich` — never derived from source font names (RFN compliance, ADR-0005; the tool does not police user-entered names either). Validation before writing the name table: letters (any case), digits, and hyphens only; spaces are replaced with hyphens rather than rejected; ASCII only (the PostScript name requires it — localized names are out of scope for v1); family name ≤ 31 characters, PostScript name ≤ 63. CSS font-family matching is case-insensitive, so two names differing only in case collide — the user's call, not the tool's.

## Recipe (YAML)

Fields: base font reference (family + version/hash), donor list, precedence rules at every granularity, weight mapping overrides, output naming, normalization switches. Three roles at once: CLI input (`fontalloy build x.yaml`), CI build input, community share unit. **A built font is a recipe run against pinned source fonts** — reproducible by CI, released through the storefront's Releases (reusing the old repo's AUR / install.sh experience). Built fonts are the marketing front and the no-install option. A font reference names a catalog family the manifest pins (`family`/`variant`, plus a filename `pattern` narrowing multi-file zips) — never a loose URL; the assets machinery resolves it against the fetched, sha256-verified catalog, and official recipes live in `recipes/`. A `path` reference may carry the same bare-filename `pattern` (round 13): the named file's own directory is scanned and every matching font file joins the reference — one reference carrying a whole local family's weight matrix, the path-form twin of the catalog zip's narrowing.

## v1 format tiers

Required: TTF/OTF in, TTF out. Expected: TTC in (`#face`), TTC out (deduped), variable-font detect + instantiate. Optional: woff2 both ways, CFF out. Merging variable fonts as such is unsolved in the open-source world — instantiation is the support.

## Differentiation

Font_Merger (ChenZhu-Xie, GPL-3.0 — never copy its code) and mytory/font-merger have no language presets, no precedence model, and no recipe ecosystem. Those three gaps are the wedge.

## Rejected routes (do not "fix" these back)

- `fonttools merge` whole-table merge (no upem scaling; no CID-CFF, VF, or TTC support)
- FontForge runtime (heavy dependency; output needs byte-level patching — the old repo's idea survives, its implementation does not)
- Rust core (write-fonts merge capability gap too large)
- PySide6 GUI (weak canvas for large glyph grids; heavy packaging)
- Per-codepoint modal conflict dialogs (superseded by the preview grid + rule model)
- Weight interpolation synthesis (violates transform-only)
