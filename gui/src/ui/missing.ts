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
 * Covered is the UNION of the picked fonts' effective cmaps — one or
 * two (round 19: browsing a single font still judges it against the
 * universe; waiting for the second pick hid the category exactly when
 * the user was studying one font's gaps). No preset is required and
 * nothing accretes point by point: the set exists exactly when at
 * least one pick exists and the coverage leaves gaps, computed from
 * the cmaps alone. With no pick at all there is nothing to judge, so
 * the set is empty and the chip stays away.
 */

import { store } from "../state";
import { pickRefs } from "../precedence/picks";
import { BROWSE_UNIVERSE } from "../unicode/universe";

export { BROWSE_UNIVERSE, browseUniverseSize } from "../unicode/universe";

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
    .map((f) => `${f.cssFamily}:${f.codepoints.length}`)
    .join("|")}:${state.selected.en ?? ""}:${state.selected.cjk ?? ""}`;
  if (memo && memo.signature === signature) return memo.missing;

  const missing: number[] = [];
  // The covered side: whatever is picked (one or both), merged by the
  // two-cursor walk over the sorted cmaps.
  const base = picks.base !== null ? picks.base.codepoints : [];
  const donor = picks.donor !== null ? picks.donor.codepoints : [];
  if (picks.base !== null || picks.donor !== null) {
    let bi = 0;
    let di = 0;
    for (const [start, end] of BROWSE_UNIVERSE) {
      while (bi < base.length && base[bi]! < start) bi++;
      while (di < donor.length && donor[di]! < start) di++;
      for (let cp = start; cp <= end; cp++) {
        while (bi < base.length && base[bi]! < cp) bi++;
        while (di < donor.length && donor[di]! < cp) di++;
        if (base[bi] === cp || donor[di] === cp) continue;
        missing.push(cp);
      }
    }
  }
  memo = { signature, missing };
  return missing;
}
