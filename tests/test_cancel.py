"""Round 19: cooperative build cancellation — the pipeline's cancel seam.

A build that a consumer asks to stop must STOP: the pipeline takes an
optional ``cancelled`` predicate, checks it at every stage boundary and
inside the long per-codepoint loops (grafting, resolution) every ~2000
codepoints, and raises :class:`BuildCancelled` — a distinct outcome, not
a failure. No artifact survives the cancellation (nothing is saved and
no report is written), and the pipeline stays usable for the next build.

Serve (issue #11) drives this seam through ``POST /builds/{id}/cancel``
— its contract tests live in ``test_cli_serve.py``. These tests pin the
core behavior in-process, deterministically: the flag is armed from the
progress callback itself, so the cancellation lands at a known point
without any sleeps.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

import pytest
from conftest import synth_font
from fontalloy_core import BuildCancelled, build_recipe
from fontalloy_core.recipe import parse_recipe
from test_cli_serve import synth_wide_font

#: Wide enough that the grafting loop spans many 2000-codepoint cadences
#: (4000 grafts run ~0.3s, so 30k keeps the in-loop window generous).
WIDE_DONOR_CODEPOINTS = 30_000


def _wide_recipe(
    tmp_path: Path, *, count: int = WIDE_DONOR_CODEPOINTS
) -> tuple[object, Path]:
    """A base + wide-donor recipe whose graft runs long enough to stop."""
    base = synth_font(
        tmp_path / "base.ttf", family="CancelBase", codepoints=(0x41, 0x42)
    )
    donor = synth_wide_font(
        tmp_path / "wide.ttf", family="CancelDonor", count=count
    )
    recipe = parse_recipe(
        {
            "base": str(base),
            "donors": [str(donor)],
            "rules": [{"set": "zh_cn", "fonts": ["base", "donor-0"]}],
        },
        tmp_path,
    )
    return recipe, tmp_path / "merged.ttf"


class TestCancellation:
    def test_a_cancel_armed_at_a_stage_boundary_stops_the_build(
        self, tmp_path
    ):
        """The flag set from the progress callback (at the grafting stage
        entry) cancels the build at that boundary: the build raises
        ``BuildCancelled`` — never a failure, never a silent finish — and
        neither the font nor the report reaches the disk."""
        recipe, output = _wide_recipe(tmp_path)
        cancel = threading.Event()
        stages: list[str] = []

        def progress(stage: str, facts: dict[str, Any] | None = None) -> None:
            stages.append(stage)
            if stage == "grafting":
                cancel.set()

        with pytest.raises(BuildCancelled):
            build_recipe(
                recipe, output, progress=progress, cancelled=cancel.is_set
            )

        # The cancellation landed in the grafting stage, past loading and
        # planning — a real mid-pipeline stop, not an early bail-out.
        assert stages[-1] == "grafting"
        assert not output.exists()
        assert not output.with_name(f"{output.stem}.report.json").exists()
        assert not output.with_suffix(".html").exists()

    def test_the_graft_loop_honours_the_flag_between_cadences(
        self, tmp_path
    ):
        """The flag arrives while the graft loop is mid-stage (not at a
        boundary): the loop's ~2000-codepoint cadence picks it up. The
        predicate counts its post-grafting consultations, so the stop
        deterministically comes from inside the loop."""
        recipe, output = _wide_recipe(tmp_path)
        armed = threading.Event()
        consultations = {"n": 0}

        def progress(stage: str, facts: dict[str, Any] | None = None) -> None:
            if stage == "grafting":
                armed.set()

        def cancelled() -> bool:
            if not armed.is_set():
                return False
            consultations["n"] += 1
            # A few in-loop consultations pass, then the consumer cancels.
            return consultations["n"] > 2

        with pytest.raises(BuildCancelled):
            build_recipe(
                recipe, output, progress=progress, cancelled=cancelled
            )
        # The predicate really ran mid-stage: a 30k-codepoint graft
        # consults it every 2000 codepoints, far past the boundary calls.
        assert consultations["n"] > 2
        assert not output.exists()

    def test_a_cancelled_build_leaves_the_pipeline_usable(self, tmp_path):
        """After a cancellation the very same inputs build cleanly — the
        cancelled run holds no lock, leaks no half-state, and the next
        build completes with its artifact on disk."""
        recipe, output = _wide_recipe(tmp_path)
        cancel = threading.Event()

        def progress(stage: str, facts: dict[str, Any] | None = None) -> None:
            if stage == "grafting":
                cancel.set()

        with pytest.raises(BuildCancelled):
            build_recipe(
                recipe, output, progress=progress, cancelled=cancel.is_set
            )

        rebuilt = build_recipe(recipe, tmp_path / "again.ttf")
        assert rebuilt.font_path.exists()
        assert rebuilt.report_path.exists()

    def test_no_predicate_means_no_cancellation(self, tmp_path):
        """The seam is opt-in: a build without ``cancelled`` behaves
        exactly as before (the whole suite pins this; one wide build
        states it here beside the cancellation tests)."""
        recipe, output = _wide_recipe(tmp_path, count=4_000)
        result = build_recipe(recipe, output)
        assert result.font_path.exists()
