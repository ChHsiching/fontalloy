import { store, type AppState } from "../state";
import { mountStatusBar, type StatusBar } from "../kit/statusBar";
import {
  liveDocument,
  lookupEntry,
  precedenceStore,
  precedenceVersion,
} from "../precedence/document";
import { pickRefs, type PickRefs } from "../precedence/picks";
import { missingCodepoints } from "./missing";
import { BROWSE_UNIVERSE, CJK_UNIVERSE } from "../unicode/universe";
import {
  countIntervals,
  intersectIntervals,
  unionIntervals,
} from "../unicode/intervalMath";

/**
 * Persistent bottom stats bar (ADR-0004), on the kit's StatusBar: the
 * prototype's color-coded counters — 字符 / 英文 / 中文 / 已调整 / 缺失
 * / 覆盖 — every number in tabular numerals, updating live as fonts,
 * rules, and the browsing context change. Every value is plain text —
 * nothing lives in hover-only tooltips.
 *
 * Scope (round 5, owner item 6 — the prototype's semantics; single
 * pick added round 19): the whole BROWSED UNIVERSE, not the union of
 * the fonts. The browsed universe is every visible codepoint of the
 * chip taxonomy's blocks — the same scope the character map pages
 * through and the 缺失 chip counts.
 *
 * - 字符: the browsed universe's size (with at least one pick: the
 *   constant total, exactly the prototype's readout);
 * - 英文 / 中文 (round 20, owner item 5 — SCRIPT REGION, not supplier):
 *   the covered universe codepoints OUTSIDE / INSIDE the CJK region
 *   (the 中日韩文字 group's blocks). Which pick supplies a glyph no
 *   longer moves the count: a lone CJK pick's Latin coverage lands in
 *   英文 (round 19 counted it into 中文), and the two regions partition
 *   the universe, so the invariant below holds by construction. The
 *   stack semantics stand — either pick covers a codepoint, both
 *   missing = missing (coverage-driven, no precedence involved);
 * - 缺失: the universe codepoints NO pick covers — the very cells the
 *   grid shows as dashed, visible the moment any pick exists and gaps
 *   remain, no preset involved;
 * - 已调整: codepoints a non-preset rule EFFECTIVELY moves away from
 *   their no-rule default supplier (round 8 — the same discipline as
 *   the grid's ov dot). Ticket #35: the count reads the landed
 *   precedence document's per-run `adjusted` flags — the serve's own
 *   verdict, clipped to the browsed universe by the walk itself. A
 *   lone pick can never be adjusted: one font means no rule can move
 *   the supplier (and without a document the counter reads 0);
 * - 覆盖: covered-by-either-font ÷ browsed-scope size — never "100%"
 *   while missing cells are on screen. Normal semantics (round 6,
 *   owner item 2): it counts the whole visible universe, so it carries
 *   no ?-popover — the explanation was noise.
 *
 * With 字符 = 英文 + 中文 + 缺失 holding under every pick state (the
 * counters all live inside the browsed universe), zero picks leaves
 * every counter at 0 — nothing to judge.
 */

interface LiveStats {
  total: number;
  en: number;
  cjk: number;
  adjusted: number;
  missing: number;
  coveragePct: string;
}

/** The computed six counters, memoized on their inputs. */
let statsMemo: { signature: string; stats: LiveStats } | null = null;

function computeStats(state: AppState, picks: PickRefs): LiveStats {
  const signature = `${state.fonts.length}:${state.selected.en ?? ""}:${state.selected.cjk ?? ""}:${state.fonts
    .map((font) => `${font.cssFamily}:${font.intervals.length}`)
    .join("|")}:${state.rules
    .map((r) => `${r.id}:${JSON.stringify(r.target)}:${r.fonts.join(",")}`)
    .join("|")}:${precedenceVersion()}`;
  if (statsMemo && statsMemo.signature === signature) {
    return statsMemo.stats;
  }

  const hasPick = picks.base !== null || picks.donor !== null;
  const missing = hasPick ? missingCodepoints() : [];
  const doc = hasPick ? liveDocument() : null;

  let en = 0;
  let cjk = 0;
  let adjusted = 0;
  if (hasPick) {
    // Ticket #36: the counters read the picks' run-length coverage
    // intervals (the serve's scan data) — interval arithmetic over the
    // browsed universe, classified by SCRIPT REGION (round 20: a
    // covered codepoint counts where it SITS, inside the 中日韩文字
    // region → 中文, everywhere else of the universe → 英文). 已调整
    // reads the document's run flags (the walk clips them to the
    // universe by construction).
    let covered: ReturnType<typeof unionIntervals> = [];
    for (const pick of [picks.base, picks.donor]) {
      if (pick !== null) covered = unionIntervals(covered, pick.intervals);
    }
    const universe = intersectIntervals(covered, BROWSE_UNIVERSE);
    cjk = countIntervals(intersectIntervals(universe, CJK_UNIVERSE));
    en = countIntervals(universe) - cjk;
    if (doc !== null) {
      for (const [start, end] of universe) {
        let entry = lookupEntry(doc, start);
        for (let cp = start; cp <= end; cp++) {
          const next = lookupEntry(doc, cp);
          if (next !== entry) entry = next;
          if (entry !== null && entry.adjusted) adjusted++;
        }
      }
    }
  }
  const total = hasPick ? en + cjk + missing.length : 0;
  const pct = total > 0 ? ((100 * (en + cjk)) / total).toFixed(2) : "0.00";
  const stats = { total, en, cjk, adjusted, missing: missing.length, coveragePct: pct };
  statsMemo = { signature, stats };
  return stats;
}

export function mountStatsbar(root: HTMLElement): StatusBar {
  const bar = mountStatusBar(root);
  bar.el.classList.add("statsbar", "enter");
  bar.el.style.animationDelay = "120ms";

  const render = (): void => {
    bar.render(computeStats(store.get(), pickRefs()));
  };
  store.subscribe(render);
  precedenceStore.subscribe(render);
  render();
  return bar;
}
