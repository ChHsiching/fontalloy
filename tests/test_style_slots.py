"""Round 29 regression: publisher style side-cuts never duplicate a slot.

The owner report this pins: after merging AnnotationMono (a base whose
release carries Oblique/Upright-Italic style side-cuts under one
umbrella typographic family) and loading the output, REGULAR text
rendered italic — the output carried two faces for the (400, upright)
slot, one of them the Oblique file's sheared glyphs flagged upright,
and the font matcher handed normal text the slanted ink.

The fixtures mirror the real release layout: four files, three legacy
nameID1 families, one umbrella nameID16, and the full cross of italic
signals —

- Regular:        no flag, no angle  — consistent upright
- Italic:         fsSelection bit, italicAngle -15 — consistent italic
- RegularOblique: no flag, italicAngle -15 — INCONSISTENT (slanted
  design, upright flags: inside its own legacy family the oblique IS
  the normal member)
- ItalicUpright:  fsSelection bit, no angle — INCONSISTENT (upright
  design, italic flags)

The build keeps one face per (weight, style) slot — the flag-consistent
one — and states every drop in the report's skipped_faces.
"""

from __future__ import annotations

import json
from pathlib import Path

from fontTools.ttLib import TTCollection

from conftest import BASE_CODEPOINTS, DONOR_CODEPOINTS, synth_font
from fontalloy_core import build
from fontalloy_core.load import load_faces, resolve_base_faces
from fontalloy_core.recipe import load_recipe

UMBRELLA = "Synth Nerd Font"


def _scenario(tmp_path: Path) -> Path:
    """The four-file release layout plus a CJK donor; returns the recipe."""
    directory = tmp_path / "cut"
    directory.mkdir()
    synth_font(
        directory / "NF-Regular.ttf",
        family="Synth NF",
        typographic_family=UMBRELLA,
        codepoints=BASE_CODEPOINTS,
    )
    synth_font(
        directory / "NF-Italic.ttf",
        family="Synth NF",
        typographic_family=UMBRELLA,
        codepoints=BASE_CODEPOINTS,
        subfamily="Italic",
        italic=True,
        italic_angle=-15.0,
    )
    synth_font(
        directory / "NF-RegularOblique.ttf",
        family="Synth NF Obl",
        typographic_family=UMBRELLA,
        codepoints=BASE_CODEPOINTS,
        subfamily="Regular Oblique",
        italic_angle=-15.0,
    )
    synth_font(
        directory / "NF-ItalicUpright.ttf",
        family="Synth NF Upright",
        typographic_family=UMBRELLA,
        codepoints=BASE_CODEPOINTS,
        subfamily="Italic Upright",
        italic=True,
    )
    donor = synth_font(
        tmp_path / "donor.ttf",
        family="Synth CJK",
        codepoints=DONOR_CODEPOINTS,
    )
    recipe = tmp_path / "recipe.yaml"
    recipe.write_text(
        f"""
base:
  path: {directory / "NF-Regular.ttf"}
  pattern: "NF-*.ttf"
donors:
  - path: {donor}
output:
  family: Synth Merged
  format: ttc
""",
        encoding="utf-8",
    )
    return recipe


def _base_faces(recipe: Path):
    return load_faces(load_recipe(recipe).base, role="base font")


def test_side_cut_files_classify_by_all_three_signals(tmp_path: Path):
    """The angle is an italic signal; flag/angle disagreement marks the
    face style-inconsistent (the slot resolver's tiebreak)."""
    faces = {
        face.info.path.name: face.info
        for face in _base_faces(_scenario(tmp_path))
    }
    assert faces["NF-Regular.ttf"].italic is False
    assert faces["NF-Regular.ttf"].style_consistent is True
    assert faces["NF-Italic.ttf"].italic is True
    assert faces["NF-Italic.ttf"].style_consistent is True
    # The Oblique file: sheared design, upright flags.
    assert faces["NF-RegularOblique.ttf"].italic is True
    assert faces["NF-RegularOblique.ttf"].style_consistent is False
    # The Upright-Italic file: upright design, italic flags.
    assert faces["NF-ItalicUpright.ttf"].italic is True
    assert faces["NF-ItalicUpright.ttf"].style_consistent is False


def test_resolve_base_faces_keeps_one_consistent_face_per_slot(tmp_path: Path):
    """A slot collision keeps the flag-consistent face and states the
    drops. The umbrella typographic family keeps the pool single-family
    (the round-23 guard sees one family — exactly why the resolver, not
    the guard, owns the fix)."""
    kept, skipped = resolve_base_faces(_base_faces(_scenario(tmp_path)))
    # File order (the pattern's glob) is preserved among the kept faces.
    assert [face.info.path.name for face in kept] == [
        "NF-Italic.ttf",
        "NF-Regular.ttf",
    ]
    assert [skip.path.name for skip in skipped] == [
        "NF-ItalicUpright.ttf",
        "NF-RegularOblique.ttf",
    ]
    assert all("duplicate 400" in skip.reason for skip in skipped)


def test_merged_output_one_face_per_slot_and_reported_skips(tmp_path: Path):
    """The bug report's exact scenario, end to end: the merged family
    carries ONE (400, upright) face whose italic signals are clear, and
    the report's skipped_faces states both drops."""
    recipe = _scenario(tmp_path)
    output = tmp_path / "merged.ttc"
    build(recipe, output)

    faces = TTCollection(str(output)).fonts
    assert len(faces) == 2  # one upright, one italic — no duplicates
    upright = next(f for f in faces if not f["OS/2"].fsSelection & 0x01)
    assert upright["OS/2"].usWeightClass == 400
    # The upright slot's container is the Regular file (its post angle
    # is 0), never the Oblique file's sheared design.
    assert float(upright["post"].italicAngle) == 0.0

    report = json.loads(
        output.with_name(output.stem + ".report.json").read_text(encoding="utf-8")
    )
    skipped = report["output"]["skipped_faces"]
    assert {entry["subfamily"] for entry in skipped} == {
        "Regular Oblique",
        "Italic Upright",
    }
    assert all("duplicate 400" in entry["reason"] for entry in skipped)
    assert len(report["weights"]) == 2
