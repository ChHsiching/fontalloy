"""Origin-list consumption: fetch an artifact, trying origins in order.

The app-side downloader (issue #17) calls this with the ordered origin
list parsed from catalog-release metadata
(:func:`fontalloy_core.load_catalog_release`). Each origin's ``base_url``
addresses the same release artifacts; the first origin that serves the
artifact with a matching sha256 wins. A dead or stale origin (network
error, checksum mismatch) falls through to the next one — so a mirror
added to the metadata heals a blocked primary, and reordering the list
reprioritizes download sources, both without touching code.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

from fontalloy_core.assets import download_verified, sha256_of
from fontalloy_core.catalog_release import Origin
from fontalloy_core.errors import AssetsError

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True)
class OriginFetch:
    """What one origin-ordered fetch did."""

    origin_id: str
    url: str
    path: Path
    skipped: bool


def fetch_from_origins(
    origins: Sequence[Origin],
    file: str,
    sha256: str,
    dest: Path | str,
    *,
    echo: Callable[[str], None] = lambda _msg: None,
) -> OriginFetch:
    """Fetch ``file`` into ``dest``, trying ``origins`` in list order.

    An artifact already present with a matching checksum is skipped —
    the same retry-on-launch mechanism the catalog fetch uses. When every
    origin fails, the error names each origin and why, so the user can
    tell a blocked mirror from a corrupt one.
    """
    if "/" in file or "\\" in file:
        raise AssetsError(f"artifact name must be a bare filename, got {file!r}")
    if not _SHA256_RE.fullmatch(sha256):
        raise AssetsError(f"expected sha256 for {file!r} must be 64 lowercase hex")

    dest_dir = Path(dest)
    dest_dir.mkdir(parents=True, exist_ok=True)
    target = dest_dir / file
    if target.is_file() and sha256_of(target) == sha256:
        echo(f"{file}: already verified")
        return OriginFetch(origin_id="", url="", path=target, skipped=True)

    if not origins:
        raise AssetsError(
            f"{file}: the origin list is empty — catalog-release metadata "
            "must carry at least one origin"
        )

    attempts: list[str] = []
    for origin in origins:
        url = f"{origin.base_url.rstrip('/')}/{file}"
        try:
            download_verified(url, target, sha256, describe=file)
        except AssetsError as exc:
            attempts.append(f"{origin.id}: {exc}")
            echo(f"{file}: origin {origin.id} failed, trying the next one")
            continue
        echo(f"{file}: verified from origin {origin.id}")
        return OriginFetch(origin_id=origin.id, url=url, path=target, skipped=False)

    raise AssetsError(
        f"{file}: every origin failed — " + "; ".join(attempts)
    )
