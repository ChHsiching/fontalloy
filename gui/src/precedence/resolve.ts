/**
 * The client-side precedence resolver (issue #18): a faithful mirror of
 * `core/fontalloy_core/precedence.py`'s `resolve_precedence`, resolved
 * per codepoint on demand (the grid renders 1024 cells, not 1.1M).
 *
 * Consistency with the backend is a hard gate (ticket #18): the same
 * rule set must yield the same winners the real pipeline resolves. The
 * semantics below are therefore TRANSLATED, not reinvented:
 *
 * - Granularity ranks: codepoint > range > set (named preset). The
 *   narrowest rule covering a codepoint wins, regardless of order;
 *   within one layer the last declared wins.
 * - Absence never overrides: within the winning rule's ordered font
 *   list, fonts lacking the codepoint are skipped; when no listed font
 *   holds it the GLOBAL DEFAULT supplies the codepoint (base first,
 *   then donors in join order) — the rule "cannot supply" and the
 *   codepoint behaves as if unruled.
 * - `kind`: the base font's own glyph = "base"; a donor filling a slot
 *   the base lacks = "fill"; a rule displacing a base glyph =
 *   "override".
 *
 * The seam-3 suite pins the mirror against the real serve: it builds a
 * rule set exercising every granularity, walks the grid's resolution,
 * then runs the IDENTICAL recipe through a real `fontalloy serve` build
 * and compares the report's per-codepoint winner/via/kind.
 */

import type { CompleteRule, EditorRule } from "./model";
import { completeRules } from "./model";
import { unionOfSets, intervalsCover, type Interval } from "./sets";

/** Coverage of one font of the build, looked up per codepoint. */
export interface Coverage {
  has(cp: number): boolean;
}

/** How a codepoint's winner was chosen. */
export interface EffectiveEntry {
  /** Font ref: `base` or `donor-<index>`. */
  winner: string;
  /** `default`, or the winning rule's id (`rule-<declaration index>`). */
  via: string;
  kind: "base" | "fill" | "override";
}

/** Granularity ranks, narrowest first (the order IS the precedence). */
const RANK: Record<string, number> = { codepoint: 3, range: 2, set: 1 };

/** One resolved rule: its rank, declaration index, and target coverage. */
interface RankedRule {
  index: number;
  rank: number;
  via: string;
  fonts: readonly string[];
  covers(cp: number): boolean;
}

/**
 * The resolver over one rule state + coverage map. Build once per state
 * change; query per cell. `null` coverage entries (a pick not made yet)
 * drop that font from the build entirely.
 */
export class EffectiveResolver {
  private readonly coverages: Map<string, Coverage>;
  private readonly baseCoverage: Coverage | null;
  private readonly defaultList: string[];
  private readonly ordered: RankedRule[];

  constructor(
    rules: readonly EditorRule[],
    coverages: ReadonlyMap<string, Coverage | null>,
  ) {
    this.coverages = new Map();
    for (const [ref, coverage] of coverages) {
      if (coverage !== null) this.coverages.set(ref, coverage);
    }
    this.baseCoverage = this.coverages.get("base") ?? null;

    // The global default: base first, then donors in join order.
    this.defaultList = [...this.coverages.keys()].sort((a, b) => {
      if (a === "base") return -1;
      if (b === "base") return 1;
      const na = Number(a.slice("donor-".length));
      const nb = Number(b.slice("donor-".length));
      return na - nb;
    });

    // Winner selection order: narrowest granularity first, and within a
    // layer the last declared — the first rule covering a codepoint in
    // this order is the winning rule (mirrors the core's sort key).
    const complete = completeRules(rules);
    const named = new Map<string, Interval[]>();
    const ranked: RankedRule[] = complete.map((entry: CompleteRule, i) => {
      const { rule, via } = entry;
      const target = rule.target;
      if (target.kind === "preset") {
        const union = unionOfSets(target.blocks);
        named.set(via, union);
        return {
          index: i,
          rank: RANK.set!,
          via,
          fonts: rule.fonts,
          covers: (cp: number) => intervalsCover(union, cp),
        };
      }
      if (target.kind === "range") {
        const lo = Math.min(target.start!, target.end!);
        const hi = Math.max(target.start!, target.end!);
        return {
          index: i,
          rank: RANK.range!,
          via,
          fonts: rule.fonts,
          covers: (cp: number) => cp >= lo && cp <= hi,
        };
      }
      return {
        index: i,
        rank: RANK.codepoint!,
        via,
        fonts: rule.fonts,
        covers: (cp: number) => cp === target.cp,
      };
    });
    this.ordered = ranked.sort((a, b) => b.rank - a.rank || b.index - a.index);
  }

  /** The default font list the resolver falls back to. */
  get defaults(): readonly string[] {
    return this.defaultList;
  }

  /** Is any font of the build covering `cp` at all? */
  covered(cp: number): boolean {
    for (const coverage of this.coverages.values()) {
      if (coverage.has(cp)) return true;
    }
    return false;
  }

  /**
   * The effective entry for `cp`, or null when NO font of the build
   * covers it (nothing in the merge to preview — the grid then falls
   * back to the plain preview stack).
   */
  resolve(cp: number): EffectiveEntry | null {
    const firstHolder = (fonts: readonly string[]): string | null => {
      for (const ref of fonts) {
        if (this.coverages.get(ref)?.has(cp)) return ref;
      }
      return null;
    };

    for (const rule of this.ordered) {
      if (!rule.covers(cp)) continue;
      const winner = firstHolder(rule.fonts);
      if (winner !== null) return this.entry(cp, winner, rule.via);
      break; // the rule won but cannot supply: the default fills
    }
    const winner = firstHolder(this.defaultList);
    if (winner === null) return null;
    return this.entry(cp, winner, "default");
  }

  private entry(cp: number, winner: string, via: string): EffectiveEntry {
    const kind = this.baseCoverage?.has(cp)
      ? winner === "base"
        ? "base"
        : "override"
      : "fill";
    return { winner, via, kind };
  }
}

/** Sorted-array coverage (the registry's codepoints are sorted). */
export function arrayCoverage(codepoints: readonly number[]): Coverage {
  return {
    has(cp: number): boolean {
      let lo = 0;
      let hi = codepoints.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const value = codepoints[mid]!;
        if (value === cp) return true;
        if (value < cp) lo = mid + 1;
        else hi = mid - 1;
      }
      return false;
    },
  };
}
