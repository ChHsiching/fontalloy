"""Recipe loading: parse a recipe YAML file strictly.

Recipe v0 carries exactly two fields (issue #2):

- ``base``: the base font reference, as a file path string
- ``donors``: the donor list, as a list of file path strings

Paths in a recipe resolve against the recipe file's directory, not the
working directory — a recipe is a share unit and must mean the same thing
wherever it is run. Parsing is strict: unknown fields, missing fields, and
type errors all raise :class:`~fontalloy_core.errors.RecipeError` with a
message naming the offending field.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml

from fontalloy_core.errors import RecipeError

#: The fields recipe v0 accepts. Later tickets extend this list.
V0_FIELDS = ("base", "donors")


@dataclass(frozen=True)
class Recipe:
    """A parsed recipe, with font paths resolved to absolute locations."""

    base: Path
    donors: tuple[Path, ...]


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
            f"{', '.join(repr(f) for f in V0_FIELDS)}"
        )

    unknown = sorted(set(data) - set(V0_FIELDS))
    if unknown:
        raise RecipeError(
            f"unknown recipe field {unknown[0]!r} "
            f"(recipe v0 accepts: {', '.join(V0_FIELDS)})"
        )

    if "base" not in data:
        raise RecipeError("recipe field 'base' is required (a font file path string)")
    base = data["base"]
    if not _is_path_string(base):
        raise RecipeError("recipe field 'base' must be a non-empty font file path string")

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

    root = recipe_path.parent
    return Recipe(
        base=(root / base).resolve(),
        donors=tuple((root / donor).resolve() for donor in donors_raw),
    )


def _is_path_string(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())
