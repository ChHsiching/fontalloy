import { store, type LoadedFont } from "../state";
import { loadLocalFontFile } from "../fonts/registry";

export type PickerRole = "en" | "cjk";

export interface PickerOptions {
  role: PickerRole;
  /** Anchor text before any font is loaded. */
  emptyText: string;
}

export interface FontPicker {
  open(): void;
  close(): void;
}

/** CSS-quoted font-family value, safe for names with spaces or quotes. */
export function cssFamily(family: string): string {
  return `"${family.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * A font picker (ADR-0004): an anchor row plus a popup listbox whose node is
 * created ONCE and survives every re-render — only the rows rebuild.
 *
 * The popup is an outer clipping layer (rounded, shadowed) around an inner
 * scroll area; the "load local font file" footer sits outside the scroll
 * area. Positioning clamps to the app frame: below the anchor first, flip
 * above when it does not fit, cap the height (internal scroll) otherwise.
 * Open/close are discrete `allow-discrete` + `@starting-style` transitions.
 */
export function mountPicker(
  root: HTMLElement,
  options: PickerOptions,
): FontPicker {
  root.dataset.role = `picker-${options.role}`;

  const anchor = document.createElement("button");
  anchor.className = "picker-anchor";
  anchor.setAttribute("aria-haspopup", "listbox");
  anchor.setAttribute("aria-expanded", "false");
  anchor.innerHTML = `
    <span class="picker-current"></span>
    <span class="picker-caret" aria-hidden="true">▾</span>
  `;
  root.appendChild(anchor);

  // The popup lives on <body> (the app frame root): fixed positioning is
  // then immune to rail overflow and to any transient transform on sections
  // during their entrance animation (ADR-0004 stacking-context constraint).
  const popup = document.createElement("div");
  popup.className = "picker-popup";
  popup.dataset.pickerPopup = options.role;
  popup.setAttribute("role", "listbox");
  popup.setAttribute("aria-label", "字体列表");
  popup.innerHTML = `
    <div class="popup-clip">
      <div class="popup-scroll">
        <div class="popup-rows"></div>
      </div>
      <div class="popup-footer">
        <div class="picker-error" role="alert" hidden></div>
        <button class="picker-load-local" type="button">加载本地字体文件…</button>
        <input class="picker-file-input" type="file" accept=".ttf,.otf,.woff,.woff2,.ttc" multiple hidden />
      </div>
    </div>
  `;
  document.body.appendChild(popup);

  const rowsEl = popup.querySelector<HTMLElement>(".popup-rows")!;
  const errorEl = popup.querySelector<HTMLElement>(".picker-error")!;
  const fileInput = popup.querySelector<HTMLInputElement>(".picker-file-input")!;
  const loadButton = popup.querySelector<HTMLButtonElement>(".picker-load-local")!;
  const current = anchor.querySelector<HTMLElement>(".picker-current")!;

  let open = false;

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

  /** Clamp to the app frame: below first, flip above, then cap the height. */
  const position = (): void => {
    const margin = 8;
    const gap = 6;
    popup.style.maxHeight = "";
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

  // Close on outside pointerdown and on Escape.
  document.addEventListener("pointerdown", (e) => {
    if (!open) return;
    const target = e.target as Node;
    if (popup.contains(target) || anchor.contains(target)) return;
    setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) setOpen(false);
  });

  loadButton.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const files = [...(fileInput.files ?? [])];
    fileInput.value = "";
    errorEl.hidden = true;
    for (const file of files) {
      try {
        const { font, isNewFamily } = await loadLocalFontFile(file);
        if (isNewFamily && store.get().selected[options.role] === null) {
          store.set({
            selected: { ...store.get().selected, [options.role]: font.cssFamily },
          });
        }
      } catch (err) {
        errorEl.hidden = false;
        errorEl.textContent = `无法加载 ${file.name}：${
          err instanceof Error ? err.message : "不是有效的字体文件"
        }`;
      }
    }
  });

  /** Rows rebuild only — the popup node and its scroll state persist. */
  const rebuildRows = (fonts: LoadedFont[], selectedKey: string | null): void => {
    const seen = new Set<string>();
    const fragment = document.createDocumentFragment();
    for (const font of fonts) {
      if (seen.has(font.cssFamily)) continue;
      seen.add(font.cssFamily);
      const row = document.createElement("div");
      row.className = "picker-row";
      row.setAttribute("role", "option");
      row.dataset.cssFamily = font.cssFamily;
      row.setAttribute("aria-selected", String(font.cssFamily === selectedKey));
      row.classList.toggle("is-selected", font.cssFamily === selectedKey);
      const name = document.createElement("span");
      name.className = "picker-row-name";
      name.textContent = font.family;
      row.appendChild(name);
      // Every row renders its family name in its own font (ADR-0004).
      row.style.fontFamily = `${cssFamily(font.cssFamily)}, sans-serif`;
      row.addEventListener("click", () => {
        store.set({
          selected: { ...store.get().selected, [options.role]: font.cssFamily },
        });
        setOpen(false);
      });
      fragment.appendChild(row);
    }
    if (fragment.childNodes.length === 0) {
      const empty = document.createElement("div");
      empty.className = "picker-empty";
      empty.textContent = "尚未加载字体 —— 请从下方加载本地字体文件。";
      fragment.appendChild(empty);
    }
    rowsEl.replaceChildren(fragment);
  };

  const render = (): void => {
    const { fonts, selected } = store.get();
    const font = fonts.find((f) => f.cssFamily === selected[options.role]);
    current.textContent = font ? font.family : options.emptyText;
    current.style.fontFamily = font
      ? `${cssFamily(font.cssFamily)}, sans-serif`
      : "";
    rebuildRows(fonts, selected[options.role]);
  };
  store.subscribe(render);
  render();

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
  };
}
