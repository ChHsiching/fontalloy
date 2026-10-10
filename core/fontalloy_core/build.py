"""The build entry point (seam 1).

``build(recipe_path, output_path, ...)`` is the single public entry point
of the core: recipe + font files in, built font + verification report out.
The CLI calls it in-process; later consumers (serve, the GUI sidecar) do
the same.

Pipeline stage in this tracer bullet (issue #2): load and validate the
base and donor fonts, resolve the default precedence into the per-codepoint
provenance table, write the base font through as the output TTF (grafting,
normalization, and table rewriting arrive in later tickets), and emit the
verification report v0. Identical inputs produce byte-identical outputs
and reports.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from fontTools.ttLib import TTFont

from fontalloy_core.errors import BuildError
from fontalloy_core.load import LoadedFace, load_face
from fontalloy_core.recipe import load_recipe
from fontalloy_core.report import (
    ProvenanceEntry,
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


def build(
    recipe_path: Path | str,
    output_path: Path | str,
    *,
    report_path: Path | str | None = None,
) -> BuildOutput:
    """Build a merged font from a recipe.

    Raises :class:`~fontalloy_core.errors.RecipeError` for an invalid
    recipe and :class:`~fontalloy_core.errors.BuildError` when the build
    fails on its font inputs or output paths.
    """
    recipe = load_recipe(recipe_path)
    output = Path(output_path)

    base = load_face(recipe.base, role="base font")
    donors = [
        load_face(ref, role=f"donor font {index}")
        for index, ref in enumerate(recipe.donors)
    ]

    try:
        # Stage: resolve the default precedence — the base font first, then
        # donors in join order, absence never overrides — into the effective
        # per-codepoint provenance table.
        stack: list[tuple[str, str, Path, set[int]]] = [
            ("base", "base", recipe.base.path, _coverage(base.font))
        ]
        for index, ref in enumerate(recipe.donors):
            stack.append(
                (f"donor-{index}", "donor", ref.path, _coverage(donors[index].font))
            )
        base_coverage = stack[0][3]
        provenance = tuple(
            ProvenanceEntry(
                codepoint=codepoint,
                winner=next(
                    source_id
                    for source_id, _role, _path, covered in stack
                    if codepoint in covered
                ),
                # v0 writes the base font through: only base-won codepoints
                # are present in the output. Grafting flips the rest later.
                in_output=codepoint in base_coverage,
            )
            for codepoint in sorted(
                set().union(*(covered for _, _, _, covered in stack))
            )
        )

        # Stage: output the built font. The base is the container (ADR-0001);
        # at v0 it passes through unchanged.
        try:
            base.font.save(output)
        except OSError as exc:
            raise BuildError(
                f"cannot write the output font: {output} ({exc})"
            ) from None
    finally:
        base.font.close()
        for donor in donors:
            donor.font.close()

    sources = tuple(
        SourceRecord(
            id=source_id,
            role=role,
            path=path,
            sha256=file_sha256(path),
            codepoints=len(covered),
        )
        for source_id, role, path, covered in stack
    )
    report = VerificationReport(
        sources=sources,
        provenance=provenance,
        output_path=output,
        output_sha256=file_sha256(output),
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

    return BuildOutput(font_path=output, report_path=report_path, report=report)


def _coverage(font: TTFont) -> set[int]:
    return set(font.getBestCmap())
