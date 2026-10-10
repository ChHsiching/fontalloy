# Font catalog license audit

Audit date: 2026-10-10 (issue #13). Scope: the per-family licensing audit
the spec and ADR-0005 make mandatory before the catalog ships. The
manifest (`assets/fonts.manifest.json`) is the machine-readable result;
this note records sources, decisions, and the exceptions that need human
awareness. All data was harvested from upstream machine-readable sources
pinned to exact tags/commits — nothing came from the prototype branch.

## Catalog composition

86 entries across 81 families, matching the spec's "~81-family catalog":

| Origin | Version pin | Families | Entries | Checksums |
| --- | --- | --- | --- | --- |
| ryanoasis/nerd-fonts | `v3.5.1` (2026-08-21) | 72 patched families | 72 zips | upstream-published (release `SHA-256.txt`) |
| subframe7536/maple-font | `v7.9` | MapleMono (`NF`, `NF-CN`) | 2 zips | upstream-published (`.sha256` sidecars) |
| lxgw/LxgwWenKai (+ `-Screen`) | `v1.522` | LXGWWenKai, …Mono, …Screen, …MonoScreen, …GBScreen, …MonoGBScreen | 10 TTFs | self-computed |
| google/fonts (commit-pinned) | `a85815a4…` / `8b0a1d0f…` | NotoSansSC, NotoSerifSC | 2 variable TTFs | self-computed |

Checksum provenance summary (every entry is pinned; nothing is pending):

- **Upstream-published (74 entries)**: Nerd Fonts zips from the release
  `SHA-256.txt`; Maple Mono from the per-zip `.sha256` sidecars (64 bare
  hex characters, no filename). The nerd-fonts checksum parsing was
  validated end-to-end during authoring by downloading `Agave.zip` and
  confirming the pinned hash matches.
- **Self-computed (12 entries)**: LXGW publishes no checksums at all
  (finding 14 of `docs/research/font-assets-strategy.md`); google/fonts
  files carry none either. These 12 files were downloaded once during
  authoring and their sha256 pinned from the download. The Noto entries
  pin by google/fonts commit SHA in `upstream_url`/`version`, which makes
  the URL immutable; the LXGW entries pin by release tag.
- **Pending: none.** The `sha256: null` / `checksum_source: "pending"`
  state exists in the schema as a safety net (fetch refuses such entries
  loudly), but the committed manifest contains none.

## Sources per field

- `license_spdx` / `rfn`: nerd-fonts `bin/scripts/lib/fonts.json`
  (`licenseId`, `RFN`) at `v3.5.1` — the upstream machine-readable audit
  (mirrored in upstream's `license-audit.md`).
- `copyright` and `rfn_names`: parsed from the per-family license files
  in the nerd-fonts repo (`patched-fonts/<Family>/…`, falling back to
  `src/unpatched-fonts/<Family>/…`) at `v3.5.1`; for the CJK families,
  from each upstream's own `OFL.txt` at the pinned ref.
- `sha256`: as per the provenance table above.
- `upstream_url` / `version`: tag-pinned release-download URLs; the Noto
  entries use `raw.githubusercontent.com/google/fonts/<commit>/…`.

One normalization: upstream records Overpass as
`OFL-1.1-no-RFN or LGPL-2.1-only` (lowercase `or`); the manifest carries
`OFL-1.1-no-RFN OR LGPL-2.1-only` for valid SPDX expression casing. All
other license ids are upstream's verbatim values (upstream's own
`LicenseRef-*` ids for licenses with no SPDX entry are already valid SPDX
LicenseRef form).

## License distribution and what each means for merged outputs

Every built font is a Modified Version of its source fonts. The licenses
below are the 72 Nerd Fonts families' upstream licenses (counts by
family) plus the CJK additions:

| License | Families | Obligation that touches FontAlloy outputs |
| --- | --- | --- |
| OFL-1.1-RFN | 17 NF + LXGW (6 families) + NotoSansSC | Modified Versions must not use the Reserved Font Name(s); license + copyright accompany every copy |
| OFL-1.1-no-RFN | 32 NF + MapleMono + NotoSerifSC | license + copyright accompany every copy; no reserved names |
| Apache-2.0 | DroidSansMono, Meslo, RobotoMono, Tinos | copyright + license + change notes accompany redistribution |
| BSD-3-Clause | 3270 | copyright + license + disclaimer accompany redistribution |
| BSD-3-Clause-Clear (Go license) | Go-Mono | same, plus no Google endorsement implication |
| Bitstream-Vera | BitstreamVeraSansMono, DejaVuSansMono, OpenDyslexic | **rename requirement**: modified versions must be renamed (upstream also flags BitstreamVeraSansMono `RFN: true`) |
| Bitstream-Vera AND MIT | Hack | both: the Vera rename requirement applies (Hack's own notice reserves "Bitstream" and "Vera" for the Vera-derived part) |
| CC-BY-SA-4.0 | BigBlueTerminal | **share-alike**: adaptations distribute under the same license; attribution required |
| LicenseRef-UbuntuFont (UFL 1.0) | Ubuntu, UbuntuMono, UbuntuSans | not-substantially-changed modifications must keep the original name plus a "derivative X" suffix; licence text accompanies copies |
| MIT | ComicShannsMono, NerdFontsSymbolsOnly, ProFont, ProggyClean | notice accompanies copies |
| MIT OR OFL-1.1-no-RFN | Monoid | dual-licensed; either set of terms |
| OFL-1.1-no-RFN OR LGPL-2.1-only | Overpass | dual-licensed; either set of terms |
| WTFPL | Gohu | no practical conditions |
| LicenseRef-Monofur | Monofur | license file must travel with the font |
| LicenseRef-VicFieger | HeavyData | free license; license text travels with the font |

None of these forbids redistribution, so no family was excluded from the
catalog on licensing grounds. The share-alike families (CC-BY-SA-4.0
BigBlue Terminal; note OFL's own "entirely under this license" term is a
font-scoped share-alike) mean merged outputs built from those sources
must stay under the source license — consistent with the spec decision
that output fonts follow only their source fonts' licenses.

## Reserved Font Names

`rfn: true` families (18 NF + all LXGW families + NotoSansSC). Names were
parsed from the "with Reserved Font Name …" clause of each family's own
license file header; the manifest's `rfn_names` carries them:

- AnonymousPro: Anonymous Pro
- AtkinsonHyperlegibleMono: ATKINSON and HYPERLEGIBLE
- CascadiaCode / CascadiaMono: Cascadia Code
- D2Coding: D2Coding, D2Coding-Bold
- EnvyCodeR: Envy Code R
- Hasklig: Source
- Hermit: Hermit
- IBMPlexMono: Plex
- IntelOneMono: Intel One Mono
- LiberationMono: Liberation
- Monaspace: Monaspace (incl. subfamilies Argon, Neon, Xenon, Radon, Krypton)
- Mononoki: mononoki
- ShareTechMono: Share
- SourceCodePro: Source
- Terminus: Terminus Font, Terminus (TTF)
- iA-Writer: iA Writer, Plex (its Duo variant derives from IBM Plex Mono)
- BitstreamVeraSansMono: flag true, no OFL-style names — the Vera rename
  rule is the binding constraint instead
- LXGW (all six families): 霞鹜, 霞鶩, 落霞孤鹜, 落霞孤鶩, LXGW
- NotoSansSC: Source (declared in google/fonts `ofl/notosanssc/OFL.txt`;
  NotoSerifSC declares none)

Merged outputs never derive their name from source fonts (fixed brand
default `ChHsich`), so RFN compliance is the default behavior; the flags
exist so recipe/UI layers can warn when a user-chosen name collides.

### The LXGW WenKai carve-out

LXGW's OFL (license of record: `main` branch `OFL.txt`, committed
verbatim as `assets/licenses/OFL-1.1-LXGW.txt`) reserves 霞鹜 / 霞鶩 /
落霞孤鹜 / 落霞孤鶩 / LXGW **with an additional permission**: those names
may continue in Modified Versions recompiled from the Original Version
without font-source changes, or in subsetted/web-converted versions for
web delivery — explicitly **not** in installable desktop fonts.
FontAlloy merged outputs are installable desktop Modified Versions, so
they must never carry these names. Bundling/redistributing the
unmodified originals (what `assets fetch` does) is unaffected.

Audit finding worth keeping: the `v1.522` release-tag `OFL.txt` omits the
RFN declaration line that `main` carries. The reserved names are real
(the author's README and the license history declare them); the manifest
therefore sources licensing from the `main`-branch license of record and
records the discrepancy here.

## Copyright gaps (honest nulls)

Nine families ship no copyright line in any license file upstream
publishes; their manifest `copyright` is `null` and the notices say so
explicitly rather than inventing a line:

AurulentSansMono, BigBlueTerminal, Gohu, HeavyData, Lekton, RobotoMono,
Tinos, Ubuntu, UbuntuMono.

(Monofur's license header names the author — "The monofur typeface by
tobias b koehler" — which the manifest carries as its copyright line.)
The license texts themselves remain the notice of record in
THIRD-PARTY-NOTICES.md.

## Regenerating and extending

- Notices: `uv run fontalloy assets notices` (from the repo root) —
  regenerates `THIRD-PARTY-NOTICES.md` byte-identically.
- Manifest edits: keep entries passing the committed-catalog data tests
  (`tests/test_cli_assets.py::TestCommittedCatalog`), which enforce
  schema validity, pinned checksums, tag-pinned URLs, and notices
  generation offline.
- Adding a family: append an entry (family/variant/file/version/
  upstream_url/sha256/license_spdx/rfn/rfn_names/copyright/license_file/
  checksum_source); if the upstream publishes no checksum, download once,
  pin the computed value, and record `checksum_source: "self-computed"`.
- Version bumps: update the tag, URLs, and checksums together — the
  fetcher verifies every artifact against the pinned hash, so a partial
  bump fails loudly rather than silently mixing versions.
