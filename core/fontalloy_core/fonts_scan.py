"""The ``/fonts`` directory scan: cached, background, never in a
handler (spec #25 review P1-1).

The ``/fonts`` enumeration used to re-parse every font file under the
configured ``--font-dir`` directories synchronously inside the request
handler — and the desktop shell points that flag at the FULL synced
catalog while the GUI asks at every connect, so each request was a
whole-catalog fontTools pass holding the GIL. The scan now gets the
treatment the system-font enumeration got (round 25):

- it runs on a BACKGROUND daemon thread the serve starts at the first
  ``/fonts`` touch, sleeping :data:`YIELD_SECONDS` between parsed
  files so request handlers keep getting GIL slots (``/health``
  answers while a scan is in flight);
- its result is cached on disk keyed by per-file fingerprints
  ``(path, size, mtime_ns)``: a steady-state launch stat-walks the
  directories and parses NOTHING — only new or changed files pay the
  fontTools parse, the same incremental contract
  :func:`fontalloy_core.systemfonts.scan_system_fonts` carries;
- ``/fonts`` answers the cached snapshot with a ``ready`` flag (false,
  families empty, until the first scan lands) and never runs fontTools
  inline. Freshness survives: every request stat-walks the
  directories — a cheap walk that reads no font bytes — and arms a
  background rescan when the fingerprints drift, so a downloader
  adding fonts lands on a subsequent request.

The enumeration itself keeps the ``/fonts`` contract unchanged: font
files at depth 0 and 1 (the fetched-catalog layouts nest their faces
one level down), files fontTools cannot read ride the ``skipped``
list, never fatal. The HTTP surface lives in ``serve.py``; this module
is the pure scan.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fontalloy_core.errors import FontAlloyError
from fontalloy_core.load import FaceInfo, scan_families
from fontalloy_core.local_fonts import FONT_SUFFIXES

#: How long the scan thread sleeps between parsed files — the GIL slot
#: every in-flight request handler needs while the font directories
#: are being parsed. Tests stretch this via :data:`FONTS_SCAN_DELAY_ENV`
#: to make a scan observably slow.
YIELD_SECONDS = 0.002

#: Test seam: when set, every per-file sleep lasts this many seconds
#: instead (deterministic slow scans for the responsiveness tests).
FONTS_SCAN_DELAY_ENV = "FONTALLOY_FONTS_SCAN_DELAY"

#: The on-disk cache schema version — a bump invalidates old caches.
CACHE_VERSION = 1


def _yield_between_files() -> None:
    """Hand the GIL to request handlers between two parsed files."""
    delay = os.environ.get(FONTS_SCAN_DELAY_ENV)
    time.sleep(float(delay) if delay else YIELD_SECONDS)


def font_file_paths(dirs: tuple[Path, ...]) -> list[Path]:
    """The font files the enumeration admits, in scan order.

    Depth-1 entries plus the FILES one level deeper (the two globs
    cannot overlap: ``*/*`` is exactly depth 2) — the layouts a real
    consumer points ``--font-dir`` at nest their font files there
    (the fetched catalog's extracted ``<fonts>/<archive stem>/``
    faces, the Tauri shell's per-family catalog storage). Deeper
    trees are not wandered.
    """
    out: list[Path] = []
    for directory in dirs:
        entries = [
            *sorted(Path(directory).glob("*")),
            *sorted(Path(directory).glob("*/*")),
        ]
        for path in entries:
            if path.is_file() and path.suffix.lower() in FONT_SUFFIXES:
                out.append(path)
    return out


def fingerprints_of(dirs: tuple[Path, ...]) -> dict[str, tuple[int, int]]:
    """The cheap stat walk: file -> (size, mtime_ns), fonts only.

    This is all a steady-state request pays — the parse only runs for
    files whose fingerprint the cache does not already carry, and the
    drift check against the last scan's fingerprints reads no font
    bytes.
    """
    out: dict[str, tuple[int, int]] = {}
    for path in font_file_paths(dirs):
        try:
            stat = path.stat()
        except OSError:
            continue
        out[str(path)] = (stat.st_size, stat.st_mtime_ns)
    return out


@dataclass(frozen=True)
class FontsScanResult:
    """One completed scan: the faces, the skipped files, and the
    fingerprints behind both.

    ``skipped`` carries the skipped PATHS (the document maps them to
    file names) so a reloaded cache can regroup its verdicts per file.
    """

    faces: tuple[FaceInfo, ...]
    skipped: tuple[Path, ...]
    fingerprints: dict[str, tuple[int, int]]


def scan_font_dirs(
    dirs: tuple[Path, ...],
    *,
    previous: FontsScanResult | None = None,
    cache_file: Path | None = None,
) -> FontsScanResult:
    """Scan ``dirs`` into faces, incrementally against ``previous``.

    Files whose (size, mtime_ns) fingerprint ``previous`` already
    carries keep their cached verdict — faces AND skip decisions:
    unchanged fonts are never re-parsed, and an unchanged unreadable
    stray stays a cached skip. New and changed files parse once.
    The caller's cache file (when given) is updated with the merged
    result. Yields the GIL between parsed files so a concurrent
    request handler stays live.
    """
    previous_faces: dict[str, list[FaceInfo]] = {}
    previous_skipped: set[str] = set()
    if previous is not None:
        for face in previous.faces:
            previous_faces.setdefault(str(face.path), []).append(face)
        previous_skipped = {str(path) for path in previous.skipped}
    prints = fingerprints_of(dirs)
    faces: list[FaceInfo] = []
    skipped: list[Path] = []
    for path_str, fingerprint in prints.items():
        cached_faces = previous_faces.get(path_str)
        was_skipped = path_str in previous_skipped
        verdict_known = (
            previous is not None
            and (cached_faces is not None or was_skipped)
            and previous.fingerprints.get(path_str) == fingerprint
        )
        if verdict_known:
            if was_skipped:
                skipped.append(Path(path_str))
            else:
                assert cached_faces is not None
                faces.extend(cached_faces)
            continue
        path = Path(path_str)
        try:
            for family in scan_families([path]):
                faces.extend(family.faces)
        except FontAlloyError:
            skipped.append(path)
        _yield_between_files()
    result = FontsScanResult(
        faces=tuple(faces), skipped=tuple(skipped), fingerprints=prints
    )
    if cache_file is not None:
        save_cache(cache_file, result)
    return result


def load_cache(cache_file: Path) -> FontsScanResult | None:
    """The persisted scan result, or None when absent/unreadable/stale."""
    try:
        document = json.loads(cache_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(document, dict) or document.get("version") != CACHE_VERSION:
        return None
    try:
        faces: list[FaceInfo] = []
        skipped: list[Path] = []
        prints: dict[str, tuple[int, int]] = {}
        files: dict[str, Any] = document["files"]
        for path_str, entry in files.items():
            prints[path_str] = (int(entry["print"][0]), int(entry["print"][1]))
            if entry.get("error"):
                skipped.append(Path(path_str))
                continue
            for row in entry["faces"]:
                faces.append(
                    FaceInfo(
                        path=Path(path_str),
                        face_index=int(row[0]),
                        family=row[1],
                        subfamily=row[2],
                        weight=int(row[3]),
                        italic=bool(row[4]),
                        variable=bool(row[5]),
                        style_consistent=bool(row[6]),
                    )
                )
    except (AttributeError, KeyError, TypeError, ValueError, IndexError):
        return None
    return FontsScanResult(
        faces=tuple(faces), skipped=tuple(skipped), fingerprints=prints
    )


def save_cache(cache_file: Path, result: FontsScanResult) -> None:
    """Persist the scan result (best effort — a full disk skips it)."""
    faces_by_path: dict[str, list[FaceInfo]] = {}
    for face in result.faces:
        faces_by_path.setdefault(str(face.path), []).append(face)
    skipped_paths = {str(path) for path in result.skipped}
    files: dict[str, dict[str, Any]] = {}
    for path_str, fingerprint in result.fingerprints.items():
        files[path_str] = {
            "print": [fingerprint[0], fingerprint[1]],
            "error": path_str in skipped_paths,
            "faces": [
                [
                    face.face_index,
                    face.family,
                    face.subfamily,
                    face.weight,
                    face.italic,
                    face.variable,
                    face.style_consistent,
                ]
                for face in faces_by_path.get(path_str, ())
            ],
        }
    document = {"version": CACHE_VERSION, "files": files}
    try:
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(
            json.dumps(document, ensure_ascii=False), encoding="utf-8"
        )
    except OSError:
        pass
