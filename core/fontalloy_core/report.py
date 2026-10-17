"""The verification report.

Every build emits one (issue #2, and the spec's "every build ships a
verification report"). The report records the build's sources and the
effective table — for each codepoint in the union of all source
coverages, which font wins it (``winner``), through which precedence
(``via``: the global default, a declared rule, or the fullwidth
quote/dash policy), and how the glyph got there (``kind``: base keep,
fill, or override).

v1 grew through the pipeline tickets: grafting made ``in_output`` an
honest readback from the built font's cmap (issue #5); output formats
added ``format`` and per-face records for collections (issue #10); the
weight/style matrix added the ``weights`` section (issue #9).

v2 (issue #12) is the report in final form — the trust artifact every
build ships, machine-readable plus human-readable:

- ``coverage``: per rule, the requested target (preset, range, or
  codepoint) versus the effective result, with the missing codepoints
  listed explicitly — bounded to :data:`MISSING_CAP` labels with exact
  totals (``missing_total``, ``missing_truncated``) — plus an overall
  record over the union of all source coverages. Like the flat
  ``provenance``, the coverage section describes face 0 of a collection.
- ``metrics``: before/after per output face — upem, the representative
  Latin advance A and CJK advance (and their grid ratio), the
  hhea/typo/usWin ascents and descents, the k and s0 actually applied
  per donor, and the untouched proof: field-level equality of hhea and
  OS/2 typo against the base face, the contract that line height fully
  inherits the base font.
- ``weights`` borrows gained ``family`` (the donor family name), making
  the borrow table self-contained for frontends.
- Round 18 made source coverage honest: a codepoint mapped to a
  suspected placeholder glyph (or to glyph 0) never counts, and each
  source record states how many it carried
  (``placeholder_codepoints``).

The human-readable forms (:mod:`fontalloy_core.render`) are pure
functions of this object, so they stay byte-reproducible with it. The
JSON carries no timestamps or nondeterministic ordering, so identical
inputs yield byte-identical reports — and the source hashes below are
what make "identical inputs" checkable in the first place.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from fontalloy_core.precedence import codepoint_label

#: Schema identifier, bumped when the report shape changes meaningfully.
SCHEMA = "fontalloy/verification-report@v2"

#: How many missing codepoints a coverage record lists explicitly; the
#: totals stay exact, the list is a bounded preview (never a
#: twenty-thousand-line dump of a preset's gaps).
MISSING_CAP = 256


@dataclass(frozen=True)
class SourceRecord:
    """One font that took part in the build.

    ``codepoints`` is the effective coverage (round 18): the font's own
    cmap minus glyph-0 mappings minus suspected placeholder mappings —
    ``placeholder_codepoints`` counts the latter, so a source that fakes
    a block with one box glyph reports it instead of hiding it inside
    the coverage number.
    """

    id: str  # "base" or "donor-<index>", stable across the report
    role: str  # "base" | "donor"
    path: Path
    sha256: str
    codepoints: int  # size of this font's own Unicode coverage
    placeholder_codepoints: int = 0  # suspected placeholder mappings


@dataclass(frozen=True)
class ProvenanceEntry:
    """Which font supplies a codepoint in the effective merged result."""

    codepoint: int
    winner: str  # a SourceRecord id
    in_output: bool  # present in the built font (read back from its cmap)
    via: str  # "default", "policy", or a rule id ("rule-<declaration index>")
    kind: str  # "base" | "fill" | "override"


@dataclass(frozen=True)
class RuleRecord:
    """One precedence rule declaration, as the recipe made it."""

    id: str  # "rule-<declaration index>"
    granularity: str  # "codepoint" | "range" | "set"
    target: str  # recipe syntax: "0x4E2D", "0x2100-0x214F", or a set name
    fonts: tuple[str, ...]  # the ordered font list, as declared


@dataclass(frozen=True)
class ConflictRecord:
    """A same-layer overlap: the later rule shadows the earlier one."""

    granularity: str
    shadowed: str  # rule id of the earlier declaration
    winner: str  # rule id of the later declaration
    overlap: tuple[str, ...]  # recipe-syntax intervals of the overlap
    codepoints: int  # size of the overlap


@dataclass(frozen=True)
class FaceRecord:
    """One output face of a collection build (issue #10).

    Identity comes from the base face the output face was merged in
    (``index`` is its face index in the base font file); ``summary`` is
    that face's own provenance accounting, read back from the built
    collection.
    """

    index: int
    family: str
    subfamily: str
    weight: int
    summary: dict[str, int]


@dataclass(frozen=True)
class BorrowRecord:
    """One donor face's landing in one output slot (issue #9).

    ``donor`` is the source record id; ``face`` is the donor file's own
    face index; ``weight``/``italic`` are that face's identity (which
    donor weight landed); ``family`` names the donor family so the
    borrow table stands alone for display; ``via`` states how it was
    chosen — ``nearest``, ``override``, or ``pinned``; ``style_fallback``
    states that the donor family lacked the slot's style and its other
    style (upright, by the terminal convention) landed instead.
    """

    donor: str
    face: int
    weight: int
    italic: bool
    family: str
    via: str
    style_fallback: bool


@dataclass(frozen=True)
class WeightSlotRecord:
    """One output slot of the weight/style matrix (issue #9).

    ``index`` is the slot's output position (its face position in a
    collection); ``weight``/``italic`` are the output identity — the
    base face's own, or the union weight of a donor-only slot (issue
    #27); ``base_face`` is the container face's index in the base font
    file; ``base_borrow`` states the union's base-side borrow — the
    base weight the container was taken from (``None`` when the base
    has its own face at the slot, and then absent from the JSON so a
    union-inert report stays byte-identical); ``borrows`` states every
    donor landing: which donor weight ended up in this output weight,
    and how it was chosen.
    """

    index: int
    weight: int
    italic: bool
    base_face: int
    base_borrow: int | None = None
    borrows: tuple[BorrowRecord, ...] = ()


@dataclass(frozen=True)
class SkippedFaceRecord:
    """One base face the build excluded, and why (round 29).

    The slot resolution (:func:`fontalloy_core.load.resolve_base_faces`)
    drops a base face only when another face already holds the same
    (weight, style) slot with flags that describe its ink — publisher
    style side-cuts (Oblique flagged upright, Upright-Italic flagged
    italic) pooled by a family-cut pattern. The record states the drop
    so the report never hides what the recipe loaded.
    """

    file: str
    weight: int
    italic: bool
    subfamily: str
    reason: str


@dataclass(frozen=True)
class CoverageRecord:
    """One rule's requested target versus the effective result (issue #12).

    ``requested`` counts the codepoints the rule's declared target
    spans; ``covered`` counts how many of those are in the built font's
    cmap (face 0 of a collection, like the flat provenance); ``missing``
    lists the gaps as recipe-syntax labels, capped at
    :data:`MISSING_CAP` — ``missing_total`` keeps the exact count and
    ``missing_truncated`` states whether the list was cut.
    """

    rule: str  # rule id ("rule-<declaration index>")
    granularity: str  # "codepoint" | "range" | "set"
    target: str  # recipe syntax, same label the rules section carries
    requested: int
    covered: int
    missing: tuple[str, ...]
    missing_total: int
    missing_truncated: bool


@dataclass(frozen=True)
class DonorNormalizationRecord:
    """The normalization actually applied to one donor in one face (issue #12).

    ``upem`` is the donor's own; ``s0 = U/u`` unified it onto the base's;
    ``han_ink_height`` is the measured H_ink in donor units (``None``
    when the donor has no common Han sample, hence no k); ``k`` is the
    school's scale (auto, grid, or optical term, guard-capped); ``scale`` is
    the per-glyph factor the graft applied — ``s0 * (k or 1)``.
    """

    donor: str
    upem: int
    s0: float
    han_ink_height: float | None
    k: float | None
    scale: float


@dataclass(frozen=True)
class MetricFaceRecord:
    """Before/after metrics for one output face (issue #12).

    Every metric is a ``(base, output)`` pair: the base face as loaded
    (post instance/detect, pre-graft — what the pipeline actually
    started from) versus the built font read back from disk. ``*_untouched``
    is the proof the inherited line height held: field-level equality of
    the hhea (ascent, descent, lineGap) and OS/2 typo (ascender,
    descender, lineGap) values against the base face — usWinAscent and
    usWinDescent are deliberately excluded, they may grow to prevent
    clipping (ADR-0003) and their growth shows in the paired values.
    """

    slot: int
    base_face: int
    weight: int
    italic: bool
    upem: tuple[int, int]
    latin_advance: tuple[int, int]  # A, the single-cell advance
    cjk_advance: tuple[int | None, int | None]  # modal Han-block advance
    hhea_ascent: tuple[int, int]
    hhea_descent: tuple[int, int]
    hhea_line_gap: tuple[int, int]
    typo_ascender: tuple[int | None, int]
    typo_descender: tuple[int | None, int]
    typo_line_gap: tuple[int | None, int]
    win_ascent: tuple[int | None, int]
    win_descent: tuple[int | None, int]
    normalization: tuple[DonorNormalizationRecord, ...] = ()
    hhea_untouched: bool = True
    typo_untouched: bool = True

    @property
    def grid_ratio(self) -> float | None:
        """The output's CJK-to-Latin advance ratio (None without Han)."""
        cjk, latin = self.cjk_advance[1], self.latin_advance[1]
        if cjk is None or latin == 0:
            return None
        return cjk / latin


@dataclass(frozen=True)
class VerificationReport:
    """The verification report of one build.

    ``format`` records the output format tier the build wrote (issue
    #10); for a ``ttc`` build, ``faces`` carries one :class:`FaceRecord`
    per packaged face, while the flat ``provenance``, ``summary``, and
    ``coverage`` describe face 0 (faces of one collection may resolve
    differently — each face's own counts are in its record; the
    ``metrics`` section is per face). ``coverage_rules`` carries the
    per-rule requested-vs-result accounting (issue #12); the overall
    coverage record derives from ``provenance``. The JSON carries no
    timestamps or nondeterministic ordering, so identical inputs yield
    byte-identical reports.
    """

    sources: tuple[SourceRecord, ...]
    provenance: tuple[ProvenanceEntry, ...]
    output_path: Path
    output_sha256: str
    rules: tuple[RuleRecord, ...] = ()
    conflicts: tuple[ConflictRecord, ...] = ()
    format: str = "ttf"
    faces: tuple[FaceRecord, ...] = ()
    weights: tuple[WeightSlotRecord, ...] = ()
    skipped_faces: tuple[SkippedFaceRecord, ...] = ()
    coverage_rules: tuple[CoverageRecord, ...] = ()
    metrics: tuple[MetricFaceRecord, ...] = ()

    @property
    def summary(self) -> dict[str, int]:
        from_base = sum(1 for e in self.provenance if e.winner == "base")
        return {
            "codepoints_total": len(self.provenance),
            "from_base": from_base,
            "from_donors": len(self.provenance) - from_base,
            "output_codepoints": sum(1 for e in self.provenance if e.in_output),
        }

    @property
    def precedence_counts(self) -> dict[str, int]:
        """The fill/override accounting over the effective table."""
        kinds = [e.kind for e in self.provenance]
        return {
            "base": kinds.count("base"),
            "fill": kinds.count("fill"),
            "override": kinds.count("override"),
        }

    @property
    def coverage_overall(self) -> dict:
        """The whole-build coverage scope: the union of all source
        coverages (the effective table) versus the built font's cmap.

        An entry here is what the pipeline intended; a nonzero
        ``missing`` means the graft dropped something it resolved —
        the honest readback makes that visible rather than assumed.
        """
        absent = [e.codepoint for e in self.provenance if not e.in_output]
        listed = absent[:MISSING_CAP]
        return {
            "requested": len(self.provenance),
            "covered": len(self.provenance) - len(absent),
            "missing": [codepoint_label(value) for value in listed],
            "missing_total": len(absent),
            "missing_truncated": len(absent) > len(listed),
        }

    def to_json_dict(self) -> dict:
        output: dict = {
            "path": str(self.output_path),
            "sha256": self.output_sha256,
            "format": self.format,
        }
        if self.faces:
            output["faces"] = [
                {
                    "index": face.index,
                    "family": face.family,
                    "subfamily": face.subfamily,
                    "weight": face.weight,
                    "summary": face.summary,
                }
                for face in self.faces
            ]
        if self.skipped_faces:
            output["skipped_faces"] = [
                {
                    "file": skipped.file,
                    "weight": skipped.weight,
                    "italic": skipped.italic,
                    "subfamily": skipped.subfamily,
                    "reason": skipped.reason,
                }
                for skipped in self.skipped_faces
            ]
        return {
            "schema": SCHEMA,
            "output": output,
            "sources": [
                {
                    "id": source.id,
                    "role": source.role,
                    "path": str(source.path),
                    "sha256": source.sha256,
                    "codepoints": source.codepoints,
                    "placeholder_codepoints": source.placeholder_codepoints,
                }
                for source in self.sources
            ],
            "rules": [
                {
                    "id": rule.id,
                    "granularity": rule.granularity,
                    "target": rule.target,
                    "fonts": list(rule.fonts),
                }
                for rule in self.rules
            ],
            "provenance": [
                {
                    "codepoint": entry.codepoint,
                    "winner": entry.winner,
                    "in_output": entry.in_output,
                    "via": entry.via,
                    "kind": entry.kind,
                }
                for entry in self.provenance
            ],
            "precedence": {
                "counts": self.precedence_counts,
                "same_layer_conflicts": [
                    {
                        "granularity": conflict.granularity,
                        "shadowed": conflict.shadowed,
                        "winner": conflict.winner,
                        "overlap": list(conflict.overlap),
                        "codepoints": conflict.codepoints,
                    }
                    for conflict in self.conflicts
                ],
            },
            "weights": [
                {
                    "index": slot.index,
                    "weight": slot.weight,
                    "style": "italic" if slot.italic else "upright",
                    "base_face": slot.base_face,
                    # The base-side borrow of a donor-only union slot
                    # (issue #27); own slots omit the key entirely so a
                    # union-inert report keeps its exact former bytes.
                    **({"base_borrow": slot.base_borrow}
                       if slot.base_borrow is not None else {}),
                    "borrows": [
                        {
                            "donor": borrow.donor,
                            "face": borrow.face,
                            "weight": borrow.weight,
                            "style": "italic" if borrow.italic else "upright",
                            "family": borrow.family,
                            "via": borrow.via,
                            "style_fallback": borrow.style_fallback,
                        }
                        for borrow in slot.borrows
                    ],
                }
                for slot in self.weights
            ],
            "coverage": {
                "overall": self.coverage_overall,
                "rules": [
                    {
                        "rule": record.rule,
                        "granularity": record.granularity,
                        "target": record.target,
                        "requested": record.requested,
                        "covered": record.covered,
                        "missing": list(record.missing),
                        "missing_total": record.missing_total,
                        "missing_truncated": record.missing_truncated,
                    }
                    for record in self.coverage_rules
                ],
            },
            "metrics": {
                "faces": [
                    {
                        "slot": face.slot,
                        "base_face": face.base_face,
                        "weight": face.weight,
                        "style": "italic" if face.italic else "upright",
                        "upem": _pair(face.upem),
                        "latin_advance": _pair(face.latin_advance),
                        "cjk_advance": _pair(face.cjk_advance),
                        "grid_ratio": _round(face.grid_ratio),
                        "ascents": {
                            "hhea": _pair(face.hhea_ascent),
                            "typo": _pair(face.typo_ascender),
                            "us_win": _pair(face.win_ascent),
                        },
                        "descents": {
                            "hhea": _pair(face.hhea_descent),
                            "typo": _pair(face.typo_descender),
                            "us_win": _pair(face.win_descent),
                        },
                        "line_gap": {
                            "hhea": _pair(face.hhea_line_gap),
                            "typo": _pair(face.typo_line_gap),
                        },
                        "normalization": [
                            {
                                "donor": record.donor,
                                "upem": record.upem,
                                "s0": _round(record.s0),
                                "han_ink_height": _round(record.han_ink_height),
                                "k": _round(record.k),
                                "scale": _round(record.scale),
                            }
                            for record in face.normalization
                        ],
                        "line_height_untouched": {
                            "hhea": face.hhea_untouched,
                            "typo": face.typo_untouched,
                        },
                    }
                    for face in self.metrics
                ],
            },
            "summary": self.summary,
        }

    def write(self, path: Path | str) -> None:
        payload = json.dumps(self.to_json_dict(), indent=2, ensure_ascii=False)
        Path(path).write_text(payload + "\n", encoding="utf-8")


def _pair(values: tuple) -> dict:
    """A (base, output) metric pair as its JSON object."""
    return {"base": values[0], "output": values[1]}


def _round(value: float | None) -> float | None | int:
    """Round report floats for serialization.

    A fixed rounding keeps the JSON stable and human-scannable while
    staying a pure function of the value (determinism gate: two runs of
    the same build must emit identical report bytes).
    """
    if value is None:
        return None
    rounded = round(float(value), 6)
    if rounded == int(rounded):
        return int(rounded)
    return rounded


def file_sha256(path: Path | str) -> str:
    """Hash a file's bytes; recorded for every source and the output."""
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()
