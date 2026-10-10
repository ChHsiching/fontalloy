"""The build entry point (seam 1).

``build(recipe_path, output_path, ...)`` is the single public entry point
of the core: recipe + font files in, built font + verification report out.
The CLI calls it in-process; later consumers (serve, the GUI sidecar) do
the same.

Pipeline stages in this ticket (issues #2 and #3): load and validate the
base and donor fonts, resolve the precedence rules — layered rules at
every granularity, absence never overrides — into the effective table,
write the base font through as the output TTF (grafting, normalization,
and table rewriting arrive in later tickets), and emit the verification
report carrying the effective table and the conflict/fill accounting.
Identical inputs produce byte-identical outputs and reports.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from fontTools.ttLib import TTFont

from fontalloy_core.errors import BuildError
from fontalloy_core.precedence import (
    BUILTIN_NAMED_SETS,
    interval_label,
    resolve_precedence,
    rule_id,
)
from fontalloy_core.recipe import load_recipe
from fontalloy_core.report import (
    ConflictRecord,
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

    base = _load_font(recipe.base, "base font")
    donors = [
        _load_font(path, f"donor font {index}")
        for index, path in enumerate(recipe.donors)
    ]

    try:
        coverages = {"base": _coverage(base)}
        for index, font in enumerate(donors):
            coverages[f"donor-{index}"] = _coverage(font)

        # Stage: resolve the precedence rules into the effective table.
        # Named sets come from the recipe, overriding any built-ins (the
        # fc-lang presets plug into BUILTIN_NAMED_SETS in a later ticket).
        resolution = resolve_precedence(
            recipe.rules,
            coverages=coverages,
            named_sets={**BUILTIN_NAMED_SETS, **recipe.named_sets},
        )

        # Stage: output the built font. The base is the container (ADR-0001);
        # at this stage it passes through unchanged.
        try:
            base.save(output)
        except OSError as exc:
            raise BuildError(
                f"cannot write the output font: {output} ({exc})"
            ) from None
    finally:
        base.close()
        for donor in donors:
            donor.close()

    base_coverage = coverages["base"]
    provenance = tuple(
        ProvenanceEntry(
            codepoint=entry.codepoint,
            winner=entry.winner,
            # v0 writes the base font through: only codepoints the base
            # covers are present in the output. Grafting flips the rest.
            in_output=entry.codepoint in base_coverage,
            via=entry.via,
            kind=entry.kind,
        )
        for entry in resolution.effective_table
    )

    sources = tuple(
        [
            SourceRecord(
                id="base",
                role="base",
                path=recipe.base,
                sha256=file_sha256(recipe.base),
                codepoints=len(coverages["base"]),
            )
        ]
    ) + tuple(
        SourceRecord(
            id=f"donor-{index}",
            role="donor",
            path=path,
            sha256=file_sha256(path),
            codepoints=len(coverages[f"donor-{index}"]),
        )
        for index, path in enumerate(recipe.donors)
    )
    report = VerificationReport(
        sources=sources,
        provenance=provenance,
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
            for conflict in resolution.conflicts
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

    return BuildOutput(font_path=output, report_path=report_path, report=report)


def _load_font(path: Path, role: str) -> TTFont:
    """Load a font file and validate it has Unicode coverage."""
    if not path.is_file():
        raise BuildError(f"{role} file not found: {path}")
    try:
        font = TTFont(path)
        best_cmap = font.getBestCmap()
    except Exception as exc:  # fontTools raises TTLibError and friends
        raise BuildError(f"{role} file is not a valid font: {path} ({exc})") from None
    if not best_cmap:
        raise BuildError(f"{role} has no Unicode coverage (no usable cmap): {path}")
    return font


def _coverage(font: TTFont) -> set[int]:
    return set(font.getBestCmap())
