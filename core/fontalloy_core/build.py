"""The build entry point (seam 1).

``build(recipe_path, output_path, ...)`` is the single public entry point
of the core: recipe + font files in, built font + verification report out.
The CLI calls it in-process; serve (issue #11) does the same through
:func:`build_recipe`, which runs the identical pipeline over an
already-parsed recipe.

Pipeline stages in this ticket (issues #2 through #10): load and detect
the base and donor fonts (TTC face selection, variable instantiation,
woff2 decode), plan the weight/style matrix — one output slot per
requested weight/style, donors matched at the nearest OS/2
usWeightClass per slot with recipe overrides beating nearest-match
(issue #9) — resolve the precedence rules — layered rules at every
granularity, absence never overrides — into the effective table, plan
the normalization per slot (ADR-0003, issue #8: upem unified by
s0 = U/u, the auto school's scale k by default — the grid term capped
by the optical ratio — with the bare schools as the recipe's knobs,
UAX #11 advances), graft the donor glyphs into each slot's base
container per the effective table with a rebuilt cmap (the base is the
container, ADR-0001), each donor glyph normalized onto that base
face's metrics, rewrite each slot's output identity — the name record
set plus OS/2 corrections, around the recipe's ``output.family``
(issue #6) — and emit the verification report carrying the effective
table, the conflict/fill accounting, the weight borrow table, the
codepoint coverage (requested versus effective, gaps explicit), and
the before/after metric comparison with the untouched-line-height
proof (issue #12; schema ``fontalloy/verification-report@v2``) in a
machine-readable JSON plus a rendered human-readable HTML beside it.

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

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, NamedTuple

from fontTools.ttLib import TTFont

from fontalloy_core.assets import resolve_recipe_fonts
from fontalloy_core.errors import BuildCancelled, BuildError
from fontalloy_core.graft import graft_effective_glyphs
from fontalloy_core.load import LoadedFace, aggregate_families, load_faces
from fontalloy_core.matrix import DonorPool, MatrixSlot, plan_matrix
from fontalloy_core.normalize import (
    HAN_COMMON_FIRST,
    HAN_COMMON_LAST,
    NormalizationPlan,
    apply_quote_dash_policy,
    latin_advance,
    plan_normalization,
)
from fontalloy_core.output import (
    OUTPUT_FORMATS,
    output_timestamp,
    save_output,
)
from fontalloy_core.placeholder import face_coverage
from fontalloy_core.precedence import (
    BUILTIN_NAMED_SETS,
    Resolution,
    codepoint_label,
    interval_label,
    resolve_precedence,
    rule_id,
)
from fontalloy_core.recipe import FontRef, Recipe, load_recipe
from fontalloy_core.render import render_html
from fontalloy_core.report import (
    BorrowRecord,
    ConflictRecord,
    CoverageRecord,
    DonorNormalizationRecord,
    FaceRecord,
    MetricFaceRecord,
    ProvenanceEntry,
    RuleRecord,
    SourceRecord,
    VerificationReport,
    WeightSlotRecord,
    file_sha256,
)
from fontalloy_core.report import MISSING_CAP
from fontalloy_core.rewrite import (
    OutputNaming,
    apply_os2_corrections,
    apply_output_identity,
)


@dataclass(frozen=True)
class BuildOutput:
    """What one build produced, plus the report describing it.

    ``report_path`` is the machine-readable JSON; ``report_html_path``
    the rendered human form written beside it (issue #12). Both are
    byte-reproducible with the font.
    """

    font_path: Path
    report_path: Path
    report: VerificationReport
    format: str = "ttf"
    report_html_path: Path | None = None


def build(
    recipe_path: Path | str,
    output_path: Path | str | None = None,
    *,
    report_path: Path | str | None = None,
    output_format: str | None = None,
    manifest: Path | str | None = None,
    fonts_dir: Path | str | None = None,
    progress: Callable[[str, "dict[str, Any] | None"], None] | None = None,
    cancelled: Callable[[], bool] | None = None,
) -> BuildOutput:
    """Build a merged font (or weight/style matrix) from a recipe file.

    ``output_path`` defaults to ``<recipe stem>.<format>`` beside the
    recipe; ``output_format`` (``ttf``, ``ttc``, or ``woff2``) overrides
    the recipe's ``output.format`` — the CLI switch rides this argument.
    ``manifest`` resolves the recipe's catalog-family references
    against the fetched catalog (issue #23; default:
    ``assets/fonts.manifest.json`` in the working directory, with
    ``fonts_dir`` defaulting to the ``fonts`` directory beside it —
    exactly what ``fontalloy assets fetch`` fills). ``progress``
    (issue #11), when given, is called with a stage name as the
    pipeline enters each stage plus a ``facts`` mapping (round 13,
    owner item 5) of the quantitative facts the pipeline already
    knows at that point — file count/sizes at ``loading``, the
    planned slot count at ``planning``, the rule count at
    ``resolving`` (refreshed with the effective codepoint count once
    resolved), slots/codepoints at ``grafting``, the face count at
    ``rewriting``, format and an estimated size at ``saving``, and
    the check count at ``reporting``; serve carries both onto the
    build's status document. A stage without facts calls with
    ``None`` (clearing the previous stage's). ``cancelled`` (round
    19), when given, is the cooperative-cancel predicate: the pipeline
    consults it at every stage boundary, and the long per-codepoint
    loops (grafting, resolution) consult it every ~2000 codepoints,
    raising :class:`~fontalloy_core.errors.BuildCancelled` the moment
    it flips — a cancelled build writes no artifact and no report.

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
    if output_path is None:
        # The file-caller default: <recipe stem>.<format> beside the recipe.
        output_path = Path(recipe_path).with_suffix(f".{fmt}")
    return build_recipe(
        recipe,
        output_path,
        report_path=report_path,
        output_format=output_format,
        manifest=manifest,
        fonts_dir=fonts_dir,
        progress=progress,
        cancelled=cancelled,
    )


#: Where a catalog-referencing build looks for the manifest when the
#: caller names none — the CLI's default, and the repo-root layout.
DEFAULT_MANIFEST = Path("assets") / "fonts.manifest.json"


def build_recipe(
    recipe: Recipe,
    output_path: Path | str | None = None,
    *,
    report_path: Path | str | None = None,
    output_format: str | None = None,
    manifest: Path | str | None = None,
    fonts_dir: Path | str | None = None,
    progress: Callable[[str, "dict[str, Any] | None"], None] | None = None,
    cancelled: Callable[[], bool] | None = None,
) -> BuildOutput:
    """Build a merged font from an already-parsed recipe.

    The whole pipeline over a :class:`~fontalloy_core.recipe.Recipe`
    object — what :func:`build` runs after loading the recipe file, and
    what serve (issue #11) runs on a recipe submitted as JSON.
    ``output_path`` is required in practice for non-file callers and
    defaults to ``fontalloy.<format>`` in the working directory.
    Catalog-family references are resolved here, through the assets
    machinery, when the recipe carries any (``manifest`` names the
    catalog; see :func:`build`).
    """

    # Round 13 (owner item 5): the stage callback carries the facts the
    # pipeline already knows alongside the stage name — the live
    # quantitative readout the build panel shows beside the elapsed
    # time. ``_stage`` marks a stage ENTRY (a None ``facts`` clears the
    # previous stage's); ``_facts`` refreshes the CURRENT stage's
    # numbers in place (the stage block stays, the values move).
    #
    # Round 19: every stage boundary is also a cancellation point —
    # checked BEFORE the stage runs and again after the progress
    # callback returned (a consumer that arms the flag from inside
    # ``progress`` — serve's cancel endpoint, the tests — stops the
    # build at exactly that boundary). The long per-codepoint loops
    # (grafting, resolution) carry their own ~2000-codepoint cadence.
    stage_now: str | None = None

    def _check_cancelled() -> None:
        if cancelled is not None and cancelled():
            raise BuildCancelled()

    def _stage(name: str, facts: dict[str, Any] | None = None) -> None:
        nonlocal stage_now
        _check_cancelled()
        stage_now = name
        if progress is not None:
            progress(name, facts)
        _check_cancelled()

    def _facts(facts: dict[str, Any]) -> None:
        if progress is not None and stage_now is not None:
            progress(stage_now, facts)

    if recipe.base.is_catalog_ref or any(
        ref.is_catalog_ref for ref in recipe.donors
    ):
        recipe = _resolve_catalog(recipe, manifest, fonts_dir)

    fmt = output_format if output_format is not None else recipe.output.format
    if fmt not in OUTPUT_FORMATS:
        raise BuildError(
            f"unknown output format {fmt!r} "
            f"(the build accepts: {', '.join(OUTPUT_FORMATS)})"
        )
    output = (
        Path(output_path)
        if output_path is not None
        else Path(f"fontalloy.{fmt}")
    )

    # The base faces the matrix draws from: a pinned face contributes
    # one, an unpinned file all of them. The one-face rule for the
    # single-file formats moves to the slot-count check below, so a
    # weights selection of one slot can stand in for a face pin.
    _stage("loading", _source_facts(recipe))
    _verify_pinned_sources(recipe)
    bases = load_faces(recipe.base, role="base font")
    pools: dict[str, DonorPool] = {}
    loaded_donors: list[LoadedFace] = []
    for index, ref in enumerate(recipe.donors):
        faces = load_faces(ref, role=f"donor font {index}")
        loaded_donors.extend(faces)
        pools[f"donor-{index}"] = _donor_pool(f"donor-{index}", faces, ref, index)

    _stage("planning")
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
    _facts({"slots": len(slots)})

    try:
        timestamp = output_timestamp([slot.base.font for slot in slots])
        # The source records' coverage counts, read while the faces are
        # open: the base file's first face, and each donor file's union
        # across its faces. Coverage is the effective kind throughout
        # (round 18): glyph-0 and suspected-placeholder mappings never
        # count, and the placeholder counts ride the source records.
        base_face_coverage_ = face_coverage(bases[0].font)
        base_codepoints = len(base_face_coverage_.codepoints)
        base_placeholders = len(base_face_coverage_.placeholders)
        donor_codepoints = {
            donor_id: _pool_codepoints(pool) for donor_id, pool in pools.items()
        }
        donor_placeholders = {
            donor_id: _pool_placeholders(pool)
            for donor_id, pool in pools.items()
        }
        # Stage: resolve the precedence rules into the effective table —
        # per slot, since each slot's container is its own output face —
        # then apply the quote/dash width policy (ADR-0003's locale
        # option): under fullwidth the policy rewrites default-decided
        # base keeps in the quote/dash set to the first donor holding
        # the codepoint, so the donor's fullwidth glyph and the wide
        # advance actually reach the merged font.
        _stage("resolving", {"rules": len(recipe.rules)})
        named_sets = {**BUILTIN_NAMED_SETS, **recipe.named_sets}
        resolutions: list[Resolution] = []
        effective_union: set[int] = set()
        for slot in slots:
            # Each slot is its own merge: the slot's base container
            # resolved against the donor faces matched for that slot —
            # rule font ids (base, donor-<i>) are join indices, so a
            # rule's "donor-0" means "donor-0's face for this slot".
            coverages = {
                "base": _coverage(slot.base.font),
                **{
                    match.donor_id: _coverage(match.face.font)
                    for match in slot.donors
                },
            }
            effective_union.update(*coverages.values())
            resolutions.append(
                apply_quote_dash_policy(
                    resolve_precedence(
                        recipe.rules,
                        coverages=coverages,
                        named_sets=named_sets,
                        cancelled=cancelled,
                    ),
                    coverages,
                    recipe.normalization,
                )
            )
        # The effective count arrives once resolution is done: slot 0's
        # table — the same face the report's flat sections describe.
        _facts(
            {
                "rules": len(recipe.rules),
                "codepoints": len(resolutions[0].effective_table),
            }
        )

        # Stage: graft the donor glyphs into each slot's base container
        # and rebuild the cmap (ADR-0001), each glyph normalized onto
        # that slot's base face metrics (ADR-0003, issue #8: upem
        # unified by s0 = U/u, the auto school's scale k by default —
        # the grid term capped by the optical ratio — with the bare
        # schools as the recipe's knobs, UAX #11 advances, usWin grown
        # only to prevent clipping). A donor face may serve several
        # slots; grafting takes private glyph copies, so each slot's
        # graft and normalization plan are independent.
        #
        # The metric comparison (issue #12) snapshots each base face as
        # loaded — pre-graft, so "before" is what the pipeline actually
        # started from (a variable base's instance, not the file's
        # default) — and the plans' k/s0 per donor are kept for the
        # report's normalization records.
        _stage(
            "grafting",
            {
                "slots": len(slots),
                "codepoints": sum(
                    len(resolution.effective_table) for resolution in resolutions
                ),
            },
        )
        base_snapshots = [_face_snapshot(slot.base.font) for slot in slots]
        slot_normalization: list[tuple[DonorNormalizationRecord, ...]] = []
        for slot, resolution in zip(slots, resolutions):
            donor_fonts = {
                match.donor_id: match.face.font for match in slot.donors
            }
            plan = plan_normalization(
                slot.base.font, donor_fonts, recipe.normalization
            )
            slot_normalization.append(_normalization_records(plan, donor_fonts))
            graft_effective_glyphs(
                slot.base.font,
                donor_fonts,
                resolution.effective_table,
                plan,
                cancelled=cancelled,
            )
            # Stage: rewrite the output identity — the full name record
            # set (both platform encodings, nameID 16/17 consistent with
            # 1/2) and the OS/2 corrections (xAvgCharWidth, PANOSE mono)
            # — before the save, so the reproducible boundary writes the
            # rewritten font. Each slot's container carries its own
            # subfamily, so the slots become the output family's
            # weight/style variants.
            _stage("rewriting", {"faces": len(slots)})
            apply_output_identity(
                slot.base.font, OutputNaming(recipe.output.family)
            )
            apply_os2_corrections(slot.base.font)

        # Stage: write the output at the single reproducible boundary —
        # pinned head timestamps, no recalculation, TTC dedup on. The
        # size fact is an ESTIMATE from the source bytes (one grafted
        # copy per slot for a collection); the saved artifact's exact
        # size lands on the done document as always.
        _stage(
            "saving",
            {
                "format": fmt,
                "bytes_est": _estimated_output_bytes(recipe, fmt, len(slots)),
            },
        )
        save_output(
            [slot.base.font for slot in slots], output, fmt, timestamp=timestamp
        )
    finally:
        for base in bases:
            base.font.close()
        for donor in loaded_donors:
            donor.font.close()

    # Read the built font back: the report's in_output flags record what
    # the output cmap actually covers, not what the pipeline intended —
    # and the metric comparison measures the saved file, never the
    # in-memory container. The checks fact: every face is read back and
    # metric-compared, every rule's coverage is checked.
    _stage(
        "reporting", {"checks": 2 * len(slots) + len(recipe.rules)}
    )
    readback = _read_back(output, fmt, len(slots))
    try:
        output_cmaps = [set(font.getBestCmap()) for font in readback]
        output_snapshots = [_face_snapshot(font) for font in readback]
    finally:
        for font in readback:
            font.close()
    per_slot_provenance = [
        _provenance(resolution, output_cmap)
        for resolution, output_cmap in zip(resolutions, output_cmaps)
    ]

    sources = tuple(
        [
            _source_record(
                recipe.base,
                id="base",
                codepoints=base_codepoints,
                placeholders=base_placeholders,
            )
        ]
    ) + tuple(
        _source_record(
            ref,
            id=f"donor-{index}",
            codepoints=donor_codepoints[f"donor-{index}"],
            placeholders=donor_placeholders[f"donor-{index}"],
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
                        family=match.face.info.family,
                        via=match.via,
                        style_fallback=match.style_fallback,
                    )
                    for match in slot.donors
                ),
            )
            for index, slot in enumerate(slots)
        ),
        coverage_rules=_coverage_records(
            recipe.rules,
            named_sets,
            # Round 18: the rule check judges the HONEST readback — a
            # placeholder mapping that survived into the output bytes
            # (a no-graft pass-through keeps the base file's own cmap)
            # still counts as missing, exactly like every other stage
            # treats it.
            output_cmaps[0] & effective_union,
        ),
        metrics=tuple(
            _metric_face_record(
                index, slot, before, after, normalization
            )
            for index, (slot, before, after, normalization) in enumerate(
                zip(slots, base_snapshots, output_snapshots, slot_normalization)
            )
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

    # The human-readable form, rendered beside the machine form (issue
    # #12): the same deterministic content as the JSON.
    report_html_path = report_path.with_suffix(".html")
    try:
        report_html_path.write_text(render_html(report), encoding="utf-8")
    except OSError as exc:
        raise BuildError(
            f"cannot write the rendered verification report: "
            f"{report_html_path} ({exc})"
        ) from None

    return BuildOutput(
        font_path=output,
        report_path=report_path,
        report=report,
        format=fmt,
        report_html_path=report_html_path,
    )


def _source_files(recipe: Recipe) -> list[Path]:
    """The distinct font files the recipe's references build from.

    A catalog reference counts its resolved artifact (the zip or the
    bare font file); a path reference the file itself. Duplicates (a
    base and a donor naming one file) count once.
    """
    files: dict[str, Path] = {}
    for ref in [recipe.base, *recipe.donors]:
        path = ref.artifact if ref.artifact is not None else ref.path
        if path is not None:
            files.setdefault(str(path), Path(path))
    return list(files.values())


def _source_facts(recipe: Recipe) -> dict[str, Any]:
    """The loading stage's facts: the file count and their total size.

    A file that cannot be stat'd contributes zero — the load itself
    fails on its own terms with the readable error.
    """
    files = _source_files(recipe)
    total = 0
    for path in files:
        try:
            total += path.stat().st_size
        except OSError:
            continue
    return {"files": len(files), "bytes": total}


def _estimated_output_bytes(
    recipe: Recipe, fmt: str, slots: int
) -> int:
    """The saving stage's rough size estimate from the source bytes.

    One grafted copy per slot for a collection, the plain source total
    otherwise — a scale reference while the write runs, never a promise
    (the exact size lands on the done document).
    """
    total = _source_facts(recipe)["bytes"]
    return total * (slots if fmt == "ttc" else 1)


def _resolve_catalog(
    recipe: Recipe,
    manifest: Path | str | None,
    fonts_dir: Path | str | None,
) -> Recipe:
    """Resolve catalog references, with a readable no-manifest error."""
    from fontalloy_core.errors import CatalogError

    manifest_path = Path(manifest) if manifest is not None else DEFAULT_MANIFEST
    if manifest is None and not manifest_path.is_file():
        raise BuildError(
            "the recipe references catalog families but no manifest was "
            f"found at {manifest_path} — pass a manifest (the CLI's "
            "--manifest) or run from the repository root"
        )
    try:
        return resolve_recipe_fonts(recipe, manifest_path, fonts_dir)
    except CatalogError as exc:
        raise BuildError(
            f"cannot resolve the recipe's catalog references: {exc}"
        ) from None


def _verify_pinned_sources(recipe: Recipe) -> None:
    """Verify the path references' ``sha256`` pins before any load.

    A path-form reference may pin its file (spec story 39); a pinned
    recipe builds from exact bytes the way a catalog-referencing recipe
    builds from the manifest's pin — a drifted file is a clear error
    naming the reference and both hashes, a missing pinned file
    likewise. Unpinned references verify nothing here; the report
    still records every source's hash either way.
    """
    pinned = [("base", recipe.base)] + [
        (f"donor-{index}", ref) for index, ref in enumerate(recipe.donors)
    ]
    for label, ref in pinned:
        if ref.sha256 is None:
            continue
        if not ref.path.is_file():
            raise BuildError(
                f"{label} file not found: {ref.path} "
                f"(the reference pins sha256 {ref.sha256})"
            )
        actual = file_sha256(ref.path)
        if actual != ref.sha256:
            raise BuildError(
                f"{label} ({ref.path}): sha256 mismatch — the recipe pins "
                f"{ref.sha256}, the file hashes {actual}"
            )


def _source_record(
    ref: FontRef, *, id: str, codepoints: int, placeholders: int = 0
) -> SourceRecord:
    """One source record: the file (or pinned artifact) a reference built from.

    A path reference records the font file; a catalog reference records
    the manifest-pinned artifact it resolved through (the zip or the
    bare font file) — the build's provenance is the pin itself, so the
    report's source hashes verify a build against the manifest.
    ``placeholders`` counts the codepoints the placeholder heuristic
    suspected (round 18); they are already excluded from ``codepoints``.
    """
    path = ref.artifact if ref.artifact is not None else ref.path
    assert path is not None  # a resolved reference always carries one
    return SourceRecord(
        id=id,
        role="base" if id == "base" else "donor",
        path=path,
        sha256=file_sha256(path),
        codepoints=codepoints,
        placeholder_codepoints=placeholders,
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
        source = ref.family if ref.family is not None else str(ref.path)
        raise BuildError(
            f"donor font {index} carries multiple families "
            f"({', '.join(family.name for family in families)}); narrow its "
            f"pattern or pin a face: {source}"
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


def _pool_placeholders(pool: DonorPool) -> int:
    """A donor pool's suspected-placeholder codepoints, unioned over
    its faces (the mirror of :func:`_pool_codepoints`)."""
    union: set[int] = set()
    for face in pool.faces:
        union |= face_coverage(face.font).placeholders
    return len(union)


def _read_back(output: Path, fmt: str, face_count: int) -> list[TTFont]:
    """The built font's own faces, opened for the honest readback.

    A woff2 output decodes on load like any other flavor; the report
    always measures what is on disk.
    """
    if fmt == "ttc":
        return [TTFont(output, fontNumber=index) for index in range(face_count)]
    return [TTFont(output)]


class _FaceSnapshot(NamedTuple):
    """One face's verification metrics (the before/after comparison's
    two sides share this shape)."""

    upem: int
    latin_advance: int
    cjk_advance: int | None
    hhea_ascent: int
    hhea_descent: int
    hhea_line_gap: int
    typo_ascender: int | None
    typo_descender: int | None
    typo_line_gap: int | None
    win_ascent: int | None
    win_descent: int | None


def _face_snapshot(font: TTFont) -> _FaceSnapshot:
    """Measure one face: upem, the representative advances, and the
    vertical metrics the report compares (issue #12)."""
    hhea = font["hhea"]
    os2 = font.get("OS/2")
    return _FaceSnapshot(
        upem=font["head"].unitsPerEm,
        latin_advance=latin_advance(font),
        cjk_advance=_cjk_advance(font),
        hhea_ascent=hhea.ascent,
        hhea_descent=hhea.descent,
        hhea_line_gap=hhea.lineGap,
        typo_ascender=getattr(os2, "sTypoAscender", None),
        typo_descender=getattr(os2, "sTypoDescender", None),
        typo_line_gap=getattr(os2, "sTypoLineGap", None),
        win_ascent=getattr(os2, "usWinAscent", None),
        win_descent=getattr(os2, "usWinDescent", None),
    )


def _cjk_advance(font: TTFont) -> int | None:
    """The representative CJK advance: the modal advance over the
    font's coverage of the common Han block (None without Han there —
    a Latin base has no CJK advance to compare)."""
    cmap = font.getBestCmap()
    counts: dict[int, int] = {}
    for codepoint in range(HAN_COMMON_FIRST, HAN_COMMON_LAST + 1):
        name = cmap.get(codepoint)
        if name is not None:
            advance = font["hmtx"][name][0]
            counts[advance] = counts.get(advance, 0) + 1
    if not counts:
        return None
    return max(counts.items(), key=lambda item: (item[1], -item[0]))[0]


def _normalization_records(
    plan: NormalizationPlan, donor_fonts: dict[str, TTFont]
) -> tuple[DonorNormalizationRecord, ...]:
    """The k and s0 actually applied per donor, in join order."""
    return tuple(
        DonorNormalizationRecord(
            donor=donor_id,
            upem=donor_fonts[donor_id]["head"].unitsPerEm,
            s0=scale.upem_scale,
            han_ink_height=scale.han_ink_height,
            k=scale.k,
            scale=scale.scale,
        )
        for donor_id, scale in plan.donor_scales.items()
    )


def _metric_face_record(
    index: int,
    slot: MatrixSlot,
    before: _FaceSnapshot,
    after: _FaceSnapshot,
    normalization: tuple[DonorNormalizationRecord, ...],
) -> MetricFaceRecord:
    """One output face's before/after record, with the untouched proof.

    The proof is field-level equality of hhea (ascent, descent,
    lineGap) and OS/2 typo (ascender, descender, lineGap) against the
    base face — usWin is excluded by design: it may grow to prevent
    clipping (ADR-0003), and its growth shows in the paired values.
    """
    return MetricFaceRecord(
        slot=index,
        base_face=slot.base.info.face_index,
        weight=slot.base.info.weight,
        italic=slot.base.info.italic,
        upem=(before.upem, after.upem),
        latin_advance=(before.latin_advance, after.latin_advance),
        cjk_advance=(before.cjk_advance, after.cjk_advance),
        hhea_ascent=(before.hhea_ascent, after.hhea_ascent),
        hhea_descent=(before.hhea_descent, after.hhea_descent),
        hhea_line_gap=(before.hhea_line_gap, after.hhea_line_gap),
        typo_ascender=(before.typo_ascender, after.typo_ascender),
        typo_descender=(before.typo_descender, after.typo_descender),
        typo_line_gap=(before.typo_line_gap, after.typo_line_gap),
        win_ascent=(before.win_ascent, after.win_ascent),
        win_descent=(before.win_descent, after.win_descent),
        normalization=normalization,
        hhea_untouched=(
            before.hhea_ascent,
            before.hhea_descent,
            before.hhea_line_gap,
        )
        == (after.hhea_ascent, after.hhea_descent, after.hhea_line_gap),
        typo_untouched=(
            before.typo_ascender,
            before.typo_descender,
            before.typo_line_gap,
        )
        == (after.typo_ascender, after.typo_descender, after.typo_line_gap),
    )


def _coverage_records(
    rules: tuple, named_sets: dict, output_cmap: set[int]
) -> tuple[CoverageRecord, ...]:
    """Every rule's declared target versus the effective result.

    A gap is a requested codepoint the built font's cmap does not cover
    (no font in the build holds it — absence never overrides, so
    nothing could fill it). Gap lists are bounded to ``MISSING_CAP``
    labels with exact totals; the section describes face 0, like the
    flat provenance.
    """
    records: list[CoverageRecord] = []
    for index, rule in enumerate(rules):
        intervals = rule.declared_intervals(named_sets)
        requested = sum(end - start + 1 for start, end in intervals)
        missing = [
            codepoint
            for start, end in intervals
            for codepoint in range(start, end + 1)
            if codepoint not in output_cmap
        ]
        listed = missing[:MISSING_CAP]
        records.append(
            CoverageRecord(
                rule=rule_id(index),
                granularity=rule.granularity,
                target=rule.target_label(),
                requested=requested,
                covered=requested - len(missing),
                missing=tuple(codepoint_label(value) for value in listed),
                missing_total=len(missing),
                missing_truncated=len(missing) > len(listed),
            )
        )
    return tuple(records)


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
    """A face's effective coverage (round 18): the cmap with glyph-0
    and suspected-placeholder mappings dropped — placeholder codepoints
    never resolve, never fill, never graft."""
    return set(face_coverage(font).codepoints)
