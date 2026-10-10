"""Catalog manifest loading: parse the font catalog strictly.

The manifest (``assets/fonts.manifest.json``, committed) is the single
source of truth for the font catalog (ADR-0005). One entry per family /
variant pins the upstream artifact: tag, URL, sha256, SPDX license id,
Reserved Font Name flag, copyright line, and the license file to carry
with redistribution. ``fontalloy assets fetch`` downloads and verifies
exactly what this file declares; nothing about the catalog is improvised
at run time.

Validation is strict, like recipe loading: a wrong schema string, a
missing field, a malformed sha256, a dangling license file reference, or
a duplicated family/variant is a :class:`~fontalloy_core.errors.CatalogError`
naming the offending entry — a broken catalog must never fetch.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fontalloy_core.errors import CatalogError

#: The manifest schema this loader understands.
SCHEMA = "fontalloy/font-catalog@v1"

#: Entry fields the manifest requires (``copyright`` and ``sha256`` may be
#: null; everything else must be present and non-null).
REQUIRED_FIELDS = (
    "family",
    "variant",
    "file",
    "version",
    "upstream_url",
    "sha256",
    "license_spdx",
    "rfn",
    "rfn_names",
    "copyright",
    "license_file",
    "checksum_source",
)

#: Where a pinned sha256 came from. ``pending`` marks entries whose
#: checksum still needs computing and pinning (fetch refuses them loudly).
CHECKSUM_SOURCES = ("upstream-published", "self-computed", "pending")

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_FONT_SUFFIXES = (".ttf", ".otf", ".ttc")


@dataclass(frozen=True)
class CatalogEntry:
    """One pinned upstream artifact, with its licensing truth."""

    family: str
    variant: str
    file: str
    version: str
    upstream_url: str
    sha256: str | None
    license_spdx: str
    rfn: bool
    rfn_names: tuple[str, ...]
    copyright: str | None
    license_file: Path  # resolved against the manifest's directory
    checksum_source: str

    @property
    def pending(self) -> bool:
        """True when no checksum has been pinned yet."""
        return self.sha256 is None


@dataclass(frozen=True)
class Catalog:
    """A parsed catalog manifest."""

    manifest_path: Path
    entries: tuple[CatalogEntry, ...]


def load_manifest(path: Path | str) -> Catalog:
    """Load and validate a catalog manifest."""
    manifest_path = Path(path)
    if not manifest_path.is_file():
        raise CatalogError(f"manifest file not found: {manifest_path}")

    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise CatalogError(f"manifest is not valid JSON: {exc}") from None

    if not isinstance(data, dict):
        raise CatalogError("manifest must be a JSON object")
    if data.get("schema") != SCHEMA:
        raise CatalogError(
            f"manifest schema {data.get('schema')!r} is not supported "
            f"(expected {SCHEMA!r})"
        )

    families_raw = data.get("families")
    if not isinstance(families_raw, list) or not families_raw:
        raise CatalogError("manifest field 'families' must be a non-empty list")

    root = manifest_path.parent
    entries: list[CatalogEntry] = []
    seen: set[tuple[str, str]] = set()
    seen_files: set[str] = set()
    for index, raw in enumerate(families_raw):
        entry = _load_entry(raw, index, root)
        key = (entry.family, entry.variant)
        if key in seen:
            raise CatalogError(
                f"manifest entry {index} ({entry.family} / {entry.variant}) "
                "duplicates an earlier family/variant"
            )
        if entry.file in seen_files:
            raise CatalogError(
                f"manifest entry {index} ({entry.family}) reuses file "
                f"{entry.file!r} already claimed by another entry"
            )
        seen.add(key)
        seen_files.add(entry.file)
        entries.append(entry)

    return Catalog(manifest_path=manifest_path, entries=tuple(entries))


def _load_entry(raw: Any, index: int, root: Path) -> CatalogEntry:
    where = f"manifest entry {index}"
    if not isinstance(raw, dict):
        raise CatalogError(f"{where} must be a JSON object")

    missing = [field for field in REQUIRED_FIELDS if field not in raw]
    if missing:
        raise CatalogError(
            f"{where} is missing required field {missing[0]!r} "
            f"(entry fields: {', '.join(REQUIRED_FIELDS)})"
        )

    family = _string(raw["family"], where, "family")
    variant = _string(raw["variant"], where, "variant", allow_empty=True)
    file = _string(raw["file"], where, "file")
    version = _string(raw["version"], where, "version")
    upstream_url = _string(raw["upstream_url"], where, "upstream_url")
    license_spdx = _string(raw["license_spdx"], where, "license_spdx")
    checksum_source = _string(raw["checksum_source"], where, "checksum_source")

    if "/" in file or "\\" in file:
        raise CatalogError(
            f"{where} ({family}): field 'file' must be a bare filename, got {file!r}"
        )
    if not upstream_url.startswith(("https://", "file://")):
        raise CatalogError(
            f"{where} ({family}): field 'upstream_url' must be an https:// or "
            f"file:// URL, got {upstream_url!r}"
        )
    if checksum_source not in CHECKSUM_SOURCES:
        raise CatalogError(
            f"{where} ({family}): field 'checksum_source' must be one of "
            f"{', '.join(CHECKSUM_SOURCES)}, got {checksum_source!r}"
        )

    sha256 = raw["sha256"]
    if sha256 is not None:
        if not isinstance(sha256, str) or not _SHA256_RE.fullmatch(sha256):
            raise CatalogError(
                f"{where} ({family}): field 'sha256' must be 64 lowercase hex "
                f"characters or null, got {sha256!r}"
            )
    if (sha256 is None) != (checksum_source == "pending"):
        raise CatalogError(
            f"{where} ({family}): sha256 and checksum_source disagree — a null "
            "sha256 means 'pending', a pinned one must be 'upstream-published' "
            "or 'self-computed'"
        )

    if not isinstance(raw["rfn"], bool):
        raise CatalogError(f"{where} ({family}): field 'rfn' must be a boolean")

    rfn_names_raw = raw["rfn_names"]
    if not isinstance(rfn_names_raw, list) or not all(
        isinstance(n, str) and n.strip() for n in rfn_names_raw
    ):
        raise CatalogError(
            f"{where} ({family}): field 'rfn_names' must be a list of non-empty "
            "strings"
        )
    rfn_names = tuple(rfn_names_raw)
    if not raw["rfn"] and rfn_names:
        raise CatalogError(
            f"{where} ({family}): rfn_names is set but rfn is false"
        )

    copyright_ = raw["copyright"]
    if copyright_ is not None and not isinstance(copyright_, str):
        raise CatalogError(f"{where} ({family}): field 'copyright' must be a string or null")

    license_file_raw = _string(raw["license_file"], where, "license_file")
    license_file = (root / license_file_raw).resolve()
    if not license_file.is_file():
        raise CatalogError(
            f"{where} ({family}): license file not found: {license_file_raw}"
        )

    return CatalogEntry(
        family=family,
        variant=variant,
        file=file,
        version=version,
        upstream_url=upstream_url,
        sha256=sha256,
        license_spdx=license_spdx,
        rfn=raw["rfn"],
        rfn_names=rfn_names,
        copyright=copyright_,
        license_file=license_file,
        checksum_source=checksum_source,
    )


def _string(value: Any, where: str, field: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or (not allow_empty and not value.strip()):
        qualifier = "a non-empty string" if not allow_empty else "a string"
        raise CatalogError(f"{where}: field {field!r} must be {qualifier}")
    return value


def font_suffixes() -> tuple[str, ...]:
    """Font file extensions fetch extracts from archive artifacts."""
    return _FONT_SUFFIXES
