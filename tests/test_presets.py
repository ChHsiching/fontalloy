"""Language presets: the bundled fc-lang data and its public registry.

The preset data layer (``fontalloy_core.presets``) is a public interface:
the resolver consumes it through ``BUILTIN_NAMED_SETS``, and later
consumers (serve, the GUI's preset picker) read the same registry. These
tests assert the bundled corpus against counts measured independently in
the fc-lang research note — the numbers are the oracle, never something
the code recomputes. Recipe-driven behavior is observed through ``build``
(seam 1 of the testing decisions), with synthetic fixture fonts.
"""

from __future__ import annotations

import pytest

from fontalloy_core import presets

#: Codepoint counts measured independently against fontconfig's fc-lang
#: corpus (research note, 2026-10-10; zh_hk is the raw supplementary set).
#: The bundled data must reproduce them: re-pin the corpus deliberately,
#: never edit the numbers to match a silent upstream drift.
MEASURED_COUNTS = {
    "zh_cn": 6765,
    "zh_tw": 13063,
    "ja": 2314,
    "ko": 2442,
    "zh_hk": 1083,
}


class TestBundledCorpus:
    """The fc-lang corpus ships whole, with its license notice."""

    def test_the_corpus_is_bundled_with_a_provenance_and_license_notice(self):
        orth_files = sorted(presets.DATA_DIR.glob("*.orth"))
        assert len(orth_files) == 341

        notice = (presets.DATA_DIR / "README.md").read_text(encoding="utf-8")
        assert "fontconfig" in notice
        assert presets.FCLANG_REF in notice

    def test_every_orth_file_keeps_a_permissive_license_header(self):
        for path in presets.DATA_DIR.glob("*.orth"):
            text = path.read_text(encoding="utf-8")
            assert (
                "Permission to use, copy, modify" in text
                or "SPDX-License-Identifier: HPND" in text
            ), f"{path.name} lost its license header"


class TestRawLanguageSets:
    """Every ``.orth`` file parses to its raw fc-lang charset."""

    @pytest.mark.parametrize(
        ("name", "expected"), sorted(MEASURED_COUNTS.items())
    )
    def test_the_cjk_benchmarks_reproduce_the_measured_counts(
        self, name, expected
    ):
        assert len(presets.LANGUAGE_SETS[name]) == expected

    def test_every_corpus_language_has_a_nonempty_raw_set(self):
        names = {path.stem for path in presets.DATA_DIR.glob("*.orth")}
        assert set(presets.LANGUAGE_SETS) == names
        assert all(presets.LANGUAGE_SETS[name] for name in names)

    def test_include_directives_compose_sibling_files(self):
        # zh_mo.orth is exactly `include zh_hk.orth`; zh_sg.orth is
        # exactly `include zh_cn.orth` — each must adopt the included
        # charset whole, or it silently under-counts.
        assert presets.LANGUAGE_SETS["zh_mo"] == presets.LANGUAGE_SETS["zh_hk"]
        assert presets.LANGUAGE_SETS["zh_sg"] == presets.LANGUAGE_SETS["zh_cn"]

    def test_zh_cn_and_ja_overlap_by_the_measured_1391_codepoints(self):
        # Coverage, not partition: the CJK presets share codepoints, and
        # the merge must treat them as overlapping coverage (seam-1 test
        # below exercises the merge itself).
        overlap = presets.LANGUAGE_SETS["zh_cn"] & presets.LANGUAGE_SETS["ja"]
        assert len(overlap) == 1391


class TestPresentationPresets:
    """A preset is the union of its named sub-blocks.

    For every language the presentation preset matches the raw fc-lang
    set, except the Hong Kong and Macau supplements: their files hold
    only the supplement (zero intersection with zh_tw), so their preset
    presents Traditional Chinese plus the supplement as its own
    toggleable sub-block — the raw boundary stays in LANGUAGE_SETS.
    """

    def test_every_language_is_a_preset_matching_its_raw_set(self):
        for name, raw_set in presets.LANGUAGE_SETS.items():
            preset = presets.PRESETS[name]
            assert preset.name == name
            if name not in ("zh_hk", "zh_mo"):
                assert preset.codepoints == raw_set, name

    def test_zh_hk_presents_traditional_chinese_plus_the_supplement(self):
        preset = presets.PRESETS["zh_hk"]
        assert [block.name for block in preset.sub_blocks] == [
            "zh_tw",
            "zh_hk_supplement",
        ]
        zh_tw, supplement = preset.sub_blocks
        assert zh_tw.codepoints == presets.LANGUAGE_SETS["zh_tw"]
        assert supplement.codepoints == presets.LANGUAGE_SETS["zh_hk"]
        assert not zh_tw.codepoints & supplement.codepoints  # disjoint blocks
        assert len(preset.codepoints) == 13063 + 1083  # 14,146

    def test_zh_mo_shares_the_hong_kong_presentation(self):
        # zh_mo.orth is literally `include zh_hk.orth`: same raw set,
        # so the same Traditional-Chinese-plus-supplement presentation.
        assert (
            presets.PRESETS["zh_mo"].codepoints
            == presets.PRESETS["zh_hk"].codepoints
        )

    def test_a_preset_is_the_union_of_its_enabled_sub_blocks(self):
        preset = presets.PRESETS["zh_hk"]
        blocks = {block.name: block for block in preset.sub_blocks}

        # All blocks enabled: the full preset.
        every = frozenset().union(
            *(block.codepoints for block in blocks.values())
        )
        assert every == preset.codepoints

        # The supplement toggled off: Traditional Chinese remains.
        without_supplement = blocks["zh_tw"].codepoints
        assert without_supplement == presets.PRESETS["zh_tw"].codepoints


class TestBuiltinNamedSets:
    """The registry the resolver plugs into: every preset selectable."""

    def test_every_preset_and_sub_block_is_selectable_by_name(self):
        named = presets.builtin_named_sets()
        expected = set(presets.PRESETS) | {"zh_hk_supplement"}
        assert set(named) == expected

    def test_named_sets_are_sorted_disjoint_scalar_intervals(self):
        for intervals in presets.builtin_named_sets().values():
            assert intervals == tuple(sorted(intervals))
            for (_, end), (start, _) in zip(intervals, intervals[1:]):
                assert start > end + 1  # sorted, disjoint, non-adjacent
            for start, end in intervals:
                assert 0 <= start <= end <= 0x10FFFF

    def test_named_sets_expand_back_to_the_preset_codepoints(self):
        def expand(intervals):
            return frozenset(
                cp for start, end in intervals for cp in range(start, end + 1)
            )

        named = presets.builtin_named_sets()
        assert expand(named["zh_cn"]) == presets.PRESETS["zh_cn"].codepoints
        assert len(expand(named["zh_hk_supplement"])) == 1083
        assert len(expand(named["zh_hk"])) == 14146
