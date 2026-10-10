import { store } from "../state";
import {
  ALL_CATEGORY_ID,
  BLOCK_GROUPS,
  CELLS_PER_PAGE,
  categorySize,
  categoryName,
  nthCodepoint,
  pageCountFor,
} from "../unicode/blocks";

/**
 * Character map (ADR-0004): hierarchical categories + the "all" aggregate
 * view, a uniform grid of 1024 cells per page, a pager with goto/page jump.
 *
 * The grid renders the codepoints of the active category; the preview font
 * stack comes from the selected base/donor fonts (set as a CSS variable, so
 * re-selecting fonts never rebuilds the grid).
 */
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

  buildCategoryTree(categories);

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

  const render = (): void => {
    const { categoryId, page, selected, selectedCodepoint, fonts } = store.get();
    const last = pageCountFor(categoryId);
    const safePage = Math.min(Math.max(page, 1), last);

    indicator.textContent = `第 ${safePage} / ${last} 页`;
    prev.disabled = safePage <= 1;
    next.disabled = safePage >= last;

    renderDetails(details, selectedCodepoint, fonts, selected);
    renderGrid(
      grid,
      categoryId,
      safePage,
      selected.en,
      selected.cjk,
      selectedCodepoint,
    );
    syncCategorySelection(categories, categoryId);
  };
  store.subscribe(render);
  render();
}

/**
 * Click-reachable cell information (ADR-0004: no hover-only info). Shows the
 * codepoint, the character, and which of the selected fonts covers it.
 */
function renderDetails(
  details: HTMLElement,
  codepoint: number | null,
  fonts: ReturnType<typeof store.get>["fonts"],
  selected: { en: string | null; cjk: string | null },
): void {
  if (codepoint === null) {
    details.textContent = "点击任一字符格，查看码位与所选字体的覆盖情况。";
    return;
  }
  const covers = (key: string | null, label: string): string => {
    const font = fonts.find((f) => f.cssFamily === key);
    if (!font) return "";
    return coversCodepoint(font, codepoint) ? ` ${label}·${font.family}` : "";
  };
  const hits =
    covers(selected.en, "英文字体") + covers(selected.cjk, "中文字体");
  details.textContent =
    `码位 ${formatCp(codepoint)} · 字符 “${String.fromCodePoint(codepoint)}” · ` +
    (hits.trim() ? `覆盖：${hits.trim()}` : "未被所选字体覆盖");
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
): void {
  const size = categorySize(categoryId);
  const first = (page - 1) * CELLS_PER_PAGE;
  const count = Math.min(CELLS_PER_PAGE, size - first);

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
    cell.classList.toggle("is-selected", cp === selectedCodepoint);
    cell.addEventListener("click", () =>
      store.set({ selectedCodepoint: cp }),
    );
    fragment.appendChild(cell);
  }
  grid.replaceChildren(fragment);

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
