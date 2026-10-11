#!/usr/bin/env python3
"""Render the recipe-release notes body from the template.

Fills ``.github/recipe-release-notes.md`` with the release's recipes
and their source-font licensing lines, read from the committed
manifest — the same truth the notices carry, in the shape the release
body wants. Deterministic: sorted input, no clocks.

Used by the recipe-release workflow (build job). The template's
``${TAG}``, ``${GITHUB_REPOSITORY}``, ``${GITHUB_SHA}`` come from the
arguments; ``${RECIPE_LINES}`` and ``${LICENSE_LINES}`` are generated
here from the official recipes (the packaged set: ``recipes/*.yaml``,
not the community samples).
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import yaml

_RECIPE_DESCRIPTIONS = {
    "chhsich-zh-cn": (
        "the flagship: JetBrains Mono × Maple Mono NF-CN under the zh_cn "
        "language preset"
    ),
    "chhsich-weights": (
        "the weight matrix: three weights of the same merge packaged as "
        "one shared-table TTC"
    ),
    "chhsich-noto": (
        "preset plus custom ranges over the Noto Sans SC variable donor"
    ),
}


def _referenced_families(recipe_path: Path) -> list[str]:
    """The manifest families one recipe references, in reference order."""
    data = yaml.safe_load(recipe_path.read_text(encoding="utf-8"))
    refs = [data["base"], *data.get("donors", [])]
    families: list[str] = []
    for ref in refs:
        family = ref["family"] if isinstance(ref, dict) else None
        if family and family not in families:
            families.append(family)
    return families


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--template", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--sha", required=True)
    args = parser.parse_args()

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    by_family: dict[str, list[dict]] = {}
    for entry in manifest["families"]:
        by_family.setdefault(entry["family"], []).append(entry)

    recipe_lines: list[str] = []
    license_lines: list[str] = []
    seen: set[str] = set()
    for recipe_path in sorted(Path("recipes").glob("*.yaml")):
        families = _referenced_families(recipe_path)
        names = " × ".join(families)
        description = _RECIPE_DESCRIPTIONS.get(recipe_path.stem, "")
        recipe_lines.append(
            f"- **`{recipe_path.stem}`** — {names}"
            + (f": {description}" if description else "")
        )
        for family in families:
            if family in seen:
                continue
            seen.add(family)
            for entry in by_family.get(family, []):
                license_lines.append(
                    f"- {entry['family']}"
                    + (f" ({entry['variant']})" if entry["variant"] else "")
                    + f" — {entry['license_spdx']}, pinned {entry['version']}"
                    + (
                        "; Reserved Font Names declared — outputs never "
                        "carry them"
                        if entry["rfn"]
                        else ""
                    )
                )

    body = args.template.read_text(encoding="utf-8")
    for placeholder, value in (
        ("${TAG}", args.tag),
        ("${GITHUB_REPOSITORY}", args.repo),
        ("${GITHUB_SHA}", args.sha),
        ("${RECIPE_LINES}", "\n".join(recipe_lines)),
        ("${LICENSE_LINES}", "\n".join(license_lines)),
    ):
        body = body.replace(placeholder, value)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(body, encoding="utf-8", newline="\n")
    print(f"wrote {args.output}")


if __name__ == "__main__":
    main()
