/**
 * Interval arithmetic over codepoint runs (ticket #36): the counters,
 * the missing view, and placeholder-styled cells are view-model
 * arithmetic over the serve's run-length coverage data — no parsing,
 * no per-codepoint font reads. Every face document carries its honest
 * coverage as sorted, disjoint, maximal `[start, end]` runs; these
 * helpers combine them exactly like the sets they stand for.
 */

/** One closed interval of codepoints. */
export type CpInterval = readonly [number, number];

/** Sorted, disjoint intervals (the document shape's invariant). */
export type CpIntervals = readonly CpInterval[];

/** Total codepoints inside sorted, disjoint intervals. */
export function countIntervals(intervals: CpIntervals): number {
  let total = 0;
  for (const [start, end] of intervals) total += end - start + 1;
  return total;
}

/** Merge two sorted-disjoint interval lists into their union. */
export function unionIntervals(a: CpIntervals, b: CpIntervals): CpInterval[] {
  const out: CpInterval[] = [];
  const push = (start: number, end: number): void => {
    const last = out[out.length - 1];
    if (last !== undefined && start <= last[1] + 1) {
      if (end > last[1]) out[out.length - 1] = [last[0], end];
      return;
    }
    out.push([start, end]);
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i]![0] <= b[j]![0]) push(a[i]![0], a[i]![1]), i++;
    else push(b[j]![0], b[j]![1]), j++;
  }
  for (; i < a.length; i++) push(a[i]![0], a[i]![1]);
  for (; j < b.length; j++) push(b[j]![0], b[j]![1]);
  return out;
}

/** The intersection of two sorted-disjoint interval lists. */
export function intersectIntervals(
  a: CpIntervals,
  b: CpIntervals,
): CpInterval[] {
  const out: CpInterval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i]![0], b[j]![0]);
    const end = Math.min(a[i]![1], b[j]![1]);
    if (start <= end) out.push([start, end]);
    if (a[i]![1] < b[j]![1]) i++;
    else j++;
  }
  return out;
}

/** ``a`` minus ``b`` (both sorted-disjoint). */
export function subtractIntervals(
  a: CpIntervals,
  b: CpIntervals,
): CpInterval[] {
  const out: CpInterval[] = [];
  let j = 0;
  for (const [start, end] of a) {
    let cursor = start;
    while (j < b.length && b[j]![1] < cursor) j++;
    let k = j;
    while (k < b.length && b[k]![0] <= end) {
      if (b[k]![0] > cursor) out.push([cursor, b[k]![0] - 1]);
      if (b[k]![1] >= cursor) cursor = b[k]![1] + 1;
      if (cursor > end) break;
      k++;
    }
    if (cursor <= end) out.push([cursor, end]);
  }
  return out;
}

/** Membership by binary search (the documents' sorted invariant). */
export function inIntervals(intervals: CpIntervals, cp: number): boolean {
  let lo = 0;
  let hi = intervals.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end] = intervals[mid]!;
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Materialize sorted-disjoint intervals as an ascending codepoint list. */
export function materializeIntervals(intervals: CpIntervals): number[] {
  const out: number[] = [];
  for (const [start, end] of intervals) {
    for (let cp = start; cp <= end; cp++) out.push(cp);
  }
  return out;
}
