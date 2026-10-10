"""Recipe loading: parse a recipe YAML file strictly.

Recipe fields (base + donors since issue #2; rules + sets since issue #3):

- ``base``: the base font reference, as a file path string
- ``donors``: the donor list, as a list of file path strings
- ``rules``: precedence rules, in declaration order — each rule declares
  exactly one target field (``codepoint`` for a single codepoint,
  ``range`` for a custom interval like ``"0x2100-0x214F"``, ``set`` for a
  named range set) plus ``fonts``, an ordered font list whose entries
  reference ``base`` or ``donor-<join index>``
- ``sets``: user-defined named range sets — a mapping of a name to a
  codepoint, an interval string, or a non-empty list of either

Paths in a recipe resolve against the recipe file's directory, not the
working directory — a recipe is a share unit and must mean the same thing
wherever it is run. Parsing is strict: unknown fields, missing fields,
and type errors all raise :class:`~fontalloy_core.errors.RecipeError`
with a message naming the offending field. ``rules`` and ``sets`` are
optional, so a v0 recipe (base + donors only) parses unchanged.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from fontalloy_core.errors import RecipeError
from fontalloy_core.precedence import (
    BUILTIN_NAMED_SETS,
    CODEPOINT,
    RANGE,
    SET,
    Interval,
    PrecedenceRule,
    compress_intervals,
    is_unicode_scalar,
)

#: The fields the recipe accepts.
RECIPE_FIELDS = ("base", "donors", "rules", "sets")

#: The target fields a rule may declare; exactly one per rule.
_TARGET_FIELDS = (CODEPOINT, RANGE, SET)


@dataclass(frozen=True)
class Recipe:
    """A parsed recipe, with font paths resolved to absolute locations."""

    base: Path
    donors: tuple[Path, ...]
    rules: tuple[PrecedenceRule, ...] = ()
    named_sets: dict[str, tuple[Interval, ...]] = field(default_factory=dict)


def load_recipe(path: Path | str) -> Recipe:
    """Load and validate a recipe file, resolving its font paths."""
    recipe_path = Path(path)
    if not recipe_path.is_file():
        raise RecipeError(f"recipe file not found: {recipe_path}")

    text = recipe_path.read_text(encoding="utf-8")
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise RecipeError(f"recipe is not valid YAML: {exc}") from None

    if not isinstance(data, dict):
        raise RecipeError(
            "recipe must be a YAML mapping with the fields "
            f"{', '.join(repr(f) for f in RECIPE_FIELDS)}"
        )

    unknown = sorted(set(data) - set(RECIPE_FIELDS))
    if unknown:
        raise RecipeError(
            f"unknown recipe field {unknown[0]!r} "
            f"(the recipe accepts: {', '.join(RECIPE_FIELDS)})"
        )

    base = _parse_base(data)
    donors_raw = _parse_donors(data)

    named_sets = _parse_sets(data.get("sets"))
    rules = _parse_rules(data.get("rules"), len(donors_raw), named_sets)

    root = recipe_path.parent
    return Recipe(
        base=(root / base).resolve(),
        donors=tuple((root / donor).resolve() for donor in donors_raw),
        rules=rules,
        named_sets=named_sets,
    )


def _parse_base(data: dict) -> str:
    if "base" not in data:
        raise RecipeError("recipe field 'base' is required (a font file path string)")
    if not _is_path_string(data["base"]):
        raise RecipeError("recipe field 'base' must be a non-empty font file path string")
    return data["base"]


def _parse_donors(data: dict) -> list[str]:
    if "donors" not in data:
        raise RecipeError("recipe field 'donors' is required (a list of font file paths)")
    donors_raw = data["donors"]
    if not isinstance(donors_raw, list):
        raise RecipeError("recipe field 'donors' must be a list of font file paths")
    for index, donor in enumerate(donors_raw):
        if not _is_path_string(donor):
            raise RecipeError(
                f"recipe field 'donors[{index}]' must be a non-empty font file path string"
            )
    return donors_raw


def _parse_sets(raw: object) -> dict[str, tuple[Interval, ...]]:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise RecipeError(
            "recipe field 'sets' must be a mapping of names to codepoints, "
            'interval strings like "0x4E00-0x9FFF", or lists of either'
        )
    named_sets: dict[str, tuple[Interval, ...]] = {}
    for name, body in raw.items():
        if not isinstance(name, str) or not name.strip():
            raise RecipeError(
                "recipe field 'sets' keys must be non-empty names"
            )
        named_sets[name] = _parse_set_body(body, f"sets[{name!r}]")
    return named_sets


def _parse_set_body(body: object, where: str) -> tuple[Interval, ...]:
    elements = body if isinstance(body, list) else [body]
    if not elements:
        raise RecipeError(f"recipe field '{where}' must declare at least one codepoint")
    intervals: list[Interval] = []
    for element in elements:
        if _is_int(element):
            intervals.append((_parse_codepoint(element, where),) * 2)
        elif isinstance(element, str):
            intervals.append(_parse_interval(element, where))
        else:
            raise RecipeError(
                f"recipe field '{where}' entries must be a codepoint or an "
                f'interval string like "0x4E00-0x9FFF" (got {element!r})'
            )
    return compress_intervals(intervals)


def _parse_rules(
    raw: object, donor_count: int, named_sets: dict[str, tuple[Interval, ...]]
) -> tuple[PrecedenceRule, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list):
        raise RecipeError(
            "recipe field 'rules' must be a list of precedence rules "
            "(each with one target field and a fonts list)"
        )

    available_sets = {**BUILTIN_NAMED_SETS, **named_sets}
    rules: list[PrecedenceRule] = []
    for index, entry in enumerate(raw):
        where = f"rules[{index}]"
        if not isinstance(entry, dict):
            raise RecipeError(
                f"recipe field '{where}' must be a mapping declaring exactly "
                f"one of {', '.join(repr(f) for f in _TARGET_FIELDS)} plus "
                "'fonts'"
            )

        unknown = sorted(set(entry) - set(_TARGET_FIELDS) - {"fonts"})
        if unknown:
            raise RecipeError(
                f"recipe field '{where}' has unknown field {unknown[0]!r} "
                f"(a rule accepts: {', '.join(repr(f) for f in _TARGET_FIELDS)}, 'fonts')"
            )

        targets = [field for field in _TARGET_FIELDS if field in entry]
        if len(targets) != 1:
            raise RecipeError(
                f"recipe field '{where}' must declare exactly one target "
                f"field: {', '.join(repr(f) for f in _TARGET_FIELDS)}"
            )
        target = targets[0]

        fonts = _parse_fonts(entry.get("fonts"), f"{where}.fonts", donor_count)

        if target == CODEPOINT:
            rule = PrecedenceRule(
                granularity=CODEPOINT,
                codepoint=_parse_codepoint(entry[target], f"{where}.{CODEPOINT}"),
                fonts=fonts,
            )
        elif target == RANGE:
            rule = PrecedenceRule(
                granularity=RANGE,
                span=_parse_interval(entry[target], f"{where}.{RANGE}"),
                fonts=fonts,
            )
        else:
            name = entry[target]
            if not isinstance(name, str) or not name.strip():
                raise RecipeError(
                    f"recipe field '{where}.{SET}' must be a named set reference"
                )
            if name not in available_sets:
                raise RecipeError(
                    f"recipe field '{where}.{SET}' references the unknown named "
                    f"set {name!r} (declared sets: "
                    f"{', '.join(sorted(available_sets)) or 'none'})"
                )
            rule = PrecedenceRule(granularity=SET, set_name=name, fonts=fonts)
        rules.append(rule)
    return tuple(rules)


def _parse_fonts(raw: object, where: str, donor_count: int) -> tuple[str, ...]:
    if not isinstance(raw, list) or not raw:
        raise RecipeError(
            f"recipe field '{where}' must be a non-empty list of font "
            "references ('base' or 'donor-<index>')"
        )
    fonts: list[str] = []
    for position, ref in enumerate(raw):
        if not isinstance(ref, str) or not _is_font_ref(ref, donor_count):
            available = ["base"] + [f"donor-{i}" for i in range(donor_count)]
            raise RecipeError(
                f"recipe field '{where}[{position}]' must reference a font in "
                f"this build: {', '.join(available)} (got {ref!r})"
            )
        if ref in fonts:
            raise RecipeError(
                f"recipe field '{where}' lists {ref!r} more than once"
            )
        fonts.append(ref)
    return tuple(fonts)


def _is_font_ref(ref: str, donor_count: int) -> bool:
    if ref == "base":
        return True
    match = re.fullmatch(r"donor-(\d+)", ref)
    return match is not None and int(match.group(1)) < donor_count


def _parse_codepoint(value: object, where: str) -> int:
    if not _is_int(value) or not is_unicode_scalar(value):
        raise RecipeError(
            f"recipe field '{where}' must be a Unicode scalar value "
            f"(an integer like 0x4E2D; got {value!r})"
        )
    return value


def _parse_interval(value: object, where: str) -> Interval:
    if not isinstance(value, str):
        raise RecipeError(
            f"recipe field '{where}' must be an interval string like "
            f'"0x4E00-0x9FFF" (got {value!r})'
        )
    parts = value.split("-")
    if len(parts) != 2:
        raise RecipeError(
            f"recipe field '{where}' must be an interval string like "
            f'"0x4E00-0x9FFF" (got {value!r})'
        )
    try:
        start, end = (int(part, 0) for part in parts)
    except ValueError:
        raise RecipeError(
            f"recipe field '{where}' must be an interval string like "
            f'"0x4E00-0x9FFF" (got {value!r})'
        ) from None
    if not is_unicode_scalar(start) or not is_unicode_scalar(end):
        raise RecipeError(
            f"recipe field '{where}' bounds must be Unicode scalar values "
            f"(got {value!r})"
        )
    if start > end:
        raise RecipeError(
            f"recipe field '{where}' start must not exceed the end "
            f"(got {value!r})"
        )
    return (start, end)


def _is_path_string(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)
