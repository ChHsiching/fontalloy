"""System font discovery (round 24, owner item 3).

The pickers' third source beside the catalog and local file loads:
the fonts the OPERATING SYSTEM itself installs, enumerated from the
standard per-platform directories and classified by what each face
actually covers — a face with Latin coverage lists in the EN picker,
one with CJK coverage in the CJK picker, and a face with both lists in
BOTH (the owner's ruling: 微软雅黑 belongs in both; wanting only its
Chinese is a legitimate pick). A user who relocates their system font
directory is out of scope.

Scanning is lazy and cached per serve process: the first
``/system-fonts`` request walks the directories and reads each font's
name table and cmap with fontTools (lazy tables, one pass per face of
a collection); later requests answer from the cache. The scan skips
anything fontTools cannot read — a stray file in a system directory
must never take the enumeration down.

The HTTP surface lives in ``serve.py``; this module is the pure scan.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path

from fontTools.ttLib import TTFont

#: Font file suffixes the scan admits (woff/woff2 are web formats a
#: system directory rarely carries; admitting them costs nothing but
#: they parse slower, so the scan stays with the installable formats).
FONT_SUFFIXES = frozenset({".ttf", ".otf", ".ttc", ".otc"})

#: The codepoints a face is classified by: "A"/"a" for Latin,
#: CJK Unified Ideographs 中 for Chinese. Both flags ride every face;
#: the picker lists per flag and a face with both is welcome twice.
_LATIN_MARKERS = (0x41, 0x61)
_CJK_MARKERS = (0x4E2D,)


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


def _name(font: TTFont, name_id: int) -> str:
    value = font["name"].getDebugName(name_id)
    return " ".join(value.split()) if value else ""


def _face_document(font: TTFont) -> tuple[str, str, int, bool, bool, bool]:
    """One open face's identity and coverage flags."""
    os2 = font.get("OS/2")
    cmap = font.getBestCmap()
    codepoints = cmap and set(cmap) or set()
    latin = any(marker in codepoints for marker in _LATIN_MARKERS)
    cjk = any(marker in codepoints for marker in _CJK_MARKERS)
    italic = bool(os2 is not None and os2.fsSelection & 0x01) if os2 else False
    weight = int(os2.usWeightClass) if os2 is not None else 400
    return (
        _name(font, 16) or _name(font, 1),
        _name(font, 17) or _name(font, 2) or "Regular",
        weight,
        italic,
        latin,
        cjk,
    )


def scan_system_fonts(dirs: tuple[Path, ...]) -> list[SystemFace]:
    """Every readable font face under ``dirs``, recursive, sorted.

    Deterministic: directory walk order, then face order within a
    file. Unreadable or non-font files are skipped silently — the
    system directories belong to the OS, not to us.
    """
    faces: list[SystemFace] = []
    for root in dirs:
        if not root.is_dir():
            continue
        for dirpath, _dirnames, filenames in os.walk(root):
            for filename in sorted(filenames):
                path = Path(dirpath) / filename
                if path.suffix.lower() not in FONT_SUFFIXES:
                    continue
                faces.extend(_scan_file(path))
    return faces


def _scan_file(path: Path) -> list[SystemFace]:
    try:
        first = TTFont(path, fontNumber=0, lazy=True)
        try:
            count = first.reader.numFonts  # type: ignore[attr-defined]
        except AttributeError:
            count = 1
        _face_document(first)  # probe: the parse must hold for face 0
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


def system_faces_document(dirs: tuple[Path, ...]) -> dict[str, object]:
    """The ``/system-fonts`` response: every face, flat.

    The GUI groups faces into families itself (the same
    representative-first discipline local loads follow).
    """
    faces = scan_system_fonts(dirs)
    return {
        "dirs": [str(directory) for directory in dirs],
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
            for face in faces
        ],
    }
