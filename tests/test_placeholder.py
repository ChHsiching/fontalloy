"""Rounds 18–20: placeholder glyphs count as missing.

Some fonts draw a placeholder glyph (a box, a boxed X, a question face)
at codepoints they do not really cover — poisoning coverage counts and,
worse, grafting tofu into builds as if it were a real glyph. Round 19
(owner ruling) fixed the first two rules to the OpenType conventions:

- A codepoint mapped to glyph 0 (``.notdef``) is absent by convention.
- A codepoint whose mapped glyph has the SAME OUTLINE as the font's own
  ``.notdef`` glyph is a suspected placeholder — the font drew its tofu
  box under another name.

Round 20 (owner-ratified) adds the third rule, reversing round 19's
pure concentration negative:

- A glyph NAME absorbing >= 64 mapped codepoints is a suspected
  MASS-DUPLICATED placeholder — whatever its outline. Real faces
  practically never do this (the shipped 213-face survey's worst case
  was 5 codepoints on one glyph name), while publisher fonts that fake
  whole icon planes map hundreds of codepoints onto one box glyph. A
  shared glyph below the threshold keeps counting as plain coverage.

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
from fontalloy_core.placeholder import face_coverage

from conftest import synth_font, synth_placeholder_font

#: The placeholder run the fixtures graft into a font: 300 codepoints of
#: the private use area, one shared glyph with .notdef's outline.
PLACEHOLDER_RUN = tuple(range(0xE000, 0xE12C))
PLACEHOLDER_COUNT = len(PLACEHOLDER_RUN)


class TestFaceCoverage:
    """The two conventions, over in-memory synthetic fonts."""

    def _font(self, tmp_path: Path, **kwargs) -> TTFont:
        path = synth_placeholder_font(
            tmp_path / "fake.ttf", family="FakeCov", **kwargs
        )
        return TTFont(path)

    def test_notdef_outline_glyph_reads_as_placeholder(self, tmp_path):
        """The round-19 rule: a mapped glyph sharing .notdef's exact
        outline is a suspected placeholder — its codepoints read as
        missing, whatever the glyph is named and however few they are."""
        font = self._font(
            tmp_path,
            codepoints=(0x41, 0x42),
            placeholder_codepoints=PLACEHOLDER_RUN,
        )
        coverage = face_coverage(font)
        assert coverage.placeholders == frozenset(PLACEHOLDER_RUN)
        assert coverage.codepoints == frozenset({0x41, 0x42})

    def test_small_notdef_outline_run_is_detected(self, tmp_path):
        """No thresholds: THREE codepoints on a .notdef-outline glyph
        (not glyph 0, not named .notdef) still read as placeholders."""
        few = (0xE000, 0xE001, 0xE002)
        font = self._font(
            tmp_path, codepoints=(0x41,), placeholder_codepoints=few
        )
        coverage = face_coverage(font)
        assert coverage.placeholders == frozenset(few)
        assert coverage.codepoints == frozenset({0x41})

    def test_shared_glyph_with_own_outline_is_coverage(self, tmp_path):
        """Below the mass-duplication threshold, a shared glyph keeps
        counting as coverage: five codepoints on one own-outline glyph
        is exactly the shipped 213-face survey's worst case — real
        shared glyphs (space, the big-parenthesis pieces) live there."""
        few = tuple(range(0xE000, 0xE005))
        font = self._font(
            tmp_path, codepoints=(0x41,), placeholder_codepoints=few,
            notdef_outline=False,
        )
        coverage = face_coverage(font)
        assert coverage.placeholders == frozenset()
        assert coverage.codepoints == frozenset({0x41, *few})

    def test_mass_duplicated_own_outline_glyph_is_placeholder(self, tmp_path):
        """Round 20, rule 3: one glyph NAME absorbing 64 or more mapped
        codepoints is a suspected placeholder WHATEVER its outline — the
        publisher trick of faking a whole icon plane off one box glyph.
        Round 19's concentration negative is reversed at the threshold."""
        run = tuple(range(0xE000, 0xE040))  # exactly 64 codepoints
        font = self._font(
            tmp_path, codepoints=(0x41,), placeholder_codepoints=run,
            notdef_outline=False,
        )
        coverage = face_coverage(font)
        assert coverage.placeholders == frozenset(run)
        assert coverage.codepoints == frozenset({0x41})

    def test_mass_duplication_threshold_is_64(self, tmp_path):
        """63 codepoints on one own-outline glyph stay coverage; 64 tip
        it — the ratified threshold is `>= 64`, not `> 64`."""
        below = tuple(range(0xE000, 0xE03F))  # 63 codepoints
        font = self._font(
            tmp_path, codepoints=(0x41,), placeholder_codepoints=below,
            notdef_outline=False,
        )
        coverage = face_coverage(font)
        assert coverage.placeholders == frozenset()
        assert coverage.codepoints == frozenset({0x41, *below})

    def test_notdef_mapped_codepoints_are_absent(self, tmp_path):
        """Glyph-0 mappings are absent by convention: never coverage,
        never placeholders (they are not a placeholder glyph, they are
        the font saying nothing). The real glyph draws its OWN outline —
        rule 2 must leave it alone."""
        from fontTools.fontBuilder import FontBuilder
        from fontTools.pens.ttGlyphPen import TTGlyphPen

        def box(x_min, y_min, x_max, y_max):
            pen = TTGlyphPen(None)
            pen.moveTo((x_min, y_min))
            pen.lineTo((x_max, y_min))
            pen.lineTo((x_max, y_max))
            pen.lineTo((x_min, y_max))
            pen.closePath()
            return pen.glyph()

        builder = FontBuilder(unitsPerEm=1000, isTTF=True)
        builder.setupGlyphOrder([".notdef", "uni0041"])
        builder.setupGlyf({".notdef": box(0, 0, 500, 700), "uni0041": box(30, 0, 570, 620)})
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

    def test_cff_notdef_outline_glyph_is_detected(self, tmp_path):
        """CFF faces: the same rule through decomposed charstrings — a
        mapped glyph whose Type 2 program draws .notdef's outline reads
        as a placeholder; a glyph with its own outline does not."""
        from fontTools.fontBuilder import FontBuilder
        from fontTools.pens.t2CharStringPen import T2CharStringPen

        def box_charstring(x0, y0, x1, y1, advance=600):
            pen = T2CharStringPen(advance, None)
            pen.moveTo((x0, y0))
            pen.lineTo((x1, y0))
            pen.lineTo((x1, y1))
            pen.lineTo((x0, y1))
            pen.closePath()
            return pen.getCharString()

        notdef = box_charstring(0, 0, 500, 700)
        # "boxGlyph": the SAME outline as .notdef, different name;
        # "ownGlyph": its own outline (a wider box).
        glyphs = {
            ".notdef": notdef,
            "boxGlyph": box_charstring(0, 0, 500, 700),
            "ownGlyph": box_charstring(0, 0, 600, 700),
        }
        builder = FontBuilder(unitsPerEm=1000, isTTF=False)
        builder.setupGlyphOrder([".notdef", "boxGlyph", "ownGlyph"])
        builder.setupCharacterMap(
            {cp: "boxGlyph" for cp in range(0xE000, 0xE064)}
            | {0x4E01: "ownGlyph"}
        )
        builder.setupCFF("CffCov", {"FullName": "CffCov"}, glyphs, {})
        builder.setupHorizontalMetrics(
            {name: (600, 40) for name in [".notdef", "boxGlyph", "ownGlyph"]}
        )
        builder.setupHorizontalHeader(ascent=800, descent=-200)
        builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWeightClass=400)
        builder.setupNameTable({"familyName": "CffCov", "styleName": "Regular"})
        builder.setupPost()
        builder.font.save(tmp_path / "cffcov.otf")
        font = TTFont(tmp_path / "cffcov.otf")
        coverage = face_coverage(font)
        assert coverage.placeholders == frozenset(range(0xE000, 0xE064))
        assert coverage.codepoints == frozenset({0x4E01})


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
