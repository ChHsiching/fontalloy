"""Local fonts by path: the serve-side scan and byte source (issue #31).

The successor of the frontend's local-font business modules (spec #25's
audit: ``gui/src/fonts/ttc.ts`` face surgery, ``localFamily.ts``
sibling discovery, ``registry.ts`` byte registration): the consumer
hands the serve a list of ABSOLUTE file paths and gets back family
documents in the same shape as ``GET /catalog/families`` — real
name-table identity, weight/style, honest coverage summaries, the
placeholder flag — with TTC collections expanded server-side so the
page never receives a collection blob, one face per (weight, style)
slot per the style-slot rule
(:func:`fontalloy_core.load.resolve_slot_faces`), and every dropped
side-cut stated in the response. Faces then serve by URL
(``GET /local-fonts/face``), so the renderer registers FontFaces over
HTTP and the IPC byte-transfer path dies with the TS modules it
replaces.

Scanning is on-demand per POST and cached in-process per resolved path
keyed by (mtime_ns, size): a re-scan of an unchanged collection is a
dictionary read, a touched or resized file re-parses. Only (path,
face_index) pairs a scan kept are byte-servable, and only while the
file's identity still matches the scan — the endpoint is a byte source
for faces the picker was shown, never a general file reader.
"""

from __future__ import annotations

import io
import os
import threading
import time
import urllib.parse
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from fontTools.ttLib import TTFont

from fontalloy_core.errors import LocalFontError
from fontalloy_core.family_docs import (
    FaceScan,
    YIELD_SECONDS,
    pick_variant_representative,
    scan_file_faces,
)
from fontalloy_core.load import aggregate_families, resolve_slot_faces

#: Font file suffixes the local-font scan considers (the same set the
#: ``/fonts`` directory enumeration considers).
FONT_SUFFIXES = {".ttf", ".otf", ".ttc", ".woff2"}

#: Test seam: when set, the per-file sleep lasts this many seconds
#: instead (deterministic slow scans for the responsiveness tests).
SCAN_DELAY_ENV = "FONTALLOY_LOCAL_FONTS_DELAY"

#: The face byte endpoint every scanned face's ``href`` points at.
FACE_ENDPOINT = "/local-fonts/face"


@dataclass(frozen=True)
class _Indexed:
    """One scanned file: its identity and every face's scan.

    ``servable`` carries the face indices the LAST scan that included
    this file kept after the style-slot rule — a dropped side-cut is
    reported but never becomes a byte source (the drop can differ per
    request: rescanning the file without its siblings re-opens the
    slot, and the next scan's verdict replaces this one).
    """

    identity: tuple[int, int]  # (st_mtime_ns, st_size)
    scans: tuple[FaceScan, ...]
    servable: frozenset[int]

    @property
    def face_count(self) -> int:
        return len(self.scans)


def validate_local_path(raw: object) -> Path:
    """One submitted path: absolute, existing, a font file — resolved.

    Everything else is rejected by name (a relative path, a traversal
    shape, a missing file, a directory, a stray suffix): the scan never
    guesses what the consumer meant. ``Path.resolve`` decides what a
    Windows UNC or drive path safely resolves to; nothing beyond that
    is special-cased.

    Raises :class:`~fontalloy_core.errors.LocalFontError` naming the
    rejected input.
    """
    if not isinstance(raw, str) or not raw:
        raise LocalFontError(f"paths must be non-empty strings: {raw!r}")
    if "\x00" in raw:
        raise LocalFontError(f"path contains a NUL byte: {raw!r}")
    candidate = Path(raw)
    if not candidate.is_absolute():
        raise LocalFontError(f"path must be absolute: {raw}")
    resolved = candidate.resolve()
    if not resolved.is_absolute():
        raise LocalFontError(f"path does not resolve to an absolute path: {raw}")
    if not resolved.exists():
        raise LocalFontError(f"path does not exist: {resolved}")
    if not resolved.is_file():
        raise LocalFontError(f"path is not a file: {resolved}")
    if resolved.suffix.lower() not in FONT_SUFFIXES:
        raise LocalFontError(
            f"path is not a font file (expected one of "
            f"{', '.join(sorted(FONT_SUFFIXES))}): {resolved}"
        )
    return resolved


def face_href(path: Path, face_index: int) -> str:
    """The URL one scanned face's bytes serve at."""
    return (
        f"{FACE_ENDPOINT}?"
        + urllib.parse.urlencode({"path": str(path), "index": face_index})
    )


def face_etag(identity: tuple[int, int], face_index: int) -> str:
    """The cache identity of one served face.

    The catalog's face ETag is its release-pinned sha256; a local file
    has no release, so its cache truth is the scan's own identity key
    (mtime_ns, size) plus the face index — the same string that
    invalidates the index, so a changed file can never serve stale
    bytes behind an old ETag.
    """
    mtime_ns, size = identity
    return f"{mtime_ns:x}-{size:x}-{face_index}"


class LocalFonts:
    """The on-demand local-font index behind ``POST /local-fonts``.

    One instance per serve. The scan itself is bounded work per file
    (identity + coverage through the family-docs machinery) and yields
    the GIL between files, so the threaded server's every other
    endpoint stays live while a big collection parses; results live in
    an in-process cache keyed per resolved path, so re-scans of
    unchanged files are snapshot reads.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._build_locks: dict[str, threading.Lock] = {}
        self._indexed: dict[str, _Indexed | str] = {}

    # -- the scan ----------------------------------------------------------

    def scan_document(self, data: object) -> dict[str, Any]:
        """The POST body's family documents, plus the skipped files.

        Raises :class:`~fontalloy_core.errors.LocalFontError` when the
        body is not ``{"paths": [absolute paths...]}`` or any path is
        rejected — a rejected request scans nothing (the caller maps
        the error to a 400).
        """
        if not isinstance(data, dict) or not isinstance(data.get("paths"), list):
            raise LocalFontError(
                "the local-fonts scan needs a JSON object with a "
                "'paths' list of absolute font file paths"
            )
        rejected: list[str] = []
        resolved: list[Path] = []
        for raw in data["paths"]:
            try:
                resolved.append(validate_local_path(raw))
            except LocalFontError as exc:
                rejected.append(str(exc))
        if rejected:
            raise LocalFontError("; ".join(rejected))
        deduped: list[Path] = []
        seen: set[str] = set()
        for path in resolved:
            if str(path) not in seen:
                seen.add(str(path))
                deduped.append(path)

        scans: list[FaceScan] = []
        skipped: list[dict[str, Any]] = []
        for path in deduped:
            indexed = self._file_index(path)
            if isinstance(indexed, str):  # a cached unreadable verdict
                skipped.append({"path": str(path), "error": indexed})
                continue
            scans.extend(indexed.scans)
            self._yield_between_files()

        return {
            "families": self._family_documents(scans),
            "skipped": skipped,
        }

    # -- the byte source ---------------------------------------------------

    def face_source(
        self, raw_path: object, face_index: object
    ) -> tuple[Path, str, int] | None:
        """One scanned face's (path, ETag, file face count), or None.

        The byte-source gate: the path must be absolute and resolve to
        a file whose CURRENT identity matches the indexed scan, and the
        face index must be one the scan kept. Anything else — never
        scanned, changed since the scan, a dropped side-cut, a
        traversal shape — is a plain miss.
        """
        if not isinstance(raw_path, str):
            return None
        if isinstance(face_index, bool) or not isinstance(face_index, int):
            return None
        if face_index < 0 or not Path(raw_path).is_absolute():
            return None
        try:
            resolved = Path(raw_path).resolve()
            stat = resolved.stat()
        except OSError:
            return None
        with self._lock:
            indexed = self._indexed.get(str(resolved))
        if not isinstance(indexed, _Indexed):
            return None
        if indexed.identity != (stat.st_mtime_ns, stat.st_size):
            return None  # the file changed since the scan: rescan first
        if face_index not in indexed.servable:
            return None
        return resolved, face_etag(indexed.identity, face_index), indexed.face_count

    def _note_servable(self, servable: dict[str, frozenset[int]]) -> None:
        """Record which of each file's faces the scan just kept."""
        with self._lock:
            for path_str, indices in servable.items():
                indexed = self._indexed.get(path_str)
                if isinstance(indexed, _Indexed):
                    self._indexed[path_str] = replace(
                        indexed, servable=indices
                    )

    # -- internals -----------------------------------------------------------

    def _file_index(self, path: Path) -> _Indexed | str:
        """One file's cached scan, built on first sight (locked per
        path; the winner re-checks the cache under the lock)."""
        with self._lock:
            lock = self._build_locks.setdefault(str(path), threading.Lock())
        with lock:
            identity = _stamp_of(path)
            if identity is None:
                return f"file is no longer readable: {path}"
            with self._lock:
                cached = self._indexed.get(str(path))
            if isinstance(cached, _Indexed) and cached.identity == identity:
                return cached
            if isinstance(cached, str) and _stamp_of(path) == identity:
                return cached  # an unchanged unreadable file stays unreadable
            try:
                scans = tuple(scan_file_faces(path))
            except Exception as exc:  # unreadable: reported, never fatal
                verdict = f"file is not a valid font: {path} ({exc})"
                with self._lock:
                    self._indexed[str(path)] = verdict
                return verdict
            indexed = _Indexed(identity=identity, scans=scans, servable=frozenset())
            with self._lock:
                self._indexed[str(path)] = indexed
            return indexed

    def _family_documents(self, scans: list[FaceScan]) -> list[dict[str, Any]]:
        """The picker-facing documents, one per name-table family.

        Sibling files submitted together pool into their shared family
        (the aggregation the frontend's directory sweep used to do
        page-side), the style-slot rule keeps one face per (weight,
        italic) slot across the WHOLE family pool, and each drop is
        stated next to the faces it lost to.
        """
        families: list[dict[str, Any]] = []
        scan_of = {id(scan.info): scan for scan in scans}
        servable: dict[str, set[int]] = {}
        for family in aggregate_families([scan.info for scan in scans]):
            kept, dropped = resolve_slot_faces(list(family.faces))
            faces = [scan_of[id(info)] for info in kept]
            for info in kept:
                servable.setdefault(str(info.path), set()).add(info.face_index)
            files = list(dict.fromkeys(info.path for info in kept))
            representative = pick_variant_representative(
                [path.name for path in files], None, family.name
            )
            families.append(
                {
                    "family": family.name,
                    "readiness": "done",
                    "error": None,
                    "scanned": True,
                    "display_name": family.name,
                    "display_names": [family.name],
                    "preview": None,
                    "dropped": [
                        {
                            "file": skip.path.name,
                            "path": str(skip.path),
                            "face_index": skip.face_index,
                            "weight": skip.weight,
                            "italic": skip.italic,
                            "subfamily": skip.subfamily,
                            "reason": skip.reason,
                        }
                        for skip in dropped
                    ],
                    "cuts": [
                        {
                            "variant": "",
                            "def": True,
                            "label": family.name,
                            "file": representative,
                            "version": None,
                            "sha256": None,
                            "axes": {},
                            "upstream_url": None,
                            "display_name": family.name,
                            "representative": representative,
                            "faces": [
                                self._face_document(scan) for scan in faces
                            ],
                        }
                    ],
                }
            )
        # The byte-source gate follows the verdicts these documents just
        # stated: only kept faces ever serve. A file whose faces span
        # several families accumulates its servable indices across all
        # of them before the verdict is recorded.
        self._note_servable({key: frozenset(value) for key, value in servable.items()})
        return families

    @staticmethod
    def _face_document(scan: FaceScan) -> dict[str, Any]:
        info = scan.info
        return {
            "file": info.path.name,
            "path": str(info.path),
            "face_index": info.face_index,
            "sha256": None,  # local files carry no release checksum
            "href": face_href(info.path, info.face_index),
            "family": info.family,
            "subfamily": info.subfamily,
            "weight": info.weight,
            "italic": info.italic,
            "variable": info.variable,
            "coverage": {
                "codepoints": scan.codepoints,
                "placeholders": scan.placeholders,
                "latin": scan.latin,
                "cjk": scan.cjk,
            },
            "placeholder": scan.placeholder,
        }

    @staticmethod
    def _yield_between_files() -> None:
        """Hand the GIL to request handlers between two files."""
        delay = os.environ.get(SCAN_DELAY_ENV)
        time.sleep(float(delay) if delay else YIELD_SECONDS)


def _stamp_of(path: Path) -> tuple[int, int] | None:
    """The file's current identity, or None when it no longer stats."""
    try:
        stat = path.stat()
    except OSError:
        return None
    return (stat.st_mtime_ns, stat.st_size)


def extract_face(path: Path, face_index: int) -> tuple[bytes, str]:
    """One collection face as (standalone font bytes, content type).

    The server-side successor of the frontend's ``ttc.ts`` surgery:
    fontTools re-serializes the single face with recomputed checksums,
    so the page receives a plain loadable TTF/OTF carrying exactly that
    face's identity — never the collection blob (user story 8's 428 MB
    non-transfer).
    """
    font = TTFont(path, fontNumber=face_index)
    try:
        content_type = "font/otf" if font.sfntVersion == "OTTO" else "font/ttf"
        buffer = io.BytesIO()
        font.save(buffer)
    finally:
        font.close()
    return buffer.getvalue(), content_type
