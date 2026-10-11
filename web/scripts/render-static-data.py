#!/usr/bin/env python3
"""Render the static JSON the WebApp bundles at build time.

Two inputs, two outputs (both committed — regeneration is deterministic,
so the frontend build never needs Python):

- ``assets/fonts.manifest.json``  -> ``gui/src/data/catalog.json``
  The catalog references the base/donor pickers offer. The manifest is
  the single source of truth (ADR-0005); only what a picker needs is
  carried (family, variant, version, licensing), never binaries.

- ``fontalloy_core.presets.PRESETS`` -> ``gui/src/data/presets.json``
  A static rendering of the fc-lang language presets: every preset with
  its codepoint count and sub-block structure (zh_hk = zh_tw + the Hong
  Kong supplement; zh_mo the same), plus the standalone set names that
  are selectable in recipes without being languages themselves.

- ``fontalloy_core.precedence.BUILTIN_NAMED_SETS`` ->
  ``gui/src/data/preset-sets.ts``
  The interval payload behind the names: every built-in named set as
  sorted disjoint interval labels in recipe syntax. The GUI's
  client-side precedence resolver (issue #18) mirrors the core resolver
  and needs the actual codepoints — counts alone cannot resolve. Emitted
  as an annotated TypeScript const (not JSON) so typechecking never
  infers a half-million-element literal type. Only the precedence
  modules import it, so the WebApp bundle never carries it.

- ``unicodedata`` (this Python's Unicode character database) ->
  ``gui/src/unicode/visible.ts``
  The VISIBLE-codepoint intervals: every codepoint whose general
  category renders real ink (letters, marks, numbers, punctuation,
  symbols, and private use — the Nerd Font icon planes) as sorted
  disjoint intervals. The character map subtracts the complement from
  its categories so control / format / separator / unassigned
  codepoints never render as meaningless blank cells (the validated
  prototype's hand-curated blocks contain none of them).

Run from anywhere: ``python web/scripts/render-static-data.py`` (needs
the core package importable; the script inserts ``core/`` itself, or use
``uv run`` from the workspace root).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "core"))

from fontalloy_core.precedence import BUILTIN_NAMED_SETS  # noqa: E402
from fontalloy_core.presets import PRESETS  # noqa: E402

#: The presets the builder surfaces first (spec issue #1, user story 8).
FEATURED = ("zh_cn", "zh_tw", "zh_hk", "ja", "ko")


def render_catalog() -> dict:
    manifest = json.loads(
        (REPO_ROOT / "assets" / "fonts.manifest.json").read_text(encoding="utf-8")
    )
    families = [
        {
            "family": entry["family"],
            "variant": entry["variant"],
            "version": entry["version"],
            "file": entry["file"],
            # Where `fontalloy assets fetch` unpacks this artifact:
            # <dest>/<archive stem>/...ttf
            "path_hint": f"fonts/{Path(entry['file']).stem}",
            "license_spdx": entry["license_spdx"],
            "rfn": entry["rfn"],
            # The pinned upstream artifact URL (round 5): the GUI derives
            # owner/repo from it for the picker's live GitHub stars.
            "upstream_url": entry.get("upstream_url"),
        }
        for entry in manifest["families"]
    ]
    families.sort(key=lambda f: (f["family"].lower(), f["variant"].lower()))
    return {"schema": manifest["schema"], "families": families}


def render_presets() -> dict:
    preset_names = set(PRESETS)
    presets = []
    standalone = set()
    for name, preset in sorted(PRESETS.items()):
        sub_blocks = []
        for block in preset.sub_blocks:
            sub_blocks.append(
                {"name": block.name, "codepoints": len(block.codepoints)}
            )
            if block.name not in preset_names:
                standalone.add(block.name)
        presets.append(
            {
                "name": name,
                "codepoints": len(preset.codepoints),
                "sub_blocks": sub_blocks,
            }
        )
    return {
        "source": "fontconfig fc-lang corpus via fontalloy_core.presets",
        "featured": list(FEATURED),
        "presets": presets,
        "standalone_sets": sorted(standalone),
    }


def interval_labels(intervals) -> list[str]:
    """One recipe-syntax label per interval (`0x41` or `0x4E00-0x9FFF`)."""
    return [f"0x{start:X}" if start == end else f"0x{start:X}-0x{end:X}"
            for start, end in intervals]


#: General categories that never render meaningful ink in a glyph cell.
#: Private use (Co) is deliberately KEPT — the Nerd Font icon planes
#: live there and the prototype browses them.
_INVISIBLE_CATEGORIES = frozenset({"Cc", "Cf", "Cs", "Cn", "Zs", "Zl", "Zp"})


def render_visible_codepoints() -> str:
    """The visible-codepoint intervals as an annotated TypeScript const."""
    import unicodedata

    max_cp = 0x10FFFF
    visible: list[tuple[int, int]] = []
    run_start: int | None = None
    for cp in range(0, max_cp + 1):
        if unicodedata.category(chr(cp)) in _INVISIBLE_CATEGORIES:
            if run_start is not None:
                visible.append((run_start, cp - 1))
                run_start = None
        elif run_start is None:
            run_start = cp
    if run_start is not None:
        visible.append((run_start, max_cp))

    lines = [
        "/**",
        " * GENERATED FILE — do not edit by hand.",
        " * Source: this Python's Unicode character database (unicodedata),",
        " * rendered by web/scripts/render-static-data.py. Regenerate when",
        " * the curated block taxonomy or the Unicode data should change.",
        " *",
        " * The VISIBLE codepoints: every scalar value whose general category",
        " * renders real ink (letters, marks, numbers, punctuation, symbols,",
        " * and private use — the Nerd Font icon planes). Control (Cc), format",
        " * (Cf), surrogate (Cs), unassigned (Cn), and separator (Zs/Zl/Zp)",
        " * codepoints never appear as glyph cells: the validated prototype's",
        " * hand-curated blocks contain none of them, so a browsable range",
        " * that included them would show meaningless blanks (owner round 5,",
        " * item 1). Sorted disjoint inclusive intervals.",
        " */",
        "export const VISIBLE_INTERVALS: ReadonlyArray<readonly [number, number]> = [",
    ]
    for start, end in visible:
        lines.append(f"  [{start}, {end}],")
    lines.append("];")
    body = "\n".join(lines) + "\n"
    counted = sum(end - start + 1 for start, end in visible)
    print(f"visible codepoints: {counted} in {len(visible)} intervals")
    return body


def render_preset_sets() -> str:
    """The interval payload as an annotated TypeScript const."""
    lines = [
        "/**",
        " * GENERATED FILE — do not edit by hand.",
        " * Source: fontconfig fc-lang corpus via fontalloy_core.precedence",
        " * .BUILTIN_NAMED_SETS, rendered by web/scripts/render-static-data.py.",
        " * Regenerate whenever the manifest or the fc-lang corpus changes.",
        " *",
        " * Every built-in named set (341 fc-lang languages plus the zh_hk",
        " * supplement) as sorted disjoint interval labels in recipe syntax.",
        " * The client-side precedence resolver (issue #18) resolves presets",
        " * from these intervals; counts alone (presets.json) cannot.",
        " */",
        "export const PRESET_SET_LABELS: Record<string, string[]> = {",
    ]
    for name in sorted(BUILTIN_NAMED_SETS):
        labels = interval_labels(BUILTIN_NAMED_SETS[name])
        body = ", ".join(json.dumps(label) for label in labels)
        lines.append(f"  {json.dumps(name)}: [{body}],")
    lines.append("};")
    return "\n".join(lines) + "\n"


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False)
    path.write_text(text + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {path.relative_to(REPO_ROOT)} ({len(text)} bytes)")


def main() -> None:
    data_dir = REPO_ROOT / "gui" / "src" / "data"
    write_json(data_dir / "catalog.json", render_catalog())
    write_json(data_dir / "presets.json", render_presets())
    sets_path = data_dir / "preset-sets.ts"
    text = render_preset_sets()
    sets_path.write_text(text, encoding="utf-8", newline="\n")
    print(f"wrote {sets_path.relative_to(REPO_ROOT)} ({len(text)} bytes)")
    visible_path = REPO_ROOT / "gui" / "src" / "unicode" / "visible.ts"
    visible_path.parent.mkdir(parents=True, exist_ok=True)
    text = render_visible_codepoints()
    visible_path.write_text(text, encoding="utf-8", newline="\n")
    print(f"wrote {visible_path.relative_to(REPO_ROOT)} ({len(text)} bytes)")


if __name__ == "__main__":
    main()
