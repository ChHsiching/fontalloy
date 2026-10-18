"""The quota'd worker child: the only place the serve's fontTools
scans run (spec #25 aftermath, the 8 GB incident).

Invoked as ``python -m fontalloy_core.font_worker <job.json>`` by
:func:`fontalloy_core.quota.run_worker`; the parent applies the hard
memory quota (a Windows Job Object's commit limit, or RLIMIT_AS on
POSIX) around this process. The job travels as a JSON file — paths
and family names carry spaces and non-ASCII — and results flow back
the same way, through the result files the job names, so nothing
large ever crosses a pipe.

Commands:

``family-documents``
    Compute one release family's picker document (names, coverage
    intervals, placeholder flags, preview subset) and write it as the
    family's on-disk document-cache entry — the exact JSON the serve
    parent later serves from :meth:`fontalloy_core.family_docs
    .FamilyDocuments.documents`. A family whose computation fails
    still gets a result file carrying the error, so the parent can
    surface a precise per-family message instead of guessing which
    family a dead child was on. ``MemoryError`` — the OS refusing an
    allocation past the quota — converts into the family's error
    entry and the dedicated exit code; anything else is written per
    family and the batch continues.

``scan-font-dirs`` / ``scan-system-files`` / ``scan-local-files``
    The per-file parse batches behind the ``/fonts`` enumeration, the
    ``/system-fonts`` scan, and ``POST /local-fonts`` (paths and
    upload alike): files in, verdict JSON out. Unreadable files are
    verdicts, never exceptions — the same "skipped, not fatal"
    contract the in-process scans always carried.

The per-file delay seams (``FONTALLOY_*_DELAY``) are honored HERE, in
the child: a test that stretches a scan still stretches it, and the
serve parent stays idle for the whole duration.
"""

from __future__ import annotations

import gc
import json
import sys
from pathlib import Path
from typing import Any

from fontalloy_core.quota import EXIT_QUOTA


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        print("usage: python -m fontalloy_core.font_worker <job.json>", file=sys.stderr)
        return 2
    job = json.loads(Path(argv[0]).read_text(encoding="utf-8"))
    command = job.get("command")
    try:
        if command == "family-documents":
            _family_documents(job)
        elif command == "scan-font-dirs":
            _scan_font_dirs(job)
        elif command == "scan-system-files":
            _scan_system_files(job)
        elif command == "scan-local-files":
            _scan_local_files(job)
        else:
            print(f"font-worker: unknown command {command!r}", file=sys.stderr)
            return 2
    except MemoryError:
        # The OS refused an allocation: the quota held. The failing
        # unit's error entry was already written by its handler; the
        # exit code tells the parent this was containment, not a bug.
        print("font-worker: memory quota exceeded", file=sys.stderr)
        return EXIT_QUOTA
    return 0


def _write_json(path: Path, body: dict[str, Any]) -> None:
    """Atomically write one result file (temp + replace, the catalog
    sync's marker discipline: a killed run never leaves a torn JSON
    a consumer could mistake for a result)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".part")
    temp.write_text(json.dumps(body, ensure_ascii=False), encoding="utf-8")
    temp.replace(path)


def _family_documents(job: dict[str, Any]) -> None:
    from fontalloy_core.family_docs import build_family_document, docs_cache_path

    docs_dir = Path(job["docs_dir"])
    manifest_path = job.get("manifest")
    preview_dir = job.get("preview_dir")
    tag = job["tag"]
    for spec in job["families"]:
        target = docs_cache_path(docs_dir, spec["family"])
        try:
            body = build_family_document(
                spec=spec,
                tag=tag,
                manifest_path=manifest_path,
                preview_dir=preview_dir,
            )
        except MemoryError:
            _write_json(
                target,
                {
                    "schema": body_schema(),
                    "key": spec["key"],
                    "error": (
                        f"{spec['family']}: the document computation exceeded "
                        "its memory quota and was contained in the worker "
                        "process (the face never parsed in the serve); the "
                        "family stays uncached until the serve restarts or "
                        "the release changes"
                    ),
                },
            )
            raise
        except Exception as exc:  # one broken family never kills the batch
            _write_json(
                target,
                {
                    "schema": body_schema(),
                    "key": spec["key"],
                    "error": f"{spec['family']}: document computation failed: {exc!r}",
                },
            )
            continue
        _write_json(target, body)
        # The next family starts from a clean heap: peak memory is the
        # worst single family, never the sum over the batch.
        gc.collect()


def body_schema() -> int:
    """The document-cache schema version (imported lazily so the
    module map stays out of unrelated commands)."""
    from fontalloy_core.family_docs import DOCS_CACHE_SCHEMA

    return DOCS_CACHE_SCHEMA


def _scan_font_dirs(job: dict[str, Any]) -> None:
    from fontalloy_core.fonts_scan import _yield_between_files
    from fontalloy_core.load import scan_families

    files: dict[str, dict[str, Any]] = {}
    for raw in job["paths"]:
        try:
            rows = [
                [
                    face.face_index,
                    face.family,
                    face.subfamily,
                    face.weight,
                    face.italic,
                    face.variable,
                    face.style_consistent,
                ]
                for family in scan_families([Path(raw)])
                for face in family.faces
            ]
            files[raw] = {"error": False, "faces": rows}
        except Exception:
            files[raw] = {"error": True, "faces": []}
        _yield_between_files()
    _write_json(Path(job["out"]), {"files": files})


def _scan_system_files(job: dict[str, Any]) -> None:
    from fontalloy_core.systemfonts import _scan_file, _yield_between_files

    files: dict[str, list[dict[str, Any]]] = {}
    for raw in job["paths"]:
        files[raw] = [
            {
                "file": face.file,
                "face": face.face,
                "family": face.family,
                "subfamily": face.subfamily,
                "weight": face.weight,
                "italic": face.italic,
                "latin": face.latin,
                "cjk": face.cjk,
                "intervals": [[start, end] for start, end in face.intervals],
            }
            for face in _scan_file(Path(raw))  # unreadable files yield []
        ]
        _yield_between_files()
    _write_json(Path(job["out"]), {"files": files})


def _scan_local_files(job: dict[str, Any]) -> None:
    from fontalloy_core.family_docs import face_scan_to_json, scan_file_faces
    from fontalloy_core.local_fonts import yield_between_files

    files: dict[str, dict[str, Any]] = {}
    for raw in job["paths"]:
        try:
            scans = scan_file_faces(Path(raw))
            files[raw] = {"error": None, "scans": [face_scan_to_json(s) for s in scans]}
        except MemoryError:
            raise
        except Exception as exc:  # the in-process scan's verdict, verbatim
            files[raw] = {
                "error": f"file is not a valid font: {raw} ({exc})",
                "scans": [],
            }
        yield_between_files()
    _write_json(Path(job["out"]), {"files": files})


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
