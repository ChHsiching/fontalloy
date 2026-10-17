import { store } from "../state";
import {
  ALL_CATEGORY_ID,
  ALL_BLOCKS,
  BLOCK_GROUPS,
  CELLS_PER_PAGE,
  blockGroup,
  categorySize,
  categoryName,
  codepointIndex,
  findBlockOf,
  findGroupCategory,
  groupCategoryId,
  nthCodepoint,
  pageCountFor,
  type UnicodeBlock,
} from "../unicode/blocks";
import { newRule, parseCodepointInput, type EditorRule } from "../precedence/model";
import {
  deeperWinner,
  documentFor,
  liveDocument,
  lookupEntry,
  precedenceStore,
} from "../precedence/document";
import { pickRefs, refFont, type PickRefs } from "../precedence/picks";
import {
  beginSelectionGesture,
  canUndoSelection,
  clearSelectionUndo,
  extendSelection,
  mutateRules,
  undoSelection,
  undoRules,
  canUndoRules,
} from "../history";
import { cssFamily } from "../kit/pickerPopup";
import { fontDisplayName } from "../fonts/registry";
import type { LoadedFont } from "../state";
import { isIconCodepoint } from "../unicode/universe";
import { mountCharPopup, type CharPopupFacts } from "../kit/charPopup";
import { mountRangePopup } from "../kit/rangePopup";
import { mountCategoryChips, type CategoryChips } from "../kit/categoryChips";
import { mountActionBar, type ActionBar, type FontSide } from "../kit/actionBar";
import { mountMessageStack, type MessageStack } from "../kit/messages";
import { mountCharGrid, type CharGrid, type GridCellData } from "../kit/grid";
import type { IconName } from "../kit/icons";
import { MISSING_CATEGORY_ID, missingCodepoints } from "./missing";
import { liveNotice } from "./live";

/**
 * Character map (ADR-0004), assembled from the kit: the horizontal
 * two-level CategoryChips bar (group + block, with the 全部 aggregate
 * and per-group aggregates), the ActionBar (per-group and per-block
 * 用英文字体/用中文字体 segments — rendered whether or not both fonts
 * are picked, the defaults driving the pressed state like the
 * prototype — plus 多选/编码/撤销, the pager, the 已调整 legend, the
 * codepoint locator, and the 按编码指定 entry), and the effective grid.
 *
 * The grid renders the EFFECTIVE merged result: each cell reads the
 * landed precedence document (ticket #35 — `POST /precedence-resolve`
 * once per picks/rules change, the SERVE's own answer, never a
 * client-side mirror), rendered in the winning font's own face and
 * carrying its resolution as DOM attributes (`data-winner` /
 * `data-via` / `data-kind`) — the grid never lies, however complex
 * the rules, and what it shows is what the build resolves. Adjusted
 * cells carry the kit's corner dot, paired with the 已调整 legend: a
 * NON-PRESET rule that EFFECTIVELY changes the supplier — the
 * resolved winner differs from the no-rule default (round 8: the dot
 * means 实际生效; a declaration whose font lacks the glyph cannot move
 * the winner and carries no dot; the run's `adjusted` flag IS that
 * discipline, computed where the build computes it).
 *
 * Interaction surfaces (prototype parity, restored):
 *
 * - **the char popup** — a plain click opens the character's popup AT
 *   the cell: the 44px glyph in the winning font, `U+XXXX`, `来自 X`,
 *   one-click 用英文字体/用中文字体 (the carried side hidden), 恢复默认
 *   when an override exists, and the missing-glyph copy (两个字体均不
 *   含该字形 / the Nerd Font PUA sentence);
 * - **多选 mode** — the explicit multi-select mode: drag-paint and
 *   Shift-range arm ONLY inside it; the toolbar's batch variant applies
 *   one side to the whole selection and announces 批量调整完成;
 * - **the 按编码指定 popup** — the range-specify contract verbatim.
 *
 * The ActionBar's segments act through the rule state: assigning a
 * block or a group creates/updates exact range rules through
 * `mutateRules` (one undo entry per action), the batch variant applies
 * to the selection exactly like the popup (one range rule per
 * contiguous run, per-codepoint rules otherwise), and typing a
 * codepoint locates it. Every block/group application announces its
 * outcome through the kit's message stack (round 8, owner item 2) —
 * the plain-words breakdown (N switched supplier; M stayed because
 * the assigned font lacks the codepoint and the other 补字) plus the
 * undo hint, in a dismissable corner card that never reflows the
 * workspace.
 */

/** Whether `rule` targets exactly this codepoint. */
function targetsCodepoint(rule: EditorRule, cp: number): boolean {
  return rule.target.kind === "codepoint" && rule.target.cp === cp;
}

/** The rule whose target is exactly this codepoint, when one exists. */
function codepointRule(cp: number): EditorRule | undefined {
  return store.get().rules.find((rule) => targetsCodepoint(rule, cp));
}

/** Upsert a codepoint rule (the popup's side buttons). */
function applyCodepointSide(cp: number, side: FontSide): void {
  const picks = pickRefs();
  const wanted = side === "base" ? "base" : "donor-0";
  if (!picks.refs.includes(wanted)) return;
  // Prototype semantics (setOv): pressing the side the character
  // already carries WITHOUT its own override reverts the override —
  // the deeper layers (defaults, ranges) show through again. The
  // deeper winner is the serve's answer for the rules beneath the
  // codepoint layer (precedence/document.ts `deeperWinner`).
  const withoutOwn = store
    .get()
    .rules.filter((rule) => !targetsCodepoint(rule, cp));
  if (deeperWinner(cp) === wanted) {
    mutateRules(withoutOwn);
    return;
  }
  upsertCodepointRule(cp, sideRuleFonts(side));
}

/** Drop the codepoint rule targeting `cp` (the popup's 恢复默认). */
function removeCodepointRule(cp: number): void {
  mutateRules(
    store.get().rules.filter((rule) => !targetsCodepoint(rule, cp)),
  );
}

/* ---------------- the batch apply (multi mode) ---------------------- */

/** One maximal adjacent run of a sorted selection (gap-aware). */
interface SelectionRun {
  start: number;
  end: number;
}

/**
 * Split a sorted selection into maximal adjacent runs. Adjacent means
 * consecutive codepoint values, or the enumeration step over the
 * surrogate gap (U+D7FF → U+E000) — a shift-range across the gap in the
 * aggregate view is one run, not 2,048 fragments.
 */
function selectionRuns(sorted: readonly number[]): SelectionRun[] {
  const runs: SelectionRun[] = [];
  let start = sorted[0]!;
  let prev = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    const cp = sorted[i]!;
    const adjacent = cp === prev + 1 || (prev === 0xd7ff && cp === 0xe000);
    if (!adjacent) {
      runs.push({ start, end: prev });
      start = cp;
    }
    prev = cp;
  }
  runs.push({ start, end: prev });
  return runs;
}

/**
 * Batch apply: one action commits the chosen side for the WHOLE
 * selection, aggregated per the rule-state shape:
 *
 * - a contiguous selection becomes ONE range rule;
 * - anything else becomes one codepoint rule per selected codepoint,
 *   declared in ascending order.
 *
 * Existing codepoint rules over the selection drop first — a stale
 * narrower rule would outrank the batch forever — and an existing range
 * rule with the exact same bounds is replaced rather than duplicated.
 * The new rules append last, so within-layer last-declared-wins makes
 * them effective immediately. The gesture ends prototype-style: the
 * selection clears and the live region announces 批量调整完成.
 */
function applyBatchRule(fonts: string[]): void {
  const { selection } = store.get();
  if (selection.length === 0 || fonts.length === 0) return;
  const sorted = [...selection].sort((a, b) => a - b);
  const runs = selectionRuns(sorted);
  const selectedSet = new Set(sorted);
  const list = [...fonts];
  const singleRun = runs.length === 1 ? runs[0]! : null;
  const rules = store.get().rules.filter((rule) => {
    if (rule.target.kind === "codepoint") {
      return rule.target.cp === null || !selectedSet.has(rule.target.cp);
    }
    if (rule.target.kind === "range" && singleRun !== null) {
      const lo = Math.min(rule.target.start ?? 0, rule.target.end ?? 0);
      const hi = Math.max(rule.target.start ?? 0, rule.target.end ?? 0);
      return !(lo === singleRun.start && hi === singleRun.end);
    }
    return true;
  });
  if (singleRun !== null && sorted.length > 1) {
    rules.push(
      newRule({ kind: "range", start: singleRun.start, end: singleRun.end }, list),
    );
  } else {
    for (const cp of sorted) {
      rules.push(newRule({ kind: "codepoint", cp }, list));
    }
  }
  mutateRules(rules);
  beginSelectionGesture([], null);
  liveNotice("批量调整完成");
}

/* -------------- block / group assignment (the segments) ------------- */

/**
 * The app-level message stack (round 8, owner item 2): one dismissable
 * corner card per operation outcome. Mounted ONCE for the page (body
 * level, fixed position — pushing a message can never reflow the
 * workspace); the charmap's assignment paths and the synthesize flow's
 * save-collision prompt (round 17) are its writers.
 */
let messageStack: MessageStack | null = null;

function messages(): MessageStack {
  messageStack ??= mountMessageStack();
  return messageStack;
}

/**
 * The page's single message stack for writers OUTSIDE the charmap
 * (round 17: the synthesize flow's same-name collision card). Same
 * singleton, same corner — every outcome of the app lands in one
 * place.
 */
export function appMessages(): MessageStack {
  return messages();
}

/** Comma-grouped plain number (报告-style, en-US grouping). */
const plainNum = (n: number): string => n.toLocaleString("en-US");

/**
 * Announce one block/group assignment (round 9, owner item 3; the
 * structured-card redesign): a structured outcome card, never a prose
 * line — the action as the title, the counts as compact stat pairs
 * (the success count ALWAYS stated, even when 0), the ineffective
 * reason as a dim sub-line only when nonzero, and the undo hint as a
 * kbd chip. `nextRules` is the rule list the assignment is about to
 * commit; the counts compare the landed document against the document
 * those rules resolve to (the same memo the commit itself will hit —
 * never a second request for the state that lands). The card
 * auto-dismisses on its countdown (round 9, owner item 7).
 */
function announceAssignment(
  blocks: readonly UnicodeBlock[],
  scope: string,
  side: FontSide,
  nextRules: readonly EditorRule[],
  reverted: boolean,
): void {
  const before = liveDocument();
  if (before === null) return; // no resolve: the segments are no-ops anyway
  void documentFor(nextRules).then((after) => {
    if (after === null) return;
    // Sweep the assigned intervals (a group assignment sweeps every
    // block interval of the group); both sides answer from compressed
    // runs, so this is a one-off walk, never a render path.
    let switched = 0;
    let ineffective = 0;
    let noop = 0;
    for (const block of blocks) {
      for (const [start, end] of blockRanges(block)) {
        for (let cp = start; cp <= end; cp++) {
          const was = lookupEntry(before, cp);
          const now = lookupEntry(after, cp);
          if (was === null || now === null) continue; // neither pick covers
          if (now.winner !== was.winner) {
            switched++;
            continue;
          }
          if (reverted) continue;
          if (now.declared !== null && now.winner !== now.declared.font) {
            // The assignment's own rule covers this codepoint but its
            // font lacks the glyph — the other font keeps supplying it.
            ineffective++;
          } else {
            // Already supplied by the assigned side; the rule changes
            // nothing here (the declaration is now explicit, the glyph
            // is the same one).
            noop++;
          }
        }
      }
    }

    const sideWord = side === "base" ? "英文" : "中文";
    if (reverted) {
      messages().push({
        icon: "undo",
        title: `${scope}恢复默认`,
        stats: [{ value: plainNum(switched), label: "恢复" }],
        undo: "撤销",
      });
      return;
    }
    messages().push({
      icon: ineffective > 0 ? "warn" : "check",
      title: `${scope}用${sideWord}字体`,
      stats: [
        { value: plainNum(switched), label: "生效" },
        { value: plainNum(ineffective + noop), label: "未变" },
      ],
      // The reason names the ASSIGNED side's lack (the char popup's own
      // vocabulary) — and only ever when there is an ineffective count
      // to explain; the title already carries the side once.
      reason: ineffective > 0 ? `${sideWord}字体不含此码位` : undefined,
      undo: "撤销",
    });
  });
}

/** The font ref of one side ("base" / the first donor). */
function sideRef(side: FontSide): string | null {
  const refs = pickRefs().refs;
  const wanted = side === "base" ? "base" : "donor-0";
  return refs.includes(wanted) ? wanted : null;
}

/**
 * The font list a side assignment writes (round 6): the side's ref
 * FIRST, then the other pick — "用X字体" under absence-never-overrides
 * means "X supplies; where X lacks the glyph the other font fills",
 * which is exactly the ordered-list form. The single-ref form would
 * dead-end (`break` to the global default) and the rule would go
 * uncredited in the effective table; the preference list keeps the
 * SAME winner for every codepoint (the default order is the same
 * chain) while `via` reports the rule and the report's per-rule
 * coverage reads sanely.
 */
function sideRuleFonts(side: FontSide): string[] {
  const mine = sideRef(side);
  if (mine === null) return [];
  const other = side === "base" ? "donor-0" : "base";
  const refs = pickRefs().refs;
  return refs.includes(other) ? [mine, other] : [mine];
}

/**
 * The enumeration (and, since round 7, RULE) intervals of a block: the
 * curated `intervals` when the block has them (the 图标 sub-blocks),
 * else the full `start`–`end` envelope. A block assignment writes one
 * exact range rule per interval, so disjoint curated blocks (Font
 * Awesome spans E200–E2A9 plus ED00–F2FF) never rule codepoints of
 * neighboring sub-blocks through their hulls.
 */
function blockRanges(
  block: UnicodeBlock,
): ReadonlyArray<readonly [number, number]> {
  return block.intervals ?? [[block.start, block.end]];
}

/** True when `rule` is a complete range rule over exactly [start, end]. */
function isExactRangeRule(
  rule: EditorRule,
  start: number,
  end: number,
): boolean {
  if (rule.target.kind !== "range") return false;
  const { start: rs, end: re } = rule.target;
  if (rs === null || re === null) return false;
  return Math.min(rs, re) === start && Math.max(rs, re) === end;
}

/**
 * The side a block's interval rules declare, when EVERY interval of
 * the block carries an exact rule whose first font agrees (round 6's
 * preference-list form). A partially ruled block is not an assignment
 * — exactly like a hand-written range that covers half a block.
 */
function blockAssignment(block: UnicodeBlock): FontSide | "" {
  const rules = store.get().rules;
  let side: FontSide | null = null;
  for (const [start, end] of blockRanges(block)) {
    let intervalSide: FontSide | null = null;
    for (let i = rules.length - 1; i >= 0; i--) {
      const rule = rules[i]!;
      if (!isExactRangeRule(rule, start, end)) continue;
      if (rule.fonts.length < 1 || rule.fonts.length > 2) continue;
      const ref = rule.fonts[0]!;
      intervalSide = ref === "base" ? "base" : ref === "donor-0" ? "donor" : null;
      break;
    }
    if (intervalSide === null) return "";
    if (side === null) side = intervalSide;
    else if (side !== intervalSide) return "";
  }
  return side ?? "";
}

/* -------- default sides (active-chip prototype parity) -------------- */

/**
 * The side a block carries WITHOUT any rule — the prototype's static
 * per-block default `d` (its chips read `S.bf[b.id] || b.d`), computed
 * from the actual coverages instead: the side every COVERED codepoint of
 * the block resolves to under the no-rules default (base keeps what it
 * holds, the donor fills the rest). Codepoints neither pick covers are
 * outside the merge and don't vote.
 *
 * Returns null for a NEUTRAL block (nothing covered — no vote in the
 * group aggregate) and "" for a MIXED block (veto).
 */
function sweepDefaultSide(
  block: UnicodeBlock,
  base: readonly number[] | null,
  donor: readonly number[] | null,
): FontSide | "" | null {
  if (base === null && donor === null) return null;
  // Two pointers over the sorted coverages, swept along the block's
  // CURATED intervals (round 7): a disjoint block's hull overlaps
  // neighboring icon sub-blocks, and their codepoints must not vote
  // here.
  let bi = 0;
  let di = 0;
  let side: FontSide | "" | null = null;
  for (const [blockStart, blockEnd] of blockRanges(block)) {
    bi = lowerBound(base, blockStart);
    di = lowerBound(donor, blockStart);
    for (let cp = blockStart; cp <= blockEnd; cp++) {
      if (bi >= (base?.length ?? 0) && di >= (donor?.length ?? 0)) break;
      if (base) while (bi < base.length && base[bi]! < cp) bi++;
      if (donor) while (di < donor.length && donor[di]! < cp) di++;
      const hasBase = base !== null && base[bi] === cp;
      const hasDonor = donor !== null && donor[di] === cp;
      if (!hasBase && !hasDonor) continue;
      const current: FontSide = hasBase ? "base" : "donor";
      if (side === null) side = current;
      else if (side !== current) return "";
    }
  }
  return side;
}

/** First index of `sorted` whose value is >= `cp` (binary search). */
function lowerBound(
  sorted: readonly number[] | null,
  cp: number,
): number {
  if (sorted === null) return 0;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < cp) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

let defaultSidesMemo: {
  key: string;
  sides: Map<string, FontSide | "" | null>;
} | null = null;

/** The default side per block id, memoized on the pick pair. */
function defaultSideMap(picks: PickRefs): Map<string, FontSide | "" | null> {
  const key = `${picks.base?.cssFamily ?? ""}|${picks.donor?.cssFamily ?? ""}`;
  if (defaultSidesMemo && defaultSidesMemo.key === key) {
    return defaultSidesMemo.sides;
  }
  const base = picks.base?.codepoints ?? null;
  const donor = picks.donor?.codepoints ?? null;
  const sides = new Map<string, FontSide | "" | null>();
  for (const block of ALL_BLOCKS) {
    sides.set(block.id, sweepDefaultSide(block, base, donor));
  }
  defaultSidesMemo = { key, sides };
  return sides;
}

/**
 * The side a block EFFECTIVELY carries: its explicit exact rule, else
 * its no-rules default. This is what the segment chips render pressed
 * (prototype parity — the prototype's default side shows bold too).
 */
function effectiveBlockSide(
  block: UnicodeBlock,
  picks: PickRefs,
): FontSide | "" {
  const explicit = blockAssignment(block);
  if (explicit !== "") return explicit;
  return defaultSideMap(picks).get(block.id) ?? "";
}

/**
 * The side every block of a group with a clear default carries ("" when
 * they disagree). Prototype parity for the boot frames: its per-block
 * static defaults made every group render a pressed 全部用… chip
 * whenever its blocks agreed — so a MIXED block (both fonts hold parts
 * of it; no single default side) abstains rather than vetoing the
 * whole group, exactly like a neutral block (nothing covered). Explicit
 * assignments still vote, and two blocks explicitly assigned to
 * opposite sides keep the group unpressed.
 */
function effectiveGroupSide(
  blocks: readonly UnicodeBlock[],
  picks: PickRefs,
): FontSide | "" {
  let side: FontSide | "" = "";
  for (const block of blocks) {
    const explicit = blockAssignment(block);
    if (explicit !== "") {
      if (side === "") side = explicit;
      else if (side !== explicit) return "";
      continue;
    }
    const def = defaultSideMap(picks).get(block.id);
    if (def === null || def === undefined || def === "") continue;
    if (side === "") side = def;
    else if (side !== def) return "";
  }
  return side;
}

/**
 * Assign one block (or a group's blocks) to a side through the rule
 * state: one exact range rule per block INTERVAL with the side's ref
 * leading the font list. Assigning the side the group already carries
 * (explicitly or by default) REVERTS it to the default (prototype
 * parity). Every application announces its outcome through the message
 * stack (round 8, owner item 2) — `scope` is the human name of the
 * assigned range (所有…字符 for a group, the block name otherwise).
 */
function assignBlocks(
  blocks: readonly UnicodeBlock[],
  side: FontSide,
  scope: string,
): void {
  const ref = sideRef(side);
  if (ref === null) return;
  const picks = pickRefs();
  const fonts = sideRuleFonts(side);
  const exact = new Set(
    blocks.flatMap((block) =>
      store
        .get()
        .rules.filter((rule) =>
          blockRanges(block).some(([start, end]) =>
            isExactRangeRule(rule, start, end),
          ),
        )
        .map((rule) => rule.id),
    ),
  );
  const already = effectiveGroupSide(blocks, picks) === side;
  const rules = store.get().rules.filter((rule) => !exact.has(rule.id));
  if (!already) {
    for (const block of blocks) {
      for (const [start, end] of blockRanges(block)) {
        rules.push(newRule({ kind: "range", start, end }, fonts));
      }
    }
  }
  announceAssignment(blocks, scope, side, rules, already);
  mutateRules(rules);
}

/* ---------------- the char popup (at the cell) ---------------------- */

/**
 * The character's taxonomy classification for the popup's qualifier tag
 * (round 20, owner item 4): the block whose enumeration content carries
 * `cp` (curated intervals respected), named with the taxonomy's own
 * group and block words, joined by U+00B7 — 「图标 · Powerline 符号」,
 * 「中日韩文字 · CJK 统一表意文字」. Undefined outside the taxonomy (the
 * browsable gaps of the 全部 view carry no block to name).
 */
function classificationOf(cp: number): string | undefined {
  const block = findBlockOf(cp);
  if (block === undefined) return undefined;
  const group = blockGroup(block.id);
  if (group === undefined) return undefined;
  return `${group.name} \u00B7 ${block.name}`;
}

/**
 * The character popup facts (the kit's CharPopup renders them
 * verbatim): the 44px glyph in the winning font, the `U+XXXX` code,
 * `来自 {字体名}`, one-click side buttons (the carried side hidden, and
 * a side whose font is not picked — an unpickable button would be a
 * lie), and 恢复默认 when the character carries its own override that
 * changes the outcome. Missing glyphs read 两个字体均不含该字形 — or,
 * in the Nerd Font private-use area, the prototype's PUA explanation
 * sentence.
 */
function charFacts(cp: number): CharPopupFacts {
  const ch = String.fromCodePoint(cp);
  const picks = pickRefs();
  const effective = picks.refs.length > 0;
  const doc = effective ? liveDocument() : null;
  const entry = doc !== null ? lookupEntry(doc, cp) : null;
  const classification = classificationOf(cp);

  if (entry === null) {
    const missingCopy =
      cp >= 0xe000 && cp <= 0xf8ff
        ? "这是一个 Nerd Font 图标字符，位于专用区编码。合成时保留包含它的字体的图标。"
        : "两个字体均不含该字形";
    return {
      glyph: ch,
      missing: true,
      code: formatCp(cp),
      from: effective ? missingCopy : "",
      ...(classification !== undefined ? { classification } : {}),
      showBase: false,
      showDonor: false,
      showReset: false,
    };
  }
  const winnerFont = refFont(entry.winner, picks);
  // The ineffective-assignment reason (round 7, owner item 1): a rule
  // DECLARED a side whose font lacks this codepoint — absence never
  // overrides, so the winner is the font that actually covers it. The
  // popup states that in plain glossary words (码位 / 补字) instead of
  // silently showing a 来自 that seems to contradict the assignment.
  const declaredRef = entry.declared?.font ?? null;
  let note: string | undefined;
  if (declaredRef !== null && declaredRef !== entry.winner) {
    const declaredName = declaredRef === "base" ? "英文字体" : "中文字体";
    const winnerName = entry.winner === "base" ? "英文字体" : "中文字体";
    note =
      entry.winner === "donor-0"
        ? `${declaredName}不含此码位，仍由${winnerName}补字`
        : `${declaredName}不含此码位，仍由${winnerName}提供`;
  }
  // Prototype parity (stk/stkW): the glyph stack carries the WINNING
  // SIDE's fallback tail — the base side falls back to the mono tail,
  // the donor side to the CJK tail. The app additionally keeps a
  // sans-serif end so a partially loading face degrades gracefully.
  const winnerTail =
    entry.winner === "base"
      ? "Consolas,ui-monospace,monospace"
      : "'Microsoft YaHei',sans-serif";
  // The carried side hides; so does a side whose font is not picked
  // (an unpickable button would be a lie). `winner` is the REF
  // (`base` / `donor-0`), compared in that vocabulary. Round 8 (owner
  // item 1): a SHOWN side whose font lacks this codepoint renders its
  // button DISABLED with the plain-words reason attached — the
  // assignment could never take effect (absence never overrides), so
  // offering it as a working action would be the lie.
  const showBase =
    entry.winner !== "base" && picks.refs.includes("base");
  const showDonor =
    entry.winner !== "donor-0" && picks.refs.includes("donor-0");
  const sideCovers = (font: typeof picks.base): boolean =>
    font !== null && font.codepoints.includes(cp);
  const baseReason =
    showBase && !sideCovers(picks.base) ? "英文字体不含此码位" : undefined;
  const donorReason =
    showDonor && !sideCovers(picks.donor) ? "中文字体不含此码位" : undefined;

  // 恢复默认 shows only when the character carries its own override
  // AND that override changes the outcome (prototype: S.ov[ch] &&
  // S.ov[ch] !== layC(ch,b)). The deeper winner is the serve's answer
  // beneath the codepoint layer.
  let showReset = false;
  const own = codepointRule(cp);
  if (own !== undefined) {
    const ownRef = own.fonts[0] ?? null;
    showReset = ownRef !== null && ownRef !== deeperWinner(cp);
  }

  return {
    glyph: ch,
    glyphFamily: winnerFont
      ? `${cssFamily(winnerFont.cssFamily)},${winnerTail}`
      : undefined,
    code: formatCp(cp),
    // Round 9 (owner item 2): the 来自 line reads the font's OWN name
    // table, verbatim — never the metadata family id.
    from: `来自 ${winnerFont ? fontDisplayName(winnerFont) : ""}`,
    ...(classification !== undefined ? { classification } : {}),
    note,
    showBase,
    showDonor,
    baseReason,
    donorReason,
    showReset,
    onBase: () => applyCodepointSide(cp, "base"),
    onDonor: () => applyCodepointSide(cp, "donor"),
    onReset: () => removeCodepointRule(cp),
  };
}

/** Upsert the codepoint rule to `fonts` (the side's preference list). */
function upsertCodepointRule(cp: number, fonts: string[]): void {
  const rules = [...store.get().rules];
  const existing = rules.findIndex((rule) => targetsCodepoint(rule, cp));
  const rule = newRule({ kind: "codepoint", cp }, fonts);
  if (existing >= 0) rules.splice(existing, 1, rule);
  else rules.push(rule);
  mutateRules(rules);
}

/* ---------------- the 按编码指定 range popup ------------------------ */

/**
 * The range-specify apply (the kit's RangePopup owns the verbatim
 * chrome): parse `U+0030 或 0` / `留空=单个` (an empty end = a single
 * codepoint), resolve the side's font ref, and add the narrow range
 * rule that outranks class defaults. Invalid input (or an unpicked
 * side) reports false — the popup paints the danger border.
 */
function applyRangeInput(
  startText: string,
  endText: string,
  side: FontSide,
): boolean {
  const start = parseCodepointInput(startText);
  const endRaw = endText.trim();
  const end = endRaw === "" ? start : parseCodepointInput(endText);
  const ref = sideRef(side);
  if (start === null || end === null || end < start || ref === null) {
    return false;
  }
  mutateRules([
    ...store.get().rules,
    newRule({ kind: "range", start, end }, sideRuleFonts(side)),
  ]);
  return true;
}

/* ---------------------- chip data ----------------------------------- */

const GROUP_ICONS: Record<string, IconName> = {
  "latin-europe": "type",
  symbols: "shapes",
  icons: "shapes",
  cjk: "lang",
  "other-scripts": "globe",
};

const BLOCK_ICONS: Record<string, IconName> = {
  "basic-latin": "type",
  latin: "type",
  greek: "sigma",
  cyrillic: "lang",
  arrows: "arrow",
  math: "inf",
  "box-drawing": "grid",
  "geometric-shapes": "shapes",
  "misc-symbols": "shapes",
  // The icon sub-blocks (round 7), one glyph per publisher macro-block.
  "nf-powerline": "arrow",
  "nf-seti-devicons": "braces",
  "nf-codicons": "dots",
  "nf-fontawesome": "star",
  "nf-fontlogos": "tag",
  "nf-octicons": "github",
  "nf-material": "layers",
  "nf-misc": "shapes",
  hiragana: "lang",
  katakana: "lang",
  emoji: "shapes",
  arabic: "lang",
  hebrew: "lang",
  thai: "lang",
  devanagari: "lang",
};

/* ---------------- module-level locate ---------------- */

/**
 * The mounted stage's live grid (locate scrolls the matched cell into
 * view). Updated on every charmap mount; a stale (detached) grid is
 * ignored — the mode bar's 定位 field reaches this from either mode.
 */
let activeGrid: CharGrid | null = null;

/**
 * The live page size (round 5, owner item 5): a multiple of the grid's
 * current column count, capped at CELLS_PER_PAGE, so every page is
 * exactly full except the final partial one. Falls back to the nominal
 * page until the first layout reports columns.
 */
let livePageSize = CELLS_PER_PAGE;

/**
 * Locate a typed codepoint (hex form or a single character): jump to its
 * category page, set the details cursor on it, and scroll it into view.
 * An unparseable query — or a codepoint the browsable universe does not
 * carry (an invisible one: a control/format/separator/unassigned scalar,
 * which the grid never shows) — is a silent no-op (prototype parity).
 */
export function locateQuery(raw: string): void {
  const text = raw.trim();
  const cp =
    parseCodepointInput(text) ??
    ([...text].length === 1 ? text.codePointAt(0) ?? null : null);
  if (cp === null) return;
  const block = ALL_BLOCKS.find((b) => cp >= b.start && cp <= b.end);
  let categoryId = ALL_CATEGORY_ID;
  let page = 1;
  if (block) categoryId = block.id;
  const index = codepointIndex(categoryId, cp);
  if (index === null) return; // not browsable here — silent no-op
  page = Math.floor(index / livePageSize) + 1;
  store.set({ categoryId, page, selectedCodepoint: cp });
  // Bring the cell into view (prototype parity: locate scrolls to it).
  window.setTimeout(() => {
    const cell = activeGrid?.cellAt(String.fromCodePoint(cp));
    if (cell && cell.isConnected) cell.scrollIntoView({ block: "center" });
  }, 60);
}

/* ------------------------------ mount ------------------------------- */

export function mountCharmap(root: HTMLElement): void {
  // The message stack (round 8, owner item 2) mounts with the first
  // charmap and stays for the page's life (a fixed, body-level layer —
  // later stage remounts reuse the same one).
  messages();
  // A previous stage mount (mode switches rebuild the stage) leaves its
  // body-level popup nodes orphaned; this mount replaces them (the
  // action bar's legend ? popup rides the same list — the bar remounts
  // with every stage).
  for (const stale of document.body.querySelectorAll(
    "[data-char-popup], [data-range-popup], [data-help-popup='adjusted-legend']",
  )) {
    stale.remove();
  }
  root.innerHTML = `
    <div class="charmap-categories" aria-label="字符分类"></div>
    <div class="charmap-main">
      <div class="charmap-toolbar"></div>
      <div class="charmap-grid"></div>
    </div>
  `;

  const categories = root.querySelector<HTMLElement>(".charmap-categories")!;
  const toolbar = root.querySelector<HTMLElement>(".charmap-toolbar")!;
  const gridHost = root.querySelector<HTMLElement>(".charmap-grid")!;

  /* View state of this stage: 编码 mode (the per-cell codepoint row)
   * and the explicit 多选 mode (prototype parity: drag-paint and
   * Shift-range arm ONLY inside it; a plain click opens the popup). */
  let showCodepoints = false;
  let multiMode = false;

  const chips: CategoryChips = mountCategoryChips(categories, {
    groups: [],
    blocks: [],
    activeGroupId: null,
    activeBlockId: "all",
    onGroup: () => undefined,
    onBlock: () => undefined,
  });
  const actionBar: ActionBar = mountActionBar(toolbar, {
    multi: false,
    showCodepoints: false,
    canUndo: false,
    onUndo: () => undoRules(),
    onToggleMulti: () => undefined,
    onToggleCodepoints: () => undefined,
  });
  const rangePopup = mountRangePopup(toolbar, {
    onApply: applyRangeInput,
  });
  const charPopup = mountCharPopup();
  const grid: CharGrid = mountCharGrid(gridHost);
  activeGrid = grid;

  /**
   * The page-fill discipline (round 5): pages hold as many full ROWS as
   * fit in the nominal 1024 cells — a page size that is a multiple of
   * the live column count. When the columns change (first layout, a
   * window resize), the current page re-renders at the new boundaries.
   */
  const onGridColumns = (columns: number): void => {
    if (columns <= 0) return;
    const next = Math.max(columns, Math.floor(CELLS_PER_PAGE / columns) * columns);
    if (next === livePageSize) return;
    livePageSize = next;
    render();
  };

  /** Leave 多选 mode: the selection, its anchor, and its undo stack go. */
  const toggleMultiMode = (): void => {
    multiMode = !multiMode;
    store.set({ selection: [], selectionAnchor: null });
    clearSelectionUndo();
    render();
  };

  /* ---------------- multi-select gestures (issue #20) ----------------
   * Painting arms ONLY in 多选 mode (prototype parity). In that mode a
   * pointer-down toggles the cell into the selection (the drag paints
   * in the toggled direction — additive when the cell was unselected,
   * subtractive otherwise); shift extends from the anchor instead.
   * Missing cells never join a selection. Outside the mode a plain
   * pointer-down sets the cursor and opens the char popup AT the cell —
   * a synchronous store patch re-renders the grid (replacing the cell
   * node) before the compatibility click lands, so the popup opens at
   * pointer-down time, not click time. */
  let painting = false;

  const cellCodepoint = (target: EventTarget | null): number | null => {
    if (!(target instanceof Element)) return null;
    const cp = target.closest<HTMLElement>(".kit-cell")?.dataset.cp;
    if (!cp) return null;
    return Number.parseInt(cp.slice(2), 16);
  };
  const cellMissing = (target: EventTarget | null): boolean => {
    if (!(target instanceof Element)) return false;
    return target.closest(".kit-cell")?.classList.contains("miss") ?? false;
  };

  grid.el.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const cellEl = event.target instanceof Element
      ? event.target.closest<HTMLElement>(".kit-cell")
      : null;
    const cp = cellCodepoint(event.target);
    if (cp === null || cellEl === null) return;
    // NOTE: no preventDefault on the popup path — canceling pointerdown
    // makes the browser drop the held-button state; in 多选 mode the
    // prototype does preventDefault and we follow it there.
    if (!multiMode) {
      // Position the popup against the LIVE cell first — the store
      // patch below re-renders the grid synchronously and would detach
      // the node (its rect then reads as zero).
      charPopup.openAt(cellEl, charFacts(cp));
      store.set({ selectedCodepoint: cp });
      return;
    }
    if (cellMissing(event.target)) return;
    event.preventDefault();
    if (event.shiftKey) {
      extendFromAnchor(cp);
      painting = true;
      return;
    }
    const { selection } = store.get();
    const had = selection.includes(cp);
    const next = had
      ? selection.filter((entry) => entry !== cp)
      : [...selection, cp].sort((a, b) => a - b);
    painting = !had;
    beginSelectionGesture(next, cp);
  });
  grid.el.addEventListener("pointermove", (event) => {
    if (!painting || !multiMode) return;
    event.preventDefault();
    const cp = cellCodepoint(event.target);
    if (cp === null || cellMissing(event.target)) return;
    const { selection } = store.get();
    if (painting && !selection.includes(cp)) extendSelection([cp]);
    if (!painting && selection.includes(cp)) {
      store.set({ selection: selection.filter((entry) => entry !== cp) });
    }
  });
  const stopPaint = (): void => {
    if (!painting) return;
    painting = false;
    // The toolbar holds its normal variant while the pointer is held
    // (the prototype's fixed-geometry discipline: a variant swap mid-drag
    // would shift the grid under the pointer and paint the wrong cells).
    // Paint end is the moment the batch variant may appear.
    render();
  };
  window.addEventListener("pointerup", stopPaint);
  window.addEventListener("pointercancel", stopPaint);

  /** Shift-extend the selection from the anchor to `cp`, in the current
   *  category's enumeration (the aggregate view skips the surrogate gap).
   *  Without an anchor in this category the click starts a fresh one. */
  function extendFromAnchor(cp: number): void {
    const { selectionAnchor, categoryId } = store.get();
    const anchorIndex =
      selectionAnchor !== null
        ? codepointIndex(categoryId, selectionAnchor)
        : null;
    const cpIndex = codepointIndex(categoryId, cp);
    if (selectionAnchor === null || anchorIndex === null || cpIndex === null) {
      beginSelectionGesture([cp], cp);
      return;
    }
    const lo = Math.min(anchorIndex, cpIndex);
    const hi = Math.max(anchorIndex, cpIndex);
    const range: number[] = [];
    for (let n = lo; n <= hi; n++) range.push(nthCodepoint(categoryId, n));
    beginSelectionGesture(range, selectionAnchor);
  }

  /** Locate a typed codepoint (hex form or a single character):
   *  jump to its category page and set the cursor. */
  const locate = locateQuery;

  const render = (): void => {
    const {
      categoryId,
      page,
      selectedCodepoint,
      selection,
      fonts,
    } = store.get();
    const missing = missingCodepoints();
    const last =
      categoryId === MISSING_CATEGORY_ID
        ? Math.max(1, Math.ceil(missing.length / livePageSize))
        : pageCountFor(categoryId, livePageSize);
    const safePage = Math.min(Math.max(page, 1), last);

    renderChips(categoryId);
    renderToolbar(categoryId, safePage, last, selection);
    renderGrid(
      categoryId,
      safePage,
      selectedCodepoint,
      selection,
      fonts,
      missing,
    );
  };
  store.subscribe(render);
  precedenceStore.subscribe(render);
  render();

  /* ---------------- chip bar ---------------- */

  function renderChips(categoryId: string): void {
    const group = blockGroup(categoryId);
    const missing = missingCodepoints();
    chips.render({
      groups: [
        {
          id: "all",
          label: "全部",
          count: categorySize(ALL_CATEGORY_ID),
          icon: "all",
        },
        ...BLOCK_GROUPS.map((g) => ({
          id: g.id,
          label: g.name,
          count: categorySize(groupCategoryId(g.id)),
          icon: GROUP_ICONS[g.id],
        })),
        // The 缺失 aggregate closes the row (danger styling) whenever
        // at least one pick exists and the browsed universe holds
        // codepoints no pick covers — computed from the coverages
        // alone, no preset involved (round 5, owner item 4; single pick
        // added round 19).
        ...(missing.length > 0
          ? [
              {
                id: MISSING_CATEGORY_ID,
                label: "缺失",
                count: missing.length,
                icon: "warn" as IconName,
                danger: true,
              },
            ]
          : []),
      ],
      blocks:
        group === undefined
          ? []
          : [
              {
                id: groupCategoryId(group.id),
                label: "全部",
                count: categorySize(groupCategoryId(group.id)),
                icon: "all",
              },
              ...group.blocks.map((b) => ({
                id: b.id,
                label: b.name,
                // The block's VISIBLE codepoint count — the cells the
                // grid actually pages through (round 5).
                count: categorySize(b.id),
                icon: BLOCK_ICONS[b.id],
              })),
            ],
      activeGroupId:
        categoryId === MISSING_CATEGORY_ID
          ? MISSING_CATEGORY_ID
          : (group?.id ?? null),
      activeBlockId: categoryId,
      onGroup: (id) => {
        store.set({
          categoryId:
            id === MISSING_CATEGORY_ID
              ? MISSING_CATEGORY_ID
              : id === null || id === "all"
                ? ALL_CATEGORY_ID
                : groupCategoryId(id),
          page: 1,
        });
      },
      onBlock: (id) => {
        store.set({ categoryId: id, page: 1 });
      },
    });
  }

  /* ---------------- action bar ---------------- */

  function renderToolbar(
    categoryId: string,
    safePage: number,
    last: number,
    selection: readonly number[],
  ): void {
    // The missing view replaces both segments with its notice.
    if (categoryId === MISSING_CATEGORY_ID) {
      actionBar.render({
        missingView: true,
        multi: multiMode,
        showCodepoints,
        canUndo: canUndoRules(),
        onUndo: () => undoRules(),
        onToggleMulti: toggleMultiMode,
        onToggleCodepoints: () => {
          showCodepoints = !showCodepoints;
          render();
        },
        page: {
          page: safePage - 1,
          count: last,
          onPage: (delta) => {
            const { page: current } = store.get();
            store.set({ page: Math.min(Math.max(current + delta, 1), last) });
          },
          onJump: (target) => {
            store.set({ page: Math.min(Math.max(target + 1, 1), last) });
          },
        },
        adjustedLegend: true,
        onLocate: locate,
        onRangeSpecify: () => rangePopup.open(),
      });
      return;
    }

    const group = blockGroup(categoryId);
    const block =
      findGroupCategory(categoryId) === undefined
        ? ALL_BLOCKS.find((b) => b.id === categoryId)
        : undefined;
    const picks = pickRefs();

    if (multiMode && selection.length > 0 && !painting) {
      actionBar.render({
        multi: multiMode,
        showCodepoints,
        canUndo: canUndoRules(),
        onUndo: () => undoRules(),
        onToggleMulti: toggleMultiMode,
        onToggleCodepoints: () => {
          showCodepoints = !showCodepoints;
          render();
        },
        batch: {
          count: selection.length,
          canUndoPick: canUndoSelection(),
          onApply: (side) => {
            if (side === "clear") {
              beginSelectionGesture([], null);
              return;
            }
            const ref = sideRef(side);
            if (ref !== null) applyBatchRule(sideRuleFonts(side));
          },
          onUndoPick: () => undoSelection(),
        },
        onRangeSpecify: () => rangePopup.open(),
      });
      return;
    }

    actionBar.render({
      // The segments render whether or not the pair is complete — the
      // prototype always shows them, the defaults (or nothing) driving
      // the pressed state; acting without the side's pick is a no-op.
      group:
        group !== undefined
          ? {
              label: group.name,
              allBase: effectiveGroupSide(group.blocks, picks) === "base",
              allDonor: effectiveGroupSide(group.blocks, picks) === "donor",
              onAssign: (side) =>
                // Round 9 (owner item 3): the message scope reads the
                // plain group name (中日韩文字), not 所有…字符.
                assignBlocks(group.blocks, side, group.name),
            }
          : undefined,
      block:
        block !== undefined
          ? {
              label: block.name,
              aggregate: false,
              value: effectiveBlockSide(block, picks),
              onAssign: (side) => assignBlocks([block], side, block.name),
            }
          : categoryId === ALL_CATEGORY_ID
            ? { label: "全部", aggregate: true, count: categorySize(categoryId) }
            : {
                label: categoryName(categoryId),
                aggregate: true,
                count: categorySize(categoryId),
              },
      multi: multiMode,
      showCodepoints,
      canUndo: canUndoRules(),
      onUndo: () => undoRules(),
      onToggleMulti: toggleMultiMode,
      onToggleCodepoints: () => {
        showCodepoints = !showCodepoints;
        render();
      },
      page: { page: safePage - 1, count: last, onPage: (delta) => {
        const { page: current } = store.get();
        store.set({ page: Math.min(Math.max(current + delta, 1), last) });
      }, onJump: (target) => {
        store.set({ page: Math.min(Math.max(target + 1, 1), last) });
      } },
      adjustedLegend: true,
      onLocate: locate,
      onRangeSpecify: () => rangePopup.toggle(),
    });
  }
  /* ---------------- grid ---------------- */

  /** The grid's cell data for the current page, resolved effectively. */
  function renderGrid(
    categoryId: string,
    page: number,
    selectedCodepoint: number | null,
    selection: readonly number[],
    fonts: ReturnType<typeof store.get>["fonts"],
    missing: readonly number[] = missingCodepoints(),
  ): void {
    const size =
      categoryId === MISSING_CATEGORY_ID
        ? missing.length
        : categorySize(categoryId);
    const first = (page - 1) * livePageSize;
    const count = Math.min(livePageSize, size - first);
    const picks = pickRefs();
    // Round 20 (owner item 1): ONE pick already judges — the grid may
    // not wait for the pair to mark the gaps (the round-19 plain
    // preview rendered an icon-less pick's unmapped NF cells as fallback
    // tofu, exactly the misleading frame the owner rejected). `plain`
    // stays for the no-pick state — and for the no-document state: a
    // lone CJK pick (the request's `picks.base` is mandatory) or an
    // absent serve has no coloring to show yet (ticket #35).
    const judged = picks.base !== null || picks.donor !== null;
    const doc = judged ? liveDocument() : null;
    const selectionSet = new Set(selection);
    // The picks' suspected-placeholder sets (round 20): a cell whose
    // codepoint a pick maps to a placeholder glyph keeps rendering that
    // font's own glyph under the missing style. Join order decides.
    const placeholderSets = new Map<LoadedFont, Set<number>>();
    const placeholderFamilyOf = (cp: number): string | null => {
      for (const font of [picks.base, picks.donor]) {
        if (font === null) continue;
        let set = placeholderSets.get(font);
        if (set === undefined) {
          set = new Set(font.placeholderCodepoints ?? []);
          placeholderSets.set(font, set);
        }
        if (set.has(cp)) return cssFamily(font.cssFamily);
      }
      return null;
    };
    // The plain preview stack for cells outside the effective preview
    // (the picked pair first, then the system tail) — the same stack the
    // pre-repair grid set as --font-preview.
    const enFamily = fonts.find(
      (f) => f.cssFamily === store.get().selected.en,
    )?.cssFamily ?? null;
    const cjkFamily = fonts.find(
      (f) => f.cssFamily === store.get().selected.cjk,
    )?.cssFamily ?? null;
    const plainStack = [
      enFamily ? cssFamily(enFamily) : "",
      cjkFamily ? cssFamily(cjkFamily) : "",
      '"Segoe UI"',
      '"Microsoft YaHei"',
      "monospace",
    ]
      .filter(Boolean)
      .join(",");

    const cells: GridCellData[] = [];
    for (let i = 0; i < count; i++) {
      // The missing view pages its own list: every cell is a dashed
      // danger cell (no picked font covers it, by construction), the
      // placeholder glyph and no-fallback rules included.
      if (categoryId === MISSING_CATEGORY_ID) {
        const cp = missing[first + i]!;
        const placeholderFamily = placeholderFamilyOf(cp);
        cells.push({
          ch: String.fromCodePoint(cp),
          state: "none",
          ...(placeholderFamily !== null ? { placeholderFamily } : {}),
          ...(placeholderFamily === null && isIconCodepoint(cp)
            ? { noFallbackGlyph: true }
            : {}),
          selected: selectionSet.has(cp),
          cursor: cp === selectedCodepoint,
          cp: formatCp(cp),
        });
        continue;
      }
      const cp = nthCodepoint(categoryId, first + i);
      const ch = String.fromCodePoint(cp);
      // The effective merged result: the landed document's run for the
      // cell, exposed and rendered in the winner's own face (the grid
      // never lies — issue #18; what it shows is what the build
      // resolves — ticket #35).
      const entry = doc !== null ? lookupEntry(doc, cp) : null;
      const winnerFont = entry ? refFont(entry.winner, picks) : null;
      if (entry === null && judged && doc !== null) {
        // Missing, two ways (round 20): a pick maps the codepoint to a
        // suspected placeholder glyph → the font's own glyph rides the
        // missing frame; nothing maps it inside the 图标 ranges → no
        // glyph at all, the codepoint row is the only content.
        const placeholderFamily = placeholderFamilyOf(cp);
        cells.push({
          ch,
          state: "none",
          ...(placeholderFamily !== null ? { placeholderFamily } : {}),
          ...(placeholderFamily === null && isIconCodepoint(cp)
            ? { noFallbackGlyph: true }
            : {}),
          selected: selectionSet.has(cp),
          cursor: cp === selectedCodepoint,
          cp: formatCp(cp),
        });
        continue;
      }
      cells.push({
        ch,
        state: entry
          ? entry.winner === "base"
            ? "base"
            : "donor"
          : "plain",
        // Adjusted = a non-preset rule EFFECTIVELY changes the supplier
        // (the run's own flag — round 8's discipline, computed where
        // the build computes it).
        adjusted: entry?.adjusted ?? false,
        selected: selectionSet.has(cp),
        cursor: cp === selectedCodepoint,
        fontFamily: winnerFont
          ? `${cssFamily(winnerFont.cssFamily)}, sans-serif`
          : plainStack,
        cp: formatCp(cp),
        attrs: entry
          ? { winner: entry.winner, via: entry.via, kind: entry.kind }
          : undefined,
      });
    }
    grid.render({
      cells,
      showCodepoints,
      cellSize: 40,
      onColumns: onGridColumns,
    });
  }

}

export function formatCp(cp: number): string {
  return "U+" + cp.toString(16).toUpperCase().padStart(4, "0");
}

export { pageCountFor, categoryName };
