"""The weight and style matrix (issue #9): one recipe, the whole family.

The default requested matrix — every output weight/style the build
emits — is the UNION of the base's and the donors' faces (round 26,
issue #27: 双方字重全部保留 means its label): one slot per (weight,
style) either side carries, confined to the styles the base carries
(a base without an italic never gains one — ADR-0006's rule). A
donor-only slot borrows the NEAREST base face for its base-side
contribution (a tie prefers the lighter face): the borrowed face is
copied into a private container carrying the slot's weight identity
(OS/2 usWeightClass, the RIBBI style bits, the subfamily names), and
the borrow rides the report's weight-borrow table next to the donor
borrows. A recipe ``weights`` section REPLACES the union with an
explicit selection of base faces — the GUI's EN-only / CJK-only merge
modes land as selections and keep their semantics.

Each slot is merged exactly like a single build: the slot's base face
is the container, and every donor *family* (faces aggregated by family
name at the load stage) contributes the face nearest the slot's OS/2
usWeightClass. A recipe may rewrite the mapping per slot — an explicit
donor weight beats nearest-match and is demanded exactly, never
silently approximated.

Style matching follows the terminal convention: a donor family without
an italic face contributes its upright faces to an italic slot (and
vice versa), and the fallback is stated in the borrow record. Nothing
is ever synthesized or interpolated to bridge a style or a weight —
transform-only (ADR-0003) means the grafted outlines are always some
loaded face's own outlines, verbatim: a borrowed container keeps the
borrowed base face's outlines and advances, only its identity records
state the union weight.

Matching rules, pinned by tests:

- nearest: the face minimizing ``|usWeightClass - target|``; a tie
  prefers the lighter face; equal candidates resolve in the family's
  deterministic face order (weight, style, subfamily, path, index).
- override: the family's face at exactly the demanded weight, style
  preference first (the slot's style, then upright); anything else is
  a clear :class:`~fontalloy_core.errors.BuildError` listing what the
  family has.
- pinned: a donor reference with a pinned face contributes that one
  face to every slot — weight matching is bypassed by the pin.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from io import BytesIO

from fontTools.ttLib import TTFont

from fontalloy_core.errors import BuildError
from fontalloy_core.load import LoadedFace
from fontalloy_core.recipe import WeightRequest
from fontalloy_core.rewrite import apply_weight_identity

#: How a donor face was chosen for a slot, as the report states it.
NEAREST = "nearest"
OVERRIDE = "override"
PINNED = "pinned"


@dataclass(frozen=True)
class DonorPool:
    """One donor's faces after family aggregation: a single family.

    ``faces`` is the family's weight/style matrix in its deterministic
    order; ``pinned`` records that the recipe's reference pinned one
    face (matching is bypassed, not nearest).
    """

    donor_id: str
    faces: tuple[LoadedFace, ...]
    pinned: bool


@dataclass(frozen=True)
class DonorMatch:
    """The donor face that landed in one slot, and how it was chosen."""

    donor_id: str
    face: LoadedFace
    via: str  # NEAREST | OVERRIDE | PINNED
    style_fallback: bool  # the family lacked the slot's style


@dataclass(frozen=True)
class MatrixSlot:
    """One output weight/style: its base container and donor matches.

    ``borrowed_base`` states the union's base-side borrow: the base
    weight the container was taken from when the slot's weight is a
    donor-only one (``None`` when the base has its own face there).
    """

    base: LoadedFace
    donors: tuple[DonorMatch, ...] = ()
    borrowed_base: int | None = None


def plan_matrix(
    bases: Sequence[LoadedFace],
    pools: Mapping[str, DonorPool],
    requests: Sequence[WeightRequest],
    *,
    union: bool = True,
) -> tuple[MatrixSlot, ...]:
    """Plan the requested weight/style matrix over the loaded faces.

    ``bases`` are the base file's faces (as loaded — a pinned reference
    contributes one). ``requests`` is the recipe's ``weights`` section;
    EMPTY means the union — every base face plus a borrowed-base slot
    for every donor-only (weight, style) the base's styles cover (see
    the module docstring) — unless ``union`` is false, which a pinned
    base reference asks for: a face pin narrows the matrix to that one
    face (ADR-0006), an explicit selection like a ``weights`` entry.
    Otherwise each request must match a base face's
    ``(usWeightClass, italic)`` exactly — a weight the base has no face
    for is a clear :class:`~fontalloy_core.errors.BuildError`, never a
    nearest-match approximation (that would move the output's own
    identity, which only the base defines). Slots come out in base face
    order (the union's additions last, weight-ascending), so a
    collection's output order is its file's order whatever the recipe
    listed.
    """
    if not requests:
        if union:
            return _union_matrix(bases, pools)
        return tuple(
            MatrixSlot(
                base=base,
                donors=tuple(
                    _match_donor(pool, base.info.weight, base.info.italic, {})
                    for pool in pools.values()
                ),
            )
            for base in bases
        )
    slots_bases = _select_bases(bases, requests)
    overrides = {
        (request.weight, request.italic): dict(request.donor_weights)
        for request in requests
    }
    return tuple(
        MatrixSlot(
            base=base,
            donors=tuple(
                _match_donor(
                    pool,
                    base.info.weight,
                    base.info.italic,
                    overrides.get((base.info.weight, base.info.italic), {}),
                )
                for pool in pools.values()
            ),
        )
        for base in slots_bases
    )


def _union_matrix(
    bases: Sequence[LoadedFace], pools: Mapping[str, DonorPool]
) -> tuple[MatrixSlot, ...]:
    """The default matrix: the union of both sides' weights (r26).

    Base faces keep their own slots exactly as before; every donor-only
    (weight, style) — no base face there, and a style the base carries
    somewhere (the ADR-0006 italic rule) — becomes a slot whose
    container is a private copy of the nearest base face at that style,
    restamped with the slot's weight identity. Donors match the union
    slot like any other: nearest weight, style preference first.
    """
    slots = [
        MatrixSlot(
            base=base,
            donors=tuple(
                _match_donor(pool, base.info.weight, base.info.italic, {})
                for pool in pools.values()
            ),
        )
        for base in bases
    ]
    base_slots = {(base.info.weight, base.info.italic) for base in bases}
    base_styles = {italic for _, italic in base_slots}
    additions: dict[tuple[int, bool], MatrixSlot] = {}
    for pool in pools.values():
        for face in pool.faces:
            key = (face.info.weight, face.info.italic)
            if key in base_slots or key in additions:
                continue
            if face.info.italic not in base_styles:
                continue  # a base without the style has no slot to borrow for
            additions[key] = _borrowed_slot(bases, pools, *key)
    return tuple(slots + [additions[key] for key in sorted(additions)])


def _borrowed_slot(
    bases: Sequence[LoadedFace],
    pools: Mapping[str, DonorPool],
    weight: int,
    italic: bool,
) -> MatrixSlot:
    """One donor-only union slot: nearest-base container, donor matches."""
    container = _nearest_base(bases, weight, italic)
    return MatrixSlot(
        base=_borrowed_container(container, weight),
        donors=tuple(
            _match_donor(pool, weight, italic, {}) for pool in pools.values()
        ),
        borrowed_base=container.info.weight,
    )


def _nearest_base(
    bases: Sequence[LoadedFace], weight: int, italic: bool
) -> LoadedFace:
    """The base face a donor-only slot borrows: nearest weight, same
    style (the gate in :func:`_union_matrix` guarantees the style
    exists), a tie preferring the lighter face."""
    same_style = [base for base in bases if base.info.italic == italic]
    return min(
        same_style, key=lambda base: (abs(base.info.weight - weight), base.info.weight)
    )


def _borrowed_container(container: LoadedFace, weight: int) -> LoadedFace:
    """A private copy of ``container`` carrying the slot's weight.

    The copy is a serialization round trip (save to memory, load back),
    so the union slot's graft and identity rewrite can never touch the
    base face's own slot — the two would otherwise share one TTFont.
    """
    buffer = BytesIO()
    container.font.save(buffer)
    buffer.seek(0)
    font = TTFont(buffer)
    subfamily = apply_weight_identity(font, weight, container.info.italic)
    return LoadedFace(
        font=font,
        info=replace(container.info, weight=weight, subfamily=subfamily),
    )


def _select_bases(
    bases: Sequence[LoadedFace], requests: Sequence[WeightRequest]
) -> tuple[LoadedFace, ...]:
    """The base face of every requested slot, in base face order."""
    if not requests:
        return tuple(bases)

    by_slot: dict[tuple[int, bool], list[LoadedFace]] = {}
    for base in bases:
        by_slot.setdefault((base.info.weight, base.info.italic), []).append(base)

    chosen: list[LoadedFace] = []
    for request in requests:
        key = (request.weight, request.italic)
        if key not in by_slot:
            raise BuildError(
                f"the weights selection requests {key[0]} "
                f"({'italic' if key[1] else 'upright'}), but the base font has "
                f"no face there (available: "
                f"{_slot_labels(bases)}): {_first_path(bases)}"
            )
        chosen.append(by_slot[key][0])
    # A selection is a set: the output keeps the base file's face order.
    return tuple(sorted(chosen, key=lambda base: base.info.face_index))


def _match_donor(
    pool: DonorPool, weight: int, italic: bool, overrides: Mapping[str, int]
) -> DonorMatch:
    """Pick the donor pool's face for one slot and state how it was chosen."""
    if pool.pinned:
        face = pool.faces[0]
        return DonorMatch(
            donor_id=pool.donor_id,
            face=face,
            via=PINNED,
            style_fallback=face.info.italic != italic,
        )
    demanded = overrides.get(pool.donor_id)
    if demanded is not None:
        face, fallback = _exact_face(pool, demanded, italic)
        via = OVERRIDE
    else:
        face, fallback = _nearest_face(pool.faces, weight, italic)
        via = NEAREST
    return DonorMatch(
        donor_id=pool.donor_id, face=face, via=via, style_fallback=fallback
    )


def _nearest_face(
    faces: Sequence[LoadedFace], weight: int, italic: bool
) -> tuple[LoadedFace, bool]:
    """The nearest-weight face, preferring the slot's style.

    Falls back to the family's other style when the requested one does
    not exist (the upright-for-italic terminal convention, symmetric so
    an italic-only family still contributes).
    """
    same_style = [face for face in faces if face.info.italic == italic]
    fallback = not same_style
    pool = same_style or [face for face in faces if not face.info.italic] or list(
        faces
    )
    # Nearest by |usWeightClass - target|; an exact tie prefers the
    # lighter face (the key states it — no reliance on pool order).
    face = min(
        pool, key=lambda face: (abs(face.info.weight - weight), face.info.weight)
    )
    return face, fallback


def _exact_face(
    pool: DonorPool, weight: int, italic: bool
) -> tuple[LoadedFace, bool]:
    """The family's face at exactly ``weight``, style preference first.

    An explicit override is a demand: no silent nearest approximation.
    """
    same_style = [
        face
        for face in pool.faces
        if face.info.italic == italic and face.info.weight == weight
    ]
    if same_style:
        return same_style[0], False
    uprights = [
        face
        for face in pool.faces
        if not face.info.italic and face.info.weight == weight
    ]
    if uprights:
        return uprights[0], True
    available = ", ".join(
        str(face.info.weight) for face in pool.faces
    )
    raise BuildError(
        f"the weights selection demands {pool.donor_id} at weight {weight}, "
        f"but the family has no face there (available weights: {available}): "
        f"{pool.faces[0].info.path}"
    )


def _slot_labels(bases: Sequence[LoadedFace]) -> str:
    """The base's available slots, in the recipe's own syntax."""
    if not bases:  # pragma: no cover — a loaded font file has a face
        return "none"
    return ", ".join(
        f"{base.info.weight} ({'italic' if base.info.italic else 'upright'})"
        for base in bases
    )


def _first_path(bases: Sequence[LoadedFace]) -> str:
    return str(bases[0].info.path)
