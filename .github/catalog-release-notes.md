# FontAlloy font catalog — ${TAG}

The consolidated catalog (${ENTRIES} pinned entries / ${FAMILIES} families),
repackaged from upstream releases verified against the manifest's sha256 pins.
This release is the app's download origin.

## Download origins (in order)

| # | id | base URL |
|---|----|-----------|
| 1 | github-releases | https://github.com/${GITHUB_REPOSITORY}/releases/download/${TAG} |

The ordered origin list is machine-readable in `catalog-release.json`; adding a
mirror later is a metadata edit, not a code change.

## Layout

- `<Family>.zip` — every face of the family plus its license file
- `SHA256SUMS` — checksum of every attached artifact (`sha256sum -c`)
- `catalog-release.json` — delivery metadata: ordered origins, per-family zip
  and face checksums
- `THIRD-PARTY-NOTICES.md` — generated license notices

Upstream provenance (pinned tags, URLs, sha256 sources) stays recorded in
[`assets/fonts.manifest.json`](https://github.com/${GITHUB_REPOSITORY}/blob/main/assets/fonts.manifest.json)
and the per-family audit in
[`docs/catalog/license-audit.md`](https://github.com/${GITHUB_REPOSITORY}/blob/main/docs/catalog/license-audit.md).

## Reproducing this release

Built from commit `${GITHUB_SHA}`. From a clean checkout of that commit:

```
uv run fontalloy assets fetch
uv run fontalloy assets notices --output dist/THIRD-PARTY-NOTICES.md
uv run fontalloy assets package --out dist --repo ${GITHUB_REPOSITORY} --tag ${TAG} \
  --include dist/THIRD-PARTY-NOTICES.md
```

The artifacts are byte-identical (packaging writes no wall clock); verify with
`sha256sum -c SHA256SUMS` inside `dist/`.
