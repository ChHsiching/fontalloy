"""Split a TTC collection into standalone TTF faces (test-side tooling).

Chromium's OTS gate is fed through @font-face, which takes single fonts
— collections are not a web-font format — so the OTS spec (round 19)
splits every face of a ttc artifact out with fontTools before handing
each face to the gate.

Honesty note: ``font.save()`` re-serializes each face (table offsets
and ``head.checkSumAdjustment`` are recomputed), so the split faces are
not byte-carves of the collection. The collection's own serialized
bytes stay covered by the ttf and woff2 artifacts of the same pipeline;
this tool exists only to give the gate a loadable view of each face.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from fontTools.ttLib import TTCollection


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ttc", type=Path, help="the .ttc collection to split")
    parser.add_argument(
        "--out-dir",
        type=Path,
        required=True,
        help="directory the face-<n>.ttf files are written into",
    )
    args = parser.parse_args()

    args.out_dir.mkdir(parents=True, exist_ok=True)
    # TTCollection with lazy=False (the default) parses every face and
    # every table up front — a face fontTools cannot read fails loudly.
    collection = TTCollection(str(args.ttc))
    if not collection.fonts:
        print("collection holds no faces", file=sys.stderr)
        return 1
    paths: list[str] = []
    for index, font in enumerate(collection.fonts):
        target = args.out_dir / f"face-{index}.ttf"
        font.save(str(target))
        paths.append(str(target))
    # One JSON line on stdout: the machine contract the spec consumes.
    print(json.dumps(paths))
    return 0


if __name__ == "__main__":
    sys.exit(main())
