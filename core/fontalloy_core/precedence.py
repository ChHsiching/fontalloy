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

import re
from collections.abc import Iterable, Mapping, Sequence, Set as AbstractSet
from dataclasses import dataclass

#: Highest valid Unicode scalar value.
MAX_CODEPOINT = 0x10FFFF

#: Granularity layer names, narrowest first. The order is the precedence.
CODEPOINT = "codepoint"
RANGE = "range"
SET = "set"
DEFAULT = "default"

#: How a codepoint's winner was chosen: the global default precedence,
#: or a rule by declaration index.
VIA_DEFAULT = "default"

_GRANULARITY_RANK = {CODEPOINT: 3, RANGE: 2, SET: 1}

#: An inclusive codepoint interval.
Interval = tuple[int, int]

#: Built-in named range sets, referenced by name from rules. Empty until
#: the fc-lang language presets land (ticket #7) — they plug in here as
#: data, with no resolver change. Recipe-defined sets override built-ins.
BUILTIN_NAMED_SETS: Mapping[str, tuple[Interval, ...]] = {}


def rule_id(index: int) -> str:
    """The stable id of the rule declared at ``index`` (0-based)."""
    return f"rule-{index}"


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


@dataclass(frozen=True)
class EffectiveEntry:
    """One codepoint of the effective table: the merged result's truth.

    ``kind`` distinguishes how the glyph got there: ``"base"`` — the base
    font keeps its own glyph; ``"fill"`` — a donor filled a slot the base
    font lacks; ``"override"`` — an explicit rule displaced a base glyph.
    """

    codepoint: int
    winner: str  # font id: "base" or "donor-<index>"
    via: str  # VIA_DEFAULT or a rule id ("rule-<index>")
    kind: str  # "base" | "fill" | "override"


@dataclass(frozen=True)
class Resolution:
    """The resolver's output: the effective table, codepoint by codepoint."""

    effective_table: tuple[EffectiveEntry, ...]  # sorted by codepoint

    @property
    def counts(self) -> dict[str, int]:
        """Fill/override accounting over the effective table."""
        kinds = [entry.kind for entry in self.effective_table]
        return {
            "base": kinds.count("base"),
            "fill": kinds.count("fill"),
            "override": kinds.count("override"),
        }


def resolve_precedence(
    rules: Sequence[PrecedenceRule],
    *,
    coverages: Mapping[str, AbstractSet[int]],
    named_sets: Mapping[str, Sequence[Interval]],
) -> Resolution:
    """Expand a rule set to codepoint level: the effective table.

    ``coverages`` maps every font id in the build (``"base"`` plus
    ``"donor-<index>"``) to the set of codepoints that font's cmap
    covers. ``named_sets`` maps set names to their intervals — the
    plug-in point for language presets. The effective table spans the
    union of all coverages: a codepoint no font holds is in no merge.
    """
    default_list = _default_font_order(coverages)
    _validate_contract(rules, coverages, named_sets, default_list)

    # Winner selection order: narrowest granularity first, and within a
    # layer the last declared — so the first rule covering a codepoint in
    # this order is the winning rule.
    ordered = sorted(
        enumerate(rules), key=lambda item: (-item[1].rank, -item[0])
    )
    base_coverage = coverages["base"]
    table = tuple(
        _resolve_codepoint(codepoint, ordered, default_list, coverages, named_sets, base_coverage)
        for codepoint in sorted(set().union(*coverages.values()))
    )
    return Resolution(effective_table=table)


def _resolve_codepoint(
    codepoint: int,
    ordered: list[tuple[int, PrecedenceRule]],
    default_list: list[str],
    coverages: Mapping[str, AbstractSet[int]],
    named_sets: Mapping[str, Sequence[Interval]],
    base_coverage: AbstractSet[int],
) -> EffectiveEntry:
    for index, rule in ordered:
        if not rule.covers(codepoint, named_sets):
            continue
        winner = _first_holder(rule.fonts, codepoint, coverages)
        if winner is not None:
            return _entry(codepoint, winner, rule_id(index), base_coverage)
        break  # the rule won but cannot supply: default precedence fills

    winner = _first_holder(default_list, codepoint, coverages)
    if winner is None:  # unreachable over the coverage union
        raise ValueError(f"no font holds codepoint {codepoint:#x}")
    return _entry(codepoint, winner, VIA_DEFAULT, base_coverage)


def _entry(
    codepoint: int, winner: str, via: str, base_coverage: AbstractSet[int]
) -> EffectiveEntry:
    if codepoint in base_coverage:
        kind = "base" if winner == "base" else "override"
    else:
        kind = "fill"
    return EffectiveEntry(codepoint=codepoint, winner=winner, via=via, kind=kind)


def _first_holder(
    fonts: Sequence[str], codepoint: int, coverages: Mapping[str, AbstractSet[int]]
) -> str | None:
    """The first font in ``fonts`` holding the codepoint, if any.

    Absence never overrides: fonts lacking the codepoint never compete.
    """
    for font in fonts:
        if codepoint in coverages[font]:
            return font
    return None


def _default_font_order(coverages: Mapping[str, AbstractSet[int]]) -> list[str]:
    """The global default font list: base first, then donors in join order."""
    donors: list[tuple[int, str]] = []
    for font_id in coverages:
        match = re.fullmatch(r"donor-(\d+)", font_id)
        if match:
            donors.append((int(match.group(1)), font_id))
        elif font_id != "base":
            raise ValueError(
                f"coverage keys must be 'base' or 'donor-<index>' (got {font_id!r})"
            )
    return ["base"] + [font_id for _, font_id in sorted(donors)]


def _validate_contract(
    rules: Sequence[PrecedenceRule],
    coverages: Mapping[str, AbstractSet[int]],
    named_sets: Mapping[str, Sequence[Interval]],
    default_list: list[str],
) -> None:
    if "base" not in coverages:
        raise ValueError("coverages must include the base font under the key 'base'")
    for rule in rules:
        for font in rule.fonts:
            if font not in default_list:
                raise ValueError(
                    f"rule font reference {font!r} is not a font id in this build"
                )
        if rule.granularity == SET and rule.set_name not in named_sets:
            raise ValueError(
                f"rule references the unknown named set {rule.set_name!r}"
            )
