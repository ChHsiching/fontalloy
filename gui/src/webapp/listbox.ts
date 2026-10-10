/**
 * A generic popup listbox (searchable option list) following the
 * ADR-0004 popup contract, shared by the catalog pickers and the preset
 * picker:
 *
 * - the popup node is created ONCE per instance and appended to
 *   `document.body`; only the rows rebuild;
 * - positioning clamps to the viewport: below the anchor first, flip
 *   above when it does not fit, cap the height (internal scroll);
 * - open/close are discrete `allow-discrete` + `@starting-style`
 *   transitions (`[data-open]` in app.css, reused here);
 * - close on outside pointerdown and on Escape.
 *
 * Options are computed at open time (`options()`), so callers can pass
 * fresh, filtered data without re-mounting anything.
 */

export interface ListboxOption {
  id: string;
  /** Main row text. */
  title: string;
  /** Second line (counts, variant…). */
  subtitle?: string;
  /** Right-aligned faint text (version, license…). */
  meta?: string;
}

export interface ListboxOptions {
  /** Accessible label for the popup. */
  label: string;
  /** Options to show; re-read on every open and every keystroke. */
  options: (query: string) => ListboxOption[];
  searchPlaceholder: string;
  /** Shown when `options()` returns nothing. */
  emptyText: string;
  /** Static footer text (e.g. provenance), outside the scroll area. */
  footerNote?: string;
  onPick: (id: string) => void;
}

export interface Listbox {
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** Tear the popup down: remove the node and every listener. */
  destroy(): void;
}

export function mountListbox(
  anchor: HTMLElement,
  options: ListboxOptions,
): Listbox {
  const popup = document.createElement("div");
  popup.className = "picker-popup wb-listbox";
  // Prefer the anchor's data-role when present (unique per instance —
  // several listboxes share a label), else the label.
  popup.dataset.pickerPopup = anchor.dataset.role || options.label;
  popup.setAttribute("role", "listbox");
  popup.setAttribute("aria-label", options.label);
  popup.innerHTML = `
    <div class="popup-clip">
      <div class="wb-listbox-search">
        <input class="wb-search-input" type="search"
               placeholder="${escapeAttr(options.searchPlaceholder)}"
               aria-label="${escapeAttr(options.searchPlaceholder)}" />
      </div>
      <div class="popup-scroll">
        <div class="popup-rows"></div>
      </div>
      ${
        options.footerNote
          ? `<div class="popup-footer"><div class="wb-listbox-note">${escapeHtml(options.footerNote)}</div></div>`
          : ""
      }
    </div>
  `;
  document.body.appendChild(popup);
  // All listeners (anchor, search, window, document) share one abort
  // signal so destroy() really removes them.
  const listeners = new AbortController();
  const { signal } = listeners;

  const rowsEl = popup.querySelector<HTMLElement>(".popup-rows")!;
  const searchEl = popup.querySelector<HTMLInputElement>(".wb-search-input")!;
  let open = false;

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

  const rebuildRows = (): void => {
    const items = options.options(searchEl.value);
    const fragment = document.createDocumentFragment();
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "picker-row wb-listbox-row";
      row.setAttribute("role", "option");
      row.dataset.optionId = item.id;
      const main = document.createElement("div");
      main.className = "wb-listbox-main";
      const title = document.createElement("span");
      title.className = "picker-row-name";
      title.textContent = item.title;
      main.appendChild(title);
      if (item.subtitle) {
        const sub = document.createElement("span");
        sub.className = "wb-listbox-sub";
        sub.textContent = item.subtitle;
        main.appendChild(sub);
      }
      row.appendChild(main);
      if (item.meta) {
        const meta = document.createElement("span");
        meta.className = "wb-listbox-meta";
        meta.textContent = item.meta;
        row.appendChild(meta);
      }
      row.addEventListener("click", () => {
        options.onPick(item.id);
        setOpen(false);
      });
      fragment.appendChild(row);
    }
    if (fragment.childNodes.length === 0) {
      const empty = document.createElement("div");
      empty.className = "picker-empty";
      empty.textContent = options.emptyText;
      fragment.appendChild(empty);
    }
    rowsEl.replaceChildren(fragment);
  };

  const setOpen = (next: boolean): void => {
    if (open === next) return;
    open = next;
    anchor.setAttribute("aria-expanded", String(next));
    if (next) {
      popup.dataset.open = "true";
      searchEl.value = "";
      rebuildRows();
      position();
      searchEl.focus();
    } else {
      delete popup.dataset.open;
    }
  };

  anchor.addEventListener(
    "click",
    () => setOpen(!open),
    { signal },
  );
  searchEl.addEventListener("input", rebuildRows, { signal });
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

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    isOpen: () => open,
    destroy: () => {
      listeners.abort();
      popup.remove();
    },
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}
