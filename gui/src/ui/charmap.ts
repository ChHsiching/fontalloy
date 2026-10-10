import { store } from "../state";
import {
  ALL_CATEGORY_ID,
  ALL_BLOCKS,
  BLOCK_GROUPS,
  CELLS_PER_PAGE,
  categorySize,
  categoryName,
  codepointIndex,
  nthCodepoint,
  pageCountFor,
} from "../unicode/blocks";
import { newRule, parseCodepointInput, type EditorRule } from "../precedence/model";
import { currentResolver } from "../precedence/live";
import { pickRefs, refFont, refLabel, type PickRefs } from "../precedence/picks";
import {
  beginSelectionGesture,
  canUndoSelection,
  extendSelection,
  mutateRules,
  undoSelection,
} from "../history";
import { cssFamily } from "./picker";

/**
 * Character map (ADR-0004): hierarchical categories + the "all" aggregate
 * view, a uniform grid of 1024 cells per page, a pager with goto/page jump
 * and a typed-codepoint locator.
 *
 * Since issue #18 the grid renders the EFFECTIVE merged result: each cell
 * is resolved through the client-side precedence mirror (same semantics
 * as the core resolver) against the coverage of the actually-loaded
 * fonts, rendered in the winning font's own face, and carries its
 * resolution as DOM attributes (`data-winner` / `data-via` /
 * `data-kind`) — the grid never lies, however complex the rules. Cells
 * no font of the build covers fall back to the plain preview stack and
 * state so in the details strip. Selecting a cell opens the
 * single-codepoint precedence editor; typing a codepoint locates it.
 *
 * Since issue #20 the grid is also multi-selectable: drag-paint,
 * Ctrl-drag-paint (additive runs), and shift-range from a click anchor.
 * A selection of two or more opens the batch precedence editor in the
 * details strip — one action applies a font list to the whole selection.
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
function applyBatchRule(): void {
  const { selection } = store.get();
  if (selection.length === 0 || batchFonts.length === 0) return;
  const sorted = [...selection].sort((a, b) => a - b);
  const runs = selectionRuns(sorted);
  const selectedSet = new Set(sorted);
  const fonts = [...batchFonts];
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
      newRule({ kind: "range", start: singleRun.start, end: singleRun.end }, fonts),
    );
  } else {
    for (const cp of sorted) {
      rules.push(newRule({ kind: "codepoint", cp }, fonts));
    }
  }
  mutateRules(rules);
}

/* ---------------------- shared font list ---------------------------- */

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
      button.className = "rule-font-move";
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

/* ------------------------------ mount ------------------------------- */

export function mountCharmap(root: HTMLElement): void {
  root.innerHTML = `
    <nav class="charmap-categories" aria-label="字符分类"></nav>
    <div class="charmap-main">
      <div class="charmap-details" data-details></div>
      <div class="charmap-pager">
        <button class="page-prev" disabled>‹ 上一页</button>
        <span class="page-indicator"></span>
        <button class="page-next">下一页 ›</button>
        <span class="page-goto-box">
          <input class="page-goto-input" type="number" min="1" inputmode="numeric"
                 aria-label="跳转到页码" placeholder="页码" />
          <button class="page-goto">跳转</button>
        </span>
        <span class="page-cp-box">
          <input data-role="cp-locate-input" type="search" spellcheck="false"
                 aria-label="定位码位" placeholder="码位（如 4E2D）" />
          <button data-role="cp-locate" type="button">定位</button>
        </span>
      </div>
      <div class="charmap-grid" role="grid"></div>
    </div>
  `;

  const categories = root.querySelector<HTMLElement>(".charmap-categories")!;
  const details = root.querySelector<HTMLElement>("[data-details]")!;
  const grid = root.querySelector<HTMLElement>(".charmap-grid")!;
  const indicator = root.querySelector<HTMLElement>(".page-indicator")!;
  const prev = root.querySelector<HTMLButtonElement>(".page-prev")!;
  const next = root.querySelector<HTMLButtonElement>(".page-next")!;
  const gotoInput = root.querySelector<HTMLInputElement>(".page-goto-input")!;
  const gotoBtn = root.querySelector<HTMLButtonElement>(".page-goto")!;
  const locateInput = root.querySelector<HTMLInputElement>(
    "[data-role='cp-locate-input']",
  )!;
  const locateBtn = root.querySelector<HTMLButtonElement>(
    "[data-role='cp-locate']",
  )!;

  buildCategoryTree(categories);

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
    const cp = target.closest<HTMLElement>(".cell")?.dataset.cp;
    if (!cp) return null;
    return Number.parseInt(cp.slice(2), 16);
  };

  grid.addEventListener("pointerdown", (event) => {
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
  grid.addEventListener("pointermove", (event) => {
    if (!painting) return;
    event.preventDefault();
    const cp = cellCodepoint(event.target);
    if (cp !== null) extendSelection([cp]);
  });
  const stopPaint = (): void => {
    painting = false;
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

  prev.addEventListener("click", () => {
    const { page } = store.get();
    if (page > 1) store.set({ page: page - 1 });
  });
  next.addEventListener("click", () => {
    const { page, categoryId } = store.get();
    if (page < pageCountFor(categoryId)) store.set({ page: page + 1 });
  });
  const jumpTo = (raw: string): void => {
    const target = Number.parseInt(raw, 10);
    if (!Number.isFinite(target)) return;
    const last = pageCountFor(store.get().categoryId);
    store.set({ page: Math.min(Math.max(target, 1), last) });
  };
  gotoBtn.addEventListener("click", () => jumpTo(gotoInput.value));
  gotoInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") jumpTo(gotoInput.value);
  });

  /** Locate a typed codepoint: jump to its block's page and select it. */
  const locate = (raw: string): void => {
    const cp = parseCodepointInput(raw);
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
      const index =
        cp <= bmpEnd ? cp - 0x20 : cp - 0xe000 + (bmpEnd - 0x20 + 1);
      page = Math.floor(index / CELLS_PER_PAGE) + 1;
    }
    locateInput.value = "";
    store.set({ categoryId, page });
    // Locating is a selection gesture too: the codepoint becomes the
    // selection and the anchor, and the details cursor lands on it.
    beginSelectionGesture([cp], cp, cp);
  };
  locateBtn.addEventListener("click", () => locate(locateInput.value));
  locateInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") locate(locateInput.value);
  });

  const render = (): void => {
    const {
      categoryId,
      page,
      selected,
      selectedCodepoint,
      selection,
      fonts,
      rules,
    } = store.get();
    const last = pageCountFor(categoryId);
    const safePage = Math.min(Math.max(page, 1), last);

    indicator.textContent = `第 ${safePage} / ${last} 页`;
    prev.disabled = safePage <= 1;
    next.disabled = safePage >= last;

    const picks = pickRefs();
    renderDetails(details, selectedCodepoint, selection, fonts, selected, picks, rules);
    renderGrid(
      grid,
      categoryId,
      safePage,
      selected.en,
      selected.cjk,
      selectedCodepoint,
      selection,
      picks,
    );
    syncCategorySelection(categories, categoryId);
  };
  store.subscribe(render);
  render();
}

/**
 * Click-reachable cell information (ADR-0004: no hover-only info): the
 * codepoint, the character, and — with a full pick pair — the effective
 * result (winning font, via, kind). Below the facts sits the
 * single-codepoint precedence editor — or, when a multi-selection is
 * active, the batch precedence editor for the whole selection.
 */
function renderDetails(
  details: HTMLElement,
  codepoint: number | null,
  selection: readonly number[],
  fonts: ReturnType<typeof store.get>["fonts"],
  selected: { en: string | null; cjk: string | null },
  picks: PickRefs,
  rules: readonly EditorRule[],
): void {
  details.replaceChildren();
  if (selection.length >= 2) {
    details.appendChild(buildBatchEditor(selection, picks));
    return;
  }
  if (codepoint === null) {
    const hint = document.createElement("div");
    hint.textContent =
      "点击任一字符格，查看码位与生效字体，并调整该码位的优先级。";
    details.appendChild(hint);
    return;
  }
  const head = document.createElement("div");
  const ch = String.fromCodePoint(codepoint);
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
      buildCpRuleEditor(codepoint, picks, rules),
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
  rules: readonly EditorRule[],
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
  apply.dataset.role = "cp-rule-apply";
  apply.textContent = existingCpRule(codepoint, rules) ? "应用修改" : "设为规则";
  apply.addEventListener("click", () => applyCodepointRule(codepoint));
  actions.appendChild(apply);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.dataset.role = "cp-rule-remove";
  remove.textContent = "移除规则";
  remove.disabled = existingCpRule(codepoint, rules) === undefined;
  remove.addEventListener("click", () => removeCodepointRule(codepoint));
  actions.appendChild(remove);
  editor.appendChild(actions);

  /** Rebuild the editor in place (the working list changed). */
  function renderCpLines(): void {
    const fresh = buildCpRuleEditor(codepoint, picks, rules);
    editor.replaceWith(fresh);
  }
  return editor;
}

/** The rule whose target is exactly this codepoint, when one exists. */
function existingCpRule(
  codepoint: number,
  rules: readonly EditorRule[],
): EditorRule | undefined {
  return rules.find((rule) => targetsCodepoint(rule, codepoint));
}

/**
 * The batch precedence editor of the multi-selection: the selection
 * summary, the plan (what one 批量应用 will create — stated in plain
 * text, never hover-only), the ordered font list, and the selection's
 * own controls (clear, undo).
 */
function buildBatchEditor(
  selection: readonly number[],
  picks: PickRefs,
): HTMLElement {
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
    apply.dataset.role = "batch-apply";
    apply.textContent = "批量应用";
    apply.addEventListener("click", () => applyBatchRule());
    actions.appendChild(apply);
    editor.appendChild(
      buildOrderedFontList(picks, batchFonts, "batch", renderBatch),
    );
  }
  const clear = document.createElement("button");
  clear.type = "button";
  clear.dataset.role = "selection-clear";
  clear.textContent = "清除选择";
  clear.addEventListener("click", () =>
    beginSelectionGesture([], null),
  );
  actions.appendChild(clear);
  const undo = document.createElement("button");
  undo.type = "button";
  undo.dataset.role = "selection-undo";
  undo.textContent = "撤销选择";
  undo.disabled = !canUndoSelection();
  undo.addEventListener("click", () => undoSelection());
  actions.appendChild(undo);
  editor.appendChild(actions);

  /** Rebuild in place (the working font list changed). */
  function renderBatch(): void {
    editor.replaceWith(buildBatchEditor(selection, picks));
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

function buildCategoryTree(root: HTMLElement): void {
  // The aggregate view is a permanent first entry.
  const all = document.createElement("button");
  all.className = "block-button is-aggregate";
  all.dataset.category = ALL_CATEGORY_ID;
  all.innerHTML = `<span class="block-name"></span><span class="block-size"></span>`;
  all.querySelector(".block-name")!.textContent = "全部";
  all.querySelector(".block-size")!.textContent =
    categorySize(ALL_CATEGORY_ID).toLocaleString("en-US");
  all.addEventListener("click", () =>
    store.set({ categoryId: ALL_CATEGORY_ID, page: 1 }),
  );
  root.appendChild(all);

  for (const group of BLOCK_GROUPS) {
    const details = document.createElement("div");
    details.className = "category-group";
    const toggle = document.createElement("button");
    toggle.className = "group-toggle";
    toggle.setAttribute("aria-expanded", "false");
    toggle.innerHTML = `<span class="group-caret" aria-hidden="true">▸</span><span class="group-name"></span>`;
    toggle.querySelector(".group-name")!.textContent = group.name;
    const list = document.createElement("div");
    list.className = "group-blocks";
    list.hidden = true;

    toggle.addEventListener("click", () => {
      const open = list.hidden;
      list.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
    });

    for (const b of group.blocks) {
      const btn = document.createElement("button");
      btn.className = "block-button";
      btn.dataset.category = b.id;
      btn.innerHTML = `<span class="block-name"></span><span class="block-size"></span>`;
      btn.querySelector(".block-name")!.textContent = b.name;
      btn.querySelector(".block-size")!.textContent = (
        b.end -
        b.start +
        1
      ).toLocaleString("en-US");
      btn.addEventListener("click", () =>
        store.set({ categoryId: b.id, page: 1 }),
      );
      list.appendChild(btn);
    }

    details.appendChild(toggle);
    details.appendChild(list);
    root.appendChild(details);
  }
}

function syncCategorySelection(root: HTMLElement, categoryId: string): void {
  for (const btn of root.querySelectorAll<HTMLButtonElement>(".block-button")) {
    btn.classList.toggle(
      "is-selected",
      btn.dataset.category === categoryId,
    );
  }
}

function renderGrid(
  grid: HTMLElement,
  categoryId: string,
  page: number,
  enFamily: string | null,
  cjkFamily: string | null,
  selectedCodepoint: number | null,
  selection: readonly number[],
  picks: PickRefs,
): void {
  const size = categorySize(categoryId);
  const first = (page - 1) * CELLS_PER_PAGE;
  const count = Math.min(CELLS_PER_PAGE, size - first);
  const effective = picks.base !== null && picks.donor !== null;
  const resolver = effective ? currentResolver(picks) : null;
  const selectionSet = new Set(selection);

  // Rebuild the cells of the current page; keep the grid container node.
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < count; i++) {
    const cp = nthCodepoint(categoryId, first + i);
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.dataset.cp = formatCp(cp);
    cell.setAttribute("role", "gridcell");
    const ch = document.createElement("span");
    ch.className = "cell-char";
    ch.textContent = String.fromCodePoint(cp);
    cell.appendChild(ch);
    // Three cell states, never conflated (ADR-0004 color semantics):
    // multi-selected and details-selected are accent-family selected
    // states; hover stays neutral. The details cursor additionally
    // carries an inner ring so it reads above the selection.
    cell.classList.toggle("is-selected", cp === selectedCodepoint);
    cell.classList.toggle("is-multi-selected", selectionSet.has(cp));

    // The effective merged result: resolve, expose, render in the
    // winner's own face (the grid never lies — issue #18).
    const entry = resolver ? resolver.resolve(cp) : null;
    if (entry) {
      cell.dataset.winner = entry.winner;
      cell.dataset.via = entry.via;
      cell.dataset.kind = entry.kind;
      cell.classList.add(`is-${entry.kind}`);
      const font = refFont(entry.winner, picks);
      if (font) {
        ch.style.fontFamily = `${cssFamily(font.cssFamily)}, sans-serif`;
      }
    } else {
      cell.classList.add("is-uncovered");
    }

    // Selection/cursor interaction is delegated to the grid container's
    // pointer handlers (see mountCharmap) — no per-cell listeners.
    fragment.appendChild(cell);
  }
  grid.replaceChildren(fragment);

  // The plain preview stack stays set for uncovered cells (and the
  // not-yet-effective single-pick preview); re-selecting fonts never
  // rebuilds the grid around it.
  const stack = [
    enFamily ? `"${enFamily}"` : "",
    cjkFamily ? `"${cjkFamily}"` : "",
    `"Segoe UI"`,
    `"Microsoft YaHei"`,
    `monospace`,
  ]
    .filter(Boolean)
    .join(",");
  grid.style.setProperty("--font-preview", stack);
}

export function formatCp(cp: number): string {
  return "U+" + cp.toString(16).toUpperCase().padStart(4, "0");
}

export { pageCountFor, categoryName };
