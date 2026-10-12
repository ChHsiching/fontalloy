"""Data tests for the COMMITTED catalog manifest (the catalog expansion).

The manifest is the single source of truth (ADR-0005), so its own data
is testable: the loader's structural guarantees (sha256 shape, license
file references, per-entry uniqueness) already hold for the committed
file the moment it loads — these tests pin the round-7 EXPANSION data:
the new families exist with the licenses and checksum provenance the
research verified, the typed variant axes are well-formed, and the
notices document renders the new license obligations (IPA rename rule,
CC0, the LXGW reserved-name carve-out).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "core"))

from fontalloy_core.catalog import AXIS_IDS, CatalogError, load_manifest  # noqa: E402
from fontalloy_core.notices import generate_notices  # noqa: E402

MANIFEST_PATH = REPO_ROOT / "assets" / "fonts.manifest.json"

#: The round-7 expansion families: family -> SPDX id (every entry of the
#: family carries it; the licenses were verified upstream by the
#: research pass, `fontalloy-notes/cjk-catalog-research.md`).
EXPANSION_LICENSES: dict[str, str] = {
    "UDEVGothic": "OFL-1.1-RFN",
    "HackGen": "OFL-1.1-RFN",
    "PlemolJP": "OFL-1.1-RFN",
    "BizinGothic": "OFL-1.1-RFN",
    "GuguruSansCode": "OFL-1.1-RFN",
    "SourceHanCodeJP": "OFL-1.1-RFN",
    "LxgwNeoXiHei": "IPA",
    "LxgwNeoXiHeiCode": "IPA",
    "LxgwNeoZhiSong": "IPA",
    "Xiaolai": "OFL-1.1-no-RFN",
    "XiaolaiMono": "OFL-1.1-no-RFN",
    "LxgwWenKaiTC": "OFL-1.1-no-RFN",
    "LxgwWenKaiMonoTC": "OFL-1.1-no-RFN",
    "LxgwZhenKai": "OFL-1.1-RFN",
    "Yozai": "OFL-1.1-RFN",
    "LxgwMarkerGothic": "OFL-1.1-no-RFN",
    "Chillkai": "OFL-1.1-no-RFN",
    "ChillRoundGothic": "OFL-1.1-RFN",
    "ChillRound": "OFL-1.1-RFN",
    "GlowSans": "MIT",
    "HuiwenMincho": "CC0-1.0",
    # The 7z-only family the expansion originally skipped; onboarded
    # when the fetch pipeline learned to extract .7z artifacts.
    "LxgwBrightCode": "OFL-1.1-RFN",
}

#: New variants of already-cataloged families (wave 3): family/variant.
EXPANSION_VARIANTS = {
    ("NotoSansSC", "Mono"),
    ("NotoSansSC", "HW"),
}


@pytest.fixture(scope="module")
def committed() -> list:
    """The committed manifest's entries (loads or fails the module)."""
    catalog = load_manifest(MANIFEST_PATH)
    return list(catalog.entries)


def by_family(entries, family: str) -> list:
    return [entry for entry in entries if entry.family == family]


def test_committed_manifest_loads(committed) -> None:
    # The strict loader validates every field, sha256 shape, uniqueness,
    # and license file reference — loading is the structural contract.
    assert len(committed) >= 114


def test_expansion_families_are_pinned(committed) -> None:
    seen = set()
    for entry in committed:
        expected = EXPANSION_LICENSES.get(entry.family)
        if expected is None:
            continue
        seen.add(entry.family)
        assert entry.license_spdx == expected, entry.family
        # No upstream publishes checksums for these releases: every
        # expansion pin is download-once, self-computed.
        assert entry.checksum_source == "self-computed", entry.family
        assert entry.sha256 is not None
        assert entry.upstream_url.startswith("https://github.com/")
        assert entry.copyright, entry.family
    assert seen == set(EXPANSION_LICENSES)


def test_expansion_variants_of_existing_families(committed) -> None:
    entries = {(entry.family, entry.variant): entry for entry in committed}
    for key in EXPANSION_VARIANTS:
        assert key in entries, key
        assert entries[key].checksum_source == "self-computed"
        # The width axis the research named: 思源等宽 (mono) and 半宽 (hw).
        expected_width = "mono" if key[1] == "Mono" else "hw"
        assert entries[key].axes.get("cjk_width") == expected_width


def test_variant_axes_are_typed_and_contrasting(committed) -> None:
    """Every entry's axes use known ids, and the chip model's source
    contrast exists where the research found it (yuru7 base/NF icons;
    WenKai mono/screen/GB; NotoSansSC mono/hw)."""
    for entry in committed:
        assert set(entry.axes) <= set(AXIS_IDS), entry.family
        for axis, value in entry.axes.items():
            assert value.strip(), f"{entry.family}.{axis}"

    icons = {
        entry.axes.get("icons")
        for entry in by_family(committed, "UDEVGothic")
    }
    assert icons == {"plain", "nf"}

    widths = {
        entry.axes.get("cjk_width") for entry in by_family(committed, "NotoSansSC")
    }
    assert widths == {None, "mono", "hw"}

    rendering = set()
    charset = set()
    for family in ("LXGWWenKai", "LXGWWenKaiMono", "LXGWWenKaiScreen",
                   "LXGWWenKaiMonoScreen", "LXGWWenKaiGBScreen",
                   "LXGWWenKaiMonoGBScreen"):
        for entry in by_family(committed, family):
            if "rendering" in entry.axes:
                rendering.add(entry.axes["rendering"])
            if "charset" in entry.axes:
                charset.add(entry.axes["charset"])
    assert rendering == {"screen"}
    assert charset == {"GB"}


def test_wenkai_family_variants_carry_weights(committed) -> None:
    weights = {
        entry.axes.get("weight")
        for entry in by_family(committed, "LXGWWenKai")
    }
    assert weights == {"Light", "Regular", "Medium"}


def test_ipa_families_carry_the_rename_rule(committed) -> None:
    """The IPA license's clause 3(4) is an RFN-like rename rule: the
    manifest records the reserved names so the notices can state it."""
    for family in ("LxgwNeoXiHei", "LxgwNeoZhiSong", "LxgwNeoXiHeiCode"):
        entries = by_family(committed, family)
        assert entries, family
        for entry in entries:
            assert entry.license_spdx == "IPA"
            assert entry.rfn and entry.rfn_names, family


def test_lxgwbrightcode_ships_the_full_7z_matrix(committed) -> None:
    """The family 7z extraction unlocks: Monaspace Argon × WenKai Lite,
    upstream's variant matrix {base, GB, TC} × {plain, NF} pinned as six
    .7z artifacts with self-computed checksums (upstream publishes no
    checksums) and the Monaspace reserved names carried on every cut."""
    entries = by_family(committed, "LxgwBrightCode")
    assert {e.variant for e in entries} == {
        "Standard", "GB", "TC", "NF", "NF-GB", "NF-TC"
    }
    for entry in entries:
        assert entry.file.endswith(".7z"), entry.variant
        assert entry.upstream_url == (
            "https://github.com/lxgw/LxgwBright-Code/releases/download/"
            f"v2.922/{entry.file}"
        )
        assert entry.checksum_source == "self-computed"
        assert entry.sha256 is not None
        assert entry.rfn
        assert "Monaspace" in " ".join(entry.rfn_names)
        assert entry.axes["cjk_width"] == "mono"
        assert entry.axes["style"] == "kai"

    icons = {e.axes["icons"] for e in entries}
    regions = {e.axes["region"] for e in entries}
    charsets = {e.axes.get("charset") for e in entries}
    assert icons == {"plain", "nf"}
    assert regions == {"SC", "TC"}
    assert charsets == {None, "GB"}


def _manifest_with_patch(tmp_path: Path, patch: dict) -> Path:
    """The committed manifest with entry 0's axes patched, on a copy of
    the licenses directory (license_file resolves against the manifest's
    own directory)."""
    import shutil

    shutil.copytree(MANIFEST_PATH.parent / "licenses", tmp_path / "licenses")
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    manifest["families"][0]["axes"] = patch
    bad = tmp_path / "fonts.manifest.json"
    bad.write_text(json.dumps(manifest), encoding="utf-8")
    return bad


def test_unknown_axis_is_rejected(tmp_path: Path) -> None:
    bad = _manifest_with_patch(tmp_path, {"colour": "red"})
    with pytest.raises(CatalogError, match="unknown variant axis 'colour'"):
        load_manifest(bad)


def test_malformed_axis_value_is_rejected(tmp_path: Path) -> None:
    bad = _manifest_with_patch(tmp_path, {"icons": 42})
    with pytest.raises(CatalogError, match="axis 'icons' must be a non-empty string"):
        load_manifest(bad)


def test_notices_render_the_expansion_obligations() -> None:
    text = generate_notices(MANIFEST_PATH)
    # The IPA rename rule (clause 3(4)) and CC0 note state their duties.
    assert "Derived Program may not use the Licensed Program's name" in text
    assert "waives all copyright" in text
    # The LXGW reserved-name carve-out covers ZhenKai's license file too.
    assert text.count("Reserved-name carve-out") >= 2
    # Every expansion family renders a section with its upstream pin.
    for family in ("UDEVGothic", "HuiwenMincho", "SourceHanCodeJP", "GlowSans",
                   "LxgwBrightCode"):
        assert f"### {family}" in text, family
    # ...and the vendored license texts are embedded once each.
    assert "### IPA-LxgwNeoXiHei.txt" in text
    assert "### MIT-GlowSans.txt" in text
    assert "### CC0-1.0.txt" in text
    assert "### OFL-1.1-SourceHanSans.txt" in text
    assert "### OFL-1.1-LxgwBrightCode.txt" in text


def test_notices_family_filter_rejects_unknown() -> None:
    with pytest.raises(CatalogError, match="unknown family"):
        generate_notices(MANIFEST_PATH, families=["NoSuchFamily"])
