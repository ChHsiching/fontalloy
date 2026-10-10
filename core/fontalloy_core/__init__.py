"""FontAlloy core: the fontTools merge pipeline.

The only capability layer (ADR-0002). Public surface:

- ``build(recipe_path, output_path, ...)``: recipe + font files in, a built
  font plus a verification report out. This is the one entry point the whole
  pipeline is tested through (seam 1 of the testing decisions).
- ``load_recipe(path)``: parse a recipe YAML strictly into a ``Recipe``.
- ``load_manifest(path)``: parse the font catalog manifest strictly into a
  ``Catalog``; ``fetch_catalog(...)`` downloads and sha256-verifies it.
- ``RecipeError`` / ``BuildError`` / ``CatalogError`` / ``AssetsError``:
  the error types callers catch.
"""

from __future__ import annotations

from fontalloy_core.assets import FetchSummary, fetch_catalog
from fontalloy_core.build import BuildOutput, build
from fontalloy_core.catalog import Catalog, CatalogEntry, load_manifest
from fontalloy_core.errors import (
    AssetsError,
    BuildError,
    CatalogError,
    FontAlloyError,
    RecipeError,
)
from fontalloy_core.notices import generate_notices, write_notices
from fontalloy_core.recipe import Recipe, load_recipe
from fontalloy_core.report import VerificationReport

__version__ = "0.1.0"

__all__ = [
    "AssetsError",
    "BuildError",
    "BuildOutput",
    "Catalog",
    "CatalogEntry",
    "CatalogError",
    "FetchSummary",
    "FontAlloyError",
    "Recipe",
    "RecipeError",
    "VerificationReport",
    "build",
    "fetch_catalog",
    "generate_notices",
    "load_manifest",
    "load_recipe",
    "write_notices",
]
