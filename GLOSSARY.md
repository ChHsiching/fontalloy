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

**Fill**:
Placing a donor glyph where the base font has no glyph. The default behavior of a merge — it needs no explicit rule.
_Avoid_: backfill, patching

**Override**:
Replacing a glyph the base font already has, by an explicit precedence rule. Only ever the result of a user decision, never implicit.
_Avoid_: replace, clobber

**Absence never overrides**:
The domain invariant: a font without a glyph at a codepoint never competes for it, whatever its precedence.
_Avoid_: empty-slot protection, skip rule

**Language preset**:
A pre-researched "language → codepoint set" mapping (e.g. Simplified Chinese, 6,765 codepoints), selected by name, with sub-blocks to toggle.
_Avoid_: language pack, orth (that is a data source, not the concept)

**Precedence rule**:
A declaration of the shape "codepoint range → ordered font list". Ranges come from language presets or custom intervals.
_Avoid_: conflict strategy, override rule

**Granularity**:
The nesting layers of precedence rules: global < preset/script < custom range < single codepoint. The narrower range wins.
_Avoid_: fine-grained control

**Preview grid**:
The interface that renders the effective merged glyphs one codepoint per cell; click a cell or type a codepoint to set precedence.
_Avoid_: glyph table, character map

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

**Catalog release**:
The consolidated font catalog republished by CI to a dedicated GitHub Releases tag (`font-catalog-v1`): one zip per family, checksums, and release metadata. The app's download origin, distinct from the upstream releases the manifest pins as provenance.
_Avoid_: font bundle, CDN

**Origin list**:
The ordered download sources carried in catalog-release metadata; the downloader tries origins in list order, so adding a mirror is a data change, never a code change.
_Avoid_: mirror config, fallback list

**Reserved Font Name (RFN)**:
A name an upstream font author reserves under its license; a modified version — every built font is one — must not carry it. The catalog records an `rfn` flag per family, and the default output name is the fixed brand default, never derived from source font names.
_Avoid_: trademark (it is a license term, not a trademark)

## Project structure

**Storefront**:
The chhsich-nerd-font repo's role: the promotion front — WebApp link, CLI/GUI install and usage guides, built-font releases. The tool code lives in the FontAlloy repo.
_Avoid_: main repo
