"""Recipe-release packaging: one zip per recipe, SHA256SUMS, no clocks.

``package_recipe_release`` is the engine behind ``fontalloy recipes
package`` and the CI recipe-release job (issue #23): it reads the
recipe files whose builds a run produced, and stages a
GitHub-Release-shaped directory — one zip per recipe carrying the built
font, its machine-readable verification report, the rendered human
form, and the release's THIRD-PARTY-NOTICES (OFL condition 1: the
copyright and license accompany each copy) — plus a ``SHA256SUMS`` file
covering every attached artifact in ``sha256sum -c`` format.

Packaging is byte-reproducible, like the catalog release it mirrors:
zip members are written with a fixed timestamp in a sorted order, and
nothing reads the wall clock — so the same recipe builds plus notices
stage identical artifacts on any machine.
"""

from __future__ import annotations

import zipfile
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

from fontalloy_core.assets import sha256_of
from fontalloy_core.errors import ReleaseError
from fontalloy_core.recipe import load_recipe
from fontalloy_core.release import FIXED_ZIP_TIMESTAMP

#: Checksums file name inside the staging directory.
SUMS_NAME = "SHA256SUMS"

#: The notices file's name inside every recipe zip and at the release
#: root — OFL condition 1 wants the copyright and license to accompany
#: each copy, so each self-contained zip carries them.
NOTICES_NAME = "THIRD-PARTY-NOTICES.md"

#: The font formats a build may emit, in the order they are probed.
_FONT_FORMATS = ("ttf", "ttc", "woff2")


@dataclass(frozen=True)
class RecipePackage:
    """What one packaging run produced."""

    out_dir: Path
    recipes: int
    notices: Path | None


def package_recipe_release(
    recipe_paths: Sequence[Path | str],
    builds_dir: Path | str,
    out_dir: Path | str = "dist",
    *,
    notices: Path | str | None = None,
    include: Sequence[Path | str] = (),
    echo: Callable[[str], None] = lambda _msg: None,
) -> RecipePackage:
    """Stage the recipe release from a directory of finished builds.

    Every recipe is parsed (strictly — a recipe that no longer parses
    stops the release) and its artifacts located in ``builds_dir`` by
    the build's naming rule: ``<recipe stem>.<format>`` plus
    ``<recipe stem>.report.json`` and ``<recipe stem>.report.html``.
    ``notices`` (the filtered THIRD-PARTY-NOTICES.md of the release)
    travels inside every zip and is staged at the release root;
    ``include`` adds extra already-written files to the checksums.
    """
    if not recipe_paths:
        raise ReleaseError("packaging requires at least one recipe file")

    builds = Path(builds_dir)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    notices_path = Path(notices) if notices is not None else None
    if notices_path is not None and not notices_path.is_file():
        raise ReleaseError(f"notices file not found: {notices_path}")

    checksums: dict[str, str] = {}

    for recipe_path in recipe_paths:
        recipe_file = Path(recipe_path)
        recipe = load_recipe(recipe_file)  # strict: invalid recipes stop here
        stem = recipe_file.stem
        font = _find_font(builds, stem)
        members: dict[str, Path] = {
            font.name: font,
            f"{stem}.report.json": builds / f"{stem}.report.json",
            f"{stem}.report.html": builds / f"{stem}.report.html",
        }
        if notices_path is not None:
            members[NOTICES_NAME] = notices_path
        missing = [name for name, path in members.items() if not path.is_file()]
        if missing:
            raise ReleaseError(
                f"recipe {recipe_file.name}: build artifacts missing in "
                f"{builds} — {', '.join(missing)}; build the recipe before "
                "packaging"
            )
        zip_name = f"{stem}.zip"
        _write_recipe_zip(out / zip_name, members, recipe_file.name)
        checksums[zip_name] = sha256_of(out / zip_name)
        echo(
            f"{zip_name}: {font.name} + report + notices "
            f"({recipe_file.name})"
        )

    if notices_path is not None:
        staged_notices = out / NOTICES_NAME
        staged_notices.write_bytes(notices_path.read_bytes())
        checksums[NOTICES_NAME] = sha256_of(staged_notices)

    for extra in include:
        extra_path = Path(extra)
        if not extra_path.is_file():
            raise ReleaseError(f"included artifact not found: {extra_path}")
        if extra_path.name in checksums or extra_path.name == SUMS_NAME:
            raise ReleaseError(
                f"included artifact {extra_path.name!r} collides with a "
                "staged artifact name"
            )
        checksums[extra_path.name] = sha256_of(extra_path)

    sums = "".join(f"{digest}  {name}\n" for name, digest in sorted(checksums.items()))
    (out / SUMS_NAME).write_bytes(sums.encode("utf-8"))
    return RecipePackage(out_dir=out, recipes=len(recipe_paths), notices=notices_path)


def _find_font(builds: Path, stem: str) -> Path:
    """The built font of one recipe: exactly one format's file."""
    found = [
        builds / f"{stem}.{fmt}" for fmt in _FONT_FORMATS
        if (builds / f"{stem}.{fmt}").is_file()
    ]
    if not found:
        raise ReleaseError(
            f"recipe stem {stem!r}: no built font in {builds} (expected one "
            f"of {', '.join(f'{stem}.{fmt}' for fmt in _FONT_FORMATS)}); "
            "build the recipe before packaging"
        )
    if len(found) > 1:
        names = ", ".join(path.name for path in found)
        raise ReleaseError(
            f"recipe stem {stem!r}: several built fonts collide ({names}); "
            "package from a directory holding one build per recipe"
        )
    return found[0]


def _write_recipe_zip(
    target: Path, members: dict[str, Path], recipe_name: str
) -> None:
    """Write one recipe zip deterministically: sorted, fixed timestamps."""
    with zipfile.ZipFile(target, "w") as zf:
        for name in sorted(members):
            info = zipfile.ZipInfo(name, date_time=FIXED_ZIP_TIMESTAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16  # regular file, rw-r--r--
            zf.writestr(info, members[name].read_bytes())
