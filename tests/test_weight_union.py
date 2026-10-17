"""Seam 1 tests: the weight union — donor-only weights get slots (#27).

双方字重全部保留 (the recommended weight-merge mode, the r26 promise)
means its label in the core matrix: the DEFAULT requested matrix — no
recipe ``weights`` selection — emits one output slot per (weight, style)
the union of the base's and the donors' faces spans, confined to the
styles the base carries (a base without an italic never gains one). A
donor-only slot borrows the nearest base face for the base-side
contribution — a private container carrying the slot's weight identity
— and every borrow (base side and donor side) is stated in the report's
weight-borrow table.

Nothing is interpolated or synthesized (transform-only, ADR-0003): the
borrowed base's outlines and the donor's own outlines land verbatim;
only the slot's identity records (OS/2 weight class, RIBBI bits, the
subfamily names) state the union weight.

The other two merge modes keep their semantics: an explicit ``weights``
selection replaces the union (the GUI's EN-only / CJK-only modes land
as selections). And for the pairs that matter most — the donor's
weights a subset of the base's — the output stays byte-identical to
the pre-union behavior, pinned by hash below.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
from fontTools.ttLib import TTCollection, TTFont

from conftest import BASE_CODEPOINTS, synth_font, synth_ttc
from fontalloy_core import BuildError, build

#: The pre-union bytes of the subset-case build (see the pin test): the
#: fixture fonts are deterministic (pinned head timestamps), so the
#: hashes hold on every machine.
SUBSET_FONT_SHA256 = "53cba617ca84559526c0ab9ee9d79fd22b333740590655033351598d578b092d"
SUBSET_REPORT_SHA256 = "bf5ea342c0c237d0506b065eefd6153c52631c9d1b8bef4c83fe1014372949eb"


@pytest.fixture
def union_base(tmp_path: Path) -> Path:
    """A two-face upright base: Regular 400, Bold 700.

    The weights carry distinct Latin advances, so which base face a
    borrowed slot took its base-side contribution from is observable in
    the output hmtx, not just in the report.
    """
    return synth_ttc(
        tmp_path / "base-family.ttc",
        faces=[
            dict(family="SynthBase", codepoints=BASE_CODEPOINTS, weight=400),
            dict(
                family="SynthBase",
                codepoints=BASE_CODEPOINTS,
                weight=700,
                subfamily="Bold",
                advance=640,
            ),
        ],
    )


@pytest.fixture
def extending_donor(tmp_path: Path) -> Path:
    """A CJK donor whose weights extend past the base: 300, 400, 600.

    Each weight carries a distinguishing extra codepoint, so which
    donor face landed in an output slot is observable in the cmap.
    """
    return synth_ttc(
        tmp_path / "cjk-family.ttc",
        faces=[
            dict(family="SynthCJK", weight=300, codepoints=(0x4E2D, 0x3000)),
            dict(family="SynthCJK", weight=400, codepoints=(0x4E2D, 0x56FD)),
            dict(family="SynthCJK", weight=600, codepoints=(0x4E2D, 0x6000)),
        ],
    )


def _recipe(tmp_path: Path, body: str) -> Path:
    recipe = tmp_path / "recipe.yaml"
    recipe.write_text(body, encoding="utf-8")
    return recipe


def _load_report(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _name(font: TTFont, name_id: int) -> str | None:
    records = [r for r in font["name"].names if r.nameID == name_id]
    for record in records:
        if (record.platformID, record.platEncID, record.langID) == (3, 1, 0x409):
            return record.toUnicode()
    return records[0].toUnicode() if records else None


def _glyph_coordinates(font: TTFont, codepoint: int) -> tuple:
    name = font.getBestCmap()[codepoint]
    coords, _, _ = font["glyf"][name].getCoordinates(font.getGlyphSet())
    return coords


def _faces_by_slot(path: Path) -> dict[tuple[int, bool], TTFont]:
    return {
        (face["OS/2"].usWeightClass, bool(face["OS/2"].fsSelection & 0x01)): face
        for face in TTCollection(path).fonts
    }


class TestUnionSlots:
    """Donor-only weights become real output slots carrying donor glyphs."""

    def test_donor_only_weights_get_real_output_slots(
        self, tmp_path, union_base, extending_donor
    ):
        recipe = _recipe(
            tmp_path,
            f"base: {union_base.name}\ndonors:\n  - {extending_donor.name}\n"
            "output:\n  format: ttc\n",
        )

        result = build(recipe, tmp_path / "out.ttc")

        # The literal union of both sides' weights: 300, 400, 600, 700.
        faces = _faces_by_slot(result.font_path)
        assert set(faces) == {(300, False), (400, False), (600, False), (700, False)}
        for (weight, _), face in faces.items():
            # A real slot of its own: the output face NAMES the weight.
            assert face["OS/2"].usWeightClass == weight
            # ...and carries both sides' glyphs: the base's Latin plus
            # the donor weight's own coverage.
            expected = set(BASE_CODEPOINTS) | {0x4E2D, {300: 0x3000, 400: 0x56FD}[weight]}
            assert set(face.getBestCmap()) == expected

    def test_a_borrowed_slot_lands_both_sides_verbatim(
        self, tmp_path, union_base, extending_donor
    ):
        """Transform-only: no weight is interpolated toward the slot.

        The 600 slot's base-side contribution is the borrowed Bold 700
        face's own outlines and advance (plain mode, equal upem: scale
        1), and its donor glyph is the donor's own 600 outline — never
        a blend of the base's 400 and 700 or the donor's 400 and 600.
        """
        recipe = _recipe(
            tmp_path,
            f"base: {union_base.name}\ndonors:\n  - {extending_donor.name}\n"
            "output:\n  format: ttc\n",
        )

        result = build(recipe, tmp_path / "out.ttc")

        slot_600 = _faces_by_slot(result.font_path)[(600, False)]
        base_faces = TTCollection(union_base).fonts
        donor_faces = TTCollection(extending_donor).fonts
        bold = next(f for f in base_faces if f["OS/2"].usWeightClass == 700)
        donor_600 = next(f for f in donor_faces if f["OS/2"].usWeightClass == 600)
        # Base side: the Bold face's own advance, not Regular's 600.
        assert slot_600["hmtx"]["uni0041"][0] == bold["hmtx"]["uni0041"][0] == 640
        assert _glyph_coordinates(slot_600, 0x41) == _glyph_coordinates(bold, 0x41)
        # Donor side: the 600 face's own outline, verbatim.
        assert _glyph_coordinates(slot_600, 0x6000) == _glyph_coordinates(donor_600, 0x6000)

    def test_a_borrowed_slot_names_as_its_own_weight(
        self, tmp_path, union_base, extending_donor
    ):
        """The union slot composes with stage 6: WWS naming per weight.

        A non-RIBBI borrowed weight splits into the legacy
        "ChHsich <Weight>" pair plus the typographic 16/17 pair, exactly
        like a base's own non-RIBBI face (the JetBrainsMono convention
        nameID 2 follows: "Regular" for every non-RIBBI weight).
        """
        recipe = _recipe(
            tmp_path,
            f"base: {union_base.name}\ndonors:\n  - {extending_donor.name}\n"
            "output:\n  format: ttc\n",
        )

        result = build(recipe, tmp_path / "out.ttc")

        faces = _faces_by_slot(result.font_path)
        light, semibold, bold = faces[(300, False)], faces[(600, False)], faces[(700, False)]
        assert _name(light, 1) == "ChHsich Light"
        assert _name(light, 2) == "Regular"
        assert (_name(light, 16), _name(light, 17)) == ("ChHsich", "Light")
        assert _name(light, 6) == "ChHsich-Light"
        assert _name(semibold, 1) == "ChHsich SemiBold"
        assert (_name(semibold, 16), _name(semibold, 17)) == ("ChHsich", "SemiBold")
        # The base's own Bold slot keeps its RIBBI split, untouched.
        assert (_name(bold, 1), _name(bold, 2)) == ("ChHsich", "Bold")
        assert _name(bold, 16) is None
        # The RIBBI style bits follow the union weight: 600 is not bold.
        assert not semibold["OS/2"].fsSelection & 0x20
        assert not semibold["head"].macStyle & 0x1
        assert bold["OS/2"].fsSelection & 0x20

    def test_each_union_slot_passes_the_single_build_assertions(
        self, tmp_path, union_base, extending_donor
    ):
        recipe = _recipe(
            tmp_path,
            f"base: {union_base.name}\ndonors:\n  - {extending_donor.name}\n"
            "output:\n  format: ttc\n",
        )

        result = build(recipe, tmp_path / "out.ttc")

        for (_, _), face in _faces_by_slot(result.font_path).items():
            assert face["head"].unitsPerEm == 1000  # the base is the container


class TestBorrowReporting:
    """Every borrow — base side included — is stated in the table."""

    def test_the_weights_section_states_the_base_borrow(
        self, tmp_path, union_base, extending_donor
    ):
        recipe = _recipe(
            tmp_path,
            f"base: {union_base.name}\ndonors:\n  - {extending_donor.name}\n"
            "output:\n  format: ttc\n",
        )

        result = build(recipe, tmp_path / "out.ttc")

        slots = {
            slot["weight"]: slot
            for slot in _load_report(result.report_path)["weights"]
        }
        assert set(slots) == {300, 400, 600, 700}
        # Own slots carry no borrow: the base face is the base's own.
        assert "base_borrow" not in slots[400]
        assert "base_borrow" not in slots[700]
        assert slots[400]["base_face"] == 0
        assert slots[700]["base_face"] == 1
        # Donor-only slots state the base-side borrow: 300 borrows the
        # Regular (nearest), 600 borrows the Bold (|100| < |200|).
        assert slots[300]["base_borrow"] == 400
        assert slots[300]["base_face"] == 0
        assert slots[600]["base_borrow"] == 700
        assert slots[600]["base_face"] == 1
        # The donor side lands at its own weight, chosen nearest.
        assert slots[300]["borrows"][0]["weight"] == 300
        assert slots[300]["borrows"][0]["via"] == "nearest"
        assert slots[600]["borrows"][0]["weight"] == 600
        assert slots[700]["borrows"][0]["weight"] == 600

    def test_the_rendered_forms_state_the_base_borrow(
        self, tmp_path, union_base, extending_donor
    ):
        from fontalloy_core import render_text

        recipe = _recipe(
            tmp_path,
            f"base: {union_base.name}\ndonors:\n  - {extending_donor.name}\n"
            "output:\n  format: ttc\n",
        )

        result = build(recipe, tmp_path / "out.ttc")

        text = render_text(result.report)
        assert "weight 600 upright: base from 700 (borrowed), donor-0 from 600 (nearest)" in text
        assert "weight 400 upright: donor-0 from 400 (nearest)" in text

    def test_several_donors_union_into_one_slot_set(
        self, tmp_path, union_base
    ):
        donor_a = synth_ttc(
            tmp_path / "cjk-a.ttc",
            faces=[dict(family="SynthA", weight=300, codepoints=(0x4E2D, 0x3000))],
        )
        donor_b = synth_ttc(
            tmp_path / "cjk-b.ttc",
            faces=[
                dict(family="SynthB", weight=300, codepoints=(0x4E2D, 0x56FD)),
                dict(family="SynthB", weight=600, codepoints=(0x4E2D, 0x6000)),
            ],
        )
        recipe = _recipe(
            tmp_path,
            f"base: {union_base.name}\ndonors:\n  - {donor_a.name}\n  - {donor_b.name}\n"
            "output:\n  format: ttc\n",
        )

        result = build(recipe, tmp_path / "out.ttc")

        # One slot per union weight, whatever donor carried it; every
        # donor states its borrow per slot.
        slots = {
            slot["weight"]: slot
            for slot in _load_report(result.report_path)["weights"]
        }
        assert set(slots) == {300, 400, 600, 700}
        assert {b["donor"] for b in slots[300]["borrows"]} == {"donor-0", "donor-1"}
        assert _faces_by_slot(result.font_path)[(300, False)].getBestCmap()[0x3000]
        assert _faces_by_slot(result.font_path)[(300, False)].getBestCmap()[0x56FD]


class TestUnionBoundaries:
    """The union stops where transform-only and the styles demand."""

    def test_a_donor_italic_never_creates_slots_without_a_base_italic(
        self, tmp_path, union_base
    ):
        """ADR-0006's rule survives the union: a base without an italic
        face has no italic slot — the upright output serves the style,
        and a donor's italic face never conjures one."""
        italic_donor = synth_ttc(
            tmp_path / "cjk-italic.ttc",
            faces=[
                dict(
                    family="SynthCJK",
                    weight=500,
                    subfamily="Italic",
                    italic=True,
                    codepoints=(0x4E2D, 0x5000),
                )
            ],
        )
        recipe = _recipe(
            tmp_path,
            f"base: {union_base.name}\ndonors:\n  - {italic_donor.name}\n"
            "output:\n  format: ttc\n",
        )

        result = build(recipe, tmp_path / "out.ttc")

        assert set(_faces_by_slot(result.font_path)) == {(400, False), (700, False)}

    def test_a_base_with_an_italic_unions_donor_italic_weights(
        self, tmp_path
    ):
        base = synth_ttc(
            tmp_path / "base.ttc",
            faces=[
                dict(family="SynthBase", codepoints=BASE_CODEPOINTS, weight=400),
                dict(
                    family="SynthBase",
                    codepoints=BASE_CODEPOINTS,
                    weight=400,
                    subfamily="Italic",
                    italic=True,
                ),
            ],
        )
        donor = synth_ttc(
            tmp_path / "cjk.ttc",
            faces=[
                dict(
                    family="SynthCJK",
                    weight=500,
                    subfamily="Italic",
                    italic=True,
                    codepoints=(0x4E2D, 0x5000),
                )
            ],
        )
        recipe = _recipe(
            tmp_path,
            f"base: {base.name}\ndonors:\n  - {donor.name}\n"
            "output:\n  format: ttc\n",
        )

        result = build(recipe, tmp_path / "out.ttc")

        # The italic 500 lands as a slot of its own: the base-side
        # borrows the base's own italic (nearest), the donor side is the
        # donor's exact italic face — no style fallback to state.
        slots = {
            (slot["weight"], slot["style"]): slot
            for slot in _load_report(result.report_path)["weights"]
        }
        assert set(slots) == {(400, "upright"), (400, "italic"), (500, "italic")}
        assert slots[(500, "italic")]["base_borrow"] == 400
        assert slots[(500, "italic")]["borrows"][0]["weight"] == 500
        assert slots[(500, "italic")]["borrows"][0]["style_fallback"] is False

    def test_the_union_demands_ttc_for_multi_slot_output(self, tmp_path, base_font):
        donor = synth_ttc(
            tmp_path / "spread.ttc",
            faces=[
                dict(family="SynthSpread", weight=300, codepoints=(0x4E2D,)),
                dict(family="SynthSpread", weight=500, codepoints=(0x4E2D,)),
            ],
        )
        recipe = _recipe(
            tmp_path, f"base: {base_font.name}\ndonors:\n  - {donor.name}\n"
        )

        with pytest.raises(BuildError, match="union"):
            build(recipe, tmp_path / "out.ttf")

    def test_an_explicit_weights_selection_replaces_the_union(
        self, tmp_path, union_base, extending_donor
    ):
        """The other two merge modes keep their semantics: the GUI's
        EN-only / CJK-only selections land as explicit ``weights``,
        which names base faces — never union extras."""
        recipe = _recipe(
            tmp_path,
            f"base: {union_base.name}\ndonors:\n  - {extending_donor.name}\n"
            "weights:\n  - weight: 400\n",
        )

        result = build(recipe, tmp_path / "out.ttf")

        font = TTFont(result.font_path)
        assert (font["OS/2"].usWeightClass, bool(font["OS/2"].fsSelection & 0x01)) == (
            400,
            False,
        )
        weights = _load_report(result.report_path)["weights"]
        assert [slot["weight"] for slot in weights] == [400]

    def test_skipped_base_faces_still_report_alongside_union_slots(
        self, tmp_path
    ):
        base = synth_ttc(
            tmp_path / "base.ttc",
            faces=[
                dict(family="SynthBase", codepoints=BASE_CODEPOINTS, weight=400),
                dict(
                    family="SynthBase",
                    codepoints=BASE_CODEPOINTS,
                    weight=400,
                    subfamily="Book",
                ),
            ],
        )
        donor = synth_ttc(
            tmp_path / "cjk.ttc",
            faces=[dict(family="SynthCJK", weight=600, codepoints=(0x4E2D,))],
        )
        recipe = _recipe(
            tmp_path,
            f"base: {base.name}\ndonors:\n  - {donor.name}\n"
            "output:\n  format: ttc\n",
        )

        result = build(recipe, tmp_path / "out.ttc")

        report = _load_report(result.report_path)
        # The duplicate 400's drop rides the report (round 29) while the
        # union adds the 600 slot.
        skipped = report["output"]["skipped_faces"]
        assert [entry["subfamily"] for entry in skipped] == ["Book"]
        assert {slot["weight"] for slot in report["weights"]} == {400, 600}


class TestSubsetByteIdentity:
    """A donor within the base's weights changes nothing (#27's pin)."""

    def test_a_subset_donor_builds_the_pre_union_bytes(self, tmp_path):
        """The r26 no-regression gate: donor weights ⊆ base weights is
        the common real pair (JetBrains Mono x any CJK family), and its
        output — font bytes AND report content — must stay exactly what
        the pre-union pipeline produced. The hashes were taken from the
        pre-change build; the report's text is normalized over the
        run's tmp path before hashing."""
        base = synth_ttc(
            tmp_path / "base-family.ttc",
            faces=[
                dict(family="SynthBase", codepoints=BASE_CODEPOINTS, weight=400),
                dict(
                    family="SynthBase",
                    codepoints=BASE_CODEPOINTS,
                    weight=700,
                    subfamily="Bold",
                ),
                dict(
                    family="SynthBase",
                    codepoints=BASE_CODEPOINTS,
                    weight=400,
                    subfamily="Italic",
                    italic=True,
                ),
            ],
        )
        donor = synth_ttc(
            tmp_path / "cjk-family.ttc",
            faces=[
                dict(family="SynthCJK", weight=400, codepoints=(0x4E2D, 0x56FD)),
                dict(family="SynthCJK", weight=700, codepoints=(0x4E2D, 0x6000)),
            ],
        )
        recipe = _recipe(
            tmp_path,
            f"base: {base.name}\ndonors:\n  - {donor.name}\n"
            "output:\n  format: ttc\n",
        )

        result = build(recipe, tmp_path / "out.ttc")

        assert (
            hashlib.sha256(result.font_path.read_bytes()).hexdigest()
            == SUBSET_FONT_SHA256
        )
        text = result.report_path.read_text(encoding="utf-8")
        # The JSON text escapes the path's separators; replace the
        # escaped form so every run normalizes to the same bytes.
        normalized = text.replace(json.dumps(str(tmp_path))[1:-1], "<TMP>")
        assert (
            hashlib.sha256(normalized.encode()).hexdigest() == SUBSET_REPORT_SHA256
        )
        # And the subset case really is union-inert: three base slots,
        # no donor-only extras, no borrow records on the base side.
        slots = _load_report(result.report_path)["weights"]
        assert [slot["weight"] for slot in slots] == [400, 400, 700]
        assert all("base_borrow" not in slot for slot in slots)
