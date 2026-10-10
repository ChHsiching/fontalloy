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
from fontalloy_core.catalog_release import Origin
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
            help="Output font path (default: <recipe stem>.<format> beside the recipe).",
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
    output_format: Annotated[
        Optional[str],
        typer.Option(
            "--format",
            "-f",
            help="Output format: ttf (default), ttc, or woff2. Overrides the "
            "recipe's output.format.",
        ),
    ] = None,
) -> None:
    """Build a merged font from a recipe.

    Donor glyphs graft into the base font per the recipe's precedence
    rules, the output identity is rewritten (name table and OS/2, the
    fixed brand default `ChHsich` unless the recipe overrides
    `output.family`), and the requested weight/style matrix (the base
    file's faces by default, a recipe `weights` selection otherwise)
    emits one merged face per slot with donors matched at the nearest
    weight. Every build emits a verification report with per-codepoint
    provenance, the weight borrow table, and the source font hashes
    backing reproducibility.
    """
    try:
        result = fontalloy_core.build(
            recipe, output, report_path=report, output_format=output_format
        )
    except FontAlloyError as exc:
        typer.secho(f"error: {exc}", fg=typer.colors.RED, err=True)
        raise typer.Exit(code=2) from None

    summary = result.report.summary
    typer.echo(
        f"built {result.font_path} (format {result.format}, "
        f"{summary['output_codepoints']} codepoints in output)"
    )
    typer.echo(
        f"report {result.report_path} "
        f"({summary['from_base']} from base, {summary['from_donors']} from donors)"
    )
    # The weight borrow table, stated in the interface too (issue #9):
    # one line per output slot, every borrow named.
    for slot in result.report.weights:
        style = "italic" if slot.italic else "upright"
        borrows = ", ".join(
            f"{borrow.donor} from {borrow.weight} ({borrow.via})"
            + (" upright" if borrow.style_fallback else "")
            for borrow in slot.borrows
        )
        typer.echo(f"weight {slot.weight} {style}: {borrows or 'no donors'}")


@app.command()
def serve(
    port: Annotated[
        int,
        typer.Option(
            "--port",
            min=0,
            max=65535,
            help="Port to bind on 127.0.0.1 (0 = an OS-assigned ephemeral "
            "port; the bound URL is printed on stdout as the startup line).",
        ),
    ] = 0,
    allow_origin: Annotated[
        Optional[list[str]],
        typer.Option(
            "--allow-origin",
            help="Origin CORS allows, e.g. the WebApp's (repeatable). The "
            "Tauri GUI passes its webview origins (tauri://localhost on "
            "macOS/Linux, http://tauri.localhost on Windows). Unlisted "
            "origins get no CORS headers and their preflights are rejected.",
        ),
    ] = None,
    manifest: Annotated[
        Optional[Path],
        typer.Option(
            "--manifest",
            help="Catalog manifest to enumerate at /catalog "
            "(default: assets/fonts.manifest.json in the working directory; "
            "a missing manifest means an empty catalog).",
        ),
    ] = Path("assets") / "fonts.manifest.json",
    font_dir: Annotated[
        Optional[list[Path]],
        typer.Option(
            "--font-dir",
            help="Local font directory to enumerate at /fonts (repeatable).",
        ),
    ] = None,
    work_dir: Annotated[
        Optional[Path],
        typer.Option(
            "--work-dir",
            help="Directory for build scratch and retained artifacts "
            "(default: a fresh system temp directory, removed on exit; a "
            "given directory itself is kept, only the service's scratch "
            "inside it is removed).",
        ),
    ] = None,
    keep_builds: Annotated[
        int,
        typer.Option(
            "--keep-builds",
            min=1,
            help="How many of the newest finished builds keep their "
            "downloadable artifacts (default: 10).",
        ),
    ] = 10,
) -> None:
    """Run the core as a localhost HTTP service (127.0.0.1 only).

    The contract both frontends consume (issue #11): enumerate the font
    catalog (/catalog) and local font directories (/fonts), submit a
    merge as recipe-shaped JSON (POST /builds — the same recipe schema
    ``fontalloy build`` parses), poll build progress (GET /builds/<id>
    reports the pipeline stage), and download the output font and its
    verification report. Builds run asynchronously on a queue; the
    output formats are ttf, ttc, and woff2.

    The bind address is 127.0.0.1, always — there is deliberately no
    way to widen it. The implementation is the Python standard library
    only, so the sidecar binary the GUI bundles stays lean. Graceful
    shutdown on SIGINT/SIGTERM (Ctrl-Break on Windows) removes every
    temporary artifact.
    """
    options = fontalloy_core.ServeOptions(
        port=port,
        allow_origins=tuple(allow_origin or ()),
        manifest=manifest,
        font_dirs=tuple(font_dir or ()),
        work_dir=work_dir,
        keep_builds=keep_builds,
    )
    try:
        fontalloy_core.run_serve(options)
    except FontAlloyError as exc:
        typer.secho(f"error: {exc}", fg=typer.colors.RED, err=True)
        raise typer.Exit(code=2) from None


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


@assets_app.command("package")
def assets_package(
    manifest: Annotated[
        Path,
        typer.Option(
            "--manifest",
            help="Path to the catalog manifest "
            "(default: assets/fonts.manifest.json in the working directory).",
        ),
    ] = Path("assets") / "fonts.manifest.json",
    fetched: Annotated[
        Optional[Path],
        typer.Option(
            "--fetched",
            help="Fetched catalog directory (default: a fonts directory "
            "beside the manifest, as `assets fetch` fills it).",
        ),
    ] = None,
    out: Annotated[
        Path,
        typer.Option(
            "--out",
            help="Staging directory for the release artifacts (default: dist).",
        ),
    ] = Path("dist"),
    repo: Annotated[
        str,
        typer.Option(
            "--repo",
            help="GitHub repository hosting the catalog release "
            "(default: this project's repository).",
        ),
    ] = "ChHsiching/fontalloy",
    tag: Annotated[
        str,
        typer.Option(
            "--tag",
            help="Dedicated catalog release tag (default: font-catalog-v1).",
        ),
    ] = "font-catalog-v1",
    extra_origin: Annotated[
        Optional[list[str]],
        typer.Option(
            "--extra-origin",
            help="Additional download origin as id=base_url, appended after "
            "the GitHub origin (repeatable).",
        ),
    ] = None,
    include: Annotated[
        Optional[list[Path]],
        typer.Option(
            "--include",
            help="Extra file to attach and checksum, e.g. the generated "
            "THIRD-PARTY-NOTICES.md (repeatable).",
        ),
    ] = None,
) -> None:
    """Stage the catalog release: per-family zips, SHA256SUMS, metadata.

    Reads the fetched catalog and writes the release layout CI attaches
    to the dedicated tag: one zip per family (all faces plus the license
    file), a SHA256SUMS covering every artifact, and catalog-release
    metadata whose ordered origin list is the app downloader's delivery
    contract. Byte-reproducible: re-running on the same inputs yields
    identical artifacts.
    """
    origins = [Origin(id="github-releases", base_url=f"https://github.com/{repo}/releases/download/{tag}")]
    for spec in extra_origin or []:
        origin_id, separator, base_url = spec.partition("=")
        if not separator or not origin_id.strip() or not base_url.strip():
            typer.secho(
                f"error: --extra-origin must be id=base_url, got {spec!r}",
                fg=typer.colors.RED,
                err=True,
            )
            raise typer.Exit(code=2)
        origins.append(Origin(id=origin_id, base_url=base_url))

    try:
        package = fontalloy_core.package_catalog_release(
            manifest,
            fetched,
            out,
            tag=tag,
            origins=origins,
            include=include or [],
            echo=typer.echo,
        )
    except FontAlloyError as exc:
        typer.secho(f"error: {exc}", fg=typer.colors.RED, err=True)
        raise typer.Exit(code=2) from None

    typer.echo(
        f"packaged {package.families} family zip(s) "
        f"({package.faces} faces) -> {package.out_dir}"
    )
    typer.echo(f"metadata {package.out_dir / 'catalog-release.json'} ({len(origins)} origin(s))")


if __name__ == "__main__":
    app()
