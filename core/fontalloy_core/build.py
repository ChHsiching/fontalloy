"""The build entry point (seam 1).

``build(recipe_path, output_path, ...)`` is the single public entry point
of the core: recipe + font files in, built font + verification report out.
The CLI calls it in-process; later consumers (serve, the GUI sidecar) do
the same.

Pipeline stages so far (issues #2 through #8): load and detect the base
and donor fonts (TTC face selection, variable instantiation, woff2
decode), resolve the precedence rules — layered rules at every
granularity, absence never overrides — into the effective table, plan
the normalization (ADR-0003: upem unified by s0 = U/u, the grid school
scale k with the optical ratio as the knob, UAX #11 advances), graft the
donor glyphs into the base font per the effective table with a rebuilt
cmap (the base is the container, ADR-0001), and emit the verification
report carrying the effective table and the conflict/fill accounting.
Table rewriting (name records, OS/2 identity fields) arrives in a later
ticket. Identical inputs produce byte-identical outputs and reports.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from fontTools.ttLib import TTFont

from fontalloy_core.errors import BuildError
from fontalloy_core.graft import graft_effective_glyphs
from fontalloy_core.load import load_face
from fontalloy_core.normalize import plan_normalization
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

    base = load_face(recipe.base, role="base font")
    donors = [
        load_face(ref, role=f"donor font {index}")
        for index, ref in enumerate(recipe.donors)
    ]

    try:
        coverages = {"base": _coverage(base.font)}
        for index, donor in enumerate(donors):
            coverages[f"donor-{index}"] = _coverage(donor.font)

        # Stage: resolve the precedence rules into the effective table.
        # Named sets come from the recipe, overriding any built-ins (the
        # fc-lang presets plug into BUILTIN_NAMED_SETS in a later ticket).
        resolution = resolve_precedence(
            recipe.rules,
            coverages=coverages,
            named_sets={**BUILTIN_NAMED_SETS, **recipe.named_sets},
        )

        # Stage: plan the normalization (ADR-0003) — the grid school by
        # default, the optical ratio as the recipe's knob, UAX #11
        # advances. The base font is only read here.
        donor_fonts = {
            f"donor-{index}": face.font for index, face in enumerate(donors)
        }
        plan = plan_normalization(
            base.font, donor_fonts, recipe.normalization
        )

        # Stage: graft the donor glyphs into the base container and
        # rebuild the cmap (ADR-0001), each glyph normalized onto the
        # base's metrics per the plan. Table rewriting is a later stage.
        try:
            graft_effective_glyphs(
                base.font,
                donor_fonts,
                resolution.effective_table,
                plan,
            )
            base.font.save(output)
        except OSError as exc:
            raise BuildError(
                f"cannot write the output font: {output} ({exc})"
            ) from None
    finally:
        base.font.close()
        for donor in donors:
            donor.font.close()

    # Read the built font back: the report's in_output flags record what
    # the output cmap actually covers, not what the pipeline intended.
    output_cmap = set(TTFont(output).getBestCmap())
    provenance = tuple(
        ProvenanceEntry(
            codepoint=entry.codepoint,
            winner=entry.winner,
            in_output=entry.codepoint in output_cmap,
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
                path=recipe.base.path,
                sha256=file_sha256(recipe.base.path),
                codepoints=len(coverages["base"]),
            )
        ]
    ) + tuple(
        SourceRecord(
            id=f"donor-{index}",
            role="donor",
            path=ref.path,
            sha256=file_sha256(ref.path),
            codepoints=len(coverages[f"donor-{index}"]),
        )
        for index, ref in enumerate(recipe.donors)
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


def _coverage(font: TTFont) -> set[int]:
    return set(font.getBestCmap())
