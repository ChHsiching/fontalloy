import { store, type AppState } from "../state";
import { mountStatusBar, type StatusBar } from "../kit/statusBar";
import { mountHelpPopover, workedTable } from "../kit/helpPopover";
import { currentResolver, defaultResolver } from "../precedence/live";
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
 * - 已调整: effective winners that differ from the no-rule default;
 * - 覆盖: covered-by-either-font ÷ browsed-scope size — never "100%"
 *   while missing cells are on screen.
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
      if (baseEntry && baseEntry.winner !== entry.winner) adjusted++;
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
        if (baseEntry && baseEntry.winner !== entry.winner) adjusted++;
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

/** The 覆盖 help popover body (kit HelpPopover form). */
function buildCoverageHelp(): HTMLElement {
  const wrap = document.createElement("div");
  const note = (text: string): HTMLElement => {
    const p = document.createElement("p");
    p.className = "kit-sub";
    p.textContent = text;
    return p;
  };
  wrap.append(
    note("覆盖 = 已覆盖码位 ÷ 浏览范围码位总数。"),
    note("浏览范围：字符表分类列出的全部 Unicode 区块中可显示的码位（控制符、格式符、未定义码位不计）。"),
    workedTable(["项", "含义"], [
      ["已覆盖", "英文字体或中文字体任意一方包含，并计入成品"],
      ["缺失", "浏览范围内两款字体都不包含的码位"],
      ["字符", "浏览范围码位总数（选定两款字体后为固定值）"],
    ]),
    note("已选字体在浏览范围之外覆盖的码位（如罕见文字区块）不计入这个数字，但仍在成品字体中。"),
    note("覆盖与当前浏览的分类无关：无论正在看哪一类，这里统计的始终是整个浏览范围。"),
  );
  return wrap;
}

export function mountStatsbar(root: HTMLElement): StatusBar {
  const bar = mountStatusBar(root);
  bar.el.classList.add("statsbar", "enter");
  bar.el.style.animationDelay = "120ms";

  // The ? next to 覆盖 explains exactly what the number counts (never
  // a hover-only mystery — the popover is clickable page text).
  const help = mountHelpPopover({
    id: "coverage",
    title: "覆盖是什么",
    buttonLabel: "覆盖是什么",
    width: 340,
    build: buildCoverageHelp,
  });
  help.anchor.dataset.role = "help-coverage";
  bar.coverageLabel.after(help.anchor);

  const render = (): void => {
    bar.render(computeStats(store.get(), pickRefs()));
  };
  store.subscribe(render);
  render();
  return bar;
}
