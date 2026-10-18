"""The quota'd font worker: every fontTools parse the serve triggers
runs in a child process the OS itself caps (spec #25 aftermath, the
8 GB incident).

The owner's absolute rule: NO process may saturate this machine's
memory — ever. A long-lived serve that decompiles a big CJK face's
glyf/CFF in-process turns one picker browse into gigabytes of Python
objects that never return; the round-31 incident was exactly that.
The architectural answer is that the serve NEVER parses: scans and
document computations run here, in a disposable child, under a HARD
memory quota the operating system enforces — a breach fails the one
unit being computed and kills the child, never the machine.

The mechanism (chosen for dependability with the repo's existing
dependencies — stdlib only, nothing new to install):

- **Windows**: a Job Object (``ctypes``; ``CreateJobObjectW`` +
  ``SetInformationJobObject`` with ``JOB_OBJECT_LIMIT_PROCESS_MEMORY``
  on ``JobObjectExtendedLimitInformation``, then
  ``AssignProcessToJobObject`` before the child can run). The limit
  caps the child's COMMIT CHARGE, so an allocation past the quota
  fails at the allocator: CPython raises ``MemoryError`` for it, the
  worker converts that into its per-unit error result and exits with
  :data:`EXIT_QUOTA`. The job also carries
  ``JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE``, so the child can never
  outlive the parent that owns the job handle. This is the same
  containment mechanism the Windows shell uses for UWP apps — the OS
  refuses the mapping, whatever the child's code does.
- **POSIX**: ``resource.setrlimit(RLIMIT_AS)`` in the child through
  ``preexec_fn`` — the classic address-space cap; allocations past it
  fail (``MemoryError`` from CPython, ``ENOMEM`` from the allocator)
  with the same worker-side conversion.

A pure self-sampling scheme (tracemalloc + RSS polling) was rejected
as the primary mechanism: it observes AFTER the fact, and a single
fontTools table decompile can jump hundreds of MiB between samples —
on the incident machine that gap is the incident. The OS cap cannot
be jumped. The child does, however, still catch ``MemoryError`` and
report it cleanly, which keeps the common breach a per-family error
string instead of a crash.

The quota itself is :data:`DEFAULT_QUOTA_MB` (1536 MiB — comfortably
above a whole real CJK family's honest parse, comfortably below a
machine-saturating balloon), overridable per environment with
:data:`QUOTA_ENV` (the serve may tune it; the memory-safety suite
pins a small one to stage cheap breaches).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from typing import Any

from fontalloy_core.errors import QuotaBreachError, WorkerError

#: The worker's hard memory quota, in MiB. Generous for every honest
#: scan (a full real CJK family parses well under this), fatal for a
#: runaway one.
DEFAULT_QUOTA_MB = 1536

#: Environment override for the quota (MiB) — the serve configuration
#: seam and the memory-safety suite's staging knob.
QUOTA_ENV = "FONTALLOY_WORKER_MAX_RSS_MB"

#: The child's exit code for "died on the memory quota": the parent
#: maps it to :class:`~fontalloy_core.errors.QuotaBreachError`.
EXIT_QUOTA = 42

#: The worker module every invocation runs (``python -m``).
WORKER_MODULE = "fontalloy_core.font_worker"

#: How long the parent waits for a worker before declaring it dead.
#: An honest scan of a real family lands in tens of seconds; a wedged
#: child must never wedge the serve with it.
DEFAULT_TIMEOUT_SECONDS = 600.0


def quota_mb() -> int:
    """The effective worker quota, in MiB (environment override wins)."""
    raw = os.environ.get(QUOTA_ENV)
    if raw:
        try:
            value = int(raw)
        except ValueError:
            return DEFAULT_QUOTA_MB
        if value > 0:
            return value
    return DEFAULT_QUOTA_MB


@dataclass(frozen=True)
class WorkerOutcome:
    """What one worker run did: its exit status and stderr tail."""

    returncode: int
    stderr_tail: str

    @property
    def quota_breach(self) -> bool:
        """Whether the child died on the memory quota (the dedicated
        exit code, or the OS's out-of-memory signature on Windows)."""
        if self.returncode == EXIT_QUOTA:
            return True
        if os.name == "nt":
            # A C-level allocation failure can abort the interpreter
            # outright instead of letting CPython raise MemoryError;
            # on Windows that lands as an NTSTATUS exit code. Treat
            # the known memory signatures as breaches so the error
            # names the containment, not a mystery crash.
            code = self.returncode & 0xFFFFFFFF
            return code in (0xC0000017, 0xC0000409)  # NO_MEMORY, fastfail
        return False


def run_worker(
    job: dict[str, Any],
    *,
    timeout: float | None = None,
) -> WorkerOutcome:
    """Run one job in the quota'd worker child and wait for it.

    The job travels as a JSON file (never argv — paths and family
    names carry spaces and non-ASCII); the worker writes its results
    to the paths the job names, so large results never flow through a
    pipe. Returns the outcome; the caller reads the result files and
    classifies failures through :class:`WorkerOutcome` and the
    dedicated errors below. Raises :class:`QuotaBreachError` /
    :class:`WorkerError` only for the spawn/wait itself.
    """
    limit_mb = quota_mb()
    handle = tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", suffix=".json", prefix="fontalloy-worker-", delete=False
    )
    try:
        json.dump(job, handle, ensure_ascii=False)
        handle.close()
        outcome = _spawn_and_wait([sys.executable, "-m", WORKER_MODULE, handle.name], limit_mb, timeout)
    finally:
        try:
            os.unlink(handle.name)
        except OSError:
            pass
    return outcome


def _spawn_and_wait(
    argv: list[str], limit_mb: int, timeout: float | None
) -> WorkerOutcome:
    """Spawn the child under the quota and wait for it (platform split)."""
    deadline_timeout = DEFAULT_TIMEOUT_SECONDS if timeout is None else timeout
    popen_kwargs: dict[str, Any] = {}
    if os.name != "nt":
        import resource

        def _limit() -> None:  # runs in the child, before exec
            byte_limit = limit_mb * 1024 * 1024
            resource.setrlimit(resource.RLIMIT_AS, (byte_limit, byte_limit))

        popen_kwargs["preexec_fn"] = _limit  # noqa: PLW1509
    process = subprocess.Popen(
        argv,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        **popen_kwargs,
    )
    job_handle: Any = None
    try:
        if os.name == "nt":
            job_handle = _windows_job_for(process.pid, limit_mb * 1024 * 1024)
        try:
            _stdout, stderr = process.communicate(timeout=deadline_timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            raise WorkerError(
                f"worker exceeded its {deadline_timeout:.0f}s time budget and "
                "was killed (the quota holds memory, not time)"
            ) from None
    finally:
        if job_handle is not None:
            import ctypes

            ctypes.windll.kernel32.CloseHandle(job_handle)  # type: ignore[attr-defined]
    tail = (stderr or b"").decode("utf-8", errors="replace")[-2000:]
    return WorkerOutcome(returncode=process.returncode, stderr_tail=tail)


def classify(
    outcome: WorkerOutcome, unit: str
) -> QuotaBreachError | WorkerError | None:
    """The error one unit's worker outcome maps to, if any."""
    if outcome.returncode == 0:
        return None
    if outcome.quota_breach or "MemoryError" in outcome.stderr_tail:
        return QuotaBreachError(
            f"{unit}: the document computation exceeded its "
            f"{quota_mb()} MiB memory quota and was contained in the "
            "worker process (the face never parsed in the serve); the "
            "family stays uncached until the serve restarts or the "
            "release changes"
        )
    return WorkerError(
        f"{unit}: the quota'd worker died (exit {outcome.returncode})"
        + (f": {outcome.stderr_tail.splitlines()[-1]}" if outcome.stderr_tail else "")
    )


# --- the Windows Job Object (ctypes, no new dependency) ----------------------


def _windows_job_for(pid: int, limit_bytes: int) -> Any:
    """A Job Object capping ``pid``'s commit at ``limit_bytes``.

    The child is assigned between spawn and its first instruction
    settling: assignment is race-safe against a running process (the
    limit applies to future commitments immediately). Returns the job
    HANDLE the caller must hold until after the wait — closing it (or
    the parent dying) kills the child, so the worker can never be
    orphaned past its quota.
    """
    import ctypes
    from ctypes import wintypes

    class _IOCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint64) for name in (
            "ReadOperationCount", "WriteOperationCount",
            "OtherOperationCount", "ReadTransferCount",
            "WriteTransferCount", "OtherTransferCount",
        )]

    class _BasicLimits(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_int64),
            ("PerJobUserTimeLimit", ctypes.c_int64),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),  # ULONG_PTR
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class _ExtendedLimits(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", _BasicLimits),
            ("IoInfo", _IOCounters),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]

    JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x00000100
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
    JobObjectExtendedLimitInformation = 9

    handle = kernel32.CreateJobObjectW(None, None)
    if not handle:
        raise WorkerError(
            f"CreateJobObjectW failed (err {ctypes.get_last_error()}); the "
            "worker cannot be launched without its memory quota"
        )
    limits = _ExtendedLimits()
    limits.BasicLimitInformation.LimitFlags = (
        JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    )
    limits.ProcessMemoryLimit = limit_bytes
    ok = kernel32.SetInformationJobObject(
        handle,
        JobObjectExtendedLimitInformation,
        ctypes.byref(limits),
        ctypes.sizeof(_ExtendedLimits),
    )
    if not ok:
        kernel32.CloseHandle(handle)
        raise WorkerError(
            f"SetInformationJobObject failed (err {ctypes.get_last_error()})"
        )
    process_handle = kernel32.OpenProcess(0x0001FFFF, False, pid)  # PROCESS_ALL_ACCESS
    if not process_handle:
        kernel32.CloseHandle(handle)
        raise WorkerError(f"OpenProcess({pid}) failed for the worker job")
    try:
        ok = kernel32.AssignProcessToJobObject(handle, process_handle)
        if not ok:
            kernel32.CloseHandle(handle)
            raise WorkerError("AssignProcessToJobObject failed for the worker")
    finally:
        kernel32.CloseHandle(process_handle)
    return handle
