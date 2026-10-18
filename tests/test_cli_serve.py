"""Seam 2 tests: ``fontalloy serve`` — the localhost HTTP contract.

Per the testing decisions in issue #1, the service is exercised exactly
the way its consumers (the GUI sidecar and the WebApp) see it: the real
``fontalloy`` executable runs as a subprocess on an ephemeral 127.0.0.1
port, and every assertion goes over real HTTP — binding, CORS
(including preflight from an allowed AND a disallowed origin), catalog
and local-font enumeration, merge submission, progress polling, and
artifact download.
"""

from __future__ import annotations

import io
import json
import os
import re
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

from conftest import (  # noqa: F401
    FIXED_TIMESTAMP,
    fontalloy_exe,
    synth_font,
    synth_ttc,
)
from fontalloy_core import serve as fontalloy_core_serve
from test_cli_assets import FAKE_OFL, entry, write_manifest

#: The one origin the shared service allows — every CORS test plays
#: against it (allowed) and against everything else (disallowed).
ALLOWED_ORIGIN = "http://webapp.example"
DISALLOWED_ORIGIN = "http://evil.example"

#: The stdout line the GUI/JS parses to learn the port (tauri-sidecar
#: notes: port 0 = OS-assigned, read it from stdout).
READY_LINE_RE = re.compile(r"^http://127\.0\.0\.1:(\d+)\s*$")

#: A big-enough donor that a real build takes a visible moment, so
#: queued/running states are observable instead of racy. The shared
#: ``synth_font`` fixture grows ink per codepoint (int16 yMax caps it
#: around 300 glyphs), so the wide variant uses fixed-height boxes.
SLOW_DONOR_CODEPOINTS = 4000

#: A donor wide enough that cancellation lands mid-graft deterministically
#: (the poll sees the grafting stage with a comfortable window).
CANCEL_DONOR_CODEPOINTS = 30_000


def synth_wide_font(path: Path, *, family: str, count: int) -> Path:
    """Write a synthetic TTF covering ``count`` CJK codepoints, fixed ink."""
    codepoints = tuple(range(0x4E00, 0x4E00 + count))

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
    glyphs.update(
        {f"uni{cp:04X}": box(40, 0, 559, 700) for cp in codepoints}
    )
    builder = FontBuilder(unitsPerEm=1000, isTTF=True)
    builder.setupGlyphOrder(glyph_names)
    builder.setupCharacterMap({cp: f"uni{cp:04X}" for cp in codepoints})
    builder.setupGlyf(glyphs)  # type: ignore[arg-type]
    builder.setupHorizontalMetrics({name: (600, 40) for name in glyph_names})
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWeightClass=400)
    builder.setupNameTable({"familyName": family, "styleName": "Regular"})
    builder.setupPost()
    builder.setupHead(
        unitsPerEm=1000, created=FIXED_TIMESTAMP, modified=FIXED_TIMESTAMP
    )
    builder.save(path)
    return Path(path)


class Response:
    """One HTTP response, kept raw so headers stay assertable."""

    def __init__(self, status: int, headers: Any, data: bytes):
        self.status = status
        self.headers = headers
        self.data = data

    def json(self) -> Any:
        return json.loads(self.data.decode("utf-8"))


class ServeClient:
    """A tiny stdlib HTTP client for one running service."""

    def __init__(self, port: int, origin: str | None = None):
        self.base = f"http://127.0.0.1:{port}"
        self.origin = origin

    def request(
        self,
        method: str,
        path: str,
        *,
        body: Any = None,
        raw: bytes | None = None,
        headers: dict[str, str] | None = None,
        timeout: float = 30.0,
    ) -> Response:
        data = None
        request_headers = dict(headers or {})
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            request_headers.setdefault("Content-Type", "application/json")
        elif raw is not None:
            data = raw  # the upload contract: exact bytes, no JSON layer
        if self.origin is not None:
            request_headers.setdefault("Origin", self.origin)
        request = urllib.request.Request(
            self.base + path, data=data, headers=request_headers, method=method
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return Response(
                    response.status, response.headers, response.read()
                )
        except urllib.error.HTTPError as exc:
            return Response(exc.status, exc.headers, exc.read())

    def get(self, path: str, **kwargs: Any) -> Response:
        return self.request("GET", path, **kwargs)

    def post(self, path: str, body: Any, **kwargs: Any) -> Response:
        return self.request("POST", path, body=body, **kwargs)

    def post_raw(
        self,
        path: str,
        payload: bytes,
        headers: dict[str, str] | None = None,
        **kwargs: Any,
    ) -> Response:
        """POST raw bytes (the file-upload contract — never JSON)."""
        return self.request(
            "POST", path, raw=payload, headers=headers, **kwargs
        )

    def preflight(self, path: str, origin: str) -> Response:
        return self.request(
            "OPTIONS",
            path,
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "Content-Type",
            },
        )

    def submit(self, recipe: dict[str, Any]) -> Response:
        return self.post("/builds", recipe)

    def wait_for_status(
        self, build_id: str, status: str, timeout: float = 60.0
    ) -> dict[str, Any]:
        """Poll a build's status document until it reaches ``status``."""
        deadline = time.monotonic() + timeout
        last: dict[str, Any] = {}
        while time.monotonic() < deadline:
            response = self.get(f"/builds/{build_id}")
            assert response.status == 200, response.data
            last = response.json()
            if last["status"] == status:
                return last
            if status != "failed" and last["status"] == "failed":
                raise AssertionError(f"build failed: {last.get('error')}")
            time.sleep(0.02)
        raise TimeoutError(f"build {build_id} never reached {status!r}: {last}")


def _spawn_service(exe: Path, args: list[str], cwd: Path) -> subprocess.Popen:
    """Spawn ``fontalloy serve`` with stdout piped, ready for the line."""
    popen_kwargs: dict[str, Any] = {}
    if os.name == "nt":
        # A new process group lets the shutdown test deliver
        # CTRL_BREAK_EVENT without signaling the test runner itself.
        popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    return subprocess.Popen(
        [str(exe), "serve", *args],
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        **popen_kwargs,
    )


@contextmanager
def running_service(
    exe: Path, args: list[str], cwd: Path
) -> Iterator[tuple[ServeClient, subprocess.Popen[str]]]:
    """Run the service until the block exits; fail loudly on early death."""
    process = _spawn_service(exe, args, cwd)
    ready = process.stdout.readline() if process.stdout else ""
    if not READY_LINE_RE.match(ready.strip()):
        process.kill()
        _, stderr = process.communicate(timeout=10)
        raise AssertionError(
            f"serve did not print a 127.0.0.1 ready line: {ready!r} "
            f"(stderr: {stderr[-2000:]})"
        )
    port = int(READY_LINE_RE.match(ready.strip()).group(1))
    try:
        yield ServeClient(port), process
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)


@pytest.fixture(scope="module")
def serve_exe() -> Path:
    """The installed console script (module-scoped, like the service)."""
    name = "fontalloy.exe" if os.name == "nt" else "fontalloy"
    exe = Path(sys.executable).parent / name
    assert exe.is_file(), f"the fontalloy executable is not installed: {exe}"
    return exe


@pytest.fixture(scope="module")
def serve_root(tmp_path_factory: Any) -> Path:
    """Shared scratch tree: the manifest, the font directory, the work dir."""
    return tmp_path_factory.mktemp("serve")


@pytest.fixture(scope="module")
def serve_fonts(serve_root: Path) -> Path:
    """Local fonts the /fonts endpoint enumerates: two families, one TTC."""
    fonts = serve_root / "fonts"
    fonts.mkdir()
    synth_font(
        fonts / "Alpha.ttf", family="ServeAlpha", codepoints=(0x41, 0x42)
    )
    synth_font(
        fonts / "Beta.ttf",
        family="ServeBeta",
        codepoints=(0x61, 0x62),
        weight=700,
    )
    synth_ttc(
        fonts / "Gamma.ttc",
        faces=[
            {"family": "ServeGamma", "codepoints": (0x30, 0x31), "weight": 400},
            {"family": "ServeGamma", "codepoints": (0x30, 0x31), "weight": 700},
        ],
    )
    return fonts


@pytest.fixture(scope="module")
def serve_manifest(serve_root: Path, serve_fonts: Path) -> Path:
    """A tiny valid catalog manifest beside its license file."""
    licenses = serve_root / "licenses"
    licenses.mkdir(exist_ok=True)
    (licenses / "OFL-1.1.txt").write_text(FAKE_OFL, encoding="utf-8")
    return write_manifest(
        serve_root / "catalog.json",
        [
            entry(
                family="FakeCode",
                file="FakeCode.zip",
                url="https://example.com/FakeCode.zip",
                sha256="0" * 64,
            ),
            entry(
                family="FakeCJK",
                file="FakeCJK.ttf",
                url="https://example.com/FakeCJK.ttf",
                sha256="1" * 64,
                variant="",
                rfn=False,
            ),
        ],
    )


@pytest.fixture(scope="module")
def serve_work_dir(serve_root: Path) -> Path:
    work = serve_root / "work"
    work.mkdir()
    return work


@pytest.fixture(scope="module")
def serve_service(
    serve_exe: Path,
    serve_root: Path,
    serve_fonts: Path,
    serve_manifest: Path,
    serve_work_dir: Path,
) -> Iterator[ServeClient]:
    """The long-lived shared service every non-shutdown test talks to."""
    with running_service(
        serve_exe,
        [
            "--port",
            "0",
            "--allow-origin",
            ALLOWED_ORIGIN,
            "--manifest",
            str(serve_manifest),
            "--font-dir",
            str(serve_fonts),
            "--work-dir",
            str(serve_work_dir),
        ],
        cwd=serve_root,
    ) as (client, _process):
        yield client


@pytest.fixture
def build_recipe_json(tmp_path: Path, serve_fonts: Path) -> dict[str, Any]:
    """A submittable recipe: the base and donor from the font directory.

    The donor sits at 700 against the base's 400, so the no-selection
    weight union (issue #27) would request two slots and the default
    single-face ttf output refuses. These suites exercise the build
    lifecycle, not the matrix, so the recipe pins the base's own weight.
    """
    return {
        "base": str(serve_fonts / "Alpha.ttf"),
        "donors": [str(serve_fonts / "Beta.ttf")],
        "weights": [{"weight": 400}],
    }


class TestBinding:
    """127.0.0.1 only — the service never binds another interface."""

    def test_health_reports_the_loopback_address(self, serve_service):
        doc = serve_service.get("/health").json()
        assert doc["address"] == "127.0.0.1"
        assert doc["port"] > 0
        assert doc["service"] == "fontalloy"

    def test_requests_answer_only_on_loopback(self, serve_service):
        port = int(serve_service.base.rsplit(":", 1)[1])
        listening = _listening_local_addresses(port)
        if listening is None:
            pytest.skip("cannot read the host's listener table on this platform")
        # Positive evidence straight from the OS: the service's port is
        # in LISTEN state on 127.0.0.1 and on nothing else.
        assert listening == {"127.0.0.1"}

    def test_no_host_flag_exists(self, serve_exe, tmp_path):
        from conftest import run_cli

        result = run_cli(serve_exe, "serve", "--help", cwd=tmp_path)
        assert result.returncode == 0, result.stderr
        assert "--host" not in result.stdout
        for line in result.stdout.splitlines():
            assert "0.0.0.0" not in line


def _listening_local_addresses(port: int) -> set[str] | None:
    """Every local address the OS shows LISTENing on ``port``, or None.

    Reads the OS listener table rather than probing with connections
    (a firewall makes connection probes inconclusive). Windows: parse
    ``netstat -an``. Linux: parse /proc/net/tcp. Anything else or any
    parse trouble yields None so the caller skips instead of guessing.
    """
    if os.name == "nt":
        try:
            table = subprocess.run(
                ["netstat", "-an", "-p", "tcp"],
                capture_output=True,
                text=True,
                timeout=15,
                check=True,
            ).stdout
        except (OSError, subprocess.SubprocessError):
            return None
        addresses = set()
        for line in table.splitlines():
            fields = line.split()
            if len(fields) >= 4 and fields[3] == "LISTENING":
                local = fields[1]
                if local.rsplit(":", 1)[1] == str(port):
                    addresses.add(local.rsplit(":", 1)[0])
        return addresses or None
    if sys.platform.startswith("linux"):
        try:
            rows = Path("/proc/net/tcp").read_text(encoding="ascii")
        except OSError:
            return None
        addresses = set()
        for line in rows.splitlines()[1:]:
            fields = line.split()
            if len(fields) < 4 or fields[3] != "0A":  # 0A = LISTEN
                continue
            local_hex, _, local_port = fields[1].rpartition(":")
            if int(local_port, 16) != port:
                continue
            # /proc gives little-endian 32-bit hex: reverse each 16-bit word.
            raw = bytes.fromhex(local_hex)
            address = ".".join(str(byte) for byte in raw[::-1])
            addresses.add(address)
        return addresses or None
    return None


class TestCors:
    """CORS allows only the configured origin — preflights included."""

    def test_preflight_from_the_allowed_origin_succeeds(self, serve_service):
        response = serve_service.preflight("/builds", ALLOWED_ORIGIN)
        assert response.status in (200, 204)
        assert response.headers.get("Access-Control-Allow-Origin") == (
            ALLOWED_ORIGIN
        )
        assert "POST" in response.headers.get(
            "Access-Control-Allow-Methods", ""
        )

    def test_preflight_from_a_disallowed_origin_is_rejected(
        self, serve_service
    ):
        response = serve_service.preflight("/builds", DISALLOWED_ORIGIN)
        assert response.status == 403
        assert response.headers.get("Access-Control-Allow-Origin") is None

    def test_allowed_origin_is_echoed_on_simple_requests(self, serve_service):
        response = serve_service.get(
            "/health", headers={"Origin": ALLOWED_ORIGIN}
        )
        assert response.status == 200
        assert response.headers.get("Access-Control-Allow-Origin") == (
            ALLOWED_ORIGIN
        )

    def test_disallowed_origin_gets_no_cors_headers(self, serve_service):
        # The request itself is served (CORS is browser mediation, not
        # access control) but carries no ACAO, so a browser cannot read it.
        response = serve_service.get(
            "/health", headers={"Origin": DISALLOWED_ORIGIN}
        )
        assert response.status == 200
        assert response.headers.get("Access-Control-Allow-Origin") is None

    def test_artifact_download_carries_cors_headers(
        self, serve_service, build_recipe_json
    ):
        submitted = serve_service.submit(build_recipe_json)
        build_id = submitted.json()["id"]
        serve_service.wait_for_status(build_id, "done")
        response = serve_service.get(
            f"/builds/{build_id}/font", headers={"Origin": ALLOWED_ORIGIN}
        )
        assert response.status == 200
        assert response.headers.get("Access-Control-Allow-Origin") == (
            ALLOWED_ORIGIN
        )


class TestCatalog:
    def test_enumerates_manifest_families(self, serve_service):
        doc = serve_service.get("/catalog").json()
        families = {family["family"]: family for family in doc["families"]}
        assert set(families) == {"FakeCode", "FakeCJK"}

        fake_code = families["FakeCode"]
        variant = fake_code["variants"][0]
        assert variant["variant"] == "Nerd Font"
        assert variant["license_spdx"] == "OFL-1.1-RFN"
        assert variant["rfn"] is True
        assert variant["sha256"] == "0" * 64

        fake_cjk = families["FakeCJK"]
        assert fake_cjk["variants"][0]["rfn"] is False


class TestLocalFonts:
    def test_enumerates_local_directories_by_family(self, serve_service):
        doc = serve_service.get("/fonts").json()
        families = {family["name"]: family for family in doc["families"]}
        assert set(families) == {"ServeAlpha", "ServeBeta", "ServeGamma"}

        alpha = families["ServeAlpha"]
        assert alpha["faces"][0]["weight"] == 400
        assert alpha["faces"][0]["subfamily"] == "Regular"

        # A TTC contributes one face per collection face.
        gamma_weights = sorted(
            face["weight"] for face in families["ServeGamma"]["faces"]
        )
        assert gamma_weights == [400, 700]

    def test_enumerates_one_level_of_extracted_family_dirs(
        self, serve_exe, serve_manifest, tmp_path
    ):
        """Round 14: the fetched-catalog layout lists its nested faces.

        The layout every real consumer points ``--font-dir`` at nests
        font files one level down — the fetched catalog's extracted
        ``<fonts>/<archive stem>/`` faces, the Tauri shell's per-family
        ``catalog/families/<Family>/`` storage. A flat ``glob("*")``
        listed none of them, so the GUI's weight-slot selection had no
        face data for family picks; the scan descends exactly one
        level (deeper trees stay unlisted).
        """
        fonts = tmp_path / "fonts"
        extracted = fonts / "JetBrainsMono"
        extracted.mkdir(parents=True)
        synth_font(
            extracted / "JetBrainsMonoNerdFont-Regular.ttf",
            family="JetBrainsMono Nerd Font",
            codepoints=(0x41,),
        )
        synth_font(
            extracted / "JetBrainsMonoNerdFont-Bold.ttf",
            family="JetBrainsMono Nerd Font",
            codepoints=(0x41,),
            weight=700,
        )
        # Two levels down: outside the bounded descent.
        deep = extracted / "licenses"
        deep.mkdir()
        synth_font(
            deep / "Stray.ttf", family="Stray", codepoints=(0x41,)
        )
        work = tmp_path / "work"
        work.mkdir()
        with running_service(
            serve_exe,
            [
                "--port",
                "0",
                "--manifest",
                str(serve_manifest),
                "--font-dir",
                str(fonts),
                "--work-dir",
                str(work),
            ],
            cwd=tmp_path,
        ) as (client, _process):
            families = {
                family["name"]: family
                for family in client.get("/fonts").json()["families"]
            }
            assert set(families) == {"JetBrainsMono Nerd Font"}
            weights = sorted(
                face["weight"] for face in families["JetBrainsMono Nerd Font"]["faces"]
            )
            assert weights == [400, 700]


class TestBuildLifecycle:
    def test_submit_poll_and_download(self, serve_service, build_recipe_json):
        submitted = serve_service.submit(build_recipe_json)
        assert submitted.status == 202
        doc = submitted.json()
        assert doc["status"] == "queued"
        build_id = doc["id"]

        done = serve_service.wait_for_status(build_id, "done")
        assert done["stage"] == "done"
        assert done["error"] is None
        assert done["font"]["filename"] == "ChHsich.ttf"
        assert len(done["font"]["sha256"]) == 64
        assert done["report"]["filename"] == "ChHsich.report.json"

        font = serve_service.get(f"/builds/{build_id}/font")
        assert font.status == 200
        assert font.headers.get("Content-Type") == "font/ttf"
        assert "attachment" in font.headers.get("Content-Disposition", "")
        merged = TTFont(io.BytesIO(font.data))
        assert set(merged.getBestCmap()) == {0x41, 0x42, 0x61, 0x62}

        report = serve_service.get(f"/builds/{build_id}/report")
        assert report.status == 200
        body = report.json()
        # Report v2 (issue #12): coverage and metrics joined the shape.
        assert body["schema"] == "fontalloy/verification-report@v2"
        winners = {
            entry["codepoint"]: entry["winner"]
            for entry in body["provenance"]
        }
        assert winners[0x41] == "base"
        assert winners[0x61] == "donor-0"

    def test_recipe_output_options_are_honored(self, serve_service, serve_fonts):
        recipe = {
            "base": str(serve_fonts / "Alpha.ttf"),
            "donors": [str(serve_fonts / "Beta.ttf")],
            # woff2 carries one face; pin the base's weight so the union
            # (400 + the donor's 700, issue #27) stays out of the way.
            "weights": [{"weight": 400}],
            "output": {"format": "woff2", "family": "Merged-Duo"},
        }
        build_id = serve_service.submit(recipe).json()["id"]
        done = serve_service.wait_for_status(build_id, "done")
        assert done["format"] == "woff2"
        assert done["font"]["filename"] == "Merged-Duo.woff2"

        font = serve_service.get(f"/builds/{build_id}/font")
        assert font.headers.get("Content-Type") == "font/woff2"
        merged = TTFont(io.BytesIO(font.data))
        assert merged.flavor == "woff2"

    def test_builds_listing_is_addressable(self, serve_service, build_recipe_json):
        build_id = serve_service.submit(build_recipe_json).json()["id"]
        serve_service.wait_for_status(build_id, "done")

        listing = serve_service.get("/builds").json()["builds"]
        listed_ids = [build["id"] for build in listing]
        assert build_id in listed_ids

        detail = serve_service.get(f"/builds/{build_id}").json()
        assert detail["status"] == "done"

    def test_stage_facts_ride_the_progress_document(
        self, serve_service, serve_fonts, tmp_path
    ):
        """Round 13 (owner item 5): the job document carries a ``facts``
        object describing the CURRENT stage — the quantitative readout
        the pipeline already knows. Pinned at three deterministic
        points: a queued build carries None, the grafting stage of a
        slow build carries its slot/codepoint counts, and a done build
        carries the reporting stage's check count."""
        slow_donor = synth_wide_font(
            tmp_path / "slow.ttf",
            family="SlowDonor",
            # Wide enough that the graft window spans several polling
            # rounds, not a missed blink (4000 grafts run ~0.3s).
            count=20_000,
        )
        recipe = {
            "base": str(serve_fonts / "Alpha.ttf"),
            "donors": [str(slow_donor)],
            "rules": [{"set": "zh_cn", "fonts": ["base", "donor-0"]}],
        }
        first = serve_service.submit(recipe).json()["id"]
        second = serve_service.submit(recipe).json()["id"]

        # Queued: no stage has run, so no facts either.
        queued = serve_service.get(f"/builds/{second}").json()
        assert queued["status"] == "queued"
        assert queued["facts"] is None

        # The wide donor keeps grafting observable: poll for the stage
        # and pin the facts that arrived with it.
        doc = self._wait_for_stage(serve_service, first, "grafting")
        assert doc["facts"] == {
            "slots": 1,
            # 2 base codepoints + the wide donor's run (the union is
            # the effective table — the zh_cn rule re-routes, never drops).
            "codepoints": 2 + 20_000,
        }

        done = serve_service.wait_for_status(first, "done")
        # 2 checks per face (readback + metrics) + 1 per rule.
        assert done["facts"] == {"checks": 2 * 1 + 1}
        serve_service.wait_for_status(second, "done")

    @staticmethod
    def _wait_for_stage(
        client: ServeClient, build_id: str, stage: str, timeout: float = 60.0
    ) -> dict[str, Any]:
        """Poll one build's document until its stage is ``stage``."""
        deadline = time.monotonic() + timeout
        last: dict[str, Any] = {}
        while time.monotonic() < deadline:
            last = client.get(f"/builds/{build_id}").json()
            if last["status"] == "failed":
                raise AssertionError(f"build failed: {last.get('error')}")
            if last.get("stage") == stage:
                return last
            time.sleep(0.02)
        raise TimeoutError(
            f"build {build_id} never reached stage {stage!r}: {last}"
        )


class TestQueueing:
    def test_concurrent_submissions_are_queued_not_lost(
        self, serve_service, serve_fonts, tmp_path
    ):
        # The slow donor keeps the worker busy long enough that the
        # second submission is observably queued behind it.
        slow_donor = synth_wide_font(
            tmp_path / "slow.ttf", family="SlowDonor", count=SLOW_DONOR_CODEPOINTS
        )
        recipe = {
            "base": str(serve_fonts / "Alpha.ttf"),
            "donors": [str(slow_donor)],
        }
        first = serve_service.submit(recipe).json()["id"]
        second = serve_service.submit(recipe).json()["id"]

        behind = serve_service.get(f"/builds/{second}").json()
        assert behind["status"] == "queued"

        for build_id in (first, second):
            serve_service.wait_for_status(build_id, "done")

        # Identical pinned inputs produce byte-identical outputs, even
        # through the service.
        fonts = [
            serve_service.get(f"/builds/{build_id}/font").data
            for build_id in (first, second)
        ]
        assert fonts[0] == fonts[1]

    def test_artifact_of_an_unfinished_build_conflicts(
        self, serve_service, serve_fonts, tmp_path
    ):
        slow_donor = synth_wide_font(
            tmp_path / "slow.ttf", family="SlowDonor", count=SLOW_DONOR_CODEPOINTS
        )
        build_id = serve_service.submit(
            {
                "base": str(serve_fonts / "Alpha.ttf"),
                "donors": [str(slow_donor)],
            }
        ).json()["id"]
        response = serve_service.get(f"/builds/{build_id}/font")
        assert response.status == 409


class TestFailures:
    def test_invalid_recipe_json_is_rejected_synchronously(self, serve_service):
        raw = serve_service.request(
            "POST", "/builds", body=None, headers={"Content-Type": "application/json"}
        )
        # An empty body is not a recipe mapping.
        assert raw.status == 400
        assert "error" in raw.json()

    def test_unknown_recipe_field_names_the_field(self, serve_service):
        response = serve_service.submit({"base": "x.ttf", "donors": [], "nope": 1})
        assert response.status == 400
        assert "nope" in response.json()["error"]

    def test_a_failing_build_reports_its_error(self, serve_service):
        response = serve_service.submit(
            {"base": "does-not-exist.ttf", "donors": ["also-missing.ttf"]}
        )
        assert response.status == 202
        build_id = response.json()["id"]
        failed = serve_service.wait_for_status(build_id, "failed")
        assert "does-not-exist.ttf" in failed["error"]
        assert serve_service.get(f"/builds/{build_id}/font").status == 409

    def test_unknown_build_is_not_found(self, serve_service):
        assert serve_service.get("/builds/nope").status == 404
        assert serve_service.get("/builds/nope/font").status == 404

    def test_unknown_route_is_not_found(self, serve_service):
        assert serve_service.get("/nope").status == 404

    def test_unsupported_method_is_not_allowed(self, serve_service):
        response = serve_service.request("PUT", "/builds")
        assert response.status == 405
        assert "GET" in response.headers.get("Allow", "")


class TestCancellation:
    """Round 19: ``POST /builds/{id}/cancel`` — the real abort contract.

    A cancelled build STOPS on the service (the worker thread moves on),
    lands status ``cancelled`` with no artifact, and a queued build
    cancelled before it starts never runs. Cancelling is idempotent and
    a settled build is a 200 no-op.
    """

    def test_unknown_build_cancel_is_not_found(self, serve_service):
        response = serve_service.post("/builds/nope/cancel", {})
        assert response.status == 404
        assert "error" in response.json()

    def test_cancelling_a_running_build_lands_cancelled_and_frees_the_worker(
        self, serve_service, serve_fonts, tmp_path, build_recipe_json
    ):
        slow_donor = synth_wide_font(
            tmp_path / "slow.ttf",
            family="SlowDonor",
            count=CANCEL_DONOR_CODEPOINTS,
        )
        recipe = {
            "base": str(serve_fonts / "Alpha.ttf"),
            "donors": [str(slow_donor)],
        }
        build_id = serve_service.submit(recipe).json()["id"]
        doc = TestBuildLifecycle._wait_for_stage(
            serve_service, build_id, "grafting"
        )
        assert doc["status"] == "running"

        response = serve_service.post(f"/builds/{build_id}/cancel", {})
        assert response.status == 200

        cancelled = serve_service.wait_for_status(build_id, "cancelled")
        # A cancelled build is not a failure: no error text, no artifact.
        assert cancelled["error"] is None
        assert cancelled["font"] is None
        assert serve_service.get(f"/builds/{build_id}/font").status == 409

        # The worker moved on: a build submitted right after the
        # cancellation completes normally.
        follow_up = serve_service.submit(build_recipe_json).json()["id"]
        serve_service.wait_for_status(follow_up, "done")

    def test_cancelling_a_queued_build_removes_it_before_it_starts(
        self, serve_service, serve_fonts, tmp_path, build_recipe_json
    ):
        slow_donor = synth_wide_font(
            tmp_path / "slow.ttf",
            family="SlowDonor",
            count=CANCEL_DONOR_CODEPOINTS,
        )
        recipe = {
            "base": str(serve_fonts / "Alpha.ttf"),
            "donors": [str(slow_donor)],
        }
        first = serve_service.submit(recipe).json()["id"]
        second = serve_service.submit(recipe).json()["id"]
        TestBuildLifecycle._wait_for_stage(serve_service, first, "grafting")
        assert serve_service.get(f"/builds/{second}").json()["status"] == (
            "queued"
        )

        response = serve_service.post(f"/builds/{second}/cancel", {})
        assert response.status == 200
        cancelled = serve_service.wait_for_status(second, "cancelled")
        # It never started: no running transition, no scratch, no start.
        assert cancelled["started_at"] is None
        assert cancelled["font"] is None

        # The queue semantics stand: the running build ahead of it (and
        # one submitted behind it) both complete.
        serve_service.wait_for_status(first, "done")
        third = serve_service.submit(build_recipe_json).json()["id"]
        serve_service.wait_for_status(third, "done")

    def test_cancelling_a_settled_build_is_a_noop(self, serve_service, build_recipe_json):
        build_id = serve_service.submit(build_recipe_json).json()["id"]
        serve_service.wait_for_status(build_id, "done")

        response = serve_service.post(f"/builds/{build_id}/cancel", {})
        assert response.status == 200
        doc = serve_service.get(f"/builds/{build_id}").json()
        assert doc["status"] == "done"
        # The artifact is untouched.
        assert serve_service.get(f"/builds/{build_id}/font").status == 200

    def test_cancel_is_idempotent(self, serve_service, serve_fonts, tmp_path):
        slow_donor = synth_wide_font(
            tmp_path / "slow.ttf",
            family="SlowDonor",
            count=CANCEL_DONOR_CODEPOINTS,
        )
        build_id = serve_service.submit(
            {
                "base": str(serve_fonts / "Alpha.ttf"),
                "donors": [str(slow_donor)],
            }
        ).json()["id"]
        TestBuildLifecycle._wait_for_stage(
            serve_service, build_id, "grafting"
        )
        for _ in range(2):
            response = serve_service.post(f"/builds/{build_id}/cancel", {})
            assert response.status == 200
        serve_service.wait_for_status(build_id, "cancelled")


class TestRetention:
    def test_old_builds_are_reaped_beyond_the_cap(
        self, serve_service, build_recipe_json
    ):
        # This batch also regression-guards the undrained-stderr wedge:
        # the service's stderr is a pipe nobody reads, so if library
        # log records went to stderr they would fill its buffer and
        # freeze the build worker mid-pipeline (fontTools warns on
        # every synthetic head timestamp — dozens of records per build).
        ids = [
            serve_service.submit(build_recipe_json).json()["id"]
            for _ in range(12)
        ]
        # Poll until every build of the batch finished or was reaped
        # (the cap prunes older builds while younger ones complete).
        deadline = time.monotonic() + 60
        for build_id in ids:
            while time.monotonic() < deadline:
                response = serve_service.get(f"/builds/{build_id}")
                if response.status == 404:
                    break
                if response.json()["status"] in ("done", "failed"):
                    break
                time.sleep(0.02)
            else:
                listing = serve_service.get("/builds").json()["builds"]
                stuck = serve_service.get(f"/builds/{build_id}")
                raise TimeoutError(
                    f"build {build_id} neither finished nor was reaped; "
                    f"its document: {stuck.data!r}; "
                    f"listing: {[(b['id'][:8], b['status'], b['stage']) for b in listing]}"
                )

        # The default retention keeps the 10 newest; the oldest two are
        # gone from the registry (their artifacts deleted with them).
        assert serve_service.get(f"/builds/{ids[0]}").status == 404
        assert serve_service.get(f"/builds/{ids[1]}").status == 404
        assert serve_service.get(f"/builds/{ids[-1]}").status == 200
        assert serve_service.get(f"/builds/{ids[-1]}/font").status == 200
        listing = serve_service.get("/builds").json()["builds"]
        assert len(listing) <= 10


class TestMalformedContentLength:
    """A non-numeric Content-Length is a 400, never a crashed handler
    (spec #25 review P2-5) — the stdlib client never emits one, so the
    requests go over a raw socket."""

    @pytest.mark.parametrize(
        "path",
        [
            "/builds",
            "/precedence-resolve",
            "/local-fonts",
            "/local-fonts/upload?filename=x.ttf",
        ],
    )
    def test_garbage_length_answers_400_json(self, serve_service, path):
        port = int(serve_service.base.rsplit(":", 1)[1])
        request = (
            f"POST {path} HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{port}\r\n"
            "Content-Length: banana\r\n"
            "Connection: close\r\n\r\n"
        ).encode("ascii")
        status, body = _raw_request(port, request)
        assert status == 400
        document = json.loads(body.decode("utf-8"))
        assert "Content-Length" in document["error"]


def _raw_request(port: int, request: bytes, timeout: float = 5.0) -> tuple[int, bytes]:
    """One raw-socket request's (status, body).

    The connection asks to close, so the response reads until EOF —
    header-level cases the stdlib client would never emit.
    """
    with socket.create_connection(("127.0.0.1", port), timeout=timeout) as sock:
        sock.settimeout(timeout)
        sock.sendall(request)
        chunks: list[bytes] = []
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
    raw = b"".join(chunks)
    assert raw, "the service closed the connection without a response"
    status_line = raw.split(b"\r\n", 1)[0]
    body = raw.partition(b"\r\n\r\n")[2]
    return int(status_line.split(b" ")[1]), body


class TestGracefulShutdown:
    def test_sigint_sigterm_mid_queue_cleans_up_and_exits_cleanly(
        self, serve_exe, serve_fonts, serve_manifest, tmp_path
    ):
        work = tmp_path / "work"
        work.mkdir()
        with running_service(
            serve_exe,
            [
                "--port",
                "0",
                "--manifest",
                str(serve_manifest),
                "--font-dir",
                str(serve_fonts),
                "--work-dir",
                str(work),
            ],
            cwd=tmp_path,
        ) as (client, process):
            # A slow first build plus a queue behind it: the signal
            # lands while work is in flight.
            slow_donor = synth_wide_font(
                tmp_path / "slow.ttf",
                family="SlowDonor",
                count=SLOW_DONOR_CODEPOINTS,
            )
            recipe = {
                "base": str(serve_fonts / "Alpha.ttf"),
                "donors": [str(slow_donor)],
            }
            client.submit(recipe)
            client.submit(recipe)
            client.submit(recipe)

            if os.name == "nt":
                process.send_signal(signal.CTRL_BREAK_EVENT)
            else:
                process.send_signal(signal.SIGTERM)

            stdout, stderr = process.communicate(timeout=30)

        assert process.returncode == 0, f"serve stderr: {stderr[-2000:]}"
        # Temporary artifacts are cleaned up: the work directory the
        # service created its build scratch inside is left empty.
        assert work.is_dir()
        assert list(work.iterdir()) == [], "build scratch survived shutdown"


def test_stdin_watch_stops_the_service_when_the_supervisor_pipe_closes(
    fontalloy_exe: Path, tmp_path: Path
) -> None:
    """The sidecar lifecycle (issue #16): with the watchdog armed, the
    service stops itself gracefully when its stdin pipe closes — the
    GUI parent died without a chance to kill the process tree, and the
    orphaned loopback server must not survive it.
    """
    env = {**os.environ, fontalloy_core_serve.STDIN_WATCH_ENV: "1"}
    process = subprocess.Popen(
        [str(fontalloy_exe), "serve", "--port", "0"],
        cwd=tmp_path,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
    )
    try:
        ready = process.stdout.readline()
        assert READY_LINE_RE.match(ready.strip()), f"no ready line: {ready!r}"
        base = ready.strip()
        health = urllib.request.urlopen(f"{base}/health", timeout=10)
        assert health.status == 200
    finally:
        # The parent's pipe closes (the GUI is gone): EOF, not a signal.
        if process.stdin:
            process.stdin.close()
    stdout, stderr = process.communicate(timeout=30)
    assert process.returncode == 0, f"serve stderr: {stderr[-2000:]}"
