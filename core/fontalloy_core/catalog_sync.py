"""Serve-side catalog sync: the catalog lifecycle the frontends poll.

The serve owns the catalog (spec #25, ticket #26): at startup — and on
``POST /catalog/sync`` — it loads the catalog release document
(``catalog-release.json``, parsed strictly by
:func:`fontalloy_core.catalog_release.load_catalog_release`), fills the
configured cache directory with every family the document carries, and
reports the run as a state machine over ``GET /catalog/status``:

============== =====================================================
state          meaning
============== =====================================================
bootstrapping  a sync run is in flight (startup or on demand)
ready          the run finished and every family is complete
unavailable    the run finished (or could not start) with an error
============== =====================================================

This module is wiring, not reimplementation. The heavy lifting is the
existing assets machinery, unchanged: family archives come through
:func:`fontalloy_core.origins.fetch_from_origins` (streaming temp-file
download with chunked sha256 verification and atomic replace, trying
the document's ordered origin list), extraction — zip and 7z alike,
with per-face parse validation — is :func:`fontalloy_core.assets.extract_font_faces`,
and the release document itself goes through the strict loader. The
service adds only the lifecycle around them.

On-disk layout inside the cache directory (the desktop appData font
directory; a CLI-specified directory elsewhere):

- ``catalog-release.json``    the cached release document (offline runs)
- ``<family>.zip`` / ``.7z``  the verified family archive
- ``<family>/``               the extracted, validated faces
- ``<archive>.complete``      the complete marker

The marker is written ONLY after the archive's sha256, every listed
face's sha256, and every face's parse have all been verified, so a run
killed mid-download leaves at worst a ``.part`` temp file — never a
falsely-complete family. The marker records the release tag plus the
byte sizes that verification pinned (the archive's and every listed
face's), which is all a relaunch needs to trust the family.

Launch checks are STAT-ONLY (the ticket #26 follow-up: re-hashing a
~10 GB catalog at every GUI launch was a full-disk-read storm on the
owner's workstation). At startup a family counts as complete iff the
marker exists, its tag matches the release tag, the archive is
present at its recorded size, and every listed face is present at its
recorded size — no byte is hashed. Bytes are sha256-verified on
download, on the explicit ``POST /catalog/sync`` repair pass (which
re-hashes everything), and whenever a launch check finds an anomaly:
a missing or stale marker, a missing file, or a size mismatch —
partial writes and truncations always change a size (the round-27
failure mode). Same-size bit-rot is deliberately out of launch-time
scope: it is caught by the explicit sync's re-hash, not by the stat
pass.

The sync runs on its own daemon thread, never inside a request handler
(the round-25 starvation lesson): the state lock is held only for
snapshot-sized mutations, and the loop yields between families, so
``/health`` and ``/catalog/status`` answer while a sync is in flight.
"""

from __future__ import annotations

import json
import os
import shutil
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fontalloy_core.assets import extract_font_faces, sha256_of
from fontalloy_core.catalog_release import (
    CatalogRelease,
    ReleaseFamily,
    load_catalog_release,
)
from fontalloy_core.errors import AssetsError, FontAlloyError
from fontalloy_core.origins import fetch_from_origins
from fontalloy_core.release import METADATA_NAME

#: The overall states of the sync state machine.
BOOTSTRAPPING = "bootstrapping"
READY = "ready"
UNAVAILABLE = "unavailable"

#: The per-family progress states the status document reports.
PENDING = "pending"
DOWNLOADING = "downloading"
EXTRACTING = "extracting"
VERIFYING = "verifying"
DONE = "done"
FAILED = "failed"

#: Complete-marker suffix: ``<archive>.complete``, written only after
#: the archive, every listed face, and every parse have been verified.
#: The marker's JSON body records the release tag and the verified
#: byte sizes (the archive's and every face's) that the stat-only
#: launch check compares against.
COMPLETE_SUFFIX = ".complete"

#: Temp-suffix of in-flight downloads. A run killed mid-download or
#: mid-document-fetch leaves these behind; the next run sweeps them
#: before doing anything else, so a partial artifact never counts.
PART_SUFFIX = ".part"

#: How long the sync thread sleeps between families — the GIL slot
#: every in-flight request handler needs while the catalog is being
#: hashed, downloaded, and extracted. Tests stretch this via
#: :data:`SYNC_DELAY_ENV` to make a run observably slow.
SYNC_YIELD_SECONDS = 0.002

#: Test seam: when set, the per-family sleep lasts this many seconds
#: instead (deterministic slow syncs for the responsiveness tests).
SYNC_DELAY_ENV = "FONTALLOY_CATALOG_SYNC_DELAY"

#: Download chunk size (1 MiB) and per-request timeout, matching the
#: assets machinery — the document is never buffered whole either.
_CHUNK = 1 << 20
_TIMEOUT_SECONDS = 300


@dataclass
class _FamilyProgress:
    """One family's progress inside the status document."""

    family: str
    state: str = PENDING
    error: str | None = None

    def document(self) -> dict[str, Any]:
        return {"family": self.family, "state": self.state, "error": self.error}


def _yield_between_families() -> None:
    """Hand the GIL to request handlers between two families."""
    delay = os.environ.get(SYNC_DELAY_ENV)
    time.sleep(float(delay) if delay else SYNC_YIELD_SECONDS)


def _marker_claim(marker: Path, tag: str) -> tuple[int, dict[str, int]] | None:
    """Parse a complete marker's claim: the release tag it was written
    under plus the byte sizes its verification pinned (the archive's
    and every listed face's). ``None`` when the marker is missing,
    unreadable, malformed, or was written under a different tag — every
    such case is an anomaly the caller repairs. A marker from a run
    before sizes were recorded carries only the bare tag string; it
    parses as malformed and the repair rewrites it in the recorded-
    sizes form (a one-time re-verification after the upgrade).
    """
    try:
        claim = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(claim, dict) or claim.get("tag") != tag:
        return None
    archive_size = claim.get("archive")
    faces = claim.get("faces")
    if not isinstance(archive_size, int) or not isinstance(faces, dict):
        return None
    if not all(isinstance(size, int) for size in faces.values()):
        return None
    return archive_size, {str(name): size for name, size in faces.items()}


class CatalogSync:
    """The catalog lifecycle service behind ``/catalog/status``.

    Constructed by the serve for every configuration — unconfigured
    serves report a quiescent ``ready`` catalog (a local-fonts-only
    setup has nothing to bootstrap and no error to show) — and started
    once at serve startup when fully configured. ``request_sync``
    re-runs the whole lifecycle on demand; it is a no-op while a run is
    in flight.
    """

    def __init__(self, release_origin: str | None, catalog_dir: Path | None):
        self._origin = release_origin
        self._dir = catalog_dir
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        config_error = self._config_error()
        if config_error is not None:
            self._state = UNAVAILABLE
            self._error: str | None = config_error
        elif self._active:
            self._state = BOOTSTRAPPING
            self._error = None
        else:
            self._state = READY
            self._error = None
        self._tag: str | None = None
        self._families: dict[str, _FamilyProgress] = {}
        self._verify_hashes = True

    # -- configuration -----------------------------------------------------

    @property
    def _active(self) -> bool:
        """The sync runs when both the document origin and the cache
        directory are configured."""
        return self._origin is not None and self._dir is not None

    def _config_error(self) -> str | None:
        if (self._origin is None) != (self._dir is None):
            missing = (
                "--catalog-dir"
                if self._dir is None
                else "--catalog-release-origin"
            )
            return (
                f"catalog sync is half-configured: {missing} is missing "
                "(the release-document origin and the cache directory "
                "activate the sync together)"
            )
        return None

    # -- the polled surface -------------------------------------------------

    def status_document(self) -> dict[str, Any]:
        """A lock-held-copy snapshot of the state machine — the document
        ``GET /catalog/status`` serves. Never blocks on the sync thread."""
        with self._lock:
            return {
                "state": self._state,
                "configured": self._active,
                "error": self._error,
                "tag": self._tag,
                "catalog_dir": str(self._dir) if self._dir is not None else None,
                "families": [
                    progress.document() for progress in self._families.values()
                ],
            }

    # -- lifecycle -----------------------------------------------------------

    def start(self) -> None:
        """Start the startup sync — the stat-only fast path.

        A warm catalog hashes nothing: every intact family is confirmed
        by its marker, the release tag, and file sizes alone. Hashing
        happens only where a launch check finds an anomaly.
        """
        self.request_sync(verify_hashes=False)

    def request_sync(self, *, verify_hashes: bool = True) -> None:
        """Run a full sync pass (re-check and repair) on a daemon thread.

        Idempotent: while a run is in flight the call is a no-op, so
        ``POST /catalog/sync`` never piles runs onto each other.

        With ``verify_hashes`` (the default — the ``POST /catalog/sync``
        repair pass) every family is re-verified by sha256 against the
        release document, whatever the marker claims — the repair path
        that also catches same-size bit-rot. Without it (the startup
        pass) intact families are confirmed by stat alone.
        """
        if not self._active:
            return
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._verify_hashes = verify_hashes
            self._thread = threading.Thread(
                target=self._run, name="fontalloy-catalog-sync", daemon=True
            )
            self._thread.start()

    def _run(self) -> None:
        """One full sync pass: document, then every family, then the
        terminal state. Any error lands ``unavailable`` with its string
        — a failing family never aborts the others."""
        assert self._origin is not None and self._dir is not None
        with self._lock:
            verify_hashes = self._verify_hashes
            self._state = BOOTSTRAPPING
            self._error = None
        try:
            release = self._load_release()
        except FontAlloyError as exc:
            with self._lock:
                self._state = UNAVAILABLE
                self._error = str(exc)
            return
        with self._lock:
            self._tag = release.tag
            self._families = {
                family.family: _FamilyProgress(family=family.family)
                for family in release.families
            }
        failures: list[str] = []
        for family in release.families:
            try:
                self._sync_family(release, family, verify_hashes=verify_hashes)
            except FontAlloyError as exc:
                self._mark_family(family.family, FAILED, error=str(exc))
                failures.append(f"{family.family}: {exc}")
            except Exception as exc:  # a broken family must not kill the run
                message = f"unexpected sync failure: {exc!r}"
                self._mark_family(family.family, FAILED, error=message)
                failures.append(f"{family.family}: {message}")
            _yield_between_families()
        with self._lock:
            if failures:
                self._state = UNAVAILABLE
                self._error = (
                    f"{len(failures)} of {len(release.families)} catalog "
                    "families failed — " + "; ".join(failures)
                )
            else:
                self._state = READY
                self._error = None

    # -- the release document ------------------------------------------------

    def _load_release(self) -> CatalogRelease:
        """Fetch and validate the release document, caching it.

        The fresh document is parsed BEFORE it replaces the cached copy,
        so a truncated fetch or a wrong-schema document never poisons a
        good cache; when the fetch fails outright (offline launch) the
        cached copy carries the run — the app keeps working offline
        once the catalog is synced.
        """
        assert self._origin is not None and self._dir is not None
        self._dir.mkdir(parents=True, exist_ok=True)
        # Stray temp files from a killed run never count as artifacts.
        for stray in self._dir.glob(f"*{PART_SUFFIX}"):
            try:
                stray.unlink()
            except OSError:
                pass

        document = self._dir / METADATA_NAME
        temp = document.with_name(document.name + PART_SUFFIX)
        url = f"{str(self._origin).rstrip('/')}/{METADATA_NAME}"
        try:
            self._download_document(url, temp)
            release = load_catalog_release(temp)
            temp.replace(document)
            return release
        except (FontAlloyError, urllib.error.URLError, OSError) as exc:
            temp.unlink(missing_ok=True)
            if document.is_file():
                # The cached document of a previous run (offline launch).
                return load_catalog_release(document)
            if isinstance(exc, FontAlloyError):
                raise
            raise AssetsError(
                f"catalog release document could not be fetched from "
                f"{url}: {exc}"
            ) from None

    @staticmethod
    def _download_document(url: str, temp: Path) -> None:
        """Stream the release document to ``temp`` (never buffered whole)."""
        with urllib.request.urlopen(url, timeout=_TIMEOUT_SECONDS) as response:
            # file:// responses carry no HTTP status; only http(s) is checked.
            if response.status not in (None, 200):
                raise AssetsError(
                    f"catalog release document origin returned HTTP "
                    f"{response.status} for {url}"
                )
            with temp.open("wb") as out:
                while chunk := response.read(_CHUNK):
                    out.write(chunk)

    # -- one family ------------------------------------------------------------

    def _sync_family(
        self,
        release: CatalogRelease,
        family: ReleaseFamily,
        *,
        verify_hashes: bool,
    ) -> None:
        """Make one family whole: verify, repair, and only then mark.

        The launch fast path (``verify_hashes`` off) trusts the marker's
        stat-level claim — matching tag, archive at its recorded size,
        every face at its recorded size — and skips the family when it
        all holds; no byte is hashed. The repair pass
        (``verify_hashes`` on, the explicit sync) re-hashes the archive
        and every listed face against the document instead. Anything
        short of a passing check runs the full repair: fetch the
        archive through the ordered origin list (skipped when the local
        archive still verifies), re-extract from scratch with per-face
        parse validation, verify every listed face's checksum, and
        write the marker last.
        """
        archive = self._dir / family.zip
        extracted = self._dir / Path(family.zip).stem
        marker = self._dir / (family.zip + COMPLETE_SUFFIX)

        self._mark_family(family.family, VERIFYING)
        if self._family_complete(
            release, family, marker, verify_hashes=verify_hashes
        ):
            self._mark_family(family.family, DONE)
            return

        self._mark_family(family.family, DOWNLOADING)
        if not (archive.is_file() and sha256_of(archive) == family.sha256):
            fetch_from_origins(
                release.origins, family.zip, family.sha256, self._dir
            )

        self._mark_family(family.family, EXTRACTING)
        # No half-built layout survives a repair: the stale extraction
        # goes away before the archive is unpacked again.
        shutil.rmtree(extracted, ignore_errors=True)
        extract_font_faces(archive, extracted)

        self._mark_family(family.family, VERIFYING)
        for listed in family.files:
            face = extracted / listed.file
            if not face.is_file():
                raise AssetsError(
                    f"{family.zip}: extraction produced no {listed.file} "
                    f"(the release document lists it)"
                )
            actual = sha256_of(face)
            if actual != listed.sha256:
                raise AssetsError(
                    f"{family.zip}: extracted face {listed.file} hashes "
                    f"{actual}, the release document pins {listed.sha256}"
                )

        marker.write_text(
            json.dumps(
                {
                    "tag": release.tag,
                    "archive": archive.stat().st_size,
                    "faces": {
                        listed.file: (extracted / listed.file).stat().st_size
                        for listed in family.files
                    },
                }
            ),
            encoding="utf-8",
        )
        self._mark_family(family.family, DONE)

    def _family_complete(
        self,
        release: CatalogRelease,
        family: ReleaseFamily,
        marker: Path,
        *,
        verify_hashes: bool,
    ) -> bool:
        """Whether the marker's completeness claim still holds.

        The marker must exist and name the current release tag; past
        that the two checks diverge. The launch check
        (``verify_hashes`` off) is stat-only: the archive and every
        listed face must be present at the byte size the marker
        recorded when the family was verified — partial writes and
        truncations always change a size, so nothing short of same-size
        bit-rot slips through, and that is the explicit sync's job, not
        the launch's. The repair check (``verify_hashes`` on) hashes
        the archive and every listed face against the release document
        — a stale marker can never canonize corrupt bytes into a
        complete family.
        """
        claim = _marker_claim(marker, release.tag)
        if claim is None:
            return False
        archive_size, face_sizes = claim
        archive = self._dir / family.zip
        extracted = self._dir / Path(family.zip).stem
        if verify_hashes:
            if not archive.is_file() or sha256_of(archive) != family.sha256:
                return False
            for listed in family.files:
                face = extracted / listed.file
                if not face.is_file() or sha256_of(face) != listed.sha256:
                    return False
            return True
        try:
            if not archive.is_file() or archive.stat().st_size != archive_size:
                return False
            for listed in family.files:
                face = extracted / listed.file
                recorded = face_sizes.get(listed.file)
                if (
                    recorded is None
                    or not face.is_file()
                    or face.stat().st_size != recorded
                ):
                    return False
        except OSError:
            return False
        return True

    def _mark_family(
        self, family: str, state: str, *, error: str | None = None
    ) -> None:
        with self._lock:
            progress = self._families.get(family)
            if progress is not None:
                progress.state = state
                progress.error = error
