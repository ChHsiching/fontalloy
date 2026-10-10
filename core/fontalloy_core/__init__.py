"""FontAlloy core: the fontTools merge pipeline.

The only capability layer (ADR-0002). Public surface:

- ``build(recipe_path, output_path, ...)``: recipe + font files in, a built
  font plus a verification report out. This is the one entry point the whole
  pipeline is tested through (seam 1 of the testing decisions).
- ``load_recipe(path)``: parse a recipe YAML strictly into a ``Recipe``.
- ``RecipeError`` / ``BuildError``: the error types callers catch.
"""

from __future__ import annotations

from fontalloy_core.build import build
from fontalloy_core.errors import BuildError, FontAlloyError, RecipeError
from fontalloy_core.recipe import Recipe, load_recipe

__version__ = "0.1.0"

__all__ = [
    "BuildError",
    "FontAlloyError",
    "Recipe",
    "RecipeError",
    "build",
    "load_recipe",
]
