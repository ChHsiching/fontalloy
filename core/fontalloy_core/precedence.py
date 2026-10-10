"""The precedence engine: rules in, effective table out.

Everything in a merge is a precedence rule — a codepoint target mapped to
an ordered font list (GLOSSARY: "precedence rule"). The resolver expands
any rule set to codepoint level and produces the effective table ("which
glyph from which font, per codepoint") plus the same-layer conflict list.

Semantics (DESIGN.md, ADR-0001):

- Granularity ranks: single codepoint > custom range > named set
  (preset/script) > global default. The narrowest rule covering a
  codepoint wins, regardless of declaration order.
- Within one granularity layer, the last declared rule covering a
  codepoint wins.
- The global default is not declared: base font first, then donors in
  join order.
- Absence never overrides: within the winning rule's ordered font list,
  fonts lacking a glyph at the codepoint are skipped and the first holder
  wins. When no font in the winning list holds the glyph, the global
  default supplies it (the codepoint behaves as if unruled).
- Fill is the default behavior; an override happens only through an
  explicit rule. Whether a rule fills or overrides is expressed by the
  rule's own font list: a list starting with ``base`` keeps base glyphs
  (fill), a list without ``base`` displaces them (override).

Named sets decouple the resolver from preset data: a rule references a
set by name, and the sets themselves arrive as data. ``BUILTIN_NAMED_SETS``
is the plug-in point for the fc-lang language presets (ticket #7); the
resolver itself never changes when preset data lands.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass

#: Highest valid Unicode scalar value.
MAX_CODEPOINT = 0x10FFFF

#: Granularity layer names, narrowest first. The order is the precedence.
CODEPOINT = "codepoint"
RANGE = "range"
SET = "set"
DEFAULT = "default"

_GRANULARITY_RANK = {CODEPOINT: 3, RANGE: 2, SET: 1}

#: An inclusive codepoint interval.
Interval = tuple[int, int]

#: Built-in named range sets, referenced by name from rules. Empty until
#: the fc-lang language presets land (ticket #7) — they plug in here as
#: data, with no resolver change. Recipe-defined sets override built-ins.
BUILTIN_NAMED_SETS: Mapping[str, tuple[Interval, ...]] = {}


@dataclass(frozen=True)
class PrecedenceRule:
    """One precedence declaration: a codepoint target → ordered font list.

    Exactly one of ``codepoint`` / ``span`` / ``set_name`` is set,
    matching ``granularity``. Font references are build font ids:
    ``"base"`` or ``"donor-<join index>"``.
    """

    granularity: str
    codepoint: int | None = None
    span: Interval | None = None
    set_name: str | None = None
    fonts: tuple[str, ...] = ()

    @property
    def rank(self) -> int:
        """Granularity rank; narrower rules rank higher."""
        return _GRANULARITY_RANK[self.granularity]

    def covers(self, codepoint: int, named_sets: Mapping[str, Sequence[Interval]]) -> bool:
        """Does this rule's declared target cover ``codepoint``?"""
        if self.granularity == CODEPOINT:
            return codepoint == self.codepoint
        if self.granularity == RANGE:
            return self.span[0] <= codepoint <= self.span[1]  # type: ignore[index]
        return any(start <= codepoint <= end for start, end in named_sets[self.set_name])  # type: ignore[index]


def compress_intervals(intervals: Iterable[Interval]) -> tuple[Interval, ...]:
    """Sort intervals and merge overlapping or adjacent ones."""
    merged: list[list[int]] = []
    for start, end in sorted(intervals):
        if merged and start <= merged[-1][1] + 1:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return tuple((start, end) for start, end in merged)


def is_unicode_scalar(value: int) -> bool:
    """Is ``value`` a Unicode scalar value (GLOSSARY: codepoint)?"""
    return 0 <= value <= MAX_CODEPOINT and not 0xD800 <= value <= 0xDFFF
