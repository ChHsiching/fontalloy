"""Family documents: the picker's catalog model, core-side (issue #38).

This module is the successor of the frontend's variant/face-set model
(``gui/src/catalog/variantAxes.ts`` + ``gui/src/catalog/faceSet.ts``):
one document per catalog family, carrying the display names from the
REAL name tables, the cuts with their face lists, and per-family
readiness — everything a picker needs to render the catalog without the
page touching font bytes (spec #25).

The model is a faithful port, not a redesign:

- **Cut structure** (:func:`variant_cuts`): a family's manifest entries
  collapse by their non-weight axis vector (weight is data, never a
  chip), the canonical member of each bucket prefers the Regular
  weight, the default cut is the one matching the family's implicit
  axis defaults, and every label is the release artifact's own stem
  (:func:`data_cut_label`) until the name tables take over.
- **Face partition** (:func:`face_matches_variant`): the variant-token
  semantics — nf/cn/hw/mono/vf/gb/tc/screen/plus ride the file's own
  words after the family-name strip, weight words stay one-directional,
  and a variant naming no axis matches only the faces carrying no
  discriminator. A cut whose token matches nothing falls back to every
  face of the family (a one-cut family serves all its faces).
- **Representative** (:func:`pick_variant_representative`): the cut's
  plainest Regular-named face (shortest name among the Regulars), the
  identity every surface reads.

Face metadata comes from the synced faces on disk — identity through
:func:`fontalloy_core.load.scan_families`, coverage and the placeholder
flag through :func:`fontalloy_core.placeholder.face_coverage` (honest
codepoints only; placeholder mappings are neither coverage nor the
latin/cjk markers). Scanning a family means opening its faces, so it
never rides a whole-catalog request: a daemon thread builds documents
after the catalog sync lands each family (yielding between families,
the round-25 starvation lesson), an in-process cache keyed by the
release document's own checksums makes every later request a snapshot
read, and a single family may build lazily on demand.
"""

from __future__ import annotations

import os
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fontTools.ttLib import TTFont

from fontalloy_core.catalog import Catalog, CatalogEntry
from fontalloy_core.catalog_release import CatalogRelease, load_catalog_release
from fontalloy_core.errors import FontAlloyError
from fontalloy_core.load import FaceInfo, scan_families
from fontalloy_core.placeholder import face_coverage
from fontalloy_core.preview import ensure_preview, preview_cache_dir
from fontalloy_core.release import METADATA_NAME
from fontalloy_core.systemfonts import _CJK_MARKERS, _LATIN_MARKERS

#: How long the builder thread idles between passes (a pass costs one
#: status snapshot plus cache checks; a family that just landed is
#: picked up within the idle window).
_IDLE_SECONDS = 0.25

#: The GIL slot every in-flight request handler needs while a family's
#: faces are being parsed.
YIELD_SECONDS = 0.002

#: Test seam: when set, the per-family sleep lasts this many seconds
#: instead (deterministic slow builds for the responsiveness tests).
DOCS_DELAY_ENV = "FONTALLOY_FAMILY_DOCS_DELAY"

#: Per-family readiness when the catalog lifecycle is not active (no
#: sync configured: a local-fonts-only serve — the cut structure still
#: renders, the faces never land).
UNSYNCED = "unsynced"

#: Per-family readiness when the sync is configured but its release
#: document does not carry the family (a manifest ahead of the release).
ABSENT = "absent"

# --- the variant-token semantics (the faceSet.ts port) -----------------------


def _cut_words(file: str, family: str) -> str:
    """The file's own words after the family prefix (dash- and
    underscore-tolerant), or the whole stem when the file does not carry
    the family name — without the strip the family's own words would
    read as cut axes (every MapleMono face "is" a Mono cut)."""
    stem = re.sub(r"\.[^.]+$", "", file).lower()
    fam_key = re.sub(r"[-_\s]", "", family).lower()
    if fam_key == "":
        return stem
    raw = key = 0
    while raw < len(stem) and key < len(fam_key):
        if stem[raw] in "-_ " or stem[raw].isspace():
            raw += 1
            continue
        if stem[raw] == fam_key[key]:
            raw += 1
            key += 1
            continue
        return stem  # the file does not carry the family prefix
    return stem[raw:] if key == len(fam_key) else stem


def face_matches_variant(file: str, variant: str, family: str = "") -> bool:
    """Whether ONE face file belongs to the variant's cut.

    Each axis the variant names rides the file's own words IFF it rides
    the variant's: nf (BizinGothicNF vs BizinGothic), cn (NF vs NF-CN),
    hw and mono (SourceHanSansHWSC / NotoSansMonoCJKsc), variable
    (``[``/VF/wght), gb, tc, screen, plus. A variant naming NO axis
    (Standard / Regular / Nerd Font) is the residual plain cut: it
    matches the faces carrying NO discriminator, so a family's plain cut
    never pools its siblings' cuts, in either direction. Weight words
    (light, medium) stay one-directional: a variant asking for them
    narrows, a variant not asking passes every weight.
    """
    v = variant.lower()
    wants_nf = re.search(r"nf|nerd ?font", v) is not None
    wants_cn = "cn" in v
    wants_hw = "hw" in v
    wants_mono = "mono" in v
    wants_variable = re.search(r"variable|vf|\[|wght", v) is not None
    wants_gb = "gb" in v
    wants_tc = "tc" in v
    wants_screen = "screen" in v
    wants_plus = "plus" in v
    n = _cut_words(file, family)
    return (
        wants_nf == (re.search(r"nerd ?font|nf", n) is not None)
        and wants_cn == ("cn" in n)
        and wants_hw == ("hw" in n)
        and wants_mono == ("mono" in n)
        and wants_variable == (re.search(r"\[|vf|wght", n) is not None)
        and wants_gb == ("gb" in n)
        and wants_tc == ("tc" in n)
        and wants_screen == ("screen" in n)
        and wants_plus == ("plus" in n)
        and ("light" not in v or "light" in n)
        and ("medium" not in v or "medium" in n)
    )


def variant_face_files(
    files: list[str] | tuple[str, ...], variant: str | None, family: str = ""
) -> list[str]:
    """Every face file of a family+variant, with the fallback: no
    matching file means the cut serves the family's whole file set
    (a one-cut family serves all its faces whatever its variant word
    happens to contain)."""
    if variant is None or len(files) <= 1:
        return list(files)
    matches = [f for f in files if face_matches_variant(f, variant, family)]
    return matches if matches else list(files)


def pick_variant_representative(
    files: list[str] | tuple[str, ...], variant: str | None, family: str = ""
) -> str | None:
    """The cut's plainest Regular-named face — among the Regulars, the
    SHORTEST file name, so an artifact's sub-face suffixes never outrank
    the cut's own plain Regular. With no Regular-named face the set's
    plainest face is the pick."""
    chosen = variant_face_files(files, variant, family)
    if not chosen:
        return None
    regulars = [f for f in chosen if re.search(r"regular", f, re.IGNORECASE)]
    pool = regulars if regulars else chosen
    return min(pool, key=len)


# --- the cut model (the variantAxes.ts port) ---------------------------------


#: The axes a cut's identity spans (weight and typographic style are
#: data, never chip identity).
CUT_AXES = ("icons", "ligature", "cjk_width", "region", "charset", "rendering")

#: The implicit per-axis defaults a family's cuts disagree against.
_IMPLICIT_DEFAULTS = {
    "icons": "plain",
    "ligature": "liga",
    "cjk_width": "prop",
    "charset": "full",
    "rendering": "print",
}

#: Variant strings that are weight names (anything else is axis data and
#: collapses to Regular so it cannot leak in as a phantom cut axis).
WEIGHT_NAMES = frozenset(
    {
        "Thin",
        "ExtraLight",
        "Light",
        "Regular",
        "Medium",
        "SemiBold",
        "Bold",
        "ExtraBold",
        "Black",
    }
)


def entry_weight(entry: CatalogEntry) -> str:
    """The weight an entry effectively carries (axes first, then a
    weight-named variant, else Regular)."""
    recorded = entry.axes.get("weight")
    if recorded is not None:
        return recorded
    return entry.variant if entry.variant in WEIGHT_NAMES else "Regular"


def _effective_axis(entry: CatalogEntry, axis: str) -> str | None:
    if axis == "weight":
        return entry_weight(entry)
    value = entry.axes.get(axis)
    if value is not None:
        return value
    return _IMPLICIT_DEFAULTS.get(axis)  # region/style carry none


def data_cut_label(file: str, variant: str) -> str:
    """The cut's DATA label: the release artifact's OWN stem — the file
    name without its extension, the catalog's leading index numbering,
    and a trailing version (``14_SourceHanSansHWSC.zip`` →
    ``SourceHanSansHWSC``). Never a translated token, never an invented
    word: it shows until the cut's face is scanned and its name-table
    name takes over."""
    stem = re.sub(r"^\d+_", "", re.sub(r"\.[^.]+$", "", file))
    stem = re.sub(r"[-_]v?\d+(\.\d+)+([-_].*)?$", "", stem)
    return stem or variant


@dataclass(frozen=True)
class Cut:
    """One selectable cut of a family (one chip on its row)."""

    entry: CatalogEntry  # the canonical entry picking this cut resolves to
    default: bool


def variant_cuts(entries: list[CatalogEntry]) -> list[Cut]:
    """The cuts of one family: entries collapsed by their non-weight
    axis vector (canonical member preferring Regular), default first."""
    if not entries:
        return []
    buckets: dict[str, list[CatalogEntry]] = {}
    for entry in entries:
        key = "|".join(_effective_axis(entry, axis) or "" for axis in CUT_AXES)
        buckets.setdefault(key, []).append(entry)
    canonical = [
        next((m for m in members if entry_weight(m) == "Regular"), members[0])
        for members in buckets.values()
    ]

    def values(axis: str) -> list[str]:
        seen: list[str] = []
        for entry in canonical:
            value = _effective_axis(entry, axis)
            if value is not None and value not in seen:
                seen.append(value)
        return seen

    contrasting = [axis for axis in CUT_AXES if len(values(axis)) > 1]
    default_vector = {
        axis: (
            _IMPLICIT_DEFAULTS[axis]
            if _IMPLICIT_DEFAULTS.get(axis) in values(axis)
            else values(axis)[0]
        )
        for axis in contrasting
    }
    default_entry = next(
        (
            entry
            for entry in canonical
            if all(
                _effective_axis(entry, axis) == wanted
                for axis, wanted in default_vector.items()
            )
        ),
        canonical[0],
    )
    cuts = [Cut(entry=entry, default=entry is default_entry) for entry in canonical]
    cuts.sort(key=lambda cut: not cut.default)  # stable: default first
    return cuts


# --- the face scan ------------------------------------------------------------


@dataclass(frozen=True)
class FaceScan:
    """One face's scanned metadata: identity plus honest coverage.

    Placeholder mappings count as neither coverage nor the latin/cjk
    markers — a font faking a CJK plane off one box glyph is not a CJK
    font, which is the entire point of the detection.

    Ticket #36: the coverage travels as COMPRESSED RUN-LENGTH
    INTERVALS beside the counts — the frontend's counters and missing
    view are view-model arithmetic over these runs, never a page-side
    cmap parse (the compressed shape a full CJK face collapses into a
    few hundred entries, the precedence document's own discipline).
    """

    info: FaceInfo
    codepoints: int
    placeholders: int
    latin: bool
    cjk: bool
    #: Ticket #34: the face's glyph count (maxp numGlyphs) — the local
    #: load outcome's 字形 figure, summed over the registered faces.
    glyphs: int
    #: Sorted, disjoint, maximal [start, end] runs of the honest
    #: (placeholder-filtered) coverage.
    intervals: tuple[tuple[int, int], ...] = ()
    #: The suspected-placeholder codepoints, same run shape (the
    #: grid's placeholder-styled cells — usually one run).
    placeholder_intervals: tuple[tuple[int, int], ...] = ()

    @property
    def placeholder(self) -> bool:
        return self.placeholders > 0


def runs_of(points: frozenset[int]) -> tuple[tuple[int, int], ...]:
    """Sorted, disjoint, maximal runs of a codepoint set.

    The compression every face document's coverage intervals use —
    a 30,000-codepoint contiguous CJK plane is ONE entry.
    """
    runs: list[tuple[int, int]] = []
    for codepoint in sorted(points):
        if runs and codepoint == runs[-1][1] + 1:
            runs[-1] = (runs[-1][0], codepoint)
        else:
            runs.append((codepoint, codepoint))
    return tuple(runs)


#: Test-only seam (the memory-safety suite): when set, the scan of one
#: file allocates and holds this many MiB for
#: :data:`TEST_HOLD_ENV` seconds — the artificial "expensive face"
#: standing in for a big CJK face's decompiled outlines without the
#: fixture carrying one. Production never sets either variable.
TEST_ALLOCATE_ENV = "FONTALLOY_TEST_SCAN_ALLOCATE_MB"
TEST_HOLD_ENV = "FONTALLOY_TEST_SCAN_HOLD_SECONDS"


def _test_allocation_hold() -> bytearray | None:
    """The seam's payload: allocated, held, and returned to the caller
    so its scope is the scan's scope."""
    raw = os.environ.get(TEST_ALLOCATE_ENV)
    if not raw:
        return None
    payload = bytearray(int(raw) * 1024 * 1024)
    hold = os.environ.get(TEST_HOLD_ENV)
    if hold:
        time.sleep(float(hold))
    return payload


def scan_file_faces(path: Path) -> list[FaceScan]:
    """Scan every face of one font file: identity through the load
    machinery, coverage through the placeholder detection module.

    Raises :class:`~fontalloy_core.errors.BuildError` when the file is
    missing or unreadable (the caller treats it as a skipped face).
    """
    hold = _test_allocation_hold()  # the memory-safety seam (tests only)
    try:
        return [
            FaceScan(
                info=face,
                **_coverage_summary(path, face.face_index),
            )
            for family in scan_families([path])
            for face in family.faces
        ]
    finally:
        del hold  # released with the scan (pyright: the seam's scope)


def _coverage_summary(path: Path, face_index: int) -> dict[str, Any]:
    """The honest coverage numbers of one face of ``path``."""
    font = TTFont(path, fontNumber=face_index)
    try:
        coverage = face_coverage(font)
        maxp = font.get("maxp")
        return {
            "codepoints": len(coverage.codepoints),
            "placeholders": len(coverage.placeholders),
            "latin": any(marker in coverage.codepoints for marker in _LATIN_MARKERS),
            "cjk": any(marker in coverage.codepoints for marker in _CJK_MARKERS),
            "glyphs": int(maxp.numGlyphs) if maxp is not None else 0,
            "intervals": runs_of(coverage.codepoints),
            "placeholder_intervals": runs_of(coverage.placeholders),
        }
    finally:
        font.close()


def _yield_between_families() -> None:
    """Hand the GIL to request handlers between two families."""
    delay = os.environ.get(DOCS_DELAY_ENV)
    time.sleep(float(delay) if delay else YIELD_SECONDS)


# --- the family-document service ----------------------------------------------


@dataclass
class _Built:
    """One family's scanned document plus its cache key and preview."""

    key: tuple  # the release-side identity the scan was built against
    document: dict[str, Any]
    preview_path: Path | None = None
    preview_etag: str | None = None


class FamilyDocuments:
    """The picker-facing catalog model behind ``GET /catalog/families``.

    Constructed by the serve for every configuration — an unconfigured
    serve reports an empty list, a manifest-only serve renders the cut
    structure with :data:`UNSYNCED` readiness and nothing to scan — and
    started once at serve startup when a catalog directory exists. The
    builder thread polls the sync's status (never the other way around),
    scans each family the sync has landed, and leaves the results in an
    in-process cache; :meth:`documents` is always a snapshot read.
    """

    def __init__(self, catalog: Catalog | None, sync: Any, catalog_dir: Path | None):
        self._catalog = catalog
        self._sync = sync
        self._dir = catalog_dir
        self._lock = threading.Lock()
        self._build_locks: dict[str, threading.Lock] = {}
        self._built: dict[str, _Built] = {}
        self._release: CatalogRelease | None = None
        self._release_stamp: tuple[int, int] | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._manifest_families: dict[str, list[CatalogEntry]] = {}
        if catalog is not None:
            for entry in catalog.entries:
                self._manifest_families.setdefault(entry.family, []).append(entry)

    # -- lifecycle -----------------------------------------------------------

    def start(self) -> None:
        """Start the background builder (a no-op with no catalog dir)."""
        if self._dir is None:
            return
        if self._thread is not None and self._thread.is_alive():
            return
        self._thread = threading.Thread(
            target=self._run, name="fontalloy-family-docs", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        """Build every family the sync lands, one pass at a time."""
        while not self._stop.is_set():
            if not self._pass():
                self._stop.wait(_IDLE_SECONDS)

    def _pass(self) -> bool:
        """One sweep over the release's synced-but-unbuilt families.

        Returns True when any family was built (so the loop re-sweeps
        immediately while families remain); a family whose faces are
        unreadable is skipped and retried next pass — the sync heals
        the disk, the pass after it rebuilds the document.
        """
        release = self._release_document()
        if release is None:
            return False
        progress = self._progress()
        advanced = False
        for family in release.families:
            state = progress.get(family.family)
            if state is None or state.get("state") != "done":
                continue
            with self._lock:
                built = self._built.get(family.family)
            if built is not None and self._current_key(family.family, release) == built.key:
                continue
            self._build_family(family.family)
            advanced = True
            if self._stop.is_set():
                return advanced
            _yield_between_families()
        return advanced

    # -- the polled surface ----------------------------------------------------

    def documents(self) -> dict[str, Any]:
        """The whole-catalog snapshot ``GET /catalog/families`` serves.

        Never scans, never blocks on the builder: families still being
        built render their cut structure with empty face lists, and
        ``scanning`` says a build is in flight (the system-fonts
        ready-flag pattern — the frontend polls).
        """
        release = self._release_document()
        progress = self._progress()
        sync_configured = self._sync.status_document()["configured"]
        with self._lock:
            built = dict(self._built)
        families: list[dict[str, Any]] = []
        scanning = False
        for family in self._family_order(release):
            document = self._stub_document(family, release)
            state = progress.get(family)
            if not sync_configured:
                readiness, error = UNSYNCED, None
            elif state is not None:
                readiness, error = state.get("state"), state.get("error")
            elif release is None or self._in_release(release, family):
                readiness, error = "pending", None
            else:
                readiness, error = ABSENT, None
            entry = built.get(family)
            if entry is not None and self._current_key(family, release) == entry.key:
                document = entry.document
            elif state is not None and state.get("state") == "done":
                scanning = True
            document["readiness"] = readiness
            document["error"] = error
            families.append(document)
        return {"scanning": scanning, "families": families}

    # -- byte sources (the serve's face and preview endpoints) ------------------

    def face_source(self, family: str, file: str) -> tuple[Path, str] | None:
        """One release-listed face's path and pinned sha256, or None.

        Only files the release document lists for the family are
        servable — the endpoint is a byte source for faces the picker
        sees, never a general file reader.
        """
        release = self._release_document()
        if release is None or self._dir is None:
            return None
        for entry in release.families:
            if entry.family != family:
                continue
            for listed in entry.files:
                if listed.file != file:
                    continue
                path = self._dir / Path(entry.zip).stem / file
                if path.is_file():
                    return path, listed.sha256
            return None
        return None

    def preview_source(self, family: str) -> tuple[Path, str] | None:
        """The family's preview subset (path + ETag), or None when the
        family has no scanned faces to derive a name from.

        Builds that one family on demand when the background builder has
        not reached it yet — exactly one family, never the catalog. A
        cached artifact that vanished is regenerated the same way.
        """
        release = self._release_document()
        if release is None or not self._in_release(release, family):
            return None
        state = self._progress().get(family)
        if state is None or state.get("state") != "done":
            return None
        built = self._build_family(family)  # cache hit, or one lazy build
        if built is None or built.preview_path is None:
            return None
        if not built.preview_path.is_file():
            # The cached artifact went away (a wiped catalog directory):
            # rebuild regenerates it from the scanned names.
            built = self._build_family(family, force_preview=True)
            if built is None or built.preview_path is None:
                return None
        return built.preview_path, built.preview_etag or ""

    # -- internals ----------------------------------------------------------------


    def _progress(self) -> dict[str, dict[str, Any]]:
        """The sync's per-family progress, snapshotted."""
        return {
            entry["family"]: entry
            for entry in self._sync.status_document()["families"]
        }

    def _release_document(self) -> CatalogRelease | None:
        """The cached release document, reloaded when the file changes.

        A failing reload keeps the previous copy (a torn write mid-sync
        must not blank the model); a missing document means no release.
        """
        if self._dir is None:
            return None
        document = self._dir / METADATA_NAME
        try:
            stat = document.stat()
            stamp = (stat.st_mtime_ns, stat.st_size)
        except OSError:
            with self._lock:
                self._release, self._release_stamp = None, None
            return None
        with self._lock:
            if stamp == self._release_stamp:
                return self._release
        try:
            release = load_catalog_release(document)
        except FontAlloyError:
            with self._lock:
                return self._release  # keep the last good copy
        with self._lock:
            self._release, self._release_stamp = release, stamp
            return release

    def _release_entry(self, release: CatalogRelease | None, family: str) -> Any | None:
        if release is None:
            return None
        for entry in release.families:
            if entry.family == family:
                return entry
        return None

    def _in_release(self, release: CatalogRelease | None, family: str) -> bool:
        return self._release_entry(release, family) is not None

    def _family_order(self, release: CatalogRelease | None) -> list[str]:
        """Manifest families in manifest order, then release-only ones."""
        families = list(self._manifest_families)
        if release is not None:
            known = set(families)
            families.extend(
                sorted(
                    entry.family
                    for entry in release.families
                    if entry.family not in known
                )
            )
        return families

    def _current_key(self, family: str, release: CatalogRelease | None) -> tuple | None:
        """The release-side identity a scan of ``family`` must match."""
        entry = self._release_entry(release, family)
        if entry is None:
            return None
        return (
            entry.zip,
            entry.sha256,
            tuple((f.file, f.sha256) for f in entry.files),
        )

    def _release_files(self, release: CatalogRelease | None, family: str) -> list[str]:
        entry = self._release_entry(release, family)
        if entry is None:
            return []
        return [listed.file for listed in entry.files]

    def _stub_document(
        self, family: str, release: CatalogRelease | None
    ) -> dict[str, Any]:
        """The unscanned shape: full cut structure, no face metadata."""
        cuts: list[dict[str, Any]] = []
        entries = self._manifest_families.get(family, [])
        files = self._release_files(release, family)
        if entries:
            for cut in variant_cuts(entries):
                cuts.append(
                    {
                        "variant": cut.entry.variant,
                        "def": cut.default,
                        "label": data_cut_label(cut.entry.file, cut.entry.variant),
                        "file": cut.entry.file,
                        "version": cut.entry.version,
                        "sha256": cut.entry.sha256,
                        "axes": dict(cut.entry.axes),
                        "upstream_url": cut.entry.upstream_url,
                        "display_name": None,
                        "representative": pick_variant_representative(
                            files, cut.entry.variant, family
                        ),
                        "faces": [],
                    }
                )
        else:
            entry = self._release_entry(release, family)
            if entry is not None:
                cuts.append(
                    {
                        "variant": "",
                        "def": True,
                        "label": data_cut_label(entry.zip, ""),
                        "file": entry.zip,
                        "version": None,
                        "sha256": entry.sha256,
                        "axes": {},
                        "upstream_url": None,
                        "display_name": None,
                        "representative": pick_variant_representative(files, "", family),
                        "faces": [],
                    }
                )
        return {
            "family": family,
            "readiness": "pending",
            "error": None,
            "scanned": False,
            "display_name": None,
            "display_names": [],
            "preview": None,
            "cuts": cuts,
        }

    def _build_family(self, family: str, *, force_preview: bool = False) -> _Built | None:
        """Scan one family's faces into a cached document (locked per
        family; the winner re-checks the cache under the lock)."""
        with self._lock:
            lock = self._build_locks.setdefault(family, threading.Lock())
        with lock:
            release = self._release_document()
            key = self._current_key(family, release)
            if key is None:
                return None
            with self._lock:
                cached = self._built.get(family)
            if cached is not None and cached.key == key:
                if force_preview or (
                    cached.preview_path is not None and not cached.preview_path.is_file()
                ):
                    self._finish_preview(cached, family, release)
                return cached
            entry = self._release_entry(release, family)
            assert entry is not None and self._dir is not None
            faces_dir = self._dir / Path(entry.zip).stem

            scans: dict[str, list[FaceScan]] = {}
            skipped: list[str] = []
            for listed in entry.files:
                try:
                    faces = scan_file_faces(faces_dir / listed.file)
                except Exception:  # unreadable face: skipped, retried next pass
                    skipped.append(listed.file)
                    continue
                if faces:
                    scans[listed.file] = faces
                else:
                    skipped.append(listed.file)

            files = [listed.file for listed in entry.files]
            shas = {listed.file: listed.sha256 for listed in entry.files}
            document = self._stub_document(family, release)
            document["scanned"] = True
            document["skipped"] = skipped
            cut_names: list[str] = []
            for cut in document["cuts"]:
                variant = cut["variant"]
                for file in variant_face_files(files, variant, family):
                    for scan in scans.get(file, ()):
                        cut["faces"].append(
                            {
                                "file": file,
                                "face_index": scan.info.face_index,
                                "sha256": shas[file],
                                "href": f"/catalog/faces/{family}/{file}",
                                "family": scan.info.family,
                                "subfamily": scan.info.subfamily,
                                "weight": scan.info.weight,
                                "italic": scan.info.italic,
                                "variable": scan.info.variable,
                                "coverage": {
                                    "codepoints": scan.codepoints,
                                    "placeholders": scan.placeholders,
                                    "latin": scan.latin,
                                    "cjk": scan.cjk,
                                    "intervals": [
                                        [start, end]
                                        for start, end in scan.intervals
                                    ],
                                    "placeholder_intervals": [
                                        [start, end]
                                        for start, end in scan.placeholder_intervals
                                    ],
                                },
                                "placeholder": scan.placeholder,
                            }
                        )
                representative = cut["representative"]
                if representative is not None:
                    faces = scans.get(representative, [])
                    if faces and faces[0].info.family:
                        cut["display_name"] = faces[0].info.family
                        cut_names.append(faces[0].info.family)
            names = sorted(set(cut_names))
            document["display_names"] = names
            default_cut = next((c for c in document["cuts"] if c["def"]), None)
            document["display_name"] = (
                default_cut["display_name"] if default_cut else None
            )

            built = _Built(key=key, document=document)
            self._finish_preview(built, family, release)
            with self._lock:
                self._built[family] = built
            return built

    def _finish_preview(
        self, built: _Built, family: str, release: CatalogRelease
    ) -> None:
        """Derive the family's preview subset after a scan (best-effort:
        a subsetting failure leaves the document intact, preview-less)."""
        names = built.document["display_names"]
        if not names or self._dir is None:
            return
        entry = self._release_entry(release, family)
        if entry is None:
            return
        representative = next(
            (
                cut["representative"]
                for cut in built.document["cuts"]
                if cut["def"] and cut["representative"]
            ),
            None,
        )
        if representative is None:
            representative = next(
                (
                    cut["representative"]
                    for cut in built.document["cuts"]
                    if cut["representative"]
                ),
                None,
            )
        if representative is None:
            return
        listed = next((f for f in entry.files if f.file == representative), None)
        if listed is None:
            return
        source = self._dir / Path(entry.zip).stem / representative
        if not source.is_file():
            return
        try:
            path, etag = ensure_preview(
                source, listed.sha256, names, preview_cache_dir(self._dir)
            )
        except Exception:
            return  # a failed derivation costs a missing preview, never an error
        built.preview_path = path
        built.preview_etag = etag
        built.document["preview"] = f"/catalog/families/{family}/preview"
