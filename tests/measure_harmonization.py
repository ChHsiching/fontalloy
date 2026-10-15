"""The CJK/Latin harmonization measurement (round 20, owner item 7).

Verdict harness for the "synthesized CJK looks visibly taller than the
Latin" report: build the pinned JetBrainsMono (Nerd Font Regular) x
LXGW WenKai Mono pair with DEFAULT settings (a v0 recipe — no
``normalization`` block, ttf), then measure in the OUTPUT, with
fontTools BoundsPen:

- Han ink: the 10th percentile ymin, 90th percentile ymax, and the
  90th-percentile ink height (:func:`fontalloy_core.normalize.\
_han_ink_height`'s own H_ink methodology) over the font's coverage of
  the common Han block U+4E00-9FFF;
- Latin: the median ink ymax of A-Z (cap height), the median ink ymax
  of the x-height letters, and the median ink ymin of the descenders
  gjpqy;
- the verdict ratio HanInk/cap (H_ink over the Latin cap height) and
  the Han bottom's position against the Latin baseline.

The same numbers are measured on the two INPUT faces for reference.
Standard (see docs/DESIGN.md, ADR-0003): the Noto-school optical zone
keeps Han ink between ~1.05x and ~1.3x the Latin cap height, with the
Han bottom at (not below) the shared Latin baseline.

Usage (from the repo root, in the uv environment)::

    uv run python tests/measure_harmonization.py

Font sourcing mirrors tests/test_anchor.py: the pinned catalog pair
fetched through :func:`fontalloy_core.assets.fetch_catalog` with
sha256 verification, cached under the gitignored ``.scratch``
directory. Seed the cache once by copying ``JetBrainsMono.zip`` and
``LXGWWenKaiMono-Regular.ttf`` from a prior fetch to skip the network.
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path
from statistics import median

from fontTools.ttLib import TTFont

from fontalloy_core.assets import fetch_catalog
from fontalloy_core.errors import AssetsError
from fontalloy_core.normalize import (
    HAN_COMMON_FIRST,
    HAN_COMMON_LAST,
    INK_PERCENTILE,
    _han_ink_height,
    _percentile,
)

_REPO_ROOT = Path(__file__).resolve().parent.parent
_MANIFEST = _REPO_ROOT / "assets" / "fonts.manifest.json"
_CACHE = _REPO_ROOT / ".scratch" / "harmonization-fonts"
_HARMONIZATION_FAMILIES = ("JetBrainsMono", "LXGWWenKaiMono")
_BASE_FACE = "JetBrainsMono/JetBrainsMonoNerdFont-Regular.ttf"
_DONOR_FILE = "LXGWWenKaiMono-Regular.ttf"

#: The x-height letters (flat-topped lowercase, no ascenders) and the
#: Latin descenders whose ymin anchors the "baseline zone".
_X_HEIGHT_LETTERS = "eonuvwxz"
_DESCENDER_LETTERS = "gjpqy"

#: The standard's verdict bounds (the Noto-school optical zone).
RATIO_FLOOR = 1.05
RATIO_CEILING = 1.30


def pair_paths() -> tuple[Path, Path]:
    """Fetch (and sha256-verify) the pinned pair; raise when offline."""
    manifest = json.loads(_MANIFEST.read_text(encoding="utf-8"))
    families = [
        f for f in manifest["families"] if f["family"] in _HARMONIZATION_FAMILIES
    ]
    assert {f["family"] for f in families} == set(_HARMONIZATION_FAMILIES)

    root = _CACHE.parent / "harmonization-manifest"
    if not (root / "fonts.manifest.json").is_file():
        root.mkdir(parents=True, exist_ok=True)
        (root / "fonts.manifest.json").write_text(
            json.dumps({"schema": manifest["schema"], "families": families}),
            encoding="utf-8",
        )
        (root / "licenses").mkdir(exist_ok=True)
        for entry in families:
            shutil.copy(
                _REPO_ROOT / "assets" / entry["license_file"],
                root / entry["license_file"],
            )
    fetch_catalog(root / "fonts.manifest.json", _CACHE)
    return _CACHE / _BASE_FACE, _CACHE / _DONOR_FILE


def _ink_extent(font: TTFont) -> dict[str, float]:
    """The Han ink statistics over the font's common-Han coverage."""
    cmap = font.getBestCmap()
    glyf = font.get("glyf")
    ymins: list[int] = []
    ymaxs: list[int] = []
    heights: list[int] = []
    for codepoint in sorted(cmap):
        if not HAN_COMMON_FIRST <= codepoint <= HAN_COMMON_LAST:
            continue
        name = cmap[codepoint]
        if glyf is not None:
            glyph = glyf[name]
            if glyph.numberOfContours == 0:
                continue
            y_min, y_max = glyph.yMin, glyph.yMax
        else:  # CFF: measure through the glyph set
            from fontTools.pens.boundsPen import BoundsPen

            pen = BoundsPen(font.getGlyphSet())
            font.getGlyphSet()[name].draw(pen)
            if pen.bounds is None:
                continue
            _x_min, y_min, _x_max, y_max = pen.bounds
        ymins.append(y_min)
        ymaxs.append(y_max)
        heights.append(y_max - y_min)
    if not heights:
        return {}
    return {
        "han_sample": len(heights),
        "han_ymin_p10": _percentile(ymins, 100 - INK_PERCENTILE),
        "han_ymax_p90": _percentile(ymaxs, INK_PERCENTILE),
        "han_ink_p90": _percentile(heights, INK_PERCENTILE),
    }


def _latin_extents(font: TTFont) -> dict[str, float]:
    """The Latin anchors: cap ymax (A-Z), x-height ymax, descender ymin."""
    cmap = font.getBestCmap()
    glyph_set = font.getGlyphSet()
    from fontTools.pens.boundsPen import BoundsPen

    def ymax(ch: str) -> int | None:
        name = cmap.get(ord(ch))
        if name is None:
            return None
        pen = BoundsPen(glyph_set)
        glyph_set[name].draw(pen)
        if pen.bounds is None:
            return None
        return pen.bounds[3]

    def ymin(ch: str) -> int | None:
        name = cmap.get(ord(ch))
        if name is None:
            return None
        pen = BoundsPen(glyph_set)
        glyph_set[name].draw(pen)
        if pen.bounds is None:
            return None
        return pen.bounds[1]

    caps = [v for v in (ymax(ch) for ch in map(chr, range(0x41, 0x5B))) if v]
    xs = [v for v in (ymax(ch) for ch in _X_HEIGHT_LETTERS) if v]
    descenders = [v for v in (ymin(ch) for ch in _DESCENDER_LETTERS) if v]
    out: dict[str, float] = {}
    if caps:
        out["cap_ymax"] = float(median(caps))
    if xs:
        out["xheight_ymax"] = float(median(xs))
    if descenders:
        out["descender_ymin"] = float(median(descenders))
    return out


def measure(font_path: Path, label: str) -> dict[str, float]:
    """Every measured number for one font, plus the derived ratio."""
    font = TTFont(font_path)
    upem = font["head"].unitsPerEm
    os2 = font.get("OS/2")
    numbers: dict[str, float] = {
        "upem": float(upem),
        "typo_ascender": float(os2.sTypoAscender),
        "typo_descender": float(os2.sTypoDescender),
        "cap_height_declared": float(getattr(os2, "sCapHeight", 0) or 0),
    }
    numbers.update(_ink_extent(font))
    numbers.update(_latin_extents(font))
    if "han_ink_p90" in numbers and "cap_ymax" in numbers:
        numbers["han_ink_over_cap"] = numbers["han_ink_p90"] / numbers["cap_ymax"]
        numbers["han_ymax_over_cap"] = numbers["han_ymax_p90"] / numbers["cap_ymax"]
    font.close()
    return {"label": label, "path": str(font_path), **numbers}


def build_default(base_path: Path, donor_path: Path, out_dir: Path) -> Path:
    """The DEFAULT-settings synthesis: a v0 recipe (auto school, ttf)."""
    from fontalloy_core import build

    out_dir.mkdir(parents=True, exist_ok=True)
    recipe = out_dir / "default-recipe.yaml"
    # Round 26: "default" here means the AUTO school — plain is the new
    # recipe default, and this measurement is the auto school's
    # evidence, so the school is pinned.
    recipe.write_text(
        f"base: {base_path.resolve().as_posix()}\n"
        f"donors:\n  - {donor_path.resolve().as_posix()}\n"
        "normalization:\n  mode: auto\n",
        encoding="utf-8",
    )
    result = build(recipe, out_dir / "merged-default.ttf")
    return Path(result.font_path)


def build_bare_grid(base_path: Path, donor_path: Path, out_dir: Path) -> Path:
    """The explicit bare-grid synthesis — the defect control (the
    round-20 report's before/after: grid 1.515 vs auto 1.23)."""
    from fontalloy_core import build

    recipe = out_dir / "grid-recipe.yaml"
    recipe.write_text(
        f"base: {base_path.resolve().as_posix()}\n"
        f"donors:\n  - {donor_path.resolve().as_posix()}\n"
        "normalization:\n  mode: grid\n",
        encoding="utf-8",
    )
    result = build(recipe, out_dir / "merged-grid.ttf")
    return Path(result.font_path)


def _fmt_row(row: dict[str, float], keys: list[tuple[str, str]]) -> list[str]:
    return [
        f"{row.get(key):.0f}" if isinstance(row.get(key), float) else str(row.get(key, "-"))
        for key, _title in keys
    ]


def main() -> int:
    base_path, donor_path = pair_paths()
    out_dir = _REPO_ROOT / ".scratch" / "harmonization-out"
    output_path = build_default(base_path, donor_path, out_dir)
    grid_path = build_bare_grid(base_path, donor_path, out_dir)

    rows = [
        measure(base_path, "INPUT base: JetBrainsMono NF Regular"),
        measure(donor_path, "INPUT donor: LXGW WenKai Mono Regular"),
        measure(grid_path, "OUTPUT merged (mode: grid — the defect)"),
        measure(output_path, "OUTPUT merged (DEFAULT = auto)"),
    ]

    columns: list[tuple[str, str]] = [
        ("upem", "upem"),
        ("typo_ascender", "typoAsc"),
        ("typo_descender", "typoDesc"),
        ("cap_height_declared", "sCapHeight"),
        ("cap_ymax", "cap ymax (A-Z med)"),
        ("xheight_ymax", "x-height ymax"),
        ("descender_ymin", "desc ymin"),
        ("han_sample", "Han sample n"),
        ("han_ymin_p10", "Han ymin p10"),
        ("han_ymax_p90", "Han ymax p90"),
        ("han_ink_p90", "Han ink p90"),
        ("han_ink_over_cap", "HanInk/cap"),
        ("han_ymax_over_cap", "HanTop/cap"),
    ]
    label_width = max(len(r["label"]) for r in rows)
    header = f"{'font':<{label_width}}  " + "  ".join(f"{t:>16}" for _k, t in columns)
    print(header)
    print("-" * len(header))
    for row in rows:
        cells: list[str] = []
        for key, _title in columns:
            value = row.get(key)
            if value is None:
                cells.append("-".rjust(16))
            elif key in ("han_ink_over_cap", "han_ymax_over_cap"):
                cells.append(f"{value:.3f}".rjust(16))
            elif isinstance(value, float) and value == int(value):
                cells.append(f"{int(value)}".rjust(16))
            else:
                cells.append(f"{value:.1f}".rjust(16))
        print(f"{row['label']:<{label_width}}  " + "  ".join(cells))

    out = rows[3]  # the DEFAULT (auto) output — the verdict row
    ratio = out.get("han_ink_over_cap")
    han_bottom = out.get("han_ymin_p10", 0.0)
    print()
    print(f"output Han ink p90 = {out.get('han_ink_p90'):.0f} units, "
          f"cap = {out.get('cap_ymax'):.0f} units -> HanInk/cap = {ratio:.3f}")
    print(f"output Han ymin p10 = {han_bottom:.0f} units "
          f"(baseline = 0; Latin descender ymin = "
          f"{out.get('descender_ymin', float('nan')):.0f})")
    verdict_in_range = RATIO_FLOOR <= ratio <= RATIO_CEILING
    print(f"standard zone [{RATIO_FLOOR}, {RATIO_CEILING}] -> "
          + ("IN RANGE (EXPECTED)" if verdict_in_range else "OUT OF RANGE (BUG)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
