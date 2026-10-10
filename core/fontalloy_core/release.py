"""Catalog-release packaging: per-family zips, SHA256SUMS, and metadata.

``package_catalog_release`` is the engine behind ``fontalloy assets
package`` and the CI catalog-release job (issue #14): it reads the
committed manifest, takes the directory ``fontalloy assets fetch``
filled, and produces a GitHub-Release-shaped staging directory — one
zip per family (every face of the family plus its license file, so a
downloaded family is self-contained and license-compliant), a
``SHA256SUMS`` file covering every attached artifact in ``sha256sum
-c`` format, and the ``catalog-release.json`` metadata document that
carries the ordered origin list (see :mod:`fontalloy_core.catalog_release`).

Packaging is byte-reproducible: zip members are written with a fixed
timestamp in a sorted order, JSON is rendered with a fixed key order,
and nothing reads the wall clock — so a clean checkout plus fetch plus
package yields artifacts identical to the published release.
"""

from __future__ import annotations

import json
import zipfile
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

from fontalloy_core.assets import sha256_of
from fontalloy_core.catalog import CatalogEntry, font_suffixes, load_manifest
from fontalloy_core.catalog_release import SCHEMA, Origin
from fontalloy_core.errors import ReleaseError

#: Metadata document name inside the staging directory.
METADATA_NAME = "catalog-release.json"
#: Checksums file name inside the staging directory.
SUMS_NAME = "SHA256SUMS"

#: Fixed zip member timestamp (2026-01-01, matching the fixture fonts):
#: no wall clock ever enters a release artifact.
FIXED_ZIP_TIMESTAMP = (2026, 1, 1, 0, 0, 0)


@dataclass(frozen=True)
class ReleasePackage:
    """What one packaging run produced."""

    out_dir: Path
    families: int
    faces: int


def package_catalog_release(
    manifest_path: Path | str,
    fetched_dir: Path | str | None = None,
    out_dir: Path | str = "dist",
    *,
    tag: str,
    origins: Sequence[Origin],
    include: Sequence[Path | str] = (),
    echo: Callable[[str], None] = lambda _msg: None,
) -> ReleasePackage:
    """Stage the catalog release from a fetched catalog.

    ``fetched_dir`` defaults to the ``fonts`` directory beside the
    manifest (what ``fontalloy assets fetch`` fills). ``tag`` is the
    release tag the artifacts will attach to — it is recorded in the
    metadata and belongs in the origins' base URLs. ``include`` adds
    extra already-written files (e.g. THIRD-PARTY-NOTICES.md) to the
    checksums, so every attached artifact is verifiable.
    """
    if not tag.strip():
        raise ReleaseError("packaging requires the release tag")
    if not origins:
        raise ReleaseError(
            "packaging requires at least one origin — the metadata must "
            "tell the downloader where to fetch from"
        )
    catalog = load_manifest(manifest_path)
    fetched = Path(fetched_dir) if fetched_dir is not None else catalog.manifest_path.parent / "fonts"
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    grouped: dict[str, list[CatalogEntry]] = {}
    for entry in catalog.entries:
        if "/" in entry.family or "\\" in entry.family:
            raise ReleaseError(
                f"family {entry.family!r} is not usable as a release asset name"
            )
        grouped.setdefault(entry.family, []).append(entry)

    families_meta: list[dict] = []
    checksums: dict[str, str] = {}
    total_faces = 0
    for family in sorted(grouped):
        zip_name = f"{family}.zip"
        faces = _family_faces(family, grouped[family], fetched)
        licenses = _family_licenses(grouped[family])
        _write_family_zip(out / zip_name, faces, licenses, family)
        checksums[zip_name] = sha256_of(out / zip_name)
        families_meta.append(
            {
                "family": family,
                "zip": zip_name,
                "sha256": checksums[zip_name],
                "files": [
                    {"file": face.name, "sha256": sha256_of(face)}
                    for face in sorted(faces, key=lambda p: p.name)
                ],
            }
        )
        total_faces += len(faces)
        echo(f"{zip_name}: {len(faces)} face(s), {len(licenses)} license file(s)")

    metadata = {
        "schema": SCHEMA,
        "tag": tag,
        "origins": [{"id": o.id, "base_url": o.base_url} for o in origins],
        "families": families_meta,
    }
    metadata_path = out / METADATA_NAME
    metadata_path.write_bytes(
        (json.dumps(metadata, ensure_ascii=False, indent=1) + "\n").encode("utf-8")
    )
    checksums[METADATA_NAME] = sha256_of(metadata_path)
    echo(f"{METADATA_NAME}: {len(families_meta)} families, {len(origins)} origin(s)")

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

    return ReleasePackage(out_dir=out, families=len(families_meta), faces=total_faces)


def _family_faces(
    family: str, entries: Sequence[CatalogEntry], fetched: Path
) -> list[Path]:
    """The font faces of one family inside the fetched directory."""
    faces: list[Path] = []
    for entry in entries:
        artifact = fetched / entry.file
        if not artifact.is_file():
            raise ReleaseError(
                f"{family} ({entry.file}): artifact not fetched — run "
                "`fontalloy assets fetch` before packaging"
            )
        if artifact.suffix.lower() in font_suffixes():
            faces.append(artifact)
            continue
        extracted = fetched / artifact.stem
        if not extracted.is_dir():
            raise ReleaseError(
                f"{family} ({entry.file}): extracted faces not found at "
                f"{extracted} — run `fontalloy assets fetch` before packaging"
            )
        archive_faces = sorted(
            p for p in extracted.iterdir()
            if p.is_file() and p.suffix.lower() in font_suffixes()
        )
        if not archive_faces:
            raise ReleaseError(
                f"{family} ({entry.file}): the fetched archive contains no "
                "font faces"
            )
        faces.extend(archive_faces)
    return faces


def _family_licenses(entries: Sequence[CatalogEntry]) -> dict[str, Path]:
    """The distinct license files a family's entries reference."""
    licenses: dict[str, Path] = {}
    for entry in entries:
        licenses.setdefault(entry.license_file.name, entry.license_file)
    return licenses


def _write_family_zip(
    target: Path, faces: Sequence[Path], licenses: dict[str, Path], family: str
) -> None:
    """Write one family zip deterministically: sorted, fixed timestamps."""
    members: dict[str, Path] = {face.name: face for face in faces}
    for name, path in licenses.items():
        if name in members:
            raise ReleaseError(
                f"{family}: license file {name!r} collides with a face name"
            )
        members[name] = path
    with zipfile.ZipFile(target, "w") as zf:
        for name in sorted(members):
            info = zipfile.ZipInfo(name, date_time=FIXED_ZIP_TIMESTAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16  # regular file, rw-r--r--
            zf.writestr(info, members[name].read_bytes())
