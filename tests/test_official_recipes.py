"""The committed official recipes (issue #23).

Three layers of proof, matching the acceptance criteria:

- **Shape**: every recipe under ``recipes/`` parses through the strict
  loader; every font reference is a catalog family the committed
  manifest pins (never a loose URL or a path), variants disambiguate
  multi-entry families, and output naming stays clear of every
  referenced family's Reserved Font Names.
- **Synthetic builds**: each official recipe — the exact committed
  YAML, unchanged — builds green against a synthetic catalog that
  mirrors its references (tiny fixture fonts inside the same zip /
  bare-file layout the real fetched catalog has), where the real fonts
  would be far too heavy for the unit suite. The community sample
  builds through the identical call and rebuilds byte-identically:
  the share unit works for anyone, not just the project.
- **The real pair** (``recipes-online`` marked, skipped offline): the
  flagship recipe builds against the genuinely fetched catalog — the
  same fetch-filter + build + fonts-dir composition CI runs.
"""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

from conftest import synth_font, synth_variable_font

from fontalloy_core.build import build
from fontalloy_core.catalog import load_manifest
from fontalloy_core.recipe import load_recipe

_REPO_ROOT = Path(__file__).resolve().parent.parent
_RECIPES_DIR = _REPO_ROOT / "recipes"
_MANIFEST = _REPO_ROOT / "assets" / "fonts.manifest.json"

BASE_CODEPOINTS = (0x0041, 0x0062, 0x0021)
DONOR_CODEPOINTS = (0x4E2D, 0x56FD, 0x4EBA)


def _official_recipes() -> list[Path]:
    return sorted(_RECIPES_DIR.glob("*.yaml"))


def _all_recipes() -> list[Path]:
    return sorted(_RECIPES_DIR.rglob("*.yaml"))


# --- shape: the strict loader and the committed manifest --------------------


def test_the_recipes_directory_exists_with_official_and_community_sets():
    official = _official_recipes()
    community = sorted((_RECIPES_DIR / "community").glob("*.yaml"))
    assert len(official) >= 3, "the flagship, weights, and preset-mix recipes"
    assert community, "the community sample recipe"
    stems = {p.stem for p in official}
    assert stems & {"chhsich-zh-cn", "chhsich-weights", "chhsich-noto"}


@pytest.mark.parametrize("recipe_path", _all_recipes(), ids=lambda p: p.name)
def test_every_recipe_parses_strictly(recipe_path: Path):
    recipe = load_recipe(recipe_path)
    assert recipe.donors, "a merge needs at least one donor"
    for ref in (recipe.base, *recipe.donors):
        assert ref.is_catalog_ref, (
            f"{recipe_path.name}: font references must name catalog "
            "families (the manifest pins them), not paths"
        )


@pytest.mark.parametrize("recipe_path", _all_recipes(), ids=lambda p: p.name)
def test_every_reference_is_pinned_by_the_committed_manifest(
    recipe_path: Path,
):
    catalog = load_manifest(_MANIFEST)
    recipe = load_recipe(recipe_path)
    for ref in (recipe.base, *recipe.donors):
        matches = [e for e in catalog.entries if e.family == ref.family]
        assert matches, f"{recipe_path.name}: family {ref.family!r} is not in the manifest"
        variants = {e.variant for e in matches}
        if len(matches) > 1:
            assert ref.variant in variants, (
                f"{recipe_path.name}: family {ref.family!r} carries "
                f"variants {sorted(variants)}; the reference must pick one"
            )
        if ref.pattern is not None:
            assert "/" not in ref.pattern and "\\" not in ref.pattern


@pytest.mark.parametrize("recipe_path", _all_recipes(), ids=lambda p: p.name)
def test_output_naming_respects_every_referenced_rfn(recipe_path: Path):
    catalog = load_manifest(_MANIFEST)
    recipe = load_recipe(recipe_path)
    family = recipe.output.family.lower()
    for ref in (recipe.base, *recipe.donors):
        for entry in catalog.entries:
            if entry.family != ref.family:
                continue
            for reserved in entry.rfn_names:
                assert reserved.lower() not in family, (
                    f"{recipe_path.name}: output family "
                    f"{recipe.output.family!r} carries the reserved name "
                    f"{reserved!r} of {entry.family}"
                )


def test_the_official_recipes_cover_the_required_demos():
    recipes = {path.stem: load_recipe(path) for path in _official_recipes()}
    # Flagship: a language preset over the coding-font x CJK-donor pair.
    flagship = recipes["chhsich-zh-cn"]
    assert any(r.set_name == "zh_cn" for r in flagship.rules)
    # Weight matrix: several weights packaged as a collection.
    weights = recipes["chhsich-weights"]
    assert weights.output.format == "ttc"
    assert len(weights.weights) >= 2
    # Preset + custom-range mixing: preset, range, and named set.
    noto = recipes["chhsich-noto"]
    granularities = {r.granularity for r in noto.rules}
    assert {"set", "range", "codepoint"} <= granularities
    assert noto.named_sets, "a recipe-defined named range set"


# --- synthetic builds: the committed YAML, tiny fonts ----------------------


@pytest.fixture(scope="module")
def synthetic_catalog(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """A fetched-catalog stand-in mirroring the recipes' references.

    Same (family, variant, file-name layout) as the committed manifest:
    the JetBrainsMono and MapleMono zips extract the exact file names
    the recipes' patterns expect; NotoSansSC and LXGWWenKai are bare
    files; Agave is a zip again. Fonts are synthetic fixtures with the
    weights the recipes' matrices request.
    """
    site = tmp_path_factory.mktemp("official-synthetic")
    fonts = site / "fonts"
    fonts.mkdir()
    (site / "licenses").mkdir()
    (site / "licenses" / "OFL-1.1.txt").write_text(
        "Fake OFL text for the synthetic catalog.\n", encoding="utf-8"
    )

    def face(path: Path, family: str, weight: int) -> None:
        synth_font(
            path, family=family, codepoints=BASE_CODEPOINTS, weight=weight
        )

    # Base zips: JetBrainsMono (3 weights), Agave (regular).
    jb = fonts / "JetBrainsMono"
    jb.mkdir()
    for name, weight in (
        ("JetBrainsMonoNerdFont-Light.ttf", 300),
        ("JetBrainsMonoNerdFont-Regular.ttf", 400),
        ("JetBrainsMonoNerdFont-Bold.ttf", 700),
    ):
        face(jb / name, "JetBrainsMono Nerd Font", weight)
    with zipfile.ZipFile(fonts / "JetBrainsMono.zip", "w") as zf:
        for path in sorted(jb.iterdir()):
            zf.writestr(path.name, path.read_bytes())
    agave = fonts / "Agave"
    agave.mkdir()
    face(agave / "AgaveNerdFont-Regular.ttf", "Agave Nerd Font", 400)
    with zipfile.ZipFile(fonts / "Agave.zip", "w") as zf:
        for path in sorted(agave.iterdir()):
            zf.writestr(path.name, path.read_bytes())

    # Donors: MapleMono zip (3 weights), NotoSansSC variable, LXGW bare.
    maple = fonts / "MapleMono-NF-CN"
    maple.mkdir()
    for name, weight in (
        ("MapleMono-NF-CN-Light.ttf", 300),
        ("MapleMono-NF-CN-Regular.ttf", 400),
        ("MapleMono-NF-CN-Bold.ttf", 700),
    ):
        synth_font(
            maple / name,
            family="Maple Mono NF CN",
            codepoints=DONOR_CODEPOINTS,
            weight=weight,
        )
    with zipfile.ZipFile(fonts / "MapleMono-NF-CN.zip", "w") as zf:
        for path in sorted(maple.iterdir()):
            zf.writestr(path.name, path.read_bytes())
    synth_variable_font(
        fonts / "NotoSansSC[wght].ttf",
        family="Noto Sans SC",
        codepoints=DONOR_CODEPOINTS,
    )
    synth_font(
        fonts / "LXGWWenKai-Light.ttf",
        family="LXGW WenKai",
        codepoints=DONOR_CODEPOINTS,
        weight=300,
    )

    import hashlib

    def sha(path: Path) -> str:
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def entry(family: str, variant: str, file: str, rfn_names: list[str]) -> dict:
        return {
            "family": family,
            "variant": variant,
            "file": file,
            "version": "v0",
            "upstream_url": (fonts / file).as_uri(),
            "sha256": sha(fonts / file),
            "license_spdx": "OFL-1.1-no-RFN",
            "rfn": bool(rfn_names),
            "rfn_names": rfn_names,
            "copyright": "Copyright 2026 synthetic",
            "license_file": "licenses/OFL-1.1.txt",
            "checksum_source": "self-computed",
        }

    (site / "fonts.manifest.json").write_text(
        json.dumps(
            {
                "schema": "fontalloy/font-catalog@v1",
                "families": [
                    entry("JetBrainsMono", "Nerd Font", "JetBrainsMono.zip", []),
                    entry("MapleMono", "NF-CN", "MapleMono-NF-CN.zip", []),
                    entry("NotoSansSC", "Variable", "NotoSansSC[wght].ttf", []),
                    entry("Agave", "Nerd Font", "Agave.zip", []),
                    entry(
                        "LXGWWenKai",
                        "Light",
                        "LXGWWenKai-Light.ttf",
                        ["LXGW", "霞鹜"],
                    ),
                ],
            },
            ensure_ascii=False,
            indent=1,
        )
        + "\n",
        encoding="utf-8",
    )
    return site


@pytest.mark.parametrize("recipe_path", _all_recipes(), ids=lambda p: p.name)
def test_every_recipe_builds_green_on_synthetic_equivalents(
    recipe_path: Path, synthetic_catalog: Path, tmp_path: Path
):
    result = build(
        recipe_path,
        tmp_path / f"{recipe_path.stem}.ttf",
        manifest=synthetic_catalog / "fonts.manifest.json",
        fonts_dir=synthetic_catalog / "fonts",
    )
    from fontTools.ttLib import TTFont

    face_index = None if result.format != "ttc" else 0
    font = TTFont(result.font_path, fontNumber=face_index)
    cmap = font.getBestCmap()
    assert set(BASE_CODEPOINTS) | set(DONOR_CODEPOINTS) <= set(cmap)
    # The output identity is the recipe's own family, never a
    # source's (non-RIBBI subfamilies append the style: "… Light").
    names = font["name"].getDebugName(1)
    recipe = load_recipe(recipe_path)
    assert names == recipe.output.family or names.startswith(
        recipe.output.family + " "
    )
    # Provenance: every source is the manifest-pinned artifact.
    for source in result.report.sources:
        assert source.path.parent == synthetic_catalog / "fonts"


def test_the_weights_recipe_packages_one_face_per_slot(
    synthetic_catalog: Path, tmp_path: Path
):
    result = build(
        _RECIPES_DIR / "chhsich-weights.yaml",
        tmp_path / "weights.ttc",
        manifest=synthetic_catalog / "fonts.manifest.json",
        fonts_dir=synthetic_catalog / "fonts",
    )
    assert result.format == "ttc"
    weights = [slot.weight for slot in result.report.weights]
    assert weights == [300, 400, 700]
    borrows = [b for slot in result.report.weights for b in slot.borrows]
    assert [b.weight for b in borrows] == [300, 400, 700]  # exact donor matches


def test_the_preset_mix_recipe_declares_its_rules_in_the_report(
    synthetic_catalog: Path, tmp_path: Path
):
    result = build(
        _RECIPES_DIR / "chhsich-noto.yaml",
        tmp_path / "noto.ttf",
        manifest=synthetic_catalog / "fonts.manifest.json",
        fonts_dir=synthetic_catalog / "fonts",
    )
    labels = [(rule.granularity, rule.target) for rule in result.report.rules]
    assert ("set", "zh_cn") in labels
    assert ("range", "0x3040-0x30FF") in labels
    assert ("set", "enclosed-cjk") in labels
    assert ("codepoint", "0xB7") in labels


def test_the_community_sample_builds_identically_through_the_same_path(
    synthetic_catalog: Path, tmp_path: Path
):
    """The share unit: rebuild byte-identical, same machinery, not official."""
    recipe_path = _RECIPES_DIR / "community" / "agave-lxgw-zh-tw.yaml"
    output = tmp_path / "community.ttf"
    first = build(
        recipe_path,
        output,
        manifest=synthetic_catalog / "fonts.manifest.json",
        fonts_dir=synthetic_catalog / "fonts",
    )
    font_bytes = output.read_bytes()
    second = build(
        recipe_path,
        output,
        manifest=synthetic_catalog / "fonts.manifest.json",
        fonts_dir=synthetic_catalog / "fonts",
    )
    assert output.read_bytes() == font_bytes
    assert first.report.output_sha256 == second.report.output_sha256
    assert first.report_path.read_bytes() == second.report_path.read_bytes()
    assert (
        first.report_html_path.read_bytes() == second.report_html_path.read_bytes()
    )
    from fontTools.ttLib import TTFont

    font = TTFont(output)
    assert font["name"].getDebugName(1) == "Community-Agave-Kai"


# --- the real pair (network on first run; skips offline) --------------------


@pytest.fixture(scope="module")
def fetched_real_catalog(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Fetch the flagship's families through the filtered fetch, or skip."""
    import os

    from fontalloy_core.assets import fetch_catalog
    from fontalloy_core.errors import AssetsError

    if os.environ.get("FONTALLOY_SKIP_ANCHOR"):
        pytest.skip("FONTALLOY_SKIP_ANCHOR is set")
    cache = _REPO_ROOT / ".scratch" / "recipe-fonts"
    cache.mkdir(parents=True, exist_ok=True)
    try:
        summary = fetch_catalog(
            _MANIFEST, cache, families=("JetBrainsMono", "MapleMono")
        )
    except AssetsError as exc:
        pytest.skip(f"offline or origin unavailable: {exc}")
    assert summary.downloaded or summary.skipped
    return cache


def test_the_flagship_builds_against_the_real_fetched_pair(
    fetched_real_catalog: Path, tmp_path: Path
):
    result = build(
        _RECIPES_DIR / "chhsich-zh-cn.yaml",
        tmp_path / "chhsich-zh-cn.ttf",
        manifest=_MANIFEST,
        fonts_dir=fetched_real_catalog,
    )
    report = result.report
    assert report.format == "ttf"
    # The zh_cn preset rule is declared and substantially covered.
    zh = [
        r
        for r in report.coverage_rules
        if r.granularity == "set" and r.target == "zh_cn"
    ]
    assert zh and zh[0].covered > 5000
    # Provenance is the manifest's pins: the two zips.
    assert [s.path.name for s in report.sources] == [
        "JetBrainsMono.zip",
        "MapleMono-NF-CN.zip",
    ]
    catalog = load_manifest(_MANIFEST)
    pins = {
        e.file: e.sha256
        for e in catalog.entries
        if e.file in {"JetBrainsMono.zip", "MapleMono-NF-CN.zip"}
    }
    for source in report.sources:
        assert source.sha256 == pins[source.path.name]
    # The output family is the brand default the recipe requests.
    from fontTools.ttLib import TTFont

    font = TTFont(result.font_path)
    assert font["name"].getDebugName(1) == "ChHsich"
    # A Regular face carries no typographic pair (1/2 already say it) —
    # and, critically, no stale 16 leaking the source family either.
    assert font["name"].getDebugName(16) in (None, "ChHsich")
    assert "JetBrainsMono Nerd Font" not in {
        r.toUnicode() for r in font["name"].names if r.nameID in (1, 4, 6, 16)
    }
    # The terminal grid: CJK advance exactly 2x the Latin advance.
    face = report.metrics[0]
    assert face.grid_ratio == 2
