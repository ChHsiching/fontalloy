"""FontAlloy core: the fontTools merge pipeline.

The only capability layer (ADR-0002). Public surface:

- ``build(recipe_path, output_path, ...)``: recipe + font files in, a built
  font plus a verification report out. This is the one entry point the whole
  pipeline is tested through (seam 1 of the testing decisions).
- ``load_recipe(path)``: parse a recipe YAML strictly into a ``Recipe``.
- ``resolve_precedence(rules, coverages=..., named_sets=...)``: the
  precedence engine — expand a rule set (with font coverages and named
  range sets) to codepoint level, producing the effective table. The
  build pipeline consumes it, and later consumers (grafting, serve, the
  GUI's effective-preview consistency check) call it directly.
- ``RecipeError`` / ``BuildError``: the error types callers catch.
"""

from __future__ import annotations

from fontalloy_core.build import BuildOutput, build
from fontalloy_core.errors import BuildError, FontAlloyError, RecipeError
from fontalloy_core.precedence import (
    BUILTIN_NAMED_SETS,
    EffectiveEntry,
    PrecedenceRule,
    Resolution,
    SameLayerConflict,
    resolve_precedence,
)
from fontalloy_core.recipe import Recipe, load_recipe
from fontalloy_core.report import VerificationReport

__version__ = "0.1.0"

__all__ = [
    "BUILTIN_NAMED_SETS",
    "BuildError",
    "BuildOutput",
    "EffectiveEntry",
    "FontAlloyError",
    "PrecedenceRule",
    "Recipe",
    "RecipeError",
    "Resolution",
    "SameLayerConflict",
    "VerificationReport",
    "build",
    "load_recipe",
    "resolve_precedence",
]
