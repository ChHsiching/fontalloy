"""Recipe loading: parse a recipe YAML file strictly.

Recipe v0 carries exactly two fields:

- ``base``: the base font reference
- ``donors``: the donor list of font references

A font reference (issue #4) is either a plain path string or a mapping:

.. code-block:: yaml

    base: JetBrainsMono.ttf
    donors:
      - MapleMono.ttc#1              # string form: path with a '#face' index
      - path: SourceHanSans.ttc      # mapping form: full face/instance control
        face: 2
      - path: Inter-Variable.ttf
        instance:
          wght: 600

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

#: The keys a font-reference mapping accepts.
REF_FIELDS = ("path", "face", "instance")


@dataclass(frozen=True)
class FontRef:
    """A reference to one face of one font file.

    ``face`` selects a face of a TTC collection (``None`` means "not a
    collection reference"). ``instance`` pins variable-font axis values
    (``None`` means "no pinning; use the default instance"), as an ordered
    tuple of ``(axis tag, value)`` pairs in declaration order.
    """

    path: Path
    face: int | None = None
    instance: tuple[tuple[str, int | float], ...] | None = None


@dataclass(frozen=True)
class Recipe:
    """A parsed recipe, with font paths resolved to absolute locations."""

    base: FontRef
    donors: tuple[FontRef, ...]


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
    if "donors" not in data:
        raise RecipeError("recipe field 'donors' is required (a list of font file paths)")
    donors_raw = data["donors"]
    if not isinstance(donors_raw, list):
        raise RecipeError("recipe field 'donors' must be a list of font file paths")

    root = recipe_path.parent
    return Recipe(
        base=_parse_font_ref(data["base"], "base", root),
        donors=tuple(
            _parse_font_ref(donor, f"donors[{index}]", root)
            for index, donor in enumerate(donors_raw)
        ),
    )


def _parse_font_ref(value: object, field: str, root: Path) -> FontRef:
    """Parse one font reference (string or mapping) against the recipe root."""
    if isinstance(value, str):
        return _parse_string_ref(value, field, root)
    if isinstance(value, dict):
        return _parse_mapping_ref(value, field, root)
    raise RecipeError(
        f"recipe field '{field}' must be a font file path string or a mapping "
        f"with the fields {', '.join(REF_FIELDS)}"
    )


def _parse_string_ref(value: str, field: str, root: Path) -> FontRef:
    """Parse ``path`` or ``path#face`` — the compact share-unit form."""
    path_text, sep, tail = value.rpartition("#")
    if sep and tail.isdigit():
        return FontRef(path=(root / path_text).resolve(), face=int(tail))
    return FontRef(path=(root / value).resolve())


def _parse_mapping_ref(value: dict, field: str, root: Path) -> FontRef:
    """Parse ``{path, face, instance}`` — the full reference form."""
    unknown = sorted(set(value) - set(REF_FIELDS))
    if unknown:
        raise RecipeError(
            f"unknown font reference field {unknown[0]!r} in recipe field "
            f"'{field}' (accepts: {', '.join(REF_FIELDS)})"
        )

    if "path" not in value:
        raise RecipeError(
            f"font reference in recipe field '{field}' is missing the "
            "required 'path' key"
        )
    path_text = value["path"]
    if not _is_path_string(path_text):
        raise RecipeError(
            f"font reference 'path' in recipe field '{field}' must be a "
            "non-empty font file path string"
        )

    face = None
    if "face" in value:
        face = value["face"]
        if _is_bool(face) or not isinstance(face, int):
            raise RecipeError(
                f"font reference 'face' in recipe field '{field}' must be a "
                "non-negative integer (the TTC face index)"
            )
        if face < 0:
            raise RecipeError(
                f"font reference 'face' in recipe field '{field}' must be a "
                "non-negative integer (the TTC face index)"
            )

    instance: tuple[tuple[str, int | float], ...] | None = None
    if "instance" in value:
        raw = value["instance"]
        if not isinstance(raw, dict):
            raise RecipeError(
                f"font reference 'instance' in recipe field '{field}' must be "
                "a mapping of variable-font axis tag to value"
            )
        pins: list[tuple[str, int | float]] = []
        for tag, pinned in raw.items():
            if not isinstance(tag, str) or not tag:
                raise RecipeError(
                    f"font reference 'instance' in recipe field '{field}' has "
                    f"a non-string axis tag {tag!r} (axis tags are 4-character "
                    "strings like 'wght')"
                )
            if _is_bool(pinned) or not isinstance(pinned, (int, float)):
                raise RecipeError(
                    f"font reference 'instance' axis {tag!r} in recipe field "
                    f"'{field}' must be a number"
                )
            pins.append((tag, pinned))
        instance = tuple(pins)

    return FontRef(path=(root / path_text).resolve(), face=face, instance=instance)


def _is_bool(value: object) -> bool:
    """YAML booleans are Python ints; a face of ``true`` is a type error."""
    return isinstance(value, bool)


def _is_path_string(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())
