"""The ``fontalloy`` command line: a thin typer shell over the core.

The CLI holds no logic of its own (ADR-0002): it parses arguments, calls
``fontalloy_core.build`` in-process, and reports results. ``assets`` and
``serve`` arrive in later tickets as sibling commands.
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


if __name__ == "__main__":
    app()
