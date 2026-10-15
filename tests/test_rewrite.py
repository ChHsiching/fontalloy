"""Seam 1 tests: the name table and OS/2 rewrite (issue #6).

Stage 6 gives the output a coherent identity: the full name record set
is rewritten on both platform encodings (Windows Unicode and Macintosh
Roman — the getDebugName trap), nameID 16/17 stay consistent with 1/2,
and OS/2 is corrected (xAvgCharWidth per the OpenType a–z formula,
usWeightClass inherited from the base, the PANOSE mono digits). Names
are validated before anything is written: the fixed brand default
applies when the recipe says nothing, and a user-entered family name
must be ASCII letters/digits/hyphens with spaces converted, bounded by
the 31/63 character limits. The oracle is fontTools reading the built
font back, enumerating name records explicitly (never getDebugName —
it returns the first platform record in file order and can mask
duplicates).
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fontTools.misc.roundTools import otRound
from fontTools.ttLib import TTFont

from conftest import BASE_CODEPOINTS, DONOR_CODEPOINTS, synth_font
from fontalloy_core import build
from fontalloy_core.errors import BuildError, RecipeError

WINDOWS = (3, 1, 0x409)
MACINTOSH = (1, 0, 0)
#: The platform encodings every rewritten record must carry.
BOTH_PLATFORMS = (WINDOWS, MACINTOSH)


def write_recipe(tmp_path: Path, body: str, name: str = "recipe.yaml") -> Path:
    recipe = tmp_path / name
    recipe.write_text(body, encoding="utf-8")
    return recipe


def minimal_recipe(base: Path, donor: Path, output_block: str = "") -> str:
    return (
        f"base: {base.name}\ndonors:\n  - {donor.name}\n{output_block}"
    )


def records(font: TTFont, name_id: int) -> dict[tuple[int, int, int], str]:
    """Every record for one nameID, keyed by (platform, encoding, language)."""
    return {
        (r.platformID, r.platEncID, r.langID): r.toUnicode()
        for r in font["name"].names
        if r.nameID == name_id
    }


def one_record_per_platform(font: TTFont, name_id: int) -> str:
    """Assert the record exists exactly once per platform and agrees."""
    found = records(font, name_id)
    assert sorted(found) == sorted(BOTH_PLATFORMS), (
        f"nameID {name_id} must have exactly the {WINDOWS} and {MACINTOSH} "
        f"records (got {sorted(found)})"
    )
    values = set(found.values())
    assert len(values) == 1, (
        f"nameID {name_id} disagrees across platforms: {found}"
    )
    return found[WINDOWS]


class TestBrandDefault:
    """The default output family is the fixed brand default — never a
    name derived from the source fonts (RFN compliance, ADR-0005)."""

    def test_default_family_is_the_brand_default(
        self, tmp_path: Path, base_font: Path, donor_font: Path
    ):
        recipe = write_recipe(tmp_path, minimal_recipe(base_font, donor_font))

        result = build(recipe, tmp_path / "out.ttf")

        out = TTFont(result.font_path)
        assert one_record_per_platform(out, 1) == "ChHsich"
        assert one_record_per_platform(out, 2) == "Regular"

    def test_source_font_names_never_leak_into_the_output(
        self, tmp_path: Path, base_font: Path, donor_font: Path
    ):
        recipe = write_recipe(tmp_path, minimal_recipe(base_font, donor_font))

        result = build(recipe, tmp_path / "out.ttf")

        texts = {r.toUnicode() for r in TTFont(result.font_path)["name"].names}
        assert not any("SynthBase" in text or "SynthDonor" in text for text in texts)

    def test_an_explicit_family_overrides_the_default(
        self, tmp_path: Path, base_font: Path, donor_font: Path
    ):
        recipe = write_recipe(
            tmp_path,
            minimal_recipe(
                base_font, donor_font, output_block="output:\n  family: MyAlloy\n"
            ),
        )

        result = build(recipe, tmp_path / "out.ttf")

        assert one_record_per_platform(TTFont(result.font_path), 1) == "MyAlloy"


class TestFamilyValidation:
    """Letters (any case), digits, hyphens only; spaces become hyphens;
    anything else, non-ASCII, or over-length is a clear error before a
    name table is written."""

    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("MyAlloy", "MyAlloy"),
            ("my-alloy-2", "my-alloy-2"),
            ("LowerUPPER123", "LowerUPPER123"),
            ("My Alloy", "My-Alloy"),  # spaces convert, never reject
            ("  Spaced  Out  ", "Spaced-Out"),  # trimmed, no doubled hyphens
            ("A" * 31, "A" * 31),  # the boundary itself passes
        ],
    )
    def test_valid_families_build_with_their_normalized_form(
        self, tmp_path, base_font, donor_font, raw, expected
    ):
        recipe = write_recipe(
            tmp_path,
            minimal_recipe(
                base_font, donor_font, output_block=f'output:\n  family: "{raw}"\n'
            ),
        )

        result = build(recipe, tmp_path / "out.ttf")

        assert one_record_per_platform(TTFont(result.font_path), 1) == expected

    @pytest.mark.parametrize(
        "raw,because",
        [
            ("bad_name", "underscore"),
            ("bad.name", "punctuation"),
            ("bad/name", "path separator"),
            ("bad'name", "apostrophe"),
            ("字体", "non-ASCII CJK"),
            ("Fônt", "non-ASCII Latin"),
            ("", "empty"),
            ("   ", "whitespace only"),
            ("A" * 32, "over the 31-character limit"),
        ],
    )
    def test_invalid_families_fail_the_build_with_a_clear_error(
        self, tmp_path, base_font, donor_font, raw, because
    ):
        recipe = write_recipe(
            tmp_path,
            minimal_recipe(
                base_font, donor_font, output_block=f'output:\n  family: "{raw}"\n'
            ),
        )

        with pytest.raises(RecipeError, match=r"output\.family"):
            build(recipe, tmp_path / "out.ttf")
        assert not (tmp_path / "out.ttf").exists()

    def test_non_string_family_is_a_clear_error(
        self, tmp_path, base_font, donor_font
    ):
        recipe = write_recipe(
            tmp_path,
            minimal_recipe(
                base_font, donor_font, output_block="output:\n  family: 42\n"
            ),
        )

        with pytest.raises(RecipeError, match=r"output\.family"):
            build(recipe, tmp_path / "out.ttf")

    def test_an_empty_output_mapping_keeps_the_default(
        self, tmp_path, base_font, donor_font
    ):
        recipe = write_recipe(
            tmp_path, minimal_recipe(base_font, donor_font, output_block="output: {}\n")
        )

        result = build(recipe, tmp_path / "out.ttf")

        assert one_record_per_platform(TTFont(result.font_path), 1) == "ChHsich"

    def test_unknown_output_field_is_rejected(
        self, tmp_path, base_font, donor_font
    ):
        recipe = write_recipe(
            tmp_path,
            minimal_recipe(
                base_font, donor_font, output_block="output:\n  style: Bold\n"
            ),
        )

        with pytest.raises(RecipeError, match="style"):
            build(recipe, tmp_path / "out.ttf")

    def test_output_that_is_not_a_mapping_is_rejected(
        self, tmp_path, base_font, donor_font
    ):
        recipe = write_recipe(
            tmp_path,
            minimal_recipe(base_font, donor_font, output_block="output: ChHsich\n"),
        )

        with pytest.raises(RecipeError, match="output"):
            build(recipe, tmp_path / "out.ttf")


class TestNameRecordSet:
    """The identity records are rewritten as a coherent set on both
    platform encodings; attribution records pass through from the base."""

    def test_the_full_identity_record_set_is_written(
        self, tmp_path: Path, base_font: Path, donor_font: Path
    ):
        recipe = write_recipe(tmp_path, minimal_recipe(base_font, donor_font))

        result = build(recipe, tmp_path / "out.ttf")
        out = TTFont(result.font_path)

        assert one_record_per_platform(out, 1) == "ChHsich"
        assert one_record_per_platform(out, 2) == "Regular"
        assert one_record_per_platform(out, 3) == "FontAlloy: ChHsich Regular"
        assert one_record_per_platform(out, 4) == "ChHsich Regular"
        assert one_record_per_platform(out, 6) == "ChHsich-Regular"

    def test_attribution_records_pass_through_from_the_base(
        self, tmp_path: Path
    ):
        base = synth_font(
            tmp_path / "base.ttf",
            family="SynthBase",
            codepoints=BASE_CODEPOINTS,
            extra_names={0: "(c) the upstream author", 7: "SynthBase is a mark"},
        )
        donor = synth_font(
            tmp_path / "donor.ttf", family="SynthDonor", codepoints=DONOR_CODEPOINTS
        )
        recipe = write_recipe(tmp_path, minimal_recipe(base, donor))

        result = build(recipe, tmp_path / "out.ttf")

        out = TTFont(result.font_path)
        assert one_record_per_platform(out, 0) == "(c) the upstream author"
        assert one_record_per_platform(out, 7) == "SynthBase is a mark"

    def test_a_stale_mac_platform_record_cannot_shadow_the_rewrite(
        self, tmp_path: Path
    ):
        # The getDebugName trap: a stale Macintosh record ahead of the
        # Windows one in file order wins naive reads. The rewrite must
        # replace both platforms for every identity nameID it touches.
        base = synth_font(
            tmp_path / "base.ttf", family="SynthBase", codepoints=BASE_CODEPOINTS
        )
        stale = TTFont(base)
        stale["name"].setName("StaleMac", 1, 1, 0, 0)  # already the Mac record
        stale["name"].setName("FaceTwo", 1, 3, 1, 0x409)
        stale.save(base)
        donor = synth_font(
            tmp_path / "donor.ttf", family="SynthDonor", codepoints=DONOR_CODEPOINTS
        )
        recipe = write_recipe(tmp_path, minimal_recipe(base, donor))

        result = build(recipe, tmp_path / "out.ttf")

        out = TTFont(result.font_path)
        assert out["name"].getDebugName(1) == "ChHsich"
        assert one_record_per_platform(out, 1) == "ChHsich"
        assert "StaleMac" not in {
            r.toUnicode() for r in out["name"].names
        }

    def test_localized_base_identity_records_are_replaced(
        self, tmp_path: Path
    ):
        # Localized names are out of scope for v1 — but a localized
        # identity record left in place would leak the source family, so
        # the rewrite clears every record of the nameIDs it owns.
        base = synth_font(
            tmp_path / "base.ttf", family="SynthBase", codepoints=BASE_CODEPOINTS
        )
        localized = TTFont(base)
        localized["name"].setName("_synthetic_base_", 1, 3, 1, 0x804)
        localized.save(base)
        donor = synth_font(
            tmp_path / "donor.ttf", family="SynthDonor", codepoints=DONOR_CODEPOINTS
        )
        recipe = write_recipe(tmp_path, minimal_recipe(base, donor))

        result = build(recipe, tmp_path / "out.ttf")

        out = TTFont(result.font_path)
        assert one_record_per_platform(out, 1) == "ChHsich"
        assert "_synthetic_base_" not in {
            r.toUnicode() for r in out["name"].names
        }


class TestTypographicNames:
    """nameID 16/17 stay consistent with 1/2 — the trap the old
    storefront hit. A non-RIBBI subfamily splits: 1 carries family +
    subfamily, 2 carries the RIBBI bit-derived style, 16/17 carry the
    typographic pair. A RIBBI base needs no 16/17 at all."""

    def test_a_non_ribbi_subfamily_splits_across_the_record_set(
        self, tmp_path: Path, synth_font_factory
    ):
        base = synth_font_factory(
            tmp_path / "base.ttf",
            family="SynthBase",
            codepoints=BASE_CODEPOINTS,
            subfamily="Medium",
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf", family="SynthDonor", codepoints=DONOR_CODEPOINTS
        )
        recipe = write_recipe(tmp_path, minimal_recipe(base, donor))

        result = build(recipe, tmp_path / "out.ttf")
        out = TTFont(result.font_path)

        assert one_record_per_platform(out, 1) == "ChHsich Medium"
        assert one_record_per_platform(out, 2) == "Regular"
        assert one_record_per_platform(out, 4) == "ChHsich Medium"
        assert one_record_per_platform(out, 6) == "ChHsich-Medium"
        assert one_record_per_platform(out, 16) == "ChHsich"
        assert one_record_per_platform(out, 17) == "Medium"

    def test_a_regular_legacy_subfamily_with_a_typographic_style_keeps_the_style(
        self, tmp_path: Path, synth_font_factory
    ):
        # Round 23 (owner item 6): the >4-style family convention keeps
        # nameID 2 at "Regular" for every non-RIBBI weight and carries
        # the real style in nameID 17 (JetBrainsMono, Noto, Maple Mono
        # all ship this way). The subfamily must read the typographic
        # record FIRST — reading nameID 2 collapsed a 16-face output
        # onto eight "ChHsich Regular" faces and every RIBBI-matching
        # application resolved the wrong one.
        base = synth_font_factory(
            tmp_path / "base.ttf",
            family="SynthBase ExtraBold",
            codepoints=BASE_CODEPOINTS,
            subfamily="Regular",
            typographic_family="SynthBase",
            extra_names={17: "ExtraBold"},
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf", family="SynthDonor", codepoints=DONOR_CODEPOINTS
        )
        recipe = write_recipe(tmp_path, minimal_recipe(base, donor))

        result = build(recipe, tmp_path / "out.ttf")
        out = TTFont(result.font_path)

        assert one_record_per_platform(out, 1) == "ChHsich ExtraBold"
        assert one_record_per_platform(out, 2) == "Regular"
        assert one_record_per_platform(out, 4) == "ChHsich ExtraBold"
        assert one_record_per_platform(out, 6) == "ChHsich-ExtraBold"
        assert one_record_per_platform(out, 16) == "ChHsich"
        assert one_record_per_platform(out, 17) == "ExtraBold"

    def test_bold_and_italic_bits_derive_the_ribbi_subfamily(
        self, tmp_path: Path, synth_font_factory
    ):
        base = synth_font_factory(
            tmp_path / "base.ttf",
            family="SynthBase",
            codepoints=BASE_CODEPOINTS,
            subfamily="Medium",
            italic=True,
        )
        bold = TTFont(base)
        bold["OS/2"].fsSelection |= 0x20  # BOLD
        bold.save(base)
        donor = synth_font_factory(
            tmp_path / "donor.ttf", family="SynthDonor", codepoints=DONOR_CODEPOINTS
        )
        recipe = write_recipe(tmp_path, minimal_recipe(base, donor))

        result = build(recipe, tmp_path / "out.ttf")

        out = TTFont(result.font_path)
        assert one_record_per_platform(out, 2) == "Bold Italic"
        assert one_record_per_platform(out, 17) == "Medium"

    def test_a_ribbi_subfamily_writes_no_typographic_pair(
        self, tmp_path: Path, synth_font_factory
    ):
        base = synth_font_factory(
            tmp_path / "base.ttf",
            family="SynthBase",
            codepoints=BASE_CODEPOINTS,
            subfamily="Bold",
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf", family="SynthDonor", codepoints=DONOR_CODEPOINTS
        )
        recipe = write_recipe(tmp_path, minimal_recipe(base, donor))

        result = build(recipe, tmp_path / "out.ttf")
        out = TTFont(result.font_path)

        assert one_record_per_platform(out, 1) == "ChHsich"
        assert one_record_per_platform(out, 2) == "Bold"
        assert one_record_per_platform(out, 6) == "ChHsich-Bold"
        assert records(out, 16) == {}
        assert records(out, 17) == {}

    def test_a_stale_typographic_pair_dies_with_the_ribbi_drop(
        self, tmp_path: Path, synth_font_factory
    ):
        """The RFN leak the real catalog exposed (issue #23's flagship).

        A RIBBI face writes no 16/17 — and a stale pair the base
        carried must not survive that drop: applications preferring
        the typographic family would see the source font's family
        (JetBrainsMono Nerd Font carries nameID 16) instead of the
        output's own.
        """
        base = synth_font_factory(
            tmp_path / "base.ttf",
            family="SynthBase",
            codepoints=BASE_CODEPOINTS,
            subfamily="Regular",
            typographic_family="SynthBase Extended",
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf", family="SynthDonor", codepoints=DONOR_CODEPOINTS
        )
        recipe = write_recipe(tmp_path, minimal_recipe(base, donor))

        result = build(recipe, tmp_path / "out.ttf")
        out = TTFont(result.font_path)

        assert one_record_per_platform(out, 1) == "ChHsich"
        assert records(out, 16) == {}
        assert records(out, 17) == {}
        assert "SynthBase Extended" not in {
            r.toUnicode() for r in out["name"].names
        }

    def test_a_stale_typographic_pair_from_the_base_is_replaced(
        self, tmp_path: Path, synth_font_factory
    ):
        base = synth_font_factory(
            tmp_path / "base.ttf",
            family="SynthBase",
            codepoints=BASE_CODEPOINTS,
            subfamily="Medium",
            typographic_family="SynthBase Extended",
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf", family="SynthDonor", codepoints=DONOR_CODEPOINTS
        )
        recipe = write_recipe(tmp_path, minimal_recipe(base, donor))

        result = build(recipe, tmp_path / "out.ttf")

        out = TTFont(result.font_path)
        assert one_record_per_platform(out, 16) == "ChHsich"
        assert "SynthBase Extended" not in {
            r.toUnicode() for r in out["name"].names
        }


class TestPostScriptName:
    """The PostScript name is ASCII, no spaces, at most 63 characters."""

    def test_a_postscript_name_over_63_characters_is_a_clear_error(
        self, tmp_path: Path, synth_font_factory
    ):
        # 31-character family + a 33-character subfamily: the family
        # passes its own limit, but the derived PostScript name cannot.
        base = synth_font_factory(
            tmp_path / "base.ttf",
            family="SynthBase",
            codepoints=BASE_CODEPOINTS,
            subfamily="S" * 33,
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf", family="SynthDonor", codepoints=DONOR_CODEPOINTS
        )
        recipe = write_recipe(
            tmp_path,
            minimal_recipe(
                base, donor, output_block=f"output:\n  family: {'F' * 31}\n"
            ),
        )

        with pytest.raises(BuildError, match="[Pp]ost[Ss]cript"):
            build(recipe, tmp_path / "out.ttf")

    def test_a_postscript_name_at_exactly_63_characters_builds(
        self, tmp_path: Path, synth_font_factory
    ):
        base = synth_font_factory(
            tmp_path / "base.ttf",
            family="SynthBase",
            codepoints=BASE_CODEPOINTS,
            subfamily="S" * 31,
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf", family="SynthDonor", codepoints=DONOR_CODEPOINTS
        )
        recipe = write_recipe(
            tmp_path,
            minimal_recipe(
                base, donor, output_block=f"output:\n  family: {'F' * 31}\n"
            ),
        )

        result = build(recipe, tmp_path / "out.ttf")

        ps = one_record_per_platform(TTFont(result.font_path), 6)
        assert ps == f"{'F' * 31}-{'S' * 31}"  # 31 + 1 + 31 = 63 exactly
        assert len(ps) == 63

    def test_a_subfamily_that_cannot_form_an_ascii_postscript_name_errors(
        self, tmp_path: Path, synth_font_factory
    ):
        base = synth_font_factory(
            tmp_path / "base.ttf",
            family="SynthBase",
            codepoints=BASE_CODEPOINTS,
            subfamily="標準",
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf", family="SynthDonor", codepoints=DONOR_CODEPOINTS
        )
        recipe = write_recipe(tmp_path, minimal_recipe(base, donor))

        with pytest.raises(BuildError, match="subfamily"):
            build(recipe, tmp_path / "out.ttf")


class TestOS2Corrections:
    """OS/2 is corrected, not redesigned: xAvgCharWidth follows the
    OpenType a–z mean (not fontTools' all-glyph average), the weight
    class is the base's, and the PANOSE mono digits follow the base's
    declared monospaced-ness."""

    def test_xavgcharwidth_is_the_mean_of_the_lowercase_advances(
        self, tmp_path: Path
    ):
        # a=500, b=700, c=300 → mean 500. The uppercase A at 600 must
        # NOT enter the sum, and neither must the donor's CJK glyphs.
        base = synth_font(
            tmp_path / "base.ttf",
            family="SynthBase",
            codepoints=(0x41, 0x61, 0x62, 0x63),
            advances={0x61: 500, 0x62: 700, 0x63: 300},
        )
        donor = synth_font(
            tmp_path / "donor.ttf", family="SynthDonor", codepoints=DONOR_CODEPOINTS
        )
        recipe = write_recipe(tmp_path, minimal_recipe(base, donor))

        result = build(recipe, tmp_path / "out.ttf")

        out = TTFont(result.font_path)
        assert set(out.getBestCmap()) >= {0x4E2D, 0x56FD}  # donor grafted
        assert out["OS/2"].xAvgCharWidth == 500

    def test_xavgcharwidth_is_measured_on_the_output_not_the_base(
        self, tmp_path: Path
    ):
        # An override rule moves the lowercase 'b' to the donor; the
        # sum must take the output's post-normalization advance,
        # proving the measurement happens after the graft, against the
        # output cmap and hmtx.
        base = synth_font(
            tmp_path / "base.ttf",
            family="SynthBase",
            codepoints=(0x61, 0x62),
            advances={0x61: 500, 0x62: 700},
        )
        donor = synth_font(
            tmp_path / "donor.ttf",
            family="SynthDonor",
            codepoints=(0x62,),
            advances={0x62: 900},
        )
        recipe = write_recipe(
            tmp_path,
            "base: base.ttf\n"
            "donors:\n  - donor.ttf\n"
            "rules:\n"
            "  - codepoint: 0x62\n"
            "    fonts: [donor-0, base]\n",
        )

        result = build(recipe, tmp_path / "out.ttf")

        out = TTFont(result.font_path)
        cmap = out.getBestCmap()
        # The donor's glyph won the override, but its own advance never
        # lands: normalization (issue #8) re-grids the narrow Latin
        # glyph onto the base's single-cell advance A (the mode over
        # the base's covered ASCII; the 500/700 tie resolves to 500).
        assert cmap[0x62].startswith("d0.")
        assert out["hmtx"][cmap[0x62]][0] == 500
        # The sum takes the OUTPUT's advance for 'b' — the re-gridded
        # A = 500, not the base's original 700 — proving the
        # measurement happens after the graft, against the output cmap
        # and hmtx (a base-only mean would be (500 + 700) / 2 = 600).
        assert out["OS/2"].xAvgCharWidth == otRound((500 + 500) / 2)

    def test_a_font_without_lowercase_glyphs_falls_back_to_half_the_upem(
        self, tmp_path: Path
    ):
        base = synth_font(
            tmp_path / "base.ttf",
            family="SynthBase",
            codepoints=BASE_CODEPOINTS,  # uppercase only
            upem=2048,
        )
        donor = synth_font(
            tmp_path / "donor.ttf", family="SynthDonor", codepoints=DONOR_CODEPOINTS
        )
        recipe = write_recipe(tmp_path, minimal_recipe(base, donor))

        result = build(recipe, tmp_path / "out.ttf")

        assert TTFont(result.font_path)["OS/2"].xAvgCharWidth == 1024

    def test_the_weight_class_is_inherited_from_the_base(
        self, tmp_path: Path, synth_font_factory
    ):
        base = synth_font_factory(
            tmp_path / "base.ttf",
            family="SynthBase",
            codepoints=BASE_CODEPOINTS,
            weight=400,
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf",
            family="SynthDonor",
            codepoints=DONOR_CODEPOINTS,
            weight=700,
        )
        recipe = write_recipe(tmp_path, minimal_recipe(base, donor))

        result = build(recipe, tmp_path / "out.ttf")

        assert TTFont(result.font_path)["OS/2"].usWeightClass == 400

    def test_a_monospaced_base_gets_the_panose_mono_digits(
        self, tmp_path: Path, synth_font_factory
    ):
        base = synth_font_factory(
            tmp_path / "base.ttf",
            family="SynthBase",
            codepoints=BASE_CODEPOINTS,
            fixed_pitch=True,
        )
        donor = synth_font_factory(
            tmp_path / "donor.ttf", family="SynthDonor", codepoints=DONOR_CODEPOINTS
        )
        recipe = write_recipe(tmp_path, minimal_recipe(base, donor))

        result = build(recipe, tmp_path / "out.ttf")

        panose = TTFont(result.font_path)["OS/2"].panose
        assert panose.bProportion == 9  # Monospaced
        assert panose.bFamilyType == 2  # Latin Text and Display

    def test_a_panose_mono_declaration_is_kept(
        self, tmp_path: Path, synth_font_factory
    ):
        base = synth_font_factory(
            tmp_path / "base.ttf", family="SynthBase", codepoints=BASE_CODEPOINTS
        )
        declared = TTFont(base)
        declared["OS/2"].panose.bProportion = 9
        declared.save(base)
        donor = synth_font_factory(
            tmp_path / "donor.ttf", family="SynthDonor", codepoints=DONOR_CODEPOINTS
        )
        recipe = write_recipe(tmp_path, minimal_recipe(base, donor))

        result = build(recipe, tmp_path / "out.ttf")

        panose = TTFont(result.font_path)["OS/2"].panose
        assert panose.bProportion == 9
        assert panose.bFamilyType == 2

    def test_a_proportional_base_stays_proportional(
        self, tmp_path: Path, base_font: Path, donor_font: Path
    ):
        recipe = write_recipe(tmp_path, minimal_recipe(base_font, donor_font))

        result = build(recipe, tmp_path / "out.ttf")

        panose = TTFont(result.font_path)["OS/2"].panose
        assert panose.bProportion != 9


class TestDeterministicIdentity:
    """The rewrite carries no wall-clock: identical inputs keep building
    byte-identical outputs."""

    def test_repeated_builds_stay_byte_identical(
        self, tmp_path: Path, base_font: Path, donor_font: Path
    ):
        recipe = write_recipe(tmp_path, minimal_recipe(base_font, donor_font))

        first = build(recipe, tmp_path / "out.ttf")
        second = build(recipe, tmp_path / "out2.ttf")

        assert first.font_path.read_bytes() == second.font_path.read_bytes()
