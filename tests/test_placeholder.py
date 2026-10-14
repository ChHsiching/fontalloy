"""Round 18 (owner item 2b): placeholder glyphs count as missing.

Some fonts draw a placeholder glyph (a box, a boxed X, a question face)
at codepoints they do not really cover — poisoning coverage counts and,
worse, grafting tofu into builds as if it were a real glyph. The
detection heuristic (validated against every face of the shipped
catalog and the GUI prototype fonts, 213 faces, observed maximum 5
codepoints on one glyph):

- A codepoint mapped to glyph 0 (``.notdef``) is absent by convention.
- Concentration: one glyph name absorbing an implausible number of
  codepoints (>= :data:`PLACEHOLDER_MIN_CODEPOINTS` AND >=
  :data:`PLACEHOLDER_MIN_SHARE` of the font's cmap) is a suspected
  placeholder, and every codepoint it absorbs reads as missing.

The pipeline consequences asserted here: such codepoints never count as
coverage (report rule records list them missing), never enter the
effective table (a placeholder is never grafted, from either side), and
the report states per source how many codepoints were suspected
(``placeholder_codepoints``).
"""

from __future__ import annotations

from pathlib import Path

from fontTools.ttLib import TTFont

from fontalloy_core.build import build
from fontalloy_core.placeholder import (
    PLACEHOLDER_MIN_CODEPOINTS,
    PLACEHOLDER_MIN_SHARE,
    face_coverage,
)

from conftest import synth_font, synth_placeholder_font

#: The placeholder run the fixtures graft into a font: 300 codepoints of
#: the private use area, one shared box glyph.
PLACEHOLDER_RUN = tuple(range(0xE000, 0xE12C))
PLACEHOLDER_COUNT = len(PLACEHOLDER_RUN)


class TestFaceCoverage:
    """The heuristic itself, over in-memory synthetic fonts."""

    def _font(self, tmp_path: Path, **kwargs) -> TTFont:
        path = synth_placeholder_font(
            tmp_path / "fake.ttf", family="FakeCov", **kwargs
        )
        return TTFont(path)

    def test_concentrated_glyph_reads_as_placeholder(self, tmp_path):
        font = self._font(
            tmp_path,
            codepoints=(0x41, 0x42),
            placeholder_codepoints=PLACEHOLDER_RUN,
        )
        coverage = face_coverage(font)
        assert coverage.placeholders == frozenset(PLACEHOLDER_RUN)
        assert coverage.codepoints == frozenset({0x41, 0x42})

    def test_count_threshold_arm(self, tmp_path):
        """Just under the 64-codepoint arm: clean, even at 100% share."""
        few = tuple(range(0xE000, 0xE000 + PLACEHOLDER_MIN_CODEPOINTS - 1))
        font = self._font(
            tmp_path, codepoints=(0x41,), placeholder_codepoints=few
        )
        coverage = face_coverage(font)
        assert coverage.placeholders == frozenset()
        assert coverage.codepoints == frozenset({0x41, *few})

    def test_share_threshold_arm(self, tmp_path):
        """Past the 64-codepoint arm but under the 5% share: clean."""
        many = tuple(
            range(0xE000, 0xE000 + PLACEHOLDER_MIN_CODEPOINTS + 6)
        )  # 70 codepoints on one glyph
        crowd = tuple(
            range(
                0x3400,
                0x3400 + 2000,
            )
        )  # 2000 real glyphs dilute the cmap below 5%
        font = self._font(
            tmp_path, codepoints=crowd, placeholder_codepoints=many
        )
        coverage = face_coverage(font)
        assert coverage.placeholders == frozenset()
        assert len(coverage.codepoints) == len(crowd) + len(many)

    def test_notdef_mapped_codepoints_are_absent(self, tmp_path):
        """Glyph-0 mappings are absent by convention: never coverage,
        never placeholders (they are not a placeholder glyph, they are
        the font saying nothing)."""
        from fontTools.fontBuilder import FontBuilder
        from fontTools.pens.ttGlyphPen import TTGlyphPen

        pen = TTGlyphPen(None)
        pen.moveTo((0, 0))
        pen.lineTo((500, 0))
        pen.lineTo((500, 700))
        pen.lineTo((0, 700))
        pen.closePath()
        box = pen.glyph()
        builder = FontBuilder(unitsPerEm=1000, isTTF=True)
        builder.setupGlyphOrder([".notdef", "uni0041"])
        builder.setupGlyf({".notdef": box, "uni0041": box})
        builder.setupHorizontalMetrics({".notdef": (600, 40), "uni0041": (600, 40)})
        builder.setupHorizontalHeader(ascent=800, descent=-200)
        # 50 codepoints mapped straight at glyph 0, two real ones (the
        # cmap precedes OS/2: fontBuilder derives fields from it).
        builder.setupCharacterMap(
            {cp: ".notdef" for cp in range(0xE000, 0xE032)}
            | {0x41: "uni0041", 0x42: "uni0041"}
        )
        builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWeightClass=400)
        builder.setupNameTable({"familyName": "NotdefMap", "styleName": "Regular"})
        builder.setupPost()
        font = builder.font
        coverage = face_coverage(font)
        assert coverage.codepoints == frozenset({0x41, 0x42})
        assert coverage.placeholders == frozenset()


class TestBuild:
    """The heuristic wired into the pipeline: counts, grafts, report."""

    def test_base_placeholder_codepoints_count_as_missing(
        self, tmp_path: Path
    ):
        base = synth_placeholder_font(
            tmp_path / "base.ttf",
            family="BoxyBase",
            codepoints=(0x41, 0x42),
            placeholder_codepoints=PLACEHOLDER_RUN,
        )
        donor = synth_font(
            tmp_path / "donor.ttf",
            family="RealDonor",
            codepoints=(0x4E2D,),
        )
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            "base: base.ttf\n"
            "donors:\n"
            "  - donor.ttf\n"
            "rules:\n"
            f"  - range: 0xE000-0x{0xE000 + PLACEHOLDER_COUNT - 1:X}\n"
            "    fonts: [base, donor-0]\n",
            encoding="utf-8",
        )

        result = build(recipe, tmp_path / "out.ttf")

        # The rule's honest verdict: every placeholder codepoint missing.
        payload = result.report.to_json_dict()
        rule = payload["coverage"]["rules"][0]
        assert rule["requested"] == PLACEHOLDER_COUNT
        assert rule["covered"] == 0
        assert rule["missing_total"] == PLACEHOLDER_COUNT

        # The report states what the base font carried.
        base_source = payload["sources"][0]
        assert base_source["placeholder_codepoints"] == PLACEHOLDER_COUNT
        assert base_source["codepoints"] == 2

        # The placeholders never reached the output cmap.
        output = TTFont(result.font_path)
        try:
            assert not (set(output.getBestCmap()) & set(PLACEHOLDER_RUN))
        finally:
            output.close()

    def test_donor_placeholder_codepoints_never_graft(
        self, tmp_path: Path
    ):
        base = synth_font(
            tmp_path / "base.ttf",
            family="CleanBase",
            codepoints=(0x41, 0x42),
        )
        donor = synth_placeholder_font(
            tmp_path / "donor.ttf",
            family="BoxyDonor",
            codepoints=(0x4E2D,),
            placeholder_codepoints=PLACEHOLDER_RUN,
        )
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            "base: base.ttf\n"
            "donors:\n"
            "  - donor.ttf\n"
            "rules:\n"
            f"  - range: 0xE000-0x{0xE000 + PLACEHOLDER_COUNT - 1:X}\n"
            "    fonts: [donor-0]\n",
            encoding="utf-8",
        )

        result = build(recipe, tmp_path / "out.ttf")

        payload = result.report.to_json_dict()
        donor_source = payload["sources"][1]
        assert donor_source["placeholder_codepoints"] == PLACEHOLDER_COUNT
        assert donor_source["codepoints"] == 1

        # No placeholder codepoint entered the effective table or the
        # output: absent from provenance, absent from the built cmap.
        provenance_cps = {entry["codepoint"] for entry in payload["provenance"]}
        assert not (provenance_cps & set(PLACEHOLDER_RUN))
        output = TTFont(result.font_path)
        try:
            assert not (set(output.getBestCmap()) & set(PLACEHOLDER_RUN))
        finally:
            output.close()

        rule = payload["coverage"]["rules"][0]
        assert rule["covered"] == 0
        assert rule["missing_total"] == PLACEHOLDER_COUNT

    def test_clean_fonts_report_no_placeholders(self, tmp_path: Path):
        base = synth_font(
            tmp_path / "base.ttf",
            family="CleanBase",
            codepoints=(0x41, 0x42),
        )
        donor = synth_font(
            tmp_path / "donor.ttf",
            family="CleanDonor",
            codepoints=(0x4E2D, 0x56FD),
        )
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base: base.ttf\ndonors:\n  - donor.ttf\n",
            encoding="utf-8",
        )

        result = build(recipe, tmp_path / "out.ttf")
        payload = result.report.to_json_dict()
        assert [s["placeholder_codepoints"] for s in payload["sources"]] == [0, 0]
        assert [s["codepoints"] for s in payload["sources"]] == [2, 2]
