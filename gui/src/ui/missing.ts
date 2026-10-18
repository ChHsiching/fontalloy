/**
 * The missing-glyph scope (round 5, owner item 4; single pick added
 * round 19): the 缺失 category.
 *
 * The prototype's 缺失 group counts (and views) the characters of its
 * browsed scope that the current merge cannot render. The GUI's honest
 * equivalent, made AUTOMATIC: every VISIBLE codepoint of the browsable
 * universe (the chip taxonomy's blocks — the same scope the grid and
 * the coverage percentage count) that the picks do not cover.
 *
 * Covered is the UNION of the picked faces' coverage — one or two
 * (round 19: browsing a single font still judges it against the
 * universe; waiting for the second pick hid the category exactly when
 * the user was studying one font's gaps). No preset is required and
 * nothing accretes point by point: the set exists exactly when at
 * least one pick exists and the coverage leaves gaps. With no pick at
 * all there is nothing to judge, so the set is empty and the chip
 * stays away.
 *
 * Ticket #36: the coverage is the serve's run-length interval data on
 * the picks' records — interval subtraction over the universe, never a
 * page-side cmap parse. The paged view materializes the gap runs once
 * per picks change (memoized).
 */

import { store, type LoadedFont } from "../state";
import { pickRefs } from "../precedence/picks";
import { BROWSE_UNIVERSE } from "../unicode/universe";
import {
  materializeIntervals,
  subtractIntervals,
  unionIntervals,
} from "../unicode/intervalMath";

export {
  BROWSE_UNIVERSE,
  browseUniverseSize,
  isCjkRegionCodepoint,
} from "../unicode/universe";

/** The synthetic category id of the missing view (not a unicode block). */
export const MISSING_CATEGORY_ID = "missing";

/** The memoized missing list (recomputed when the picks change). */
let memo: { signature: string; missing: number[] } | null = null;

/**
 * Every visible codepoint of the browsable universe that NO picked
 * font covers (ascending; empty until at least one pick exists).
 */
export function missingCodepoints(): number[] {
  const state = store.get();
  const picks = pickRefs();
  const signature = `${state.fonts
    .map((f) => `${f.cssFamily}:${f.intervals.length}`)
    .join("|")}:${state.selected.en ?? ""}:${state.selected.cjk ?? ""}`;
  if (memo && memo.signature === signature) return memo.missing;

  let missing: number[] = [];
  if (picks.base !== null || picks.donor !== null) {
    // The covered side: whatever is picked (one or both), as merged
    // interval runs; the gap is the universe minus that union.
    const covered = unionOf([picks.base, picks.donor]);
    missing = materializeIntervals(
      subtractIntervals(BROWSE_UNIVERSE, covered),
    );
  }
  memo = { signature, missing };
  return missing;
}

/** The merged coverage runs of the picks that exist. */
function unionOf(picks: Array<LoadedFont | null>): ReturnType<typeof unionIntervals> {
  let union: ReturnType<typeof unionIntervals> = [];
  for (const pick of picks) {
    if (pick === null) continue;
    union = unionIntervals(union, pick.intervals);
  }
  return union;
}
