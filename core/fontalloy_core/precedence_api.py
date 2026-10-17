"""The precedence-resolve API document (ticket #28, spec #25).

The resolver as an API: the request carries the picks (font references
resolved exactly the way a build submission resolves them — the recipe
schema's parser, the load stage's face decoding, the placeholder-aware
coverage), the rules, and a universe spec; the response is the
effective table as COMPRESSED RUNS so the preview grid pages locally
with no per-cell requests.

Request (all bodies JSON)::

    POST /precedence-resolve
    {
      "picks":   {"base": "<font ref>", "donors": ["<font ref>", ...]},
      "rules":   [ ...the recipe rule schema, declaration order... ],
      "sets":    { "name": ["0x4E00-0x9FFF", ...] },
      "universe": {"intervals": ["0x41", "0x4E00-0x9FFF"]}
    }

- ``picks`` is required (``base`` mandatory, ``donors`` optional — a
  base-only merge is a valid resolve). Font references are the recipe's
  forms: path strings (resolved against the serve process's working
  directory), path#face pins, or catalog ``{family, variant, pattern}``
  mappings resolved against the serve's manifest.
- ``rules``/``sets`` are the recipe schema, parsed by the recipe's own
  code — one validation path, never duplicated. Codepoint targets are
  integers in JSON (YAML's ``0x4E2D`` literal has no JSON spelling).
- ``universe`` is optional (default: the whole merge). Its intervals
  bound the answer: the response covers ``universe ∩ coverage union``,
  so a full-range universe costs nothing beyond the fonts' real
  coverage. Interval entries are recipe-syntax strings ("0x4E00-0x9FFF"
  or "0x41") or plain integers.

Response::

    {
      "fonts": ["base", "donor-0"],          # the build's font ids
      "rules": 3,                            # declaration count
      "codepoints": 30002,                   # |universe ∩ coverage union|
      "runs": [                              # maximal same-answer stretches
        {"start": 65, "end": 66, "winner": "base", "via": "default",
         "kind": "base", "declared": null, "adjusted": false},
        ...
      ],
      "counts": {"base": 2, "fill": 30000, "override": 0},
      "conflicts": [ ...the report's same-layer conflict shape... ],
      "universe": ["0x41", "0x4E00-0x9FFF"]  # the echoed spec (or null)
    }

One run is one maximal stretch of consecutive codepoints sharing the
full answer tuple — ``winner``/``via``/``kind`` straight from the
resolver, plus the two grid semantics that replace the frontend's TS
mirror: ``declared`` (the covering rule's first font and granularity,
exposed even when that rule cannot supply — absence never overrides)
and ``adjusted`` (the 已调整 discipline: a non-set rule EFFECTIVELY
moved the winner off the no-rule default). A codepoint inside the
universe but in no run is covered by no font of the merge — the grid's
plain-preview fallback. The client looks runs up by binary search;
adjacent runs with equal tuples are merged, so a 30,000-codepoint CJK
stretch collapses into a handful of entries.

Determinism: the document is a pure function of the request — sorted
runs, fixed key order, no timestamps — so identical requests answer
byte-identically.

Synchronous by measurement: the worst realistic fixture (a
30,000-codepoint contiguous donor resolved against a zh_cn preset, a
range, and a codepoint rule) answers in about 4 s on the reference
machine while ``/health`` keeps answering on its own connection thread
(worst observed poll 0.2 s — the threaded server plus GIL preemption
keep the service live), so the endpoint needs none of the
build-submission queueing — measured and pinned by
``tests/test_serve_precedence.py``.
"""

from __future__ import annotations

import bisect
from pathlib import Path
from typing import Any

from fontalloy_core.errors import RecipeError
from fontalloy_core.load import load_faces
from fontalloy_core.placeholder import face_coverage
from fontalloy_core.precedence import (
    BUILTIN_NAMED_SETS,
    SET,
    VIA_DEFAULT,
    Interval,
    compress_intervals,
    default_font_order,
    interval_label,
    is_unicode_scalar,
    resolve_precedence,
    winner_selection_order,
)
from fontalloy_core.recipe import _parse_interval, parse_recipe

#: The request's top-level fields (mirrors the recipe field discipline).
REQUEST_FIELDS = ("picks", "rules", "sets", "universe")

#: The picks object's fields.
_PICKS_FIELDS = ("base", "donors")


def resolve_document(
    body: object,
    *,
    root: Path | str,
    manifest: Path | str | None = None,
    fonts_dir: Path | str | None = None,
) -> dict[str, Any]:
    """Resolve one precedence request to its response document.

    Raises :class:`~fontalloy_core.errors.RecipeError` for a request
    that violates the schema and whatever
    :class:`~fontalloy_core.errors.FontAlloyError` the load stage
    raises for unresolvable font references — the serve maps both to a
    400 response.
    """
    picks, rules_raw, sets_raw, universe = _parse_request(body)

    # The same validation a build submission goes through — picks,
    # rules, and sets ARE the recipe's fields, parsed by its code.
    recipe = parse_recipe(
        {
            "base": picks["base"],
            "donors": picks.get("donors", []),
            "rules": rules_raw,
            "sets": sets_raw,
        },
        root,
    )
    if recipe.base.is_catalog_ref or any(
        ref.is_catalog_ref for ref in recipe.donors
    ):
        from fontalloy_core.build import _resolve_catalog

        recipe = _resolve_catalog(recipe, manifest, fonts_dir)

    # Coverage per pick: the honest supply every absence-never-overrides
    # decision draws on — placeholder-aware, unioned over the pick's
    # faces (a collection pick supplies what any of its faces supply).
    coverages: dict[str, set[int]] = {
        "base": _pick_coverage(recipe.base, "base font")
    }
    for index, ref in enumerate(recipe.donors):
        coverages[f"donor-{index}"] = _pick_coverage(ref, f"donor font {index}")

    named_sets = {**BUILTIN_NAMED_SETS, **recipe.named_sets}
    resolution = resolve_precedence(
        recipe.rules, coverages=coverages, named_sets=named_sets
    )

    table = resolution.effective_table
    if universe is not None:
        starts = [start for start, _end in universe]
        table = tuple(
            entry
            for entry in table
            if _interval_covers(universe, starts, entry.codepoint)
        )

    return _document(
        recipe.rules, coverages, named_sets, universe, table, resolution.conflicts
    )


# --- request parsing -------------------------------------------------------


def _parse_request(
    body: object,
) -> tuple[dict, object, object, tuple[Interval, ...] | None]:
    """Split the request into picks/rules/sets/universe, strictly."""
    if not isinstance(body, dict):
        raise RecipeError(
            "precedence request must be a JSON object with the fields "
            f"{', '.join(repr(f) for f in REQUEST_FIELDS)}"
        )
    unknown = sorted(set(body) - set(REQUEST_FIELDS))
    if unknown:
        raise RecipeError(
            f"unknown precedence field {unknown[0]!r} "
            f"(the request accepts: {', '.join(REQUEST_FIELDS)})"
        )
    picks = body["picks"]
    if not isinstance(picks, dict):
        raise RecipeError(
            "precedence field 'picks' must be a mapping with 'base' (a font "
            "reference) and an optional 'donors' list"
        )
    unknown = sorted(set(picks) - set(_PICKS_FIELDS))
    if unknown:
        raise RecipeError(
            f"unknown picks field {unknown[0]!r} "
            f"(picks accepts: {', '.join(_PICKS_FIELDS)})"
        )
    if "base" not in picks:
        raise RecipeError(
            "precedence field 'picks.base' is required (a font reference)"
        )
    donors = picks.get("donors")
    if donors is not None and not isinstance(donors, list):
        raise RecipeError(
            "precedence field 'picks.donors' must be a list of font references"
        )
    return (
        picks,
        body.get("rules"),
        body.get("sets"),
        _parse_universe(body.get("universe")),
    )


def _parse_universe(raw: object) -> tuple[Interval, ...] | None:
    """The universe spec as sorted, disjoint intervals (None: no bound)."""
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise RecipeError(
            "precedence field 'universe' must be a mapping with an "
            "'intervals' list"
        )
    unknown = sorted(set(raw) - {"intervals"})
    if unknown:
        raise RecipeError(
            f"unknown universe field {unknown[0]!r} "
            "(universe accepts: intervals)"
        )
    entries = raw.get("intervals")
    if not isinstance(entries, list) or not entries:
        raise RecipeError(
            "precedence field 'universe.intervals' must be a non-empty list "
            'of interval strings like "0x4E00-0x9FFF" (or single codepoints)'
        )
    intervals: list[Interval] = []
    for index, entry in enumerate(entries):
        where = f"universe.intervals[{index}]"
        value: int | None = None
        if isinstance(entry, bool):
            value = None
        elif isinstance(entry, int):
            value = entry
        elif isinstance(entry, str) and "-" not in entry:
            try:
                value = int(entry, 0)
            except ValueError:
                value = None
        if value is not None:
            if not is_unicode_scalar(value):
                raise RecipeError(
                    f"precedence field '{where}' must be a Unicode scalar "
                    f"value (got {entry!r})"
                )
            intervals.append((value, value))
            continue
        try:
            intervals.append(_parse_interval(entry, where))
        except RecipeError as exc:
            # Same syntax, same failures — re-labeled for this field.
            raise RecipeError(
                str(exc).replace("recipe field", "precedence field", 1)
            ) from None
    return compress_intervals(intervals)


def _interval_covers(
    intervals: tuple[Interval, ...], starts: list[int], codepoint: int
) -> bool:
    """Does the sorted disjoint interval list cover ``codepoint``?"""
    index = bisect.bisect_right(starts, codepoint) - 1
    if index < 0:
        return False
    return codepoint <= intervals[index][1]


def _pick_coverage(ref, role: str) -> set[int]:
    """One pick's honest coverage: the placeholder-aware union over the
    faces its reference selects (the same loading a build performs)."""
    union: set[int] = set()
    for face in load_faces(ref, role=role):
        union |= set(face_coverage(face.font).codepoints)
    return union


# --- response assembly -----------------------------------------------------


def _document(
    rules,
    coverages: dict[str, set[int]],
    named_sets,
    universe: tuple[Interval, ...] | None,
    table,
    conflicts,
) -> dict[str, Any]:
    """The response document: runs, counts, conflicts — deterministic."""
    ordered = winner_selection_order(rules)
    by_index = {index: rule for index, rule in ordered}
    default_list = default_font_order(coverages)
    runs: list[dict[str, Any]] = []
    counts = {"base": 0, "fill": 0, "override": 0}
    current: dict[str, Any] | None = None
    current_key: tuple[Any, ...] | None = None
    for entry in table:
        declared = _declared_document(entry, by_index, ordered, named_sets)
        adjusted = _is_adjusted(entry, declared, default_list, coverages)
        key = (entry.winner, entry.via, entry.kind, repr(declared), adjusted)
        if (
            current is not None
            and current_key == key
            and current["end"] + 1 == entry.codepoint
        ):
            current["end"] = entry.codepoint
        else:
            current = {
                "start": entry.codepoint,
                "end": entry.codepoint,
                "winner": entry.winner,
                "via": entry.via,
                "kind": entry.kind,
                "declared": declared,
                "adjusted": adjusted,
            }
            current_key = key
            runs.append(current)
        counts[entry.kind] += 1
    return {
        "fonts": default_list,
        "rules": len(rules),
        "codepoints": len(table),
        "runs": runs,
        "counts": counts,
        "conflicts": [
            {
                "granularity": conflict.granularity,
                "shadowed": conflict.shadowed,
                "winner": conflict.winner,
                "overlap": [interval_label(span) for span in conflict.overlap],
                "codepoints": conflict.codepoints,
            }
            for conflict in conflicts
        ],
        "universe": (
            [interval_label(span) for span in universe]
            if universe is not None
            else None
        ),
    }


def _declared_document(
    entry, by_index: dict, ordered, named_sets
) -> dict[str, Any] | None:
    """The covering rule's first font and granularity (the assignment
    layer) — present even when the rule cannot supply the codepoint.

    ``via`` already names the covering rule whenever the rule supplies;
    only default-decided codepoints need the covering walk, through the
    module's own winner-selection order and ``covers`` predicate.
    """
    if entry.via != VIA_DEFAULT:
        index = int(entry.via.split("-", 1)[1])
    else:
        index = next(
            (
                candidate
                for candidate, rule in ordered
                if rule.covers(entry.codepoint, named_sets)
            ),
            None,
        )
    rule = by_index.get(index) if index is not None else None
    if rule is None or not rule.fonts:
        return None
    return {"font": rule.fonts[0], "granularity": rule.granularity}


def _is_adjusted(
    entry, declared: dict[str, Any] | None, default_list, coverages
) -> bool:
    """The 已调整 discipline (the grid's dot): a NON-SET rule
    effectively moved the winner off the no-rule default. A declaration
    whose fonts lack the glyph cannot move the winner (absence never
    overrides), so it carries no dot; preset rules never count.
    """
    if declared is None or declared["granularity"] == SET:
        return False
    default_winner = next(
        (
            font
            for font in default_list
            if entry.codepoint in coverages[font]
        ),
        None,
    )
    return entry.winner != default_winner
