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

#: Name under which the Hong Kong supplementary charset (the verbatim
#: ``zh_hk.orth`` set) is exposed as its own toggleable sub-block.
ZH_HK_SUPPLEMENT = "zh_hk_supplement"

#: An inclusive codepoint interval, structurally identical to
#: ``fontalloy_core.precedence.Interval``.
Interval = tuple[int, int]

#: Range separators inside one ``.orth`` entry (fc-lang accepts both).
_RANGE_SEPARATOR = re.compile(r"\.\.|-")


@dataclass(frozen=True)
class SubBlock:
    """One toggleable block of a language preset (GLOSSARY: sub-block).

    A preset is the union of its sub-blocks; a consumer toggling a block
    off composes the remaining blocks. Every block is also selectable on
    its own as a named set.
    """

    name: str
    codepoints: frozenset[int]


@dataclass(frozen=True)
class LanguagePreset:
    """A language preset: the union of its sub-blocks.

    The sub-blocks default to the language's own raw set. The only
    exceptions are declared in ``_PRESENTATION_SUB_BLOCKS`` below.
    """

    name: str
    sub_blocks: tuple[SubBlock, ...]

    @property
    def codepoints(self) -> frozenset[int]:
        """The preset's coverage: every sub-block enabled."""
        return frozenset().union(
            *(block.codepoints for block in self.sub_blocks)
        )


#: Presentation presets that differ from the raw fc-lang set: the Hong
#: Kong and Macau files are supplementary charsets that presuppose
#: Traditional Chinese without including it (``zh_hk.orth``'s header
#: describes a supplement with zero intersection with zh_tw;
#: ``zh_mo.orth`` is literally ``include zh_hk.orth``). Their preset
#: presents zh_tw plus the supplement, with the supplement as its own
#: toggleable sub-block. Maps a language name to its ``(block name,
#: source language)`` blocks, in display order.
_PRESENTATION_SUB_BLOCKS: dict[str, tuple[tuple[str, str], ...]] = {
    "zh_hk": (("zh_tw", "zh_tw"), (ZH_HK_SUPPLEMENT, "zh_hk")),
    "zh_mo": (("zh_tw", "zh_tw"), (ZH_HK_SUPPLEMENT, "zh_hk")),
}


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

#: The presentation layer: what "select this language" means. One preset
#: per corpus language; a preset is the union of its sub-blocks.
PRESETS: dict[str, LanguagePreset] = {
    name: LanguagePreset(
        name=name,
        sub_blocks=tuple(
            SubBlock(name=block, codepoints=LANGUAGE_SETS[source])
            for block, source in _PRESENTATION_SUB_BLOCKS.get(
                name, ((name, name),)
            )
        ),
    )
    for name in sorted(LANGUAGE_SETS)
}


def builtin_named_sets() -> dict[str, tuple[Interval, ...]]:
    """The registry the resolver plugs into: name → interval tuples.

    Every preset is selectable by name, and so is every sub-block that
    is not itself a language (the zh_hk supplement). Intervals are
    sorted and disjoint — the shape the precedence engine assumes.
    """
    named: dict[str, tuple[Interval, ...]] = {}
    for name, preset in PRESETS.items():
        named[name] = _compress(preset.codepoints)
    for preset in PRESETS.values():
        for block in preset.sub_blocks:
            named.setdefault(block.name, _compress(block.codepoints))
    return named


def _compress(codepoints: frozenset[int]) -> tuple[Interval, ...]:
    """Sorted, disjoint, non-adjacent intervals covering ``codepoints``."""
    merged: list[list[int]] = []
    for value in sorted(codepoints):
        if merged and value == merged[-1][1] + 1:
            merged[-1][1] = value
        else:
            merged.append([value, value])
    return tuple((start, end) for start, end in merged)
