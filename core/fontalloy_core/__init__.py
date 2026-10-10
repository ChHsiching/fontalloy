"""FontAlloy core: the fontTools merge pipeline.

The only capability layer (ADR-0002). Public surface:

- ``build(recipe_path, output_path, ...)``: recipe + font files in, a built
  font plus a verification report out. This is the one entry point the whole
  pipeline is tested through (seam 1 of the testing decisions).
- ``load_recipe(path)``: parse a recipe YAML strictly into a ``Recipe``.
- ``scan_families(paths)`` / ``aggregate_families(faces)``: group font
  faces by family into weight/style matrices (stage 1's detection side,
  consumed by the catalog, the pickers, and the weight matching).
- ``RecipeError`` / ``BuildError``: the error types callers catch.
"""

from __future__ import annotations

from fontalloy_core.build import BuildOutput, build
from fontalloy_core.errors import BuildError, FontAlloyError, RecipeError
from fontalloy_core.load import FaceInfo, Family, aggregate_families, scan_families
from fontalloy_core.recipe import Recipe, load_recipe
from fontalloy_core.report import VerificationReport

__version__ = "0.1.0"

__all__ = [
    "BuildError",
    "BuildOutput",
    "FaceInfo",
    "Family",
    "FontAlloyError",
    "Recipe",
    "RecipeError",
    "VerificationReport",
    "aggregate_families",
    "build",
    "load_recipe",
    "scan_families",
]
