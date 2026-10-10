"""Public error types for the FontAlloy core."""

from __future__ import annotations


class FontAlloyError(Exception):
    """Base class for every error FontAlloy raises on purpose."""


class RecipeError(FontAlloyError):
    """The recipe file is missing, not valid YAML, or violates the schema."""


class BuildError(FontAlloyError):
    """A build failed on its inputs or outputs (fonts, paths, I/O)."""
