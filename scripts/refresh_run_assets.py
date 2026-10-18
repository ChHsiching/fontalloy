"""Refresh the e2e run-assets layout from the CURRENT catalog manifest.

The user-journey suites (gui/tests/journey.spec.ts, web/tests/
journey.spec.ts) walk the app over a real ``fontalloy serve`` pointed at
a fetched catalog layout — ``FONTALLOY_RUN_ASSETS``, by default the
sibling ``fontalloy-run/assets`` checkout (``fonts/`` + its own
``fonts.manifest.json`` + ``licenses/``). When that layout's manifest
predates a manifest-schema change, the journeys silently test the WRONG
catalog: spec #25's final batch caught exactly this (an 8ec6223-era
layout without the typed ``axes``, so ``variant_cuts`` collapsed
MapleMono NF/NF-CN into one cut and J11.3's chip never rendered).

This tool materializes a NEW layout from the repo's CURRENT manifest,
REUSING the old layout's already-verified bytes — an artifact whose
pinned sha256 is unchanged is COPIED, never re-downloaded; only genuine
gaps (new or re-pinned artifacts) go over the network, through the
plain ``fontalloy assets fetch`` machinery (sha256-verified, extracts
archive faces beside each artifact). Usage:

    uv run python scripts/refresh_run_assets.py \
        --source ../fontalloy-run/assets \
        --output  .scratch/run-assets

    # audit only: name the gaps, download nothing, exit 2 when any
    uv run python scripts/refresh_run_assets.py \
        --source ../fontalloy-run/assets \
        --output  .scratch/run-assets --offline

The output is a NEW directory (gitignored scratch — never write into
the source checkout): ``fonts/`` (the fetch layout), the current
``fonts.manifest.json``, and the ``licenses/`` tree the current
manifest references. Point the journeys at it with::

    FONTALLOY_RUN_ASSETS=<repoRoot>/.scratch/run-assets npx playwright ...

The SOURCE is read-only throughout (the tool only ever copies FROM it).
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

from fontalloy_core.assets import fetch_catalog, sha256_of
from fontalloy_core.catalog import load_manifest
from fontalloy_core.errors import FontAlloyError

REPO_ROOT = Path(__file__).resolve().parent.parent


def _is_inside(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def refresh_run_assets(
    *,
    source: Path,
    output: Path,
    manifest_path: Path,
    offline: bool = False,
    echo=print,
) -> dict[str, int]:
    """Materialize a fresh run-assets layout; returns the summary counts.

    ``source`` is the existing layout (READ-ONLY — its ``fonts/``
    artifacts are reuse candidates); ``output`` is the new layout
    directory (must not exist or be empty, and may not live inside
    ``source``); ``manifest_path`` is the CURRENT manifest the new
    layout serves.
    """
    source = source.resolve()
    output = output.resolve()
    manifest_path = manifest_path.resolve()
    if _is_inside(output, source) or _is_inside(source, output):
        raise ValueError(
            f"the output ({output}) must not overlap the source ({source}) — "
            "a refresh writes a NEW directory, never into the source layout"
        )
    if output.exists() and any(output.iterdir()):
        raise ValueError(
            f"the output directory ({output}) must be absent or empty — a "
            "refresh materializes a fresh layout"
        )

    catalog = load_manifest(manifest_path)
    source_fonts = source / "fonts"
    output_fonts = output / "fonts"
    output_fonts.mkdir(parents=True, exist_ok=True)

    # Warm reuse: every artifact the old layout carries with the CURRENT
    # pin's exact sha256 is copied verbatim — the fetch pass below then
    # sees it as already-verified and never touches its origin.
    reused = 0
    gaps: list[str] = []
    for entry in catalog.entries:
        if entry.sha256 is None:
            continue  # the fetch pass raises on unpinned entries itself
        candidate = source_fonts / entry.file
        if not candidate.is_file() or sha256_of(candidate) != entry.sha256:
            gaps.append(f"{entry.family} ({entry.file})")
            continue
        shutil.copy2(candidate, output_fonts / entry.file)
        reused += 1
        echo(f"{entry.file}: reused from the source layout (sha256 verified)")
    echo(
        f"reuse pass: {reused} artifact(s) copied, {len(gaps)} gap(s) to fetch"
    )

    if offline:
        if gaps:
            echo(
                "offline: gaps remain (pass without --offline to fetch them):\n  "
                + "\n  ".join(gaps),
            )
            raise SystemExit(2)
        raise SystemExit(0)

    summary = fetch_catalog(manifest_path, dest=output_fonts, echo=echo)

    # The layout's own truth: the CURRENT manifest plus the license tree
    # it references. ``entry.license_file`` is resolved against the
    # manifest's own directory (absolute); the layout mirrors the same
    # RELATIVE path under the output root.
    shutil.copy2(manifest_path, output / "fonts.manifest.json")
    for entry in catalog.entries:
        relative = entry.license_file.relative_to(manifest_path.parent)
        target = output / relative
        if target.exists():
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(manifest_path.parent / relative, target)
    echo(
        f"refreshed run assets at {output}: {summary.downloaded} downloaded, "
        f"{reused} reused, {len(catalog.entries)} entry/entries, licenses copied"
    )
    return {"reused": reused, "downloaded": summary.downloaded}


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--source",
        type=Path,
        required=True,
        help="The existing run-assets layout (READ-ONLY; needs fonts/)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        required=True,
        help="The NEW layout directory (absent or empty, never inside --source)",
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=REPO_ROOT / "assets" / "fonts.manifest.json",
        help="The CURRENT manifest to materialize from "
        "(default: assets/fonts.manifest.json)",
    )
    parser.add_argument(
        "--offline",
        action="store_true",
        help="Never download: name the gaps and exit 2 when any remain",
    )
    args = parser.parse_args(argv)
    try:
        refresh_run_assets(
            source=args.source,
            output=args.output,
            manifest_path=args.manifest,
            offline=args.offline,
        )
    except (ValueError, FontAlloyError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(2) from None


if __name__ == "__main__":
    main()
