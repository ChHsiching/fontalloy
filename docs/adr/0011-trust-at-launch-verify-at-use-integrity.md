# The catalog store is trusted at launch, verified at use, repaired explicitly

Status: accepted (owner ruling: the second launch is as fast as possible; integrity assurance lives in the mechanism, never as "checking" UX)

Measured on the real machine (48 GB / 103 families): every launch ran a full stat sweep over the extracted tree before the family list existed (~80 s with an empty progress feed), then ran the same sweep a second time family-by-family, while the materializer concurrently sha256-hashed every artifact it had ever downloaded. The user stared at a motionless progress bar and a lying title (「正在下载字体目录」 during a verify pass that downloaded nothing).

Survey of six stores (git objects, npm/cacache, Steam depots, apt, Chromium disk cache, OCI/rsync — official docs, sources in the research note): all converge on the same three-phase model — hash at ingest into an atomic ledger, trust the ledger at startup (metadata-only), verify the individual item at use, and keep whole-store verification explicit/offline/background, never on the interactive critical path.

## Decision

- **The completion markers are the trust ledger** (release tag + recorded sizes, written last — unchanged from ADR-0005). Launch reads the ledger and presets every family done immediately; no tree walk precedes the preset, and the duplicate sweep is unified into one pass.
- **Launch-time background sweep is stat-only and off the critical path**: it may downgrade a family only on hard evidence (marker missing/stale/tag-mismatch), which triggers that family's re-sync in the background.
- **The materializer never hashes at launch.** Its pins are computed at download time; a launch only trusts and, in the background, stat-checks.
- **Use-time verification covers the last mile**: opening a face for serving/merging does a cheap size check against the ledger; a mismatch hashes the archive against the release pin and re-syncs that family (surfaced once, consumer-plain — never a loop).
- **Full verification is explicit** (settings action / repair flow) or background-scheduled — never a gate between the user and the app.
- Same-size bit-rot at launch is consciously out of scope — the accepted industry position; the use-time check catches it at the moment it would matter, and re-download is the cure.

## Consequences

- Second-launch target: interactive with the full catalog immediately; per-family states stream into the progress feed only when real work exists, so the bar never sits still while work runs (the batch-flip class dies with the silent window).
- AV-quarantined files appear as repeated single-family repairs — visible, bounded, never a silent re-download loop.
- Sourced analysis: `docs/research/on-disk-cache-integrity-patterns.md`.
