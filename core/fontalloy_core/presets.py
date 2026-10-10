"""Language presets: fontconfig's fc-lang orthographies, bundled as data.

GLOSSARY: a language preset is a pre-researched "language → codepoint set"
mapping, selected by name, with sub-blocks to toggle. The raw material is
fontconfig's fc-lang corpus — 341 ``.orth`` files, one language charset
per file — vendored under ``data/fc-lang`` with every license header
intact (that directory's README carries the provenance and the pinned
ref). This module is a leaf: it imports nothing from ``fontalloy_core``,
so the precedence engine can plug into it without a cycle.

One rule of thumb throughout: counts are never hand-maintained — they
are derived from the bundled data (the test suite pins them against
independently measured values, so re-pinning the corpus is a deliberate
act that surfaces in CI).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

#: The vendored fc-lang corpus (341 ``.orth`` files plus its README).
DATA_DIR = Path(__file__).parent / "data" / "fc-lang"

#: The fontconfig release tag the corpus was vendored from (see the
#: data directory's README; the measured-count tests guard re-pinning).
FCLANG_REF = "2.18.3"

#: An inclusive codepoint interval, structurally identical to
#: ``fontalloy_core.precedence.Interval``.
Interval = tuple[int, int]

#: Range separators inside one ``.orth`` entry (fc-lang accepts both).
_RANGE_SEPARATOR = re.compile(r"\.\.|-")


def parse_orth(path: Path | str) -> frozenset[int]:
    """Parse one ``.orth`` file into its codepoint set.

    The format is defined by fontconfig's ``fc-lang/fc-lang.py``:
    everything after ``#`` or a TAB is comment; an entry is a codepoint
    (``0x4E00`` or bare hex ``0041``), an inclusive range
    (``start-end`` or ``start..end``), or a deletion (a leading ``-``
    removes the codepoint); an ``include <file>`` line splices a sibling
    file's set in at that point.
    """
    path = Path(path)
    codepoints: set[int] = set()
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        if raw_line.startswith("include "):
            included = path.parent / raw_line[len("include ") :].strip()
            codepoints |= parse_orth(included)
            continue
        line = raw_line.split("#", 1)[0].split("\t", 1)[0].strip()
        if not line:
            continue
        deleting = line.startswith("-")
        if deleting:
            line = line[1:]
        first, *rest = _RANGE_SEPARATOR.split(line)
        start = int(first, 16)
        end = int(rest[0], 16) if rest else start
        for codepoint in range(start, end + 1):
            codepoints.discard(codepoint) if deleting else codepoints.add(codepoint)
    return frozenset(codepoints)


def _load_language_sets(data_dir: Path) -> dict[str, frozenset[int]]:
    """Every ``.orth`` file parsed, keyed by its file stem (``zh_cn``)."""
    return {
        path.stem: parse_orth(path) for path in sorted(data_dir.glob("*.orth"))
    }


#: The raw fc-lang boundary, verbatim: one codepoint set per ``.orth``
#: file, ``include`` directives composed. This is where the preset data
#: keeps its fontconfig truth — the presentation layer below is the only
#: thing that ever differs from it.
LANGUAGE_SETS: dict[str, frozenset[int]] = _load_language_sets(DATA_DIR)
