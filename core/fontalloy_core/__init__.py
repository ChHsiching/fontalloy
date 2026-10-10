"""FontAlloy core: the fontTools merge pipeline.

The only capability layer (ADR-0002). Public surface:

- ``build(recipe_path, output_path, ...)``: recipe + font files in, a built
  font plus a verification report out. This is the one entry point the whole
  pipeline is tested through (seam 1 of the testing decisions).
- ``load_recipe(path)``: parse a recipe YAML strictly into a ``Recipe``.
- ``scan_families(paths)`` / ``aggregate_families(faces)``: group font
  faces by family into weight/style matrices (stage 1's detection side,
  consumed by the catalog, the pickers, and the weight matching).
- ``resolve_precedence(rules, coverages=..., named_sets=...)``: the
  precedence engine — expand a rule set (with font coverages and named
  range sets) to codepoint level, producing the effective table. The
  build pipeline consumes it, and later consumers (grafting, serve, the
  GUI's effective-preview consistency check) call it directly.
- ``fontalloy_core.presets``: the language-preset registry — the bundled
  fc-lang corpus, its raw per-language sets, and the presentation
  presets (sub-block unions) that fill ``BUILTIN_NAMED_SETS``.
- ``load_manifest(path)``: parse the font catalog manifest strictly into a
  ``Catalog``; ``fetch_catalog(...)`` downloads and sha256-verifies it.
- ``load_catalog_release(path)``: parse catalog-release metadata strictly
  into a ``CatalogRelease`` — the ordered origin list the app-side
  downloader consumes; ``fetch_from_origins(...)`` fetches an artifact
  trying origins in list order.
- ``package_catalog_release(...)``: repackage a fetched catalog into
  per-family zips plus SHA256SUMS and catalog-release metadata (the CI
  catalog release job).
- ``RecipeError`` / ``BuildError`` / ``CatalogError`` / ``AssetsError`` /
  ``ReleaseError``: the error types callers catch.
"""

from __future__ import annotations

from fontalloy_core import presets
from fontalloy_core.assets import FetchSummary, fetch_catalog
from fontalloy_core.build import BuildOutput, build
from fontalloy_core.catalog import Catalog, CatalogEntry, load_manifest
from fontalloy_core.catalog_release import (
    CatalogRelease,
    Origin,
    ReleaseFamily,
    ReleaseFile,
    load_catalog_release,
)
from fontalloy_core.errors import (
    AssetsError,
    BuildError,
    CatalogError,
    FontAlloyError,
    RecipeError,
    ReleaseError,
)
from fontalloy_core.load import FaceInfo, Family, aggregate_families, scan_families
from fontalloy_core.notices import generate_notices, write_notices
from fontalloy_core.origins import OriginFetch, fetch_from_origins
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
from fontalloy_core.release import ReleasePackage, package_catalog_release

__version__ = "0.1.0"

__all__ = [
    "AssetsError",
    "BUILTIN_NAMED_SETS",
    "BuildError",
    "BuildOutput",
    "Catalog",
    "CatalogEntry",
    "CatalogError",
    "CatalogRelease",
    "EffectiveEntry",
    "FaceInfo",
    "Family",
    "FetchSummary",
    "FontAlloyError",
    "Origin",
    "OriginFetch",
    "PrecedenceRule",
    "Recipe",
    "RecipeError",
    "ReleaseError",
    "ReleaseFamily",
    "ReleaseFile",
    "ReleasePackage",
    "Resolution",
    "SameLayerConflict",
    "VerificationReport",
    "aggregate_families",
    "build",
    "fetch_catalog",
    "fetch_from_origins",
    "generate_notices",
    "load_catalog_release",
    "load_manifest",
    "load_recipe",
    "package_catalog_release",
    "presets",
    "resolve_precedence",
    "scan_families",
    "write_notices",
]
