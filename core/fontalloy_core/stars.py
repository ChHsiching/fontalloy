"""Launch-cached GitHub stars, core-side (issue #38).

The successor of ``gui/src/catalog/stars.ts``: the repo→family mapping
(“the repos the catalog manifest pins” — ``upstream_url`` →
``owner/repo``, first entry per family) and the once-per-launch sweep
live behind ``GET /catalog/stars`` so the frontend drops its own
network dependency (spec #25, user story 25).

The sweep runs ONCE per serve launch, on a daemon thread started at
serve startup — never inside a request handler. Repos are queried
sequentially with a pause between requests (an unauthenticated client
owes the shared GitHub rate limit exactly that; the shipped catalog
dedupes to ~27 repos), each with a bounded timeout, and every failure
mode is a skip: offline is a state, not an error. The endpoint is
always a 200 — ``state`` says whether the launch sweep has finished,
``stars`` carries whatever landed (possibly nothing).
"""

from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from fontalloy_core.catalog import Catalog

#: The real API the sweep talks to; tests point :data:`STARS_API_ENV`
#: at a file:// tree instead (the offline-suite convention).
DEFAULT_API_BASE = "https://api.github.com"

#: Test seam: when set, the stars API base URL comes from here.
STARS_API_ENV = "FONTALLOY_STARS_API"

#: Per-request timeout and the pause between two repos (the frontend
#: module's own pacing, preserved).
_TIMEOUT_SECONDS = 8.0
_PAUSE_SECONDS = 0.25

#: Hostnames whose first two path segments are an owner/repo pair.
_REPO_HOSTS = ("github.com", "raw.githubusercontent.com")


def repo_of_url(url: str | None) -> str | None:
    """``owner/repo`` of a pinned upstream URL (None when it pins
    nothing GitHub-shaped)."""
    if not url:
        return None
    try:
        parsed = urllib.parse.urlparse(url)
    except ValueError:
        return None
    if parsed.hostname not in _REPO_HOSTS:
        return None
    segments = [segment for segment in parsed.path.split("/") if segment]
    if len(segments) < 2:
        return None
    return f"{segments[0]}/{segments[1]}"


def repo_of_family(entries_by_family: dict[str, list[Any]], family: str) -> str | None:
    """The repo a catalog family pins (its first entry decides; None
    when it pins none)."""
    for entry in entries_by_family.get(family, ()):
        return repo_of_url(entry.upstream_url)
    return None


def fetch_repo_stars(api_base: str, repo: str) -> int | None:
    """One bounded GET, never raising (offline is a state, not an
    error). A rate-limited (403) or gone (404) repo reads as None — the
    cached count, wherever it lives, stands."""
    url = f"{api_base.rstrip('/')}/repos/{repo}"
    request = urllib.request.Request(
        url, headers={"Accept": "application/vnd.github+json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=_TIMEOUT_SECONDS) as response:
            if response.status not in (None, 200):  # file:// carries no status
                return None
            document = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError):
        return None
    count = document.get("stargazers_count") if isinstance(document, dict) else None
    return count if isinstance(count, (int, float)) else None


class StarsCache:
    """The launch-cached star counts behind ``GET /catalog/stars``.

    With no manifest (or no GitHub-shaped upstreams) there is nothing
    to fetch and the document reports ``disabled`` immediately; the
    state is otherwise ``fetching`` until the one launch sweep ends and
    ``done`` forever after — a second sweep never runs.
    """

    def __init__(self, catalog: Catalog | None, api_base: str | None = None):
        self._api_base = api_base or os.environ.get(STARS_API_ENV) or DEFAULT_API_BASE
        self._lock = threading.Lock()
        self._stars: dict[str, int] = {}
        entries_by_family: dict[str, list[Any]] = {}
        if catalog is not None:
            for entry in catalog.entries:
                entries_by_family.setdefault(entry.family, []).append(entry)
        self._family_repos: dict[str, str] = {
            family: repo
            for family in entries_by_family
            if (repo := repo_of_family(entries_by_family, family)) is not None
        }
        self._repos: list[str] = list(dict.fromkeys(self._family_repos.values()))
        self._state = "disabled" if not self._repos else "fetching"
        self._thread: threading.Thread | None = None

    # -- lifecycle -----------------------------------------------------------

    def start(self) -> None:
        """Start the launch sweep (a no-op when there is nothing to fetch)."""
        if not self._repos:
            with self._lock:
                self._state = "disabled"
            return
        if self._thread is not None and self._thread.is_alive():
            return
        self._thread = threading.Thread(
            target=self._run, name="fontalloy-stars", daemon=True
        )
        self._thread.start()

    def _run(self) -> None:
        """The one launch sweep: sequential, paced, failure-tolerant."""
        for repo in self._repos:
            stars = fetch_repo_stars(self._api_base, repo)
            if stars is not None:
                with self._lock:
                    for family, pinned in self._family_repos.items():
                        if pinned == repo:
                            self._stars[family] = int(stars)
            time.sleep(_PAUSE_SECONDS)
        with self._lock:
            self._state = "done"

    # -- the polled surface ----------------------------------------------------

    def document(self) -> dict[str, Any]:
        """The endpoint's response: always a snapshot, never an error."""
        with self._lock:
            return {"state": self._state, "stars": dict(self._stars)}
