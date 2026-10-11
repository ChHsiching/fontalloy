/**
 * The language-preset picker for precedence rules: an app-level popup on
 * the kit's .kit-pop chrome (the workspace's preset picker pattern —
 * gui/src/ui/presetpicker.ts), positioned with the kit's fitPop
 * discipline (below first, flip above, cap, clamped to the viewport: the
 * webapp page fills the window, so the viewport IS the frame).
 *
 * Carried rules (ADR-0004 / the kit's popup contract):
 * - the popup node is created ONCE per instance and appended to
 *   `document.body`; only the rows rebuild (node persistence);
 * - the search field and the provenance note sit OUTSIDE the scroll
 *   area (a sticky footer inside the scroll always bleeds);
 * - open/close run on the .kit-pop class transition; close on outside
 *   pointerdown (still-connected guard) and on Escape;
 * - `destroy()` detaches everything — the rule row that owns this
 *   picker rebuilds on structural edits and must not leak listeners or
 *   duplicate data-picker-popup nodes on <body>.
 */

import { fitPopup } from "../kit/position";

export interface PresetPickOption {
  id: string;
  /** Row title (the preset name). */
  title: string;
  /** Second line (codepoint count + composition, or a note). */
  sub: string;
  /** Featured presets render in the 常用 group, above the rest. */
  featured: boolean;
}

export interface PresetPickerOptions {
  /** Stable key: the anchor's data-role and the popup's data-picker-popup. */
  role: string;
  searchPlaceholder: string;
  /** Shown when `options()` returns nothing. */
  emptyText: string;
  /** Static provenance note below the scroll area. */
  footerNote?: string;
  /** The anchor's current label (re-read on every render). */
  currentLabel: () => string;
  /** Options to show; re-read on every open and every keystroke. */
  options: (query: string) => PresetPickOption[];
  onPick: (id: string) => void;
}

export interface PresetPicker {
  /** The anchor button (dropdown-chrome) — placed by the caller's row. */
  readonly anchor: HTMLButtonElement;
  /** Refresh the anchor's label (the popup rows re-read on open). */
  render(): void;
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** Remove the node and every listener. */
  destroy(): void;
}

export function mountPresetPicker(
  options: PresetPickerOptions,
): PresetPicker {
  const anchor = document.createElement("button");
  anchor.type = "button";
  anchor.className = "kit-csel wb-preset-anchor";
  anchor.dataset.role = options.role;
  anchor.setAttribute("aria-haspopup", "listbox");
  anchor.setAttribute("aria-expanded", "false");

  const popup = document.createElement("div");
  popup.className = "kit-pop wb-pop-list";
  popup.dataset.pickerPopup = options.role;
  popup.setAttribute("role", "listbox");
  popup.setAttribute("aria-label", "语言预设列表");

  const search = document.createElement("input");
  search.type = "search";
  search.className = "kit-q";
  search.placeholder = options.searchPlaceholder;
  search.setAttribute("aria-label", options.searchPlaceholder);
  const scroll = document.createElement("div");
  scroll.className = "wb-pop-scroll";
  popup.append(search, scroll);
  if (options.footerNote) {
    const note = document.createElement("div");
    note.className = "wb-pop-note";
    note.textContent = options.footerNote;
    popup.appendChild(note);
  }
  document.body.appendChild(popup);

  const listeners = new AbortController();
  const { signal } = listeners;
  let open = false;

  const position = (): void => {
    fitPopup(popup, anchor.getBoundingClientRect());
  };

  const rebuildRows = (): void => {
    const items = options.options(search.value.trim().toLowerCase());
    const fragment = document.createDocumentFragment();
    const group = (text: string): void => {
      const label = document.createElement("div");
      label.className = "wb-pop-group";
      label.textContent = text;
      fragment.appendChild(label);
    };
    const append = (item: PresetPickOption): void => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "kit-fp wb-pop-row";
      row.setAttribute("role", "option");
      row.dataset.optionId = item.id;
      row.title = item.title;
      const name = document.createElement("span");
      name.className = "kit-nm";
      name.textContent = item.title;
      row.appendChild(name);
      const sub = document.createElement("span");
      sub.className = "kit-fp-note";
      sub.textContent = item.sub;
      row.appendChild(sub);
      row.addEventListener("click", () => {
        options.onPick(item.id);
        setOpen(false);
      });
      fragment.appendChild(row);
    };
    const featured = items.filter((item) => item.featured);
    const rest = items.filter((item) => !item.featured);
    if (featured.length > 0) {
      group("常用");
      for (const item of featured) append(item);
    }
    if (rest.length > 0) {
      if (featured.length > 0) group("全部");
      for (const item of rest) append(item);
    }
    if (fragment.childNodes.length === 0) {
      const empty = document.createElement("div");
      empty.className = "kit-gempty";
      empty.textContent = options.emptyText;
      fragment.appendChild(empty);
    }
    scroll.replaceChildren(fragment);
  };

  const setOpen = (next: boolean): void => {
    if (open === next) return;
    open = next;
    anchor.setAttribute("aria-expanded", String(next));
    if (next) {
      search.value = "";
      rebuildRows();
      popup.classList.add("open");
      position();
      search.focus();
    } else {
      popup.classList.remove("open");
    }
  };

  anchor.addEventListener(
    "click",
    () => setOpen(!open),
    { signal },
  );
  search.addEventListener("input", rebuildRows, { signal });
  window.addEventListener(
    "resize",
    () => {
      if (open) position();
    },
    { signal },
  );
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!open) return;
      const target = e.target as Node;
      if (popup.contains(target) || anchor.contains(target)) return;
      setOpen(false);
    },
    { signal },
  );
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && open) {
        setOpen(false);
        anchor.focus();
      }
    },
    { signal },
  );

  const render = (): void => {
    anchor.textContent = options.currentLabel();
  };
  render();

  return {
    anchor,
    render,
    open: () => setOpen(true),
    close: () => setOpen(false),
    isOpen: () => open,
    destroy: () => {
      listeners.abort();
      popup.remove();
      anchor.remove();
    },
  };
}
