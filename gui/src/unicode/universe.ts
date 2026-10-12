/**
 * The browsable universe (round 5): the VISIBLE codepoints of the chip
 * taxonomy's blocks — the denominator of the coverage percentage and
 * the scope the 缺失 set lives in. Pure data geometry (no store, no
 * JSON imports) so tests can import it directly.
 */

import { ALL_BLOCKS } from "./blocks";
import { VISIBLE_INTERVALS } from "./visible";

/** First index of VISIBLE_INTERVALS whose interval can overlap `from`. */
function firstVisibleFrom(from: number): number {
  let lo = 0;
  let hi = VISIBLE_INTERVALS.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (VISIBLE_INTERVALS[mid]![1] < from) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function intersect(
  intervals: ReadonlyArray<{ start: number; end: number }>,
): Array<readonly [number, number]> {
  const out: Array<readonly [number, number]> = [];
  // Blocks are declared in TAXONOMY order, not codepoint order (the CJK
  // group lists the compatibility block before the unified one), so
  // each interval finds its starting visible interval by search — a
  // shared forward cursor would skip everything after a backwards step.
  for (const interval of intervals) {
    for (let j = firstVisibleFrom(interval.start); j < VISIBLE_INTERVALS.length; j++) {
      const [visStart, visEnd] = VISIBLE_INTERVALS[j]!;
      if (visStart > interval.end) break;
      const start = Math.max(visStart, interval.start);
      const end = Math.min(visEnd, interval.end);
      if (start <= end) out.push([start, end]);
    }
  }
  return out;
}

/**
 * The taxonomy blocks' enumeration intervals, in declaration order —
 * curated intervals included (the 图标 group contributes the Nerd Font
 * PUA planes, not their raw envelope).
 */
export const BLOCK_UNIVERSE: ReadonlyArray<{ start: number; end: number }> =
  ALL_BLOCKS.flatMap((block) =>
    block.intervals
      ? block.intervals.map(([start, end]) => ({ start, end }))
      : [{ start: block.start, end: block.end }],
  );

/** The browsable universe's visible intervals (sorted, disjoint). */
export const BROWSE_UNIVERSE: ReadonlyArray<readonly [number, number]> =
  intersect(BLOCK_UNIVERSE).sort((a, b) => a[0] - b[0]);

/** The browsable universe's visible codepoint count. */
export function browseUniverseSize(): number {
  return BROWSE_UNIVERSE.reduce(
    (sum, [start, end]) => sum + (end - start + 1),
    0,
  );
}
