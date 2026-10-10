/**
 * The language-preset picker (issue #18): an ADR-0004 popup listing the
 * fc-lang presets (featured five first, then every language), with
 * search. Picking one adds a preset rule with ALL sub-blocks enabled —
 * the preset's full union; the row's sub-block toggles then compose
 * partial unions (ticket #7 semantics).
 *
 * The popup node is created ONCE and appended to <body> (never inside
 * the rail); only rows rebuild. Positioning clamps to the app frame:
 * below first, flip above, cap with internal scroll.
 */

import { store } from "../state";
import { newRule } from "../precedence/model";
import { pickRefs } from "../precedence/picks";
import presetsData from "../data/presets.json";

interface PresetRow {
  name: string;
  codepoints: number;
  subBlocks: string[];
}

const ROWS: PresetRow[] = (
  presetsData.presets as Array<{
    name: string;
    codepoints: number;
    sub_blocks: Array<{ name: string }>;
  }>
).map((preset) => ({
  name: preset.name,
  codepoints: preset.codepoints,
  subBlocks: preset.sub_blocks.map((block) => block.name),
}));

/** Wire the picker to its anchor button; the popup mounts on <body>. */
export function mountPresetPicker(anchor: HTMLElement): void {
  const popup = document.createElement("div");
  popup.className = "picker-popup preset-picker-popup";
  popup.dataset.pickerPopup = "preset-add";
  popup.setAttribute("role", "listbox");
  popup.setAttribute("aria-label", "语言预设列表");
  popup.innerHTML = `
    <div class="popup-clip">
      <div class="popup-search">
        <input class="picker-search" type="search" placeholder="搜索语言预设…" aria-label="搜索语言预设" />
      </div>
      <div class="popup-scroll"><div class="popup-rows"></div></div>
    </div>
  `;
  document.body.appendChild(popup);

  const rowsEl = popup.querySelector<HTMLElement>(".popup-rows")!;
  const searchInput = popup.querySelector<HTMLInputElement>(".picker-search")!;

  let open = false;
  let query = "";

  const setOpen = (next: boolean): void => {
    if (open === next) return;
    open = next;
    anchor.setAttribute("aria-expanded", String(next));
    if (next) {
      popup.dataset.open = "true";
      position();
    } else {
      delete popup.dataset.open;
    }
  };

  /** Clamp to the app frame: below first, flip above, then cap. */
  const position = (): void => {
    const margin = 8;
    const gap = 6;
    const anchorRect = anchor.getBoundingClientRect();
    const pw = popup.offsetWidth;
    const ph = popup.offsetHeight;
    const frameW = window.innerWidth;
    const frameH = window.innerHeight;

    let left = anchorRect.left;
    if (left + pw > frameW - margin) left = frameW - pw - margin;
    if (left < margin) left = margin;

    let top = anchorRect.bottom + gap;
    if (top + ph > frameH - margin) {
      const above = anchorRect.top - ph - gap;
      if (above >= margin) {
        top = above;
      } else {
        top = margin;
        popup.style.maxHeight = `${frameH - 2 * margin}px`;
      }
    }
    popup.style.left = `${Math.round(left)}px`;
    popup.style.top = `${Math.round(top)}px`;
  };

  anchor.addEventListener("click", () => setOpen(!open));
  window.addEventListener("resize", () => {
    if (open) position();
  });
  document.addEventListener("pointerdown", (e) => {
    if (!open) return;
    const target = e.target as Node;
    if (popup.contains(target) || anchor.contains(target)) return;
    setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) setOpen(false);
  });

  searchInput.addEventListener("input", () => {
    query = searchInput.value.trim().toLowerCase();
    renderRows();
  });

  const addPreset = (row: PresetRow): void => {
    store.set({
      rules: [
        ...store.get().rules,
        newRule(
          { kind: "preset", name: row.name, blocks: [...row.subBlocks] },
          pickRefs().refs,
        ),
      ],
    });
    setOpen(false);
  };

  /** Rows rebuild only — the popup node and its scroll state persist. */
  const renderRows = (): void => {
    const fragment = document.createDocumentFragment();
    const group = (text: string): void => {
      const label = document.createElement("div");
      label.className = "picker-group-label";
      label.textContent = text;
      fragment.appendChild(label);
    };
    const append = (row: PresetRow): void => {
      const el = document.createElement("div");
      el.className = "picker-row preset-row";
      el.setAttribute("role", "option");
      const name = document.createElement("span");
      name.className = "picker-row-name";
      name.textContent = row.name;
      el.appendChild(name);
      const count = document.createElement("span");
      count.className = "picker-row-tag";
      count.textContent = `${row.codepoints.toLocaleString("en-US")} 码位`;
      el.appendChild(count);
      el.addEventListener("click", () => addPreset(row));
      fragment.appendChild(el);
    };

    const featured = ROWS.filter(
      (row) =>
        presetsData.featured.includes(row.name) &&
        row.name.toLowerCase().includes(query),
    );
    if (featured.length > 0) {
      group("常用");
      for (const row of featured) append(row);
    }
    const rest = ROWS.filter(
      (row) =>
        !presetsData.featured.includes(row.name) &&
        row.name.toLowerCase().includes(query),
    );
    if (rest.length > 0) {
      group("全部语言");
      for (const row of rest) append(row);
    }
    if (fragment.childNodes.length === 0) {
      const empty = document.createElement("div");
      empty.className = "picker-empty";
      empty.textContent = query
        ? `没有匹配“${searchInput.value.trim()}”的语言预设。`
        : "没有可选的语言预设。";
      fragment.appendChild(empty);
    }
    rowsEl.replaceChildren(fragment);
    if (open) position();
  };

  // Opening rebuilds the rows (state may have changed since last open).
  anchor.addEventListener("click", () => {
    if (open) renderRows();
  });
}
