"""The verification report.

Every build emits one (issue #2, and the spec's "every build ships a
verification report"). Report v0 records the build's sources and the
per-codepoint provenance — for each codepoint in the union of all source
coverages, which font wins it under the default precedence (base first,
donors in join order, absence never overrides).

v0 is the structure later tickets extend, not the final content: when
grafting lands, donor-won codepoints flip ``in_output`` to true and the
summary converges; the weight-borrow table and metric comparison join as
new sections. The JSON carries no timestamps or nondeterministic ordering,
so identical inputs yield byte-identical reports.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

#: Schema identifier, bumped when the report shape changes meaningfully.
SCHEMA = "fontalloy/verification-report@v0"


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
    in_output: bool  # present in the built font (v0: base coverage only)


@dataclass(frozen=True)
class VerificationReport:
    sources: tuple[SourceRecord, ...]
    provenance: tuple[ProvenanceEntry, ...]
    output_path: Path
    output_sha256: str

    @property
    def summary(self) -> dict[str, int]:
        from_base = sum(1 for e in self.provenance if e.winner == "base")
        return {
            "codepoints_total": len(self.provenance),
            "from_base": from_base,
            "from_donors": len(self.provenance) - from_base,
            "output_codepoints": sum(1 for e in self.provenance if e.in_output),
        }

    def to_json_dict(self) -> dict:
        return {
            "schema": SCHEMA,
            "output": {
                "path": str(self.output_path),
                "sha256": self.output_sha256,
            },
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
            "provenance": [
                {
                    "codepoint": entry.codepoint,
                    "winner": entry.winner,
                    "in_output": entry.in_output,
                }
                for entry in self.provenance
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
