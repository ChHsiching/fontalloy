"""Ticket #43: materialize the fetched layout beside the serve's catalog.

The desktop client's split layout — variant metadata in a manifest,
synced family archives in the app's catalog directory — cannot satisfy
the recipe resolver's fetched-layout contract on its own: the manifest's
entries pin PER-ENTRY artifact files whose bytes must exist and hash to
the pins. The materializer downloads the origin's per-entry artifacts
and license files into ``<catalog_dir>/fonts/`` and writes a
self-consistent manifest at ``<catalog_dir>/fonts.manifest.json``
(each entry's sha256 = the hash of the bytes on disk), so the
resolver's default ``<manifest dir>/fonts`` rule sees exactly the
fetched layout ``fontalloy assets fetch`` would have produced.

The origin is the same base URL the catalog sync downloads family
archives from (the vite dev-catalog in dev builds, the GitHub release
tag in production), extended with three routes: ``manifest.json``,
``entry/<artifact file>``, and ``licenses/<name>``.

Runs as a daemon thread started after the HTTP server binds, yielding
between artifacts (the sync's GIL convention), and is idempotent:
artifacts that already exist with a non-zero size are hashed in place
and never re-downloaded, so steady-state launches pay a stat walk and
local reads only. The manifest is written LAST, atomically (temp file
+ rename): its presence means the set beneath it is complete as of
that write.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

#: Release artifacts run to tens of MB.
_FETCH_TIMEOUT = 180

#: The GIL-yield cadence between artifacts (the sync's convention).
_YIELD_SECONDS = 0.02


def _get_bytes(url: str) -> bytes:
    """One GET, whole body (loopback or a CDN; no streaming contract)."""
    with urllib.request.urlopen(url, timeout=_FETCH_TIMEOUT) as response:
        return response.read()


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def materialize(
    origin: str,
    catalog_dir: Path,
    stop: threading.Event | None = None,
) -> bool:
    """Fill ``<catalog_dir>/fonts/`` and write ``fonts.manifest.json``.

    Returns True when the self-consistent manifest is on disk (written
    this run or already current). Per-artifact failures are logged and
    skipped — the entry stays absent, its picks fail verification
    honestly, and the next launch retries the download.
    """
    origin = origin.rstrip("/")
    catalog_dir.mkdir(parents=True, exist_ok=True)
    fonts_dir = catalog_dir / "fonts"
    fonts_dir.mkdir(parents=True, exist_ok=True)
    manifest_target = catalog_dir / "fonts.manifest.json"

    try:
        manifest: dict[str, Any] = json.loads(_get_bytes(f"{origin}/manifest.json"))
    except (urllib.error.URLError, OSError, ValueError) as exc:
        log.warning("catalog materializer: manifest fetch failed: %s", exc)
        return manifest_target.is_file()

    entries = manifest.get("families")
    if not isinstance(entries, list) or not entries:
        log.warning("catalog materializer: origin manifest has no families")
        return manifest_target.is_file()

    pins: dict[str, str] = {}
    licenses: set[str] = set()
    for entry in entries:
        name = str(entry.get("file") or "").replace("/", "-").replace("\\", "-")
        if not name:
            continue
        target = fonts_dir / name
        if not (target.is_file() and target.stat().st_size > 0):
            try:
                body = _get_bytes(f"{origin}/entry/{name}")
                tmp = target.with_suffix(target.suffix + ".part")
                tmp.write_bytes(body)
                tmp.replace(target)
                pins[name] = _sha256_bytes(body)
            except (urllib.error.URLError, OSError) as exc:
                log.warning(
                    "catalog materializer: %s failed (%s); "
                    "its picks stay honestly unfetched",
                    name,
                    exc,
                )
                if stop is not None and stop.is_set():
                    return manifest_target.is_file()
                continue
        else:
            pins[name] = _sha256_file(target)
        # The fetched layout's extraction: the resolver expects the
        # entry's faces under <fonts>/<stem>/ beside the zip (exactly
        # where `fontalloy assets fetch` unpacks them). Skipped when
        # the directory already carries faces (steady-state launch).
        stem = Path(name).stem
        extract_dir = fonts_dir / stem
        if not (extract_dir.is_dir() and any(extract_dir.iterdir())):
            try:
                extract_dir.mkdir(parents=True, exist_ok=True)
                with zipfile.ZipFile(target) as archive:
                    archive.extractall(extract_dir)
            except (OSError, zipfile.BadZipFile) as exc:
                log.warning(
                    "catalog materializer: extracting %s failed (%s)", name, exc
                )
        license_file = entry.get("license_file")
        if isinstance(license_file, str) and license_file:
            licenses.add(license_file)
        if stop is not None and stop.is_set():
            return manifest_target.is_file()
        threading.Event().wait(_YIELD_SECONDS)

    for license_file in sorted(licenses):
        target = catalog_dir / license_file
        if target.is_file():
            continue
        name = Path(license_file).name
        try:
            body = _get_bytes(f"{origin}/licenses/{name}")
            target.parent.mkdir(parents=True, exist_ok=True)
            tmp = target.with_suffix(target.suffix + ".part")
            tmp.write_bytes(body)
            tmp.replace(target)
        except (urllib.error.URLError, OSError) as exc:
            log.warning(
                "catalog materializer: license %s failed (%s)", name, exc
            )

    # The self-consistent manifest: same entries, pins = the bytes on
    # disk. Written LAST and atomically — its presence certifies the
    # set beneath it as of this write.
    for entry in entries:
        name = str(entry.get("file") or "").replace("/", "-").replace("\\", "-")
        if name in pins:
            entry["sha256"] = pins[name]
    tmp = manifest_target.with_suffix(".json.part")
    tmp.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1) + "\n",
        encoding="utf-8",
    )
    tmp.replace(manifest_target)
    log.info(
        "catalog materializer: %d artifacts under %s, manifest written",
        len(pins),
        fonts_dir,
    )
    return True
