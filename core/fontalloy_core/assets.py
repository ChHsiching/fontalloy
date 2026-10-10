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
"""

from __future__ import annotations

import hashlib
import shutil
import urllib.error
import urllib.request
import zipfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote

from fontalloy_core.catalog import Catalog, CatalogEntry, font_suffixes, load_manifest
from fontalloy_core.errors import AssetsError

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
    echo: Callable[[str], None] = lambda _msg: None,
) -> FetchSummary:
    """Fetch every manifest entry into ``dest``, verifying sha256 pins.

    ``dest`` defaults to a ``fonts`` directory beside the manifest. Entries
    whose artifact is already present with a matching checksum are skipped,
    which makes re-runs cheap and powers the first-run retry behavior.
    """
    catalog: Catalog = load_manifest(manifest_path)
    dest_dir = Path(dest) if dest is not None else catalog.manifest_path.parent / "fonts"

    pending = [entry for entry in catalog.entries if entry.pending]
    if pending:
        names = ", ".join(f"{e.family} ({e.file})" for e in pending)
        raise AssetsError(
            "manifest entries without a pinned sha256 cannot be fetched "
            f"securely; compute and pin them first: {names}"
        )

    dest_dir.mkdir(parents=True, exist_ok=True)
    downloaded = 0
    skipped = 0
    for entry in catalog.entries:
        target = dest_dir / entry.file
        if target.is_file() and sha256_of(target) == entry.sha256:
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
