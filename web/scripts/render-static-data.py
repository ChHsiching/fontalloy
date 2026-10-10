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


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False)
    path.write_text(text + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {path.relative_to(REPO_ROOT)} ({len(text)} bytes)")


def main() -> None:
    data_dir = REPO_ROOT / "gui" / "src" / "data"
    write_json(data_dir / "catalog.json", render_catalog())
    write_json(data_dir / "presets.json", render_presets())


if __name__ == "__main__":
    main()
