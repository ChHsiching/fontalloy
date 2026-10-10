"""The build entry point (seam 1).

``build(recipe_path, output_path, ...)`` is the single public entry point
of the core: recipe + font files in, built font + verification report out.
The CLI calls it in-process; later consumers (serve, the GUI sidecar) do
the same.

Pipeline stages in this ticket (issues #2 through #5, #10): load and
detect the base and donor fonts (TTC face selection, variable
instantiation, woff2 decode), resolve the precedence rules — layered
rules at every granularity, absence never overrides — into the effective
table, graft the donor glyphs into the base font per the effective table
with a rebuilt cmap (the base is the container, ADR-0001; normalization
and table rewriting arrive in later tickets), and emit the verification
report carrying the effective table and the conflict/fill accounting.

Output formats (issue #10): the recipe's ``output.format`` (or the
``output_format`` argument) selects the format tier. A ``ttc`` build
merges every selected face of the base font file — one output face per
base face, sharing the donors — and packages the faces with
shared-table dedup; ``woff2`` compresses the single merged face. Every
format saves through the one reproducible boundary
(:func:`fontalloy_core.output.save_output`): identical inputs produce
byte-identical outputs and reports, with no wall clock in the file.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from fontTools.ttLib import TTFont

from fontalloy_core.errors import BuildError
from fontalloy_core.graft import graft_effective_glyphs
from fontalloy_core.load import load_face, load_faces
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
from fontalloy_core.recipe import load_recipe
from fontalloy_core.report import (
    ConflictRecord,
    FaceRecord,
    ProvenanceEntry,
    RuleRecord,
    SourceRecord,
    VerificationReport,
    file_sha256,
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
    """Build a merged font from a recipe.

    ``output_path`` defaults to ``<recipe stem>.<format>`` beside the
    recipe; ``output_format`` (``ttf``, ``ttc``, or ``woff2``) overrides
    the recipe's ``output.format`` — the CLI switch rides this argument.

    Raises :class:`~fontalloy_core.errors.RecipeError` for an invalid
    recipe and :class:`~fontalloy_core.errors.BuildError` when the build
    fails on its font inputs or output paths.
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

    # The base faces to merge: a collection-output build takes every
    # selected face of the base font file (one output face per base
    # face); every other format resolves exactly one face, so a
    # collection base still has to name its face.
    if fmt == "ttc":
        bases = load_faces(recipe.base, role="base font")
    else:
        bases = [load_face(recipe.base, role="base font")]
    donors = [
        load_face(ref, role=f"donor font {index}")
        for index, ref in enumerate(recipe.donors)
    ]

    try:
        # The source record describes the base font file's own coverage
        # (its first face's, for a collection) — not the base-won share
        # of the merge, which the provenance already accounts for.
        base_coverage = _coverage(bases[0].font)
        donor_coverages = {
            f"donor-{index}": _coverage(donor.font)
            for index, donor in enumerate(donors)
        }
        timestamp = output_timestamp([base.font for base in bases])

        # Stage: resolve the precedence rules into the effective table —
        # per base face, since each face is the container of its own
        # output face and coverages may differ between faces. Named sets
        # come from the recipe, overriding any built-ins (the fc-lang
        # presets plug into BUILTIN_NAMED_SETS in a later ticket).
        named_sets = {**BUILTIN_NAMED_SETS, **recipe.named_sets}
        resolutions = [
            resolve_precedence(
                recipe.rules,
                coverages={"base": _coverage(base.font), **donor_coverages},
                named_sets=named_sets,
            )
            for base in bases
        ]

        # Stage: graft the donor glyphs into each base container and
        # rebuild the cmap (ADR-0001). The donors are shared across the
        # faces; grafting takes private glyph copies, so each face's
        # graft is independent. Normalization (upem scaling, advance
        # re-gridding) and table rewriting are later stages.
        donor_fonts = {
            f"donor-{index}": donor.font for index, donor in enumerate(donors)
        }
        for base, resolution in zip(bases, resolutions):
            graft_effective_glyphs(base.font, donor_fonts, resolution.effective_table)

        # Stage: write the output at the single reproducible boundary —
        # pinned head timestamps, no recalculation, TTC dedup on.
        save_output(
            [base.font for base in bases], output, fmt, timestamp=timestamp
        )
    finally:
        for base in bases:
            base.font.close()
        for donor in donors:
            donor.font.close()

    # Read the built font back: the report's in_output flags record what
    # the output cmap actually covers, not what the pipeline intended.
    output_cmaps = _read_back_cmaps(output, fmt, len(bases))
    per_face_provenance = [
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
                codepoints=len(base_coverage),
            )
        ]
    ) + tuple(
        SourceRecord(
            id=f"donor-{index}",
            role="donor",
            path=ref.path,
            sha256=file_sha256(ref.path),
            codepoints=len(donor_coverages[f"donor-{index}"]),
        )
        for index, ref in enumerate(recipe.donors)
    )
    report = VerificationReport(
        sources=sources,
        provenance=per_face_provenance[0],
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
                index=index,
                family=base.info.family,
                subfamily=base.info.subfamily,
                weight=base.info.weight,
                summary=_summary(provenance),
            )
            for index, (base, provenance) in enumerate(
                zip(bases, per_face_provenance)
            )
        )
        if fmt == "ttc"
        else (),
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
