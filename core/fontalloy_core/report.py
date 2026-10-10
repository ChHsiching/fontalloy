"""The verification report.

Every build emits one (issue #2, and the spec's "every build ships a
verification report"). The report records the build's sources and the
effective table — for each codepoint in the union of all source
coverages, which font wins it (``winner``), through which precedence
(``via``: the global default or the winning rule), and how the glyph got
there (``kind``: base keep, fill, or override).

This is still the structure later tickets extend, not the final content:
grafting has landed (issue #5), so ``in_output`` records presence in the
built font's own cmap — read back from the output, never assumed — and
the summary's ``output_codepoints`` counts the true merged coverage.
Output formats landed next (issue #10): ``format`` records the tier a
build wrote, and a collection build carries one face record per packaged
face with its identity and its own summary counts. The weight and style
matrix (issue #9) added the ``weights`` section — one slot record per
output weight/style with its borrow table: which donor weight landed in
which output weight, chosen how, and whether a style fell back to
upright. The metric comparison joins as a new section. The JSON carries
no timestamps or nondeterministic ordering, so identical inputs yield
byte-identical reports — and the source hashes below are what make
"identical inputs" checkable in the first place.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

#: Schema identifier, bumped when the report shape changes meaningfully.
SCHEMA = "fontalloy/verification-report@v1"


@dataclass(frozen=True)
class SourceRecord:
    """One font that took part in the build."""

    id: str  # "base" or "donor-<index>", stable across the report
    role: str  # "base" | "donor"
    path: Path
    sha256: str
    codepoints: int  # size of this font's own Unicode coverage


@dataclass(frozen=True)
class ProvenanceEntry:
    """Which font supplies a codepoint in the effective merged result."""

    codepoint: int
    winner: str  # a SourceRecord id
    in_output: bool  # present in the built font (read back from its cmap)
    via: str  # "default" or a rule id ("rule-<declaration index>")
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
    donor weight landed); ``via`` states how it was chosen —
    ``nearest``, ``override``, or ``pinned``; ``style_fallback`` states
    that the donor family lacked the slot's style and its other style
    (upright, by the terminal convention) landed instead.
    """

    donor: str
    face: int
    weight: int
    italic: bool
    via: str
    style_fallback: bool


@dataclass(frozen=True)
class WeightSlotRecord:
    """One output slot of the weight/style matrix (issue #9).

    ``index`` is the slot's output position (its face position in a
    collection); ``weight``/``italic`` are the output identity — the
    base face's own; ``base_face`` is that face's index in the base
    font file; ``borrows`` states every donor landing: which donor
    weight ended up in this output weight, and how it was chosen.
    """

    index: int
    weight: int
    italic: bool
    base_face: int
    borrows: tuple[BorrowRecord, ...] = ()


@dataclass(frozen=True)
class VerificationReport:
    """The verification report of one build.

    ``format`` records the output format tier the build wrote (issue
    #10); for a ``ttc`` build, ``faces`` carries one :class:`FaceRecord`
    per packaged face, while the flat ``provenance`` and ``summary``
    describe face 0 (faces of one collection may resolve differently —
    each face's own counts are in its record). The JSON carries no
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
                    "borrows": [
                        {
                            "donor": borrow.donor,
                            "face": borrow.face,
                            "weight": borrow.weight,
                            "style": "italic" if borrow.italic else "upright",
                            "via": borrow.via,
                            "style_fallback": borrow.style_fallback,
                        }
                        for borrow in slot.borrows
                    ],
                }
                for slot in self.weights
            ],
            "summary": self.summary,
        }

    def write(self, path: Path | str) -> None:
        payload = json.dumps(self.to_json_dict(), indent=2, ensure_ascii=False)
        Path(path).write_text(payload + "\n", encoding="utf-8")


def file_sha256(path: Path | str) -> str:
    """Hash a file's bytes; recorded for every source and the output."""
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()
