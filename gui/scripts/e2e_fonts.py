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
Writes base.ttf and donor.ttf into <output-dir>. --family writes a
three-face family; --ttc writes a three-face collection.
"""

from __future__ import annotations

import argparse
import io
import sys
from pathlib import Path
from typing import BinaryIO

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTCollection, TTFont

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
    path: Path | BinaryIO,
    *,
    family: str,
    codepoints: tuple[int, ...],
    advance: int = 600,
    weight: int = 400,
    style: str = "Regular",
    italic: bool = False,
    placeholder_codepoints: tuple[int, ...] = (),
    shared_codepoints: tuple[int, ...] = (),
) -> None:
    """Write a small synthetic TTF covering exactly ``codepoints``.

    ``weight``/``style`` name the face's own identity (OS/2
    usWeightClass, the italic bits, the name table's subfamily) so one
    ``family`` can ship several faces — the round-12 family-pick
    fixtures: a Regular/Bold/Italic trio that parses to ONE css family
    with a real weight matrix.

    ``placeholder_codepoints`` (round 18, round 19) all map to ONE
    shared ``placeholderBox`` glyph whose outline IS ``.notdef``'s —
    the fake-coverage shape the outline rule must catch (a font drawing
    its own tofu box under another name at codepoints it does not
    really cover).

    ``shared_codepoints`` (round 19) map to one ``sharedBox`` glyph
    with its OWN outline — the concentration NEGATIVE: a shared glyph
    of real shape keeps counting as plain coverage.
    """
    glyph_names = [".notdef", "placeholderBox", "sharedBox"] + [
        f"uni{cp:04X}" for cp in codepoints
    ]
    glyphs = {
        ".notdef": _box_glyph(0, 0, 500, 700),
        "placeholderBox": _box_glyph(0, 0, 500, 700),
        "sharedBox": _box_glyph(60, 60, 540, 640),
    }
    metrics = {
        ".notdef": (advance, 40),
        "placeholderBox": (advance, 40),
        "sharedBox": (advance, 40),
    }
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
        | {cp: "sharedBox" for cp in shared_codepoints}
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
# weight matrix a catalog pick registers (Regular 400, Bold 700,
# Italic 400-italic; RIBBI subfamilies keep the shared family name).
FAMILY_FACES = (
    ("Regular", 400, False),
    ("Bold", 700, False),
    ("Italic", 400, True),
)


def _t2_box_glyph(x_min, y_min, x_max, y_max, advance):
    pen = T2CharStringPen(advance, None)
    pen.moveTo((x_min, y_min))
    pen.lineTo((x_max, y_min))
    pen.lineTo((x_max, y_max))
    pen.lineTo((x_min, y_max))
    pen.closePath()
    return pen.getCharString()


def synth_cff_donor(
    path: Path,
    *,
    codepoints: tuple[int, ...],
    placeholder_codepoints: tuple[int, ...] = (),
    family: str = "AlloyDonor",
) -> None:
    """Write the donor as a CFF (OTF) face instead of a TTF one.

    Same coverage skeleton as the TTF donor — the shared placeholder
    glyph carries ``.notdef``'s outline (round 19) — so the GUI's CFF
    parse path (charstring INDEX compare) is testable exactly like the
    glyf one.
    """
    glyph_names = [".notdef", "placeholderBox"] + [
        f"uni{cp:04X}" for cp in codepoints
    ]
    glyphs = {
        ".notdef": _t2_box_glyph(0, 0, 500, 700, 600),
        "placeholderBox": _t2_box_glyph(0, 0, 500, 700, 600),
    }
    for index, cp in enumerate(codepoints):
        glyphs[f"uni{cp:04X}"] = _t2_box_glyph(
            40, 0, 560, 300 + (100 * (index % 5)), 600
        )

    builder = FontBuilder(unitsPerEm=1000, isTTF=False)
    builder.setupGlyphOrder(glyph_names)
    builder.setupCharacterMap(
        {cp: f"uni{cp:04X}" for cp in codepoints}
        | {cp: "placeholderBox" for cp in placeholder_codepoints}
    )
    builder.setupCFF(family, {"FullName": family}, glyphs, {})
    builder.setupHorizontalMetrics({name: (600, 40) for name in glyph_names})
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    builder.setupOS2(
        sTypoAscender=800,
        sTypoDescender=-200,
        usWinAscent=900,
        usWinDescent=300,
        usWeightClass=400,
    )
    builder.setupNameTable({"familyName": family, "styleName": "Regular"})
    builder.setupPost()
    builder.setupHead(
        unitsPerEm=1000, created=FIXED_TIMESTAMP, modified=FIXED_TIMESTAMP
    )
    builder.save(path)


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


#: The round-19 collection fixture: three faces with DISTINCT family
#: names (the local-load path registers every face as its own font), the
#: first two Latin cuts (identical glyph programs, so ``shareTables=True``
#: dedups their glyf/cmap/loca into the shared region exactly like the
#: pipeline's own ttc output) and one CJK face.
TTC_FACES = (
    ("Alloy TTC One", "Regular", 400, BASE_CODEPOINTS),
    ("Alloy TTC Two", "Bold", 700, BASE_CODEPOINTS),
    ("Alloy TTC CJK", "Regular", 400, tuple(range(DONOR_FIRST, DONOR_FIRST + 120))),
)


def synth_ttc(outdir: Path, *, stem: str = "AlloyTTC") -> Path:
    """Write a real three-face .ttc (shared-table dedup, like the build).

    The member faces are built in memory: the only file the directory
    gains is the collection itself, so a test directory holds exactly
    what the fixture promises.
    """
    faces = []
    for family, style, weight, codepoints in TTC_FACES:
        member = io.BytesIO()
        synth_font(
            member,
            family=family,
            codepoints=codepoints,
            style=style,
            weight=weight,
        )
        member.seek(0)
        faces.append(TTFont(member))
    collection = TTCollection()
    collection.fonts = faces
    path = outdir / f"{stem}.ttc"
    collection.save(path, shareTables=True)
    for face in faces:
        face.close()
    return path


#: The round-20 REAL-family fixture: sixteen faces of ONE family (the
#: JetBrainsMono Nerd Font cut's own weight × style matrix), derived
#: from the real release binary — the shape the pipeline's own ttc
#: output carries (every face one name-table family, sixteen weights).
NF_FAMILY_FACES = (
    ("Thin", 100, False),
    ("ThinItalic", 100, True),
    ("ExtraLight", 200, False),
    ("ExtraLightItalic", 200, True),
    ("Light", 300, False),
    ("LightItalic", 300, True),
    ("Regular", 400, False),
    ("Italic", 400, True),
    ("Medium", 500, False),
    ("MediumItalic", 500, True),
    ("SemiBold", 600, False),
    ("SemiBoldItalic", 600, True),
    ("Bold", 700, False),
    ("BoldItalic", 700, True),
    ("ExtraBold", 800, False),
    ("ExtraBoldItalic", 800, True),
)


def synth_nf_family(outdir: Path, src: Path) -> list[Path]:
    """Write a real 16-face JetBrainsMono family over the release binary.

    Each face is the REAL font with its name table, OS/2 weight and
    italic bits rewritten to its slot of the matrix (what the upstream
    release's own family looks like structurally); ``head`` timestamps
    stay pinned. The files name the family cut the pipeline's cut
    pattern resolves: ``JetBrainsMonoNerdFont-*``.
    """
    paths = []
    for style, weight, italic in NF_FAMILY_FACES:
        font = TTFont(src)
        font["head"].created = FIXED_TIMESTAMP
        font["head"].modified = FIXED_TIMESTAMP
        font["OS/2"].usWeightClass = weight
        if italic:
            font["head"].macStyle |= 0x02
            font["OS/2"].fsSelection = (font["OS/2"].fsSelection & ~0x40) | 0x01
        else:
            font["head"].macStyle &= ~0x02
            font["OS/2"].fsSelection &= ~0x01
        subfamily = (
            "Italic"
            if italic and style == "Regular"
            else (f"{style} Italic" if italic else style)
        )
        ribbi = style in ("Regular", "Bold")
        fam1 = "JetBrainsMono NF" if ribbi else f"JetBrainsMono NF {style}"
        sub2 = subfamily if ribbi else ("Italic" if italic else "Regular")
        for rec in font["name"].names:
            if rec.nameID == 1:
                rec.string = fam1
            elif rec.nameID == 2:
                rec.string = sub2
            elif rec.nameID == 4:
                rec.string = f"JetBrainsMono NF {subfamily}"
            elif rec.nameID == 6:
                rec.string = f"JetBrainsMonoNerdFont-{style}{'Italic' if italic else ''}"
        path = outdir / f"JetBrainsMonoNerdFont-{style}{'Italic' if italic else ''}.ttf"
        font.save(path)
        font.close()
        paths.append(path)
    return paths


def synth_subset_donor(outdir: Path, src: Path) -> Path:
    """Write a real donor subset: the first 400 ideographs of 一.

    The full LXGW binary grafts ~45k glyphs per output face; sixteen
    faces over it build for minutes. The subset keeps the bytes real
    (a true fontTools subset of the real font) while the 16-face
    pipeline build stays a suite-viable ~40s.
    """
    from fontTools import subset

    text = "".join(chr(cp) for cp in range(0x4E00, 0x4E00 + 400)) + "AB"
    options = subset.Options()
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.notdef_outline = True
    options.recalc_bounds = False
    options.drop_tables += ["DSIG"]
    font = subset.load_font(str(src), options)
    submitter = subset.Subsetter(options)
    submitter.populate(text=text)
    submitter.subset(font)
    path = outdir / "LXGWSubset-Regular.ttf"
    subset.save_font(font, str(path), options)
    return path


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
        "shared glyph carrying .notdef's outline (round 19: the "
        "fake-coverage fixture the outline rule must catch)",
    )
    parser.add_argument(
        "--shared-glyph-donor",
        type=int,
        default=0,
        help="the donor ALSO maps N private-use codepoints onto ONE "
        "shared glyph with its OWN outline (round 19: the concentration "
        "negative — plain coverage, never a placeholder)",
    )
    parser.add_argument(
        "--cff-donor",
        action="store_true",
        help="write the donor as a CFF (OTF) face instead of a TTF one "
        "(the CFF parse path's fixture; combines with --placeholder-donor)",
    )
    parser.add_argument(
        "--donor-name",
        default="AlloyDonor",
        help="the donor's family name (round 20: a LONG name forces the "
        "report's source sentence to wrap, the geometry the tag-under-"
        "wrap rule pins)",
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
    parser.add_argument(
        "--ttc",
        action="store_true",
        help="write a real three-face .ttc collection (distinct family "
        "names, shared-table dedup) instead of the base/donor pair — "
        "the round-19 local-load fixture",
    )
    parser.add_argument(
        "--ttc-stem",
        default="AlloyTTC",
        help="the collection fixture's file stem (--ttc only)",
    )
    parser.add_argument(
        "--nf-family",
        type=Path,
        metavar="SRC",
        help="write the round-20 REAL 16-face JetBrainsMono family "
        "(weight × style over the given release binary) instead of the "
        "base/donor pair",
    )
    parser.add_argument(
        "--subset-donor",
        type=Path,
        metavar="SRC",
        help="write LXGWSubset-Regular.ttf — a real fontTools subset of "
        "the given donor (the round-20 fast fixture donor)",
    )
    args = parser.parse_args()

    args.outdir.mkdir(parents=True, exist_ok=True)
    if args.nf_family is not None:
        paths = synth_nf_family(args.outdir, args.nf_family)
        print("wrote " + ", ".join(path.name for path in paths))
        return 0
    if args.subset_donor is not None:
        path = synth_subset_donor(args.outdir, args.subset_donor)
        print(f"wrote {path}")
        return 0
    if args.ttc:
        path = synth_ttc(args.outdir, stem=args.ttc_stem)
        print(f"wrote {path}")
        return 0
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
    if args.cff_donor:
        synth_cff_donor(
            args.outdir / "donor.ttf",
            codepoints=donor_codepoints,
            placeholder_codepoints=tuple(
                range(
                    PLACEHOLDER_FIRST,
                    PLACEHOLDER_FIRST + args.placeholder_donor,
                )
            ),
            family=args.donor_name,
        )
    else:
        synth_font(
            args.outdir / "donor.ttf",
            family=args.donor_name,
            codepoints=donor_codepoints,
            placeholder_codepoints=tuple(
                range(PLACEHOLDER_FIRST, PLACEHOLDER_FIRST + args.placeholder_donor)
            ),
            shared_codepoints=tuple(
                range(PLACEHOLDER_FIRST, PLACEHOLDER_FIRST + args.shared_glyph_donor)
            ),
        )
    print(f"wrote {args.outdir / 'base.ttf'} and {args.outdir / 'donor.ttf'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
