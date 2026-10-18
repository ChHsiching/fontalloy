"""``fontalloy serve``: the core as a localhost HTTP service (issue #11).

The localhost contract both frontends consume (ADR-0002): the WebApp in
the browser and the Tauri GUI's webview talk to this service over plain
HTTP, and the GUI bundles it as a binary sidecar. Everything here is the
Python standard library — ``http.server`` with a threading server —
because the sidecar bundle (PyInstaller/shiv) must stay lean: a heavy
framework would be a liability the service gains nothing from. The
builds themselves run on one worker thread (fontTools pipelines are
CPU- and memory-bound; serial builds keep them predictable), submitted
concurrently and queued, never lost.

Security posture, per the spec: the server binds 127.0.0.1 ONLY — the
address is hard-coded, there is no ``--host`` flag, and no other
interface is ever listened on. CORS allows only the origins passed via
``--allow-origin`` (the WebApp origin in production; the Tauri webview
origins for the GUI-spawned instance). Requests from other origins get
no CORS headers and their preflights are rejected, so a browser can
neither read responses nor submit builds — CORS is browser mediation,
not access control, and the loopback bind is the real boundary.

Endpoint map (all bodies JSON, all responses carry CORS headers only
for allowed origins):

=============  ======  ==================================================
path           method  response
=============  ======  ==================================================
``/health``    GET     service identity + the bound 127.0.0.1 address
``/catalog``   GET     the manifest's families (grouped per family)
``/catalog/status`` GET  the catalog sync state machine (issue #26)
``/catalog/sync``   POST re-run the catalog sync (re-check + repair)
``/catalog/families`` GET  per-family picker documents (issue #38)
``/catalog/faces/fam/file`` GET  one face's bytes, streamed + cached
``/catalog/families/fam/preview`` GET  the family's preview subset
``/catalog/stars`` GET  launch-cached GitHub stars (offline-tolerant)
``/fonts``     GET     local font directories, scanned into families
``/local-fonts`` POST  scan absolute font paths into family docs (31)
``/local-fonts/upload`` POST  one uploaded font file, scanned (36)
``/local-fonts/face`` GET  one scanned local face's extracted bytes
``/builds``    GET     every retained build, newest last
``/builds``    POST    submit a merge (recipe-shaped JSON) -> 202 + id
``/builds/id`` GET     one build's status/stage/artifact document
``/builds/id/cancel`` POST  stop a queued/running build (idempotent)
``/builds/id/font``   GET  the output font (ttf/ttc/woff2 bytes)
``/builds/id/report`` GET  the verification report JSON
``/precedence-resolve`` POST  the effective table for picks+rules (28)
=============  ======  ==================================================

Progress transport is polling: ``GET /builds/{id}`` reports the stage
the pipeline entered (``loading`` … ``reporting``, then ``done``) plus
a ``facts`` object — the quantitative readout the pipeline already
knows at that point (file count/sizes, slot count, rule and codepoint
counts, format and an estimated size, the check count), refreshed
mid-stage as numbers resolve (round 13, owner item 5). A stage without
facts carries ``null``; consumers degrade to stage names alone.
Polling over a stateless endpoint is the lean choice for a stdlib
threaded server — an SSE stream would pin one thread per watcher and
complicate graceful shutdown — and stage granularity fits builds that
take seconds, not sub-seconds. The GUI (#16) and WebApp (#22) poll at
250ms–1s.

Lifecycle: each build writes its artifacts into a scratch directory the
service owns; only the ``keep-builds`` newest finished builds are
retained (older artifacts are deleted with their registry entries).
SIGINT/SIGTERM (SIGBREAK on Windows) stop the accept loop and the
worker — the running build aborts at its next stage boundary, queued
builds never start, and every scratch directory the service created is
removed before exit.
"""

from __future__ import annotations

import json
import logging
import os
import queue
import re
import shutil
import signal
import sys
import tempfile
import threading
import urllib.parse
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from fontalloy_core.build import build_recipe
from fontalloy_core.catalog import Catalog, load_manifest
from fontalloy_core.catalog_sync import CatalogSync
from fontalloy_core.errors import BuildCancelled, FontAlloyError
from fontalloy_core.family_docs import FamilyDocuments
from fontalloy_core.load import (
    FaceInfo,
    aggregate_families,
    scan_families,
)
from fontalloy_core.local_fonts import FONT_SUFFIXES, LocalFonts, extract_face
from fontalloy_core.precedence_api import resolve_document
from fontalloy_core.recipe import Recipe, parse_recipe
from fontalloy_core.stars import StarsCache
from fontalloy_core.systemfonts import (
    ScanResult,
    face_etag,
    face_href,
    group_system_families,
    load_cache,
    scan_system_fonts,
    system_font_dirs,
)
from fontalloy_core.report import file_sha256

#: The interface the service binds — and the only one it ever binds.
BIND_ADDRESS = "127.0.0.1"

#: Set by the GUI shell (issue #16) to arm the stdin watchdog: the
#: sidecar parent owns the service's stdin pipe, and when that pipe
#: closes — the app exited, with or without a chance to kill the child
#: process tree — the service stops itself gracefully instead of being
#: orphaned on a loopback port. Off by default: an interactive
#: ``fontalloy serve`` keeps the terminal's stdin untouched.
STDIN_WATCH_ENV = "FONTALLOY_SERVE_STDIN_WATCH"

#: Recipe submissions are small (paths and rules, never font bytes).
MAX_BODY_BYTES = 10 * 1024 * 1024

#: Ticket #36: the upload ceiling — one font FILE, never a font
#: COLLECTION of collections. A real worst-case family face is a few
#: hundred MB; 1 GiB covers every legitimate single upload while
#: keeping a runaway body from filling the disk.
MAX_UPLOAD_BYTES = 1024 * 1024 * 1024

#: Output-format content types for artifact downloads.
FONT_CONTENT_TYPES = {
    "ttf": "font/ttf",
    "otf": "font/otf",
    "ttc": "font/collection",
    "woff2": "font/woff2",
}

#: Font file suffixes the local-font enumeration considers (the
#: local-fonts scan module owns the set; the /fonts enumeration shares
#: it — one definition of "a font file").
_FONT_SUFFIXES = FONT_SUFFIXES

#: Disk artifacts stream in these chunks (a face is never buffered
#: whole inside a handler — the renderer-side byte-pinning lesson,
#: server-side).
_STREAM_CHUNK = 1 << 20


@dataclass(frozen=True)
class ServeOptions:
    """Everything the service is configured with at startup.

    ``port`` 0 means an OS-assigned ephemeral port — the Tauri sidecar
    pattern: the GUI spawns ``serve --port 0`` and reads the bound URL
    from stdout. ``manifest`` may not exist (an empty catalog is a
    valid local-fonts-only setup); a manifest that exists but does not
    validate fails startup loudly. ``work_dir`` is where build scratch
    lives; the default is a fresh system temp directory the service
    removes on exit, while a caller-provided directory is left in place
    (only the service's own scratch inside it is removed).
    """

    port: int = 0
    allow_origins: tuple[str, ...] = ()
    manifest: Path | None = None
    font_dirs: tuple[Path, ...] = ()
    work_dir: Path | None = None
    keep_builds: int = 10
    # Round 24 (owner item 3): the system font directories to enumerate
    # (None = the platform's standard set). The serve CLI flag of the
    # same name is also the e2e seam — a fixture directory stands in
    # for C:\Windows\Fonts.
    system_font_dirs: tuple[Path, ...] | None = None
    # Round 25: where the scan persists its result (None = no disk
    # cache; the scan re-runs per process). The GUI passes its app-data
    # directory so a steady-state launch stat-walks instead of parsing.
    system_cache_dir: Path | None = None
    # Issue #26 (spec #25): the catalog lifecycle the serve owns. The
    # release document's origin — the base URL serving
    # catalog-release.json (the catalog release tag's download address
    # in production, a file:// directory in the offline suite) — and
    # the cache directory the families land in (the desktop appData
    # font dir; a CLI-specified directory elsewhere). Both together
    # activate the sync service behind /catalog/status; neither means a
    # local-fonts-only serve with a quiescent catalog.
    catalog_release_origin: str | None = None
    catalog_dir: Path | None = None


class _BuildAborted(Exception):
    """Raised inside the pipeline when shutdown interrupts a build."""


class _LogRing(logging.Handler):
    """A bounded in-memory sink for library log records.

    fontTools logs warnings on every table it finds odd (a synthetic or
    vintage ``head`` timestamp, for one). A long-lived service must not
    write those to stderr unconditionally: a consumer that spawns serve
    without draining its stderr pipe would fill the 64 KB buffer and
    wedge the build worker mid-write. Installing this handler on the
    root logger reroutes every library record into a small ring (the
    implicit ``lastResort`` stderr handler never fires once a root
    handler exists), keeping the service immune to undrained pipes.
    """

    def __init__(self, capacity: int = 256):
        super().__init__(level=logging.WARNING)
        self.records: deque[str] = deque(maxlen=capacity)

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self.records.append(
                f"{record.name}: {record.getMessage()}"
            )
        except Exception:
            # A logging failure must never take the service down.
            pass


def _now() -> str:
    """A UTC timestamp for status documents (never in built artifacts)."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


@dataclass
class BuildJob:
    """One submitted merge and everything observable about it."""

    id: str
    recipe: Recipe
    submitted_at: str = field(default_factory=_now)
    status: str = "queued"  # queued | running | done | failed | cancelled
    stage: str | None = None
    #: Round 13 (owner item 5): the live facts of the CURRENT stage —
    #: the quantitative readout (file count/sizes, slot count, rule
    #: count, …) the pipeline already knows. Replaced on every stage
    #: entry (None clears it), refreshed in place mid-stage.
    facts: dict[str, Any] | None = None
    started_at: str | None = None
    finished_at: str | None = None
    error: str | None = None
    build_dir: Path | None = None
    font_size: int | None = None
    font_sha256: str | None = None
    #: Round 19: the cooperative-cancel flag. The cancel endpoint sets
    #: it; the pipeline consults it at stage boundaries and inside the
    #: long loops, so a running build stops within a fraction of a wide
    #: graft and the worker moves on to the next queued build.
    cancel: threading.Event = field(default_factory=threading.Event)

    @property
    def format(self) -> str:
        return self.recipe.output.format

    @property
    def family(self) -> str:
        return self.recipe.output.family

    @property
    def font_path(self) -> Path | None:
        if self.build_dir is None:
            return None
        return self.build_dir / f"{self.family}.{self.format}"

    @property
    def report_path(self) -> Path | None:
        if self.build_dir is None:
            return None
        return self.build_dir / f"{self.family}.report.json"


class ServeState:
    """The shared state behind the HTTP handler and the build worker.

    One lock guards the registry; builds run on the single worker
    thread, so mutations are rare and short. Font paths inside a
    submitted recipe resolve against ``recipe_root`` (the serve process
    working directory) — the GUI and WebApp send absolute paths.
    """

    def __init__(self, options: ServeOptions, port: int, recipe_root: Path):
        self.options = options
        self.port = port
        self.recipe_root = recipe_root
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.jobs: dict[str, BuildJob] = {}
        self._queue: queue.Queue[BuildJob] = queue.Queue()
        self.catalog: Catalog | None = self._load_catalog(options.manifest)

        created_root = options.work_dir
        if created_root is None:
            created_root = Path(tempfile.mkdtemp(prefix="fontalloy-serve-"))
        else:
            created_root.mkdir(parents=True, exist_ok=True)
        self.build_root = created_root
        self._owns_root = options.work_dir is None
        self._created_dirs: set[Path] = set()
        self._system_result: ScanResult | None = None
        self._system_ready = False
        self._system_dirs = tuple(
            options.system_font_dirs
            if options.system_font_dirs is not None
            else system_font_dirs()
        )
        self._system_cache_file = (
            options.system_cache_dir / "system-fonts-cache.json"
            if options.system_cache_dir is not None
            else None
        )
        # Round 25 (owner items 1+2, the wedge): the scan runs on a
        # daemon thread, NEVER inside a request handler — the thread
        # yields the GIL between files, so /health and every other
        # endpoint stay live while a real machine's font directory is
        # being parsed, and the disk cache makes steady-state launches
        # a stat walk only. Round 26 correction: the thread starts
        # LAZILY, at the first /system-fonts touch — a serve nobody
        # asks about system fonts (tests, /fonts-only consumers) never
        # scans the machine at all; spawning it at boot made every
        # fixture serve parse the real font directory.
        self._system_thread: threading.Thread | None = None
        # Issue #26: the catalog sync service polled at /catalog/status.
        # Unlike the system-fonts scan it starts EAGERLY at serve
        # startup when configured — filling the catalog is the point of
        # a launch — on its own daemon thread, never in a handler.
        self.catalog_sync = CatalogSync(
            options.catalog_release_origin, options.catalog_dir
        )
        # Issue #38: the picker-facing catalog model (family documents,
        # face/preview byte sources) and the launch-cached stars. The
        # documents build on their own thread as the sync lands
        # families; both are snapshot-only from request handlers.
        self.family_docs = FamilyDocuments(
            self.catalog, self.catalog_sync, options.catalog_dir
        )
        self.stars = StarsCache(self.catalog)
        # Issue #31: the on-demand local-font index behind POST
        # /local-fonts (paths in, family documents with server-side TTC
        # expansion out) and the GET /local-fonts/face byte source. The
        # scan runs inside the POST, bounded per file and yielding
        # between files; later scans of unchanged paths are cache reads.
        self.local_fonts = LocalFonts()
        # Ticket #36: the serve-owned scratch dir uploaded font FILES
        # land in (POST /local-fonts/upload — the browser fallback's
        # byte-free flow). Created lazily; removed with every other
        # scratch directory at shutdown.
        self._upload_dir: Path | None = None

    def upload_scratch(self) -> Path:
        """The scratch directory uploads stream into (created once)."""
        with self.lock:
            if self._upload_dir is None:
                directory = self.build_root / "uploads"
                directory.mkdir(parents=True, exist_ok=True)
                self._created_dirs.add(directory)
                self._upload_dir = directory
            return self._upload_dir

    # -- startup -----------------------------------------------------------

    @staticmethod
    def _load_catalog(manifest: Path | None) -> Catalog | None:
        """The catalog, or None when no manifest is configured/found.

        A missing manifest file is an empty catalog (serve must start
        for local-fonts-only setups); an invalid one is a startup error.
        """
        if manifest is None or not Path(manifest).is_file():
            return None
        return load_manifest(manifest)

    # -- submission --------------------------------------------------------

    def submit(self, data: object) -> BuildJob:
        """Validate a recipe submission and queue it as a build.

        Raises :class:`~fontalloy_core.errors.RecipeError` for a body
        that is not the recipe schema (the caller maps that to a 400
        response) — validation is synchronous so malformed submissions
        never occupy the queue.
        """
        recipe = parse_recipe(data, self.recipe_root)
        job = BuildJob(id=uuid.uuid4().hex, recipe=recipe)
        with self.lock:
            self.jobs[job.id] = job
        self._queue.put(job)
        return job

    def precedence_resolve(self, data: object) -> dict[str, Any]:
        """Resolve one precedence request (ticket #28) to its document.

        Synchronous by measurement (see
        :mod:`fontalloy_core.precedence_api`): the walk is the same one
        the build pipeline's resolving stage performs, and at
        visible-universe scale it answers in a few seconds while the
        threaded server keeps every other endpoint live. Raises
        :class:`~fontalloy_core.errors.FontAlloyError` for a malformed
        request or an unresolvable font reference (the caller maps that
        to a 400 response).
        """
        return resolve_document(
            data,
            root=self.recipe_root,
            manifest=self.options.manifest,
        )

    def queue_position(self, job: BuildJob) -> int | None:
        """1-based position among the queued builds, None once running."""
        with self.lock:
            position = 0
            for candidate in self.jobs.values():
                if candidate.status != "queued":
                    continue
                position += 1
                if candidate.id == job.id:
                    return position
        return None

    # -- cancellation ------------------------------------------------------

    def cancel_job(self, job: BuildJob) -> bool:
        """Stop a build (round 19): arm its flag, and when it has not
        started yet, retire it on the spot.

        Idempotent and settle-safe: a job already done, failed, or
        cancelled is a no-op (returns False); a queued job lands
        ``cancelled`` immediately — the worker later dequeues it and
        skips it before any scratch exists; a running job keeps its
        status until the pipeline's next cancellation point (stage
        boundary or loop cadence) raises, at which point the worker
        lands ``cancelled`` and frees itself for the next queued build.
        Returns True when this call actually moved the job towards
        cancellation.
        """
        with self.lock:
            if job.status in ("done", "failed", "cancelled"):
                return False
            job.cancel.set()
            if job.status == "queued":
                job.status = "cancelled"
                job.finished_at = _now()
                return True
            return True

    # -- worker side -------------------------------------------------------

    def next_job(self, timeout: float) -> BuildJob | None:
        """The next queued build, or None on timeout/stop."""
        if self.stop.is_set():
            return None
        try:
            return self._queue.get(timeout=timeout)
        except queue.Empty:
            return None

    def scratch_for(self, job: BuildJob) -> Path:
        """The private scratch directory one build writes into."""
        build_dir = self.build_root / f"build-{job.id}"
        build_dir.mkdir(parents=True, exist_ok=True)
        with self.lock:
            self._created_dirs.add(build_dir)
        return build_dir

    def mark(self, job: BuildJob, **fields: Any) -> None:
        with self.lock:
            for name, value in fields.items():
                setattr(job, name, value)

    def progress_of(self, job: BuildJob):
        """The stage callback handed to the build pipeline.

        Carries the stage's live ``facts`` (round 13, owner item 5) onto
        the job — a stage entry without facts clears the previous
        stage's, so the document's ``facts`` always describes the
        document's ``stage``. Doubles as the cooperative shutdown point:
        a build between stages aborts the moment shutdown is requested,
        so no half-written artifact outlives the service.
        """

        def progress(stage: str, facts: dict[str, Any] | None = None) -> None:
            if self.stop.is_set():
                raise _BuildAborted()
            self.mark(job, stage=stage, facts=facts)

        return progress

    def prune(self) -> None:
        """Keep only the newest finished builds (and their artifacts)."""
        with self.lock:
            finished = [
                candidate
                for candidate in self.jobs.values()
                if candidate.status in ("done", "failed", "cancelled")
            ]
            surplus = finished[: max(len(finished) - self.options.keep_builds, 0)]
            for candidate in surplus:
                self.jobs.pop(candidate.id, None)
        for candidate in surplus:
            self._remove_dir(candidate.build_dir)

    def drop_scratch(self, job: BuildJob) -> None:
        """Remove one job's scratch directory (a cancelled build keeps
        no half-written artifact) and forget it."""
        with self.lock:
            build_dir = job.build_dir
            job.build_dir = None
            if build_dir is not None:
                self._created_dirs.discard(build_dir)
        self._remove_dir(build_dir)

    def cleanup(self) -> None:
        """Remove every scratch directory the service created."""
        with self.lock:
            dirs = list(self._created_dirs)
            self._created_dirs.clear()
        for path in dirs:
            self._remove_dir(path)
        if self._owns_root:
            shutil.rmtree(self.build_root, ignore_errors=True)

    @staticmethod
    def _remove_dir(path: Path | None) -> None:
        if path is not None:
            shutil.rmtree(path, ignore_errors=True)

    # -- documents ---------------------------------------------------------

    def job_document(self, job: BuildJob) -> dict[str, Any]:
        """The status/stage/artifact document of one build."""
        with self.lock:
            snapshot = {
                field: getattr(job, field)
                for field in (
                    "status",
                    "stage",
                    "facts",
                    "started_at",
                    "finished_at",
                    "error",
                    "font_size",
                    "font_sha256",
                )
            }
            font_path, report_path = job.font_path, job.report_path
        document: dict[str, Any] = {
            "id": job.id,
            "format": job.format,
            "submitted_at": job.submitted_at,
            "queue_position": self.queue_position(job),
            "href": f"/builds/{job.id}",
            "font": None,
            "report": None,
            **snapshot,
        }
        if snapshot["status"] == "done" and font_path is not None:
            document["font"] = {
                "filename": font_path.name,
                "size": snapshot["font_size"],
                "sha256": snapshot["font_sha256"],
            }
            if report_path is not None:
                document["report"] = {"filename": report_path.name}
        document.pop("font_size")
        document.pop("font_sha256")
        return document

    def catalog_document(self) -> dict[str, Any]:
        """The manifest's families, grouped one entry per family."""
        families: list[dict[str, Any]] = []
        if self.catalog is not None:
            grouped: dict[str, list[dict[str, Any]]] = {}
            for entry in self.catalog.entries:
                grouped.setdefault(entry.family, []).append(
                    {
                        "variant": entry.variant,
                        "version": entry.version,
                        "file": entry.file,
                        "sha256": entry.sha256,
                        "license_spdx": entry.license_spdx,
                        "rfn": entry.rfn,
                        "rfn_names": list(entry.rfn_names),
                    }
                )
            families = [
                {"family": name, "variants": variants}
                for name, variants in grouped.items()
            ]
        return {
            "manifest": str(self.catalog.manifest_path)
            if self.catalog is not None
            else None,
            "families": families,
        }

    def _ensure_system_scan_started(self) -> None:
        """Start the scan thread at most once, at the first touch."""
        if self._system_thread is None and self._system_dirs:
            self._system_thread = threading.Thread(
                target=self._scan_system_fonts, name="system-fonts", daemon=True
            )
            self._system_thread.start()

    def _scan_system_fonts(self) -> None:
        """The background scan (daemon thread; see __init__)."""
        previous = (
            load_cache(self._system_cache_file)
            if self._system_cache_file is not None
            else None
        )
        result = scan_system_fonts(
            self._system_dirs,
            previous=previous,
            cache_file=self._system_cache_file,
        )
        with self.lock:
            self._system_result = result
            self._system_ready = True

    def system_fonts_document(self) -> dict[str, Any]:
        """The enumeration snapshot: ``ready`` false until it lands.

        Never scans, never blocks on the scanning thread — an
        in-flight scan means ``{"ready": false, faces: []}`` and the
        GUI retries. Ticket #34: the document GROUPS the scan
        (``families``, representative first, flags riding actual
        coverage — the semantics the frontend used to compute
        page-side) and every face carries its byte-source ``href``.
        """
        self._ensure_system_scan_started()
        with self.lock:
            ready = self._system_ready
            result = self._system_result
        faces = result.faces if result else ()

        def _face_doc(face: Any) -> dict[str, Any]:
            return {
                "path": str(face.path),
                "file": face.file,
                "face": face.face,
                "family": face.family,
                "subfamily": face.subfamily,
                "weight": face.weight,
                "italic": face.italic,
                "latin": face.latin,
                "cjk": face.cjk,
                # Ticket #36: the counters' data, same compressed shape
                # as the family-document faces' coverage intervals.
                "intervals": [
                    [start, end] for start, end in face.intervals
                ],
                "href": face_href(face.path, face.face),
            }

        return {
            "dirs": [str(directory) for directory in self._system_dirs],
            "ready": ready,
            "faces": [_face_doc(face) for face in faces],
            "families": [
                {
                    "family": family.family,
                    "latin": family.latin,
                    "cjk": family.cjk,
                    "representative": _face_doc(family.representative),
                    "faces": [_face_doc(face) for face in family.faces],
                }
                for family in group_system_families(faces)
            ],
        }

    def system_face_source(
        self, raw_path: object, face_index: object
    ) -> tuple[Path, str, int] | None:
        """One scanned system face's (path, ETag, file face count).

        Ticket #34's byte-source gate: the path must be one the scan
        itself recorded and the index one of that file's faces — the
        endpoint is a byte source for faces the enumeration showed,
        never a general file reader. The ETag is the scan's own
        fingerprint of the file plus the face index, so cache truth
        and scan truth are one string.
        """
        if not isinstance(raw_path, str):
            return None
        if isinstance(face_index, bool) or not isinstance(face_index, int):
            return None
        if face_index < 0 or not Path(raw_path).is_absolute():
            return None
        wanted = Path(raw_path)
        with self.lock:
            if self._system_result is None:
                return None
            indices = [
                face.face
                for face in self._system_result.faces
                if face.path == wanted
            ]
            fingerprint = self._system_result.fingerprints.get(str(wanted))
        if not indices or face_index not in indices:
            return None
        if fingerprint is None:
            return None
        return wanted, face_etag(fingerprint, face_index), len(indices)

    def fonts_document(self) -> dict[str, Any]:
        """The configured local directories, scanned into families.

        Scanned per request (a downloader may add fonts while the
        service runs). Files fontTools cannot read are skipped and
        reported, not fatal: a stray file in a user directory must not
        take the enumeration down.

        The scan descends ONE level into subdirectories (round 14): the
        layouts a real consumer points ``--font-dir`` at nest their font
        files there — the fetched catalog extracts each archive's faces
        into ``<fonts>/<archive stem>/``, and the Tauri shell's catalog
        storage keeps per-family directories under ``catalog/families``.
        A flat ``glob("*")`` lists none of those faces, so the GUI's
        weight-slot selection had no face data for family picks. The
        descent is bounded at one level exactly like the dev catalog's
        scan of the same layouts; deeper trees are not wandered.
        """
        skipped: list[str] = []
        faces: list[FaceInfo] = []
        for directory in self.options.font_dirs:
            # Depth-1 entries plus the FILES one level deeper (the two
            # globs cannot overlap: "*/*" is exactly depth 2).
            entries = [
                *sorted(Path(directory).glob("*")),
                *sorted(Path(directory).glob("*/*")),
            ]
            for path in entries:
                if not path.is_file() or path.suffix.lower() not in _FONT_SUFFIXES:
                    continue
                try:
                    for family in scan_families([path]):
                        faces.extend(family.faces)
                except FontAlloyError:
                    skipped.append(path.name)
        return {
            "directories": [str(path) for path in self.options.font_dirs],
            "families": [
                {
                    "name": family.name,
                    "faces": [_face_document(face) for face in family.faces],
                }
                for family in aggregate_families(faces)
            ],
            "skipped": skipped,
        }


def _face_document(face: Any) -> dict[str, Any]:
    return {
        "path": str(face.path),
        "face_index": face.face_index,
        "family": face.family,
        "subfamily": face.subfamily,
        "weight": face.weight,
        "italic": face.italic,
        "variable": face.variable,
    }


def _path_segment(raw: str) -> str:
    """One decoded path-segment capture.

    ``urlparse().path`` keeps the request's percent-encoding, and the
    route regexes match that still-encoded text — a family or file name
    with a space or any non-ASCII byte arrives as ``%20``/``%XX`` and
    would miss the release lookup (a silent 404). Decoding happens AFTER
    the segment boundary match, and the decoded strings only ever
    compare against the release document's own names (never join a
    path), so encoded traversal shapes gain nothing.
    """
    return urllib.parse.unquote(raw)


class _BuildWorker(threading.Thread):
    """Runs the queued builds, one at a time, until stopped."""

    def __init__(self, state: ServeState):
        super().__init__(name="fontalloy-build-worker", daemon=True)
        self._state = state

    def run(self) -> None:
        state = self._state
        while not state.stop.is_set():
            job = state.next_job(timeout=0.2)
            if job is None:
                continue
            self._run_job(job)

    def _run_job(self, job: BuildJob) -> None:
        state = self._state
        # Round 19: a job cancelled while queued never starts — no
        # running transition, no scratch, nothing for the worker to do
        # but move on to the next queued build.
        with state.lock:
            if job.status == "cancelled":
                return
        state.mark(job, status="running", started_at=_now())
        try:
            job.build_dir = state.scratch_for(job)
            build_recipe(
                job.recipe,
                job.font_path,
                report_path=job.report_path,
                # Catalog-family references in submissions resolve
                # against the serve process's configured manifest.
                manifest=state.options.manifest,
                progress=state.progress_of(job),
                # Round 19: the cooperative-cancel seam. The predicate
                # reads the job's own flag (never the service-wide stop,
                # which the progress callback owns).
                cancelled=job.cancel.is_set,
            )
            # Artifact facts are computed once at completion — polling a
            # done build must not re-hash the font on every request.
            font_path = job.font_path
            state.mark(
                job,
                status="done",
                stage="done",
                finished_at=_now(),
                font_size=font_path.stat().st_size,
                font_sha256=file_sha256(font_path),
            )
        except _BuildAborted:
            # Shutdown interrupted the build: nothing is recorded — the
            # process is exiting and the scratch is removed on the way out.
            return
        except BuildCancelled:
            # Round 19: the consumer cancelled the build. It lands as
            # its own outcome — never failed, no error text — with no
            # artifact: the scratch (and any half-written bytes in it)
            # goes away and the worker is free for the next queued job.
            state.drop_scratch(job)
            state.mark(
                job,
                status="cancelled",
                finished_at=_now(),
                facts=None,
            )
        except FontAlloyError as exc:
            state.mark(
                job, status="failed", error=str(exc), finished_at=_now()
            )
        except Exception as exc:  # a broken build must never kill the worker
            state.mark(
                job,
                status="failed",
                error=f"unexpected build failure: {exc!r}",
                finished_at=_now(),
            )
        finally:
            state.prune()


class _ServeHTTPServer(ThreadingHTTPServer):
    """A threading HTTP server pinned to the loopback interface."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, options: ServeOptions, state: ServeState):
        # BIND_ADDRESS is the whole security posture: the socket can
        # only ever exist on 127.0.0.1 — no flag can widen it.
        super().__init__((BIND_ADDRESS, options.port), _ServeHandler)
        self.state = state
        self.state.port = self.server_address[1]


class _ServeHandler(BaseHTTPRequestHandler):
    """Routing, CORS, and JSON bodies for the serve contract."""

    protocol_version = "HTTP/1.1"
    server_version = "fontalloy-serve"
    timeout = 60  # reap idle keep-alive connections

    @property
    def state(self) -> ServeState:
        return self.server.state  # type: ignore[attr-defined]

    # -- plumbing ----------------------------------------------------------

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        """Stay quiet on stderr — stdout carries only the ready URL."""

    def _cors_headers(self) -> dict[str, str]:
        origin = self.headers.get("Origin")
        if origin is not None and origin in self.state.options.allow_origins:
            return {
                "Access-Control-Allow-Origin": origin,
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type",
                "Access-Control-Max-Age": "600",
                "Vary": "Origin",
            }
        return {}

    def _send(
        self,
        status: int,
        body: bytes = b"",
        content_type: str = "application/json; charset=utf-8",
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        self.send_response(status)
        for name, value in {**self._cors_headers(), **(extra_headers or {})}.items():
            self.send_header(name, value)
        if status != 204:
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if status != 204 and body:
            self.wfile.write(body)

    def _send_json(self, document: Any, status: int = 200, **kwargs: Any) -> None:
        self._send(
            status,
            json.dumps(document, ensure_ascii=False).encode("utf-8"),
            **kwargs,
        )

    def _send_error(self, status: int, message: str, **kwargs: Any) -> None:
        self._send_json({"error": message}, status=status, **kwargs)

    # -- methods -----------------------------------------------------------

    def do_OPTIONS(self) -> None:  # noqa: N802
        origin = self.headers.get("Origin")
        if origin is not None and origin not in self.state.options.allow_origins:
            # A disallowed origin's preflight is rejected outright — the
            # browser never sends the actual cross-origin request.
            self._send_error(403, f"origin {origin!r} is not allowed")
            return
        self._send(204)

    def do_GET(self) -> None:  # noqa: N802
        self._route("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._route("POST")

    def do_PUT(self) -> None:  # noqa: N802
        self._route("PUT")

    def do_DELETE(self) -> None:  # noqa: N802
        self._route("DELETE")

    def do_PATCH(self) -> None:  # noqa: N802
        self._route("PATCH")

    # -- routing -----------------------------------------------------------

    def _route(self, method: str) -> None:
        path = urllib.parse.urlparse(self.path).path
        state = self.state

        if path == "/health":
            self._require_methods(method, ("GET",))
            self._send_json(_health_document(state))
        elif path == "/catalog":
            self._require_methods(method, ("GET",))
            self._send_json(state.catalog_document())
        elif path == "/catalog/status":
            self._require_methods(method, ("GET",))
            self._send_json(state.catalog_sync.status_document())
        elif path == "/catalog/sync":
            self._require_methods(method, ("POST",))
            # The handler only arms the sync thread; the run itself is
            # polled through /catalog/status (a handler must never wait
            # on catalog work — the round-25 starvation lesson).
            state.catalog_sync.request_sync()
            self._send_json(state.catalog_sync.status_document(), status=202)
        elif path == "/catalog/families":
            self._require_methods(method, ("GET",))
            self._send_json(state.family_docs.documents())
        elif path == "/catalog/stars":
            self._require_methods(method, ("GET",))
            self._send_json(state.stars.document())
        elif path == "/fonts":
            self._require_methods(method, ("GET",))
            self._send_json(state.fonts_document())
        elif path == "/local-fonts":
            self._require_methods(method, ("POST",))
            self._local_scan()
        elif path == "/local-fonts/upload":
            self._require_methods(method, ("POST",))
            self._local_upload()
        elif path == "/local-fonts/face":
            self._require_methods(method, ("GET",))
            self._local_face()
        elif path == "/system-fonts":
            self._require_methods(method, ("GET",))
            self._send_json(state.system_fonts_document())
        elif path == "/system-fonts/file":
            self._require_methods(method, ("GET",))
            self._system_face()
        elif path == "/precedence-resolve":
            self._require_methods(method, ("POST",))
            self._precedence_resolve()
        elif path == "/builds":
            self._require_methods(method, ("GET", "POST"))
            if method == "POST":
                self._submit_build()
            else:
                self._send_json(
                    {
                        "builds": [
                            state.job_document(job) for job in self._jobs()
                        ]
                    }
                )
        else:
            preview = re.fullmatch(r"/catalog/families/([^/]+)/preview", path)
            face = re.fullmatch(r"/catalog/faces/([^/]+)/([^/]+)", path)
            detail = re.fullmatch(r"/builds/([^/]+)", path)
            cancel = re.fullmatch(r"/builds/([^/]+)/cancel", path)
            artifact = re.fullmatch(r"/builds/([^/]+)/(font|report)", path)
            if preview is not None:
                self._require_methods(method, ("GET",))
                self._catalog_preview(_path_segment(preview.group(1)))
            elif face is not None:
                self._require_methods(method, ("GET",))
                self._catalog_face(
                    _path_segment(face.group(1)), _path_segment(face.group(2))
                )
            elif detail is not None:
                self._require_methods(method, ("GET",))
                self._build_detail(detail.group(1))
            elif cancel is not None:
                self._require_methods(method, ("POST",))
                self._cancel_build(cancel.group(1))
            elif artifact is not None:
                self._require_methods(method, ("GET",))
                self._build_artifact(artifact.group(1), artifact.group(2))
            else:
                self._send_error(404, f"no such endpoint: {path}")

    def _require_methods(self, method: str, allowed: tuple[str, ...]) -> None:
        if method not in allowed:
            self._send_error(
                405,
                f"method {method} is not allowed here "
                f"(allows: {', '.join(allowed)})",
                extra_headers={"Allow": ", ".join(allowed)},
            )

    def _jobs(self) -> list[BuildJob]:
        with self.state.lock:
            return list(self.state.jobs.values())

    def _find_job(self, build_id: str) -> BuildJob | None:
        with self.state.lock:
            return self.state.jobs.get(build_id)

    def _submit_build(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY_BYTES:
            self._send_error(413, "submission body exceeds the size limit")
            return
        raw = self.rfile.read(length) if length else b""
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            self._send_error(400, f"submission is not valid JSON: {exc}")
            return
        try:
            job = self.state.submit(data)
        except FontAlloyError as exc:  # recipe schema violations -> RecipeError
            self._send_error(400, str(exc))
            return
        document = self.state.job_document(job)
        self._send_json(
            {"id": job.id, "status": document["status"], "href": document["href"]},
            status=202,
            extra_headers={"Location": document["href"]},
        )

    def _precedence_resolve(self) -> None:
        """``POST /precedence-resolve`` (ticket #28): the effective table.

        A malformed body, an invalid rule set, or an unresolvable font
        reference is a synchronous 400 — the resolve never queues, so
        there is nothing to poll and no partial state to clean up.
        """
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY_BYTES:
            self._send_error(413, "submission body exceeds the size limit")
            return
        raw = self.rfile.read(length) if length else b""
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            self._send_error(400, f"submission is not valid JSON: {exc}")
            return
        try:
            document = self.state.precedence_resolve(data)
        except FontAlloyError as exc:
            self._send_error(400, str(exc))
            return
        self._send_json(document)

    def _system_face(self) -> None:
        """``GET /system-fonts/file?path=…&index=N`` (ticket #34): one
        scanned system face's bytes by URL — the byte source the
        enumeration's own ``href`` fields point at.

        A plain font streams its exact disk bytes; a collection face
        serves its EXTRACTED standalone sfnt (the same server-side
        surgery the local-font face endpoint performs), so the page
        never receives the collection blob. Only (path, index) pairs
        the scan recorded are servable; the index is required.
        """
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        target = query.get("path", [None])[0]
        index = query.get("index", [None])[0]
        if target is None or index is None:
            self._send_error(400, "the file endpoint needs ?path= and ?index=")
            return
        try:
            face_index = int(index)
        except ValueError:
            self._send_error(400, f"index must be an integer: {index!r}")
            return
        source = self.state.system_face_source(target, face_index)
        if source is None:
            self._send_error(
                404, f"not a scanned system font face: {target}#{index}"
            )
            return
        font_path, etag, face_count = source
        if face_count == 1:
            # A plain font file: the exact bytes off disk, streamed.
            self._send_font_file(
                font_path,
                FONT_CONTENT_TYPES.get(
                    font_path.suffix.lower().lstrip("."),
                    "application/octet-stream",
                ),
                etag=etag,
            )
            return
        # One face of a collection: the extracted standalone font.
        try:
            payload, content_type = extract_face(font_path, face_index)
        except Exception:
            self._send_error(404, f"face is no longer readable: {font_path.name}")
            return
        self._send_font_bytes(payload, content_type, etag=etag)

    def _local_scan(self) -> None:
        """``POST /local-fonts`` (ticket #31): paths in, family documents
        out — the same document shape as ``GET /catalog/families``, TTCs
        expanded server-side, one face per (weight, style) slot, side-cut
        drops stated. A malformed body or a rejected path (relative,
        missing, not a font) is a synchronous 400 naming every offender;
        a readable-but-invalid font file is never fatal — it rides the
        response's ``skipped`` list while its siblings still scan."""
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY_BYTES:
            self._send_error(413, "submission body exceeds the size limit")
            return
        raw = self.rfile.read(length) if length else b""
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            self._send_error(400, f"submission is not valid JSON: {exc}")
            return
        try:
            document = self.state.local_fonts.scan_document(data)
        except FontAlloyError as exc:
            self._send_error(400, str(exc))
            return
        self._send_json(document)

    def _local_upload(self) -> None:
        """``POST /local-fonts/upload?filename=…`` (ticket #36): the
        browser fallback's byte-free font load.

        The plain-browser file input has no absolute paths to hand the
        path-based scan, so the page UPLOADS the File object itself:
        the raw request body (any content type) streams into a
        serve-owned scratch file in bounded chunks — never buffered
        whole in the handler — and the SAME scan pipeline that serves
        ``POST /local-fonts`` answers with family documents whose face
        ``href`` points at the scratch copy. The filename rides the
        query string and must be a bare font-suffixed name (no path
        separators — the scratch directory decides where the bytes
        land, never the client).
        """
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        raw_name = query.get("filename", [None])[0]
        if raw_name is None or not raw_name.strip():
            self._send_error(
                400, "the upload endpoint needs a non-empty ?filename="
            )
            return
        name = raw_name.strip()
        if "/" in name or "\\" in name or name in (".", ".."):
            self._send_error(
                400,
                f"the upload filename must be a bare file name: {raw_name!r}",
            )
            return
        if Path(name).suffix.lower() not in _FONT_SUFFIXES:
            self._send_error(
                400,
                f"the upload filename is not a font file (expected one of "
                f"{', '.join(sorted(_FONT_SUFFIXES))}): {name}",
            )
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            self._send_error(400, "the upload body is empty")
            return
        if length > MAX_UPLOAD_BYTES:
            self._send_error(413, "the uploaded file exceeds the size limit")
            return
        target = self.state.upload_scratch() / f"{uuid.uuid4().hex}-{name}"
        try:
            with open(target, "wb") as stream:
                remaining = length
                while remaining > 0:
                    chunk = self.rfile.read(min(_STREAM_CHUNK, remaining))
                    if not chunk:
                        break  # a truncated body: the scan below reports it
                    stream.write(chunk)
                    remaining -= len(chunk)
        except OSError as exc:
            self._remove_quietly(target)
            self._send_error(500, f"the upload could not be stored: {exc}")
            return
        try:
            document = self.state.local_fonts.scan_document(
                {"paths": [str(target)]}
            )
        except FontAlloyError as exc:
            self._remove_quietly(target)
            self._send_error(400, str(exc))
            return
        self._send_json(document)

    @staticmethod
    def _remove_quietly(path: Path) -> None:
        """Best-effort scratch cleanup on a rejected upload."""
        try:
            path.unlink()
        except OSError:
            pass

    def _local_face(self) -> None:
        """``GET /local-fonts/face?path=…&index=N`` (ticket #31): one
        scanned local face's bytes by URL.

        Only (path, face index) pairs a scan kept are servable, and only
        while the file's (mtime, size) identity still matches the scan —
        the same never-a-general-file-reader posture as the catalog and
        system-font byte sources. A plain font streams its exact disk
        bytes; a collection face serves its EXTRACTED standalone sfnt
        (the server-side successor of the frontend's ttc.ts surgery),
        so the page never receives the collection blob. The ETag is the
        scan's own identity (mtime, size, face), so cache truth and
        index truth are one string."""
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        target = query.get("path", [None])[0]
        index = query.get("index", [None])[0]
        if target is None or index is None:
            self._send_error(400, "the face endpoint needs ?path= and ?index=")
            return
        try:
            face_index = int(index)
        except ValueError:
            self._send_error(400, f"index must be an integer: {index!r}")
            return
        source = self.state.local_fonts.face_source(target, face_index)
        if source is None:
            self._send_error(
                404, f"not a scanned local font face: {target}#{index}"
            )
            return
        path, etag, face_count = source
        if face_count == 1:
            # A plain font file: the exact bytes off disk, streamed.
            self._send_font_file(
                path,
                FONT_CONTENT_TYPES.get(
                    path.suffix.lower().lstrip("."), "application/octet-stream"
                ),
                etag=etag,
            )
            return
        # One face of a collection: the extracted standalone font. The
        # extraction itself is bounded per face (fontTools re-serializes
        # that face only), and the immutable+ETag discipline keeps the
        # browser from asking twice.
        try:
            payload, content_type = extract_face(path, face_index)
        except Exception:
            self._send_error(404, f"face is no longer readable: {path.name}")
            return
        self._send_font_bytes(payload, content_type, etag=etag)

    def _build_detail(self, build_id: str) -> None:
        job = self._find_job(build_id)
        if job is None:
            self._send_error(404, f"no such build: {build_id}")
            return
        self._send_json(self.state.job_document(job))

    def _cancel_build(self, build_id: str) -> None:
        """``POST /builds/{id}/cancel`` (round 19): really stop a build.

        Idempotent; a settled build is a 200 no-op, an unknown id is a
        404. The response is the job document — its ``status`` says
        where the cancellation stands (``cancelled`` once it landed).
        """
        job = self._find_job(build_id)
        if job is None:
            self._send_error(404, f"no such build: {build_id}")
            return
        self.state.cancel_job(job)
        self._send_json(self.state.job_document(job))

    def _build_artifact(self, build_id: str, kind: str) -> None:
        job = self._find_job(build_id)
        if job is None:
            self._send_error(404, f"no such build: {build_id}")
            return
        with self.state.lock:
            status = job.status
        if status != "done":
            self._send_error(409, f"build is not finished (status: {status})")
            return
        path = job.font_path if kind == "font" else job.report_path
        assert path is not None  # a done job always has scratch paths
        try:
            payload = path.read_bytes()
        except OSError:
            self._send_error(404, f"artifact is no longer available: {path.name}")
            return
        if kind == "font":
            content_type = FONT_CONTENT_TYPES.get(job.format, "application/octet-stream")
            extra = {
                "Content-Disposition": f'attachment; filename="{path.name}"'
            }
        else:
            content_type = "application/json; charset=utf-8"
            extra = {}
        self._send(200, payload, content_type, extra_headers=extra)

    def _catalog_face(self, family: str, file: str) -> None:
        """``GET /catalog/faces/{family}/{file}``: one release-listed
        face's bytes (issue #38).

        Only files the release document lists are servable — the byte
        source behind the picker's face cards, never a general file
        reader (unlisted names and traversal shapes are plain 404s).
        The ETag is the face's release-pinned sha256, so the cache
        truth and the checksum truth are one string.
        """
        source = self.state.family_docs.face_source(family, file)
        if source is None:
            self._send_error(404, f"not a release-listed face: {family}/{file}")
            return
        path, sha256 = source
        self._send_font_file(
            path,
            FONT_CONTENT_TYPES.get(
                path.suffix.lower().lstrip("."), "application/octet-stream"
            ),
            etag=sha256,
        )

    def _catalog_preview(self, family: str) -> None:
        """``GET /catalog/families/{family}/preview``: the family's tiny
        name-subset font (issue #38) — the artifact a picker row loads
        as its own FontFace. Served from the disk cache; the ETag is
        the subset's cache key (source checksum + names), so a name
        change means new bytes AND a new ETag."""
        source = self.state.family_docs.preview_source(family)
        if source is None:
            self._send_error(404, f"no preview subset for family: {family}")
            return
        path, etag = source
        self._send_font_file(path, "font/ttf", etag=etag or None)

    def _send_font_file(
        self, path: Path, content_type: str, etag: str | None = None
    ) -> None:
        """Stream one immutable disk artifact in bounded chunks — a face
        is never buffered whole inside a handler (:data:`_STREAM_CHUNK`).

        Cache truth rides the headers: ``immutable`` (the bytes behind
        an ETag never change — the release checksums and the preview
        cache keys pin them) and the ETag itself, so a matching
        ``If-None-Match`` revalidates to a 304 without reading the file.
        """
        try:
            size = path.stat().st_size
        except OSError:
            self._send_error(404, f"artifact is no longer available: {path.name}")
            return
        headers = {"Cache-Control": "public, max-age=31536000, immutable"}
        if etag is not None:
            headers["ETag"] = f'"{etag}"'
        if etag is not None and self.headers.get("If-None-Match") == f'"{etag}"':
            # 304 carries the same cache truth, none of the bytes.
            self.send_response(304)
            for name, value in {**self._cors_headers(), **headers}.items():
                self.send_header(name, value)
            self.end_headers()
            return
        self.send_response(200)
        for name, value in {**self._cors_headers(), **headers}.items():
            self.send_header(name, value)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(size))
        self.end_headers()
        with open(path, "rb") as stream:
            while chunk := stream.read(_STREAM_CHUNK):
                self.wfile.write(chunk)

    def _send_font_bytes(
        self, payload: bytes, content_type: str, etag: str | None = None
    ) -> None:
        """Serve font bytes already in memory with the byte-source cache
        discipline (an extracted collection face — the extraction had to
        hold the face anyway; a disk-backed artifact uses
        :meth:`_send_font_file` and streams)."""
        headers = {"Cache-Control": "public, max-age=31536000, immutable"}
        if etag is not None:
            headers["ETag"] = f'"{etag}"'
        if etag is not None and self.headers.get("If-None-Match") == f'"{etag}"':
            self.send_response(304)
            for name, value in {**self._cors_headers(), **headers}.items():
                self.send_header(name, value)
            self.end_headers()
            return
        self._send(200, payload, content_type, extra_headers=headers)


def _health_document(state: ServeState) -> dict[str, Any]:
    import fontalloy_core

    return {
        "service": "fontalloy",
        "version": fontalloy_core.__version__,
        "address": BIND_ADDRESS,
        "port": state.port,
    }


def make_serve_server(options: ServeOptions) -> _ServeHTTPServer:
    """Bind the service on 127.0.0.1 and return the ready server.

    The socket exists from this call onward; the caller prints the
    bound URL, starts the worker and the accept loop, and eventually
    shuts down through :func:`run_serve`'s lifecycle.
    """
    state = ServeState(options, port=options.port, recipe_root=Path.cwd())
    return _ServeHTTPServer(options, state)


def _watch_stdin(stop: threading.Event) -> None:
    """Set ``stop`` once stdin reaches EOF (the supervising parent died).

    Read errors are NOT a shutdown signal — a console detached under a
    supervised run must not take the service down; only a clean pipe
    close is.
    """
    try:
        while sys.stdin.buffer.read(1):
            pass
    except Exception:
        return
    stop.set()


def run_serve(options: ServeOptions) -> None:
    """Run the serve HTTP service until SIGINT/SIGTERM (SIGBREAK).

    Prints the bound URL (``http://127.0.0.1:<port>``) on stdout as the
    single machine-readable startup line, then blocks. On a shutdown
    signal the accept loop stops, the worker aborts its build at the
    next stage boundary (queued builds never start), and every scratch
    directory the service created is removed before returning.
    """
    server = make_serve_server(options)
    state = server.state
    worker = _BuildWorker(state)
    serve_thread = threading.Thread(
        target=server.serve_forever,
        kwargs={"poll_interval": 0.2},
        daemon=True,
    )
    # Library log records go to the bounded ring, never to stderr — an
    # undrained stderr pipe (a consumer that spawns but never reads it)
    # must not be able to wedge a build mid-pipeline.
    logging.getLogger().addHandler(_LogRing())

    def _stop(signum: int, frame: Any) -> None:
        state.stop.set()

    handled = [signal.SIGINT, signal.SIGTERM]
    if hasattr(signal, "SIGBREAK"):  # the Windows sidecar is stopped via Ctrl-Break
        handled.append(signal.SIGBREAK)
    for sig in handled:
        try:
            signal.signal(sig, _stop)
        except (ValueError, OSError):
            pass  # not the main thread; the embedder owns lifecycle

    if os.environ.get(STDIN_WATCH_ENV, "") not in ("", "0"):
        threading.Thread(
            target=_watch_stdin,
            args=(state.stop,),
            name="fontalloy-stdin-watch",
            daemon=True,
        ).start()

    worker.start()
    serve_thread.start()
    # The catalog lifecycle starts with the service (issue #26): the
    # sync runs on its own daemon thread, so the ready line below may
    # print while families are still downloading — /catalog/status is
    # the progress truth from the first moment. The family documents
    # (issue #38) build behind the sync on their own thread (a handler
    # never scans a face), and the stars sweep runs once per launch.
    state.catalog_sync.start()
    state.family_docs.start()
    state.stars.start()
    print(f"http://{BIND_ADDRESS}:{state.port}", flush=True)
    try:
        # A timed wait, not a plain block: on Windows an unbounded
        # Event.wait() never wakes to run the signal handler (the lock
        # acquire is not interruptible there), so the loop keeps the
        # shutdown path real on every platform.
        while not state.stop.wait(timeout=0.5):
            pass
    finally:
        server.shutdown()
        serve_thread.join(timeout=5)
        server.server_close()
        state.stop.set()  # aborts a running build at its next stage boundary
        state.family_docs.stop()
        worker.join(timeout=30)
        state.cleanup()
