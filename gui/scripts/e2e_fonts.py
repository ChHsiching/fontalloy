"""Tiny synthetic fonts for the GUI synthesize e2e suite.

The seam-3 synthesize spec drives a REAL `fontalloy serve` subprocess
against these fixtures: a Latin base (26 glyphs, one per ASCII letter)
and a CJK donor whose glyph count is deliberately large enough that a
build takes observable seconds — the test needs to catch a build
mid-flight to prove progress visibility and that the app stays usable
while the pipeline runs.

Same recipe as the core suite's conftest synth harness (deterministic
fonts, pinned head timestamps); kept standalone so the Playwright
bootstrap only needs a plain `python` with fontTools, never pytest.

Usage: python e2e-fonts.py <output-dir> [--donor-glyphs N]
Writes base.ttf and donor.ttf into <output-dir>.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

#: Fixed head timestamps (2026-01-01 UTC): deterministic, no wall clock.
FIXED_TIMESTAMP = 1767225600

#: Base coverage: ASCII uppercase letters.
BASE_CODEPOINTS = tuple(range(0x41, 0x5B))

#: Donor coverage: a contiguous run of CJK ideographs starting at 一.
DONOR_FIRST = 0x4E00

#: The round-18 placeholder run's first codepoint (private use area).
PLACEHOLDER_FIRST = 0xE000


def _box_glyph(x_min: int, y_min: int, x_max: int, y_max: int):
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
    advance: int = 600,
    weight: int = 400,
    style: str = "Regular",
    italic: bool = False,
    placeholder_codepoints: tuple[int, ...] = (),
) -> None:
    """Write a small synthetic TTF covering exactly ``codepoints``.

    ``weight``/``style`` name the face's own identity (OS/2
    usWeightClass, the italic bits, the name table's subfamily) so one
    ``family`` can ship several faces — the round-12 family-pick
    fixtures: a Regular/Bold/Italic trio that parses to ONE css family
    with a real weight matrix.

    ``placeholder_codepoints`` (round 18) all map to ONE shared
    ``placeholderBox`` glyph — the fake-coverage shape the placeholder
    heuristic must catch (a font drawing a box at codepoints it does
    not really cover).
    """
    glyph_names = [".notdef", "placeholderBox"] + [
        f"uni{cp:04X}" for cp in codepoints
    ]
    glyphs = {
        ".notdef": _box_glyph(0, 0, 500, 700),
        "placeholderBox": _box_glyph(60, 60, 540, 640),
    }
    metrics = {".notdef": (advance, 40), "placeholderBox": (advance, 40)}
    for index, cp in enumerate(codepoints):
        # Distinct ink height per codepoint so a glyph is traceable to
        # its font of origin (same trick as the core fixtures).
        glyphs[f"uni{cp:04X}"] = _box_glyph(
            40, 0, advance - 40, 300 + (100 * (index % 5))
        )
        metrics[f"uni{cp:04X}"] = (advance, 40)

    builder = FontBuilder(unitsPerEm=1000, isTTF=True)
    builder.setupGlyphOrder(glyph_names)
    builder.setupCharacterMap(
        {cp: f"uni{cp:04X}" for cp in codepoints}
        | {cp: "placeholderBox" for cp in placeholder_codepoints}
    )
    builder.setupGlyf(glyphs)
    builder.setupHorizontalMetrics(metrics)
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    builder.setupOS2(
        sTypoAscender=800,
        sTypoDescender=-200,
        usWinAscent=900,
        usWinDescent=300,
        usWeightClass=weight,
    )
    builder.setupNameTable({"familyName": family, "styleName": style})
    builder.setupPost()
    builder.setupHead(
        unitsPerEm=1000, created=FIXED_TIMESTAMP, modified=FIXED_TIMESTAMP
    )
    font = builder.font
    if italic:
        # The italic bits both the core and the browser read.
        font["OS/2"].fsSelection = (font["OS/2"].fsSelection & ~0x40) | 0x01
        font["head"].macStyle |= 0x02
    builder.save(path)


#: The round-12 family-pick fixture: one family, three faces — the
#: weight matrix a catalog pick registers (Regular 400, Bold 700,
#: Italic 400-italic; RIBBI subfamilies keep the shared family name).
FAMILY_FACES = (
    ("Regular", 400, False),
    ("Bold", 700, False),
    ("Italic", 400, True),
)


def synth_family(outdir: Path, *, family: str, stem: str) -> list[Path]:
    """Write the family's faces as ``<stem>-<Subfamily>.ttf`` files."""
    paths = []
    for style, weight, italic in FAMILY_FACES:
        path = outdir / f"{stem}-{style}.ttf"
        synth_font(
            path,
            family=family,
            codepoints=BASE_CODEPOINTS,
            weight=weight,
            style=style,
            italic=italic,
        )
        paths.append(path)
    return paths


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("outdir", type=Path)
    parser.add_argument(
        "--donor-glyphs",
        type=int,
        default=2000,
        help="glyph count of the CJK donor (build duration knob)",
    )
    parser.add_argument(
        "--donor-ascii",
        type=int,
        default=0,
        help="the donor ALSO covers the first N ASCII letters "
        "(overlap knob: makes override cases observable)",
    )
    parser.add_argument(
        "--placeholder-donor",
        type=int,
        default=0,
        help="the donor ALSO maps N private-use codepoints onto ONE "
        "shared box glyph (round 18: the fake-coverage fixture the "
        "placeholder heuristic must catch)",
    )
    parser.add_argument(
        "--family",
        action="store_true",
        help="write a three-face family (Regular/Bold/Italic, one "
        "shared family name) instead of the base/donor pair — the "
        "round-12 family-pick fixture",
    )
    parser.add_argument(
        "--family-name",
        default="Alloy Family",
        help="the family fixture's family name (--family only)",
    )
    parser.add_argument(
        "--family-stem",
        default="AlloyFamily",
        help="the family fixture's file stem (--family only)",
    )
    args = parser.parse_args()

    args.outdir.mkdir(parents=True, exist_ok=True)
    if args.family:
        paths = synth_family(
            args.outdir,
            family=args.family_name,
            stem=args.family_stem,
        )
        print("wrote " + ", ".join(str(p) for p in paths))
        return 0
    synth_font(
        args.outdir / "base.ttf",
        family="AlloyBase",
        codepoints=BASE_CODEPOINTS,
    )
    donor_codepoints = tuple(
        range(DONOR_FIRST, DONOR_FIRST + args.donor_glyphs)
    ) + tuple(range(0x41, 0x41 + args.donor_ascii))
    synth_font(
        args.outdir / "donor.ttf",
        family="AlloyDonor",
        codepoints=donor_codepoints,
        placeholder_codepoints=tuple(
            range(PLACEHOLDER_FIRST, PLACEHOLDER_FIRST + args.placeholder_donor)
        ),
    )
    print(f"wrote {args.outdir / 'base.ttf'} and {args.outdir / 'donor.ttf'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
