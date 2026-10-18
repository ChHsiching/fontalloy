# FontAlloy

The chhsich-nerd-font repo acts as the storefront for FontAlloy; this glossary defines FontAlloy's domain language. The tool itself lives in `~/Git/fontalloy`, built from scratch — no code or git history shared with the storefront.

## Merge model

**Base font**:
The container of the merge: the output font inherits its metrics and identity, and it holds the highest glyph precedence by default.
_Avoid_: master font, target font

**Donor font**:
An outside font that supplies glyphs for a chosen codepoint range.
_Avoid_: source font, patch font

**Codepoint**:
A Unicode scalar value; the cmap table maps codepoints to glyphs.
_Avoid_: encoding index, character number

**Coverage intervals**:
The codepoint ranges a face's glyph coverage is summarized as — the one form that counts, grouping, and missing-glyph detection all read, instead of a per-codepoint list.
_Avoid_: coverage map, character set dump

**Fill**:
Placing a donor glyph where the base font has no glyph. The default behavior of a merge — it needs no explicit rule. The user-facing Chinese term is 补字 (report copy, settings help, popup notes).
_Avoid_: backfill, patching

**Override**:
Replacing a glyph the base font already has, by an explicit precedence rule. Only ever the result of a user decision, never implicit. The user-facing Chinese term is 替换.
_Avoid_: replace, clobber

**Variant**:
One of the named releases a font family ships the same design in, identified by its official name — NF, NF-CN, Mono, SC, TC, 屏幕版 — never assembled from options. A variant pins an exact source file; every identity surface shows it by its real name, and recipes reference it as the pair `{family, variant}`.
_Avoid_: option, flavor, edition

**Absence never overrides**:
The domain invariant: a font without a glyph at a codepoint never competes for it, whatever its precedence.
_Avoid_: empty-slot protection, skip rule

**Language preset**:
A pre-researched "language → codepoint set" mapping (e.g. Simplified Chinese, 6,765 codepoints), selected by name, with sub-blocks to toggle.
_Avoid_: language pack, orth (that is a data source, not the concept)

**Sub-block**:
One named component of a language preset; the preset is the union of its enabled sub-blocks (e.g. zh_hk = zh_tw + the zh_hk supplement). Every sub-block is selectable on its own.
_Avoid_: layer, chunk

**Precedence rule**:
A declaration of the shape "codepoint range → ordered font list". Ranges come from language presets or custom intervals.
_Avoid_: conflict strategy, override rule

**Granularity**:
The nesting layers of precedence rules: global < preset/script < custom range < single codepoint. The narrower range wins.
_Avoid_: fine-grained control

**Preview grid**:
The interface that renders the effective merged glyphs one codepoint per cell; click a cell or type a codepoint to set precedence.
_Avoid_: glyph table, character map

**Weight matrix**:
The set of output weight/style slots one recipe emits — the weight union of base and donors by default (donor-only slots borrowing the nearest base face), a recipe `weights` selection or a base face pin otherwise. Each slot is merged like a single build; donor families match their nearest OS/2 usWeightClass per slot, and a recipe may rewrite the mapping per slot. Nearest match, never interpolation or synthesis.
_Avoid_: instance set, style bundle

**Borrow**:
One donor face's landing in one output slot: which donor weight ended up in which output weight, chosen how (nearest, override, or pin) — or, for a donor-only union slot, the base weight its container was borrowed from. Every borrow is stated in the build report.
_Avoid_: substitution, weight mix

**Style fallback**:
A donor family without the requested style contributes its other style (upright, by the terminal convention) to that slot, stated in the borrow. The outlines are always some face's own — never slanted or synthesized.
_Avoid_: fake italic (that is what this prevents)

## Normalization

**Normalization**:
The uniform geometric transforms applied to donor glyphs during a merge (scaling, advance re-gridding, baseline alignment). Transform only, never reshape — the outline design stays untouched.
_Avoid_: adjusting glyphs, modifying font internals

## Recipe and releases

**Recipe**:
A YAML file declaring one complete merge: base font, donors, precedence rules at every granularity, weight mapping, output naming, normalization switches. It serves as CLI input, CI build input, and the community share unit.
_Avoid_: config file, preset file

**Built font**:
The output of running a recipe against pinned source fonts: reproducible by CI, released through the storefront.
_Avoid_: release font, official font

**Format tier**:
The v1 classification of font formats: required (TTF/OTF in, TTF out — always, the default), expected (TTC in with face selection; TTC out with shared-table dedup), optional (woff2 out, behind an explicit format choice). Selected by the recipe's `output.format` or the CLI `--format` switch.
_Avoid_: output type, file kind

**Shared-table dedup**:
How a TTC output stays small: a table compiling to identical bytes across faces — the grafted donor glyphs above all — is stored once and pointed at by every face, instead of once per face (the old repo's 284 MB lesson). Content-keyed: any accidental per-face difference silently defeats sharing for that table.
_Avoid_: compression (it is deduplication, not encoding)

**Byte-reproducible build**:
Identical pinned inputs rebuild byte-identical output: no wall clock in the file (head timestamps pinned from the base font), deterministic ordering, brotli pinned in the lockfile for woff2. The verification report records the source font hashes that make "identical inputs" checkable.
_Avoid_: deterministic build (weaker: that only means same behavior)
**Catalog release**:
The consolidated font catalog republished by CI to a dedicated GitHub Releases tag (`font-catalog-v1`): one zip per family, checksums, and release metadata. The app's download origin, distinct from the upstream releases the manifest pins as provenance.
_Avoid_: font bundle, CDN

**Origin list**:
The ordered download sources carried in catalog-release metadata; the downloader tries origins in list order, so adding a mirror is a data change, never a code change.
_Avoid_: mirror config, fallback list

**Catalog sync**:
The background lifecycle that brings the local catalog cache to the catalog release's state — download, verify, extract, and repair — usable while it runs and self-healing on a later launch after a partial or corrupt download.
_Avoid_: catalog download, update job

**Preview subset**:
A tiny face containing just the glyphs a family's own name needs, used where loading the real family would be too heavy — rows still show each family in its own font.
_Avoid_: sample font, thumbnail

**Reserved Font Name (RFN)**:
A name an upstream font author reserves under its license; a modified version — every built font is one — must not carry it. The catalog records an `rfn` flag per family, and the default output name is the fixed brand default, never derived from source font names.
_Avoid_: trademark (it is a license term, not a trademark)

## Project structure

**Storefront**:
The chhsich-nerd-font repo's role: the promotion front — WebApp link, CLI/GUI install and usage guides, built-font releases. The tool code lives in the FontAlloy repo.
_Avoid_: main repo
