/**
 * The language-preset picker (issue #18): an app-level popup on the
 * kit's .kit-pop chrome (positioned with the kit's fitPop discipline —
 * below first, flip above, cap, clamped to the app frame), listing the
 * fc-lang presets (featured five first, then every language), with
 * search. Picking one adds a preset rule with ALL sub-blocks enabled —
 * the preset's full union; the row's sub-block toggles then compose
 * partial unions (ticket #7 semantics).
 *
 * The popup node is created ONCE and appended to <body> (never inside
 * the rail); only rows rebuild.
 */

import { store } from "../state";
import { newRule } from "../precedence/model";
import { pickRefs } from "../precedence/picks";
import presetsData from "../data/presets.json";
import { fitPopup } from "../kit/position";

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
  popup.className = "kit-pop preset-pop";
  popup.dataset.pickerPopup = "preset-add";
  popup.setAttribute("role", "listbox");
  popup.setAttribute("aria-label", "语言预设列表");
  popup.innerHTML = `
    <input class="kit-q" type="search" placeholder="搜索语言预设…" aria-label="搜索语言预设" />
    <div class="preset-pop-scroll"><div class="popup-rows"></div></div>
  `;
  document.body.appendChild(popup);

  const rowsEl = popup.querySelector<HTMLElement>(".popup-rows")!;
  const searchInput = popup.querySelector<HTMLInputElement>(".kit-q")!;

  let open = false;
  let query = "";

  const setOpen = (next: boolean): void => {
    if (open === next) return;
    open = next;
    anchor.setAttribute("aria-expanded", String(next));
    if (next) {
      popup.classList.add("open");
      position();
    } else {
      popup.classList.remove("open");
    }
  };

  /** Clamp to the app frame: below first, flip above, then cap. */
  const position = (): void => {
    fitPopup(popup, anchor.getBoundingClientRect());
  };

  anchor.addEventListener("click", () => {
    if (!open) renderRows();
    setOpen(!open);
  });
  window.addEventListener("resize", () => {
    if (open) position();
  });
  document.addEventListener("pointerdown", (e) => {
    if (!open) return;
    const target = e.target as Node;
    if (!target.isConnected) return;
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
    // A pressed language is already declared (the 文字范围 chips show
    // it): picking it again would declare a duplicate rule — a no-op.
    const declared = store
      .get()
      .rules.some(
        (rule) => rule.target.kind === "preset" && rule.target.name === row.name,
      );
    if (!declared) {
      const refs = pickRefs().refs;
      store.set({
        rules: [
          ...store.get().rules,
          newRule(
            { kind: "preset", name: row.name, blocks: [...row.subBlocks] },
            refs.length > 0 ? refs : ["base", "donor-0"],
          ),
        ],
      });
    }
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
      const el = document.createElement("button");
      el.type = "button";
      el.className = "kit-fp preset-row";
      el.setAttribute("role", "option");
      const name = document.createElement("span");
      name.className = "kit-nm";
      name.textContent = row.name;
      el.appendChild(name);
      const count = document.createElement("span");
      count.className = "kit-fp-note";
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
      empty.className = "kit-gempty";
      empty.textContent = query
        ? `没有匹配“${searchInput.value.trim()}”的语言预设。`
        : "没有可选的语言预设。";
      fragment.appendChild(empty);
    }
    rowsEl.replaceChildren(fragment);
    if (open) position();
  };
}
