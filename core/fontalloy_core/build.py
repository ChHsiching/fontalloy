"""The build entry point (seam 1).

``build(recipe_path, output_path, ...)`` is the single public entry point
of the core: recipe + font files in, built font + verification report out.
The CLI calls it in-process; later consumers (serve, the GUI sidecar) do
the same.

Pipeline stages in this ticket (issues #2 through #6, #9, #10): load and
detect the base and donor fonts (TTC face selection, variable
instantiation, woff2 decode), plan the weight/style matrix — one output
slot per requested weight/style, donors matched at the nearest OS/2
usWeightClass per slot with recipe overrides beating nearest-match
(issue #9) — resolve the precedence rules — layered rules at every
granularity, absence never overrides — into the effective table, graft
the donor glyphs into each slot's base container per the effective table
with a rebuilt cmap (the base is the container, ADR-0001), rewrite each
slot's output identity — the name record set plus OS/2 corrections,
around the recipe's ``output.family`` (issue #6; normalization arrives
in a later ticket) — and emit the verification report carrying the
effective table, the conflict/fill accounting, and the weight borrow
table.

Output formats (issue #10), reconciled with the matrix (issue #9): the
recipe's ``output.format`` (or the ``output_format`` argument) selects
the format tier. The requested matrix defaults to every face of the base
font file (a pinned face narrows it to one; a recipe ``weights``
section selects a subset). A ``ttc`` build packages one merged face per
slot with shared-table dedup — for an unpinned collection base this is
exactly issue #10's "every base face" rule, now explained as the default
matrix. ``ttf`` and ``woff2`` carry a single slot, so a multi-slot
matrix with those formats is a clear error pointing at ``ttc`` (the
rejected multi-file alternative is recorded in ADR-0006). Every format
saves through the one reproducible boundary
(:func:`fontalloy_core.output.save_output`): identical inputs produce
byte-identical outputs and reports, with no wall clock in the file.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from fontTools.ttLib import TTFont

from fontalloy_core.errors import BuildError
from fontalloy_core.graft import graft_effective_glyphs
from fontalloy_core.load import LoadedFace, aggregate_families, load_faces
from fontalloy_core.matrix import DonorPool, plan_matrix
from fontalloy_core.output import (
    OUTPUT_FORMATS,
    output_timestamp,
    save_output,
)
from fontalloy_core.precedence import (
    BUILTIN_NAMED_SETS,
    Resolution,
    interval_label,
    resolve_precedence,
    rule_id,
)
from fontalloy_core.recipe import FontRef, load_recipe
from fontalloy_core.report import (
    BorrowRecord,
    ConflictRecord,
    FaceRecord,
    ProvenanceEntry,
    RuleRecord,
    SourceRecord,
    VerificationReport,
    WeightSlotRecord,
    file_sha256,
)
from fontalloy_core.rewrite import (
    OutputNaming,
    apply_os2_corrections,
    apply_output_identity,
)
from fontalloy_core.rewrite import (
    OutputNaming,
    apply_os2_corrections,
    apply_output_identity,
)


@dataclass(frozen=True)
class BuildOutput:
    """What one build produced, plus the report describing it."""

    font_path: Path
    report_path: Path
    report: VerificationReport
    format: str = "ttf"


def build(
    recipe_path: Path | str,
    output_path: Path | str | None = None,
    *,
    report_path: Path | str | None = None,
    output_format: str | None = None,
) -> BuildOutput:
    """Build a merged font (or weight/style matrix) from a recipe.

    ``output_path`` defaults to ``<recipe stem>.<format>`` beside the
    recipe; ``output_format`` (``ttf``, ``ttc``, or ``woff2``) overrides
    the recipe's ``output.format`` — the CLI switch rides this argument.

    The requested matrix comes from the base font file's faces (a
    recipe ``weights`` section selects a subset); every donor family
    matches its nearest-weight face per slot, and the report states
    every borrow. Raises :class:`~fontalloy_core.errors.RecipeError`
    for an invalid recipe and
    :class:`~fontalloy_core.errors.BuildError` when the build fails on
    its font inputs or output paths.
    """
    recipe = load_recipe(recipe_path)
    fmt = output_format if output_format is not None else recipe.output.format
    if fmt not in OUTPUT_FORMATS:
        raise BuildError(
            f"unknown output format {fmt!r} "
            f"(the build accepts: {', '.join(OUTPUT_FORMATS)})"
        )
    output = (
        Path(output_path)
        if output_path is not None
        else Path(recipe_path).with_suffix(f".{fmt}")
    )

    # The base faces the matrix draws from: a pinned face contributes
    # one, an unpinned file all of them. The one-face rule for the
    # single-file formats moves to the slot-count check below, so a
    # weights selection of one slot can stand in for a face pin.
    bases = load_faces(recipe.base, role="base font")
    pools: dict[str, DonorPool] = {}
    loaded_donors: list[LoadedFace] = []
    for index, ref in enumerate(recipe.donors):
        faces = load_faces(ref, role=f"donor font {index}")
        loaded_donors.extend(faces)
        pools[f"donor-{index}"] = _donor_pool(f"donor-{index}", faces, ref, index)

    slots = plan_matrix(bases, pools, recipe.weights)
    if fmt != "ttc" and len(slots) > 1:
        if recipe.weights:
            raise BuildError(
                f"the weights selection requests {len(slots)} slots, but the "
                f"{fmt!r} output carries exactly one face — select a single "
                "slot or use output.format ttc"
            )
        raise BuildError(
            f"base font file is a collection with {len(bases)} faces; the "
            f"{fmt!r} output carries one face — select a face reference, "
            "declare a single weights slot, or use output.format ttc"
        )

    try:
        timestamp = output_timestamp([slot.base.font for slot in slots])
        # The source records' coverage counts, read while the faces are
        # open: the base file's first face, and each donor file's union
        # across its faces.
        base_codepoints = len(_coverage(bases[0].font))
        donor_codepoints = {
            donor_id: _pool_codepoints(pool)
            for donor_id, pool in pools.items()
        }
        named_sets = {**BUILTIN_NAMED_SETS, **recipe.named_sets}
        resolutions: list[Resolution] = []
        for slot in slots:
            # Each slot is its own merge: the slot's base container
            # resolved against the donor faces matched for that slot —
            # rule font ids (base, donor-<i>) are join indices, so a
            # rule's "donor-0" means "donor-0's face for this slot".
            resolutions.append(
                resolve_precedence(
                    recipe.rules,
                    coverages={
                        "base": _coverage(slot.base.font),
                        **{
                            match.donor_id: _coverage(match.face.font)
                            for match in slot.donors
                        },
                    },
                    named_sets=named_sets,
                )
            )

        # Stage: graft the donor glyphs into each slot's base container
        # and rebuild the cmap (ADR-0001). A donor face may serve
        # several slots; grafting takes private glyph copies, so each
        # slot's graft is independent. Normalization (upem scaling,
        # advance re-gridding) is a later stage.
        for slot, resolution in zip(slots, resolutions):
            graft_effective_glyphs(
                slot.base.font,
                {match.donor_id: match.face.font for match in slot.donors},
                resolution.effective_table,
            )
            # Stage: rewrite the output identity — the full name record
            # set (both platform encodings, nameID 16/17 consistent with
            # 1/2) and the OS/2 corrections (xAvgCharWidth, PANOSE mono)
            # — before the save, so the reproducible boundary writes the
            # rewritten font. Each slot's container carries its own
            # subfamily, so the slots become the output family's
            # weight/style variants.
            apply_output_identity(
                slot.base.font, OutputNaming(recipe.output.family)
            )
            apply_os2_corrections(slot.base.font)

        # Stage: write the output at the single reproducible boundary —
        # pinned head timestamps, no recalculation, TTC dedup on.
        save_output(
            [slot.base.font for slot in slots], output, fmt, timestamp=timestamp
        )
    finally:
        for base in bases:
            base.font.close()
        for donor in loaded_donors:
            donor.font.close()

    # Read the built font back: the report's in_output flags record what
    # the output cmap actually covers, not what the pipeline intended.
    output_cmaps = _read_back_cmaps(output, fmt, len(slots))
    per_slot_provenance = [
        _provenance(resolution, output_cmap)
        for resolution, output_cmap in zip(resolutions, output_cmaps)
    ]

    sources = tuple(
        [
            SourceRecord(
                id="base",
                role="base",
                path=recipe.base.path,
                sha256=file_sha256(recipe.base.path),
                # The base font file's own coverage (its first face's,
                # for a collection) — not the base-won share of the
                # merge, which the provenance already accounts for.
                codepoints=base_codepoints,
            )
        ]
    ) + tuple(
        SourceRecord(
            id=f"donor-{index}",
            role="donor",
            path=ref.path,
            sha256=file_sha256(ref.path),
            codepoints=donor_codepoints[f"donor-{index}"],
        )
        for index, ref in enumerate(recipe.donors)
    )
    report = VerificationReport(
        sources=sources,
        provenance=per_slot_provenance[0],
        output_path=output,
        output_sha256=file_sha256(output),
        rules=tuple(
            RuleRecord(
                id=rule_id(index),
                granularity=rule.granularity,
                target=rule.target_label(),
                fonts=rule.fonts,
            )
            for index, rule in enumerate(recipe.rules)
        ),
        conflicts=tuple(
            ConflictRecord(
                granularity=conflict.granularity,
                shadowed=conflict.shadowed,
                winner=conflict.winner,
                overlap=tuple(interval_label(span) for span in conflict.overlap),
                codepoints=conflict.codepoints,
            )
            for conflict in resolutions[0].conflicts
        ),
        format=fmt,
        faces=tuple(
            FaceRecord(
                # The face record's documented meaning: the base file's
                # face index the output face was merged in.
                index=slot.base.info.face_index,
                family=slot.base.info.family,
                subfamily=slot.base.info.subfamily,
                weight=slot.base.info.weight,
                summary=_summary(provenance),
            )
            for slot, provenance in zip(slots, per_slot_provenance)
        )
        if fmt == "ttc"
        else (),
        weights=tuple(
            WeightSlotRecord(
                index=index,
                weight=slot.base.info.weight,
                italic=slot.base.info.italic,
                base_face=slot.base.info.face_index,
                borrows=tuple(
                    BorrowRecord(
                        donor=match.donor_id,
                        face=match.face.info.face_index,
                        weight=match.face.info.weight,
                        italic=match.face.info.italic,
                        via=match.via,
                        style_fallback=match.style_fallback,
                    )
                    for match in slot.donors
                ),
            )
            for index, slot in enumerate(slots)
        ),
    )

    if report_path is None:
        report_path = output.with_name(f"{output.stem}.report.json")
    report_path = Path(report_path)
    try:
        report.write(report_path)
    except OSError as exc:
        raise BuildError(
            f"cannot write the verification report: {report_path} ({exc})"
        ) from None

    return BuildOutput(
        font_path=output, report_path=report_path, report=report, format=fmt
    )


def _donor_pool(
    donor_id: str, faces: list[LoadedFace], ref: FontRef, index: int
) -> DonorPool:
    """Aggregate one donor's faces by family into its matching pool.

    Faces aggregate by family (the load stage's grouping); a donor file
    carrying more than one family would make "the donor's nearest
    face" ambiguous, so it is a clear error naming the families. The
    pool keeps the family's deterministic face order.
    """
    families = aggregate_families([face.info for face in faces])
    if len(families) > 1:
        raise BuildError(
            f"donor font {index} file carries multiple families "
            f"({', '.join(family.name for family in families)}); pin one "
            f"face or split the file: {ref.path}"
        )
    by_identity = {
        (face.info.path, face.info.face_index): face for face in faces
    }
    return DonorPool(
        donor_id=donor_id,
        faces=tuple(
            by_identity[(face.path, face.face_index)]
            for face in families[0].faces
        ),
        pinned=ref.face is not None,
    )


def _pool_codepoints(pool: DonorPool) -> int:
    """A donor pool's own Unicode coverage: the union of its faces'."""
    union: set[int] = set()
    for face in pool.faces:
        union |= _coverage(face.font)
    return len(union)


def _read_back_cmaps(output: Path, fmt: str, face_count: int) -> list[set[int]]:
    """The built font's own cmaps, one per output face."""
    if fmt == "ttc":
        return [
            set(TTFont(output, fontNumber=index).getBestCmap())
            for index in range(face_count)
        ]
    return [set(TTFont(output).getBestCmap())]


def _provenance(
    resolution: Resolution, output_cmap: set[int]
) -> tuple[ProvenanceEntry, ...]:
    return tuple(
        ProvenanceEntry(
            codepoint=entry.codepoint,
            winner=entry.winner,
            in_output=entry.codepoint in output_cmap,
            via=entry.via,
            kind=entry.kind,
        )
        for entry in resolution.effective_table
    )


def _summary(provenance: tuple[ProvenanceEntry, ...]) -> dict[str, int]:
    from_base = sum(1 for entry in provenance if entry.winner == "base")
    return {
        "codepoints_total": len(provenance),
        "from_base": from_base,
        "from_donors": len(provenance) - from_base,
        "output_codepoints": sum(1 for entry in provenance if entry.in_output),
    }


def _coverage(font: TTFont) -> set[int]:
    return set(font.getBestCmap())
