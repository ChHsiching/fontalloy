"""The ``fontalloy`` command line: a thin typer shell over the core.

The CLI holds no logic of its own (ADR-0002): it parses arguments, calls
``fontalloy_core`` in-process, and reports results. ``build`` and
``serve`` drive the pipeline (``serve`` as the localhost HTTP service
both frontends consume), and the ``assets`` / ``recipes`` subcommands
cover the catalog and release workflow.
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

recipes_app = typer.Typer(
    help="Work with recipe files: the families they pin, release packaging.",
    no_args_is_help=True,
)
app.add_typer(recipes_app, name="recipes")


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
    manifest: Annotated[
        Optional[Path],
        typer.Option(
            "--manifest",
            help="Catalog manifest resolving the recipe's catalog-family "
            "font references (default: assets/fonts.manifest.json in the "
            "working directory). Unnecessary for path-only recipes.",
        ),
    ] = None,
    fonts_dir: Annotated[
        Optional[Path],
        typer.Option(
            "--fonts-dir",
            help="Fetched catalog directory the references resolve in "
            "(default: a fonts directory beside the manifest, as "
            "`assets fetch` fills it).",
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
    weight. Every build emits a verification report with codepoint
    coverage, the weight borrow table, and the metric comparison —
    printed here in the terminal form, written beside the font as the
    machine-readable JSON plus the rendered HTML.
    """
    try:
        result = fontalloy_core.build(
            recipe,
            output,
            report_path=report,
            output_format=output_format,
            manifest=manifest,
            fonts_dir=fonts_dir,
        )
    except FontAlloyError as exc:
        typer.secho(f"error: {exc}", fg=typer.colors.RED, err=True)
        raise typer.Exit(code=2) from None

    summary = result.report.summary
    typer.echo(
        f"built {result.font_path} (format {result.format}, "
        f"{summary['output_codepoints']} codepoints in output)"
    )
    typer.echo(f"report {result.report_path} (machine-readable JSON)")
    if result.report_html_path is not None:
        typer.echo(f"report {result.report_html_path} (rendered, human-readable)")
    # The terminal form of the whole report (issue #12): coverage with
    # explicit gaps, the borrow table, and the before/after metrics —
    # including the borrow lines the interface has always stated.
    typer.echo()
    typer.echo(fontalloy_core.render_text(result.report), nl=False)


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
    system_font_dir: Annotated[
        Optional[list[Path]],
        typer.Option(
            "--system-font-dir",
            help="System font directory to enumerate at /system-fonts "
            "(repeatable; default: the platform's standard font "
            "directories). Also the e2e seam — a fixture directory "
            "stands in for the real one.",
        ),
    ] = None,
    system_cache_dir: Annotated[
        Optional[Path],
        typer.Option(
            "--system-cache-dir",
            help="Directory the system-font scan caches its result in "
            "(round 25: a steady-state launch stat-walks and parses "
            "nothing). No disk cache when omitted.",
        ),
    ] = None,
    fonts_cache_dir: Annotated[
        Optional[Path],
        typer.Option(
            "--fonts-cache-dir",
            help="Directory the /fonts directory scan caches its result "
            "in (spec #25 review P1-1: same contract as "
            "--system-cache-dir — a steady-state launch stat-walks the "
            "font directories and parses nothing). No disk cache when "
            "omitted.",
        ),
    ] = None,
    catalog_release_origin: Annotated[
        Optional[str],
        typer.Option(
            "--catalog-release-origin",
            help="Base URL serving catalog-release.json (the catalog "
            "release tag's download address; file:// works for offline "
            "setups). Together with --catalog-dir it activates the "
            "serve-side catalog sync polled at /catalog/status.",
        ),
    ] = None,
    catalog_dir: Annotated[
        Optional[Path],
        typer.Option(
            "--catalog-dir",
            help="Cache directory the catalog sync fills with verified "
            "family archives and extracted faces (the app's font "
            "directory). Together with --catalog-release-origin it "
            "activates the sync.",
        ),
    ] = None,
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
        system_font_dirs=(
            tuple(system_font_dir) if system_font_dir is not None else None
        ),
        system_cache_dir=system_cache_dir,
        fonts_cache_dir=fonts_cache_dir,
        catalog_release_origin=catalog_release_origin,
        catalog_dir=catalog_dir,
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
    family: Annotated[
        Optional[list[str]],
        typer.Option(
            "--family",
            help="Fetch only the named manifest family (repeatable); the "
            "default fetches the whole catalog.",
        ),
    ] = None,
    recipes: Annotated[
        Optional[Path],
        typer.Option(
            "--recipes",
            help="Recipe directory whose referenced families to fetch "
            "(every .yaml under it, recursively) — CI fetches exactly what "
            "the recipes pin. Combines with --family (union).",
        ),
    ] = None,
) -> None:
    """Download the catalog into a gitignored directory, verifying sha256.

    Every artifact is checked against its pinned checksum; a mismatch or an
    unreachable origin aborts the run with a nonzero exit code. Already
    verified artifacts are skipped, so re-runs only fill what is missing.
    """
    try:
        families = _collect_families(manifest, family, recipes)
        summary = fontalloy_core.fetch_catalog(
            manifest, dest, families=families, echo=typer.echo
        )
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
    family: Annotated[
        Optional[list[str]],
        typer.Option(
            "--family",
            help="Include only the named manifest family (repeatable); the "
            "default covers the whole catalog.",
        ),
    ] = None,
    recipes: Annotated[
        Optional[Path],
        typer.Option(
            "--recipes",
            help="Recipe directory whose referenced families to cover "
            "(every .yaml under it, recursively) — a recipe release "
            "carries exactly its source fonts' notices. Combines with "
            "--family (union).",
        ),
    ] = None,
) -> None:
    """Generate THIRD-PARTY-NOTICES.md from the catalog manifest.

    Per family: copyright, license, upstream pin, and Reserved Font Name
    notes for merged-output naming, plus the full license texts. Generated
    output — regenerate instead of editing by hand.
    """
    try:
        families = _collect_families(manifest, family, recipes)
        notices_path = fontalloy_core.write_notices(
            manifest,
            output,
            families=families,
            reporter=lambda p: typer.echo(f"wrote {p}"),
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


def _collect_families(
    manifest: Path, family: Optional[list[str]], recipes: Optional[Path]
) -> Optional[list[str]]:
    """The union of --family names and --recipes-referenced families.

    None means "no filter" (everything); an empty union is an error, not
    a silent no-op fetch. Recipes that fail to parse stop the command —
    a broken recipe must never look like an empty family list.
    """
    if family is None and recipes is None:
        return None
    families: list[str] = list(family or [])
    if recipes is not None:
        recipes_dir = Path(recipes)
        if not recipes_dir.is_dir():
            raise fontalloy_core.errors.RecipeError(
                f"recipe directory not found: {recipes_dir}"
            )
        recipe_paths = sorted(recipes_dir.rglob("*.yaml"))
        if not recipe_paths:
            raise fontalloy_core.errors.RecipeError(
                f"recipe directory holds no .yaml recipes: {recipes_dir}"
            )
        parsed = [fontalloy_core.load_recipe(path) for path in recipe_paths]
        families.extend(fontalloy_core.recipes_catalog_families(parsed))
        # The recipe files are only read for their families here; say
        # which recipes were consulted so a surprise is traceable.
        typer.echo(
            f"recipes under {recipes_dir}: "
            + ", ".join(path.name for path in recipe_paths)
        )
    unique = list(dict.fromkeys(families))
    if not unique:
        raise fontalloy_core.errors.RecipeError(
            "the family filter is empty — name a --family or point --recipes "
            "at recipes that reference catalog families"
        )
    return unique


@recipes_app.command("families")
def recipes_families(
    recipes: Annotated[
        Path,
        typer.Option(
            "--recipes",
            help="Recipe directory to scan (every .yaml under it, "
            "recursively).",
        ),
    ] = Path("recipes"),
) -> None:
    """List the manifest families recipes reference, one per line.

    The fetch filter CI composes: `fontalloy recipes families --recipes "
    "recipes` feeds `fontalloy assets fetch --family`. Recipes that "
    fail to parse stop the command with exit code 2.
    """
    try:
        families = _recipes_families(Path(recipes))
    except FontAlloyError as exc:
        typer.secho(f"error: {exc}", fg=typer.colors.RED, err=True)
        raise typer.Exit(code=2) from None
    for name in families:
        typer.echo(name)


def _recipes_families(recipes_dir: Path) -> list[str]:
    if not recipes_dir.is_dir():
        raise fontalloy_core.errors.RecipeError(
            f"recipe directory not found: {recipes_dir}"
        )
    recipe_paths = sorted(recipes_dir.rglob("*.yaml"))
    if not recipe_paths:
        raise fontalloy_core.errors.RecipeError(
            f"recipe directory holds no .yaml recipes: {recipes_dir}"
        )
    parsed = [fontalloy_core.load_recipe(path) for path in recipe_paths]
    families = list(fontalloy_core.recipes_catalog_families(parsed))
    if not families:
        raise fontalloy_core.errors.RecipeError(
            f"no recipe under {recipes_dir} references a catalog family"
        )
    return families


@recipes_app.command("package")
def recipes_package(
    recipe: Annotated[
        list[Path],
        typer.Argument(
            exists=True,
            dir_okay=False,
            readable=True,
            help="Recipe files whose builds to package (repeatable).",
        ),
    ],
    builds: Annotated[
        Path,
        typer.Option(
            "--builds",
            help="Directory holding the builds (fonts plus report.json / "
            "report.html per recipe stem).",
        ),
    ] = Path("build"),
    out: Annotated[
        Path,
        typer.Option(
            "--out",
            help="Staging directory for the release artifacts (default: dist).",
        ),
    ] = Path("dist"),
    notices: Annotated[
        Optional[Path],
        typer.Option(
            "--notices",
            help="THIRD-PARTY-NOTICES.md to carry inside every recipe zip "
            "and at the release root (generate with `assets notices "
            "--recipes ...`).",
        ),
    ] = None,
    include: Annotated[
        Optional[list[Path]],
        typer.Option(
            "--include",
            help="Extra file to attach and checksum (repeatable).",
        ),
    ] = None,
) -> None:
    """Stage the recipe release: one zip per recipe, SHA256SUMS.

    Each zip carries the built font, both verification report forms, and
    the notices — self-contained and license-compliant. Byte-reproducible:
    re-running over the same builds yields identical artifacts.
    """
    try:
        package = fontalloy_core.package_recipe_release(
            recipe,
            builds,
            out,
            notices=notices,
            include=include or [],
            echo=typer.echo,
        )
    except FontAlloyError as exc:
        typer.secho(f"error: {exc}", fg=typer.colors.RED, err=True)
        raise typer.Exit(code=2) from None
    typer.echo(f"packaged {package.recipes} recipe zip(s) -> {package.out_dir}")
    typer.echo(f"checksums {package.out_dir / 'SHA256SUMS'}")


if __name__ == "__main__":
    app()
