"""Shared fixtures: the synthetic fixture-font harness and the seam-2 CLI
harness.

Every font the test suite uses is a small synthetic TTF generated in-test
with fontTools — the repo never contains font binaries, and no test
touches the catalog. Fonts are deterministic (pinned head timestamps), so
build outputs and reports are byte-reproducible.
"""

from __future__ import annotations

import os
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path

import pytest
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

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
) -> Path:
    """Write a small synthetic TTF covering exactly ``codepoints``."""
    glyph_names = [".notdef"] + [f"uni{cp:04X}" for cp in codepoints]
    glyphs: dict[str, object] = {".notdef": _box_glyph(0, 0, 500, 700)}
    for index, cp in enumerate(codepoints):
        # Distinct ink height per codepoint so a glyph is traceable to its font.
        glyphs[f"uni{cp:04X}"] = _box_glyph(40, 0, advance - 40, 300 + 100 * (index + 1))

    builder = FontBuilder(unitsPerEm=upem, isTTF=True)
    builder.setupGlyphOrder(glyph_names)
    builder.setupCharacterMap({cp: f"uni{cp:04X}" for cp in codepoints})
    builder.setupGlyf(glyphs)  # type: ignore[arg-type]
    builder.setupHorizontalMetrics({name: (advance, 40) for name in glyph_names})
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWeightClass=400)
    builder.setupNameTable({"familyName": family, "styleName": "Regular"})
    builder.setupPost()
    builder.setupHead(created=FIXED_TIMESTAMP, modified=FIXED_TIMESTAMP)
    builder.save(path)
    return Path(path)


def _box_glyph(x_min: int, y_min: int, x_max: int, y_max: int):
    pen = TTGlyphPen(None)
    pen.moveTo((x_min, y_min))
    pen.lineTo((x_max, y_min))
    pen.lineTo((x_max, y_max))
    pen.lineTo((x_min, y_max))
    pen.closePath()
    return pen.glyph()


@pytest.fixture
def synth_font_factory() -> Callable[..., Path]:
    """Factory for synthetic fonts; returns the written font's path."""
    return synth_font


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
