/**
 * FontAlloy kit — PickerPopup.
 *
 * The prototype's font selector (fsel), rebuilt typed and prop-driven:
 * a bordered card whose header shows the current font in its own
 * typeface plus the no-pills MetaLine and a rotating chevron; opening
 * squares the card's bottom corners and attaches a popup listbox that
 * renders as one seamless extension of the card.
 *
 * Carried architecture constraints (the validated popup rules):
 *
 * - the popup is an OUTER CLIPPING LAYER (rounded, shadowed) around an
 *   inner SCROLL area; the search field is a header above the scroll
 *   and the footer action sits below it, OUTSIDE the scroll — a sticky
 *   footer inside the scroll area always bleeds (prototype r27→r29);
 * - the popup node is portaled to <body> and positioned fixed against
 *   the card's box, immune to rail overflow and entrance-animation
 *   stacking contexts;
 * - NODE PERSISTENCE: the popup skeleton is built once per open;
 *   re-renders rebuild only the rows, so the open/close transitions
 *   (allow-discrete + @starting-style) survive; after close the node's
 *   removal waits ~240ms so the exit transition plays;
 * - positioning clamps to the app frame (never past the window edge),
 *   capping the height with internal scroll;
 * - rows self-render: the family name in its own font, the MetaLine,
 *   and a check mark on the selected row.
 */

import { icon } from "./icons";
import { metaLine, type FontMeta } from "./metaLine";
import { attachPopupBelow } from "./position";

/** CSS font-family value, quoted safely for names with spaces/quotes. */
export function cssFamily(family: string): string {
  return `"${family.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** One selectable font. */
export interface PickerFont {
  id: string;
  /** Display name (rendered in `family` when given). */
  name: string;
  /** CSS family for self-rendering the name; omit for UI font. */
  family?: string;
  meta?: FontMeta;
  /**
   * Extra search terms matched alongside name/id (Stage-3 webapp
   * extension): catalog rows display "Family · Variant" but users type
   * "Family Variant" — the separator would otherwise hide the row.
   */
  keywords?: string;
  /**
   * Not pickable right now (a catalog family still downloading): the
   * row renders `note` as its status tag and never fires onPick.
   */
  disabled?: boolean;
  /** Inline status tag for a disabled row (e.g. 下载中…). */
  note?: string;
}

export interface PickerPopupProps {
  /** Stable key: the card's data-role and the popup's data-picker. */
  role: string;
  /** Fonts to list (call render() again when the list changes). */
  fonts: readonly PickerFont[];
  /** Currently selected font id. */
  selectedId: string | null;
  /**
   * Header label while nothing is selected. Without it the header falls
   * back to the first font's name (the prototype's preselected demo);
   * consumers without a preselection pass their empty-state text.
   */
  emptyLabel?: string;
  /** Search field placeholder (搜索字体). */
  searchPlaceholder?: string;
  /** Empty-list note when no font matches. */
  emptyText?: string;
  /**
   * Catalog status note rendered above the footer (visible page text,
   * never hover-only) — e.g. an offline or partial-download notice.
   */
  note?: string | null;
  /** Inline error line above the footer (a failed local-file load). */
  error?: string | null;
  /** Footer action (加载本地字体文件) — outside the scroll area. */
  footer?: { label: string; onClick(): void };
  onPick(id: string): void;
}

export interface PickerPopup {
  /** The card element (.kit-fsel) — append into the rail. */
  readonly el: HTMLElement;
  /** Re-render with fresh props; the popup node survives when open. */
  render(props: PickerPopupProps): void;
  open(): void;
  close(): void;
  /**
   * Tear the component down (Stage-3 webapp extension): close without
   * waiting for the exit transition, detach the document/window
   * listeners, and remove the card plus any popup node still on
   * <body>. Call before rebuilding a region that owns the picker — a
   * popup mid-close would otherwise linger under the same
   * data-picker-popup key.
   */
  destroy(): void;
}

/** Open pickers — opening one closes the others. */
const openPickers = new Set<PickerPopupHandleInternal>();

interface PickerPopupHandleInternal {
  close(): void;
}

export function mountPickerPopup(
  host: HTMLElement,
  initial: PickerPopupProps,
): PickerPopup {
  const el = document.createElement("div");
  el.className = "kit-fsel";
  el.dataset.role = `picker-${initial.role}`;
  host.appendChild(el);

  // Stage-3 extension: document/window listeners ride one abort signal
  // so destroy() detaches them all.
  const listeners = new AbortController();
  const { signal } = listeners;

  // --- card header (rebuilt on render; never contains the popup) ---
  let header: HTMLElement | null = null;

  // --- popup state ---
  let popup: HTMLElement | null = null;
  let scrollArea: HTMLElement | null = null;
  let searchInput: HTMLInputElement | null = null;
  let open = false;
  let query = "";
  let removeTimer: ReturnType<typeof setTimeout> | undefined;

  let props: PickerPopupProps = initial;

  /** Deferred removal so the exit transition finishes (node persistence). */
  const armRemoval = (): void => {
    clearTimeout(removeTimer);
    removeTimer = setTimeout(() => {
      if (!open && popup && !popup.classList.contains("open")) {
        popup.remove();
        popup = null;
        scrollArea = null;
        searchInput = null;
      }
    }, 240);
  };

  const position = (): void => {
    if (!popup) return;
    attachPopupBelow(popup, el.getBoundingClientRect());
  };

  const close = (): void => {
    if (!open) return;
    open = false;
    openPickers.delete(handle);
    el.classList.remove("open");
    if (header) header.setAttribute("aria-expanded", "false");
    if (popup) {
      popup.classList.remove("open");
      armRemoval();
    }
  };

  const buildPopup = (): void => {
    popup = document.createElement("div");
    popup.className = "kit-pk";
    popup.dataset.pickerPopup = props.role;
    popup.setAttribute("role", "listbox");
    popup.setAttribute("aria-label", "字体列表");

    // Search header — outside the scroll area (a header, not a row).
    searchInput = document.createElement("input");
    searchInput.type = "search";
    searchInput.className = "kit-q";
    searchInput.placeholder = props.searchPlaceholder ?? "搜索字体";
    searchInput.setAttribute("aria-label", "搜索字体");
    searchInput.value = query;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    searchInput.addEventListener("input", () => {
      query = searchInput!.value.trim().toLowerCase();
      clearTimeout(debounce);
      debounce = setTimeout(() => renderRows(), 120);
    });
    popup.appendChild(searchInput);

    // Inner scroll area — the only scrolling child.
    scrollArea = document.createElement("div");
    scrollArea.className = "kit-pks";
    popup.appendChild(scrollArea);

    // Status note + error line — siblings below the scroll, above the
    // footer action (page text, never hover-only). Built once per open;
    // renderStatus keeps their text in sync with the props.
    const noteEl = document.createElement("div");
    noteEl.className = "kit-pkn";
    noteEl.dataset.pickerNote = "";
    noteEl.hidden = true;
    popup.appendChild(noteEl);
    const errorEl = document.createElement("div");
    errorEl.className = "kit-pke";
    errorEl.setAttribute("role", "alert");
    errorEl.dataset.pickerError = "";
    errorEl.hidden = true;
    popup.appendChild(errorEl);

    // Footer action — a sibling BELOW the scroll, never scrolling.
    if (props.footer) {
      const footer = document.createElement("button");
      footer.type = "button";
      footer.className = "kit-fpsys";
      footer.innerHTML = `${icon("plus")}<span></span>`;
      footer.querySelector("span")!.textContent = props.footer.label;
      footer.addEventListener("click", (e) => {
        e.stopPropagation();
        props.footer!.onClick();
      });
      popup.appendChild(footer);
    }

    document.body.appendChild(popup);
  };

  /** Sync the note/error status lines with the current props. */
  const renderStatus = (): void => {
    if (!popup) return;
    const noteEl = popup.querySelector<HTMLElement>("[data-picker-note]");
    const errorEl = popup.querySelector<HTMLElement>("[data-picker-error]");
    if (noteEl) {
      noteEl.hidden = !props.note;
      noteEl.textContent = props.note ?? "";
    }
    if (errorEl) {
      errorEl.hidden = !props.error;
      errorEl.textContent = props.error ?? "";
    }
  };

  const openPicker = (): void => {
    if (open) return;
    for (const other of [...openPickers]) other.close();
    open = true;
    openPickers.add(handle);
    // Reusing a still-animating-out node? It was kept alive precisely
    // for this case — cancel its removal and reuse it.
    clearTimeout(removeTimer);
    if (!popup) buildPopup();
    el.classList.add("open");
    if (header) header.setAttribute("aria-expanded", "true");
    renderRows();
    renderStatus();
    popup!.classList.add("open");
    position();
  };

  const renderRows = (): void => {
    if (!scrollArea) return;
    const selectedId = props.selectedId;
    const fragment = document.createDocumentFragment();
    const matches = props.fonts.filter(
      (f) =>
        !query ||
        f.name.toLowerCase().includes(query) ||
        f.id.toLowerCase().includes(query) ||
        (f.keywords?.toLowerCase().includes(query) ?? false),
    );
    for (const font of matches) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "kit-fp" + (font.disabled ? " off" : "");
      row.dataset.fontId = font.id;
      row.setAttribute("role", "option");
      row.setAttribute("aria-pressed", String(font.id === selectedId));
      if (font.disabled) row.setAttribute("aria-disabled", "true");
      row.title = font.name;
      const name = document.createElement("span");
      name.className = "kit-nm";
      name.textContent = font.name;
      // Self-rendering: the name in its own font (fallback to UI font).
      if (font.family) {
        name.style.fontFamily = `${cssFamily(font.family)},sans-serif`;
      }
      row.appendChild(name);
      if (font.meta) row.appendChild(metaLine(font.meta));
      if (font.note) {
        const tag = document.createElement("span");
        tag.className = "kit-fp-note";
        tag.textContent = font.note;
        row.appendChild(tag);
      }
      if (font.id === selectedId) {
        const chk = document.createElement("span");
        chk.className = "kit-chk";
        chk.innerHTML = icon("check");
        row.appendChild(chk);
      }
      row.addEventListener("click", () => {
        if (font.disabled) return;
        props.onPick(font.id);
        close();
      });
      fragment.appendChild(row);
    }
    if (matches.length === 0) {
      const empty = document.createElement("div");
      empty.className = "kit-gempty";
      empty.textContent =
        query && searchInput ? `没有匹配“${searchInput.value.trim()}”的字体` : (props.emptyText ?? "暂无字体");
      fragment.appendChild(empty);
    }
    scrollArea.replaceChildren(fragment);
  };

  const renderHeader = (): void => {
    const selected = props.fonts.find((f) => f.id === props.selectedId);
    const fallback = props.emptyLabel ?? props.fonts[0]?.name ?? "—";
    const next = document.createElement("div");
    next.className = "kit-hd";
    next.setAttribute("role", "button");
    next.tabIndex = 0;
    next.setAttribute("aria-expanded", String(open));
    const hdc = document.createElement("span");
    hdc.className = "kit-hdc";
    const name = document.createElement("b");
    name.textContent = selected ? selected.name : fallback;
    if (selected?.family) {
      name.style.fontFamily = `${cssFamily(selected.family)},sans-serif`;
    }
    hdc.appendChild(name);
    if (selected?.meta) hdc.appendChild(metaLine(selected.meta));
    next.appendChild(hdc);
    next.insertAdjacentHTML("beforeend", icon("chevron"));
    next.addEventListener("click", () => {
      if (open) close();
      else openPicker();
    });
    next.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (open) close();
        else openPicker();
      }
    });
    if (header) header.replaceWith(next);
    else el.appendChild(next);
    header = next;
  };

  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!open) return;
      const target = e.target as Node;
      if (!target.isConnected) return;
      if (el.contains(target) || popup?.contains(target)) return;
      close();
    },
    { signal },
  );
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && open) close();
    },
    { signal },
  );
  window.addEventListener(
    "resize",
    () => {
      if (open) position();
    },
    { signal },
  );

  const handle: PickerPopupHandleInternal = { close };

  renderHeader();

  return {
    el,
    render(next) {
      props = next;
      renderHeader();
      if (open) {
        renderRows();
        renderStatus();
      }
    },
    open: openPicker,
    close,
    destroy() {
      open = false;
      openPickers.delete(handle);
      clearTimeout(removeTimer);
      listeners.abort();
      el.remove();
      popup?.remove();
      popup = null;
    },
  };
}
