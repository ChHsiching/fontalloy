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
``/fonts``     GET     local font directories, scanned into families
``/builds``    GET     every retained build, newest last
``/builds``    POST    submit a merge (recipe-shaped JSON) -> 202 + id
``/builds/id`` GET     one build's status/stage/artifact document
``/builds/id/font``   GET  the output font (ttf/ttc/woff2 bytes)
``/builds/id/report`` GET  the verification report JSON
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
from fontalloy_core.errors import FontAlloyError
from fontalloy_core.load import (
    FaceInfo,
    aggregate_families,
    scan_families,
)
from fontalloy_core.recipe import Recipe, parse_recipe
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

#: Output-format content types for artifact downloads.
FONT_CONTENT_TYPES = {
    "ttf": "font/ttf",
    "otf": "font/otf",
    "ttc": "font/collection",
    "woff2": "font/woff2",
}

#: Font file suffixes the local-font enumeration considers.
_FONT_SUFFIXES = {".ttf", ".otf", ".ttc", ".woff2"}


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
    status: str = "queued"  # queued | running | done | failed
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
                if candidate.status in ("done", "failed")
            ]
            surplus = finished[: max(len(finished) - self.options.keep_builds, 0)]
            for candidate in surplus:
                self.jobs.pop(candidate.id, None)
        for candidate in surplus:
            self._remove_dir(candidate.build_dir)

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
        elif path == "/fonts":
            self._require_methods(method, ("GET",))
            self._send_json(state.fonts_document())
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
            detail = re.fullmatch(r"/builds/([^/]+)", path)
            artifact = re.fullmatch(r"/builds/([^/]+)/(font|report)", path)
            if detail is not None:
                self._require_methods(method, ("GET",))
                self._build_detail(detail.group(1))
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

    def _build_detail(self, build_id: str) -> None:
        job = self._find_job(build_id)
        if job is None:
            self._send_error(404, f"no such build: {build_id}")
            return
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
        worker.join(timeout=30)
        state.cleanup()
