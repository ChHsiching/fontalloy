"""Seam 1 tests: glyph grafting and the rebuilt cmap (issue #5).

The base font is the container (ADR-0001): donor glyphs move in per the
effective table and the cmap is rebuilt. The oracle is fontTools reading
the built font back — cmap coverage, per-codepoint glyph provenance,
composite integrity, and the base font's pass-through identity. Fixture
fonts stay synthetic (the harness in conftest.py).
"""

from __future__ import annotations

from pathlib import Path

from fontTools.ttLib import TTFont

from conftest import BASE_CODEPOINTS, DONOR_CODEPOINTS
from fontalloy_core import build


class TestFillGraft:
    """The default merge: donor glyphs fill slots the base font lacks."""

    def test_donor_glyphs_land_in_the_output_font(
        self, recipe_file: Path, tmp_path: Path, base_font: Path, donor_font: Path
    ):
        result = build(recipe_file, tmp_path / "out.ttf")

        out = TTFont(result.font_path)
        cmap = out.getBestCmap()
        # The rebuilt cmap covers the union of the effective table.
        assert set(cmap) == {*BASE_CODEPOINTS, *DONOR_CODEPOINTS}

        # A grafted glyph is real: it has outlines and the donor's own
        # advance and side bearing (nothing is scaled at this stage).
        donor = TTFont(donor_font)
        donor_cmap = donor.getBestCmap()
        for cp in DONOR_CODEPOINTS:
            name = cmap[cp]
            assert name in out["glyf"].keys()
            assert out["hmtx"][name] == donor["hmtx"][donor_cmap[cp]]

        # The base glyphs are untouched: same name, same metrics.
        base = TTFont(base_font)
        base_cmap = base.getBestCmap()
        for cp in BASE_CODEPOINTS:
            name = cmap[cp]
            assert name == base_cmap[cp]
            assert out["hmtx"][name] == base["hmtx"][base_cmap[cp]]
