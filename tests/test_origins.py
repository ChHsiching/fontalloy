"""Seam 1 tests: the catalog-release metadata contract and the origin list.

The ordered origin list is the v1 delivery decision (issue #1): the
catalog release metadata carries the origins in priority order, and the
downloader (ticket #17) consumes them as data — GitHub Releases alone in
v1, a China mirror later, with no code change anywhere. These tests pin
that contract against hand-written metadata documents and local
``file://`` origins standing in for release hosts; no network.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
from fontalloy_core import (
    AssetsError,
    ReleaseError,
    fetch_from_origins,
    load_catalog_release,
)

RELEASE_SCHEMA = "fontalloy/catalog-release@v1"

ARTIFACT = "FakeCJK.zip"
ARTIFACT_BYTES = b"the mirrored catalog zip payload"
ARTIFACT_SHA = hashlib.sha256(ARTIFACT_BYTES).hexdigest()


def write_release(path: Path, origins: list[dict], *, tag: str = "font-catalog-v1") -> Path:
    """Write a minimal hand-authored catalog-release metadata document."""
    path.write_text(
        json.dumps(
            {
                "schema": RELEASE_SCHEMA,
                "tag": tag,
                "origins": origins,
                "families": [
                    {
                        "family": "FakeCJK",
                        "zip": ARTIFACT,
                        "sha256": ARTIFACT_SHA,
                        "files": [
                            {
                                "file": "FakeCJK-Regular.ttf",
                                "sha256": hashlib.sha256(b"face bytes").hexdigest(),
                            }
                        ],
                    }
                ],
            },
            indent=1,
        )
        + "\n",
        encoding="utf-8",
    )
    return path


def origin_dir(tmp_path: Path, name: str, *, serve: bool, stale: bool = False) -> Path:
    """A local stand-in origin directory addressed via file:// URLs.

    ``serve`` places the artifact; ``stale`` serves different bytes (a
    checksum mismatch), modelling a mirror that lags behind the release.
    """
    directory = tmp_path / name
    directory.mkdir(parents=True)
    if serve:
        (directory / ARTIFACT).write_bytes(ARTIFACT_BYTES if not stale else b"old bytes")
    return directory


class TestLoadCatalogRelease:
    def test_metadata_parses_with_the_ordered_origin_list(self, tmp_path):
        path = write_release(
            tmp_path / "catalog-release.json",
            [
                {"id": "github-releases", "base_url": "https://github.com/ChHsiching/fontalloy/releases/download/font-catalog-v1"},
                {"id": "mirror", "base_url": "https://mirror.example.com/fontalloy/v1"},
            ],
        )

        release = load_catalog_release(path)

        assert [o.id for o in release.origins] == ["github-releases", "mirror"]
        assert release.origins[1].base_url == "https://mirror.example.com/fontalloy/v1"
        assert release.tag == "font-catalog-v1"
        family = release.families[0]
        assert (family.family, family.zip, family.sha256) == ("FakeCJK", ARTIFACT, ARTIFACT_SHA)
        assert family.files[0].file == "FakeCJK-Regular.ttf"

    def test_metadata_rejects_a_wrong_schema(self, tmp_path):
        path = write_release(tmp_path / "catalog-release.json", [])
        data = json.loads(path.read_text(encoding="utf-8"))
        data["schema"] = "fontalloy/catalog-release@v0"
        path.write_text(json.dumps(data), encoding="utf-8")

        with pytest.raises(ReleaseError, match="schema"):
            load_catalog_release(path)

    def test_metadata_rejects_an_empty_origin_list(self, tmp_path):
        path = write_release(tmp_path / "catalog-release.json", [])

        with pytest.raises(ReleaseError, match="origins"):
            load_catalog_release(path)

    def test_metadata_rejects_a_malformed_sha256(self, tmp_path):
        path = write_release(
            tmp_path / "catalog-release.json",
            [{"id": "github-releases", "base_url": "https://github.com/x/y/releases/download/t"}],
        )
        data = json.loads(path.read_text(encoding="utf-8"))
        data["families"][0]["sha256"] = "not-hex"
        path.write_text(json.dumps(data), encoding="utf-8")

        with pytest.raises(ReleaseError, match="sha256"):
            load_catalog_release(path)

    def test_metadata_accepts_a_loopback_http_origin_the_dev_carve_out(self, tmp_path):
        # The vite dev/preview catalog middleware serves its origin at a
        # loopback http address by construction (gui/scripts/
        # dev-catalog.mjs); a local serve consuming the dev catalog
        # (the journey harness, spec #25) must be able to load that
        # document. Loopback ONLY — the production rule below stands.
        path = write_release(
            tmp_path / "catalog-release.json",
            [
                {"id": "dev", "base_url": "http://127.0.0.1:5351/dev-catalog/origins/dev"},
                {"id": "dev-v6", "base_url": "http://[::1]:5351/dev-catalog/origins/dev"},
                {"id": "dev-named", "base_url": "http://localhost:4273/dev-catalog/origins/dev"},
            ],
        )

        release = load_catalog_release(path)

        assert [o.id for o in release.origins] == ["dev", "dev-v6", "dev-named"]

    def test_metadata_rejects_plain_http_off_loopback(self, tmp_path):
        path = write_release(
            tmp_path / "catalog-release.json",
            [{"id": "not-dev", "base_url": "http://example.com/fontalloy/v1"}],
        )

        with pytest.raises(ReleaseError, match="https:// or file://"):
            load_catalog_release(path)


class TestFetchFromOrigins:
    def test_the_first_origin_that_serves_the_artifact_wins(self, tmp_path):
        first = origin_dir(tmp_path, "github", serve=True)
        second = origin_dir(tmp_path, "mirror", serve=True)
        dest = tmp_path / "fonts"
        dest.mkdir()

        result = fetch_from_origins(
            [load_origin("github", first), load_origin("mirror", second)],
            ARTIFACT,
            ARTIFACT_SHA,
            dest,
        )

        assert result.origin_id == "github"
        assert (dest / ARTIFACT).read_bytes() == ARTIFACT_BYTES

    def test_a_dead_origin_falls_through_to_the_next_in_order(self, tmp_path):
        dead = origin_dir(tmp_path, "github", serve=False)
        live = origin_dir(tmp_path, "mirror", serve=True)
        dest = tmp_path / "fonts"
        dest.mkdir()

        result = fetch_from_origins(
            [load_origin("github", dead), load_origin("mirror", live)],
            ARTIFACT,
            ARTIFACT_SHA,
            dest,
        )

        assert result.origin_id == "mirror"
        assert (dest / ARTIFACT).read_bytes() == ARTIFACT_BYTES

    def test_adding_a_china_mirror_is_a_data_change_not_a_code_change(self, tmp_path):
        """The acceptance test for the origin-list decision.

        Two metadata documents differ ONLY in ``origins`` — the first ships
        v1's single GitHub origin (dead here), the second adds a mirror
        after it. The same downloader call goes from failing to working,
        so a mirror lands by editing release metadata, never code.
        """
        github = origin_dir(tmp_path, "github", serve=False)
        mirror = origin_dir(tmp_path, "mirror", serve=True)
        v1 = write_release(
            tmp_path / "catalog-release-v1.json",
            [{"id": "github-releases", "base_url": github.as_uri()}],
        )
        v2 = write_release(
            tmp_path / "catalog-release-v2.json",
            [
                {"id": "github-releases", "base_url": github.as_uri()},
                {"id": "china-mirror", "base_url": mirror.as_uri()},
            ],
        )
        dest_a = tmp_path / "fonts-a"
        dest_b = tmp_path / "fonts-b"
        dest_a.mkdir()
        dest_b.mkdir()

        with pytest.raises(AssetsError, match="github-releases"):
            fetch_from_origins(
                load_catalog_release(v1).origins, ARTIFACT, ARTIFACT_SHA, dest_a
            )

        result = fetch_from_origins(
            load_catalog_release(v2).origins, ARTIFACT, ARTIFACT_SHA, dest_b
        )

        assert result.origin_id == "china-mirror"
        assert (dest_b / ARTIFACT).read_bytes() == ARTIFACT_BYTES

    def test_all_origins_failing_names_every_origin_and_reason(self, tmp_path):
        dead = origin_dir(tmp_path, "github", serve=False)
        stale = origin_dir(tmp_path, "mirror", serve=True, stale=True)
        dest = tmp_path / "fonts"
        dest.mkdir()

        with pytest.raises(AssetsError) as excinfo:
            fetch_from_origins(
                [load_origin("github-releases", dead), load_origin("china-mirror", stale)],
                ARTIFACT,
                ARTIFACT_SHA,
                dest,
            )

        message = str(excinfo.value)
        assert "github-releases" in message
        assert "china-mirror" in message
        assert "sha256" in message.lower()
        # a mismatched download never lands in the destination
        assert not (dest / ARTIFACT).exists()
        assert not (dest / (ARTIFACT + ".part")).exists()

    def test_an_already_verified_artifact_is_skipped_without_any_origin(self, tmp_path):
        dest = tmp_path / "fonts"
        dest.mkdir()
        (dest / ARTIFACT).write_bytes(ARTIFACT_BYTES)

        result = fetch_from_origins([], ARTIFACT, ARTIFACT_SHA, dest)

        assert result.skipped is True


def load_origin(origin_id: str, directory: Path):
    from fontalloy_core import Origin

    return Origin(id=origin_id, base_url=directory.as_uri())
