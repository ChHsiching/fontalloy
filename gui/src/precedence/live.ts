/**
 * The live effective resolver shared by the preview grid (issue #18)
 * and the real-world scenes (issue #19): one memoized
 * `EffectiveResolver` over the current rule state and pick coverages,
 * so every rendering of the effective merged result — cell or scene
 * character — resolves through the SAME client-side mirror of the core
 * precedence semantics.
 */

import { store } from "../state";
import { EffectiveResolver, arrayCoverage, type Coverage } from "./resolve";
import { pickRefs, type PickRefs } from "./picks";

let memo: { signature: string; resolver: EffectiveResolver | null } | null =
  null;

/** The memoized resolver for the current rules + picks (null: no pair). */
export function currentResolver(picks: PickRefs): EffectiveResolver | null {
  const { rules } = store.get();
  if (picks.refs.length === 0) return null;
  const signature = `${rules.length}:${rules
    .map((r) => `${r.id}:${JSON.stringify(r.target)}:${r.fonts.join(",")}`)
    .join("|")}:${picks.base?.cssFamily ?? ""}:${picks.donor?.cssFamily ?? ""}`;
  if (memo && memo.signature === signature) {
    return memo.resolver;
  }
  const coverages = new Map<string, Coverage | null>();
  if (picks.base) coverages.set("base", arrayCoverage(picks.base.codepoints));
  if (picks.donor) coverages.set("donor-0", arrayCoverage(picks.donor.codepoints));
  const resolver = new EffectiveResolver(rules, coverages);
  memo = { signature, resolver };
  return resolver;
}

/** Convenience: the resolver for the CURRENT picks (null: no pair). */
export function liveResolver(): { picks: PickRefs; resolver: EffectiveResolver | null } {
  const picks = pickRefs();
  return { picks, resolver: currentResolver(picks) };
}
