"""Catalog fetch: download pinned artifacts and verify every sha256.

``fetch_catalog`` is the engine behind ``fontalloy assets fetch``
(ADR-0005): it fills a gitignored directory with the catalog's artifacts
exactly as the manifest pins them. Every artifact is verified against its
pinned sha256 — a mismatch deletes the download and fails loudly; git
never carries a font binary, and a corrupted or tampered artifact never
reaches the build.

Origins are ordinary URLs (``https://`` upstream releases in production,
``file://`` local directories in the offline test suite). Zip artifacts
keep the verified archive and additionally extract their font faces
beside it, so later pipeline stages read unpacked TTF/OTF files.

This module is also the assets machinery behind catalog-family recipe
references (issue #23): :func:`resolve_recipe_fonts` turns a recipe's
``family``/``variant``/``pattern`` references into concrete font files
inside the fetched directory — re-verifying the pinned artifact's
sha256 on the way, so a build from catalog references is exactly a
build against the manifest's pinned source fonts.
"""

from __future__ import annotations

import hashlib
import shutil
import urllib.error
import urllib.request
import zipfile
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from fnmatch import fnmatchcase
from pathlib import Path
from urllib.parse import unquote

from fontalloy_core.catalog import Catalog, CatalogEntry, font_suffixes, load_manifest
from fontalloy_core.errors import AssetsError
from fontalloy_core.recipe import FontRef, Recipe

#: Read/download chunk size (1 MiB).
_CHUNK = 1 << 20
#: Per-request timeout; generous for slow release CDNs.
_TIMEOUT_SECONDS = 300


@dataclass(frozen=True)
class FetchSummary:
    """What one fetch run did."""

    downloaded: int
    skipped: int


def fetch_catalog(
    manifest_path: Path | str,
    dest: Path | str | None = None,
    *,
    families: Sequence[str] | None = None,
    echo: Callable[[str], None] = lambda _msg: None,
) -> FetchSummary:
    """Fetch every manifest entry into ``dest``, verifying sha256 pins.

    ``dest`` defaults to a ``fonts`` directory beside the manifest. Entries
    whose artifact is already present with a matching checksum are skipped,
    which makes re-runs cheap and powers the first-run retry behavior.
    ``families`` narrows the run to the named manifest families (issue #23:
    CI fetches exactly what the official recipes reference); an unknown
    family name is a clear error, never a silent no-op.
    """
    catalog: Catalog = load_manifest(manifest_path)
    dest_dir = Path(dest) if dest is not None else catalog.manifest_path.parent / "fonts"

    entries = catalog.entries
    if families is not None:
        wanted = list(dict.fromkeys(families))
        known = {entry.family for entry in catalog.entries}
        unknown = [name for name in wanted if name not in known]
        if unknown:
            raise AssetsError(
                f"unknown family {unknown[0]!r} in the fetch filter "
                f"(the manifest carries {len(known)} families)"
            )
        selected = set(wanted)
        entries = [entry for entry in catalog.entries if entry.family in selected]

    pending = [entry for entry in entries if entry.pending]
    if pending:
        names = ", ".join(f"{e.family} ({e.file})" for e in pending)
        raise AssetsError(
            "manifest entries without a pinned sha256 cannot be fetched "
            f"securely; compute and pin them first: {names}"
        )

    dest_dir.mkdir(parents=True, exist_ok=True)
    downloaded = 0
    skipped = 0
    for entry in entries:
        target = dest_dir / entry.file
        if target.is_file() and sha256_of(target) == entry.sha256:
            # The artifact is verified, but the layout must be whole:
            # a zip whose extracted faces vanished is re-extracted, so
            # "re-run assets fetch" genuinely repairs any state the
            # error messages point it at (issue #23).
            if zipfile.is_zipfile(target) and not (dest_dir / target.stem).is_dir():
                extracted = _extract_faces(target, dest_dir / target.stem)
                echo(f"{entry.file}: extracted {extracted} font file(s)")
            skipped += 1
            echo(f"{entry.file}: already verified")
            continue
        _download_verified(entry, target)
        downloaded += 1
        echo(f"{entry.file}: verified ({entry.checksum_source} sha256)")
        if zipfile.is_zipfile(target):
            extracted = _extract_faces(target, dest_dir / target.stem)
            echo(f"{entry.file}: extracted {extracted} font file(s)")

    return FetchSummary(downloaded=downloaded, skipped=skipped)


def _download_verified(entry: CatalogEntry, target: Path) -> None:
    """Download ``entry`` to a temp file, verify it, then move it into place."""
    download_verified(
        entry.upstream_url,
        target,
        entry.sha256,
        describe=f"{entry.family} ({entry.file})",
    )


def download_verified(
    url: str, target: Path, expected: str, *, describe: str
) -> None:
    """Download ``url`` to a temp file, verify sha256, then move into place.

    Shared by the catalog fetch and the origin-list consumer
    (:mod:`fontalloy_core.origins`): one download-and-verify
    implementation, so both paths fail identically. ``describe`` names the
    artifact in errors (``"<family> (<file>)"`` from the fetch path).
    """
    temp = target.with_name(target.name + ".part")
    try:
        digest = hashlib.sha256()
        with urllib.request.urlopen(url, timeout=_TIMEOUT_SECONDS) as response:  # noqa: S310
            # file:// responses carry no HTTP status; only http(s) is checked
            if response.status not in (None, 200):
                raise AssetsError(
                    f"{describe}: origin returned HTTP {response.status} for {url}"
                )
            with temp.open("wb") as out:
                while chunk := response.read(_CHUNK):
                    digest.update(chunk)
                    out.write(chunk)
        actual = digest.hexdigest()
        if actual != expected:
            raise AssetsError(
                f"{describe}: sha256 mismatch — expected {expected}, got "
                f"{actual}; the download was deleted and NOT placed in the "
                "assets directory"
            )
        temp.replace(target)
    except AssetsError:
        temp.unlink(missing_ok=True)
        raise
    except (urllib.error.URLError, OSError) as exc:
        temp.unlink(missing_ok=True)
        raise AssetsError(
            f"{describe}: download failed from {url}: {exc}"
        ) from None


def _extract_faces(archive: Path, into: Path) -> int:
    """Extract the font files from a verified zip artifact.

    Only font files are extracted (licenses stay inside the verified
    archive of record); member paths are sanitized so a hostile archive
    cannot write outside ``into``.
    """
    into.mkdir(parents=True, exist_ok=True)
    extracted = 0
    with zipfile.ZipFile(archive) as zf:
        for info in zf.infolist():
            name = Path(unquote(info.filename)).name
            if info.is_dir() or name.startswith("."):
                continue
            if not name.lower().endswith(font_suffixes()):
                continue
            with zf.open(info) as src, (into / name).open("wb") as out:
                shutil.copyfileobj(src, out)
            extracted += 1
    return extracted


def sha256_of(path: Path) -> str:
    """The sha256 hex digest of a file, read in chunks."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def recipe_catalog_families(recipe: Recipe) -> tuple[str, ...]:
    """The manifest families a recipe references, sorted and unique.

    The fetch filter behind ``fontalloy assets fetch --recipes``: the
    union over the base and every donor reference (issue #23).
    """
    families = {
        ref.family for ref in (recipe.base, *recipe.donors) if ref.family is not None
    }
    return tuple(sorted(families))


def recipes_catalog_families(recipes: Sequence[Recipe]) -> tuple[str, ...]:
    """The manifest families any of the given recipes reference."""
    families: set[str] = set()
    for recipe in recipes:
        families.update(recipe_catalog_families(recipe))
    return tuple(sorted(families))


def resolve_recipe_fonts(
    recipe: Recipe,
    manifest_path: Path | str,
    fonts_dir: Path | str | None = None,
) -> Recipe:
    """Resolve a recipe's catalog-family references against the fetched
    catalog.

    Every ``family`` reference is looked up in the manifest, its pinned
    artifact is located in ``fonts_dir`` (default: the ``fonts``
    directory beside the manifest, exactly what ``fontalloy assets
    fetch`` fills) and re-verified against the pinned sha256 — a
    drifted or missing artifact is a clear error pointing at the fetch
    command. The reference's ``paths`` fill with the referenced font
    files (an optional ``pattern`` — a bare-filename glob — narrows a
    multi-file artifact such as a Nerd Fonts zip, whose extracted
    directory carries several internal families) and ``artifact``
    records the pin for the build's source provenance. Path references
    pass through untouched.
    """
    catalog: Catalog = load_manifest(manifest_path)
    fonts = (
        Path(fonts_dir)
        if fonts_dir is not None
        else catalog.manifest_path.parent / "fonts"
    )
    base = _resolve_ref(recipe.base, catalog, fonts, "base")
    donors = tuple(
        _resolve_ref(ref, catalog, fonts, f"donors[{index}]")
        for index, ref in enumerate(recipe.donors)
    )
    return replace(recipe, base=base, donors=donors)


def _resolve_ref(
    ref: FontRef, catalog: Catalog, fonts: Path, where: str
) -> FontRef:
    """Resolve one catalog reference to concrete, verified files."""
    if ref.family is None:
        return ref

    entry = _lookup_entry(ref, catalog, where)
    if entry.pending:
        raise AssetsError(
            f"{where}: catalog family {entry.family!r} ({entry.file}) has no "
            "pinned sha256 yet; compute and pin it in the manifest first"
        )
    artifact = fonts / entry.file
    describe = f"{where}: catalog family {entry.family!r} ({entry.file})"
    if not artifact.is_file():
        raise AssetsError(
            f"{describe} is not fetched — run `fontalloy assets fetch "
            f"--family {entry.family}` first (expected {artifact})"
        )
    actual = sha256_of(artifact)
    if actual != entry.sha256:
        raise AssetsError(
            f"{describe}: sha256 mismatch — the manifest pins "
            f"{entry.sha256}, the fetched artifact hashes {actual}; "
            "re-run `fontalloy assets fetch` to restore the pinned bytes"
        )

    files = _entry_files(entry, artifact, fonts, ref, where)
    return replace(ref, paths=tuple(files), artifact=artifact)


def _lookup_entry(ref: FontRef, catalog: Catalog, where: str) -> CatalogEntry:
    """Find the manifest entry a family/variant reference names."""
    matches = [entry for entry in catalog.entries if entry.family == ref.family]
    if not matches:
        raise AssetsError(
            f"{where}: unknown catalog family {ref.family!r} (the manifest "
            f"carries {len(catalog.entries)} entries)"
        )
    if ref.variant is not None:
        for entry in matches:
            if entry.variant == ref.variant:
                return entry
        variants = ", ".join(
            repr(entry.variant) for entry in sorted(matches, key=lambda e: e.variant)
        )
        raise AssetsError(
            f"{where}: family {ref.family!r} has no variant {ref.variant!r} "
            f"(it carries: {variants})"
        )
    if len(matches) > 1:
        variants = ", ".join(
            repr(entry.variant) for entry in sorted(matches, key=lambda e: e.variant)
        )
        raise AssetsError(
            f"{where}: family {ref.family!r} carries several variants "
            f"({variants}) — the reference must declare one"
        )
    return matches[0]


def _entry_files(
    entry: CatalogEntry, artifact: Path, fonts: Path, ref: FontRef, where: str
) -> list[Path]:
    """The font files a manifest entry contributes, in deterministic order.

    A bare font artifact is the one file; an archive contributes its
    extracted faces (``<fonts>/<archive stem>/``), narrowed by the
    reference's pattern when given.
    """
    if artifact.suffix.lower() in font_suffixes():
        candidates = [artifact]
    else:
        extracted = fonts / artifact.stem
        if not extracted.is_dir():
            raise AssetsError(
                f"{where}: {entry.family!r} ({entry.file}) is fetched but "
                f"its extracted faces are missing at {extracted} — re-run "
                "`fontalloy assets fetch`"
            )
        candidates = sorted(
            path
            for path in extracted.iterdir()
            if path.is_file() and path.suffix.lower() in font_suffixes()
        )
        if not candidates:
            raise AssetsError(
                f"{where}: {entry.family!r} ({entry.file}) contains no font "
                "faces"
            )

    if ref.pattern is None:
        return candidates

    matched = [path for path in candidates if fnmatchcase(path.name, ref.pattern)]
    if not matched:
        available = ", ".join(path.name for path in candidates)
        raise AssetsError(
            f"{where}: pattern {ref.pattern!r} matches no file of "
            f"{entry.family!r} ({entry.file}); available: {available}"
        )
    return matched
