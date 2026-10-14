"""The harmonized default on the real pinned pair (round 20, owner
item 7): the DEFAULT (auto-school) build keeps the merged Han ink
inside the Noto-school optical zone.

The pair is the same class of real fonts the anchor measures —
JetBrainsMono (Nerd Font Regular, the Latin base) x LXGW WenKai Mono
(Regular, the CJK donor) — fetched through the assets machinery with
sha256 verification (mirrors tests/test_anchor.py; skips rather than
fails offline, FONTALLOY_SKIP_ANCHOR=1 opts out).

The standard (ADR-0003; the round-20 correction): the Noto/Source Han
native pairing keeps the Han ink at ~1.23x the Latin cap height, and
the acceptance zone is ~1.05-1.3x. Measured on the inputs: Noto Sans
SC's own Han ink p90 906 over its Latin cap 733 = 1.236; LXGW WenKai
Mono's own pairing is 921/709 = 1.299 — both inside the zone. The bare
grid school put this pair's merged font at 921*1.2/730 = 1.515 — the
"CJK visibly taller than the Latin" defect; the auto default caps the
grid term at the optical ratio and lands 1.23.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from measure_harmonization import (
    RATIO_CEILING,
    RATIO_FLOOR,
    build_default,
    measure,
    pair_paths,
)

pytestmark = pytest.mark.anchor


@pytest.fixture(scope="module")
def harmonized_pair(tmp_path_factory: pytest.TempPathFactory) -> dict:
    """The measured default-settings build over the pinned real pair."""
    if os.environ.get("FONTALLOY_SKIP_ANCHOR"):
        pytest.skip("FONTALLOY_SKIP_ANCHOR is set")
    base_path, donor_path = pair_paths()
    out_dir = tmp_path_factory.mktemp("harmonization-out")
    output_path = build_default(base_path, donor_path, out_dir)
    return {
        "base": measure(base_path, "base"),
        "donor": measure(donor_path, "donor"),
        "output": measure(output_path, "output"),
    }


class TestHarmonizedDefault:
    """The default build's Han/Latin ratio sits in the Noto-school
    zone, and the Han bottom stays inside the ideographic em box."""

    def test_the_output_ratio_is_inside_the_standard_zone(self, harmonized_pair):
        ratio = harmonized_pair["output"]["han_ink_over_cap"]
        assert RATIO_FLOOR <= ratio <= RATIO_CEILING, (
            f"the default build's HanInk/cap = {ratio:.3f} left the "
            f"[{RATIO_FLOOR}, {RATIO_CEILING}] Noto-school zone"
        )

    def test_the_output_ratio_lands_on_the_optical_anchor(self, harmonized_pair):
        # For this pair the optical term binds (the grid term 1.2 would
        # overshoot), so the ratio is the optical anchor 1.23 — the
        # Noto native pairing's own number (906/733), not a coincidence.
        ratio = harmonized_pair["output"]["han_ink_over_cap"]
        assert ratio == pytest.approx(1.23, abs=0.01)

    def test_the_han_bottom_stays_inside_the_ideographic_em_box(
        self, harmonized_pair
    ):
        # The OpenType ideographic em-box convention: the em box spans
        # [-0.12em, +0.88em] around the shared baseline (Kozuka Mincho's
        # registered -120/+880 at 1000 upem; ADR-0003's invariant).
        output = harmonized_pair["output"]
        upem = output["upem"]
        assert output["han_ymin_p10"] >= -0.12 * upem

    def test_the_latin_side_passes_through_untouched(self, harmonized_pair):
        base, output = harmonized_pair["base"], harmonized_pair["output"]
        for key in ("cap_ymax", "xheight_ymax", "descender_ymin"):
            assert output[key] == pytest.approx(base[key]), (
                f"the merged font's Latin {key} moved"
            )

    def test_the_bare_grid_school_was_the_defect(self, harmonized_pair, tmp_path):
        """The red-capable control: the same pair under the explicit
        bare grid school reproduces the reported defect (1.515x), so
        the in-range assertions above mean the auto cap actually
        judged the scale, not that any scale passes."""
        from fontalloy_core import build

        base_path, donor_path = pair_paths()
        recipe = tmp_path / "grid-recipe.yaml"
        recipe.write_text(
            f"base: {base_path.resolve().as_posix()}\n"
            f"donors:\n  - {donor_path.resolve().as_posix()}\n"
            "normalization:\n  mode: grid\n",
            encoding="utf-8",
        )
        result = build(recipe, tmp_path / "merged-grid.ttf")
        grid = measure(Path(result.font_path), "grid")
        assert grid["han_ink_over_cap"] > RATIO_CEILING, (
            "the bare grid school no longer reproduces the measured "
            "defect; the harmonization tests lost their red control"
        )
