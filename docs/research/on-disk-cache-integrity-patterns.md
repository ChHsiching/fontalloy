# On-disk artifact caches: trust at launch, verify lazily — established patterns

Research question: what is the established pattern for a desktop application to
trust a large on-disk downloaded artifact cache at launch WITHOUT re-verifying
it on the startup critical path — while still self-healing corruption and
missing files lazily?

Context: FontAlloy downloads a ~48 GB font catalog (per-family zip + extracted
faces + completion markers recording sizes). The product ruling is that second
launch must be as fast as possible, and integrity assurance must be built into
the mechanism rather than shown as "checking…" UX.

All findings below are from primary sources: official documentation, design
docs, or reference-implementation source code. No secondary write-ups.

---

## Per-system findings

### 1. Git object store — hash computed at write, trusted at read; `fsck` is on demand

Source: <https://git-scm.com/book/en/v2/Git-Internals-Git-Objects> (Pro Git,
official). Git is a content-addressable key-value store: the SHA-1 of
`"<type> <size>\0" + content` is computed **before storage** — "you can insert
any kind of content into a Git repository, for which Git will hand you back a
unique key" — and the object is written to `.git/objects/<2-hex>/<38-hex>`,
zlib-compressed, **filename = hash**. Nothing in the chapter describes a
per-read or per-startup hash re-check; retrieval works purely by hash
addressing (`git cat-file -p <sha>`).

Source: <https://git-scm.com/docs/git-fsck> (official man page). The
dedicated integrity tool is separate and on demand: "git-fsck tests SHA-1 and
general object sanity… It prints out any corruption it finds (missing or bad
objects)" — including the diagnostic "hash mismatch <object>… indicates a
serious data integrity problem." The page documents **no automatic trigger**;
integrity checks during transfers exist only as opt-in configuration
(`fetch.fsckObjects` / `receive.fsckObjects`). Recovery guidance is to remove
corrupt objects and re-fetch them from a healthy copy.

What this establishes: verification at ingest (the hash *is* the storage key,
so a successful write is a verified write); zero verification on ordinary
reads; deep verification exists as an explicit, user-invoked tool.

### 2. npm cache (cacache) — SRI integrity keys; verify the entry you touch; `verify` is offline maintenance

Source: <https://github.com/npm/cacache> (official README of npm's
content-addressable cache library). Entries are keyed two ways: a logical
index key, and a **content address** that is a Subresource Integrity string
(`<hash-algorithm>-<base64-integrity-hash>`, default sha512). Integrity is
enforced **on write** ("If this option is provided and does not match the
post-insertion digest, insertion will fail with an EINTEGRITY error") and **on
the read of an individual entry** (`get`/`get.stream` fail "if the
locally-stored data does not pass the validity checksum"). `cacache.verify`
is a separate offline operation: it "checks integrity for all content entries
and removes invalid content" plus garbage-collects — with
`cacache.verify.lastRun(cache)` provided so hosts can schedule it
periodically. It is never described as a startup requirement.

Source: <https://raw.githubusercontent.com/npm/cli/latest/docs/lib/content/commands/npm-cache.md>
(official npm CLI docs; published at
<https://docs.npmjs.com/cli/commands/npm-cache>). The cache is "a
`cacache`-based content-addressable cache that stores all http request data."
Key quotes:

- "All data that passes through the cache is fully verified for integrity on
  both insertion and extraction."
- "Cache corruption will either trigger an error, or signal to `pacote` that
  the data must be refetched" — i.e. per-entry failure converts into a
  re-download of just that entry.
- `npm cache verify` is "an offline verification of existing cache contents."
- "This is typically unnecessary, as npm's cache is self-healing and resistant
  to data corruption issues" (why `npm cache clean` requires `--force`).

What this establishes: verification happens at write and at **use** (the one
package being extracted), never as a whole-store startup walk; a failing
entry is deleted and re-fetched; whole-store verification is an offline,
explicit command.

### 3. Steam depots — manifest records per-file SHA-1 and sizes; verified during download; "Verify Integrity" is a user-initiated repair

Source: <https://partner.steamgames.com/doc/sdk/uploading> (Valve Steamworks
official). "SteamPipe initially splits each file into roughly one megabyte
(MB) chunks"; "Each chunk is then compressed and encrypted before being
uploaded to the Steam content-delivery system" and stays that way "until
downloaded by each client, where they are decrypted and expanded." "A final
manifest is generated for this depot version; each manifest is identified by
a unique 64-bit manifest ID." Delta updates reuse chunks that "match the
previous build of the game."

Source: <https://github.com/SteamRE/SteamKit/blob/master/SteamKit2/SteamKit2/Types/DepotManifest.cs>
(SteamKit2, the reference open-source implementation of the Steam protocol —
source code as primary evidence of the manifest format). `FileData` carries
`FileName`, `FileNameHash` ("SHA-1 hash of this file's name"), `FileHash`
("SHA-1 hash of this file"), `TotalSize`, `Flags`, and `Chunks`.
`ChunkData` carries `ChunkID` ("SHA-1 hash chunk id" — the content-addressed
key used to fetch the chunk), `Checksum` ("expected Adler32 checksum of this
chunk"), and compressed/uncompressed lengths. So the manifest is exactly a
ledger of file names, sizes, per-file SHA-1s, and chunk addresses.

Source: <https://help.steampowered.com/en/faqs/view/0C48-FCBD-DA71-93EB>
(Steam Support, "Verify Integrity of Game Files"; the page is JS-rendered so
it could not be quoted verbatim, but its existence, title, and function — a
manual command under Properties → Installed Files that re-checks installed
files and re-acquires the ones that fail — are confirmed). Valve positions
full verification as the **user-driven remedy for symptoms** (missing
textures, crashing), not a launch step. Valve does not publicly document any
launch-time re-verification; the documented verification points are the
download/update path and this explicit command. (SteamWorks docs also note
per-file `userconfig` data "won't trigger a verification error if it's
different from the previous version" — verification is manifest-driven, not
directory-driven.)

What this establishes: the authoritative manifest (hashes + sizes) is applied
at download time; afterwards the installed tree is trusted to launch; deep
verification is an explicit repair action that re-acquires only failing
files.

### 4. apt / Debian archives — checksums + sizes enforced at acquisition; local copy trusted afterwards

Source: <https://wiki.debian.org/DebianRepository/Format> (official Debian
wiki, normative repository format). The `Release` file carries checksum
lists — `MD5Sum`, `SHA1`, `SHA256` — where each entry is "the checksum, the
file size, and a filename relative to the Release file's directory",
describing the package index files. `Packages` stanzas carry `Size`
(mandatory) and `SHA256` (recommended) per package archive. Enforcement is at
download: every file "should be checked at least once, either in compressed
or uncompressed form," and on mismatch "the client shall not use any
information from that file, inform the user, and might use old information."
"Clients may not use the MD5Sum and SHA1 fields for security purposes, and
must require a SHA256 or a SHA512 field." Nothing in the format describes
re-hashing the local `/var/cache/apt` copy on later invocations — the
documented enforcement point is acquisition.

What this establishes: an upstream, signed ledger (Release) pins hashes and
sizes; they are checked when data is fetched; once on disk, the copy is
trusted. This is the "authoritative remote ledger + trust local bytes"
model.

### 5. Chromium disk cache — no startup scan; per-entry validation at open; discard on corruption

Source: <https://www.chromium.org/developers/design-documents/network-stack/disk-cache/>
(official Chromium design doc). The cache applies **no cryptographic
validation** to cached data; checks are structural: "the magic number on the
header matches the expected value, and that the version is correct" for the
index and every block-file. Corruption is discovered **lazily**: dirty
entries are detected when read; deeper list corruption "will not be detected
at start up… but at some point we'll find out and proceed to discard the
whole cache" — recovery is wholesale discard rather than a startup scan,
because salvaging isn't "worth the increased complexity."

Source: <https://www.chromium.org/developers/design-documents/network-stack/disk-cache/very-simple-backend>
(official design doc for the Simple Cache backend; the page notes it is
"significantly out-of-date" but it is the design rationale of record). One
file per entry, plus a small index that is "flushed on shutdown, and
periodically while running." After a crash the browser has a stale index,
and rather than scanning at startup it "periodically scan[s] the directory
for entries missing from the index" **after** startup; it can even "operate
without the IO thread index by directly opening files in the directory."
The explicit tradeoff: after a crash Chrome "will start with a stale cache,
rather than have to drop its entire cache." Entries are published by atomic
file swap, and durability is delegated downward: "It is not a filesystem.
The disk cache delegates filesystem operations to the filesystem." Entry
files themselves embed "a magic number and version field" and checksummed
data chunks — per-entry structure that can be checked when the entry is
opened.

What this establishes: startup cost is minimized to reading a small index;
entries are validated individually at open time; a bad entry (or worst case
the whole cache) is discarded and refetched later; periodic reconciliation
runs in the background, not on the critical path.

### 6. Ledger / quick-check patterns — rsync and OCI/Docker

Source: <https://manpages.debian.org/trixie/rsync/rsync.1.en.html> (official
man page). rsync's default decision is a metadata-only quick check:
"Normally rsync will skip any files that are already the same size and have
the same modification timestamp." `--checksum` is the explicit opt-in to
reading all data ("compares a 128-bit checksum for files of matching size"),
and the man page warns it means "both sides will expend a lot of disk I/O
reading all the data in the files" and "can slow things down significantly."
So the default trust model is: recorded metadata ⇒ same content; hashing
everything is an exceptional, expensive mode. (rsync always performs a
whole-file checksum exchange **during** transfer — verify at write.)

Source: <https://github.com/opencontainers/distribution-spec/blob/main/spec.md>
(OCI distribution spec — the Docker registry protocol). Blobs and manifests
are content-addressed by digest ("a unique identifier created from a
cryptographic hash of a Blob's content"). Verification points are **push and
pull only**: on push the registry rejects with `DIGEST_INVALID` when "the
provided digest did not match uploaded content"; on pull "Clients SHOULD
verify that the response body matches the requested digest," and the content
verification use case states "After each layer is downloaded, the engine
verifies the digest of the layer." The spec defines no re-verification at
`docker run` — once pulled, layers on local disk are trusted at container
start.

What this establishes (combined with npm): the "ledger" model — write
`hash + size` when an item completes, verify against it at ingest and at
per-item use, and offer a full-sweep verification only as explicit
maintenance.

---

## The convergent pattern

Every system above splits integrity assurance into the same three phases:

1. **Verify once, at ingest (the write path).** The hash is computed while
   the bytes are being written (git computes the key from the content it is
   about to store; cacache fails insertion on digest mismatch; OCI registries
   reject mismatched pushes; apt clients validate against the Release file at
   fetch; SteamPipe chunks are addressed/checked during download). The
   record of `hash + size` (object filename, SRI key, manifest entry,
   Release checksum list) is written **only for verified data**, published
   atomically (temp + rename / marker last).

2. **Trust the ledger at startup; never hash payloads to get going.** Git has
   no startup check; npm never walks the store; apt doesn't re-hash the local
   cache; Chromium reads at most a small index and tolerates a stale one;
   Steam launches installed games without re-verification. rsync's default
   "quick check" is the distilled principle: recorded metadata (size, mtime)
   is sufficient to treat local bytes as valid.

3. **Validate per-item, at use time; repair by re-fetching that item.** The
   only artifact verified on the normal path is the one actually being
   consumed (npm verifies on extraction; Chromium checks entry structure at
   open; git decompresses the object it reads). A failure dooms exactly that
   entry (cacache deletes and pacote refetches; Chromium discards the entry;
   Steam's verify re-acquires only failing files). Deep, whole-store
   verification exists everywhere — git fsck, `npm cache verify`, Steam
   "Verify Integrity", rsync `--checksum`, apt re-fetch — but always as an
   explicit/offline/background action, never on the interactive critical
   path.

Two sub-patterns are worth naming:

- **Authoritative remote ledger + local completion claim.** apt/Steam/npm all
  keep the authoritative hashes in a small upstream document (Release file,
  depot manifest, lockfile SRI). The local marker/claim only asserts "this
  completed against ledger version X" — it does not need to duplicate the
  hashes.
- **Cheap check escalation.** stat (existence + size) → structural/header
  check → full hash, in that order, escalating only on anomaly (rsync
  quick check; Chromium magic/version before anything; our stat-only
  completeness check).

---

## Recommendation for the FontAlloy catalog store

The current `catalog_sync.py` mechanism (release document
`catalog-release.json` + per-family `<archive>.complete` markers + `.part`
temps + atomic replace) is exactly the convergent pattern; keep its shape and
make the trust boundaries explicit:

- **Record at completion (ingest, unchanged in substance):** the marker is
  written last, only after the archive's sha256 and every listed face's
  sha256 verify against the release document (the authoritative upstream
  ledger — the apt Release-file role). Marker content: release tag + archive
  size + per-face sizes (as today). Do not bother duplicating the sha256s in
  the marker: the pinned release document is the hash ledger, so use-time
  verification compares against it — one authority, not two.
- **Trust at launch:** read the cached release document + markers, then a
  stat-only completeness check per family (marker exists, tag matches,
  archive and every face exist with recorded sizes — no byte is hashed). No
  tree walk beyond the per-family directory listings implied by stat, no
  re-hash, no "checking" UX. This is `start()`'s `verify_hashes=False` fast
  path; it must remain the only startup pass.
- **Verify at use time (the lazy self-heal trigger):** when the merge
  pipeline actually opens a face, run the cheap check (size from the
  marker/ledger); on mismatch or open failure, hash that one face against the
  ledger, and on failure mark the family incomplete and re-sync just that
  family (archive delete → `.part` download → verify → marker last). The
  npm/pacote refetch loop is the model: corruption becomes a re-download of
  one family, silently.
- **Deep verification as explicit repair:** keep `POST /catalog/sync` with
  `verify_hashes=True` (the "Steam Verify Integrity" / `npm cache verify`
  equivalent) for symptom-driven repair, and optionally schedule it
  periodically in the background (the `cacache.verify.lastRun` pattern) —
  never on the launch path.
- **Failure scoping:** one anomalous family must never block or fail the
  others (already the per-family try/except discipline in `_run`); a
  corrupt/missing ledger document itself (`catalog-release.json` fails to
  parse) degrades to a cold fetch, and an unparseable marker (`_marker_claim`
  → `None`) is just another anomaly that triggers that family's repair.

## Open risks

- **Bit rot / same-size corruption on consumer disks.** The stat-only launch
  check cannot catch content changes that preserve size (the rsync man
  page's implicit caveat: the quick check trusts size+mtime, `--checksum`
  exists precisely because metadata can match while bytes differ). This is
  accepted by every surveyed system; the mitigations are use-time hashing of
  the file actually consumed and the explicit deep-verify pass. If we want a
  bounded safety net, the cheap escalation is: hash a face the first time it
  is opened in a session (48 GB of faces are never all opened in one
  session), not at launch.
- **AV / ransomware tampering.** Antivirus quarantine typically deletes or
  truncates files after download — which the stat check catches immediately
  (missing file / size mismatch → family repair). The failure mode to watch
  is a re-download loop (AV deletes every re-fetched zip); that argues for
  surfacing repeated repair of the same family as a distinct error
  ("repaired twice in a row — check your AV exclusions") rather than looping
  silently. (Steam Support documents AV-vs-game-files interference and
  recommends verification as the remedy; same operational shape.)
- **Ledger authenticity.** Our ledger is the release document; the sha256
  chain only binds catalog content if the document itself comes from a
  trusted origin over TLS (as designed). A compromised document compromises
  everything downstream — this is apt's SecureApt argument for signing the
  Release file; if the catalog ever serves from a mirror, the document needs
  a signature, not just HTTPS.
- **Windows rename atomicity.** The marker-last + atomic-replace scheme
  depends on `os.replace` semantics on Windows (rename-over-existing is
  atomic on NTFS, but file locks from AV/indexers can make it fail
  transiently); the repair path must treat a failed rename as an incomplete
  family, not a crash.
