"""FontAlloy core: the fontTools merge pipeline.

The only capability layer (ADR-0002). Public surface:

- ``build(recipe_path, output_path, ...)``: recipe + font files in, a built
  font plus a verification report out. This is the one entry point the whole
  pipeline is tested through (seam 1 of the testing decisions).
- ``load_recipe(path)``: parse a recipe YAML strictly into a ``Recipe``.
- ``OutputNaming`` / ``apply_output_identity(font, naming)`` /
  ``apply_os2_corrections(font)`` (stage 6): the output identity —
  the validated output family (fixed brand default ``ChHsich``), the
  full name record set on both platform encodings, and the OS/2
  corrections (xAvgCharWidth per the OpenType a–z formula, the PANOSE
  mono digits).
- ``scan_families(paths)`` / ``aggregate_families(faces)``: group font
  faces by family into weight/style matrices (stage 1's detection side,
  consumed by the catalog, the pickers, and the weight matching).
- ``resolve_precedence(rules, coverages=..., named_sets=...)``: the
  precedence engine — expand a rule set (with font coverages and named
  range sets) to codepoint level, producing the effective table. The
  build pipeline consumes it, and later consumers (grafting, serve, the
  GUI's effective-preview consistency check) call it directly.
- ``plan_matrix(bases, pools, requests)``: the weight/style matrix
  (issue #9) — which output weight/style slots a build emits and which
  donor face lands in each (nearest OS/2 usWeightClass by default,
  recipe overrides per slot, stated as borrows in the report).
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
from fontalloy_core.matrix import DonorMatch, DonorPool, MatrixSlot, plan_matrix
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
from fontalloy_core.recipe import Recipe, WeightRequest, load_recipe
from fontalloy_core.report import VerificationReport
from fontalloy_core.release import ReleasePackage, package_catalog_release
from fontalloy_core.rewrite import (
    BRAND_DEFAULT_FAMILY,
    OutputNaming,
    apply_os2_corrections,
    apply_output_identity,
    validate_family_name,
)

__version__ = "0.1.0"

__all__ = [
    "AssetsError",
    "BRAND_DEFAULT_FAMILY",
    "BUILTIN_NAMED_SETS",
    "BuildError",
    "BuildOutput",
    "Catalog",
    "CatalogEntry",
    "CatalogError",
    "CatalogRelease",
    "DonorMatch",
    "DonorPool",
    "EffectiveEntry",
    "FaceInfo",
    "Family",
    "FetchSummary",
    "FontAlloyError",
    "MatrixSlot",
    "Origin",
    "OriginFetch",
    "OutputNaming",
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
    "WeightRequest",
    "aggregate_families",
    "apply_os2_corrections",
    "apply_output_identity",
    "build",
    "fetch_catalog",
    "fetch_from_origins",
    "generate_notices",
    "load_catalog_release",
    "load_manifest",
    "load_recipe",
    "package_catalog_release",
    "plan_matrix",
    "presets",
    "resolve_precedence",
    "scan_families",
    "validate_family_name",
    "write_notices",
]
