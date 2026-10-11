import { store, selectedCoverage, type AppState } from "../state";
import { mountStatusBar, type StatusBar } from "../kit/statusBar";
import { currentResolver, defaultResolver } from "../precedence/live";
import { pickRefs, type PickRefs } from "../precedence/picks";
import { missingCodepoints } from "./missing";

/**
 * Persistent bottom stats bar (ADR-0004), on the kit's StatusBar: the
 * prototype's color-coded counters — 字符 / 英文 / 中文 / 已调整 / 缺失
 * / 覆盖 — every number in tabular numerals, updating live as fonts,
 * rules, and the browsing context change. Every value is plain text —
 * nothing lives in hover-only tooltips.
 *
 * Scope: the WHOLE MERGE (prototype parity — its counters never change
 * with the browsing category). The merge universe is every codepoint
 * the picks cover (the output font's real content) plus every gap of
 * the declared 文字范围 scope (the codepoints the merge owes but
 * cannot render). Within it: 英文 counts base winners, 中文 donor
 * winners, 已调整 counts effective winners that differ from the
 * no-rule default, and 缺失 is the uncovered remainder. 覆盖 is the
 * covered share of the universe.
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
    .map((font) => `${font.cssFamily}:${font.codepoints.length}`)
    .join("|")}:${state.rules
    .map((r) => `${r.id}:${JSON.stringify(r.target)}:${r.fonts.join(",")}`)
    .join("|")}`;
  if (statsMemo && statsMemo.signature === signature) {
    return statsMemo.stats;
  }

  // Any pick resolves (a lone base pick previews like the old 已选覆盖);
  // with no picks at all there is nothing to measure yet.
  const union = selectedCoverage(state);
  const measurable = picks.refs.length > 0;
  const resolver = measurable ? currentResolver(picks) : null;
  const base = measurable ? defaultResolver(picks) : null;

  let en = 0;
  let cjk = 0;
  let adjusted = 0;
  if (resolver) {
    for (const cp of union) {
      const entry = resolver.resolve(cp);
      if (!entry) continue;
      if (entry.winner === "base") en++;
      else cjk++;
      const baseEntry = base ? base.resolve(cp) : null;
      if (baseEntry && baseEntry.winner !== entry.winner) adjusted++;
    }
  }
  // The declared-scope gaps no pick covers (whole-merge 缺失; the
  // surrogate gap is never renderable and never counted).
  const missing = missingCodepoints().length;
  const covered = en + cjk;
  const total = covered + missing;
  const pct = total > 0 ? ((100 * covered) / total).toFixed(2) : "0.00";
  const stats = { total, en, cjk, adjusted, missing, coveragePct: pct };
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
  render();
  return bar;
}
