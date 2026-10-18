"""System font discovery (round 24, owner item 3; round 25 rebuild).

The pickers' third source beside the catalog and local file loads:
the fonts the OPERATING SYSTEM itself installs, enumerated from the
standard per-platform directories and classified by what each face
actually covers — a face with Latin coverage lists in the EN picker,
one with CJK coverage in the CJK picker, and a face with both lists in
BOTH (the owner's ruling: 微软雅黑 belongs in both; wanting only its
Chinese is a legitimate pick). A user who relocates their system font
directory is out of scope.

Round 25 (owner items 1+2, the wedge): the first implementation
parsed the whole machine's font directory inside one request handler
while holding the serve's global lock — pure-CPU fontTools work that
starved every other request (the GIL) for minutes on a real install,
wedged the service, and re-scanned the disk on every launch. The scan
now:

- runs on a BACKGROUND THREAD the serve starts at boot, sleeping
  :data:`SCAN_YIELD_SECONDS` between files so request handlers keep
  getting GIL slots (``/health`` answers while a scan is in flight);
- caches its result on disk keyed by per-file fingerprints
  (path, size, mtime_ns): a steady-state launch stat-walks the
  directories and parses NOTHING — only new or changed files pay the
  fontTools parse;
- answers ``/system-fonts`` with ``{"ready": false, faces: []}``
  until the first scan lands, and the byte endpoint serves only files
  the scan itself recorded.

Ticket #34: the FAMILY GROUPING is the serve's too —
:func:`group_system_families` pools the flat scan into per-family
documents (representative first, flags riding actual coverage), so the
frontend consumes groups and never re-derives the semantics page-side.

The HTTP surface lives in ``serve.py``; this module is the pure scan.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.parse
from dataclasses import dataclass
from pathlib import Path

from fontTools.ttLib import TTFont

#: Font file suffixes the scan admits (woff/woff2 are web formats a
#: system directory rarely carries; they also parse slower, so the
#: scan stays with the installable formats).
FONT_SUFFIXES = frozenset({".ttf", ".otf", ".ttc", ".otc"})

#: How long the scan thread sleeps between files — the GIL slot every
#: in-flight request handler needs while a real machine's font
#: directory is being parsed. Tests stretch this via
#: :data:`SCAN_DELAY_ENV` to make a scan observably slow.
SCAN_YIELD_SECONDS = 0.002

#: Test seam: when set, every per-file sleep lasts this many seconds
#: instead (deterministic slow scans for the responsiveness tests).
SCAN_DELAY_ENV = "FONTALLOY_SYSTEM_SCAN_DELAY"

#: The codepoints a face is classified by: "A"/"a" for Latin,
#: CJK Unified Ideographs 中 for Chinese. Both flags ride every face;
#: the picker lists per flag and a face with both is welcome twice.
_LATIN_MARKERS = (0x41, 0x61)
_CJK_MARKERS = (0x4E2D,)

#: The on-disk cache schema version — a bump invalidates old caches.
CACHE_VERSION = 2


@dataclass(frozen=True)
class SystemFace:
    """One face of one installed system font file."""

    path: Path
    file: str
    face: int
    family: str
    subfamily: str
    weight: int
    italic: bool
    latin: bool
    cjk: bool


@dataclass(frozen=True)
class SystemFamily:
    """One installed family: its faces grouped, with the row's flags.

    Ticket #34: the grouping semantics the frontend used to compute
    page-side now live here — faces pool by their own name-table family,
    the representative (400-upright preferred, else the scan's first
    face) leads ``faces``, and the family's latin/cjk flags ride its
    faces' ACTUAL coverage (any face covering a side marks the family —
    the owner's 微软雅黑 ruling: a family whose Chinese is a legitimate
    standalone CJK pick lists in both pickers).
    """

    family: str
    faces: tuple[SystemFace, ...]
    representative: SystemFace
    latin: bool
    cjk: bool


def group_system_families(
    faces: tuple[SystemFace, ...] | list[SystemFace],
) -> list[SystemFamily]:
    """Group the flat scan into families (representative first)."""
    groups: dict[str, list[SystemFace]] = {}
    for face in faces:
        groups.setdefault(face.family, []).append(face)
    families: list[SystemFamily] = []
    for family, group in groups.items():
        rep = next(
            (face for face in group if face.weight == 400 and not face.italic),
            group[0],
        )
        families.append(
            SystemFamily(
                family=family,
                faces=(rep, *(face for face in group if face is not rep)),
                representative=rep,
                latin=any(face.latin for face in group),
                cjk=any(face.cjk for face in group),
            )
        )
    return families


#: The face byte endpoint every grouped face's ``href`` points at.
_FACE_ENDPOINT = "/system-fonts/file"


def face_href(path: Path, face_index: int) -> str:
    """The URL one scanned system face's bytes serve at."""
    return (
        f"{_FACE_ENDPOINT}?"
        + urllib.parse.urlencode({"path": str(path), "index": face_index})
    )


def face_etag(fingerprint: tuple[int, int], face_index: int) -> str:
    """The cache identity of one served system face.

    The scan's own per-file fingerprint (size, mtime_ns) plus the face
    index — the same string that invalidated the scan, so a changed
    file can never serve stale bytes behind an old ETag.
    """
    size, mtime_ns = fingerprint
    return f"{mtime_ns:x}-{size:x}-{face_index}"


def system_font_dirs() -> tuple[Path, ...]:
    """The standard font directories of the running platform.

    Windows: the machine directory plus the per-user directory modern
    Windows installs into. macOS: the system, local, and user library
    font directories. Linux: the XDG data directory and its legacy
    spelling plus the two system-wide share locations. Missing
    directories are fine — the scan skips them.
    """
    home = Path.home()
    if sys.platform == "win32":
        windir = Path(os.environ.get("WINDIR", r"C:\Windows"))
        local = Path(os.environ.get("LOCALAPPDATA", home / "AppData/Local"))
        return (
            windir / "Fonts",
            local / "Microsoft" / "Windows" / "Fonts",
        )
    if sys.platform == "darwin":
        return (
            Path("/System/Library/Fonts"),
            Path("/Library/Fonts"),
            home / "Library" / "Fonts",
        )
    return (
        home / ".local" / "share" / "fonts",
        home / ".fonts",
        Path("/usr/share/fonts"),
        Path("/usr/local/share/fonts"),
    )


def _yield_between_files() -> None:
    """Hand the GIL to request handlers between two scanned files."""
    delay = os.environ.get(SCAN_DELAY_ENV)
    time.sleep(float(delay) if delay else SCAN_YIELD_SECONDS)


def _name(font: TTFont, name_id: int) -> str:
    value = font["name"].getDebugName(name_id)
    return " ".join(value.split()) if value else ""


def _face_document(font: TTFont) -> tuple[str, str, int, bool, bool, bool]:
    """One open face's identity and coverage flags."""
    os2 = font.get("OS/2")
    cmap = font.getBestCmap()
    codepoints = set(cmap) if cmap else set()
    latin = any(marker in codepoints for marker in _LATIN_MARKERS)
    cjk = any(marker in codepoints for marker in _CJK_MARKERS)
    italic = bool(os2 is not None and os2.fsSelection & 0x01)
    weight = int(os2.usWeightClass) if os2 is not None else 400
    return (
        _name(font, 16) or _name(font, 1),
        _name(font, 17) or _name(font, 2) or "Regular",
        weight,
        italic,
        latin,
        cjk,
    )


def _scan_file(path: Path) -> list[SystemFace]:
    try:
        first = TTFont(path, fontNumber=0, lazy=True)
        try:
            reader = getattr(first, "reader", None)
            count = int(getattr(reader, "numFonts", 1) or 1)
        except Exception:
            count = 1
        documents: list[tuple[str, str, int, bool, bool, bool]] = []
        for index in range(count):
            font = first if index == 0 else TTFont(path, fontNumber=index, lazy=True)
            try:
                documents.append(_face_document(font))
            finally:
                if index != 0:
                    font.close()
        first.close()
    except Exception:
        return []
    return [
        SystemFace(
            path=path,
            file=path.name,
            face=index,
            family=family,
            subfamily=subfamily,
            weight=weight,
            italic=italic,
            latin=latin,
            cjk=cjk,
        )
        for index, (family, subfamily, weight, italic, latin, cjk) in enumerate(
            documents
        )
    ]


def _fingerprints(dirs: tuple[Path, ...]) -> dict[str, tuple[int, int]]:
    """The cheap stat walk: file -> (size, mtime_ns), fonts only.

    This is all a steady-state launch pays — the parse only runs for
    files whose fingerprint the cache does not already carry.
    """
    out: dict[str, tuple[int, int]] = {}
    for root in dirs:
        if not root.is_dir():
            continue
        for dirpath, _dirnames, filenames in os.walk(root):
            for filename in filenames:
                if Path(filename).suffix.lower() not in FONT_SUFFIXES:
                    continue
                path = Path(dirpath) / filename
                try:
                    stat = path.stat()
                except OSError:
                    continue
                out[str(path)] = (stat.st_size, stat.st_mtime_ns)
    return out


@dataclass(frozen=True)
class ScanResult:
    """One completed scan: the faces plus the fingerprints behind them."""

    faces: tuple[SystemFace, ...]
    fingerprints: dict[str, tuple[int, int]]


def load_cache(cache_file: Path) -> ScanResult | None:
    """The persisted scan result, or None when absent/unreadable/stale."""
    try:
        document = json.loads(cache_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if document.get("version") != CACHE_VERSION:
        return None
    try:
        faces = tuple(
            SystemFace(
                path=Path(face["path"]),
                file=face["file"],
                face=face["face"],
                family=face["family"],
                subfamily=face["subfamily"],
                weight=face["weight"],
                italic=face["italic"],
                latin=face["latin"],
                cjk=face["cjk"],
            )
            for face in document["faces"]
        )
        fingerprints = {
            path: (entry[0], entry[1]) for path, entry in document["prints"].items()
        }
    except (KeyError, TypeError, ValueError):
        return None
    return ScanResult(faces=faces, fingerprints=fingerprints)


def save_cache(cache_file: Path, result: ScanResult) -> None:
    """Persist the scan result (best effort — a full disk skips it)."""
    document = {
        "version": CACHE_VERSION,
        "faces": [
            {
                "path": str(face.path),
                "file": face.file,
                "face": face.face,
                "family": face.family,
                "subfamily": face.subfamily,
                "weight": face.weight,
                "italic": face.italic,
                "latin": face.latin,
                "cjk": face.cjk,
            }
            for face in result.faces
        ],
        "prints": result.fingerprints,
    }
    try:
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(
            json.dumps(document, ensure_ascii=False), encoding="utf-8"
        )
    except OSError:
        pass


def scan_system_fonts(
    dirs: tuple[Path, ...],
    *,
    previous: ScanResult | None = None,
    cache_file: Path | None = None,
) -> ScanResult:
    """Scan ``dirs`` into faces, incrementally against ``previous``.

    Files whose (size, mtime_ns) fingerprint ``previous`` already
    carries keep their cached faces — unchanged fonts are never
    re-parsed. New and changed files parse once. The caller's cache
    file (when given) is updated with the merged result. Yields the
    GIL between files so a concurrent request handler stays live.
    """
    previous_faces: dict[str, list[SystemFace]] = {}
    if previous is not None:
        for face in previous.faces:
            previous_faces.setdefault(str(face.path), []).append(face)
    prints = _fingerprints(dirs)
    faces: list[SystemFace] = []
    for path_str, fingerprint in prints.items():
        cached = previous_faces.get(path_str)
        if (
            cached is not None
            and previous is not None
            and previous.fingerprints.get(path_str) == fingerprint
            and cached[0].file == Path(path_str).name
        ):
            faces.extend(cached)
            continue
        faces.extend(_scan_file(Path(path_str)))
        _yield_between_files()
    result = ScanResult(faces=tuple(faces), fingerprints=prints)
    if cache_file is not None:
        save_cache(cache_file, result)
    return result


def scan_system_fonts_sync(dirs: tuple[Path, ...]) -> list[SystemFace]:
    """Every readable font face under ``dirs`` — the plain full scan.

    Kept for tests and one-off tooling; the serve uses the cached,
    incremental :func:`scan_system_fonts` on its background thread.
    """
    return list(scan_system_fonts(dirs).faces)
