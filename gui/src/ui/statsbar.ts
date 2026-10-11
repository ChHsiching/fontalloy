import { store, selectedCoverage, type AppState } from "../state";
import { mountStatusBar, type StatusBar } from "../kit/statusBar";
import { currentResolver, defaultResolver } from "../precedence/live";
import { pickRefs, type PickRefs } from "../precedence/picks";
import { categoryIntervals, categorySize } from "../unicode/blocks";

/**
 * Persistent bottom stats bar (ADR-0004), on the kit's StatusBar: the
 * prototype's color-coded counters — 字符 / 英文 / 中文 / 已调整 / 缺失
 * / 覆盖 — every number in tabular numerals, updating live as fonts,
 * rules, and the browsing context change. Every value is plain text —
 * nothing lives in hover-only tooltips.
 *
 * Scope: the ACTIVE category (the grid in view) — the same scope the
 * prototype's counters had over its curated catalog. Within it, every
 * codepoint covered by the pick pair resolves through the live
 * effective resolver: 英文 counts base winners, 中文 donor winners,
 * 已调整 counts effective winners that differ from the no-rule default,
 * and 缺失 is the category size minus the covered count.
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

function inCategory(categoryId: string, cp: number): boolean {
  for (const interval of categoryIntervals(categoryId)) {
    if (cp >= interval.start && cp <= interval.end) return true;
  }
  return false;
}

function computeStats(state: AppState, picks: PickRefs): LiveStats {
  const signature = `${state.categoryId}:${state.fonts.length}:${state.selected.en ?? ""}:${state.selected.cjk ?? ""}:${state.fonts
    .map((font) => `${font.cssFamily}:${font.codepoints.length}`)
    .join("|")}:${state.rules
    .map((r) => `${r.id}:${JSON.stringify(r.target)}:${r.fonts.join(",")}`)
    .join("|")}`;
  if (statsMemo && statsMemo.signature === signature) {
    return statsMemo.stats;
  }

  const total = categorySize(state.categoryId);
  const union = selectedCoverage(state);
  // Any pick resolves (a lone base pick previews like the old 已选覆盖);
  // with no picks at all there is nothing to measure yet.
  const measurable = picks.refs.length > 0;
  const resolver = measurable ? currentResolver(picks) : null;
  const base = measurable ? defaultResolver(picks) : null;

  let en = 0;
  let cjk = 0;
  let adjusted = 0;
  let covered = 0;
  if (resolver) {
    for (const cp of union) {
      if (!inCategory(state.categoryId, cp)) continue;
      covered++;
      const entry = resolver.resolve(cp);
      if (!entry) continue;
      if (entry.winner === "base") en++;
      else cjk++;
      const baseEntry = base ? base.resolve(cp) : null;
      if (baseEntry && baseEntry.winner !== entry.winner) adjusted++;
    }
  }
  const missing = Math.max(0, total - covered);
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
