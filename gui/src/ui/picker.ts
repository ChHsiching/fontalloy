import { store, type CatalogFamilyEntry, type CatalogState, type LoadedFont } from "../state";
import { registerFontBytes } from "../fonts/registry";
import { getDefaultManager } from "../catalog/manager";
import { canPickWithDialog, pickLocalFonts } from "../platform/localfonts";

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

/** Inline status tag for a catalog row that cannot be picked (yet). */
function catalogTag(family: CatalogFamilyEntry): string | null {
  if (family.status === "failed") return "未下载 · 下次启动自动重试";
  if (family.status === "downloading") return "下载中…";
  if (family.status === "pending") return "等待下载";
  return null;
}

/** Catalog status line for the popup footer (visible text, never hover). */
function catalogNote(catalog: CatalogState): string | null {
  if (catalog.status === "unavailable") {
    return "目录不可用（离线）—— 本地字体不受影响。";
  }
  if (catalog.status === "settled-partial") {
    const missing = catalog.families.filter((f) => f.status !== "verified").length;
    return `目录不完整：${missing} 个家族未下载，下次启动时自动重试。`;
  }
  return null;
}

/**
 * A font picker (ADR-0004): an anchor row plus a popup listbox whose node is
 * created ONCE and survives every re-render — only the rows rebuild.
 *
 * The popup is an outer clipping layer (rounded, shadowed) around an inner
 * scroll area; a search box sits above the scroll area, and the "load local
 * font file" footer sits below it, outside the scroll. Rows list catalog
 * families (metadata-driven, self-rendered once their face is registered)
 * plus locally loaded fonts. Positioning clamps to the app frame: below the
 * anchor first, flip above when it does not fit, cap the height (internal
 * scroll) otherwise. Open/close are discrete `allow-discrete` +
 * `@starting-style` transitions.
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
      <div class="popup-search">
        <input class="picker-search" type="search" placeholder="搜索字体…" aria-label="搜索字体" />
      </div>
      <div class="popup-scroll">
        <div class="popup-rows"></div>
      </div>
      <div class="popup-footer">
        <div class="picker-catalog-note" hidden></div>
        <div class="picker-error" role="alert" hidden></div>
        <button class="picker-load-local" type="button">加载本地字体文件…</button>
        <input class="picker-file-input" type="file" accept=".ttf,.otf,.woff,.woff2,.ttc" multiple hidden />
      </div>
    </div>
  `;
  document.body.appendChild(popup);

  const rowsEl = popup.querySelector<HTMLElement>(".popup-rows")!;
  const errorEl = popup.querySelector<HTMLElement>(".picker-error")!;
  const noteEl = popup.querySelector<HTMLElement>(".picker-catalog-note")!;
  const searchInput = popup.querySelector<HTMLInputElement>(".picker-search")!;
  const fileInput = popup.querySelector<HTMLInputElement>(".picker-file-input")!;
  const loadButton = popup.querySelector<HTMLButtonElement>(".picker-load-local")!;
  const current = anchor.querySelector<HTMLElement>(".picker-current")!;

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

  searchInput.addEventListener("input", () => {
    query = searchInput.value.trim().toLowerCase();
    renderRows();
  });

  /** Register picked local fonts, selecting the first new family. */
  const registerPicked = async (
    entries: Array<{ buffer: ArrayBuffer; fileName: string; path?: string }>,
  ): Promise<void> => {
    errorEl.hidden = true;
    for (const entry of entries) {
      try {
        const { font, isNewFamily } = await registerFontBytes(entry.buffer, {
          fileName: entry.fileName,
          origin: "local",
          path: entry.path,
        });
        if (isNewFamily && store.get().selected[options.role] === null) {
          store.set({
            selected: { ...store.get().selected, [options.role]: font.cssFamily },
          });
        }
      } catch (err) {
        errorEl.hidden = false;
        errorEl.textContent = `无法加载 ${entry.fileName}：${
          err instanceof Error ? err.message : "不是有效的字体文件"
        }`;
      }
    }
  };

  loadButton.addEventListener("click", async () => {
    // Under Tauri the native dialog: real absolute paths for recipes.
    if (canPickWithDialog()) {
      const picked = await pickLocalFonts();
      if (picked !== null && picked.length > 0) {
        await registerPicked(picked);
      }
      return;
    }
    fileInput.click();
  });
  fileInput.addEventListener("change", async () => {
    const files = [...(fileInput.files ?? [])];
    fileInput.value = "";
    await registerPicked(
      await Promise.all(
        files.map(async (file) => ({
          buffer: await file.arrayBuffer(),
          fileName: file.name,
        })),
      ),
    );
  });

  /**
   * Select a catalog family for preview: read the primary face from local
   * storage (it was sha256-verified at download time), register it through
   * the same FontFace(arrayBuffer) path as local files, and load it so the
   * anchor renders in it immediately.
   */
  const selectCatalogFamily = async (family: CatalogFamilyEntry): Promise<void> => {
    const manager = getDefaultManager();
    const release = manager?.getRelease();
    const meta = release?.families.find((f) => f.family === family.family);
    if (!manager || !meta) return;
    const cssKey = await manager.ensureRegistered(meta);
    if (!cssKey) {
      errorEl.hidden = false;
      errorEl.textContent = `无法载入目录字体 ${family.family}：存储的字体文件无法解析。`;
      return;
    }
    // Deterministic load for immediate rendering (lazy faces load on use).
    await document.fonts.load(`16px ${cssFamily(cssKey)}`);
    store.set({
      selected: { ...store.get().selected, [options.role]: cssKey },
    });
    setOpen(false);
  };

  /** Rows rebuild only — the popup node and its scroll state persist. */
  const renderRows = (): void => {
    const { fonts, selected, catalog } = store.get();
    const selectedKey = selected[options.role];
    const fragment = document.createDocumentFragment();

    const appendGroupLabel = (text: string): void => {
      const label = document.createElement("div");
      label.className = "picker-group-label";
      label.textContent = text;
      fragment.appendChild(label);
    };

    // Catalog families: metadata-driven rows; the name text is the metadata
    // family and the row renders in its own font once the face registered.
    const catalogRows = catalog.families.filter((family) =>
      family.family.toLowerCase().includes(query),
    );
    if (catalogRows.length > 0) {
      appendGroupLabel("目录字体");
      for (const family of catalogRows) {
        const row = document.createElement("div");
        row.className = "picker-row catalog-row";
        row.setAttribute("role", "option");
        row.dataset.family = family.family;
        row.dataset.catalogStatus = family.status;
        const cssKey = catalog.registered[family.family] ?? null;
        row.setAttribute("aria-selected", String(cssKey !== null && cssKey === selectedKey));
        row.classList.toggle("is-selected", cssKey !== null && cssKey === selectedKey);
        const name = document.createElement("span");
        name.className = "picker-row-name";
        name.textContent = family.family;
        row.appendChild(name);
        if (cssKey) {
          // Every row renders its family name in its own font (ADR-0004).
          row.style.fontFamily = `${cssFamily(cssKey)}, sans-serif`;
        }
        const tag = catalogTag(family);
        if (tag) {
          row.classList.add("is-unavailable");
          row.setAttribute("aria-disabled", "true");
          const tagEl = document.createElement("span");
          tagEl.className = "picker-row-tag";
          tagEl.textContent = tag;
          row.appendChild(tagEl);
        }
        row.addEventListener("click", () => {
          if (family.status !== "verified") return; // not downloadable (yet)
          void selectCatalogFamily(family);
        });
        fragment.appendChild(row);
      }
    }

    // Locally loaded fonts.
    const seen = new Set<string>();
    const localRows: LoadedFont[] = [];
    for (const font of fonts) {
      if (seen.has(font.cssFamily)) continue;
      seen.add(font.cssFamily);
      if (
        !font.family.toLowerCase().includes(query) &&
        !font.cssFamily.toLowerCase().includes(query)
      ) {
        continue;
      }
      localRows.push(font);
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
    if (localRows.length > 0) appendGroupLabel("本地字体");

    if (fragment.childNodes.length === 0) {
      const empty = document.createElement("div");
      empty.className = "picker-empty";
      empty.textContent = query
        ? `没有匹配“${searchInput.value.trim()}”的字体。`
        : "尚未加载字体 —— 请从下方加载本地字体文件。";
      fragment.appendChild(empty);
    }
    rowsEl.replaceChildren(fragment);
  };

  const render = (): void => {
    const { fonts, selected, catalog } = store.get();
    const key = selected[options.role];
    // The anchor shows the DISPLAY family: the metadata family for catalog
    // selections (registered fonts carry it), the parsed family for local
    // files. One lookup suffices — both kinds live in store.fonts.
    const selectedFont = fonts.find((f) => f.cssFamily === key);
    current.textContent = selectedFont ? selectedFont.family : options.emptyText;
    current.style.fontFamily = key ? `${cssFamily(key)}, sans-serif` : "";
    const note = catalogNote(catalog);
    noteEl.hidden = note === null;
    noteEl.textContent = note;
    renderRows();
  };
  store.subscribe(render);
  render();

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
  };
}
