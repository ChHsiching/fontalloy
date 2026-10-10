# Glyph-level, base-first merge — not whole-table merge

Merge strategy: the base font stays the container; donor glyphs are grafted in per codepoint following the layered precedence rules (absence never overrides: a font lacking a glyph at a codepoint never competes for it). `fontTools.merge` whole-table merging is rejected: pyftmerge requires identical unitsPerEm across inputs with no auto-scaling, rejects CID-keyed CFF (Source Han / Noto CJK), rejects variable fonts and TTC inputs, and resolves duplicate codepoints by renaming plus a `locl` lookup — unworkable at tens of thousands of CJK glyphs. The glyph-level route is independently validated by Maple Mono, Font_Merger, and the Nerd Fonts patcher.

## Considered options

- `fonttools merge` whole-table merge: rejected for the limits above.
- FontForge glyph copy (the old chhsich-nerd-font approach): the model is right, but the runtime is heavy and its output needs byte-level patching. The idea survives; the implementation moves to fontTools.

## Precedence semantics (paired with GLOSSARY)

Every precedence rule is a codepoint range mapped to an ordered font list. The effective rule is the narrowest by granularity (single codepoint > custom range > preset/script > global default); overlapping ranges at the same layer resolve to the last declared; the global default is base font first, donors in join order.
