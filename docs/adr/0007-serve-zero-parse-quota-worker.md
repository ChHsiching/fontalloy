# The serve never parses fonts; every fontTools scan runs in a quota'd worker child

Status: accepted (P0, spec #25 aftermath — mandated after a real memory-saturation incident on the 8 GB real-catalog machine)

The owner's absolute rule: **no process may saturate this machine's memory — ever.** The round-31 incident had two in-serve fontTools parse storms: the catalog install path parse-validated every extracted face, and the picker's family documents (names, coverage intervals, placeholder flags) were built lazily per family — partially at request time — inside the long-lived serve. A big CJK face's decompiled glyf/CFF is gigabytes of Python objects; browsing the picker over 96 real families was a second storm. This ADR records the structural fix.

## Decision

1. **The install path is hash-only.** The release document pins sha256 per archive AND per face, so streaming-hash equality already proves the bytes match the release. The client install path (catalog sync) therefore does download → chunked sha256 vs pinned → extract to disk → complete marker, and opens no face with fontTools. "Hash-matches-but-unparsable" is a release-builder defect: it is checked at **packaging** (`package_catalog_release` fails a release whose staged face does not parse — a bounded, lazy name-table open on the release machine), never re-checked in every long-lived client.
2. **Family documents are precomputed at sync time in a quota'd subprocess.** After a family passes hash verification, its document (the exact shape `/catalog/families` serves) is computed ONCE inside a worker child under a HARD memory quota; the child writes it as a small JSON file under `<catalog dir>/docs/`, keyed by the release tag plus the family's archive/face checksums. The serve parent only reads that cache; requests never parse, never even lazily. A quota breach kills the child and surfaces a clear per-family error in the served document (sticky until the serve restarts or the release changes — an endless spawn loop over a deterministic breach is its own incident).
3. **All per-file scans ride the same worker.** `POST /local-fonts` (paths and upload), the `/fonts` enumeration, and the `/system-fonts` scan batch their uncached files to the same child. Verdicts, disk caches, ready flags, and the test delay seams keep their contracts (the seam sleeps in the child now); a worker death degrades to skip verdicts, never a dead enumeration.

## The quota mechanism (and why)

Chosen for dependability with the repo's existing dependencies (stdlib only — no pywin32, no psutil):

- **Windows: a Job Object via ctypes.** `CreateJobObjectW` + `SetInformationJobObject(JobObjectExtendedLimitInformation)` with `JOB_OBJECT_LIMIT_PROCESS_MEMORY`, assigned to the child before it can do real work, plus `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` so a worker can never be orphaned. The limit caps the child's COMMIT CHARGE, so an allocation past the quota fails at the allocator itself: CPython raises `MemoryError`, the worker converts that into the failing unit's error entry and exits with the dedicated code; a C-level abort lands as an NTSTATUS the parent classifies. The OS refuses the mapping whatever the child's code does.
- **POSIX: `resource.setrlimit(RLIMIT_AS)` in `preexec_fn`** — the classic address-space cap, same failure semantics.

Rejected as the primary mechanism: a self-sampling scheme (`tracemalloc` + RSS polling, `--max-rss-mb`) — it observes after the fact, and one fontTools table decompile jumps hundreds of MiB between samples; that gap is the incident. The child does still catch `MemoryError` and report cleanly, which keeps the common breach a per-family error string instead of a crash.

The quota defaults to 1536 MiB (comfortably above an honest whole-CJK-family parse, far below a machine-saturating balloon), overridable via `FONTALLOY_WORKER_MAX_RSS_MB`.

## Proofs (the red-first memory-safety suite, `tests/test_serve_memory_safety.py`)

- Install path, family documents, and all three scan paths: **zero fontTools face constructions in the serve process** (counting seam around every `TTFont` reference the scan paths reach) — written first, proven red on the old design.
- **Parent-RSS-flat**: with a family's document computation made artificially expensive (a test seam allocating past the quota inside the scan), the real subprocess serve's RSS stays flat (measured: +8 MiB against a +520 MiB inflation on the old design) and the family surfaces the quota error.
- Packaging gate: a hash-valid-but-unparsable face fails the release loudly (the check's honest home; the release suite's fixtures became real synthetic fonts for it).

## Consequences

- Document latency shifts: a picker over a cold catalog waits for worker children (batched — one child computes the pass's whole pending set; the 96-family owner scenario settles in seconds, pinned by the owner-scenario spec). The `scanning` flag and per-family errors keep the frontend contract identical.
- The worker needs a real Python interpreter next to the serve (`python -m fontalloy_core.font_worker`). The future PyInstaller/shiv sidecar must therefore ship the worker module and a spawnable interpreter — a bundling constraint recorded here, not yet exercised.
- The collection-face byte endpoints (`/local-fonts/face`, `/system-fonts/file`) still re-serialize one face in-process on request: bounded by that one face, out of the incident's scope, and deliberately left — revisit only if a real face ever disproves the bound.
- Worker failures are sticky per family/scan: a deterministic breach never hot-loops (spawn-per-pass) inside one serve lifetime; a serve restart or a release change clears it.
