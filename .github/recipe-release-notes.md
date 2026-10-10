# FontAlloy built fonts — ${TAG}

Prebuilt merged fonts from FontAlloy's official recipes: no install, no
Python — download a zip, install the font, done. Every font below is a
recipe run against source fonts pinned by
[the catalog manifest](https://github.com/${GITHUB_REPOSITORY}/blob/${GITHUB_SHA}/assets/fonts.manifest.json)
(sha256-verified at build time), and every build is byte-reproducible:
CI builds each recipe twice and compares the bytes before anything ships.

Built from commit [${GITHUB_SHA}](https://github.com/${GITHUB_REPOSITORY}/tree/${GITHUB_SHA}).

## Recipes in this release

${RECIPE_LINES}

Each zip carries the built font (`.ttf`, or one `.ttc` for multi-weight
recipes), the verification report in both forms (`*.report.json`,
`*.report.html` — coverage, weight borrows, metric comparison), and
`THIRD-PARTY-NOTICES.md`.

## Licensing

Every output is a Modified Version of its source fonts and follows only
those fonts' licenses — never FontAlloy's own AGPL-3.0:

${LICENSE_LINES}

The output family names (`ChHsich…`) are deliberately independent of the
source families, so no Reserved Font Name travels into an output.
`THIRD-PARTY-NOTICES.md` (in the release root and inside every zip)
states each source family's copyright, license, upstream pin, and
naming obligations.

## Verifying a download

```
sha256sum -c SHA256SUMS
```

## Reproducing a build locally

```
uv run fontalloy assets fetch --recipes recipes
uv run fontalloy build recipes/<recipe>.yaml
```

The rebuild is byte-identical to the released artifact (no wall clock
reaches the output); the report inside the zip states the source
artifacts' sha256 pins.
