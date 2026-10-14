import { store, type AppState } from "../state";
import { mountStatusBar, type StatusBar } from "../kit/statusBar";
import { currentResolver, defaultResolver } from "../precedence/live";
import { isAdjusted } from "../precedence/resolve";
import { pickRefs, type PickRefs } from "../precedence/picks";
import { missingCodepoints, BROWSE_UNIVERSE, isCjkRegionCodepoint } from "./missing";

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
 *   missing = missing;
 * - 缺失: the universe codepoints NO pick covers — the very cells the
 *   grid shows as dashed, visible the moment any pick exists and gaps
 *   remain, no preset involved;
 * - 已调整: codepoints a non-preset rule EFFECTIVELY moves away from
 *   their no-rule default supplier (round 8 — the same discipline as
 *   the grid's ov dot; see precedence/resolve.ts isAdjusted). A lone
 *   pick can never be adjusted: one font means no rule can move the
 *   supplier;
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

  const hasPick = picks.base !== null || picks.donor !== null;
  const resolver = currentResolver(picks);
  const base = defaultResolver(picks);

  let en = 0;
  let cjk = 0;
  let adjusted = 0;
  if (hasPick) {
    // The prototype readout under every pick state (round 19): one or
    // two picks, everything counts inside the browsed universe, so
    // 字符 is the constant universe size and en + cjk + 缺失 always add
    // up to it. Round 20 classifies by SCRIPT REGION: a covered
    // codepoint counts where it SITS (inside the 中日韩文字 region →
    // 中文, everywhere else of the universe → 英文), never by which
    // pick supplies it. Resolution still walks every covered codepoint
    // for the 已调整 verdict (adjusted stays 0 with a lone pick — one
    // font means no rule can move a supplier).
    forUniverseCodepoint((cp) => {
      const entry = resolver ? resolver.resolve(cp) : null;
      if (!entry) return;
      if (isCjkRegionCodepoint(cp)) cjk++;
      else en++;
      const baseEntry = base ? base.resolve(cp) : null;
      if (isAdjusted(entry, baseEntry)) adjusted++;
    });
  }
  const missing = hasPick ? missingCodepoints().length : 0;
  const total = hasPick ? en + cjk + missing : 0;
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
