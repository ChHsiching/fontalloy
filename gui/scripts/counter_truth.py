"""Ground-truth coverage counter for the status-bar verification spec.

An INDEPENDENT implementation (fontTools) of the same effective-coverage
spec the GUI's own sfnt reader (gui/src/fonts/sfnt.ts) implements — the
counters under test must never be fed by the code path that computes
them, so the e2e spec shells out here and counts the union/regions
itself (gui/tests/countertruth.spec.ts). The spec being mirrored:

- cmap subtable choice: the same platform/encoding/format precedence
  ((3,10,12) > (0,*,12) > (0,4)/(3,1,4) > (0,6) > (3,0,4)), first
  record with the top score wins;
- glyph-0 mappings are absent by convention;
- a glyph whose outline equals the font's own .notdef outline is a
  suspected placeholder (its codepoints read as missing);
- a glyph absorbing 64 or more mapped codepoints is a mass-duplicated
  placeholder whatever its outline.

Outline equality via fontTools recording pens over the glyph set
(composites decompose with their transforms), with the same cheap
pre-filter the GUI applies: a simple .notdef only ever suspects glyphs
sharing its contour count, bounding box, and point count. glyf-backed
faces only — a CFF face would need the charstring compare, which this
helper refuses loudly instead of guessing.

Usage: python counter_truth.py FONT [FONT...] → one JSON document on
stdout: { "<path>": { family, display, raw, effective, codepoints[] } }
with `codepoints` the sorted effective coverage (decimal ints).
"""

from __future__ import annotations

import json
import sys

from fontTools.pens.recordingPen import RecordingPen
from fontTools.ttLib import TTFont

# The mass-duplication threshold (core placeholder.py's constant).
MASS_DUPLICATION_THRESHOLD = 64


def subtable_score(platform: int, encoding: int, fmt: int) -> int:
    if platform == 3 and encoding == 10 and fmt == 12:
        return 5
    if platform == 0 and fmt == 12:
        return 4
    if platform == 0 and fmt == 4:
        return 3
    if platform == 3 and encoding == 1 and fmt == 4:
        return 3
    if platform == 0 and fmt == 6:
        return 2
    if platform == 3 and encoding == 0 and fmt == 4:
        return 1
    return -1


def pick_subtable(font: TTFont):
    """The one cmap subtable the GUI's scoring would read."""
    best = None
    best_score = -1
    for table in font["cmap"].tables:
        score = subtable_score(table.platformID, table.platEncID, table.format)
        if score > best_score:
            best = table
            best_score = score
    return best


def shape_key(glyph) -> tuple | None:
    """The pre-filter key of a glyf record (None for composites/empty)."""
    contours = glyph.numberOfContours
    if contours is None or contours <= 0:
        return None
    return (
        contours,
        glyph.xMin,
        glyph.yMin,
        glyph.xMax,
        glyph.yMax,
        len(glyph.coordinates),
    )


def outline(font: TTFont, name: str):
    """One glyph's decomposed outline as a comparable recording."""
    pen = RecordingPen()
    font.getGlyphSet()[name].draw(pen)
    return pen.value


def effective_coverage(path: str) -> dict:
    font = TTFont(path, fontNumber=0, lazy=True)
    if "glyf" not in font:
        raise SystemExit(f"{path}: not a glyf-backed face; the outline rule "
                         "would need the CFF charstring compare")
    subtable = pick_subtable(font)
    if subtable is None or subtable.format not in (4, 6, 12):
        raise SystemExit(f"{path}: no cmap subtable the GUI would read")

    # cp -> glyph id, glyph-0 mappings absent by convention.
    glyph_id = font.getGlyphID
    mapped = {cp: glyph_id(name) for cp, name in subtable.cmap.items()}
    mapped = {cp: gid for cp, gid in mapped.items() if gid != 0}

    # Mass duplication: one glyph absorbing >= 64 mapped codepoints.
    absorbed: dict[int, int] = {}
    for gid in mapped.values():
        absorbed[gid] = absorbed.get(gid, 0) + 1

    # The .notdef-outline rule. An empty .notdef (no contours) carries
    # no box evidence — the rule is off for the face entirely, as is a
    # .notdef whose decomposed outline is empty.
    glyf = font["glyf"]
    order = font.getGlyphOrder()
    notdef = glyf[".notdef"]
    notdef_key = shape_key(notdef)  # None when composite/empty
    notdef_outline = (
        None if notdef.numberOfContours == 0 else outline(font, order[0])
    )
    if notdef_outline == []:
        notdef_outline = None  # a blank .notdef suspects nothing

    suspect_cache: dict[int, bool] = {}

    def suspect(gid: int) -> bool:
        if absorbed.get(gid, 0) >= MASS_DUPLICATION_THRESHOLD:
            return True
        verdict = suspect_cache.get(gid)
        if verdict is None:
            verdict = False
            if notdef_outline is not None:
                glyph = glyf[order[gid]]
                key = shape_key(glyph)  # None when composite/empty
                # A simple .notdef pre-filters: only same-key simple
                # glyphs reach the compare. A composite .notdef (no key
                # of its own) sends every glyph to the full compare.
                if notdef_key is None or key == notdef_key:
                    verdict = outline(font, order[gid]) == notdef_outline
            suspect_cache[gid] = verdict
        return verdict

    codepoints = sorted(cp for cp, gid in mapped.items() if not suspect(gid))

    name_table = font["name"]
    family = name_table.getDebugName(16) or name_table.getDebugName(1)
    subfamily = name_table.getDebugName(17) or name_table.getDebugName(2)
    display = family if subfamily in (None, "", "Regular", "标准") else (
        family if subfamily in family else f"{family} {subfamily}"
    )
    return {
        "family": family,
        "display": display,
        "raw": len(mapped),
        "effective": len(codepoints),
        "codepoints": codepoints,
    }


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    print(json.dumps({path: effective_coverage(path) for path in argv[1:]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
