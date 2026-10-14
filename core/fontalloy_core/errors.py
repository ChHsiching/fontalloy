"""Public error types for the FontAlloy core."""

from __future__ import annotations


class FontAlloyError(Exception):
    """Base class for every error FontAlloy raises on purpose."""


class RecipeError(FontAlloyError):
    """The recipe file is missing, not valid YAML, or violates the schema."""


class BuildError(FontAlloyError):
    """A build failed on its inputs or outputs (fonts, paths, I/O)."""


class BuildCancelled(Exception):
    """A build was cancelled mid-pipeline through its cancel flag.

    Round 19's cooperative-cancellation seam: the pipeline checks the
    consumer-supplied predicate at stage boundaries and inside the long
    per-codepoint loops, and this — not a failure — is what a cancelled
    build raises. Deliberately outside the ``FontAlloyError`` hierarchy:
    a consumer that never arms the flag can never see it, and a caller
    that does must treat it as its own outcome (serve lands the job as
    ``cancelled``, distinct from ``failed``).
    """


class CatalogError(FontAlloyError):
    """The font catalog manifest is missing, not valid JSON, or invalid."""


class AssetsError(FontAlloyError):
    """A catalog fetch failed (unreachable origin, checksum mismatch)."""


class ReleaseError(FontAlloyError):
    """Catalog-release metadata is invalid, or release packaging failed."""


class PresetError(FontAlloyError):
    """The language-preset corpus is missing or unreadable (bad install)."""
