"""System font discovery (round 24, owner item 3): the scan and its
classification rule — Latin coverage lists in the EN picker, CJK
coverage in the CJK picker, and a face with both belongs in BOTH.
"""

from __future__ import annotations

from pathlib import Path

from fontalloy_core.systemfonts import scan_system_fonts, system_font_dirs

from conftest import synth_font, synth_ttc


def _latin(path: Path) -> Path:
    return synth_font(path, family="AlloyEN", codepoints=(0x41, 0x61))


def _cjk(path: Path) -> Path:
    return synth_font(path, family="AlloyCJK", codepoints=(0x4E2D,))


def _both(path: Path) -> Path:
    return synth_font(path, family="AlloyBoth", codepoints=(0x41, 0x4E2D))


def test_classification_rides_coverage_both_ways(tmp_path: Path):
    _latin(tmp_path / "AlloyEN-Regular.ttf")
    _cjk(tmp_path / "AlloyCJK-Regular.ttf")
    _both(tmp_path / "AlloyBoth-Regular.ttf")

    faces = {(face.file, face.face): face for face in scan_system_fonts((tmp_path,))}

    assert faces["AlloyEN-Regular.ttf", 0].latin is True
    assert faces["AlloyEN-Regular.ttf", 0].cjk is False

    assert faces["AlloyCJK-Regular.ttf", 0].latin is False
    assert faces["AlloyCJK-Regular.ttf", 0].cjk is True

    # The owner's ruling: a face covering both lists in BOTH pickers —
    # 微软雅黑's Chinese is a legitimate standalone CJK pick.
    assert faces["AlloyBoth-Regular.ttf", 0].latin is True
    assert faces["AlloyBoth-Regular.ttf", 0].cjk is True


def test_collections_contribute_every_face(tmp_path: Path):
    synth_ttc(
        tmp_path / "AlloySys.ttc",
        faces=[
            dict(family="AlloySysA", weight=400, codepoints=(0x41,)),
            dict(family="AlloySysB", weight=700, codepoints=(0x4E2D,)),
        ],
    )

    faces = {(face.file, face.face): face for face in scan_system_fonts((tmp_path,))}

    assert faces["AlloySys.ttc", 0].family == "AlloySysA"
    assert faces["AlloySys.ttc", 0].latin is True
    assert faces["AlloySys.ttc", 1].family == "AlloySysB"
    assert faces["AlloySys.ttc", 1].cjk is True


def test_stray_files_are_skipped_not_fatal(tmp_path: Path):
    _latin(tmp_path / "AlloyEN-Regular.ttf")
    (tmp_path / "not-a-font.ttf").write_bytes(b"nope")
    (tmp_path / "readme.txt").write_text("hello", encoding="utf-8")

    faces = scan_system_fonts((tmp_path,))

    assert [face.file for face in faces] == ["AlloyEN-Regular.ttf"]


def test_missing_directories_scan_empty(tmp_path: Path):
    assert scan_system_fonts((tmp_path / "nowhere",)) == []


def test_platform_directories_are_non_empty():
    # Smoke: the running platform always names at least one standard
    # font directory; whether it exists is the scan's business.
    assert len(system_font_dirs()) >= 1
