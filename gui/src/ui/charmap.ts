import { store } from "../state";
import {
  ALL_CATEGORY_ID,
  ALL_BLOCKS,
  BLOCK_GROUPS,
  CELLS_PER_PAGE,
  blockGroup,
  categoryIntervals,
  categorySize,
  categoryName,
  codepointIndex,
  findGroupCategory,
  groupCategoryId,
  nthCodepoint,
  pageCountFor,
  type UnicodeBlock,
} from "../unicode/blocks";
import { newRule, parseCodepointInput, type EditorRule } from "../precedence/model";
import { currentResolver, defaultResolver } from "../precedence/live";
import { pickRefs, refFont, refLabel, type PickRefs } from "../precedence/picks";
import {
  beginSelectionGesture,
  canUndoSelection,
  extendSelection,
  mutateRules,
  undoSelection,
  undoRules,
  canUndoRules,
} from "../history";
import { cssFamily } from "../kit/pickerPopup";
import { fitPopup } from "../kit/position";
import { mountCategoryChips, type CategoryChips } from "../kit/categoryChips";
import { mountActionBar, type ActionBar, type FontSide } from "../kit/actionBar";
import { mountCharGrid, type CharGrid, type GridCellData } from "../kit/grid";
import type { IconName } from "../kit/icons";
import { MISSING_CATEGORY_ID, missingCodepoints } from "./missing";

/**
 * Character map (ADR-0004), assembled from the kit: the horizontal
 * two-level CategoryChips bar (group + block, with the 全部 aggregate
 * and per-group aggregates), the ActionBar (per-group and per-block
 * 用英文字体/用中文字体 segments, 多选/编码/撤销, the pager, the 已调整
 * legend, the codepoint locator, and the 按编码指定 entry), and the
 * effective grid.
 *
 * Since issue #18 the grid renders the EFFECTIVE merged result: each
 * cell is resolved through the client-side precedence mirror (same
 * semantics as the core resolver) against the coverage of the
 * actually-loaded fonts, rendered in the winning font's own face, and
 * carries its resolution as DOM attributes (`data-winner` / `data-via`
 * / `data-kind`) — the grid never lies, however complex the rules.
 * Adjusted cells (the effective winner differing from the no-rule
 * default) carry the kit's corner dot, paired with the 已调整 legend.
 *
 * The ActionBar's segments act through the EXISTING rule-state
 * machinery (#18/#20): assigning a block or a group creates/updates
 * exact range rules through `mutateRules` (one undo entry per action),
 * and the batch variant applies to the multi-selection exactly like
 * the details strip's batch editor (one range rule per contiguous run,
 * per-codepoint rules otherwise). Selecting a cell opens the
 * single-codepoint precedence editor; typing a codepoint locates it;
 * drag-paint / Ctrl-drag-paint / shift-range build selections (issue
 * #20), with the two separate undo stacks.
 */

/** Whether `rule` targets exactly this codepoint. */
function targetsCodepoint(rule: EditorRule, cp: number): boolean {
  return rule.target.kind === "codepoint" && rule.target.cp === cp;
}

/** The rule whose target is exactly this codepoint, when one exists. */
function codepointRule(cp: number): EditorRule | undefined {
  return store.get().rules.find((rule) => targetsCodepoint(rule, cp));
}

/* ---------- the single-codepoint precedence editor (issue #18) ------- */

/** The editor's working state; survives re-renders, resets on move. */
let editorFor: number | null = null;
let editorFonts: string[] = [];

function openEditor(cp: number, picks: PickRefs): void {
  if (editorFor === cp) return;
  editorFor = cp;
  const existing = codepointRule(cp);
  editorFonts = existing ? [...existing.fonts] : [...picks.refs];
}

/** Patch the rule state: upsert the editor's list as a codepoint rule. */
function applyCodepointRule(cp: number): void {
  const rules = [...store.get().rules];
  const index = rules.findIndex((rule) => targetsCodepoint(rule, cp));
  if (index >= 0) {
    rules[index] = { ...rules[index]!, fonts: [...editorFonts] };
  } else {
    rules.push(newRule({ kind: "codepoint", cp }, editorFonts));
  }
  mutateRules(rules);
}

/** Patch the rule state: drop the codepoint rule targeting `cp`. */
function removeCodepointRule(cp: number): void {
  mutateRules(
    store.get().rules.filter((rule) => !targetsCodepoint(rule, cp)),
  );
}

/* ---------------- the batch precedence editor (issue #20) ----------- */

/** The batch editor's working state; resets when the selection changes. */
let batchSignature = "";
let batchFonts: string[] = [];

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
 * Batch apply: one action commits the chosen font list for the WHOLE
 * selection, aggregated per #18's rule-state shape:
 *
 * - a contiguous selection becomes ONE range rule;
 * - anything else becomes one codepoint rule per selected codepoint,
 *   declared in ascending order (the plan line in the editor states
 *   which, before the user commits).
 *
 * Existing codepoint rules over the selection drop first — a stale
 * narrower rule would outrank the batch forever — and an existing range
 * rule with the exact same bounds is replaced rather than duplicated.
 * The new rules append last, so within-layer last-declared-wins makes
 * them effective immediately.
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
}

/* -------------- block / group assignment (the segments) ------------- */

/** The font ref of one side ("base" / the first donor). */
function sideRef(side: FontSide): string | null {
  const refs = pickRefs().refs;
  const wanted = side === "base" ? "base" : "donor-0";
  return refs.includes(wanted) ? wanted : null;
}

/** True when `rule` is a complete range rule over exactly `block`. */
function isExactBlockRule(rule: EditorRule, block: UnicodeBlock): boolean {
  if (rule.target.kind !== "range") return false;
  const { start, end } = rule.target;
  if (start === null || end === null) return false;
  return (
    Math.min(start, end) === block.start && Math.max(start, end) === block.end
  );
}

/** The side a block is explicitly assigned to ("" = not assigned). */
function blockAssignment(block: UnicodeBlock): FontSide | "" {
  const rules = store.get().rules;
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]!;
    if (!isExactBlockRule(rule, block)) continue;
    if (rule.fonts.length !== 1) continue;
    const ref = rule.fonts[0]!;
    if (ref === "base") return "base";
    if (ref === "donor-0") return "donor";
  }
  return "";
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
  // Two pointers over the sorted coverages, swept along the block span.
  let bi = lowerBound(base, block.start);
  let di = lowerBound(donor, block.start);
  let side: FontSide | "" | null = null;
  for (let cp = block.start; cp <= block.end; cp++) {
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
 * The side every non-neutral block of a group carries ("" when they
 * disagree or any covered block is mixed; neutral blocks — nothing
 * covered, no explicit rule — don't vote).
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
    if (def === null || def === undefined) continue;
    if (def === "") return "";
    if (side === "") side = def;
    else if (side !== def) return "";
  }
  return side;
}

/**
 * Assign one block to a side through the rule state: an exact range
 * rule with the side's ref as the only font. Assigning the side the
 * block already carries (explicitly or by default) REVERTS it to the
 * default (prototype parity).
 */
function assignBlocks(
  blocks: readonly UnicodeBlock[],
  side: FontSide,
): void {
  const ref = sideRef(side);
  if (ref === null) return;
  const exact = new Set(
    blocks.flatMap((block) =>
      store
        .get()
        .rules.filter((rule) => isExactBlockRule(rule, block))
        .map((rule) => rule.id),
    ),
  );
  const already = effectiveGroupSide(blocks, pickRefs()) === side;
  const rules = store.get().rules.filter((rule) => !exact.has(rule.id));
  if (!already) {
    for (const block of blocks) {
      rules.push(
        newRule({ kind: "range", start: block.start, end: block.end }, [ref]),
      );
    }
  }
  mutateRules(rules);
}

/* ---------------- shared font list ---------------------------- */

/**
 * The ordered font list editor shared by the single-codepoint and batch
 * editors: one line per ref (checkbox + order controls). `working` is
 * mutated in place (the module-level editor state); `rebuild` re-renders
 * the owning editor.
 */
function buildOrderedFontList(
  picks: PickRefs,
  working: string[],
  rolePrefix: string,
  rebuild: () => void,
): HTMLElement {
  const list = document.createElement("div");
  list.className = "rule-fonts";
  const order = [
    ...working,
    ...picks.refs.filter((ref) => !working.includes(ref)),
  ];
  for (const ref of order) {
    const checked = working.includes(ref);
    const line = document.createElement("div");
    line.className = "rule-font-line";
    line.dataset.fontRef = ref;
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.dataset.role = `${rolePrefix}-font-${ref}`;
    box.checked = checked;
    box.addEventListener("change", () => {
      if (box.checked) {
        working.push(ref);
      } else {
        const at = working.indexOf(ref);
        if (at >= 0) working.splice(at, 1);
      }
      rebuild();
    });
    label.appendChild(box);
    label.appendChild(document.createTextNode(` ${refLabel(ref, picks)}`));
    line.appendChild(label);
    for (const [direction, delta] of [
      ["up", -1],
      ["down", 1],
    ] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "rule-font-move kit-btn sm gh";
      button.dataset.role = `${rolePrefix}-font-${direction}-${ref}`;
      button.textContent = delta < 0 ? "↑" : "↓";
      button.disabled = !checked;
      button.addEventListener("click", () => {
        const from = working.indexOf(ref);
        const to = from + delta;
        if (from < 0 || to < 0 || to >= working.length) return;
        working.splice(to, 0, working.splice(from, 1)[0]!);
        rebuild();
      });
      line.appendChild(button);
    }
    list.appendChild(line);
  }
  return list;
}

/* ---------------- the 按编码指定 range popup ------------------------ */

/**
 * The range-specify popup (按编码指定): the kit's .kit-pop chrome with
 * two codepoint inputs and the two side actions — one more entry to the
 * SAME range-rule machinery the rail and the segments use.
 */
function mountRangePopup(anchor: HTMLElement): { open(): void } {
  const popup = document.createElement("div");
  popup.className = "kit-pop range-pop";
  popup.dataset.rangePopup = "";
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-label", "按编码指定");
  const title = document.createElement("h5");
  title.textContent = "按编码指定";
  const hint = document.createElement("p");
  hint.className = "kit-sub";
  hint.textContent = "把一段码位整体指定给一侧字体（创建一条区间规则）。";
  const startInput = document.createElement("input");
  startInput.type = "search";
  startInput.spellcheck = false;
  startInput.dataset.role = "range-start";
  startInput.placeholder = "起始（如 4E00）";
  startInput.setAttribute("aria-label", "起始码位");
  const endInput = document.createElement("input");
  endInput.type = "search";
  endInput.spellcheck = false;
  endInput.dataset.role = "range-end";
  endInput.placeholder = "结束（如 9FFF）";
  endInput.setAttribute("aria-label", "结束码位");
  const actions = document.createElement("div");
  actions.className = "range-pop-actions";
  const error = document.createElement("div");
  error.className = "range-pop-error";
  error.dataset.role = "range-error";
  error.hidden = true;
  const apply = (side: FontSide): void => {
    const ref = sideRef(side);
    const start = parseCodepointInput(startInput.value);
    const end = parseCodepointInput(endInput.value);
    if (ref === null || start === null || end === null) {
      error.hidden = false;
      error.textContent = "请输入两个有效的码位（如 4E00 与 9FFF）。";
      return;
    }
    mutateRules([
      ...store.get().rules,
      newRule(
        {
          kind: "range",
          start: Math.min(start, end),
          end: Math.max(start, end),
        },
        [ref],
      ),
    ]);
    close();
  };
  for (const [side, label] of [
    ["base", "用英文字体"],
    ["donor", "用中文字体"],
  ] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "kit-btn sm";
    button.dataset.role = `range-${side}`;
    button.textContent = label;
    button.addEventListener("click", () => apply(side));
    actions.appendChild(button);
  }
  popup.append(title, hint, startInput, endInput, error, actions);
  document.body.appendChild(popup);

  let open = false;
  const position = (): void => {
    fitPopup(popup, anchor.getBoundingClientRect());
  };
  const close = (): void => {
    if (!open) return;
    open = false;
    error.hidden = true;
    popup.classList.remove("open");
  };
  anchor.addEventListener("click", () => {
    open = !open;
    if (open) {
      popup.classList.add("open");
      position();
    } else {
      close();
    }
  });
  popup.addEventListener("pointerdown", (e) => e.stopPropagation());
  document.addEventListener("pointerdown", (e) => {
    if (!open) return;
    const target = e.target as Node;
    if (!target.isConnected) return;
    if (popup.contains(target) || anchor.contains(target)) return;
    close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) close();
  });
  window.addEventListener("resize", () => {
    if (open) position();
  });
  return { open: () => {
    if (!open) {
      open = true;
      popup.classList.add("open");
      position();
    }
  } };
}

/* ---------------------- chip data ----------------------------------- */

const GROUP_ICONS: Record<string, IconName> = {
  "latin-europe": "type",
  symbols: "shapes",
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
 * Locate a typed codepoint (hex form or a single character): jump to its
 * category page, select it, and scroll it into view.
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
  if (block) {
    categoryId = block.id;
    page = Math.floor((cp - block.start) / CELLS_PER_PAGE) + 1;
  } else if (cp >= 0x20) {
    // The aggregate view: index within it, surrogate gap included.
    const bmpEnd = 0xd7ff;
    const index = cp <= bmpEnd ? cp - 0x20 : cp - 0xe000 + (bmpEnd - 0x20 + 1);
    page = Math.floor(index / CELLS_PER_PAGE) + 1;
  }
  store.set({ categoryId, page });
  // Locating is a selection gesture too: the codepoint becomes the
  // selection and the anchor, and the details cursor lands on it.
  beginSelectionGesture([cp], cp, cp);
  // Bring the cell into view (prototype parity: locate scrolls to it).
  window.setTimeout(() => {
    const cell = activeGrid?.cellAt(String.fromCodePoint(cp));
    if (cell && cell.isConnected) cell.scrollIntoView({ block: "center" });
  }, 60);
}

/* ------------------------------ mount ------------------------------- */

export function mountCharmap(root: HTMLElement): void {
  root.innerHTML = `
    <div class="charmap-categories" aria-label="字符分类"></div>
    <div class="charmap-main">
      <div class="charmap-details" data-details></div>
      <div class="charmap-toolbar"></div>
      <div class="charmap-grid"></div>
    </div>
  `;

  const categories = root.querySelector<HTMLElement>(".charmap-categories")!;
  const details = root.querySelector<HTMLElement>("[data-details]")!;
  const toolbar = root.querySelector<HTMLElement>(".charmap-toolbar")!;
  const gridHost = root.querySelector<HTMLElement>(".charmap-grid")!;

  /* 编码 mode: the per-cell codepoint row (view state of this stage). */
  let showCodepoints = false;

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
    onToggleMulti: () => beginSelectionGesture([], null),
    onToggleCodepoints: () => {
      showCodepoints = !showCodepoints;
      render();
    },
  });
  const rangePopup = mountRangePopup(
    toolbar // re-anchored on every action-bar render (see syncRangeAnchor)
  );
  const grid: CharGrid = mountCharGrid(gridHost);
  activeGrid = grid;

  /** The live 按编码指定 anchor inside the (rebuilt) action bar. */
  const syncRangeAnchor = (): void => {
    const anchor = toolbar.querySelector<HTMLButtonElement>(
      "[data-role='range-specify']",
    );
    if (anchor && rangeAnchor !== anchor) {
      rangeAnchor = anchor;
      anchor.addEventListener("click", () => rangePopup.open());
    }
  };
  let rangeAnchor: HTMLButtonElement | null = null;

  /* ---------------- multi-select gestures (issue #20) ---------------
   * All cell interaction happens at pointer-down: a plain click must
   * patch the store synchronously, and a synchronous patch re-renders
   * the grid (replacing the cell node) BEFORE the compatibility click
   * event lands — a click-time handler would never fire. Drag-paint and
   * Ctrl-drag-paint (additive) start here; shift extends from the
   * anchor instead of starting a paint. */
  let painting = false;

  const cellCodepoint = (target: EventTarget | null): number | null => {
    if (!(target instanceof Element)) return null;
    const cp = target.closest<HTMLElement>(".kit-cell")?.dataset.cp;
    if (!cp) return null;
    return Number.parseInt(cp.slice(2), 16);
  };

  grid.el.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const cp = cellCodepoint(event.target);
    if (cp === null) return;
    // NOTE: no preventDefault here — canceling pointerdown makes the
    // browser drop the held-button state and swallow the drag's pointer
    // moves (observed in Chromium); user-select: none on the grid
    // already keeps the drag from selecting text.
    if (event.shiftKey) {
      extendFromAnchor(cp);
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      // Additive paint: one gesture — one undo entry covers the run the
      // drag is about to paint plus this cell.
      const { selection, selectionAnchor } = store.get();
      beginSelectionGesture(
        [...new Set([...selection, cp])].sort((a, b) => a - b),
        selectionAnchor,
      );
      painting = true;
      return;
    }
    painting = true;
    beginSelectionGesture([cp], cp, cp);
  });
  grid.el.addEventListener("pointermove", (event) => {
    if (!painting) return;
    event.preventDefault();
    const cp = cellCodepoint(event.target);
    if (cp !== null) extendSelection([cp]);
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
      beginSelectionGesture([cp], cp, cp);
      return;
    }
    const lo = Math.min(anchorIndex, cpIndex);
    const hi = Math.max(anchorIndex, cpIndex);
    const range: number[] = [];
    for (let n = lo; n <= hi; n++) range.push(nthCodepoint(categoryId, n));
    beginSelectionGesture(range, selectionAnchor, cp);
  }

  /** Locate a typed codepoint (hex form or a single character):
   *  jump to its category page and select it. */
  const locate = locateQuery;

  const render = (): void => {
    const {
      categoryId,
      page,
      selected,
      selectedCodepoint,
      selection,
      fonts,
    } = store.get();
    const missing = missingCodepoints();
    const last =
      categoryId === MISSING_CATEGORY_ID
        ? Math.max(1, Math.ceil(missing.length / CELLS_PER_PAGE))
        : pageCountFor(categoryId);
    const safePage = Math.min(Math.max(page, 1), last);

    renderChips(categoryId);
    renderToolbar(categoryId, safePage, last, selection);
    renderDetails(
      details,
      selectedCodepoint,
      selection,
      fonts,
      selected,
      painting,
    );
    renderGrid(
      categoryId,
      safePage,
      selected.en,
      selected.cjk,
      selectedCodepoint,
      selection,
      missing,
    );
    syncRangeAnchor();
  };
  store.subscribe(render);
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
        // the declared preset scope has uncovered codepoints.
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
                count: b.end - b.start + 1,
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
        multi: selection.length > 0,
        showCodepoints,
        canUndo: canUndoRules(),
        onUndo: () => undoRules(),
        onToggleMulti: () => beginSelectionGesture([], null),
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
    const effective = picks.base !== null && picks.donor !== null;

    if (selection.length >= 2 && !painting) {
      actionBar.render({
        multi: true,
        showCodepoints,
        canUndo: canUndoRules(),
        onUndo: () => undoRules(),
        onToggleMulti: () => beginSelectionGesture([], null),
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
            if (ref !== null) applyBatchRule([ref]);
          },
          onUndoPick: () => undoSelection(),
        },
        onRangeSpecify: () => rangePopup.open(),
      });
      return;
    }

    actionBar.render({
      group:
        group !== undefined && effective
          ? {
              label: group.name,
              allBase: effectiveGroupSide(group.blocks, picks) === "base",
              allDonor: effectiveGroupSide(group.blocks, picks) === "donor",
              onAssign: (side) => assignBlocks(group.blocks, side),
            }
          : undefined,
      block:
        block !== undefined
          ? effective
            ? {
                label: block.name,
                aggregate: false,
                value: effectiveBlockSide(block, picks),
                onAssign: (side) => assignBlocks([block], side),
              }
            : {
                label: block.name,
                aggregate: true,
                count: block.end - block.start + 1,
              }
          : categoryId === ALL_CATEGORY_ID
            ? { label: "全部", aggregate: true, count: categorySize(categoryId) }
            : {
                label: categoryName(categoryId),
                aggregate: true,
                count: categorySize(categoryId),
              },
      multi: selection.length > 0,
      showCodepoints,
      canUndo: canUndoRules(),
      onUndo: () => undoRules(),
      onToggleMulti: () => beginSelectionGesture([], null),
      onToggleCodepoints: () => {
        showCodepoints = !showCodepoints;
        render();
      },
      page: { page: safePage - 1, count: last, onPage: (delta) => {
        const { page: current } = store.get();
        store.set({ page: Math.min(Math.max(current + delta, 1), last) });
      } },
      adjustedLegend: true,
      onLocate: locate,
      onRangeSpecify: () => rangePopup.open(),
    });
  }
  /* ---------------- grid ---------------- */

  /** The grid's cell data for the current page, resolved effectively. */
  function renderGrid(
    categoryId: string,
    page: number,
    enFamily: string | null,
    cjkFamily: string | null,
    selectedCodepoint: number | null,
    selection: readonly number[],
    missing: readonly number[] = missingCodepoints(),
  ): void {
    const size =
      categoryId === MISSING_CATEGORY_ID
        ? missing.length
        : categorySize(categoryId);
    const first = (page - 1) * CELLS_PER_PAGE;
    const count = Math.min(CELLS_PER_PAGE, size - first);
    const picks = pickRefs();
    const effective = picks.base !== null && picks.donor !== null;
    const resolver = effective ? currentResolver(picks) : null;
    const base = effective ? defaultResolver(picks) : null;
    const selectionSet = new Set(selection);
    // The plain preview stack for cells outside the effective preview
    // (the picked pair first, then the system tail) — the same stack the
    // pre-repair grid set as --font-preview.
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
      // danger cell (no picked font covers it, by construction).
      if (categoryId === MISSING_CATEGORY_ID) {
        const cp = missing[first + i]!;
        cells.push({
          ch: String.fromCodePoint(cp),
          state: "none",
          selected: selectionSet.has(cp),
          cursor: cp === selectedCodepoint,
          cp: formatCp(cp),
        });
        continue;
      }
      const cp = nthCodepoint(categoryId, first + i);
      const ch = String.fromCodePoint(cp);
      // The effective merged result: resolve, expose, render in the
      // winner's own face (the grid never lies — issue #18).
      const entry = resolver ? resolver.resolve(cp) : null;
      const baseEntry = base ? base.resolve(cp) : null;
      const winnerFont = entry ? refFont(entry.winner, picks) : null;
      cells.push({
        ch,
        state: entry
          ? entry.winner === "base"
            ? "base"
            : "donor"
          : effective
            ? "none"
            : "plain",
        // Adjusted = the effective winner differs from the no-rule default.
        adjusted:
          entry !== null && baseEntry !== null
            ? entry.winner !== baseEntry.winner
            : false,
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
    grid.render({ cells, showCodepoints, cellSize: 40 });
  }

}

/**
 * Click-reachable cell information (ADR-0004: no hover-only info): the
 * codepoint, the character, and — with a full pick pair — the effective
 * result (winning font, via, kind). Below the facts sits the
 * single-codepoint precedence editor — or, when a multi-selection is
 * active, the batch precedence editor for the whole selection.
 *
 * The dock COLLAPSES to zero height while nothing is selected (prototype
 * density: its unselected frames have no strip between the chip bar and
 * the toolbar). It expands the moment a cursor or selection exists — but
 * never mid-drag: `painting` holds the collapsed/open state steady while
 * the pointer is held, the same fixed-geometry discipline issue #20
 * forced on this strip (an expansion at drag start would shift the grid
 * under the pointer and paint the wrong cells). Paint end is the moment
 * the strip may re-open.
 */
function renderDetails(
  details: HTMLElement,
  codepoint: number | null,
  selection: readonly number[],
  fonts: ReturnType<typeof store.get>["fonts"],
  selected: { en: string | null; cjk: string | null },
  painting: boolean,
): void {
  const open = !painting && (codepoint !== null || selection.length >= 2);
  details.dataset.open = String(open);
  details.replaceChildren();
  if (!open) return;
  if (selection.length >= 2) {
    details.appendChild(buildBatchEditor(selection));
    return;
  }
  const head = document.createElement("div");
  const ch = String.fromCodePoint(codepoint);
  const picks = pickRefs();
  const effective = picks.base !== null && picks.donor !== null;
  const resolver = effective ? currentResolver(picks) : null;
  const entry = resolver ? resolver.resolve(codepoint) : null;
  if (entry) {
    const via =
      entry.via === "default" ? "默认" : `规则 ${entry.via}`;
    const kind =
      entry.kind === "base" ? "保留" : entry.kind === "fill" ? "填充" : "覆盖";
    head.textContent =
      `码位 ${formatCp(codepoint)} · 字符 “${ch}” · ` +
      `生效：${refLabel(entry.winner, picks)} · 来源：${via} · 方式：${kind}`;
  } else if (effective) {
    head.textContent = `码位 ${formatCp(codepoint)} · 字符 “${ch}” · 未被所选字体覆盖`;
  } else {
    const covers = (key: string | null, label: string): string => {
      const font = fonts.find((f) => f.cssFamily === key);
      if (!font) return "";
      return coversCodepoint(font, codepoint) ? ` ${label} ${font.family}` : "";
    };
    const hits =
      covers(selected.en, "英文字体") + covers(selected.cjk, "中文字体");
    head.textContent =
      `码位 ${formatCp(codepoint)} · 字符 “${ch}” · ` +
      (hits.trim() ? `覆盖：${hits.trim()}` : "未被所选字体覆盖");
  }
  details.appendChild(head);

  if (effective) {
    openEditor(codepoint, picks);
    details.appendChild(
      buildCpRuleEditor(codepoint, picks),
    );
  } else {
    editorFor = null;
  }
}

/**
 * The precedence editor of the selected codepoint: one row per font ref
 * (checkbox + order controls) plus apply/remove. Edits a working list;
 * 应用 commits it as (or onto) the codepoint's rule — the grid updates
 * in place, never by reload.
 */
function buildCpRuleEditor(
  codepoint: number,
  picks: PickRefs,
): HTMLElement {
  const editor = document.createElement("div");
  editor.className = "cp-rule-editor";
  editor.dataset.role = "cp-rule-editor";

  const title = document.createElement("div");
  title.className = "cp-rule-title";
  title.textContent = "该码位的优先级（列表顺序，首个持有者生效）";
  editor.appendChild(title);

  editor.appendChild(
    buildOrderedFontList(picks, editorFonts, "cp", renderCpLines),
  );

  const actions = document.createElement("div");
  actions.className = "cp-rule-actions";
  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "kit-btn sm";
  apply.dataset.role = "cp-rule-apply";
  apply.textContent = existingCpRule(codepoint) ? "应用修改" : "设为规则";
  apply.addEventListener("click", () => applyCodepointRule(codepoint));
  actions.appendChild(apply);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "kit-btn sm gh";
  remove.dataset.role = "cp-rule-remove";
  remove.textContent = "移除规则";
  remove.disabled = existingCpRule(codepoint) === undefined;
  remove.addEventListener("click", () => removeCodepointRule(codepoint));
  actions.appendChild(remove);
  editor.appendChild(actions);

  /** Rebuild the editor in place (the working list changed). */
  function renderCpLines(): void {
    const fresh = buildCpRuleEditor(codepoint, picks);
    editor.replaceWith(fresh);
  }
  return editor;
}

/** The rule whose target is exactly this codepoint, when one exists. */
function existingCpRule(codepoint: number): EditorRule | undefined {
  return store.get().rules.find((rule) => targetsCodepoint(rule, codepoint));
}

/**
 * The batch precedence editor of the multi-selection: the selection
 * summary, the plan (what one 批量应用 will create — stated in plain
 * text, never hover-only), the ordered font list, and the selection's
 * own controls (clear, undo).
 */
function buildBatchEditor(selection: readonly number[]): HTMLElement {
  const picks = pickRefs();
  const sorted = [...selection].sort((a, b) => a - b);
  const signature = sorted.join(",");
  if (signature !== batchSignature) {
    batchSignature = signature;
    batchFonts = [...picks.refs];
  }
  const runs = selectionRuns(sorted);
  const contiguous = runs.length === 1;
  const lo = sorted[0]!;
  const hi = sorted[sorted.length - 1]!;

  const editor = document.createElement("div");
  editor.className = "batch-editor";
  editor.dataset.role = "batch-editor";

  const summary = document.createElement("div");
  summary.className = "batch-summary";
  summary.textContent = contiguous
    ? `已选 ${sorted.length} 码位 · 连续区间 ${formatCp(lo)}–${formatCp(hi)}`
    : `已选 ${sorted.length} 码位 · 不连续（${runs.length} 段）`;
  editor.appendChild(summary);

  const plan = document.createElement("div");
  plan.className = "batch-plan";
  plan.dataset.role = "batch-plan";
  plan.textContent =
    contiguous && sorted.length > 1
      ? `将创建 1 条区间规则（0x${lo.toString(16).toUpperCase()}-0x${hi.toString(16).toUpperCase()}）`
      : `将创建 ${sorted.length} 条码位规则`;
  editor.appendChild(plan);

  const actions = document.createElement("div");
  actions.className = "cp-rule-actions";
  if (picks.refs.length > 0) {
    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "kit-btn sm";
    apply.dataset.role = "batch-apply";
    apply.textContent = "批量应用";
    apply.addEventListener("click", () => applyBatchRule(batchFonts));
    actions.appendChild(apply);
    editor.appendChild(
      buildOrderedFontList(picks, batchFonts, "batch", renderBatch),
    );
  }
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "kit-btn sm gh";
  clear.dataset.role = "selection-clear";
  clear.textContent = "清除选择";
  clear.addEventListener("click", () =>
    beginSelectionGesture([], null),
  );
  actions.appendChild(clear);
  const undo = document.createElement("button");
  undo.type = "button";
  undo.className = "kit-btn sm";
  undo.dataset.role = "selection-undo";
  undo.textContent = "撤销选择";
  undo.disabled = !canUndoSelection();
  undo.addEventListener("click", () => undoSelection());
  actions.appendChild(undo);
  editor.appendChild(actions);

  /** Rebuild in place (the working font list changed). */
  function renderBatch(): void {
    editor.replaceWith(buildBatchEditor(selection));
  }
  return editor;
}

function coversCodepoint(font: { codepoints: number[] }, cp: number): boolean {
  const arr = font.codepoints;
  let lo = 0;
  let hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] === cp) return true;
    if (arr[mid] < cp) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

export function formatCp(cp: number): string {
  return "U+" + cp.toString(16).toUpperCase().padStart(4, "0");
}

export { pageCountFor, categoryName, categoryIntervals };
