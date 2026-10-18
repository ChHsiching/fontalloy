"""The P0 memory-safety proofs (spec #25 aftermath, the 8 GB incident).

The owner's absolute rule: NO process may saturate this machine's
memory. Two architecture invariants make that rule structural, and
this suite pins both:

1. **The serve never parses font faces for the picker.** The client
   install path (catalog sync) verifies bytes by streaming sha256
   alone — the release document pins every face's checksum, so
   hash-matching-but-unparsable bytes are a release-builder defect,
   checked at packaging. Family documents (names, coverage, the
   placeholder flag) are computed ONCE, at sync time, inside a
   quota'd worker subprocess; the serve parent only reads the cached
   JSON, and request handlers never touch fontTools at all.
2. **The serve parent's RSS stays flat while that work runs.** A
   family whose document computation is artificially expensive (the
   allocation seam below) must inflate — and, past its quota, die —
   inside the CHILD, never in the long-lived serve.

The zero-parse assertions are this suite's in-process exceptions (the
TestFastPath pattern): a counting seam around every fontTools face
constructor the serve's scan paths reach, which a subprocess serve
cannot expose. The RSS assertion samples a REAL subprocess serve from
the test process, the way the frontends experience it.

The allocation seam (:data:`ALLOCATE_ENV` / :data:`HOLD_ENV`) is a
test-only hook inside the family-document scan: it makes one family's
document computation hold a chosen number of megabytes for a chosen
time, standing in for the decompiled glyf/CFF of a real CJK face
without the fixture carrying one.
"""

from __future__ import annotations

import ctypes
import os
import socket
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from conftest import fontalloy_exe, synth_font  # noqa: F401
from fontalloy_core.catalog import load_manifest
from fontalloy_core.catalog_sync import CatalogSync
from fontalloy_core.family_docs import FamilyDocuments
from test_cli_serve import running_service
from test_serve_catalog_sync import build_site
from test_serve_family_docs import (
    CutSpec,
    FaceSpec,
    FamilySpec,
    build_picker_site,
    write_site_manifest,
)

#: Test seam: the worker's per-family hard memory quota, in MiB. The
#: production default lives in :mod:`fontalloy_core.quota`; tests pin a
#: small one so the breach is cheap to stage.
QUOTA_ENV = "FONTALLOY_WORKER_MAX_RSS_MB"

#: Test seam: megabytes the family-document scan allocates and holds —
#: the artificial "expensive face" (a real CJK face's decompiled glyf).
ALLOCATE_ENV = "FONTALLOY_TEST_SCAN_ALLOCATE_MB"

#: Test seam: seconds the allocation is held, so the RSS sampler (and
#: the quota) reliably observe it.
HOLD_ENV = "FONTALLOY_TEST_SCAN_HOLD_SECONDS"

#: How much the serve parent's RSS may grow while a document
#: computation runs (MiB). The child's interpreter never inflates the
#: parent; the parent only ever reads small JSON.
PARENT_RSS_BUDGET_MB = 128

#: Every module attribute a face parse goes through. Counting these
#: counts every fontTools face open the serve's scan paths can make.
_PARSE_REFS = (
    "fontTools.ttLib.TTFont",
    "fontalloy_core.load.TTFont",
    "fontalloy_core.family_docs.TTFont",
    "fontalloy_core.placeholder.TTFont",
    "fontalloy_core.systemfonts.TTFont",
    "fontalloy_core.local_fonts.TTFont",
)


@pytest.fixture
def parse_counter(monkeypatch) -> list[str]:
    """Every face construction the SERVE PROCESS performs, via a
    counting wrapper that still delegates to the real fontTools."""
    calls: list[str] = []

    def counting(*args: Any, **kwargs: Any):
        first = args[0] if args else kwargs.get("file", "?")
        calls.append(str(first))
        return _real_ttfont(*args, **kwargs)

    import fontTools.ttLib
    from fontalloy_core import (
        family_docs,
        load as load_mod,
        local_fonts,
        placeholder,
        systemfonts,
    )

    _real_ttfont = fontTools.ttLib.TTFont
    monkeypatch.setattr(fontTools.ttLib, "TTFont", counting)
    for module in (load_mod, family_docs, placeholder, systemfonts, local_fonts):
        monkeypatch.setattr(module, "TTFont", counting)
    return calls


def _run_sync_to_terminal(
    release_origin: str, catalog_dir: Path, *, verify_hashes: bool = False
) -> dict[str, Any]:
    """One in-process catalog sync, run to its terminal state."""
    sync = CatalogSync(release_origin, catalog_dir)
    sync.request_sync(verify_hashes=verify_hashes)
    thread = sync._thread
    assert thread is not None
    thread.join(timeout=120)
    document = sync.status_document()
    assert document["state"] in ("ready", "unavailable"), document
    return document


def _run_docs_to_scanned(
    manifest: Path, sync: CatalogSync, catalog_dir: Path, family: str
) -> dict[str, Any]:
    """The in-process family-document builder, polled to one scanned
    family (the TestFastPath pattern: the zero-parse counter needs the
    builder running in this process)."""
    docs = FamilyDocuments(load_manifest(manifest), sync, catalog_dir)
    docs.start()
    deadline = time.monotonic() + 120
    last: dict[str, Any] = {}
    try:
        while time.monotonic() < deadline:
            last = docs.documents()
            for entry in last["families"]:
                if entry["family"] == family and entry["scanned"]:
                    return entry
            time.sleep(0.02)
    finally:
        docs.stop()
    raise TimeoutError(f"family {family} never scanned: {last}")


class TestInstallPathNeverParses:
    """Invariant A: the client install path is hash-only."""

    def test_the_install_path_performs_no_face_parse(
        self, tmp_path, parse_counter
    ):
        """Download → streaming sha256 → extract → marker: the bytes'
        authenticity is the pinned checksum, so a client never opens a
        face with fontTools — the unparsable-but-hash-valid case is the
        release builder's defect (checked at packaging), never the
        long-lived serve's memory risk."""
        site = build_site(
            tmp_path / "site",
            families=[("FakeCode", ".zip"), ("FakeBright", ".7z")],
        )
        document = _run_sync_to_terminal(
            site.release_origin, tmp_path / "catalog"
        )
        assert document["state"] == "ready", document["error"]
        for name, payload in site.spec("FakeCode").faces.items():
            assert (
                tmp_path / "catalog" / "FakeCode" / name
            ).read_bytes() == payload
        assert parse_counter == [], (
            f"the install path opened {len(parse_counter)} face(s) with "
            "fontTools; it must verify by hash alone"
        )


class TestDocumentsNeverParseInServe:
    """Invariant B: family documents are precomputed in a quota'd child;
    the serve parent only reads the cached JSON."""

    @pytest.fixture
    def picker_site(self, tmp_path: Path) -> tuple[Any, Path, Path, Path]:
        site = build_picker_site(
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
                                )
                            ],
                        ),
                        CutSpec(
                            variant="",
                            faces=[
                                FaceSpec(
                                    file="FakeCode-Regular.ttf",
                                    family="FakeCode",
                                )
                            ],
                        ),
                    ],
                )
            ],
        )
        manifest = write_site_manifest(tmp_path / "m", site)
        catalog_dir = tmp_path / "catalog"
        return site, manifest, catalog_dir, tmp_path / "work"

    def test_the_serve_process_never_parses_faces_for_documents(
        self, picker_site, parse_counter
    ):
        """The whole lifecycle — sync, document build, preview
        derivation — parses zero faces inside the serve process: the
        scans run in quota'd worker children, the parent reads the JSON
        they wrote."""
        site, manifest, catalog_dir, _work = picker_site
        sync = CatalogSync(site.release_origin, catalog_dir)
        sync.request_sync(verify_hashes=False)
        thread = sync._thread
        assert thread is not None
        thread.join(timeout=120)
        assert sync.status_document()["state"] == "ready"

        family = _run_docs_to_scanned(manifest, sync, catalog_dir, "FakeCode")
        assert family["display_names"] == ["FakeCode", "FakeCode Nerd Font"]
        assert parse_counter == [], (
            f"the serve process opened {len(parse_counter)} face(s) with "
            "fontTools while building family documents"
        )

    def test_request_time_document_serving_parses_nothing(
        self, picker_site, parse_counter
    ):
        """GET /catalog/families and the preview byte source are pure
        cache reads: a request may trigger JSON loads, never a face
        parse."""
        site, manifest, catalog_dir, _work = picker_site
        sync = CatalogSync(site.release_origin, catalog_dir)
        sync.request_sync(verify_hashes=False)
        thread = sync._thread
        assert thread is not None
        thread.join(timeout=120)
        assert sync.status_document()["state"] == "ready"
        docs = FamilyDocuments(load_manifest(manifest), sync, catalog_dir)
        docs.start()
        try:
            deadline = time.monotonic() + 120
            last: dict[str, Any] = {}
            while time.monotonic() < deadline:
                last = docs.documents()
                if any(entry["scanned"] for entry in last["families"]):
                    break
                time.sleep(0.02)
            assert any(entry["scanned"] for entry in last["families"]), last

            parse_counter.clear()
            snapshot = docs.documents()
            preview = docs.preview_source("FakeCode")
            assert snapshot["families"]
            assert preview is not None, "the built family serves its preview"
            assert parse_counter == []
        finally:
            docs.stop()


class _ProcessMemory:
    """Read one process's working-set size from outside it.

    Windows: ``GetProcessMemoryInfo`` through ctypes (psapi), no new
    dependency. Linux: ``/proc/<pid>/statm``. Nowhere else: the RSS
    proof skips — the incident machine is Windows and the CI Linux,
    both covered.
    """

    def __init__(self, pid: int):
        self.pid = pid
        if os.name == "nt":
            self._psapi = ctypes.WinDLL("psapi")  # type: ignore[attr-defined]
            self._kernel32 = ctypes.WinDLL("kernel32")  # type: ignore[attr-defined]

            class _Counters(ctypes.Structure):
                _fields_ = [
                    ("cb", ctypes.c_uint32),
                    ("PageFaultCount", ctypes.c_uint32),
                    ("PeakWorkingSetSize", ctypes.c_size_t),
                    ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t),
                    ("PeakPagefileUsage", ctypes.c_size_t),
                ]

            self._counters = _Counters

    def rss_bytes(self) -> int:
        if os.name == "nt":
            handle = self._kernel32.OpenProcess(0x1000, False, self.pid)
            if not handle:
                raise OSError(f"OpenProcess({self.pid}) failed")
            try:
                counters = self._counters()
                counters.cb = ctypes.sizeof(self._counters)
                ok = self._psapi.GetProcessMemoryInfo(
                    handle, ctypes.byref(counters), counters.cb
                )
                if not ok:
                    raise OSError("GetProcessMemoryInfo failed")
                return int(counters.WorkingSetSize)
            finally:
                self._kernel32.CloseHandle(handle)
        with open(f"/proc/{self.pid}/statm", encoding="ascii") as statm:
            return int(statm.read().split()[1]) * os.sysconf("SC_PAGE_SIZE")


def _serve_rss_target(process: Any, port: int) -> int:
    """The pid whose RSS is the serve interpreter's own.

    The serve is identified exactly — by owning the loopback listening
    socket — because on Windows the installed ``fontalloy`` console
    script reaches the interpreter through stub processes, and the
    serve itself grows worker children (whose RSS is their own
    business). POSIX: the launched pid is the serve already.
    """
    if os.name != "nt":
        return process.pid
    import ctypes.wintypes as wt

    iphlpapi = ctypes.WinDLL("iphlpapi")  # type: ignore[attr-defined]

    class _Row(ctypes.Structure):
        _fields_ = [
            ("dwState", wt.DWORD),
            ("dwLocalAddr", wt.DWORD),
            ("dwLocalPort", wt.DWORD),
            ("dwRemoteAddr", wt.DWORD),
            ("dwRemotePort", wt.DWORD),
            ("dwOwningPid", wt.DWORD),
        ]

    class _Table(ctypes.Structure):
        _fields_ = [("dwNumEntries", wt.DWORD), ("table", _Row * 1)]

    size = wt.DWORD(0)
    iphlpapi.GetExtendedTcpTable(None, ctypes.byref(size), False, 2, 5, 0)
    buffer = ctypes.create_string_buffer(size.value)
    if iphlpapi.GetExtendedTcpTable(
        buffer, ctypes.byref(size), False, 2, 5, 0
    ) != 0:
        raise OSError("GetExtendedTcpTable failed")
    table = ctypes.cast(
        buffer, ctypes.POINTER(_Table)
    ).contents
    count = table.dwNumEntries
    rows = ctypes.cast(
        ctypes.byref(table.table), ctypes.POINTER(_Row * count)
    ).contents
    want_port_net = socket.htons(port) & 0xFFFF  # row ports are network order
    want_bytes = socket.inet_aton("127.0.0.1")
    want_addr = ctypes.cast(
        ctypes.c_char_p(want_bytes), ctypes.POINTER(wt.DWORD)
    ).contents.value
    listeners = [
        int(row.dwOwningPid)
        for row in rows
        if (row.dwLocalPort & 0xFFFF) == want_port_net
        and row.dwLocalAddr == want_addr
        and row.dwState == 2  # MIB_TCP_STATE_LISTEN
    ]
    assert len(listeners) == 1, f"expected one listener on 127.0.0.1:{port}"
    return listeners[0]


class TestScanPathsNeverParseInServe:
    """Invariant D: the /local-fonts scan, the /fonts enumeration, and
    the /system-fonts scan also parse exclusively in the worker."""

    def test_the_local_fonts_scan_never_parses_in_the_caller(
        self, tmp_path, parse_counter
    ):
        from fontalloy_core.local_fonts import LocalFonts

        font = synth_font(
            tmp_path / "Local.ttf",
            family="MemLocal",
            codepoints=(0x41, 0x4E2D),
        )
        document = LocalFonts().scan_document({"paths": [str(font)]})
        assert len(document["families"]) == 1
        assert document["families"][0]["family"] == "MemLocal"
        assert parse_counter == []

    def test_the_fonts_directory_scan_never_parses_in_the_caller(
        self, tmp_path, parse_counter
    ):
        from fontalloy_core.fonts_scan import scan_font_dirs

        synth_font(tmp_path / "Dir.ttf", family="MemDir", codepoints=(0x41,))
        (tmp_path / "stray.ttf").write_bytes(b"not a font")
        result = scan_font_dirs((tmp_path,))
        assert [face.family for face in result.faces] == ["MemDir"]
        assert [path.name for path in result.skipped] == ["stray.ttf"]
        assert parse_counter == []

    def test_the_system_font_scan_never_parses_in_the_caller(
        self, tmp_path, parse_counter
    ):
        from fontalloy_core.systemfonts import scan_system_fonts_sync

        synth_font(tmp_path / "Sys.ttf", family="MemSys", codepoints=(0x41,))
        faces = scan_system_fonts_sync((tmp_path,))
        assert [face.family for face in faces] == ["MemSys"]
        assert parse_counter == []


class TestPeakRss:
    """Invariant C: the parent stays flat; the child obeys its quota."""

    def test_the_serve_parent_stays_flat_and_the_quota_contains_the_breach(
        self, fontalloy_exe, tmp_path  # noqa: F811
    ):
        """A family whose document computation allocates far past its
        quota (the seam stands in for a big CJK face's decompiled
        outlines): the allocation — and the breach — happen inside the
        quota'd child. The serve parent's RSS must stay flat for the
        whole run, and the family must surface a clear per-family error
        in the families document."""
        if os.name not in ("nt", "posix"):  # pragma: no cover
            pytest.skip("no cross-process RSS reader on this platform")
        site = build_picker_site(
            tmp_path / "site",
            families=[
                FamilySpec(
                    family="FakeHeavy",
                    cuts=[
                        CutSpec(
                            variant="",
                            faces=[
                                FaceSpec(
                                    file="FakeHeavy-Regular.ttf",
                                    family="FakeHeavy",
                                    codepoints=tuple(range(0x41, 0x7B)),
                                )
                            ],
                        )
                    ],
                )
            ],
        )
        manifest = write_site_manifest(tmp_path / "m", site)
        catalog_dir = tmp_path / "catalog"
        work = tmp_path / "work"
        work.mkdir()

        # The expensive family: hold 512 MiB for 1.5 s inside the
        # document scan, under a 256 MiB quota — a breach the child
        # must die from, the parent must never feel.
        os.environ[QUOTA_ENV] = "256"
        os.environ[ALLOCATE_ENV] = "512"
        os.environ[HOLD_ENV] = "1.5"
        try:
            with running_service(
                fontalloy_exe,
                [
                    "--port",
                    "0",
                    "--catalog-release-origin",
                    site.release_origin,
                    "--catalog-dir",
                    str(catalog_dir),
                    "--manifest",
                    str(manifest),
                    "--work-dir",
                    str(work),
                ],
                cwd=tmp_path,
            ) as (client, process):
                serve_port = int(client.base.rsplit(":", 1)[1])
                memory = _ProcessMemory(
                    _serve_rss_target(process, serve_port)
                )
                baseline = memory.rss_bytes()
                peak = baseline

                def sample() -> None:
                    nonlocal peak
                    peak = max(peak, memory.rss_bytes())

                family = _wait_for_docs_settled(client, "FakeHeavy", sample)
                grew_mb = (peak - baseline) / (1024 * 1024)
                print(
                    f"\nserve parent RSS: baseline {baseline / (1 << 20):.0f} "
                    f"MiB, peak {peak / (1 << 20):.0f} MiB "
                    f"(+{grew_mb:.0f} MiB) while the child breached its "
                    "256 MiB quota"
                )
                assert grew_mb < PARENT_RSS_BUDGET_MB, (
                    f"the serve parent grew {grew_mb:.0f} MiB while a "
                    "family document was computed; the computation must "
                    "live in the quota'd child"
                )
                assert family["error"], family
                assert "quota" in family["error"].lower(), family["error"]
                assert family["scanned"] is False
        finally:
            os.environ.pop(QUOTA_ENV, None)
            os.environ.pop(ALLOCATE_ENV, None)
            os.environ.pop(HOLD_ENV, None)


def _wait_for_docs_settled(
    client: Any, family: str, sample: Callable[[], None], timeout: float = 120.0
) -> dict[str, Any]:
    """Poll /catalog/families until ``family`` is scanned or carries an
    error, sampling the serve's RSS around every poll."""
    deadline = time.monotonic() + timeout
    last: dict[str, Any] = {}
    while time.monotonic() < deadline:
        last = client.get("/catalog/families").json()
        for entry in last["families"]:
            if entry["family"] == family and (
                entry["scanned"] or entry.get("error")
            ):
                sample()
                return entry
        sample()
        time.sleep(0.05)
    raise TimeoutError(f"family {family} never settled: {last}")
