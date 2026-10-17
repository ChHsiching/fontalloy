"""Preview subsets: the tiny fonts picker rows self-render their names in.

Every catalog family's display names — the strings the REAL name tables
carry, which the family documents (:mod:`fontalloy_core.family_docs`)
report — need to be drawable without loading a single real face into the
renderer (spec #25: the page never holds font bytes). Each family gets
ONE subset of its default cut's representative face, cut down to exactly
the name codepoints and nothing speculative: no scene previews, no
weight matrices, no extra glyph planes.

Subsets are disk-cached under the catalog directory
(``<catalog_dir>/previews/``) keyed by the source face's checksum plus
the display names, so a name change (or a healed face with different
bytes) regenerates instead of serving stale glyphs, and a restart serves
the cache without paying the subsetting cost again. Generation writes a
temp file and atomically replaces the target, so a killed run leaves no
half-written preview behind.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

from fontTools import subset

#: The directory under the catalog cache the subsets live in.
PREVIEW_DIR = "previews"

#: Temp suffix of an in-flight subset write (swept by regeneration).
PART_SUFFIX = ".part"


def preview_cache_dir(catalog_dir: Path) -> Path:
    """The previews directory under one catalog cache directory."""
    return catalog_dir / PREVIEW_DIR


def preview_key(source_sha: str, names: list[str] | tuple[str, ...]) -> str:
    """The cache key: the source face's checksum plus the names.

    Names are part of the key ON PURPOSE: a renamed family regenerates
    (the new glyphs may not be in the old subset), while an unchanged
    name plus unchanged source is a permanent cache hit — the artifact
    is immutable, exactly like the face bytes it derives from.
    """
    material = source_sha + "\n" + "\n".join(names)
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def ensure_preview(
    source: Path, source_sha: str, names: list[str] | tuple[str, ...], cache_dir: Path
) -> tuple[Path, str]:
    """The subset for one family, generated on miss, cached on hit.

    Returns the artifact's path and its key (the serve's ETag truth).
    The source face is read once; the output is a plain TTF whose cmap
    covers the name codepoints the source itself covered (a name the
    source cannot draw is absent from the subset — never synthesized).
    """
    key = preview_key(source_sha, names)
    target = cache_dir / f"preview-{key}.ttf"
    if target.is_file():
        return target, key

    cache_dir.mkdir(parents=True, exist_ok=True)
    # Stray temp files from a killed run never count as artifacts.
    for stray in cache_dir.glob(f"*{PART_SUFFIX}"):
        try:
            stray.unlink()
        except OSError:
            pass

    unicodes = sorted(
        {ord(character) for name in names for character in name if not character.isspace()}
    )
    options = subset.Options()
    options.hinting = False  # a name ribbon does not need it
    font = subset.load_font(str(source), options)
    try:
        subsetter = subset.Subsetter(options)
        subsetter.populate(unicodes=unicodes)
        subsetter.subset(font)
        font.flavor = None  # whatever the source was, the preview is a TTF
        temp = cache_dir / f"preview-{key}.ttf{PART_SUFFIX}"
        subset.save_font(font, str(temp), options)
        temp.replace(target)
    finally:
        font.close()
    return target, key
