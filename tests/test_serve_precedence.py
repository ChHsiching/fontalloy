"""Seam 2 tests: ``POST /precedence-resolve`` — the precedence API.

Ticket #28 (spec #25, core unification): the resolver becomes an API.
The request carries the picks (font references the serve resolves the
same way a build does), the rules, and a universe spec; the response is
the effective table as COMPRESSED RUNS — maximal codepoint stretches
sharing one (winner, via, kind, declared, adjusted) tuple — so the
preview grid pages locally with no per-cell requests.

The contract is pinned three ways: hand-computed winners on a layered
fixture exercising every granularity, byte-identical parity against a
DIRECT library call of ``resolve_precedence`` on the same inputs, and
the timing/starvation guarantee — a worst-case resolve answers
synchronously while ``/health`` stays live.
"""

from __future__ import annotations

import bisect
import json
import sys
import threading
import time
from pathlib import Path
from typing import Any

import pytest

from conftest import synth_font
from test_cli_assets import FAKE_OFL, entry, write_manifest
from test_cli_serve import ALLOWED_ORIGIN, running_service, synth_wide_font

from fontalloy_core.placeholder import face_coverage
from fontalloy_core.precedence import BUILTIN_NAMED_SETS, resolve_precedence
from fontalloy_core.recipe import parse_recipe

#: The wide donor of the worst-case timing fixture (a contiguous CJK
#: run): the same scale the cancel suite grafts, tens of thousands of
#: codepoints — the visible-universe ceiling the endpoint must answer
#: synchronously.
WIDE_DONOR_CODEPOINTS = 30_000


def _expected_runs() -> list[dict[str, Any]]:
    """The layered fixture's expectation, run by run — hand-computed
    from the resolver's documented semantics.

    - 0x41-0x42: no rule covers; the default precedence keeps the
      base's own glyphs (fill-by-default, nothing declared).
    - 0x4E00: the codepoint rule (rule-2) supplies donor-0 over the
      base's glyph — an override, and the winner differs from the
      no-rule default (base), so the cell is adjusted.
    - 0x4E01: the range rule (rule-1) supplies donor-1; the default
      winner there is donor-0 (donor-0 covers it and joins earlier),
      so the rule moved the winner — adjusted.
    - 0x4E02: the set rule (rule-0) supplies donor-0; preset rules
      never count as adjustments (declaring a language scope IS the
      default order, not an adjustment).
    - 0x2100: rule-3 heads donor-0, which lacks the glyph — absence
      never overrides, the default supplies donor-1, and the
      declaration (donor-0, range) rides the run without moving the
      winner: no adjustment.
    """
    return [
        {
            "start": 0x41,
            "end": 0x42,
            "winner": "base",
            "via": "default",
            "kind": "base",
            "declared": None,
            "adjusted": False,
        },
        {
            "start": 0x2100,
            "end": 0x2100,
            "winner": "donor-1",
            "via": "default",
            "kind": "fill",
            "declared": {"font": "donor-0", "granularity": "range"},
            "adjusted": False,
        },
        {
            "start": 0x4E00,
            "end": 0x4E00,
            "winner": "donor-0",
            "via": "rule-2",
            "kind": "override",
            "declared": {"font": "donor-0", "granularity": "codepoint"},
            "adjusted": True,
        },
        {
            "start": 0x4E01,
            "end": 0x4E01,
            "winner": "donor-1",
            "via": "rule-1",
            "kind": "fill",
            "declared": {"font": "donor-1", "granularity": "range"},
            "adjusted": True,
        },
        {
            "start": 0x4E02,
            "end": 0x4E02,
            "winner": "donor-0",
            "via": "rule-0",
            "kind": "fill",
            "declared": {"font": "donor-0", "granularity": "set"},
            "adjusted": False,
        },
    ]


def expand_runs(runs: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    """Expand compressed runs to a per-codepoint entry map (the grid's
    client-side lookup is the same walk, no request per cell)."""
    table: dict[int, dict[str, Any]] = {}
    for run in runs:
        assert run["start"] <= run["end"], run
        for codepoint in range(run["start"], run["end"] + 1):
            table[codepoint] = run
    return table


def lookup_run(runs: list[dict[str, Any]], codepoint: int) -> dict[str, Any] | None:
    """The binary-search lookup the grid performs per cell, locally."""
    starts = [run["start"] for run in runs]
    index = bisect.bisect_right(starts, codepoint) - 1
    if index < 0:
        return None
    run = runs[index]
    return run if codepoint <= run["end"] else None


@pytest.fixture(scope="module")
def prec_exe() -> Path:
    name = "fontalloy.exe" if sys.platform == "win32" else "fontalloy"
    exe = Path(sys.executable).parent / name
    assert exe.is_file(), f"the fontalloy executable is not installed: {exe}"
    return exe


@pytest.fixture(scope="module")
def prec_root(tmp_path_factory: Any) -> Path:
    return tmp_path_factory.mktemp("precedence-serve")


@pytest.fixture(scope="module")
def prec_fonts(prec_root: Path) -> Path:
    """Three single-face picks whose coverages interleave on purpose:

    the base owns one Latin pair plus ONE CJK codepoint (so a rule can
    override a base glyph), donor-0 and donor-1 carve the 0x4E00 block
    differently (so each granularity layer has a distinct winner), and
    0x2100 is held by donor-1 only (so a rule heading donor-0 there
    cannot supply — absence never overrides).
    """
    fonts = prec_root / "fonts"
    fonts.mkdir()
    synth_font(
        fonts / "PrecBase.ttf",
        family="PrecBase",
        codepoints=(0x41, 0x42, 0x4E00),
    )
    synth_font(
        fonts / "PrecDonor0.ttf",
        family="PrecDonor0",
        codepoints=(0x4E00, 0x4E01, 0x4E02),
    )
    synth_font(
        fonts / "PrecDonor1.ttf",
        family="PrecDonor1",
        codepoints=(0x4E01, 0x4E02, 0x2100),
    )
    return fonts


@pytest.fixture(scope="module")
def prec_manifest(prec_root: Path) -> Path:
    licenses = prec_root / "licenses"
    licenses.mkdir(exist_ok=True)
    (licenses / "OFL-1.1.txt").write_text(FAKE_OFL, encoding="utf-8")
    return write_manifest(
        prec_root / "catalog.json",
        [entry(family="FakeCode", file="FakeCode.zip",
               url="https://example.com/FakeCode.zip", sha256="0" * 64)],
    )


@pytest.fixture(scope="module")
def prec_service(
    prec_exe: Path, prec_root: Path, prec_fonts: Path, prec_manifest: Path
):
    with running_service(
        prec_exe,
        [
            "--port", "0",
            "--allow-origin", ALLOWED_ORIGIN,
            "--manifest", str(prec_manifest),
            "--font-dir", str(prec_fonts),
        ],
        cwd=prec_root,
    ) as (client, _process):
        yield client


def layered_body(prec_fonts: Path) -> dict[str, Any]:
    """The layered request: every granularity plus a rule that cannot
    supply its own target (0x2100) plus a user-defined named set."""
    return {
        "picks": {
            "base": str(prec_fonts / "PrecBase.ttf"),
            "donors": [
                str(prec_fonts / "PrecDonor0.ttf"),
                str(prec_fonts / "PrecDonor1.ttf"),
            ],
        },
        "sets": {"alpha": ["0x4E00-0x4E02"]},
        "rules": [
            {"set": "alpha", "fonts": ["donor-0"]},
            {"range": "0x4E00-0x4E01", "fonts": ["donor-1"]},
            {"codepoint": 0x4E00, "fonts": ["donor-0"]},
            {"range": "0x2100-0x2101", "fonts": ["donor-0"]},
        ],
    }


def _library_resolution(body: dict[str, Any]):
    """The DIRECT library call the contract is pinned against: the same
    picks parsed by the recipe schema, loaded by the load stage, and
    resolved by ``resolve_precedence`` — no HTTP anywhere."""
    from fontalloy_core.load import load_faces

    recipe = parse_recipe(
        {
            "base": body["picks"]["base"],
            "donors": body["picks"]["donors"],
            "sets": body.get("sets"),
            "rules": body.get("rules"),
        },
        Path(body["picks"]["base"]).parent,
    )
    coverages: dict[str, set[int]] = {}
    refs = [("base", recipe.base)] + [
        (f"donor-{index}", ref) for index, ref in enumerate(recipe.donors)
    ]
    for font_id, ref in refs:
        union: set[int] = set()
        for face in load_faces(ref, role=font_id):
            union |= set(face_coverage(face.font).codepoints)
        coverages[font_id] = union
    return resolve_precedence(
        recipe.rules,
        coverages=coverages,
        named_sets={**BUILTIN_NAMED_SETS, **recipe.named_sets},
    )


class TestPrecedenceResolve:
    """Winners, shape, and the grid's local-paging contract."""

    def test_layered_rules_resolve_to_the_documented_runs(self, prec_service, prec_fonts):
        response = prec_service.post("/precedence-resolve", layered_body(prec_fonts))
        assert response.status == 200, response.data
        doc = response.json()
        assert doc["fonts"] == ["base", "donor-0", "donor-1"]
        assert doc["rules"] == 4
        assert doc["codepoints"] == 6
        assert doc["counts"] == {"base": 2, "fill": 3, "override": 1}
        assert doc["conflicts"] == []
        assert doc["runs"] == _expected_runs()

    def test_identical_winners_against_a_direct_library_call(
        self, prec_service, prec_fonts
    ):
        """THE contract (ticket #28): identical winners, per codepoint,
        against the core resolver invoked directly on the same picks,
        rules, and sets the request carried."""
        body = layered_body(prec_fonts)
        doc = prec_service.post("/precedence-resolve", body).json()
        resolution = _library_resolution(body)

        expected = {
            entry.codepoint: entry for entry in resolution.effective_table
        }
        table = expand_runs(doc["runs"])
        assert set(table) == set(expected), "the tables cover different codepoints"
        for codepoint, entry in expected.items():
            run = table[codepoint]
            assert (run["winner"], run["via"], run["kind"]) == (
                entry.winner,
                entry.via,
                entry.kind,
            ), codepoint
        assert doc["counts"] == resolution.counts
        assert doc["codepoints"] == len(resolution.effective_table)

    def test_runs_compress_and_lookup_pages_locally(self, prec_service, prec_fonts):
        """The runs are the grid's local index: sorted, disjoint, and a
        binary-search lookup answers any codepoint with no request."""
        doc = prec_service.post("/precedence-resolve", layered_body(prec_fonts)).json()
        runs = doc["runs"]
        starts = [run["start"] for run in runs]
        assert starts == sorted(starts)
        for earlier, later in zip(runs, runs[1:]):
            assert later["start"] > earlier["end"] + 1 or (
                later["start"] == earlier["end"] + 1
                and _run_key(earlier) != _run_key(later)
            )
        table = expand_runs(runs)
        for codepoint in table:
            assert lookup_run(runs, codepoint) is table[codepoint]
        assert lookup_run(runs, 0x10FFFF) is None
        assert lookup_run(runs, 0x43) is None

    def test_the_universe_spec_bounds_the_table(self, prec_service, prec_fonts):
        body = layered_body(prec_fonts)
        body["universe"] = {"intervals": ["0x41-0x42", "0x2100"]}
        doc = prec_service.post("/precedence-resolve", body).json()
        assert set(expand_runs(doc["runs"])) == {0x41, 0x42, 0x2100}
        assert doc["codepoints"] == 3
        assert doc["counts"] == {"base": 2, "fill": 1, "override": 0}

    def test_universe_entries_accept_ints_and_single_codepoint_strings(
        self, prec_service, prec_fonts
    ):
        body = layered_body(prec_fonts)
        body["universe"] = {"intervals": [0x41, "0x4E00"]}
        doc = prec_service.post("/precedence-resolve", body).json()
        assert set(expand_runs(doc["runs"])) == {0x41, 0x4E00}

    def test_the_same_request_answers_byte_identically(self, prec_service, prec_fonts):
        """Deterministic results: no timestamps, no drift — the grid can
        cache a response and trust it."""
        body = layered_body(prec_fonts)
        first = prec_service.post("/precedence-resolve", body)
        second = prec_service.post("/precedence-resolve", body)
        assert first.data == second.data

    def test_the_response_carries_cors_headers_for_the_allowed_origin(
        self, prec_service, prec_fonts
    ):
        body = layered_body(prec_fonts)
        response = prec_service.post(
            "/precedence-resolve", body, headers={"Origin": ALLOWED_ORIGIN}
        )
        assert response.headers.get("Access-Control-Allow-Origin") == ALLOWED_ORIGIN


def _run_key(run: dict[str, Any]) -> tuple[Any, ...]:
    return (
        run["winner"],
        run["via"],
        run["kind"],
        json.dumps(run["declared"], sort_keys=True),
        run["adjusted"],
    )


class TestSameLayerConflicts:
    def test_overlapping_ranges_report_their_overlap(self, prec_service, prec_fonts):
        body = layered_body(prec_fonts)
        body["rules"] = [
            {"range": "0x4E00-0x4E02", "fonts": ["donor-0"]},
            {"range": "0x4E01-0x4E03", "fonts": ["donor-1"]},
        ]
        doc = prec_service.post("/precedence-resolve", body).json()
        assert doc["conflicts"] == [
            {
                "granularity": "range",
                "shadowed": "rule-0",
                "winner": "rule-1",
                "overlap": ["0x4E01-0x4E02"],
                "codepoints": 2,
            }
        ]
        resolution = _library_resolution(body)
        assert len(doc["conflicts"]) == len(resolution.conflicts)


class TestFailures:
    def test_get_is_not_allowed(self, prec_service):
        response = prec_service.get("/precedence-resolve")
        assert response.status == 405
        assert "POST" in response.headers.get("Allow", "")

    def test_unknown_request_field_names_the_field(self, prec_service, prec_fonts):
        body = layered_body(prec_fonts)
        body["nope"] = 1
        response = prec_service.post("/precedence-resolve", body)
        assert response.status == 400
        assert "nope" in response.json()["error"]

    def test_picks_must_be_a_mapping(self, prec_service, prec_fonts):
        body = layered_body(prec_fonts)
        body["picks"] = [body["picks"]["base"]]
        response = prec_service.post("/precedence-resolve", body)
        assert response.status == 400
        assert "picks" in response.json()["error"]

    def test_picks_need_a_base(self, prec_service, prec_fonts):
        body = layered_body(prec_fonts)
        body["picks"] = {"donors": body["picks"]["donors"]}
        response = prec_service.post("/precedence-resolve", body)
        assert response.status == 400
        assert "base" in response.json()["error"]

    def test_a_rule_referencing_an_unknown_font_is_rejected(
        self, prec_service, prec_fonts
    ):
        body = layered_body(prec_fonts)
        body["rules"][0]["fonts"] = ["donor-9"]
        response = prec_service.post("/precedence-resolve", body)
        assert response.status == 400
        assert "donor-9" in response.json()["error"]

    def test_a_missing_font_file_is_a_client_error(self, prec_service, prec_fonts):
        body = layered_body(prec_fonts)
        body["picks"]["base"] = str(prec_fonts / "not-there.ttf")
        response = prec_service.post("/precedence-resolve", body)
        assert response.status == 400
        assert "not-there.ttf" in response.json()["error"]

    def test_an_unresolvable_catalog_family_is_a_client_error(
        self, prec_service, prec_fonts
    ):
        body = layered_body(prec_fonts)
        body["picks"]["base"] = {"family": "NoSuchFamily"}
        response = prec_service.post("/precedence-resolve", body)
        assert response.status == 400
        assert "NoSuchFamily" in response.json()["error"]

    def test_a_broken_universe_spec_is_rejected(self, prec_service, prec_fonts):
        body = layered_body(prec_fonts)
        body["universe"] = {"intervals": ["junk"]}
        response = prec_service.post("/precedence-resolve", body)
        assert response.status == 400
        assert "universe" in response.json()["error"]

    def test_an_empty_universe_interval_list_is_rejected(
        self, prec_service, prec_fonts
    ):
        body = layered_body(prec_fonts)
        body["universe"] = {"intervals": []}
        response = prec_service.post("/precedence-resolve", body)
        assert response.status == 400


class TestWorstCaseTiming:
    def test_a_visible_universe_scale_resolve_is_synchronous_and_health_stays_live(
        self, prec_service, prec_fonts, tmp_path
    ):
        """The engineering constraint, measured: the worst fixture at
        visible-universe scale (a 30,000-codepoint contiguous donor, a
        zh_cn preset rule, a range, and a codepoint rule) resolves
        INLINE and synchronously — measured at 3.9 s on the reference
        machine (the timing is printed every run) — while /health keeps
        answering on its own connection thread (worst observed poll
        0.17 s across the 29 polls that landed mid-resolve), so the
        endpoint needs no job-queue dance: the threaded server answers
        health concurrently and the GIL preempts the walk.
        """
        wide = synth_wide_font(
            tmp_path / "wide.ttf",
            family="PrecWide",
            count=WIDE_DONOR_CODEPOINTS,
        )
        body = {
            "picks": {
                "base": str(prec_fonts / "PrecBase.ttf"),
                "donors": [str(wide)],
            },
            "rules": [
                {"set": "zh_cn", "fonts": ["base", "donor-0"]},
                {"range": "0x4E00-0x9FFF", "fonts": ["donor-0"]},
                {"codepoint": 0x4E2D, "fonts": ["donor-0"]},
            ],
        }
        result: dict[str, Any] = {}
        thread = threading.Thread(
            target=lambda: result.update(
                response=prec_service.post("/precedence-resolve", body, timeout=120)
            )
        )
        started = time.monotonic()
        thread.start()
        health_latencies: list[float] = []
        while thread.is_alive():
            poll_started = time.monotonic()
            health = prec_service.get("/health", timeout=30)
            health_latencies.append(time.monotonic() - poll_started)
            assert health.status == 200, health.data
            time.sleep(0.01)
        thread.join()
        elapsed = time.monotonic() - started

        response = result["response"]
        assert response.status == 200, response.data
        doc = response.json()
        # 2 base-only Latin codepoints + the wide donor's contiguous run
        # (0x4E00 is shared, not double-counted).
        assert doc["codepoints"] == 2 + WIDE_DONOR_CODEPOINTS
        # Bounded and compact: tens of thousands of codepoints collapse
        # into a handful of runs — the grid pages locally.
        assert len(doc["runs"]) < 100
        # /health was actually polled DURING the resolve, and every poll
        # answered promptly (no starvation at realistic scale).
        assert health_latencies, "no /health poll landed during the resolve"
        worst_health = max(health_latencies)
        print(
            f"\nprecedence-resolve worst case: {doc['codepoints']} codepoints "
            f"in {elapsed:.2f}s ({len(doc['runs'])} runs); "
            f"{len(health_latencies)} /health polls, worst {worst_health:.3f}s"
        )
        assert worst_health < 5.0
        assert elapsed < 30.0  # documented bound; see the class docstring
