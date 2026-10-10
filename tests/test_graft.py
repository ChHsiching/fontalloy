"""Seam 1 tests: glyph grafting and the rebuilt cmap (issue #5, with
the normalization expectations of issue #8 folded in).

The base font is the container (ADR-0001): donor glyphs move in per the
effective table and the cmap is rebuilt. The oracle is fontTools reading
the built font back — cmap coverage, per-codepoint glyph provenance,
composite integrity, and the base font's pass-through identity. Fixture
fonts stay synthetic (the harness in conftest.py).

Since stage 4 (issue #8) donor glyphs land normalized: advances on the
terminal grid, ink scaled by the donor's k, side bearings riding the
scale. The winner-tracing assertions therefore compare scaled ink, and
the base's own glyphs still pass through untouched.
"""

from __future__ import annotations

import json
import unicodedata
from pathlib import Path

from fontTools.pens.boundsPen import BoundsPen
from fontTools.ttLib import TTFont

from conftest import (
    BASE_CODEPOINTS,
    DONOR_CODEPOINTS,
    synth_cff_font,
    synth_composite_font,
)
from fontalloy_core import build


class TestAbsenceNeverOverrides:
    """A donor gap leaves the base glyph in place — at the output font."""

    def test_a_rule_preferring_an_absent_donor_leaves_the_base_glyph(
        self, tmp_path: Path, synth_font_factory
    ):
        # The base owns 0x41 and 0x4E2D; the donor owns 0x4E2D and
        # 0x56FD but NOT 0x41, and draws wider ink (advance 700).
        base = synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=(0x41, 0x4E2D)
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf",
            family="SynthDonor",
            codepoints=(0x4E2D, 0x56FD),
            advance=700,
        )
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base: {base.name}\n"
            f"donors:\n  - {donor.name}\n"
            "rules:\n"
            "  - codepoint: 0x41\n"
            "    fonts: [donor-0]\n",
            encoding="utf-8",
        )

        result = build(recipe, tmp_path / "out.ttf")

        report = json.loads(result.report_path.read_text(encoding="utf-8"))
        entry = {e["codepoint"]: e for e in report["provenance"]}[0x41]
        assert entry == {
            "codepoint": 0x41,
            "winner": "base",
            "in_output": True,
            "via": "default",
            "kind": "base",
        }

        out = TTFont(result.font_path)
        base_glyph = TTFont(base).getBestCmap()[0x41]
        assert out.getBestCmap()[0x41] == base_glyph
        assert out["hmtx"][base_glyph] == (600, 40)  # the base's metrics
        # The donor still fills the codepoint it does hold.
        assert 0x56FD in out.getBestCmap()


class TestOverrideGraft:
    """An explicit rule displaces a base glyph at the output font."""

    def test_a_rule_replaces_the_base_glyph_with_the_donor_glyf(
        self, tmp_path: Path, synth_font_factory
    ):
        # Both fonts cover 0x41; the donor draws wider ink (advance 700)
        # so the winner is distinguishable by metrics.
        base = synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=BASE_CODEPOINTS
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf",
            family="SynthDonor",
            codepoints=(0x41, 0x4E2D),
            advance=700,
        )
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base: {base.name}\n"
            f"donors:\n  - {donor.name}\n"
            "rules:\n"
            "  - codepoint: 0x41\n"
            "    fonts: [donor-0]\n",
            encoding="utf-8",
        )

        result = build(recipe, tmp_path / "out.ttf")

        report = json.loads(result.report_path.read_text(encoding="utf-8"))
        entry = {e["codepoint"]: e for e in report["provenance"]}[0x41]
        assert entry["winner"] == "donor-0"
        assert entry["via"] == "rule-0"
        assert entry["kind"] == "override"

        out = TTFont(result.font_path)
        base = TTFont(base)
        base_glyph = base.getBestCmap()[0x41]
        donor = TTFont(donor)
        out_glyph = out.getBestCmap()[0x41]
        # The codepoint now renders the donor's glyph, not the base's:
        # normalization (issue #8) re-grids the advance to the base's
        # single cell A = 600 and scales the donor ink by its k = 1.2
        # (Han heights [500] -> H_ink 500, guard 1.9).
        assert out["hmtx"][out_glyph] == (600, 48)  # A, scaled side bearing
        assert _bounds(out, out_glyph) == (48, 0, 792, 480)
        assert _bounds(out, out_glyph) != _bounds(base, base_glyph)
        # ...and the displaced base glyph is mapped nowhere in the output.
        assert base_glyph not in out.getBestCmap().values()
        # The untouched base codepoint keeps its glyph.
        assert out.getBestCmap()[0x42] == base.getBestCmap()[0x42]


class TestCompositeGraft:
    """Compound glyphs and their components stay intact end to end."""

    def test_a_nested_composite_arrives_with_its_component_closure(
        self, tmp_path: Path, synth_font_factory
    ):
        base = synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=BASE_CODEPOINTS
        )
        donor = synth_composite_font(
            tmp_path / "donor.ttf", family="SynthDonorComposite"
        )
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base: {base.name}\ndonors:\n  - {donor.name}\n", encoding="utf-8"
        )

        result = build(recipe, tmp_path / "out.ttf")

        out = TTFont(result.font_path)
        out_cmap = out.getBestCmap()
        assert set(out_cmap) == {0x41, 0x42, 0x4E09}

        # The mapped glyph is a composite whose component chain resolves
        # inside the output font, level by level, with offsets scaled by
        # the donor's k = 1.2 (H_ink 350 from the single Han glyph's ink
        # height, guard 2.7 — the grid term 1.2 binds; issue #8).
        top = out["glyf"][out_cmap[0x4E09]]
        assert top.isComposite()
        (component,) = top.components
        assert component.glyphName in out["glyf"].keys()
        assert (component.x, component.y) == (-36, 24)  # (-30, 20) * 1.2
        middle = out["glyf"][component.glyphName]
        assert middle.isComposite()
        (leaf_ref,) = middle.components
        assert leaf_ref.glyphName in out["glyf"].keys()
        assert (leaf_ref.x, leaf_ref.y) == (120, 60)  # (100, 50) * 1.2
        assert not out["glyf"][leaf_ref.glyphName].isComposite()
        # The unmapped components arrived as glyphs but map no codepoint.
        assert component.glyphName not in out_cmap.values()
        assert leaf_ref.glyphName not in out_cmap.values()

        # Rendering through the output's own glyph set reproduces the
        # donor's ink under the normalization scale (bounds as the
        # drawing oracle): donor (70, 70, 470, 420) * 1.2.
        out_bounds = _bounds(out, out_cmap[0x4E09])
        assert out_bounds == (84, 84, 564, 504)


class TestCFFDonorGraft:
    """OTF donors graft into the TrueType container (required tier:
    TTF/OTF in, TTF out) — cubic outlines converted to quadratic."""

    def test_a_cff_donor_grafts_with_its_ink_intact(
        self, tmp_path: Path, synth_font_factory
    ):
        base = synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=BASE_CODEPOINTS
        )
        donor = synth_cff_font(
            tmp_path / "donor.otf", family="SynthDonorCFF"
        )
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base: {base.name}\ndonors:\n  - {donor.name}\n", encoding="utf-8"
        )

        result = build(recipe, tmp_path / "out.ttf")

        out = TTFont(result.font_path)
        cmap = out.getBestCmap()
        # The container stays TrueType; no CFF table rides along.
        assert "glyf" in out
        assert "CFF " not in out
        assert set(cmap) == {*BASE_CODEPOINTS, 0x4E2D, 0x56FD}

        # The converted quadratic outlines reproduce the donor's ink
        # under the normalization scale (axis-aligned boxes survive
        # cu2qu losslessly; issue #8: H_ink 490 -> k = 1.2, advances on
        # the 2:1 grid, side bearings scaled).
        donor_font = TTFont(donor)
        for cp in (0x4E2D, 0x56FD):
            name = cmap[cp]
            assert out["hmtx"][name] == (1200, 48)
            donor_bounds = _bounds(donor_font, donor_font.getBestCmap()[cp])
            x0, y0, x1, y1 = donor_bounds
            assert _bounds(out, name) == (
                _r(x0 * 1.2), _r(y0 * 1.2), _r(x1 * 1.2), _r(y1 * 1.2)
            )


class TestProvenanceReadback:
    """Per-codepoint provenance read back from the output font matches
    the effective table exactly — the report never describes an output
    the built font does not contain, and vice versa."""

    def test_every_codepoint_renders_its_declared_winner_and_only_it(
        self, tmp_path: Path, synth_font_factory
    ):
        # Three fonts distinguished by ink geometry (distinct vertical
        # offsets and heights — normalization collapses all Latin
        # advances to A and all Han advances to 2A, so advances no
        # longer trace provenance; ink does). The rules exercise
        # override, absence fallback, and plain fill side by side.
        base = synth_font_factory(
            tmp_path / "base.ttf",
            family="SynthBase",
            codepoints=(0x41, 0x42, 0x4E2D),
        )
        donor0 = synth_font_factory(
            tmp_path / "donor0.ttf",
            family="SynthDonorZero",
            codepoints=(0x41, 0x56FD),
            advance=700,
            ink_dy=10,
        )
        donor1 = synth_font_factory(
            tmp_path / "donor1.ttf",
            family="SynthDonorOne",
            codepoints=(0x4E2D, 0x4E09),
            advance=800,
            ink_dy=20,
        )
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base: {base.name}\n"
            f"donors:\n  - {donor0.name}\n  - {donor1.name}\n"
            "rules:\n"
            "  - codepoint: 0x41\n"      # donor-0 holds it: override
            "    fonts: [donor-0]\n"
            "  - codepoint: 0x4E2D\n"    # donor-1 holds it: override
            "    fonts: [donor-1]\n"
            "  - codepoint: 0x42\n"      # donor-0 lacks it: absence
            "    fonts: [donor-0]\n",    # never overrides -> base keeps
            encoding="utf-8",
        )

        result = build(recipe, tmp_path / "out.ttf")
        report = json.loads(result.report_path.read_text(encoding="utf-8"))

        # The declared effective table, as the report states it.
        declared = {e["codepoint"]: e for e in report["provenance"]}
        assert declared == {
            0x41: {"codepoint": 0x41, "winner": "donor-0", "in_output": True,
                   "via": "rule-0", "kind": "override"},
            0x42: {"codepoint": 0x42, "winner": "base", "in_output": True,
                   "via": "default", "kind": "base"},
            0x4E2D: {"codepoint": 0x4E2D, "winner": "donor-1", "in_output": True,
                     "via": "rule-1", "kind": "override"},
            0x4E09: {"codepoint": 0x4E09, "winner": "donor-1", "in_output": True,
                     "via": "default", "kind": "fill"},
            0x56FD: {"codepoint": 0x56FD, "winner": "donor-0", "in_output": True,
                     "via": "default", "kind": "fill"},
        }

        # Readback: the output cmap covers exactly the effective table,
        # and every entry's in_output flag agrees with that cmap.
        out = TTFont(result.font_path)
        out_cmap = out.getBestCmap()
        assert set(out_cmap) == set(declared)
        for entry in report["provenance"]:
            assert entry["in_output"] is (entry["codepoint"] in out_cmap)

        # The glyph mapped at each codepoint is the winner's own glyph:
        # same ink under the winner's normalization scale — and never
        # another holder's glyph (donors k = 1.2 each: H_ink 510 and
        # 490, guards 1.86 and 1.94; the grid term binds for both).
        fonts = {
            "base": TTFont(base),
            "donor-0": TTFont(donor0),
            "donor-1": TTFont(donor1),
        }
        scales = {"base": 1.0, "donor-0": 1.2, "donor-1": 1.2}

        def scaled_ink(font_id: str, cp: int):
            winner = fonts[font_id]
            name = winner.getBestCmap()[cp]
            x0, y0, x1, y1 = _bounds(winner, name)
            s = scales[font_id]
            return (_r(x0 * s), _r(y0 * s), _r(x1 * s), _r(y1 * s))

        def advance_for(cp: int) -> int:
            # UAX #11: Wide codepoints take two cells, the rest one.
            wide = unicodedata.east_asian_width(chr(cp)) in ("F", "W")
            return (2 if wide else 1) * 600

        for cp, entry in declared.items():
            out_name = out_cmap[cp]
            assert out["hmtx"][out_name][0] == advance_for(cp)
            assert _bounds(out, out_name) == scaled_ink(entry["winner"], cp)
            for other_id in fonts:
                if other_id != entry["winner"] and cp in fonts[other_id].getBestCmap():
                    assert _bounds(out, out_name) != scaled_ink(other_id, cp)

        summary = report["summary"]
        assert summary["codepoints_total"] == 5
        assert summary["output_codepoints"] == 5  # grafted codepoints now in


class TestBaseContainerPassThrough:
    """The base font stays the container: vertical metrics pass through
    unmodified; donor glyphs land normalized on top (issue #8 — the
    v-era verbatim expectations this class used to pin are superseded by
    the stage-4 scales). The name table and OS/2 no longer pass
    through: stage 6 (issue #6) rewrites the output identity around the
    brand default family, which is exactly why no source font name may
    leak."""

    def test_vertical_metrics_pass_through_and_identity_is_rewritten(
        self, tmp_path: Path, synth_font_factory
    ):
        # The donor runs at a different upem (2048): normalization scales
        # it by s0 * k = (1000/2048) * 1.2 = 0.5859375 (H_ink 490 donor
        # units -> 239 base units, guard 3.97 — the grid term 1.2 binds),
        # and the container stays 1000 upem.
        base = synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=BASE_CODEPOINTS
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf",
            family="SynthDonor",
            codepoints=DONOR_CODEPOINTS,
            upem=2048,
        )
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base: {base.name}\ndonors:\n  - {donor.name}\n", encoding="utf-8"
        )

        result = build(recipe, tmp_path / "out.ttf")

        out, base_font = TTFont(result.font_path), TTFont(base)

        # Identity: stage 6 rewrote it around the output family — both
        # platform encodings, and no source font name anywhere in the
        # record set (enumerate records; getDebugName can mask platform
        # duplicates).
        identity = {
            (r.platformID, r.platEncID, r.langID): r.toUnicode()
            for r in out["name"].names
            if r.nameID == 1
        }
        assert identity == {
            (3, 1, 0x409): "ChHsich",
            (1, 0, 0): "ChHsich",
        }
        texts = {r.toUnicode() for r in out["name"].names}
        assert not any("SynthBase" in text or "SynthDonor" in text for text in texts)

        # Container metrics: upem, hhea, OS/2 typo/win, and post values
        # all pass through identical — donor glyphs ride on top, the
        # base's layout contract is untouched (line height inherits the
        # base; the scaled ink stays inside the win metrics, so they do
        # not grow).
        assert out["head"].unitsPerEm == base_font["head"].unitsPerEm == 1000
        for attr in ("ascent", "descent", "lineGap"):
            assert getattr(out["hhea"], attr) == getattr(base_font["hhea"], attr)
        for attr in (
            "sTypoAscender", "sTypoDescender", "sTypoLineGap",
            "usWinAscent", "usWinDescent", "usWeightClass",
        ):
            assert getattr(out["OS/2"], attr) == getattr(base_font["OS/2"], attr)
        for attr in ("italicAngle", "underlinePosition", "underlineThickness"):
            assert getattr(out["post"], attr) == getattr(base_font["post"], attr)

        # The 2048-upem donor's glyphs arrived normalized onto the base's
        # metrics: the ink scales by 0.5859375 about the shared baseline,
        # and the Han advance lands on the 2:1 grid.
        out_cmap = out.getBestCmap()
        assert out["hmtx"][out_cmap[0x4E2D]] == (1200, 23)  # 2A, round(40*s)
        assert _bounds(out, out_cmap[0x4E2D]) == (23, 0, 328, 234)
        assert _bounds(out, out_cmap[0x56FD]) == (23, 0, 328, 293)

    def test_a_donor_that_wins_nothing_leaves_the_base_glyphs_untouched(
        self, tmp_path: Path, synth_font_factory
    ):
        # The donor's coverage is a subset of the base's: no codepoint
        # resolves to it, nothing is grafted — the output's glyph set
        # and cmap are exactly the base's own. The bytes differ from a
        # plain base recompile only because stage 6 rewrote the output
        # identity (name table, OS/2 corrections) — that rewrite runs
        # for every build, grafted or not (byte-level reproducibility
        # is pinned separately by the repeated-build tests, issue #10).
        base = synth_font_factory(
            tmp_path / "base.ttf",
            family="SynthBase",
            codepoints=(0x41, 0x42, 0x4E2D),
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf", family="SynthDonor", codepoints=(0x4E2D,)
        )
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base: {base.name}\ndonors:\n  - {donor.name}\n", encoding="utf-8"
        )

        result = build(recipe, tmp_path / "out.ttf")
        base_font = TTFont(base)
        out = TTFont(result.font_path)

        assert out.getBestCmap() == base_font.getBestCmap()
        assert out.getGlyphOrder() == base_font.getGlyphOrder()
        assert out["hmtx"].metrics == base_font["hmtx"].metrics
        # And stage 6 still ran: the output carries its own identity.
        assert out["name"].getDebugName(1) == "ChHsich"


def _bounds(font: TTFont, name: str) -> tuple[int, int, int, int] | None:
    pen = BoundsPen(font.getGlyphSet())
    font.getGlyphSet()[name].draw(pen)
    return pen.bounds


def _r(value: float) -> int:
    """fontTools' otRound (half away from zero), for scaled expectations."""
    return int((value + 0.5) if value >= 0 else (value - 0.5))


class TestAstralCoverage:
    """The rebuilt cmap carries astral codepoints through format 12."""

    def test_an_astral_codepoint_lands_in_a_ucs4_cmap_subtable(
        self, tmp_path: Path, synth_font_factory
    ):
        base = synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=(0x41,)
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf",
            family="SynthDonorAstral",
            codepoints=(0x4E2D, 0x1F600),
        )
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base: {base.name}\ndonors:\n  - {donor.name}\n", encoding="utf-8"
        )

        result = build(recipe, tmp_path / "out.ttf")

        out = TTFont(result.font_path)
        cmap = out.getBestCmap()
        assert set(cmap) == {0x41, 0x4E2D, 0x1F600}

        subtables = {(t.platformID, t.platEncID): t for t in out["cmap"].tables}
        # Windows UCS-4 subtable exists and carries the complete mapping
        # (getBestCmap prefers it, so BMP entries must live there too).
        ucs4 = subtables[(3, 10)]
        assert ucs4.format == 12
        assert ucs4.cmap == cmap
        # The BMP subtable carries its subset and cannot hold the astral
        # codepoint.
        bmp = subtables[(3, 1)]
        assert bmp.format == 4
        assert set(bmp.cmap) == {0x41, 0x4E2D}
        # The astral glyph itself arrived with real ink.
        assert cmap[0x1F600] in out["glyf"].keys()


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

        # A grafted glyph is real: it has outlines, its advance lands on
        # the 2:1 grid, and its side bearing rides the scale (issue #8:
        # donor Han heights [400, 500] -> H_ink 490 -> k = 1.2, lsb
        # round(40 * 1.2) = 48).
        donor = TTFont(donor_font)
        donor_cmap = donor.getBestCmap()
        for cp in DONOR_CODEPOINTS:
            name = cmap[cp]
            assert name in out["glyf"].keys()
            assert out["hmtx"][name] == (1200, 48)

        # The base glyphs are untouched: same name, same metrics.
        base = TTFont(base_font)
        base_cmap = base.getBestCmap()
        for cp in BASE_CODEPOINTS:
            name = cmap[cp]
            assert name == base_cmap[cp]
            assert out["hmtx"][name] == base["hmtx"][base_cmap[cp]]
