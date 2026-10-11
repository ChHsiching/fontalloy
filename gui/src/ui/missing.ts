/**
 * The missing-glyph scope (design-fidelity round 1): the 缺失 category.
 *
 * The prototype's 缺失 group counts (and views) the characters of the
 * donor-language scope that the current merge cannot render. The GUI's
 * honest equivalent: every codepoint of the DECLARED language-preset
 * scope (the 文字范围 rules' enabled sub-blocks) that the effective
 * precedence resolver says NO picked font covers. With no preset rules
 * there is no declared scope, so the count is 0 and the chip stays away.
 */

import { store } from "../state";
import { currentResolver } from "../precedence/live";
import { pickRefs } from "../precedence/picks";
import { unionOfSets, type Interval } from "../precedence/sets";

/** The synthetic category id of the missing view (not a unicode block). */
export const MISSING_CATEGORY_ID = "missing";

/** The declared scope: the union of every preset rule's enabled blocks. */
function scopeIntervals(): Interval[] {
  const names: string[] = [];
  for (const rule of store.get().rules) {
    if (rule.target.kind !== "preset") continue;
    names.push(...rule.target.blocks);
  }
  if (names.length === 0) return [];
  return unionOfSets(names);
}

/** The memoized missing list (recomputed when fonts or rules change). */
let memo: { signature: string; missing: number[] } | null = null;

/**
 * Every codepoint of the declared preset scope that no picked font
 * covers (ascending; empty with no preset rules or no picks).
 */
export function missingCodepoints(): number[] {
  const state = store.get();
  const signature = `${state.rules
    .map((r) => `${r.id}:${JSON.stringify(r.target)}`)
    .join("|")}:${state.fonts
    .map((f) => `${f.cssFamily}:${f.codepoints.length}`)
    .join("|")}:${state.selected.en ?? ""}:${state.selected.cjk ?? ""}`;
  if (memo && memo.signature === signature) return memo.missing;

  const missing: number[] = [];
  const picks = pickRefs();
  const resolver = picks.refs.length > 0 ? currentResolver(picks) : null;
  if (resolver !== null) {
    for (const { start, end } of scopeIntervals()) {
      // The surrogate gap is never renderable; the resolver would call
      // every one of those "missing" and drown the real signal.
      for (let cp = start; cp <= end; cp++) {
        if (cp >= 0xd800 && cp <= 0xdfff) continue;
        if (resolver.resolve(cp) === null) missing.push(cp);
      }
    }
  }
  memo = { signature, missing };
  return missing;
}
