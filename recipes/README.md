# Recipes

A recipe is one build in one YAML file: base font, donors, precedence
rules, weight matrix, normalization switches, output naming. It is
simultaneously the CLI input (`fontalloy build <recipe>`), the CI build
input, and the community share unit — a built font is a recipe run
against pinned source fonts.

## Layout

- Top level (`recipes/*.yaml`): the **official recipes**. CI builds
  every one of them from the manifest's pinned source fonts, asserts
  byte-reproducibility, and publishes the fonts plus their verification
  reports to the storefront repository's Releases
  ([`ChHsiching/chhsich-nerd-font`](https://github.com/ChHsiching/chhsich-nerd-font));
  see `docs/storefront-releases.md` for the release layout and the
  one-time setup.
- `recipes/community/`: **community recipes** — samples of the share
  unit as users write them. CI builds them through the identical path
  (same fetch, same pipeline, same reproducibility gate) but does not
  package them into the release.

## Font references

Official and community recipes reference catalog *families*, never
loose URLs — the committed manifest (`assets/fonts.manifest.json`) pins
every artifact's tag, URL, and sha256:

```yaml
base:
  family: JetBrainsMono
  variant: Nerd Font                 # required when the family has several
  pattern: "JetBrainsMonoNerdFont-*.ttf"   # narrow a multi-file zip
donors:
  - family: NotoSansSC
    variant: Variable
    instance:
      wght: 400                      # pin a variable-font instance
```

A reference with a plain `path` still works (paths resolve against the
recipe file) — that is how a recipe can merge fonts outside the
catalog, fully offline.

## Building locally

```console
$ uv run fontalloy assets fetch --recipes recipes   # only what they pin
$ uv run fontalloy build recipes/chhsich-zh-cn.yaml
```

Fetching and building are separate on purpose: the fetch is slow and
network-bound, the build is offline and byte-reproducible. Rebuilds
re-verify the pinned artifacts against the manifest, so a drifted
catalog fails loudly instead of building something else.

## Sharing a recipe

- Reference catalog families (or paths that travel with the recipe).
- Keep `output.family` clear of every source font's Reserved Font
  Names — the default (`ChHsich`) already is; the notices in the
  release state the naming obligations per family.
- One file, one build: everything the build needs is in the recipe
  plus the manifest, so anyone can reproduce your font exactly.
