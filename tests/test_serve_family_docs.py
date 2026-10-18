"""Seam 2 tests: the picker-facing catalog endpoints (issue #38).

The serve exposes everything a picker needs to render the catalog
without the page touching font bytes (spec #25): per-family documents
carrying display names from the REAL name tables, cuts with the variant
token semantics the frontend model discriminates today, per-face byte
serving streamed from disk with cache headers, tiny per-family preview
subsets so picker rows can self-render their names, and launch-cached
GitHub stars (offline-tolerant). Everything is asserted the way the
frontends see it: the real ``fontalloy`` executable as a subprocess over
real HTTP, plus the on-disk outcomes.

The fixtures follow the offline-suite conventions of
``test_serve_catalog_sync.py``: local ``file://`` origins, real synthetic
fonts inside the family archives, and a file:// stand-in for the GitHub
stars API.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import time
import zipfile
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

from conftest import FIXED_TIMESTAMP, synth_font, synth_placeholder_font  # noqa: F401
from test_cli_assets import FAKE_OFL, entry, write_manifest
from test_cli_serve import running_service
from test_serve_catalog_sync import RELEASE_SCHEMA, TAG, wait_for_terminal

#: Test seam: stretches the family-document builder's per-family yield
#: so a build observably spans time — the responsiveness test needs
#: /health and /catalog/families to answer INSIDE a build.
DOCS_DELAY_ENV = "FONTALLOY_FAMILY_DOCS_DELAY"

#: Test seam: the stars API base URL (a file:// tree stands in for
#: https://api.github.com in the offline suite).
STARS_API_ENV = "FONTALLOY_STARS_API"

#: Enough Latin coverage that every letter of the fixture display names
#: is mapped (the preview subsets must carry the name codepoints).
_LATIN = tuple(range(0x41, 0x7B))  # A-Z a-z


def _sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _wide_font(
    path: Path, *, family: str, subfamily: str, weight: int, codepoints: tuple[int, ...]
) -> None:
    """A wide synthetic face with fixed-height ink (int16 bounds hold at
    thousands of codepoints — the growing-ink fixture caps around 300)."""
    def box(x_min: int, y_min: int, x_max: int, y_max: int):
        pen = TTGlyphPen(None)
        pen.moveTo((x_min, y_min))
        pen.lineTo((x_max, y_min))
        pen.lineTo((x_max, y_max))
        pen.lineTo((x_min, y_max))
        pen.closePath()
        return pen.glyph()

    glyph_names = [".notdef"] + [f"uni{cp:04X}" for cp in codepoints]
    glyphs: dict[str, object] = {".notdef": box(0, 0, 500, 700)}
    glyphs.update({f"uni{cp:04X}": box(40, 0, 559, 700) for cp in codepoints})
    builder = FontBuilder(unitsPerEm=1000, isTTF=True)
    builder.setupGlyphOrder(glyph_names)
    builder.setupCharacterMap({cp: f"uni{cp:04X}" for cp in codepoints})
    builder.setupGlyf(glyphs)  # type: ignore[arg-type]
    builder.setupHorizontalMetrics({name: (600, 40) for name in glyph_names})
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWeightClass=weight)
    builder.setupNameTable({"familyName": family, "styleName": subfamily})
    builder.setupPost()
    builder.setupHead(
        unitsPerEm=1000, created=FIXED_TIMESTAMP, modified=FIXED_TIMESTAMP
    )
    builder.save(path)


@dataclass
class FaceSpec:
    """One face of a fixture family: file name, name-table identity."""

    file: str
    family: str  # the REAL name-table family (what documents must report)
    weight: int = 400
    subfamily: str = "Regular"
    codepoints: tuple[int, ...] = _LATIN
    wide: bool = False  # fixed-ink wide coverage (the timing fixture)


@dataclass
class CutSpec:
    """One cut of a fixture family: its variant string and faces."""

    variant: str
    faces: list[FaceSpec] = field(default_factory=list)
    axes: dict[str, str] = field(default_factory=dict)


@dataclass
class FamilySpec:
    """One fixture family: the cuts its manifest entries pin."""

    family: str
    cuts: list[CutSpec] = field(default_factory=list)
    suffix: str = ".zip"


@dataclass
class PickerSite:
    """A catalog-release origin whose families exercise the cut model."""

    origin_dir: Path
    families: list[FamilySpec]
    faces: dict[str, dict[str, bytes]] = field(default_factory=dict)

    @property
    def release_origin(self) -> str:
        return self.origin_dir.as_uri()

    def manifest_entries(self) -> list[dict[str, Any]]:
        """One manifest entry per cut, in family/cut order.

        The upstream archive names follow the real catalog's convention
        (the cut's own stem — `FakeKaiScreen.zip`, not a translated
        token; the plain/Regular member rides the family-named archive
        the way LxgwNeoXiHei does), and cut-discriminating axes ride the
        entries exactly the way the committed manifest encodes NF-vs-
        plain and screen cuts.
        """
        entries: list[dict[str, Any]] = []
        for spec in self.families:
            for cut in spec.cuts:
                stem = (
                    spec.family
                    if cut.variant in ("", "Regular")
                    else spec.family + cut.variant.replace(" ", "")
                )
                item = entry(
                    family=spec.family,
                    file=f"{stem}.zip",
                    url=(
                        "https://github.com/owner/"
                        f"{spec.family.lower()}/releases/v1/{stem}.zip"
                    ),
                    sha256="a" * 64,
                    variant=cut.variant,
                    rfn=False,
                )
                if cut.axes:
                    item["axes"] = dict(cut.axes)
                entries.append(item)
        return entries


def build_picker_site(root: Path, families: list[FamilySpec]) -> PickerSite:
    """Build a release origin with token-carrying face names.

    Every cut's faces ride ONE family zip (the round-20 release layout),
    so the document's variant-token partition — not the archive layout —
    decides which face belongs to which cut, exactly like the frontend
    model the endpoint succeeds.
    """
    origin_dir = root / "origin"
    origin_dir.mkdir(parents=True)
    site = PickerSite(origin_dir=origin_dir, families=families)
    release_families: list[dict[str, Any]] = []
    for spec in families:
        archive = origin_dir / f"{spec.family}{spec.suffix}"
        payload: dict[str, bytes] = {}
        with zipfile.ZipFile(archive, "w") as zf:
            for cut in spec.cuts:
                for face in cut.faces:
                    staged = root / f"{spec.family}-{face.file}"
                    if face.wide:
                        _wide_font(
                            staged,
                            family=face.family,
                            subfamily=face.subfamily,
                            weight=face.weight,
                            codepoints=face.codepoints,
                        )
                    else:
                        synth_font(
                            staged,
                            family=face.family,
                            codepoints=face.codepoints,
                            weight=face.weight,
                            subfamily=face.subfamily,
                        )
                    payload[face.file] = staged.read_bytes()
                    zf.writestr(f"{spec.family}/{face.file}", payload[face.file])
                    staged.unlink()
        site.faces[spec.family] = payload
        release_families.append(
            {
                "family": spec.family,
                "zip": archive.name,
                "sha256": _sha256_bytes(archive.read_bytes()),
                "files": [
                    {"file": name, "sha256": _sha256_bytes(data)}
                    for name, data in sorted(payload.items())
                ],
            }
        )
    (origin_dir / "catalog-release.json").write_text(
        json.dumps(
            {
                "schema": RELEASE_SCHEMA,
                "tag": TAG,
                "origins": [{"id": "primary", "base_url": origin_dir.as_uri()}],
                "families": release_families,
            },
            indent=1,
        )
        + "\n",
        encoding="utf-8",
    )
    return site


def write_site_manifest(root: Path, site: PickerSite) -> Path:
    """The manifest matching a picker site (one entry per cut)."""
    licenses = root / "licenses"
    licenses.mkdir(parents=True, exist_ok=True)
    (licenses / "OFL-1.1.txt").write_text(FAKE_OFL, encoding="utf-8")
    return write_manifest(root / "catalog.json", site.manifest_entries())


def picker_args(
    release_origin: str, catalog_dir: Path, work_dir: Path, manifest: Path | None
) -> list[str]:
    args = [
        "--port",
        "0",
        "--catalog-release-origin",
        release_origin,
        "--catalog-dir",
        str(catalog_dir),
        "--work-dir",
        str(work_dir),
    ]
    if manifest is not None:
        args += ["--manifest", str(manifest)]
    return args


def wait_for_scanned(client, family: str, timeout: float = 60.0) -> dict[str, Any]:
    """Poll /catalog/families until ``family``'s document is scanned."""
    deadline = time.monotonic() + timeout
    last: dict[str, Any] = {}
    while time.monotonic() < deadline:
        last = client.get("/catalog/families").json()
        for doc in last["families"]:
            if doc["family"] == family and doc["scanned"]:
                return doc
        time.sleep(0.02)
    raise TimeoutError(f"family {family} never scanned: {last}")


def cut_of(family_doc: dict[str, Any], variant: str) -> dict[str, Any]:
    for cut in family_doc["cuts"]:
        if cut["variant"] == variant:
            return cut
    raise KeyError(variant)


@pytest.fixture
def work_dir(tmp_path: Path) -> Path:
    work = tmp_path / "work"
    work.mkdir()
    return work


@pytest.fixture
def catalog_dir(tmp_path: Path) -> Path:
    return tmp_path / "catalog"


@pytest.fixture
def site(tmp_path: Path) -> PickerSite:
    """One family with two cuts: an NF cut and a plain cut."""
    return build_picker_site(
        tmp_path / "site",
        families=[
            FamilySpec(
                family="FakeCode",
                cuts=[
                    CutSpec(
                        variant="Nerd Font",
                        axes={"icons": "nf"},
                        faces=[
                            FaceSpec(
                                file="FakeCodeNerdFont-Regular.ttf",
                                family="FakeCode Nerd Font",
                            ),
                            FaceSpec(
                                file="FakeCodeNerdFont-Bold.ttf",
                                family="FakeCode Nerd Font",
                                weight=700,
                                subfamily="Bold",
                            ),
                        ],
                    ),
                    CutSpec(
                        variant="",
                        faces=[
                            FaceSpec(
                                file="FakeCode-Regular.ttf", family="FakeCode"
                            ),
                        ],
                    ),
                ],
            )
        ],
    )


@pytest.fixture
def manifest(tmp_path: Path, site: PickerSite) -> Path:
    return write_site_manifest(tmp_path / "site-manifest", site)


class TestFamiliesDocument:
    """GET /catalog/families — the successor of the variant/face-set model."""

    def test_an_empty_serve_lists_no_families(self, fontalloy_exe, work_dir, tmp_path):
        with running_service(
            fontalloy_exe, ["--port", "0", "--work-dir", str(work_dir)], cwd=tmp_path
        ) as (client, _):
            response = client.get("/catalog/families")
            assert response.status == 200
            assert response.json() == {"scanning": False, "families": []}

    def test_a_manifest_only_serve_lists_cuts_without_faces(
        self, fontalloy_exe, manifest, work_dir, tmp_path
    ):
        """No sync configured: the cut structure still renders (readiness
        says the catalog lifecycle is not active), and no face metadata
        exists to scan."""
        with running_service(
            fontalloy_exe,
            ["--port", "0", "--manifest", str(manifest), "--work-dir", str(work_dir)],
            cwd=tmp_path,
        ) as (client, _):
            doc = client.get("/catalog/families").json()
            assert doc["scanning"] is False
            families = {f["family"]: f for f in doc["families"]}
            assert set(families) == {"FakeCode"}
            family = families["FakeCode"]
            assert family["readiness"] == "unsynced"
            assert family["scanned"] is False
            assert family["display_name"] is None
            cuts = {c["variant"]: c for c in family["cuts"]}
            assert set(cuts) == {"Nerd Font", ""}
            assert cuts["Nerd Font"]["faces"] == []
            assert cuts[""]["faces"] == []

    def test_cut_model_ports_the_variant_axes_semantics(
        self, fontalloy_exe, catalog_dir, work_dir, tmp_path
    ):
        """The cut structure follows the frontend model: non-weight axes
        collapse multi-weight entries onto one cut whose canonical member
        prefers Regular, the default cut leads, and the data label is the
        release artifact's own stem."""
        wide = build_picker_site(
            tmp_path / "wide",
            families=[
                FamilySpec(
                    family="FakeKai",
                    cuts=[
                        CutSpec(
                            variant="Light",
                            faces=[
                                FaceSpec(
                                    file="FakeKaiLight-Regular.ttf",
                                    family="FakeKai Light",
                                )
                            ],
                        ),
                        CutSpec(
                            variant="Regular",
                            faces=[
                                FaceSpec(
                                    file="FakeKai-Regular.ttf", family="FakeKai"
                                )
                            ],
                        ),
                        CutSpec(
                            variant="Medium",
                            faces=[
                                FaceSpec(
                                    file="FakeKaiMedium-Regular.ttf",
                                    family="FakeKai Medium",
                                    weight=500,
                                )
                            ],
                        ),
                        CutSpec(
                            variant="Screen",
                            axes={"rendering": "screen"},
                            faces=[
                                FaceSpec(
                                    file="FakeKaiScreen-Regular.ttf",
                                    family="FakeKai Screen",
                                )
                            ],
                        ),
                    ],
                )
            ],
        )
        wide_manifest = write_site_manifest(tmp_path / "wide-manifest", wide)
        with running_service(
            fontalloy_exe,
            picker_args(wide.release_origin, catalog_dir, work_dir, wide_manifest),
            cwd=tmp_path,
        ) as (client, _):
            assert wait_for_terminal(client)["state"] == "ready"
            family = wait_for_scanned(client, "FakeKai")
            # Light/Medium/Regular collapse onto ONE cut (weight is data,
            # not a chip); Screen stays its own cut.
            assert [cut["variant"] for cut in family["cuts"]] == [
                "Regular",
                "Screen",
            ]
            regular = family["cuts"][0]
            assert regular["def"] is True
            assert family["cuts"][1]["def"] is False
            # The collapsed cut pools every weight's faces.
            assert sorted(face["file"] for face in regular["faces"]) == [
                "FakeKai-Regular.ttf",
                "FakeKaiLight-Regular.ttf",
                "FakeKaiMedium-Regular.ttf",
            ]
            # The label is the artifact stem, not a translated token.
            assert regular["label"] == "FakeKai"
            assert family["cuts"][1]["label"] == "FakeKaiScreen"

    def test_documents_carry_real_name_table_metadata(
        self, fontalloy_exe, site, manifest, catalog_dir, work_dir, tmp_path
    ):
        """After the sync lands, the documents carry what only the REAL
        name tables know: display names, weights, styles, coverage
        summaries, placeholder flags — and per-family readiness."""
        with running_service(
            fontalloy_exe,
            picker_args(site.release_origin, catalog_dir, work_dir, manifest),
            cwd=tmp_path,
        ) as (client, _):
            assert wait_for_terminal(client)["state"] == "ready"
            family = wait_for_scanned(client, "FakeCode")
            assert family["readiness"] == "done"
            assert family["display_name"] == "FakeCode"  # the default cut's own name
            assert family["display_names"] == ["FakeCode", "FakeCode Nerd Font"]
            assert family["preview"] == "/catalog/families/FakeCode/preview"

            nf = cut_of(family, "Nerd Font")
            assert nf["display_name"] == "FakeCode Nerd Font"
            assert nf["representative"] == "FakeCodeNerdFont-Regular.ttf"
            faces = {face["file"]: face for face in nf["faces"]}
            assert set(faces) == {
                "FakeCodeNerdFont-Regular.ttf",
                "FakeCodeNerdFont-Bold.ttf",
            }
            regular = faces["FakeCodeNerdFont-Regular.ttf"]
            assert regular["family"] == "FakeCode Nerd Font"
            assert regular["subfamily"] == "Regular"
            assert regular["weight"] == 400
            assert regular["italic"] is False
            assert regular["variable"] is False
            assert regular["placeholder"] is False
            assert regular["coverage"]["codepoints"] == len(_LATIN)
            assert regular["coverage"]["placeholders"] == 0
            assert regular["coverage"]["latin"] is True
            assert regular["coverage"]["cjk"] is False
            # Ticket #36: the counters' data — run-length intervals of
            # the honest coverage (the fixture's Latin run is ONE run).
            assert regular["coverage"]["intervals"] == [
                [min(_LATIN), max(_LATIN)]
            ]
            assert regular["coverage"]["placeholder_intervals"] == []
            # The face sha is the release document's pinned checksum.
            assert regular["sha256"] == _sha256_bytes(
                site.faces["FakeCode"]["FakeCodeNerdFont-Regular.ttf"]
            )
            assert regular["href"] == (
                "/catalog/faces/FakeCode/FakeCodeNerdFont-Regular.ttf"
            )
            # The plain cut keeps ONLY the plain faces (the token
            # partition, in both directions).
            plain = cut_of(family, "")
            assert [face["file"] for face in plain["faces"]] == [
                "FakeCode-Regular.ttf"
            ]

    def test_placeholder_faces_are_flagged(
        self, fontalloy_exe, catalog_dir, work_dir, tmp_path
    ):
        """A face faking coverage the placeholder way carries the flag
        and the honest codepoint count (placeholder mappings are not
        coverage — not for the count, not for the cjk marker)."""
        site = build_picker_site(
            tmp_path / "site",
            families=[
                FamilySpec(
                    family="FakeTox",
                    cuts=[
                        CutSpec(
                            variant="",
                            faces=[
                                FaceSpec(
                                    file="FakeTox-Regular.ttf",
                                    family="FakeTox",
                                    codepoints=(0x41, 0x42),
                                )
                            ],
                        )
                    ],
                )
            ],
        )
        # Rewrite the one face as a placeholder font (the site builder
        # writes clean synths; the placeholder shape needs its own tool).
        staged = tmp_path / "tox.ttf"
        synth_placeholder_font(
            staged,
            family="FakeTox",
            codepoints=(0x41, 0x42),
            placeholder_codepoints=tuple(range(0x4E00, 0x4E00 + 100)),
        )
        archive = site.origin_dir / "FakeTox.zip"
        with zipfile.ZipFile(archive, "w") as zf:
            zf.writestr("FakeTox/FakeTox-Regular.ttf", staged.read_bytes())
        site.faces["FakeTox"]["FakeTox-Regular.ttf"] = staged.read_bytes()
        document = json.loads(
            (site.origin_dir / "catalog-release.json").read_text(encoding="utf-8")
        )
        for family in document["families"]:
            assert family["family"] == "FakeTox"
            family["sha256"] = _sha256_bytes(archive.read_bytes())
            family["files"] = [
                {
                    "file": "FakeTox-Regular.ttf",
                    "sha256": _sha256_bytes(staged.read_bytes()),
                }
            ]
        (site.origin_dir / "catalog-release.json").write_text(
            json.dumps(document, indent=1), encoding="utf-8"
        )
        manifest = write_site_manifest(tmp_path / "m", site)
        with running_service(
            fontalloy_exe,
            picker_args(site.release_origin, catalog_dir, work_dir, manifest),
            cwd=tmp_path,
        ) as (client, _):
            assert wait_for_terminal(client)["state"] == "ready"
            family = wait_for_scanned(client, "FakeTox")
            face = family["cuts"][0]["faces"][0]
            assert face["placeholder"] is True
            assert face["coverage"]["codepoints"] == 2
            assert face["coverage"]["placeholders"] == 100
            assert face["coverage"]["cjk"] is False

    def test_health_and_the_listing_answer_while_documents_build(
        self, fontalloy_exe, site, manifest, catalog_dir, work_dir, tmp_path
    ):
        """The document builder runs on its own thread: with the
        per-family yield stretched, /health and /catalog/families answer
        well inside a build, and the snapshot never blocks on a scan."""
        os.environ[DOCS_DELAY_ENV] = "0.3"
        try:
            with running_service(
                fontalloy_exe,
                picker_args(site.release_origin, catalog_dir, work_dir, manifest),
                cwd=tmp_path,
            ) as (client, _):
                saw_scanning = False
                deadline = time.monotonic() + 30
                while time.monotonic() < deadline:
                    started = time.monotonic()
                    doc = client.get("/catalog/families").json()
                    elapsed = time.monotonic() - started
                    assert elapsed < 1.0, (
                        f"/catalog/families took {elapsed:.2f}s mid-build"
                    )
                    if doc["scanning"]:
                        saw_scanning = True
                        started = time.monotonic()
                        assert client.get("/health").json()["service"] == (
                            "fontalloy"
                        )
                        assert time.monotonic() - started < 1.0
                    if not doc["scanning"] and doc["families"] and all(
                        family["scanned"] for family in doc["families"]
                    ):
                        break
                    time.sleep(0.02)
                assert saw_scanning, "the build finished before any poll saw it run"
        finally:
            os.environ.pop(DOCS_DELAY_ENV, None)


class TestFaceBytes:
    """GET /catalog/faces/{family}/{file} — streamed bytes + cache truth."""

    def test_serves_the_exact_face_bytes_with_cache_headers(
        self, fontalloy_exe, site, manifest, catalog_dir, work_dir, tmp_path
    ):
        with running_service(
            fontalloy_exe,
            picker_args(site.release_origin, catalog_dir, work_dir, manifest),
            cwd=tmp_path,
        ) as (client, _):
            assert wait_for_terminal(client)["state"] == "ready"
            wait_for_scanned(client, "FakeCode")
            path = "/catalog/faces/FakeCode/FakeCodeNerdFont-Regular.ttf"
            response = client.get(path)
            assert response.status == 200
            payload = site.faces["FakeCode"]["FakeCodeNerdFont-Regular.ttf"]
            assert response.data == payload
            assert response.headers.get("Content-Type") == "font/ttf"
            assert response.headers.get("Content-Length") == str(len(payload))
            assert "immutable" in response.headers.get("Cache-Control", "")
            assert response.headers.get("ETag") == f'"{_sha256_bytes(payload)}"'

            # A matching If-None-Match revalidates to 304 (no body).
            response = client.get(
                path, headers={"If-None-Match": f'"{_sha256_bytes(payload)}"'}
            )
            assert response.status == 304
            assert response.data == b""

    def test_unknown_faces_and_traversal_are_refused(
        self, fontalloy_exe, site, manifest, catalog_dir, work_dir, tmp_path
    ):
        with running_service(
            fontalloy_exe,
            picker_args(site.release_origin, catalog_dir, work_dir, manifest),
            cwd=tmp_path,
        ) as (client, _):
            assert wait_for_terminal(client)["state"] == "ready"
            wait_for_scanned(client, "FakeCode")
            assert client.get("/catalog/faces/FakeCode/nope.ttf").status == 404
            assert client.get("/catalog/faces/Nope/x.ttf").status == 404
            # Only release-listed faces serve — never a general file reader.
            assert client.get("/catalog/faces/FakeCode/release.json").status == 404
            assert client.get("/catalog/faces/../../etc/passwd").status == 404


class TestPreviewSubset:
    """GET /catalog/families/{family}/preview — self-rendering picker rows."""

    def test_the_subset_loads_and_carries_the_name_codepoints(
        self, fontalloy_exe, site, manifest, catalog_dir, work_dir, tmp_path
    ):
        with running_service(
            fontalloy_exe,
            picker_args(site.release_origin, catalog_dir, work_dir, manifest),
            cwd=tmp_path,
        ) as (client, _):
            assert wait_for_terminal(client)["state"] == "ready"
            wait_for_scanned(client, "FakeCode")
            response = client.get("/catalog/families/FakeCode/preview")
            assert response.status == 200
            assert response.headers.get("Content-Type") == "font/ttf"
            assert "immutable" in response.headers.get("Cache-Control", "")
            assert response.headers.get("ETag")
            # A valid font a FontFace can load: parses, plain ttf flavor.
            font = TTFont(io.BytesIO(response.data))
            assert font.flavor is None
            cmap = font.getBestCmap()
            for name in ("FakeCode", "FakeCode Nerd Font"):
                needed = {ord(ch) for ch in name if not ch.isspace()}
                assert needed <= set(cmap), (
                    f"preview subset lacks glyphs for {name!r}"
                )
            # Tiny: a subset, never the face itself.
            full = site.faces["FakeCode"]["FakeCodeNerdFont-Regular.ttf"]
            assert len(response.data) < len(full)
            # Disk-cached under the catalog directory.
            previews = list((catalog_dir / "previews").glob("*.ttf"))
            assert previews, "no preview subset was disk-cached"

    def test_the_disk_cache_is_served_not_regenerated(
        self, fontalloy_exe, site, manifest, catalog_dir, work_dir, tmp_path
    ):
        """A cached subset is served as-is (the picker must not pay the
        subsetting cost twice); the cache key is the names + source, so
        name changes regenerate instead of serving stale glyphs."""
        with running_service(
            fontalloy_exe,
            picker_args(site.release_origin, catalog_dir, work_dir, manifest),
            cwd=tmp_path,
        ) as (client, _):
            assert wait_for_terminal(client)["state"] == "ready"
            wait_for_scanned(client, "FakeCode")
            first = client.get("/catalog/families/FakeCode/preview")
            assert first.status == 200
            # Poison the cached artifact: the next request must serve the
            # cache (proving the disk cache is real), and the key embeds
            # the names so a name change can never hit the poisoned entry.
            cached = next((catalog_dir / "previews").glob("*.ttf"))
            cached.write_bytes(b"poisoned cache bytes")
            second = client.get("/catalog/families/FakeCode/preview")
            assert second.data == b"poisoned cache bytes"

    def test_families_without_synced_faces_have_no_preview(
        self, fontalloy_exe, manifest, work_dir, tmp_path
    ):
        with running_service(
            fontalloy_exe,
            ["--port", "0", "--manifest", str(manifest), "--work-dir", str(work_dir)],
            cwd=tmp_path,
        ) as (client, _):
            response = client.get("/catalog/families/FakeCode/preview")
            assert response.status == 404
            assert "error" in response.json()


class TestStars:
    """GET /catalog/stars — launch-cached, offline-tolerant."""

    @staticmethod
    def stars_api_tree(root: Path, repos: dict[str, int]) -> str:
        """A file:// stand-in for api.github.com: <base>/repos/<repo>."""
        for repo, stars in repos.items():
            target = root / "repos" / repo
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(
                json.dumps({"stargazers_count": stars}), encoding="utf-8"
            )
        return root.as_uri()

    def test_launch_cached_stars_map_repos_to_families(
        self, fontalloy_exe, site, manifest, catalog_dir, work_dir, tmp_path
    ):
        api = self.stars_api_tree(tmp_path / "stars-api", {"owner/fakecode": 4242})
        os.environ[STARS_API_ENV] = api
        try:
            with running_service(
                fontalloy_exe,
                picker_args(site.release_origin, catalog_dir, work_dir, manifest),
                cwd=tmp_path,
            ) as (client, _):
                deadline = time.monotonic() + 30
                doc: dict[str, Any] = {}
                while time.monotonic() < deadline:
                    response = client.get("/catalog/stars")
                    assert response.status == 200  # never an error state
                    doc = response.json()
                    if doc["state"] == "done":
                        break
                    time.sleep(0.02)
                assert doc["state"] == "done"
                assert doc["stars"] == {"FakeCode": 4242}
        finally:
            os.environ.pop(STARS_API_ENV, None)

    def test_offline_is_empty_never_an_error(
        self, fontalloy_exe, site, manifest, catalog_dir, work_dir, tmp_path
    ):
        os.environ[STARS_API_ENV] = (tmp_path / "nowhere").as_uri()
        try:
            with running_service(
                fontalloy_exe,
                picker_args(site.release_origin, catalog_dir, work_dir, manifest),
                cwd=tmp_path,
            ) as (client, _):
                deadline = time.monotonic() + 30
                doc: dict[str, Any] = {}
                while time.monotonic() < deadline:
                    response = client.get("/catalog/stars")
                    assert response.status == 200
                    doc = response.json()
                    if doc["state"] == "done":
                        break
                    time.sleep(0.02)
                assert doc["state"] == "done"
                assert doc["stars"] == {}
        finally:
            os.environ.pop(STARS_API_ENV, None)

    def test_a_serve_without_a_manifest_has_no_stars_to_fetch(
        self, fontalloy_exe, work_dir, tmp_path
    ):
        with running_service(
            fontalloy_exe, ["--port", "0", "--work-dir", str(work_dir)], cwd=tmp_path
        ) as (client, _):
            response = client.get("/catalog/stars")
            assert response.status == 200
            assert response.json() == {"state": "disabled", "stars": {}}


class TestWorstFixtureTiming:
    """The measured cost of the worst fixture (reported, then pinned)."""

    def test_document_build_and_handler_latency_for_the_worst_fixture(
        self, fontalloy_exe, catalog_dir, work_dir, tmp_path
    ):
        """A 6-face family of 3,000-codepoint faces (the wide end of the
        shipped catalog's per-family scale, at test speed): the document
        build is measured and reported, and the served snapshot after the
        build answers well inside the responsiveness budget — the scan
        never rides a request handler."""
        faces = [
            FaceSpec(
                file=f"Worst-{name}.ttf",
                family="WorstFamily",
                weight=weight,
                subfamily=name,
                codepoints=_LATIN + tuple(range(0x4E00, 0x4E00 + 3000)),
                wide=True,
            )
            for name, weight in (
                ("Light", 300),
                ("Regular", 400),
                ("Medium", 500),
                ("SemiBold", 600),
                ("Bold", 700),
                ("Black", 900),
            )
        ]
        site = build_picker_site(
            tmp_path / "site",
            families=[
                FamilySpec(family="Worst", cuts=[CutSpec(variant="", faces=faces)])
            ],
        )
        manifest = write_site_manifest(tmp_path / "m", site)
        with running_service(
            fontalloy_exe,
            picker_args(site.release_origin, catalog_dir, work_dir, manifest),
            cwd=tmp_path,
        ) as (client, _):
            assert wait_for_terminal(client)["state"] == "ready"
            started = time.monotonic()
            family = wait_for_scanned(client, "Worst")
            build_seconds = time.monotonic() - started
            print(
                f"\nworst-fixture document build: {build_seconds:.2f}s "
                f"for {len(faces)} faces x 3000 codepoints"
            )
            assert len(family["cuts"][0]["faces"]) == 6

            started = time.monotonic()
            doc = client.get("/catalog/families").json()
            elapsed = time.monotonic() - started
            assert elapsed < 1.0, f"/catalog/families took {elapsed:.2f}s cached"
            started = time.monotonic()
            preview = client.get("/catalog/families/Worst/preview")
            elapsed = time.monotonic() - started
            assert elapsed < 5.0, f"preview took {elapsed:.2f}s"
            assert preview.status == 200
