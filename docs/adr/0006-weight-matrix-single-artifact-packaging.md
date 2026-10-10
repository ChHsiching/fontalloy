# Weight matrix lands as one collection; multi-file TTF output rejected

One recipe yields the complete family (issue #9): the requested weight/style matrix — the base font file's faces by default, a recipe `weights` selection otherwise — emits one merged face per slot. The packaging decision: a multi-slot matrix lands as **one TTC** (`output.format: ttc`, one merged face per slot, shared-table dedup on); `ttf` and `woff2` keep carrying exactly one slot, and a multi-slot request with those formats is a clear error pointing at `ttc`. A single-slot build works in every format, unchanged.

This reconciles issue #9 with issue #10's per-face TTC machinery rather than adding a second packaging path: for an unpinned collection base under `format: ttc`, "every base face" (issue #10's rule) is exactly "the default requested matrix" — one mechanism, two descriptions. A recipe may also select a single slot from an unpinned collection for a plain TTF, which previously required a face pin (select-by-weight now stands in for pin-by-index).

## Considered options

- Multiple TTF files per build (`<stem>-700.ttf`...): rejected — `build()`'s contract is one output artifact (path, sha256, byte-reproducibility gate, report schema, CLI output); multiplying files touches every one of those surfaces for a packaging convenience the expected tier already covers. A complete family as one installable TTC is also the better terminal story (one family, one file).
- Implicit multi-file output when the base is an unpinned collection: rejected — silently changing "error: select a face" into N files is a behavior change no one asked for; the `weights` selection (or `format: ttc`) is the explicit opt-in.
- Nearest-match approximation for base faces (request weight 430, get 400): rejected — the output's own identity comes only from the base (the container); a slot must name a face the base actually has, or the build fails with the available slots listed. Donors get nearest-match; the base does not.

## Consequences

- Donor files load all faces and match per slot (the "seven-weight CJK donor" case); a donor reference with a pinned face bypasses matching for that donor, and a donor file carrying multiple families is a clear error.
- The report's `weights` section states every borrow (which donor weight landed in which output weight, via nearest/override/pin, style fallbacks flagged); the CLI echoes one line per slot.
- A base without an italic face has no italic slot to request — the upright output serves the style by the renderer's convention, and nothing is ever synthesized. A base with an italic face borrows the donor's upright glyphs for it (terminal convention), stated as a style fallback.
- Slot order is the base file's face order, whatever the recipe listed; the selection is a set.
- If multi-file TTF output is ever wanted, it is a packaging fast-follow on the slot machinery (the slots, not the save boundary, are the hard part).
