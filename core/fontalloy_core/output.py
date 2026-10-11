"""Pipeline stage 7, the output side: format selection and the save boundary.

This is the single place a built font is written to disk (the
"determinism gate"): every format the v1 tiers define saves through
:func:`save_output`, which pins each face's ``head.created`` /
``head.modified`` and disables timestamp recalculation, so no wall clock
ever reaches the output. Identical pinned inputs therefore rebuild
byte-identically — for TTC, byte-identical face bytes are also what lets
``TTCollection.save`` dedup shared tables (sharing is content-keyed, so
any accidental per-face nondeterminism silently defeats it; see
fonttools#4110).

Format tiers (spec, "v1 format tiers"):

- ``ttf`` (default, required tier): one merged face, a plain TrueType
  font — whatever the inputs were (TTF, OTF/CFF, TTC face, instantiated
  variable font, decoded woff2), the graft always lands in TrueType
  outlines.
- ``ttc`` (expected tier): one merged face per selected face of the base
  font file, packaged as a TrueType Collection with shared-table dedup
  (``shareTables=True``): tables compiling to identical bytes — the
  grafted donor glyphs above all — are stored once and pointed at by
  every face, so the collection is measurably smaller than the sum of
  equivalent standalone TTF builds.
- ``woff2`` (optional tier): the single merged face, brotli-compressed
  via ``font.flavor = "woff2"``. Byte-stability of the compressed output
  is scoped to the brotli build (pinned in the lockfile): brotli does
  not guarantee cross-version byte stability, so the byte-identical
  acceptance gate covers TTF and TTC; woff2 is verified byte-identical
  within one environment.

``head.checkSumAdjustment`` is never pinned by hand: the writer always
recomputes it as a pure function of the table bytes, which is
deterministic whenever the tables are.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

from fontTools.ttLib import TTCollection, TTFont

from fontalloy_core.errors import BuildError

#: The output formats a build can write (the v1 format tiers).
OUTPUT_FORMATS = ("ttf", "ttc", "woff2")

#: The default output format: the required tier, always available.
DEFAULT_OUTPUT_FORMAT = "ttf"

#: Fallback timestamp pin (2026-01-01T00:00:00Z) for base fonts whose
#: ``head.created`` is unset (0) — the pin must be a constant, never a
#: clock reading, for builds to reproduce byte-identically.
FALLBACK_TIMESTAMP = 1767225600


def save_output(
    fonts: Sequence[TTFont],
    output: Path,
    output_format: str,
    *,
    timestamp: int,
) -> None:
    """Write the built face(s) to ``output`` in ``output_format``.

    ``fonts`` carries one merged face per output face (a TTC packages
    them all; the other formats take exactly one). ``timestamp`` is the
    pinned ``head.created``/``head.modified`` every face receives —
    derived from the base font (see :func:`output_timestamp`), never
    from the wall clock.

    Raises :class:`~fontalloy_core.errors.BuildError` for an unknown
    format, a face-count mismatch, or an unwritable output path.
    """
    if output_format not in OUTPUT_FORMATS:
        raise BuildError(
            f"unknown output format {output_format!r} "
            f"(the build accepts: {', '.join(OUTPUT_FORMATS)})"
        )
    if not fonts:
        raise BuildError("cannot save a build with no faces")

    try:
        if output_format == "ttc":
            for font in fonts:
                _pin_timestamps(font, timestamp)
            collection = TTCollection()
            collection.fonts = list(fonts)
            # shareTables=True (the default): content-keyed dedup —
            # tables compiling to identical bytes are written once.
            collection.save(output)
        else:
            if len(fonts) != 1:
                raise BuildError(
                    f"the {output_format!r} output carries exactly one face "
                    f"(got {len(fonts)}; use the 'ttc' format for a collection)"
                )
            font = fonts[0]
            _pin_timestamps(font, timestamp)
            font.flavor = "woff2" if output_format == "woff2" else None
            font.save(output)
    except OSError as exc:
        raise BuildError(f"cannot write the output font: {output} ({exc})") from None


def output_timestamp(base_fonts: Sequence[TTFont]) -> int:
    """The reproducible timestamp pin for a build's output.

    The output inherits the base font's own ``head.created`` (the build
    is the base font's identity extended, and a constant read from a
    pinned input); fonts without one fall back to
    :data:`FALLBACK_TIMESTAMP`. All faces of one build share the pin so
    that faces whose tables would otherwise be identical still dedup.
    """
    for font in base_fonts:
        created = int(font["head"].created)
        if created:
            return created
    return FALLBACK_TIMESTAMP


def _pin_timestamps(font: TTFont, timestamp: int) -> None:
    """Stamp one face reproducibly and freeze it for the save.

    ``recalcTimestamp = False`` is what keeps ``save()`` from restamping
    ``head.modified`` with ``timestampNow()``; in a TTC save,
    ``TTCollection`` only force-stamps faces whose ``recalcTimestamp``
    is on, so frozen faces keep their pin untouched.
    """
    head = font["head"]
    head.created = timestamp
    head.modified = timestamp
    font.recalcTimestamp = False
