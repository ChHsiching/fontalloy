"""Shared fixtures: the synthetic fixture-font harness and the seam-2 CLI
harness.

Every font the test suite uses is a small synthetic font generated in-test
with fontTools — the repo never contains font binaries, and no test
touches the catalog. Fonts are deterministic (pinned head timestamps), so
build outputs and reports are byte-reproducible.
"""

from __future__ import annotations

import os
import subprocess
import sys
from collections.abc import Callable, Sequence
from pathlib import Path

import pytest
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTCollection, TTFont
from fontTools.ttLib.tables.TupleVariation import TupleVariation

#: Coverage of the default base fixture: two Latin codepoints.
BASE_CODEPOINTS = (0x41, 0x42)
#: Coverage of the default donor fixture: two CJK codepoints, disjoint
#: from the base so provenance is assertable per codepoint.
DONOR_CODEPOINTS = (0x4E2D, 0x56FD)

#: Fixed head timestamps (2026-01-01 UTC): fixtures are deterministic and
#: carry no wall-clock, so build outputs stay byte-reproducible.
FIXED_TIMESTAMP = 1767225600


def synth_font(
    path: Path | str,
    *,
    family: str,
    codepoints: tuple[int, ...],
    upem: int = 1000,
    advance: int = 600,
    weight: int = 400,
    subfamily: str = "Regular",
    italic: bool = False,
    typographic_family: str | None = None,
    ink_dy: int = 0,
) -> Path:
    """Write a small synthetic TTF covering exactly ``codepoints``.

    ``ink_dy`` shifts every mapped glyph's ink vertically (the ink height
    is unchanged) so tests can tell a translated/scaled glyph from an
    unscaled one by its baseline-relative bounds.
    """
    font = _build_font_object(
        family,
        codepoints,
        upem=upem,
        advance=advance,
        weight=weight,
        subfamily=subfamily,
        italic=italic,
        typographic_family=typographic_family,
        ink_dy=ink_dy,
    )
    font.save(path)
    return Path(path)


def synth_ttc(
    path: Path | str,
    faces: Sequence[dict],
) -> Path:
    """Write a tiny TTC collection with one face per ``faces`` entry.

    Each entry is keyword arguments for the underlying synthetic font:
    ``family``, ``codepoints``, ``weight``, ``subfamily``... Faces of one
    collection typically share a family and differ in weight/coverage.
    """
    fonts = [_build_font_object(**face) for face in faces]
    collection = TTCollection()
    collection.fonts = fonts
    collection.save(path)
    return Path(path)


def synth_variable_font(
    path: Path | str,
    *,
    family: str,
    codepoints: tuple[int, ...],
    axes: Sequence[tuple[str, float, float, float]] = (("wght", 100, 400, 900),),
) -> Path:
    """Write a tiny variable TTF with an fvar and a gvar per axis.

    The gvar deltas grow each glyph vertically toward each axis maximum,
    so a pinned instance is distinguishable from the default instance by
    glyph geometry, not just by table presence.
    """
    glyph_names = [".notdef"] + [f"uni{cp:04X}" for cp in codepoints]
    glyphs: dict[str, object] = {".notdef": _box_glyph(0, 0, 500, 700)}
    for index, cp in enumerate(codepoints):
        glyphs[f"uni{cp:04X}"] = _box_glyph(40, 0, 559, 300 + 100 * (index + 1))

    builder = FontBuilder(unitsPerEm=1000, isTTF=True)
    builder.setupGlyphOrder(glyph_names)
    builder.setupCharacterMap({cp: f"uni{cp:04X}" for cp in codepoints})
    builder.setupGlyf(glyphs)  # type: ignore[arg-type]
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
    builder.setupHead(created=FIXED_TIMESTAMP, modified=FIXED_TIMESTAMP)
    builder.setupFvar(
        [(tag, lo, default, hi, tag.upper()) for tag, lo, default, hi in axes],
        [],
    )
    variations = {
        name: [
            # 4 real contour points + 4 phantom points per glyph; the top
            # two points rise by 300 units at each axis maximum.
            TupleVariation(
                {tag: (0.0, 1.0, 1.0) for tag, _lo, _default, _hi in axes},
                [(0, 0), (0, 0), (0, 300), (0, 300), (0, 0), (0, 0), (0, 0), (0, 0)],
            )
        ]
        for name in glyph_names[1:]
    }
    builder.setupGvar(variations)
    builder.save(path)
    return Path(path)


def synth_woff2(
    path: Path | str,
    *,
    family: str,
    codepoints: tuple[int, ...],
    weight: int = 400,
) -> Path:
    """Write a tiny woff2 (a re-compressed synthetic TTF)."""
    font = _build_font_object(family, codepoints, weight=weight)
    font.flavor = "woff2"
    font.save(path)
    return Path(path)


def _build_font_object(
    family: str,
    codepoints: tuple[int, ...],
    *,
    upem: int = 1000,
    advance: int = 600,
    weight: int = 400,
    subfamily: str = "Regular",
    italic: bool = False,
    typographic_family: str | None = None,
    ink_dy: int = 0,
) -> TTFont:
    """Build (but do not save) a synthetic single-face font."""
    glyph_names = [".notdef"] + [f"uni{cp:04X}" for cp in codepoints]
    glyphs: dict[str, object] = {".notdef": _box_glyph(0, 0, 500, 700)}
    for index, cp in enumerate(codepoints):
        # Distinct ink height per codepoint so a glyph is traceable to its font.
        glyphs[f"uni{cp:04X}"] = _box_glyph(
            40, ink_dy, advance - 40, ink_dy + 300 + 100 * (index + 1)
        )

    builder = FontBuilder(unitsPerEm=upem, isTTF=True)
    builder.setupGlyphOrder(glyph_names)
    builder.setupCharacterMap({cp: f"uni{cp:04X}" for cp in codepoints})
    builder.setupGlyf(glyphs)  # type: ignore[arg-type]
    builder.setupHorizontalMetrics({name: (advance, 40) for name in glyph_names})
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    # Sane win metrics (fontBuilder's zero defaults would make every ink
    # "clip"): ascent 900 / descent 300 sit above the tallest fixture ink
    # unless a test deliberately grafts taller ink.
    builder.setupOS2(
        sTypoAscender=800,
        sTypoDescender=-200,
        usWinAscent=900,
        usWinDescent=300,
        usWeightClass=weight,
    )
    if italic:
        builder.font["OS/2"].fsSelection |= 0x01  # ITALIC bit
    builder.setupNameTable({"familyName": family, "styleName": subfamily})
    if typographic_family is not None:
        name_table = builder.font["name"]
        name_table.setName(typographic_family, 16, 3, 1, 0x409)
        name_table.setName(subfamily, 17, 3, 1, 0x409)
    builder.setupPost()
    builder.setupHead(unitsPerEm=upem, created=FIXED_TIMESTAMP, modified=FIXED_TIMESTAMP)
    return builder.font


def _box_glyph(x_min: int, y_min: int, x_max: int, y_max: int):
    pen = TTGlyphPen(None)
    pen.moveTo((x_min, y_min))
    pen.lineTo((x_max, y_min))
    pen.lineTo((x_max, y_max))
    pen.lineTo((x_min, y_max))
    pen.closePath()
    return pen.glyph()


def _composite_glyph(component: str, dx: int, dy: int, glyph_set: dict):
    pen = TTGlyphPen(glyph_set)
    pen.addComponent(component, (1, 0, 0, 1, dx, dy))
    return pen.glyph()


def synth_composite_font(
    path: Path | str,
    *,
    family: str,
    upem: int = 1000,
    advance: int = 600,
) -> Path:
    """Write a donor whose mapped glyph is a nested composite.

    The mapped codepoint 0x4E09 draws as a composite over the unmapped
    glyph ``uni4E8C``, itself a composite over the unmapped simple glyph
    ``uni4E00`` — two closure levels that only the unmapped chain can
    exercise. Offsets are distinct so re-pointing is observable.
    """
    glyph_names = [".notdef", "uni4E00", "uni4E8C", "uni4E09"]
    glyphs: dict[str, object] = {
        ".notdef": _box_glyph(0, 0, 500, 700),
        "uni4E00": _box_glyph(0, 0, 400, 350),
    }
    # Composites are built over the growing glyph set (the pen validates
    # component names against it), in dependency order.
    glyphs["uni4E8C"] = _composite_glyph("uni4E00", 100, 50, glyphs)
    glyphs["uni4E09"] = _composite_glyph("uni4E8C", -30, 20, glyphs)
    builder = FontBuilder(unitsPerEm=upem, isTTF=True)
    builder.setupGlyphOrder(glyph_names)
    builder.setupCharacterMap({0x4E09: "uni4E09"})
    builder.setupGlyf(glyphs)  # type: ignore[arg-type]
    builder.setupHorizontalMetrics({name: (advance, 40) for name in glyph_names})
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
    builder.setupHead(unitsPerEm=upem, created=FIXED_TIMESTAMP, modified=FIXED_TIMESTAMP)
    builder.save(path)
    return Path(path)


def _t2_box_glyph(x_min: int, y_min: int, x_max: int, y_max: int, advance: int):
    pen = T2CharStringPen(advance, None)
    pen.moveTo((x_min, y_min))
    pen.lineTo((x_max, y_min))
    pen.lineTo((x_max, y_max))
    pen.lineTo((x_min, y_max))
    pen.closePath()
    return pen.getCharString()


def synth_cff_font(
    path: Path | str,
    *,
    family: str,
    upem: int = 1000,
    advance: int = 600,
) -> Path:
    """Write a CFF (OTF) donor covering 0x4E2D and 0x56FD.

    CFF charstrings are built with T2CharStringPen (plain TrueType
    ``Glyph`` objects do not compile into CFF). Distinct ink heights per
    codepoint keep glyphs traceable to the donor, like the TTF fixtures.
    """
    glyph_names = [".notdef", "uni4E2D", "uni56FD"]
    glyphs = {
        ".notdef": _t2_box_glyph(0, 0, 500, 700, advance),
        "uni4E2D": _t2_box_glyph(40, 0, advance - 40, 400, advance),
        "uni56FD": _t2_box_glyph(40, 0, advance - 40, 500, advance),
    }

    builder = FontBuilder(unitsPerEm=upem, isTTF=False)
    builder.setupGlyphOrder(glyph_names)
    builder.setupCharacterMap({0x4E2D: "uni4E2D", 0x56FD: "uni56FD"})
    builder.setupCFF(family, {"FullName": family}, glyphs, {})
    builder.setupHorizontalMetrics({name: (advance, 40) for name in glyph_names})
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
    builder.setupHead(unitsPerEm=upem, created=FIXED_TIMESTAMP, modified=FIXED_TIMESTAMP)
    builder.save(path)
    return Path(path)


@pytest.fixture
def synth_font_factory() -> Callable[..., Path]:
    """Factory for synthetic fonts; returns the written font's path."""
    return synth_font


@pytest.fixture
def synth_ttc_factory() -> Callable[..., Path]:
    """Factory for synthetic TTC collections; returns the written path."""
    return synth_ttc


@pytest.fixture
def synth_variable_font_factory() -> Callable[..., Path]:
    """Factory for synthetic variable fonts; returns the written path."""
    return synth_variable_font


@pytest.fixture
def synth_woff2_factory() -> Callable[..., Path]:
    """Factory for synthetic woff2 files; returns the written path."""
    return synth_woff2


@pytest.fixture
def base_font(tmp_path: Path, synth_font_factory: Callable[..., Path]) -> Path:
    """A synthetic base font covering two Latin codepoints."""
    return synth_font_factory(
        tmp_path / "base.ttf", family="SynthBase", codepoints=BASE_CODEPOINTS
    )


@pytest.fixture
def donor_font(tmp_path: Path, synth_font_factory: Callable[..., Path]) -> Path:
    """A synthetic donor font covering two CJK codepoints (disjoint from the base)."""
    return synth_font_factory(
        tmp_path / "donor.ttf", family="SynthDonor", codepoints=DONOR_CODEPOINTS
    )


@pytest.fixture
def recipe_file(tmp_path: Path, base_font: Path, donor_font: Path) -> Path:
    """A minimal v0 recipe: base font file plus one donor font file."""
    recipe = tmp_path / "recipe.yaml"
    recipe.write_text(
        f"base: {base_font.name}\ndonors:\n  - {donor_font.name}\n",
        encoding="utf-8",
    )
    return recipe


# --- seam-2 harness: the real fontalloy executable as a subprocess ---------


@pytest.fixture
def fontalloy_exe() -> Path:
    """The installed console script next to this interpreter."""
    name = "fontalloy.exe" if os.name == "nt" else "fontalloy"
    exe = Path(sys.executable).parent / name
    assert exe.is_file(), (
        f"the fontalloy executable is not installed next to python: {exe} "
        "(run the suite through `uv run pytest`)"
    )
    return exe


def run_cli(exe: Path, *args: str, cwd: Path) -> subprocess.CompletedProcess[str]:
    """Run the fontalloy executable as a real subprocess, UTF-8 safe."""
    return subprocess.run(
        [str(exe), *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
    )
