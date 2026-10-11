/**
 * Named-set interval data for the client-side precedence resolver
 * (issue #18): the same fc-lang payload the core resolver resolves
 * against (`fontalloy_core.precedence.BUILTIN_NAMED_SETS`), statically
 * rendered at build time into `../data/preset-sets.ts`.
 *
 * A preset is the UNION of its enabled sub-blocks (ticket #7): the
 * consumer composes the union of the blocks still enabled. This module
 * exists to compose such unions (and to answer "does set S cover
 * codepoint C") without shipping the parsing machinery — labels are
 * already sorted and disjoint per set.
 */

import { PRESET_SET_LABELS } from "../data/preset-sets";

/** An inclusive codepoint interval. */
export interface Interval {
  start: number;
  end: number;
}

function parseLabel(label: string): Interval {
  const dash = label.indexOf("-");
  if (dash === -1) {
    const value = Number.parseInt(label, 16);
    return { start: value, end: value };
  }
  return {
    start: Number.parseInt(label.slice(0, dash), 16),
    end: Number.parseInt(label.slice(dash + 1), 16),
  };
}

const PARSED_SETS = new Map<string, readonly Interval[]>();
for (const [name, labels] of Object.entries(PRESET_SET_LABELS)) {
  PARSED_SETS.set(name, labels.map(parseLabel));
}

/** Sort intervals and merge overlapping or adjacent ones. */
export function compressIntervals(
  intervals: readonly Interval[],
): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const current of sorted) {
    const last = merged[merged.length - 1];
    if (last && current.start <= last.end + 1) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push({ ...current });
    }
  }
  return merged;
}

/** The union of the named sets, as one sorted disjoint interval list. */
export function unionOfSets(names: readonly string[]): Interval[] {
  const pieces: Interval[] = [];
  for (const name of names) {
    const intervals = PARSED_SETS.get(name);
    if (intervals) pieces.push(...intervals);
  }
  return compressIntervals(pieces);
}

/** Does a sorted disjoint interval list cover `cp`? (binary search) */
export function intervalsCover(
  intervals: readonly Interval[],
  cp: number,
): boolean {
  let lo = 0;
  let hi = intervals.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const interval = intervals[mid]!;
    if (cp < interval.start) hi = mid - 1;
    else if (cp > interval.end) lo = mid + 1;
    else return true;
  }
  return false;
}

/** A recipe-syntax label per interval (`0x41` or `0x4E00-0x9FFF`). */
export function intervalLabels(intervals: readonly Interval[]): string[] {
  return intervals.map((interval) =>
    interval.start === interval.end
      ? `0x${interval.start.toString(16).toUpperCase()}`
      : `0x${interval.start.toString(16).toUpperCase()}-${interval.end
          .toString(16)
          .toUpperCase()}`,
  );
}
