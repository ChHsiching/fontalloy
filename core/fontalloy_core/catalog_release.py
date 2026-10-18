"""Catalog-release metadata: the ordered origin list as data.

The catalog release (a dedicated GitHub Releases tag such as
``font-catalog-v1``, built by CI) carries one metadata document,
``catalog-release.json``, next to the per-family zips. The document is
the delivery truth for the app-side downloader (issue #17): the ordered
``origins`` list names where family zips may be fetched from, in
priority order — GitHub Releases alone in v1; a China mirror added later
is a metadata edit, never a code change (issue #1's catalog-origin
decision). Provenance — upstream tags, URLs, checksum sources, licenses
— stays in the committed manifest; this document says only what ships
where, with which checksums.

Loading is strict, like the manifest loader: a wrong schema string, a
missing field, a malformed sha256, an empty origin list, or a duplicate
family is a :class:`~fontalloy_core.errors.ReleaseError` naming the
offender — the downloader must never act on metadata it half-understands.
"""

from __future__ import annotations

import json
import re
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fontalloy_core.errors import ReleaseError

#: The catalog-release metadata schema this loader understands.
SCHEMA = "fontalloy/catalog-release@v1"

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True)
class Origin:
    """One place family zips may be downloaded from, in list order."""

    id: str
    base_url: str


@dataclass(frozen=True)
class ReleaseFile:
    """One font face inside a family zip, with its pinned sha256."""

    file: str
    sha256: str


@dataclass(frozen=True)
class ReleaseFamily:
    """One family's release artifact and its contents."""

    family: str
    zip: str
    sha256: str
    files: tuple[ReleaseFile, ...]


@dataclass(frozen=True)
class CatalogRelease:
    """A parsed catalog-release metadata document."""

    path: Path
    tag: str
    origins: tuple[Origin, ...]
    families: tuple[ReleaseFamily, ...]


def load_catalog_release(path: Path | str) -> CatalogRelease:
    """Load and validate a catalog-release metadata document."""
    metadata_path = Path(path)
    if not metadata_path.is_file():
        raise ReleaseError(f"catalog-release metadata not found: {metadata_path}")

    try:
        data = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ReleaseError(f"catalog-release metadata is not valid JSON: {exc}") from None

    if not isinstance(data, dict):
        raise ReleaseError("catalog-release metadata must be a JSON object")
    if data.get("schema") != SCHEMA:
        raise ReleaseError(
            f"catalog-release schema {data.get('schema')!r} is not supported "
            f"(expected {SCHEMA!r})"
        )

    tag = _string(data.get("tag"), "metadata field 'tag'")

    origins = _load_origins(data.get("origins"))
    families = _load_families(data.get("families"))
    return CatalogRelease(
        path=metadata_path, tag=tag, origins=origins, families=families
    )


#: The loopback hostnames the dev carve-out below accepts.
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})


def _is_loopback_http(base_url: str) -> bool:
    """The dev carve-out: a plain-http origin on a loopback host.

    The vite dev/preview servers serve the REAL dev catalog's origin at
    ``http://127.0.0.1:<port>/dev-catalog/origins/dev`` (gui/scripts/
    dev-catalog.mjs) — by construction loopback, and the documented way
    a local ``fontalloy serve`` consumes the dev catalog (the harness's
    journey suites, spec #25). The deleted frontend loader carried the
    same carve-out (gui/src/catalog/release.ts); the strict loader
    keeps it for loopback ONLY — anything else plain-http stays a
    load-time error, so a production catalog can never silently
    downgrade off https.
    """
    try:
        parsed = urllib.parse.urlsplit(base_url)
    except ValueError:
        return False
    return parsed.scheme == "http" and parsed.hostname in _LOOPBACK_HOSTS


def _load_origins(raw: Any) -> tuple[Origin, ...]:
    if not isinstance(raw, list) or not raw:
        raise ReleaseError(
            "metadata field 'origins' must be a non-empty ordered list "
            "(the downloader tries origins in list order)"
        )
    origins: list[Origin] = []
    seen: set[str] = set()
    for index, item in enumerate(raw):
        where = f"origin {index}"
        if not isinstance(item, dict):
            raise ReleaseError(f"{where} must be a JSON object")
        origin_id = _string(item.get("id"), f"{where} field 'id'")
        base_url = _string(item.get("base_url"), f"{where} field 'base_url'")
        if not base_url.startswith(("https://", "file://")) and not _is_loopback_http(
            base_url
        ):
            raise ReleaseError(
                f"{where} ({origin_id}): base_url must be an https:// or "
                f"file:// URL, got {base_url!r}"
            )
        if origin_id in seen:
            raise ReleaseError(f"{where}: duplicate origin id {origin_id!r}")
        seen.add(origin_id)
        origins.append(Origin(id=origin_id, base_url=base_url))
    return tuple(origins)


def _load_families(raw: Any) -> tuple[ReleaseFamily, ...]:
    if not isinstance(raw, list) or not raw:
        raise ReleaseError("metadata field 'families' must be a non-empty list")
    families: list[ReleaseFamily] = []
    seen_families: set[str] = set()
    seen_zips: set[str] = set()
    for index, item in enumerate(raw):
        where = f"family {index}"
        if not isinstance(item, dict):
            raise ReleaseError(f"{where} must be a JSON object")
        family = _string(item.get("family"), f"{where} field 'family'")
        where = f"family {family!r}"
        zip_name = _filename(item.get("zip"), f"{where} field 'zip'")
        sha256 = _sha256(item.get("sha256"), f"{where} field 'sha256'")
        if family in seen_families:
            raise ReleaseError(f"{where} duplicates an earlier family")
        if zip_name in seen_zips:
            raise ReleaseError(f"{where} reuses zip {zip_name!r} of another family")
        seen_families.add(family)
        seen_zips.add(zip_name)
        families.append(
            ReleaseFamily(
                family=family,
                zip=zip_name,
                sha256=sha256,
                files=_load_files(item.get("files"), where),
            )
        )
    return tuple(families)


def _load_files(raw: Any, where: str) -> tuple[ReleaseFile, ...]:
    if not isinstance(raw, list) or not raw:
        raise ReleaseError(f"{where}: field 'files' must be a non-empty list")
    files: list[ReleaseFile] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            raise ReleaseError(f"{where}: each file entry must be a JSON object")
        name = _filename(item.get("file"), f"{where} file entry field 'file'")
        sha256 = _sha256(item.get("sha256"), f"{where} file {name!r} field 'sha256'")
        if name in seen:
            raise ReleaseError(f"{where} lists file {name!r} twice")
        seen.add(name)
        files.append(ReleaseFile(file=name, sha256=sha256))
    return tuple(files)


def _string(value: Any, where: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ReleaseError(f"{where} must be a non-empty string")
    return value


def _filename(value: Any, where: str) -> str:
    name = _string(value, where)
    if "/" in name or "\\" in name:
        raise ReleaseError(f"{where} must be a bare filename, got {name!r}")
    return name


def _sha256(value: Any, where: str) -> str:
    if not isinstance(value, str) or not _SHA256_RE.fullmatch(value):
        raise ReleaseError(
            f"{where} must be 64 lowercase hex characters, got {value!r}"
        )
    return value
