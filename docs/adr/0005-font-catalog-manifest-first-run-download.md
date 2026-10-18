# Font catalog = manifest + Releases; installers ship zero fonts, first run downloads all

The ~81-family font catalog (~375 MB of TTF/OTF) never enters git. A committed manifest — per family: variant, pinned upstream tag + URL, sha256, SPDX id, RFN flag, license file reference — is the single source of truth; `fontalloy assets fetch` downloads and verifies it into a gitignored directory; THIRD-PARTY-NOTICES.md is generated from the manifest; CI republishes the consolidated catalog on GitHub Releases, which becomes the app's download origin (upstream URLs stay recorded as provenance). Installers bundle no fonts at all: the first-run download runs behind a progress screen inside the core serve (the runtime strategy below); failures never block startup — missing families retry on later launches, and user-local font files always work offline.

Output naming: the default output name is the fixed brand default (`ChHsich`), never derived from source font names. The tool does not police user-entered names; it only refuses to generate infringing defaults itself.

## Runtime strategy (round 31, core unification)

The core unification (spec #25, enforcing ADR-0002) moved the whole catalog runtime out of the frontends and into `fontalloy serve`. This section records that decision and **supersedes the page-side download strategy** — the GUI frontend's release-doc parser, zip reader, sha256 verify loop, and IndexedDB/FS storage layer were deleted, not bypassed. What holds now:

- **Installers still ship zero fonts.** Nothing about bundling changed; only the owner of the download moved.
- **The serve owns the catalog lifecycle.** A serve-side sync fills the cache directory: streaming temp-file download with sha256-on-write (bytes are verified as they land, not after), ordered origin-list fallback, zip/7z hash-only extraction (ADR-0007: the client never opens a face; the parse gate lives at packaging), atomic replace, and a per-family complete marker written only after every hash verified. The marker carries the release tag and the byte sizes verification pinned. The launch check is **stat-only** — marker present, tag matching, archive and every face present at their recorded sizes; no byte is hashed at launch. A full re-hash happens only on an anomaly (missing or stale marker, missing file, size mismatch) or an explicit sync. This rule is incident-driven: launch-time full re-hashing of the multi-GB catalog (~10 GB on the real machine) was a disk-IO storm — every app start re-read the whole catalog from disk. Sizes catch the partial-write/truncation failure mode; same-size bit-rot is the explicit sync's job, not launch's.
- **The frontend holds zero font bytes.** Every FontFace is a URL against the serve with descriptors, picker rows self-render from serve-generated preview subsets, and a browser file pick streams the file up to the serve instead of reading it in the page. Nothing font-shaped is parsed, hashed, or stored in the renderer (enforced by the conformance guard).
- **Web users get the catalog through their local CLI's serve** (ADR-0002's localhost service): the catalog downloads once into the local CLI's cache, never into the page, and later visits start ready. Without a local serve the web app is the no-service panel — a recipe file plus a copy-paste CLI command.

## Considered options

- Git LFS for the binaries: rejected — metered bandwidth is billed to the repository owner even on public repos (10 GiB/month on Free, hard-blocked at a $0 budget; ~27 full clones exhaust it).
- Committing binaries: rejected — permanent history bloat against GitHub's documented repository-size guidance.
- Submodules to upstream font repos: rejected — multi-GB clones, and upstream tags move independently of our pinning.
- Bundling the full catalog in the installer: rejected — Tauri updates are full-package, so 375 MB would ride every installer and every update. Disk space is not the constraint; download weight is.
- Bundling a minimal default pair with per-family on-demand downloads (the research recommendation): rejected — preview coverage is the product; a first-run full-catalog download with retry-on-launch is a simpler and better UX, and disk size is a non-issue for users.
- Install-time fetch inside the installer: rejected — only the Windows NSIS installer supports hooks; macOS dmg and Linux AppImage/deb have no install-time execution, so the first-run path must exist on every platform anyway. A Windows NSIS prefetch was evaluated and dropped: beyond the hook itself it needs NSIS-side download, checksum, and progress logic — a second verification implementation — which is not trivial. Revisit only if a simple path appears.

## Consequences

- First run needs the network for the catalog; loading user-local fonts works offline regardless.
- Downloading 375 MB from GitHub Releases in mainland China is the known delivery risk; the mirror strategy (Gitee mirror, CDN front) is a high-priority open question for the spec — LXGW maintains a Gitee mirror as precedent.
- A per-family license audit is mandatory before the catalog ships: several Nerd Fonts families are not OFL (CC-BY-SA-4.0, Ubuntu Font License, Bitstream-Vera rename rule), and LXGW WenKai reserves 霞鹜/LXGW with a carve-out that explicitly excludes installable desktop modified versions — merged outputs must never carry those names.
- Open questions carried to the spec: mirror choice, woff2 preview artifacts, manifest vs. derived UI metadata, the first-run screen's exact UX.
- Sourced analysis: `docs/research/font-assets-strategy.md`.
