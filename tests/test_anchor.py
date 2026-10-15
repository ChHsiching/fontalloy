"""The measured anchor integration test (issue #8, ADR-0003, round-20
correction):

JetBrains Mono x Noto Sans SC — both 1000 upem — under the default
(auto-school) normalization: A = 600, k = 0.9988 (the optical term
1.23*730/899 — the grid term 1.2 would put the Han ink at 1.49x the
cap height, outside the Noto-school zone), and the Han ink span lands
entirely inside the base font's existing metrics, with zero
vertical-metric table changes.

Font sourcing: the catalog's pinned pair, fetched through the assets
machinery exactly as ``fontalloy assets fetch`` does it — the repo
manifest (``assets/fonts.manifest.json``) filtered down to the
JetBrainsMono and NotoSansSC families, every file sha256-verified
against its pin. Downloads cache under the gitignored ``.scratch``
directory, so the first run pays ~26 MB and later runs nothing. The
test skips (rather than fails) when the pair cannot be fetched, and
``FONTALLOY_SKIP_ANCHOR=1`` opts out entirely.

Scoping: the anchor is a measurement of representative common Han ink,
so the harness subsets the pinned donor down to the sample characters
(fontTools subset — the pipeline's own stage-3 tool) before the build.
Recipes cannot turn off the default fill (a rule whose fonts all lack a
codepoint falls back to the global precedence), so an unsubsetting
recipe would graft the donor's entire ~30k-glyph coverage — including
genuinely tall non-Han glyphs (vertical kana marks 〪〫, precomposed
Latin) whose ink exceeds the base's win metrics; covering those is
exactly the grow-only-to-prevent-clipping rule, but it is not the
measured anchor.

Face notes. The pinned JetBrainsMono artifact is the Nerd Font release
(v3.5.1); its Regular face carries upstream JetBrains Mono's metrics
(upem 1000, typo 1020/-300, win 1020/300, Latin advance 600, declared
sCapHeight 730). The pinned NotoSansSC artifact is the google/fonts
variable font whose fvar default is wght=100; the anchor measurement
corresponds to that default instance (the recipe leaves ``instance``
unset, which is the pipeline's documented "default instance" behavior),
and the anchor's [-68, +830] is exactly the representative common
glyph 中 under the auto k = 0.9988.
"""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

import pytest
from fontTools import subset
from fontTools.misc.fixedTools import otRound
from fontTools.pens.boundsPen import BoundsPen
from fontTools.ttLib import TTFont

from fontalloy_core.assets import fetch_catalog
from fontalloy_core.errors import AssetsError
from fontalloy_core.load import load_face
from fontalloy_core.recipe import FontRef

pytestmark = pytest.mark.anchor

_REPO_ROOT = Path(__file__).resolve().parent.parent
_MANIFEST = _REPO_ROOT / "assets" / "fonts.manifest.json"
#: The gitignored download cache (survives across runs).
_CACHE = _REPO_ROOT / ".scratch" / "anchor-fonts"
_ANCHOR_FAMILIES = ("JetBrainsMono", "NotoSansSC")
#: The base face inside the extracted JetBrainsMono Nerd Font zip.
_BASE_FACE = "JetBrainsMono/JetBrainsMonoNerdFont-Regular.ttf"
#: The donor: the pinned variable Noto Sans SC at its default instance.
_DONOR_FILE = "NotoSansSC[wght].ttf"
#: The anchor sample of representative common Han characters, subset
#: into the cached donor beside the pinned original.
_SAMPLE = (0x4E2D, 0x56FD, 0x4EBA, 0x65E5, 0x672C)  # 中 国 人 日 本
_SAMPLE_DONOR = "NotoSansSC-anchor-sample.ttf"


@pytest.fixture(scope="module")
def anchor_pair(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, Path]:
    """Fetch (and sha256-verify) the pinned pair; skip when offline."""
    if os.environ.get("FONTALLOY_SKIP_ANCHOR"):
        pytest.skip("FONTALLOY_SKIP_ANCHOR is set")

    manifest = json.loads(_MANIFEST.read_text(encoding="utf-8"))
    families = [f for f in manifest["families"] if f["family"] in _ANCHOR_FAMILIES]
    assert {f["family"] for f in families} == set(_ANCHOR_FAMILIES)

    # A filtered manifest beside the license files it references, so
    # fetch_catalog validates exactly what the CLI would.
    root = tmp_path_factory.mktemp("anchor-manifest")
    (root / "fonts.manifest.json").write_text(
        json.dumps({"schema": manifest["schema"], "families": families}),
        encoding="utf-8",
    )
    # Every license file the FILTERED manifest references (round 7:
    # NotoSansSC gained Mono/HW variants with their own license files).
    (root / "licenses").mkdir()
    for entry in families:
        shutil.copy(
            _REPO_ROOT / "assets" / entry["license_file"],
            root / entry["license_file"],
        )

    try:
        fetch_catalog(root / "fonts.manifest.json", _CACHE)
    except AssetsError as exc:
        pytest.skip(f"the pinned anchor pair could not be fetched: {exc}")

    # Stage-3 style: subset the donor to the anchor sample (the recipe
    # cannot disable the default fill, see the module docstring).
    sample = _CACHE / _SAMPLE_DONOR
    if not sample.is_file():
        options = subset.Options()
        options.recalc_timestamp = False
        donor = subset.load_font(_CACHE / _DONOR_FILE, options)
        subsetter = subset.Subsetter(options)
        subsetter.populate(unicodes=list(_SAMPLE))
        subsetter.subset(donor)
        donor.save(sample)
    return _CACHE / _BASE_FACE, sample


def _bounds(font: TTFont, name: str) -> tuple[int, int, int, int]:
    pen = BoundsPen(font.getGlyphSet())
    font.getGlyphSet()[name].draw(pen)
    assert pen.bounds is not None
    return pen.bounds  # type: ignore[return-value]


def _scaled(box: tuple[int, int, int, int], factor: float):
    return tuple(otRound(value * factor) for value in box)


#: The auto school's k over the anchor sample: the smaller of the grid
#: term 2A/U = 1.2 and the optical term ratio*capHeight/H_ink =
#: 1.23*730/899 = 0.9988 (the subsetted sample's H_ink = p90 = 899).
#: The optical term binds: the grid term would scale the 899-unit ink
#: to 1079 = 1.48x the 730-unit cap height, outside the Noto-school
#: ~1.05-1.3x zone; auto lands the ink at 898 = 1.23x, the native
#: Noto pairing's own number (Noto Sans SC measures 906/733 = 1.236).
_K_AUTO = 1.23 * 730 / 899


class TestMeasuredAnchor:
    """JetBrains Mono x Noto/Source Han: A = 600, k = 0.9988 (the auto
    school's optical term), Han ink [-68, +830] = 1.23x the cap height,
    inside the base's existing metrics, zero table changes."""

    def test_the_anchor_pair_reproduces_the_measured_values(
        self, tmp_path: Path, anchor_pair: tuple[Path, Path]
    ):
        base_path, donor_path = anchor_pair
        recipe = tmp_path / "recipe.yaml"
        # Absolute paths (the recipe resolves paths against itself, and
        # the anchor fonts live in the shared cache, not in tmp_path).
        # Round 26: the anchor measurement pins the auto school (plain
        # is the recipe default now; the anchor is the school's oracle).
        recipe.write_text(
            f"base: {base_path.resolve().as_posix()}\n"
            f"donors:\n  - {donor_path.resolve().as_posix()}\n"
            "normalization:\n  mode: auto\n",
            encoding="utf-8",
        )

        from fontalloy_core import build

        result = build(recipe, tmp_path / "out.ttf")

        out = TTFont(result.font_path)
        base = TTFont(base_path)
        cmap = out.getBestCmap()

        # upem unified: both fonts (and the output) run at 1000.
        assert out["head"].unitsPerEm == base["head"].unitsPerEm == 1000

        # A = 600: the base font's Latin advance, untouched.
        latin = out["hmtx"][cmap[0x41]][0]
        assert latin == 600

        # The grid school: CJK advance = exactly 2x the Latin advance.
        for cp in _SAMPLE:
            assert out["hmtx"][cmap[cp]][0] == 2 * latin == 1200

        # k = 0.9988: the auto school's optical term binds (the grid
        # term 2A/U = 1.2 sits ABOVE it, the overflow guard at
        # 0.95*1320/899 = 1.39 above both) — proven by the ink, which
        # scales by exactly _K_AUTO about the shared baseline.
        loaded = load_face(FontRef(path=donor_path), role="donor")
        donor, donor_cmap = loaded.font, loaded.font.getBestCmap()
        for cp in _SAMPLE:
            assert _bounds(out, cmap[cp]) == _scaled(
                _bounds(donor, donor_cmap[cp]), _K_AUTO
            )

        # The anchor's measured Han ink span: 中 lands at [-68, +830] —
        # an ink height of 898 = 1.23x the base's 730-unit cap height,
        # the Noto native pairing's own ratio (Noto Sans SC itself
        # measures 906/733 = 1.236).
        assert _bounds(out, cmap[0x4E2D]) == (105, -68, 889, 830)
        assert (830 - (-68)) / 730 == pytest.approx(1.23, abs=0.01)

        # ...entirely inside the base font's existing metrics (typo
        # 1020/-300, win 1020/300) — and the anchor build therefore
        # changes no vertical metric table at all: zero table changes.
        os2, base_os2 = out["OS/2"], base["OS/2"]
        hhea, base_hhea = out["hhea"], base["hhea"]
        for cp in _SAMPLE:
            _x0, y0, _x1, y1 = _bounds(out, cmap[cp])
            assert y1 <= base_os2.usWinAscent
            assert y1 <= base_os2.sTypoAscender
            assert -y0 <= base_os2.usWinDescent
            assert -y0 <= -base_os2.sTypoDescender
        for attr in ("ascent", "descent", "lineGap"):
            assert getattr(hhea, attr) == getattr(base_hhea, attr)
        for attr in (
            "sTypoAscender", "sTypoDescender", "sTypoLineGap",
            "usWinAscent", "usWinDescent",
        ):
            assert getattr(os2, attr) == getattr(base_os2, attr)

        # The coverage is the base's plus the anchor sample — and the
        # grafted glyphs carry no donor instructions.
        assert set(cmap) == set(base.getBestCmap()) | set(_SAMPLE)
        for cp in _SAMPLE:
            program = getattr(out["glyf"][cmap[cp]], "program", None)
            assert not program or not program.getBytecode()

    def test_the_anchor_report_verifies_the_build_end_to_end(
        self, tmp_path: Path, anchor_pair: tuple[Path, Path]
    ):
        """The verification report of the measured anchor pair (issue
        #12): coverage, borrow table, and the metric comparison —
        including the untouched-line-height proof — asserted on the
        JSON a consumer reads back from disk."""
        import json

        from fontalloy_core import build, render_text

        base_path, donor_path = anchor_pair
        recipe = tmp_path / "recipe.yaml"
        recipe.write_text(
            f"base: {base_path.resolve().as_posix()}\n"
            f"donors:\n  - {donor_path.resolve().as_posix()}\n"
            "normalization:\n  mode: auto\n",
            encoding="utf-8",
        )

        result = build(recipe, tmp_path / "out.ttf")
        report = json.loads(result.report_path.read_text(encoding="utf-8"))
        base = TTFont(base_path)

        assert report["schema"] == "fontalloy/verification-report@v2"

        # Coverage: the effective table (the base's coverage plus the
        # anchor sample) landed whole; the recipe declares no rules, so
        # there are no per-rule scopes to gap-check.
        expected_coverage = set(base.getBestCmap()) | set(_SAMPLE)
        assert report["coverage"]["overall"] == {
            "requested": len(expected_coverage),
            "covered": len(expected_coverage),
            "missing": [],
            "missing_total": 0,
            "missing_truncated": False,
        }
        assert report["coverage"]["rules"] == []

        # The borrow table: one slot (the base's Regular), the donor's
        # default-instance face, nearest-matched, no style fallback.
        [slot] = report["weights"]
        assert (slot["weight"], slot["style"]) == (400, "upright")
        [borrow] = slot["borrows"]
        donor_face = load_face(FontRef(path=donor_path), role="donor")
        assert borrow["donor"] == "donor-0"
        # The instantiated default instance (wght=100) names its own
        # typographic family ("Noto Sans SC Thin") — the loaded face's
        # identity, exactly what landed in the output.
        assert borrow["family"] == donor_face.info.family
        assert "Noto Sans SC" in borrow["family"]
        assert borrow["weight"] == donor_face.info.weight
        assert borrow["via"] == "nearest"
        assert borrow["style_fallback"] is False

        # The metric comparison: the anchor's measured values, before
        # and after, read back from the built font.
        [face] = report["metrics"]["faces"]
        assert face["upem"] == {"base": 1000, "output": 1000}
        assert face["latin_advance"] == {"base": 600, "output": 600}
        assert face["cjk_advance"] == {"base": None, "output": 1200}
        assert face["grid_ratio"] == 2.0
        hhea, os2 = base["hhea"], base["OS/2"]
        assert face["ascents"]["hhea"]["base"] == hhea.ascent
        assert face["descents"]["hhea"]["base"] == hhea.descent
        assert face["line_gap"]["hhea"]["base"] == hhea.lineGap
        assert face["ascents"]["typo"]["base"] == os2.sTypoAscender
        assert face["descents"]["typo"]["base"] == os2.sTypoDescender
        assert face["line_gap"]["typo"]["base"] == os2.sTypoLineGap
        # The anchor's zero-table-changes: the Han ink [-68, +830] sits
        # inside the base's win metrics, so usWin did not grow.
        assert face["ascents"]["us_win"] == {
            "base": os2.usWinAscent,
            "output": os2.usWinAscent,
        }
        assert face["descents"]["us_win"] == {
            "base": os2.usWinDescent,
            "output": os2.usWinDescent,
        }
        # The proof the line-height contract held: hhea and typo are
        # untouched against the base face.
        assert face["line_height_untouched"] == {"hhea": True, "typo": True}

        # k and s0 actually applied per donor: both fonts run at 1000
        # upem (s0 = 1), the auto school's optical term binds
        # (k = 1.23*730/899 = 0.9988, under the grid term 1.2).
        [record] = face["normalization"]
        assert record["donor"] == "donor-0"
        assert record["upem"] == 1000
        assert record["s0"] == pytest.approx(1.0)
        assert record["k"] == pytest.approx(_K_AUTO)
        assert record["scale"] == pytest.approx(_K_AUTO)

        # The human form ships with the build and states the same facts.
        assert result.report_html_path is not None
        assert result.report_html_path.is_file()
        text = render_text(result.report)
        assert "line height untouched: hhea yes, typo yes" in text
        assert "grid ratio 2" in text
