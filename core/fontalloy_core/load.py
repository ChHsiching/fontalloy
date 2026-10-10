"""Pipeline stage 1: load and detect (issue #4).

Any real-world font file works as input. :func:`load_face` turns one
recipe font reference into a loaded face — a TTC collection selects its
face, a variable font is instantiated to a static instance, a woff2 is
decoded — plus the :class:`FaceInfo` metadata (family, weight, style)
that later stages aggregate and match on. :func:`scan_families` and
:func:`aggregate_families` group faces by family into the weight/style
matrices the weight-mapping and catalog work consume.

The loaded font is always a plain static TTF/OTF in memory (flavor
cleared), so no later stage has to care what the file on disk was.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from pathlib import Path

from fontTools.ttLib import TTFont

from fontalloy_core.errors import BuildError
from fontalloy_core.recipe import FontRef

#: The sfnt tag of a TrueType Collection file.
_TTC_TAG = b"ttcf"


@dataclass(frozen=True)
class FaceInfo:
    """Detectable identity of one face of a font file.

    ``family`` and ``subfamily`` prefer the typographic name records
    (nameID 16/17) and fall back to the legacy ones (1/2); ``weight`` is
    OS/2.usWeightClass; ``italic`` is the OS/2 fsSelection italic bit.
    ``variable`` records that the face on disk carried an ``fvar`` table.
    """

    path: Path
    face_index: int
    family: str
    subfamily: str
    weight: int
    italic: bool
    variable: bool


@dataclass(frozen=True)
class Family:
    """One family name with its faces — the weight/style matrix."""

    name: str
    faces: tuple[FaceInfo, ...]


@dataclass
class LoadedFace:
    """One loaded face: the decoded static font plus its identity."""

    font: TTFont
    info: FaceInfo


def load_face(ref: FontRef, *, role: str) -> LoadedFace:
    """Load the face a font reference points at.

    Raises :class:`~fontalloy_core.errors.BuildError` when the file is
    missing, is not a usable font, or the reference's face selection or
    instance pins do not fit the file.
    """
    path = ref.path
    if not path.is_file():
        raise BuildError(f"{role} file not found: {path}")

    face_index = _select_face(path, ref.face, role)
    try:
        font = TTFont(path, fontNumber=face_index)
        best_cmap = font.getBestCmap()
    except Exception as exc:  # fontTools raises TTLibError and friends
        raise BuildError(f"{role} file is not a valid font: {path} ({exc})") from None
    if not best_cmap:
        raise BuildError(f"{role} has no Unicode coverage (no usable cmap): {path}")

    # A woff2 input is decoded: clearing the flavor makes every later
    # save (and the pass-through output) a plain TTF.
    font.flavor = None
    return LoadedFace(
        font=font,
        info=FaceInfo(
            path=path,
            face_index=face_index,
            family=_name(font, 16, 1),
            subfamily=_name(font, 17, 2),
            weight=_weight(font),
            italic=_italic(font),
            variable="fvar" in font,
        ),
    )


def _select_face(path: Path, face: int | None, role: str) -> int:
    """Resolve the face selection against the file's face count."""
    face_count = _face_count(path)
    if face_count <= 1:
        # A plain font has exactly face 0; higher indices are mistakes.
        if face is None or face == 0:
            return 0
        raise BuildError(
            f"{role} file is not a collection and has no face {face}: {path}"
        )
    if face is None:
        raise BuildError(
            f"{role} file is a collection with {face_count} faces; select one "
            f"with a face reference (e.g. '{path.name}#1' or 'face: 1'): {path}"
        )
    if face >= face_count:
        raise BuildError(
            f"{role} face {face} is out of range: {path} is a collection with "
            f"{face_count} faces (0 to {face_count - 1})"
        )
    return face


def _face_count(path: Path) -> int:
    """Read how many faces a font file carries (1 unless it is a TTC)."""
    with path.open("rb") as stream:
        tag = stream.read(4)
        if tag != _TTC_TAG:
            return 1
        stream.seek(8)  # past the tag and the version field
        return struct.unpack(">I", stream.read(4))[0]


def _name(font: TTFont, preferred_id: int, fallback_id: int) -> str:
    table = font.get("name")
    if table is None:
        return ""
    for name_id in (preferred_id, fallback_id):
        name = table.getDebugName(name_id)
        if name:
            return name
    return ""


def _weight(font: TTFont) -> int:
    os2 = font.get("OS/2")
    if os2 is None:
        return 400
    return int(os2.usWeightClass)


def _italic(font: TTFont) -> bool:
    os2 = font.get("OS/2")
    if os2 is not None:
        return bool(os2.fsSelection & 0x01)
    head = font.get("head")
    if head is not None:
        return bool(head.macStyle & 0x02)
    return False
