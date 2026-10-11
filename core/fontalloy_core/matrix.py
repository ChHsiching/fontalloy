"""The weight and style matrix (issue #9): one recipe, the whole family.

The requested matrix — every output weight/style the build emits — comes
from the base font file's faces (stage 1 already loaded them; a recipe
``weights`` section selects a subset). Each slot is merged exactly like
a single build: the slot's base face is the container, and every donor
*family* (faces aggregated by family name at the load stage) contributes
the face nearest the slot's OS/2 usWeightClass. A recipe may rewrite the
mapping per slot — an explicit donor weight beats nearest-match and is
demanded exactly, never silently approximated.

Style matching follows the terminal convention: a donor family without
an italic face contributes its upright faces to an italic slot (and
vice versa), and the fallback is stated in the borrow record. Nothing
is ever synthesized or interpolated to bridge a style or a weight —
transform-only (ADR-0003) means the grafted outlines are always some
loaded face's own outlines, verbatim.

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
from dataclasses import dataclass

from fontalloy_core.errors import BuildError
from fontalloy_core.load import LoadedFace
from fontalloy_core.recipe import WeightRequest

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
    """One output weight/style: its base container and donor matches."""

    base: LoadedFace
    donors: tuple[DonorMatch, ...] = ()


def plan_matrix(
    bases: Sequence[LoadedFace],
    pools: Mapping[str, DonorPool],
    requests: Sequence[WeightRequest],
) -> tuple[MatrixSlot, ...]:
    """Plan the requested weight/style matrix over the loaded faces.

    ``bases`` are the base file's faces (as loaded — a pinned reference
    contributes one). ``requests`` is the recipe's ``weights`` section
    (empty means "every base face"). Each request must match a base
    face's ``(usWeightClass, italic)`` exactly — a weight the base has
    no face for is a clear :class:`~fontalloy_core.errors.BuildError`,
    never a nearest-match approximation (that would move the output's
    own identity, which only the base defines). Slots come out in base
    face order, so a collection's output order is its file's order
    whatever the recipe listed.
    """
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
