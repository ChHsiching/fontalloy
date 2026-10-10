"""The ``fontalloy`` command line: a thin typer shell over the core.

The CLI holds no logic of its own (ADR-0002): it parses arguments, calls
``fontalloy_core`` in-process, and reports results. ``serve`` arrives in a
later ticket as a sibling command.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Optional

import typer

import fontalloy_core
from fontalloy_core.errors import FontAlloyError

app = typer.Typer(
    name="fontalloy",
    no_args_is_help=True,
    help="Merge multiple fonts into one, driven by codepoint rules.",
)

assets_app = typer.Typer(
    help="Manage the font catalog: fetch verified binaries, generate notices.",
    no_args_is_help=True,
)
app.add_typer(assets_app, name="assets")


@app.callback()
def main() -> None:
    """FontAlloy — merge multiple fonts into one, driven by codepoint rules."""


@app.command()
def build(
    recipe: Annotated[
        Path,
        typer.Argument(
            exists=True,
            dir_okay=False,
            readable=True,
            help="Path to the recipe YAML file.",
        ),
    ],
    output: Annotated[
        Optional[Path],
        typer.Option(
            "--output",
            "-o",
            help="Output font path (default: <recipe stem>.ttf beside the recipe).",
        ),
    ] = None,
    report: Annotated[
        Optional[Path],
        typer.Option(
            "--report",
            help="Verification report path "
            "(default: <output stem>.report.json beside the output).",
        ),
    ] = None,
) -> None:
    """Build a merged font from a recipe.

    v0: the base font passes through with donors loaded and validated;
    every build emits a verification report with per-codepoint provenance.
    """
    output = output if output is not None else recipe.with_suffix(".ttf")
    try:
        result = fontalloy_core.build(recipe, output, report_path=report)
    except FontAlloyError as exc:
        typer.secho(f"error: {exc}", fg=typer.colors.RED, err=True)
        raise typer.Exit(code=2) from None

    summary = result.report.summary
    typer.echo(
        f"built {result.font_path} "
        f"({summary['output_codepoints']} codepoints in output)"
    )
    typer.echo(
        f"report {result.report_path} "
        f"({summary['from_base']} from base, {summary['from_donors']} from donors)"
    )


@assets_app.command("fetch")
def assets_fetch(
    manifest: Annotated[
        Path,
        typer.Option(
            "--manifest",
            help="Path to the catalog manifest "
            "(default: assets/fonts.manifest.json in the working directory).",
        ),
    ] = Path("assets") / "fonts.manifest.json",
    dest: Annotated[
        Optional[Path],
        typer.Option(
            "--dest",
            help="Download directory (default: a fonts directory beside the manifest).",
        ),
    ] = None,
) -> None:
    """Download the catalog into a gitignored directory, verifying sha256.

    Every artifact is checked against its pinned checksum; a mismatch or an
    unreachable origin aborts the run with a nonzero exit code. Already
    verified artifacts are skipped, so re-runs only fill what is missing.
    """
    try:
        summary = fontalloy_core.fetch_catalog(manifest, dest, echo=typer.echo)
    except FontAlloyError as exc:
        typer.secho(f"error: {exc}", fg=typer.colors.RED, err=True)
        raise typer.Exit(code=2) from None

    typer.echo(
        f"fetched {summary.downloaded} artifact(s), "
        f"{summary.skipped} already verified"
    )


@assets_app.command("notices")
def assets_notices(
    manifest: Annotated[
        Path,
        typer.Option(
            "--manifest",
            help="Path to the catalog manifest "
            "(default: assets/fonts.manifest.json in the working directory).",
        ),
    ] = Path("assets") / "fonts.manifest.json",
    output: Annotated[
        Path,
        typer.Option(
            "--output",
            "-o",
            help="Notices output path (default: THIRD-PARTY-NOTICES.md).",
        ),
    ] = Path("THIRD-PARTY-NOTICES.md"),
) -> None:
    """Generate THIRD-PARTY-NOTICES.md from the catalog manifest.

    Per family: copyright, license, upstream pin, and Reserved Font Name
    notes for merged-output naming, plus the full license texts. Generated
    output — regenerate instead of editing by hand.
    """
    try:
        notices_path = fontalloy_core.write_notices(
            manifest, output, reporter=lambda p: typer.echo(f"wrote {p}")
        )
    except FontAlloyError as exc:
        typer.secho(f"error: {exc}", fg=typer.colors.RED, err=True)
        raise typer.Exit(code=2) from None
    typer.echo(f"notices generated from {manifest} -> {notices_path}")


if __name__ == "__main__":
    app()
