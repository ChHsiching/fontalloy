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
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

from fontalloy_core.errors import BuildError
from fontalloy_core.recipe import FontRef

#: The sfnt tag of a TrueType Collection file.
_TTC_TAG = b"ttcf"


@dataclass(frozen=True)
class FaceInfo:
    """Detectable identity of one face of a font file.

    ``family`` and ``subfamily`` prefer the typographic name records
    (nameID 16/17) and fall back to the legacy ones (1/2); ``weight`` is
    OS/2.usWeightClass; ``italic`` is the face's slanted-ness (any of
    the OS/2 fsSelection italic bit, the head macStyle italic bit, or a
    nonzero post.italicAngle — round 29). ``variable`` records that the
    face on disk carried an ``fvar`` table.

    ``style_consistent`` (round 29) records whether the three italic
    signals AGREE. Publisher style side-cuts disagree on purpose: Nerd
    Fonts releases ship Oblique faces with sheared glyphs but upright
    flags (inside their own legacy family the oblique IS the normal
    member) and Upright-Italic faces flagged italic with upright ink.
    A consistent face's flags describe its ink; an inconsistent face's
    do not, which is what :func:`resolve_base_faces` breaks ties with.
    """

    path: Path
    face_index: int
    family: str
    subfamily: str
    weight: int
    italic: bool
    variable: bool
    style_consistent: bool = True


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


@dataclass(frozen=True)
class SkippedFace:
    """One base face the slot resolution dropped, and why (round 29).

    Report data: the face's file, slot identity, its own subfamily,
    and the reason it lost the slot — never a silent drop.
    """

    path: Path
    face_index: int
    weight: int
    italic: bool
    subfamily: str
    reason: str


def resolve_base_faces(
    faces: list[LoadedFace],
) -> tuple[list[LoadedFace], list[SkippedFace]]:
    """One base face per (weight, italic) slot (round 29, owner report).

    A base reference whose pattern pools a publisher's style side-cuts
    (Nerd Fonts Oblique/Upright-Italic files — all under one umbrella
    typographic family, so :func:`aggregate_families` sees a single
    family) delivers several faces for the same (weight, style) slot.
    The output would carry two faces claiming the same slot with
    different ink — an upright-flagged face with sheared glyphs — and
    every font matcher may then hand normal text the slanted one. That
    is exactly the round-29 report: merged REGULAR text rendering
    italic.

    Resolution: when faces collide on a slot, the one whose own flags
    describe its ink (``style_consistent``) keeps the slot; the file
    order decides among equals, and a slot with no consistent face
    keeps its first face. Dropped faces come back as
    :class:`SkippedFace` records for the report — a drop is stated,
    never silent. A pool with no collisions passes through untouched.
    """
    slots: dict[tuple[int, bool], list[LoadedFace]] = {}
    for face in faces:
        slots.setdefault((face.info.weight, face.info.italic), []).append(face)
    dropped_ids: set[int] = set()
    skipped: list[SkippedFace] = []
    for (weight, italic), group in slots.items():
        if len(group) == 1:
            continue
        consistent = [face for face in group if face.info.style_consistent]
        winner = (consistent or group)[0]
        style = "italic" if italic else "upright"
        for face in group:
            if face is winner:
                continue
            dropped_ids.add(id(face))
            skipped.append(
                SkippedFace(
                    path=face.info.path,
                    face_index=face.info.face_index,
                    weight=weight,
                    italic=italic,
                    subfamily=face.info.subfamily,
                    reason=(
                        f"duplicate {weight} {style} slot; kept "
                        f"{winner.info.subfamily or winner.info.family}"
                    ),
                )
            )
    kept = [face for face in faces if id(face) not in dropped_ids]
    return kept, skipped


def load_face(ref: FontRef, *, role: str) -> LoadedFace:
    """Load the face a font reference points at.

    Raises :class:`~fontalloy_core.errors.BuildError` when the file is
    missing, is not a usable font, or the reference's face selection or
    instance pins do not fit the file. Only a single-file reference can
    load through here — a catalog-family reference that resolved to
    several files is a clear error (it carries a family, not a face).
    """
    path = _single_path(ref, role)
    if not path.is_file():
        raise BuildError(f"{role} file not found: {path}")
    face_index = _select_face(path, ref.face, role)
    return _load_face_at(path, face_index, ref.instance, role)


def load_faces(ref: FontRef, *, role: str) -> list[LoadedFace]:
    """Load every face the reference selects, without the one-face rule.

    This is the TTC-output selection (issue #10): a build that packages
    a collection merges each face of the base font file into its own
    output face, so a reference without a face pin selects ALL faces
    here, while a pinned face still selects just that one (a plain font
    file contributes its single face). Every per-face behavior of
    :func:`load_face` — variable instantiation, woff2 decode, identity
    detection — applies unchanged.

    A catalog-family reference (issue #23) resolves to the files its
    manifest entry contributes (one bare font file, or the extracted
    faces of a pinned archive narrowed by the recipe's pattern); every
    face of every file loads here in deterministic file order, which is
    how one reference carries a whole weight matrix.
    """
    faces: list[LoadedFace] = []
    for path in _ref_paths(ref, role):
        if not path.is_file():
            raise BuildError(f"{role} file not found: {path}")
        face_count = _face_count(path)
        indices = range(face_count) if ref.face is None else [ref.face]
        faces.extend(
            _load_face_at(path, index, ref.instance, role) for index in indices
        )
    return faces


def _ref_paths(ref: FontRef, role: str) -> tuple[Path, ...]:
    """Every file a reference points at (path and catalog forms alike)."""
    if ref.paths:
        return ref.paths
    if ref.path is not None:
        return (ref.path,)
    raise BuildError(
        f"{role} reference carries no font files — a catalog-family "
        "reference must be resolved against the fetched catalog first "
        "(the build does this when given a manifest)"
    )


def _single_path(ref: FontRef, role: str) -> Path:
    """The one file a single-face reference points at."""
    paths = _ref_paths(ref, role)
    if len(paths) > 1:
        raise BuildError(
            f"{role} reference resolved to {len(paths)} files; a single "
            "face needs exactly one — narrow the recipe's pattern"
        )
    return paths[0]


def _load_face_at(
    path: Path,
    face_index: int,
    instance: tuple[tuple[str, int | float], ...] | None,
    role: str,
) -> LoadedFace:
    """Load one face of ``path`` at ``face_index`` (shared load path)."""
    _select_face(path, face_index, role)
    try:
        font = TTFont(path, fontNumber=face_index)
        best_cmap = font.getBestCmap()
    except Exception as exc:  # fontTools raises TTLibError and friends
        raise BuildError(f"{role} file is not a valid font: {path} ({exc})") from None
    if not best_cmap:
        raise BuildError(f"{role} has no Unicode coverage (no usable cmap): {path}")

    if "fvar" in font:
        _instantiate(font, instance, role, path)

    # A woff2 input is decoded: clearing the flavor makes every later
    # save (and the pass-through output) a plain TTF.
    font.flavor = None
    italic, style_consistent = _style_identity(font)
    return LoadedFace(
        font=font,
        info=FaceInfo(
            path=path,
            face_index=face_index,
            family=_name(font, 16, 1),
            subfamily=_name(font, 17, 2),
            weight=_weight(font),
            italic=italic,
            variable=False,  # instantiated above: the face is static now
            style_consistent=style_consistent,
        ),
    )


def scan_families(paths: Iterable[Path | str]) -> tuple[Family, ...]:
    """Scan font files and aggregate their faces by family.

    One :class:`FaceInfo` per face of every file (a TTC contributes one
    per face), grouped into :class:`Family` weight/style matrices — the
    input side of the catalog, the GUI font pickers, and the weight
    matching. Files are scanned as-is: a variable font reports its
    default instance's weight with ``variable=True`` (no instantiation
    happens here). Raises :class:`~fontalloy_core.errors.BuildError` for
    a missing file or one fontTools cannot read.
    """
    faces: list[FaceInfo] = []
    for path in map(Path, paths):
        if not path.is_file():
            raise BuildError(f"font file not found: {path}")
        for index in range(_face_count(path)):
            faces.append(_scan_face(path, index))
    return aggregate_families(faces)


def aggregate_families(faces: Iterable[FaceInfo]) -> tuple[Family, ...]:
    """Group faces by family name into weight/style matrices.

    Families sort by name, faces within a family by (weight, style,
    path, face index), so the result is deterministic for equal input.
    """
    grouped: dict[str, list[FaceInfo]] = {}
    for face in faces:
        grouped.setdefault(face.family, []).append(face)
    return tuple(
        Family(
            name=name,
            faces=tuple(
                sorted(
                    group,
                    key=lambda face: (
                        face.weight,
                        face.italic,
                        face.subfamily,
                        str(face.path),
                        face.face_index,
                    ),
                )
            ),
        )
        for name, group in sorted(grouped.items())
    )


def _scan_face(path: Path, index: int) -> FaceInfo:
    """Read one face's identity without loading it as a merge input."""
    try:
        font = TTFont(path, fontNumber=index)
    except Exception as exc:  # fontTools raises TTLibError and friends
        raise BuildError(f"file is not a valid font: {path} ({exc})") from None
    try:
        italic, style_consistent = _style_identity(font)
        return FaceInfo(
            path=path,
            face_index=index,
            family=_name(font, 16, 1),
            subfamily=_name(font, 17, 2),
            weight=_weight(font),
            italic=italic,
            variable="fvar" in font,
            style_consistent=style_consistent,
        )
    except BuildError:
        raise
    except Exception as exc:  # round 27: a truncated table read inside
        # the identity pass is as fatal as an unopenable file — convert
        # it so the serve's per-file skip (fonts_document) catches it
        # and one corrupt face never 500s the whole /fonts listing.
        raise BuildError(
            f"file is not a valid font: {path} ({exc})"
        ) from None
    finally:
        font.close()


def _instantiate(
    font: TTFont,
    instance: tuple[tuple[str, int | float], ...] | None,
    role: str,
    path: Path,
) -> None:
    """Instantiate a variable font to a static instance (issue #4).

    Pinned axes take the recipe's values; every other axis takes its
    default, so the result is always fully static.
    """
    axes = {axis.axisTag: axis for axis in font["fvar"].axes}
    limits: dict[str, int | float] = {}
    for tag, pinned in instance or ():
        axis = axes.get(tag)
        if axis is None:
            available = ", ".join(sorted(axes))
            raise BuildError(
                f"{role} instance pins axis {tag!r}, but the font has no such "
                f"axis (available: {available}): {path}"
            )
        if not axis.minValue <= pinned <= axis.maxValue:
            raise BuildError(
                f"{role} instance pins axis {tag!r} to {pinned}, outside its "
                f"range {axis.minValue:g} to {axis.maxValue:g}: {path}"
            )
        limits[tag] = pinned
    for tag, axis in axes.items():
        limits.setdefault(tag, axis.defaultValue)

    try:
        instantiateVariableFont(font, limits, inplace=True)
    except Exception as exc:
        raise BuildError(
            f"{role} variable font could not be instantiated: {path} ({exc})"
        ) from None


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


def _style_identity(font: TTFont) -> tuple[bool, bool]:
    """The face's (slanted, flags-describe-ink) style identity.

    Slanted-ness is ANY italic signal (round 29): the OS/2 fsSelection
    bit, the head macStyle bit, or a nonzero post.italicAngle — an
    Oblique face flagged upright (its publisher keeps the oblique the
    "normal" member of its own legacy family) still slants, and a slot
    key that ignores that puts sheared ink under an upright slot.
    Consistency requires all three to agree (see :class:`FaceInfo`).
    """
    os2 = font.get("OS/2")
    head = font.get("head")
    post = font.get("post")
    fs_bit = bool(os2.fsSelection & 0x01) if os2 is not None else False
    mac_bit = bool(head.macStyle & 0x02) if head is not None else False
    try:
        angle_slant = (
            post is not None and float(post.italicAngle) != 0.0
        )
    except (TypeError, ValueError):  # a malformed angle reads upright
        angle_slant = False
    return (
        fs_bit or mac_bit or angle_slant,
        fs_bit == mac_bit == angle_slant,
    )
