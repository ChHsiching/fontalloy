"""Generate the synthetic fonts the WebApp serve e2e suite merges.

The seam-3 WebApp tests (issue #22) drive a real ``fontalloy serve``
instance; the fonts it merges are small synthetic fixtures, never the
catalog (the seam-1 principle). Deterministic like ``tests/conftest.py``:
a fixed ``head`` timestamp keeps regeneration reproducible, and the slow
donor — a wide CJK block with fixed-height ink, since int16 yMax caps
the shared ``synth_font``'s growing ink — keeps a build observably in
flight (a couple of seconds) so polling/progress is assertable instead
of racy.

Usage (the web test bootstrap runs this through the project env):

    uv run python web/scripts/make-serve-fixture-fonts.py <output-dir>
"""

from __future__ import annotations

import sys
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

#: tests/conftest.py's FIXED_TIMESTAMP — a pinned, reproducible moment.
FIXED_TIMESTAMP = 1767225600

#: The slow donor's coverage: 0x4E00 .. 0x4E00+SLOW_CODEPOINTS-1.
SLOW_CODEPOINTS = 30_000


def _box(x_min: int, y_min: int, x_max: int, y_max: int):
    pen = TTGlyphPen(None)
    pen.moveTo((x_min, y_min))
    pen.lineTo((x_max, y_min))
    pen.lineTo((x_max, y_max))
    pen.lineTo((x_min, y_max))
    pen.closePath()
    return pen.glyph()


def synth_font(
    path: Path,
    *,
    family: str,
    codepoints: tuple[int, ...],
    weight: int = 400,
) -> Path:
    """Write a tiny TTF covering exactly ``codepoints`` with box ink."""
    glyph_names = [".notdef"] + [f"uni{cp:04X}" for cp in codepoints]
    glyphs: dict[str, object] = {".notdef": _box(0, 0, 500, 700)}
    glyphs.update(
        {f"uni{cp:04X}": _box(40, 0, 559, 700) for cp in codepoints}
    )
    builder = FontBuilder(unitsPerEm=1000, isTTF=True)
    builder.setupGlyphOrder(glyph_names)
    builder.setupCharacterMap({cp: f"uni{cp:04X}" for cp in codepoints})
    builder.setupGlyf(glyphs)  # type: ignore[arg-type]
    builder.setupHorizontalMetrics({name: (600, 40) for name in glyph_names})
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWeightClass=weight)
    builder.setupNameTable({"familyName": family, "styleName": "Regular"})
    builder.setupPost()
    builder.setupHead(
        unitsPerEm=1000, created=FIXED_TIMESTAMP, modified=FIXED_TIMESTAMP
    )
    builder.save(path)
    return path


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    out_dir = Path(sys.argv[1])
    out_dir.mkdir(parents=True, exist_ok=True)
    synth_font(out_dir / "Alpha.ttf", family="WebServeAlpha", codepoints=(0x41, 0x42))
    synth_font(
        out_dir / "Beta.ttf", family="WebServeBeta", codepoints=(0x61, 0x62), weight=700
    )
    synth_font(
        out_dir / "Slow.ttf",
        family="WebServeSlow",
        codepoints=tuple(range(0x4E00, 0x4E00 + SLOW_CODEPOINTS)),
    )
    for name in ("Alpha.ttf", "Beta.ttf", "Slow.ttf"):
        print(f"wrote {out_dir / name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
