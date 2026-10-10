# Storefront releases

Built fonts are the no-install option: CI builds every official recipe
from the manifest's pinned source fonts and publishes the fonts, their
verification reports, and the license notices to the **storefront
repository's Releases** — [`ChHsiching/chhsich-nerd-font`][storefront]
— where the AUR package and `install.sh` already live. This document is
the release contract and the one-time setup the repository owner does.

The workflow: [`.github/workflows/recipe-release.yml`][workflow]. The
recipes: [`recipes/`](../../recipes) (official at the top level,
community samples under `recipes/community/`).

## What the workflow does

1. **Fetch** — `fontalloy assets fetch --recipes recipes`: downloads
   exactly the families the recipes reference, every artifact
   sha256-verified against `assets/fonts.manifest.json`.
2. **Build** — every recipe (official and community) through the one
   pipeline, same as a local `fontalloy build`.
3. **Byte-reproducibility gate** — every recipe builds a second time
   over the same output paths; `diff -r` must be empty (font bytes,
   report JSON, report HTML). A difference fails the release.
4. **Package** — `fontalloy recipes package recipes/*.yaml`: one zip
   per official recipe (font + `*.report.json` + `*.report.html` +
   `THIRD-PARTY-NOTICES.md`), filtered notices at the root, and a
   `SHA256SUMS` covering everything (`sha256sum -c` passes).
5. **Dry run** — the staged `dist/` uploads as the workflow artifact
   `recipe-release`. This proves the whole chain with **no secret
   configured** and is what pull requests run.
6. **Publish** — (main pushes and dispatches only) the staged assets
   attach to the storefront repo's release tag.

Triggers: pushes to `main` and PRs touching `recipes/**`, the
manifest, the license files, `core/`, `cli/`, the lockfile, or the
workflow itself; plus `workflow_dispatch` with a `tag` input (default
`fontalloy-v1`) and a `publish` toggle.

## One-time setup (repository owner)

Publishing is cross-repository: the workflow runs in `fontalloy` but
writes to `chhsich-nerd-font`, so the default `GITHUB_TOKEN` cannot do
it. Configure one PAT as a repository secret:

1. Create a fine-grained personal access token
   (GitHub → Settings → Developer settings → Fine-grained tokens):
   - **Resource owner**: `ChHsiching`
   - **Repository access**: only `ChHsiching/chhsich-nerd-font`
   - **Permissions**: Repository → Contents → **Read and write**
     (Releases live under Contents).
2. Add it as a secret named `STOREFRONT_TOKEN` in
   `ChHsiching/fontalloy` (Settings → Secrets and variables → Actions
   → New repository secret).
3. Run the workflow once (`workflow_dispatch` → `publish: true`) to
   confirm the publish path end to end.

Until the secret exists: pushes to `main` stay green, skip publishing
with a visible note, and the workflow artifact remains as the dry run;
an explicit dispatch with `publish: true` fails loudly instead.

A classic PAT with the `repo` scope also works but grants more than
needed; prefer the fine-grained form above. Rotate by replacing the
secret — nothing else holds the value.

## Release layout

```
<tag>/
├── chhsich-zh-cn.zip        # font + report.json + report.html + notices
├── chhsich-weights.zip      # (ttc recipe: one collection)
├── chhsich-noto.zip
├── THIRD-PARTY-NOTICES.md   # filtered to the recipes' source families
└── SHA256SUMS               # every attached asset, sha256sum -c format
```

The release body is rendered from
[`.github/recipe-release-notes.md`](../recipe-release-notes.md) by
[`.github/scripts/render-recipe-notes.py`](../scripts/render-recipe-notes.py):
the recipe list and each source family's SPDX license, pin, and RFN
status — the licensing statement travels with the release, not in
someone's memory.

## Licensing rules the artifacts enforce

- Output family names (`ChHsich…`) never derive from source font
  names; the pipeline additionally strips stale typographic family
  records (nameID 16/17) from RIBBI faces so no source family leaks.
- Every zip carries `THIRD-PARTY-NOTICES.md` (OFL condition 1: the
  copyright and license accompany each copy), generated from the
  manifest — filtered to the families the recipes actually merged.
- Every zip carries the per-build verification report, which states the
  source artifacts' sha256 pins — a released font is auditable against
  the manifest without re-building it.
- Community recipes are built and reproducibility-checked by the same
  workflow but never packaged: the storefront ships official recipes
  only.

## Choosing the tag

The default `fontalloy-v1` is a rolling tag (like the catalog's
`font-catalog-v1`): re-publishing replaces its assets via
`--clobber`. To cut a durable version, dispatch with a specific tag
(e.g. `v2026.10`); the storefront's install surfaces point at whichever
tag convention they prefer — that is a storefront-side decision, out
of scope here (only the Releases integration contract is in scope for
v1).

[storefront]: https://github.com/ChHsiching/chhsich-nerd-font
[workflow]: https://github.com/ChHsiching/fontalloy/blob/main/.github/workflows/recipe-release.yml
