"""Public error types for the FontAlloy core."""

from __future__ import annotations


class FontAlloyError(Exception):
    """Base class for every error FontAlloy raises on purpose."""


class RecipeError(FontAlloyError):
    """The recipe file is missing, not valid YAML, or violates the schema."""


class BuildError(FontAlloyError):
    """A build failed on its inputs or outputs (fonts, paths, I/O)."""


class CatalogError(FontAlloyError):
    """The font catalog manifest is missing, not valid JSON, or invalid."""


class AssetsError(FontAlloyError):
    """A catalog fetch failed (unreachable origin, checksum mismatch)."""


class ReleaseError(FontAlloyError):
    """Catalog-release metadata is invalid, or release packaging failed."""


class PresetError(FontAlloyError):
    """The language-preset corpus is missing or unreadable (bad install)."""
