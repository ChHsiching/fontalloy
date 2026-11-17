# First run offers the catalog scope choice: full download or on-demand

Status: accepted (owner ruling, 2026-11-16 grill; reverses the "on-demand rejected" option in ADR-0005)

ADR-0005 rejected per-family on-demand download with the rationale "preview coverage is the product; a first-run full-catalog download is simpler and better UX". The real catalog landed at ~48 GB / 103 families. The owner ruled the reversal: the first run must offer the choice, because users who work from local font files — and users without the disk or the patience for 48 GB — were being forced through a download they never use.

Industry survey (14 products, official docs): every surveyed product browses its full catalog before any download; downloads are per-item from the list entry with inline, non-modal progress and a queue; a skipped onboarding is never re-nagged; pre-download entries show full metadata with a degraded preview (Google Fonts' "smallest possible file" subset is the precedent for previewing without the bytes). We deliberately differ on one point: a first-class in-app 「下载全部字体」 stays, as an equal option — the owner's explicit call for this product's users, against the industry norm of omitting it.

## Decision

- The first-run screen offers 「下载全部字体」 (with the real size stated; 103 families queued, per-family progress — today's full-sync behavior) and 「按需下载」 (UI copy includes 跳过; nothing downloads up front).
- **On-demand mode's listing is identical to full mode**: all families, metadata, and self-rendered rows — powered by a **preview pack** bundled with the installer (tiny per-family name-glyph subsets; the serve's existing preview-subset mechanism, pre-generated at packaging so no family bytes are needed to browse).
- **Clicking a family in on-demand mode downloads that one family** (tens of MB) with inline progress and queue semantics (Unity/Steam pattern: the entry becomes its own progress; cancellable).
- The choice is remembered, changeable in settings, and never re-nagged; switching to full download later is just starting the full sync.
- Failure copy is consumer-plain (下载失败 / 请检查网络连接 / 重试) — no engineering vocabulary anywhere near the user.

## Consequences

- The preview pack becomes a packaging artifact (generated in `catalog-release` packaging, shipped in installers) — small, versioned with the release tag.
- The serve's per-family download path (today driven only by the full sync) gains a single-family entry point with its own progress state machine; the marker/verify pipeline is reused as-is.
- ADR-0005's runtime strategy (serve-owned sync, zero renderer bytes, retry-on-launch) is unchanged; only the forced scope is replaced by the choice.
- Sourced analysis: `docs/research/first-run-download-ux-patterns.md`.
