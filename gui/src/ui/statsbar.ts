import { store, type AppState } from "../state";
import { mountStatusBar, type StatusBar } from "../kit/statusBar";
import { currentResolver, defaultResolver } from "../precedence/live";
import { isAdjusted } from "../precedence/resolve";
import { pickRefs, type PickRefs } from "../precedence/picks";
import { missingCodepoints, BROWSE_UNIVERSE } from "./missing";

/**
 * Persistent bottom stats bar (ADR-0004), on the kit's StatusBar: the
 * prototype's color-coded counters — 字符 / 英文 / 中文 / 已调整 / 缺失
 * / 覆盖 — every number in tabular numerals, updating live as fonts,
 * rules, and the browsing context change. Every value is plain text —
 * nothing lives in hover-only tooltips.
 *
 * Scope (round 5, owner item 6 — the prototype's semantics): the whole
 * BROWSED UNIVERSE, not the union of the fonts. The browsed universe is
 * every visible codepoint of the chip taxonomy's blocks — the same
 * scope the character map pages through and the 缺失 chip counts.
 *
 * - 字符: the browsed universe's size (with both picks: the constant
 *   total, exactly the prototype's readout);
 * - 英文 / 中文: the universe codepoints the merge renders from the
 *   base / the donor (rules included);
 * - 缺失: the universe codepoints NEITHER pick covers — the very cells
 *   the grid shows as dashed, visible the moment both picks exist, no
 *   preset involved;
 * - 已调整: codepoints a non-preset rule EFFECTIVELY moves away from
 *   their no-rule default supplier (round 8 — the same discipline as
 *   the grid's ov dot; see precedence/resolve.ts isAdjusted);
 * - 覆盖: covered-by-either-font ÷ browsed-scope size — never "100%"
 *   while missing cells are on screen. Normal semantics (round 6,
 *   owner item 2): it counts the whole visible universe, so it carries
 *   no ?-popover — the explanation was noise.
 *
 * Before both picks exist there is no merge to judge: the counters
 * then report the covered share of whatever IS picked (the lone-pick
 * preview) and 缺失 stays 0.
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

/** The browsed universe's visible intervals as flat bounds. */
const UNIVERSE_BOUNDS = BROWSE_UNIVERSE.map(([start, end]) => [start, end] as const);

/** Walk the universe, calling `visit` for every codepoint in scope. */
function forUniverseCodepoint(visit: (cp: number) => void): void {
  for (const [start, end] of UNIVERSE_BOUNDS) {
    for (let cp = start; cp <= end; cp++) visit(cp);
  }
}

function computeStats(state: AppState, picks: PickRefs): LiveStats {
  const signature = `${state.fonts.length}:${state.selected.en ?? ""}:${state.selected.cjk ?? ""}:${state.fonts
    .map((font) => `${font.cssFamily}:${font.codepoints.length}`)
    .join("|")}:${state.rules
    .map((r) => `${r.id}:${JSON.stringify(r.target)}:${r.fonts.join(",")}`)
    .join("|")}`;
  if (statsMemo && statsMemo.signature === signature) {
    return statsMemo.stats;
  }

  const hasPair = picks.base !== null && picks.donor !== null;
  const resolver = currentResolver(picks);
  const base = defaultResolver(picks);

  let en = 0;
  let cjk = 0;
  let adjusted = 0;
  if (hasPair) {
    // The full prototype readout: everything counts inside the browsed
    // universe, so 字符 is the constant universe size and en + cjk +
    // 缺失 always add up to it.
    forUniverseCodepoint((cp) => {
      const entry = resolver ? resolver.resolve(cp) : null;
      if (!entry) return;
      if (entry.winner === "base") en++;
      else cjk++;
      const baseEntry = base ? base.resolve(cp) : null;
      if (isAdjusted(entry, baseEntry)) adjusted++;
    });
  } else {
    // The lone-pick preview: count the covered union of whatever is
    // picked (unrestricted — the output font's real content), missing 0.
    const union = new Set<number>();
    for (const font of [picks.base, picks.donor]) {
      if (font === null) continue;
      for (const cp of font.codepoints) union.add(cp);
    }
    if (resolver) {
      for (const cp of union) {
        const entry = resolver.resolve(cp);
        if (!entry) continue;
        if (entry.winner === "base") en++;
        else cjk++;
        const baseEntry = base ? base.resolve(cp) : null;
        if (isAdjusted(entry, baseEntry)) adjusted++;
      }
    }
  }
  const missing = hasPair ? missingCodepoints().length : 0;
  const total = hasPair ? en + cjk + missing : en + cjk;
  const pct = total > 0 ? ((100 * (en + cjk)) / total).toFixed(2) : "0.00";
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
