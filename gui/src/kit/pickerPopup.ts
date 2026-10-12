/**
 * FontAlloy kit — PickerPopup.
 *
 * The prototype's font selector (fsel), in the SAME dropdown-list form
 * as AppSelect (round 4; the owner's chosen pattern): the popup is an
 * anchor-fused list card — a PERSISTENT CHILD of the picker card,
 * absolutely positioned at its bottom edge (top:100%, left/right:-1px,
 * no top border, bottom corners squared against the open card), never
 * portaled and never re-parented. Open/close is pure class toggling
 * through `display` with allow-discrete + @starting-style, exactly the
 * csel-pk discipline — no bespoke transition choreography, no deferred
 * node removal, no frame math.
 *
 * Carried architecture constraints (the validated popup rules):
 *
 * - the popup is an OUTER CLIPPING LAYER (rounded, shadowed) around an
 *   inner SCROLL area; the search field is a header above the scroll
 *   and the footer action sits below it, OUTSIDE the scroll — a sticky
 *   footer inside the scroll area always bleeds (prototype r27→r29);
 * - NODE PERSISTENCE: the popup skeleton (search + scroll + status +
 *   footer) is built ONCE at mount; re-renders rebuild only the rows,
 *   so the open/close transitions survive every render;
 * - rows self-render: the family name in its own font, the MetaLine,
 *   and a check mark on the selected row;
 * - open-at-the-selection: when the popup opens with the current pick
 *   in the list, the scroll area starts centered on the checked row
 *   (never a page scroll — the rect math touches the scroll area only).
 */

import { icon } from "./icons";
import { mountHelpPopover } from "./helpPopover";
import { metaLine, type FontMeta } from "./metaLine";

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
   * Extra search terms matched alongside name/id (the builder
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
  /**
   * Variant chips (round 8 final form): one chip per CUT — the
   * distinct releases the manifest pins, labeled with official proper
   * nouns (NF / NF-CN / Mono / 屏幕版 …; the default reads 标准). A
   * chip is a span-button (the row itself is the <button>; nested
   * buttons are invalid HTML); clicking it fires onChip instead of
   * onPick. `on` marks the cut the USER explicitly picked (accent);
   * the default cut renders plain. `disabled` marks an unfetched
   * member family — the chip then carries the 未下载 `tag`.
   */
  chips?: PickerChip[];
}

/** One variant chip of a picker row. */
export interface PickerChip {
  /** Stable key: the cut id (`${family}::${variant}`). */
  id: string;
  label: string;
  /** The user explicitly selected this cut (accent). */
  on?: boolean;
  /** The cut's member family is not fetched (未下载 tag, no click). */
  disabled?: boolean;
  /** Inline tag inside a disabled chip (未下载). */
  tag?: string;
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
  /**
   * The picker-level variant help (round 7 redesign): when present, a
   * single ? anchor rides the search header — one place per picker
   * explaining what the rows' variant chips mean, instead of per-row
   * machinery. Mounted once at mount; destroyed with the picker.
   */
  help?: PickerHelpProps;
  onPick(id: string): void;
  /** A variant chip was clicked (round 7); falls back to onPick. */
  onChip?(rowId: string, chipId: string): void;
}

/** The picker-level variant help's content (chrome is the kit's). */
export interface PickerHelpProps {
  /** Popover heading (h5) — e.g. 变体是什么. */
  title: string;
  /** aria-label for the circular ? button. */
  buttonLabel: string;
  /** Build the popover body (static content, built once). */
  build(): HTMLElement;
}

export interface PickerPopup {
  /** The card element (.kit-fsel) — append into the rail. */
  readonly el: HTMLElement;
  /** Re-render with fresh props; the popup node survives when open. */
  render(props: PickerPopupProps): void;
  open(): void;
  close(): void;
  /**
   * Tear the component down (builder extension): close, detach the
   * document listeners, and remove the card (the popup is its child
   * and goes with it).
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

  // Stage-3 extension: document listeners ride one abort signal
  // so destroy() detaches them all.
  const listeners = new AbortController();
  const { signal } = listeners;

  // --- card header (rebuilt on render; always the first child) ---
  let header: HTMLElement | null = null;

  // --- the persistent popup skeleton (built ONCE, right after the
  // header; rows and status lines are the only parts that re-render) ---
  let open = false;
  let query = "";

  const popup = document.createElement("div");
  popup.className = "kit-pk";
  popup.dataset.pickerPopup = initial.role;
  popup.setAttribute("role", "listbox");
  popup.setAttribute("aria-label", "字体列表");

  // Search header — outside the scroll area (a header, not a row). The
  // variant help's ? anchor (when props carry one) rides the same
  // header row, to the field's right — one per picker, never per row.
  const searchRow = document.createElement("div");
  searchRow.className = "kit-qrow";
  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.className = "kit-q";
  searchInput.placeholder = initial.searchPlaceholder ?? "搜索字体";
  searchInput.setAttribute("aria-label", "搜索字体");
  let debounce: ReturnType<typeof setTimeout> | undefined;
  searchInput.addEventListener("input", () => {
    query = searchInput.value.trim().toLowerCase();
    clearTimeout(debounce);
    debounce = setTimeout(() => renderRows(), 120);
  });
  searchRow.appendChild(searchInput);
  const variantHelp = initial.help
    ? mountHelpPopover({
        // Role-scoped: every picker (en + cjk) mounts its own help, and
        // two body-level popups must never share one walker id.
        id: `picker-variants-${initial.role}`,
        title: initial.help.title,
        buttonLabel: initial.help.buttonLabel,
        width: 340,
        build: initial.help.build,
      })
    : null;
  if (variantHelp) searchRow.appendChild(variantHelp.anchor);
  popup.appendChild(searchRow);

  // Inner scroll area — the only scrolling child.
  const scrollArea = document.createElement("div");
  scrollArea.className = "kit-pks";
  popup.appendChild(scrollArea);

  // Status note + error line — siblings below the scroll, above the
  // footer action (page text, never hover-only).
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

  // Footer action — a sibling BELOW the scroll, never scrolling. The
  // button is permanent; render() only retunes its label and handler.
  const footerBtn = document.createElement("button");
  footerBtn.type = "button";
  footerBtn.className = "kit-fpsys";
  footerBtn.innerHTML = `${icon("plus")}<span></span>`;
  const footerLabel = footerBtn.querySelector("span")!;
  let footerClick: (() => void) | null = null;
  footerBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    footerClick?.();
  });
  popup.appendChild(footerBtn);

  let props: PickerPopupProps = initial;

  const close = (): void => {
    if (!open) return;
    open = false;
    openPickers.delete(handle);
    el.classList.remove("open");
    if (header) header.setAttribute("aria-expanded", "false");
  };

  const openPicker = (): void => {
    if (open) return;
    for (const other of [...openPickers]) other.close();
    open = true;
    openPickers.add(handle);
    el.classList.add("open");
    if (header) header.setAttribute("aria-expanded", "true");
    renderRows();
    renderStatus();
    revealSelected();
  };

  /**
   * Open-at-the-selection: when the current pick is in the list, the
   * scroll area starts centered on the checked row (the catalog list is
   * far taller than the popup; the prototype's boot frame opens on its
   * picked row). Rect-relative math against the scroll area only — a
   * scrollIntoView here could also scroll the page under the popup.
   */
  const revealSelected = (): void => {
    if (props.selectedId === null) return;
    const row = scrollArea.querySelector<HTMLElement>(
      `[data-font-id="${CSS.escape(props.selectedId)}"]`,
    );
    if (!row) return;
    const rowRect = row.getBoundingClientRect();
    const areaRect = scrollArea.getBoundingClientRect();
    const delta =
      rowRect.top + rowRect.height / 2 - (areaRect.top + areaRect.height / 2);
    if (delta !== 0) scrollArea.scrollTop += delta;
  };

  const renderRows = (): void => {
    const selectedId = props.selectedId;
    const matches = props.fonts.filter(
      (f) =>
        !query ||
        f.name.toLowerCase().includes(query) ||
        f.id.toLowerCase().includes(query) ||
        (f.keywords?.toLowerCase().includes(query) ?? false),
    );
    // Node persistence, rows edition: rebuild the row list only when
    // what it SHOWS changed (same guard as the header). Store patches
    // that do not touch this popup's rows then cannot churn the nodes
    // under a cursor.
    const signature = JSON.stringify([
      query,
      selectedId,
      matches.map((f) => [
        f.id,
        f.name,
        f.family ?? null,
        f.meta ?? null,
        f.disabled ?? false,
        f.note ?? null,
        f.chips ?? null,
      ]),
    ]);
    if (scrollArea.dataset.signature === signature) return;
    scrollArea.dataset.signature = signature;
    const fragment = document.createDocumentFragment();
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
      if (font.chips && font.chips.length > 0) {
        const chips = document.createElement("span");
        chips.className = "kit-fp-chips";
        for (const chip of font.chips) {
          const el = document.createElement("span");
          el.className =
            "kit-vchip" +
            (chip.on ? " on" : "") +
            (chip.disabled ? " off" : "");
          el.dataset.chip = chip.id;
          el.setAttribute("role", "button");
          el.textContent = chip.label;
          // Round 8: an unfetched cut carries the 未下载 tag inline —
          // the axis stays visible, the reason with it.
          if (chip.disabled && chip.tag) {
            const tag = document.createElement("span");
            tag.className = "kit-vchip-tag";
            tag.textContent = chip.tag;
            el.appendChild(tag);
            el.title = chip.tag;
          }
          if (!chip.disabled) {
            el.tabIndex = -1; // pointer-driven (the row is the key target)
            el.addEventListener("click", (e) => {
              e.stopPropagation();
              if (font.disabled) return;
              props.onChip?.(font.id, chip.id);
            });
          } else {
            el.setAttribute("aria-disabled", "true");
          }
          chips.appendChild(el);
        }
        row.appendChild(chips);
      }
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

  /** Sync the note/error status lines and the footer action. */
  const renderStatus = (): void => {
    noteEl.hidden = !props.note;
    noteEl.textContent = props.note ?? "";
    errorEl.hidden = !props.error;
    errorEl.textContent = props.error ?? "";
    if (props.footer) {
      footerLabel.textContent = props.footer.label;
      footerClick = props.footer.onClick;
      footerBtn.style.display = "";
    } else {
      footerClick = null;
      footerBtn.style.display = "none";
    }
  };

  const renderHeader = (): void => {
    const selected = props.fonts.find((f) => f.id === props.selectedId);
    const fallback = props.emptyLabel ?? props.fonts[0]?.name ?? "—";
    // Node persistence: rebuild the header only when what it SHOWS
    // changed. The workspace patches the store for every catalog family
    // (download status, lazy registration) — rebuilding the card header
    // each time would churn the node under a user's cursor (and a
    // test's), for identical pixels.
    const signature = JSON.stringify([
      selected?.id ?? null,
      selected?.name ?? fallback,
      selected?.family ?? null,
      selected?.meta ?? null,
      open,
    ]);
    if (header && header.dataset.signature === signature) {
      return;
    }
    const next = document.createElement("div");
    next.className = "kit-hd";
    next.dataset.signature = signature;
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
    else el.insertBefore(next, popup);
    header = next;
  };

  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!open) return;
      const target = e.target as Node;
      if (!target.isConnected) return;
      // The popup lives INSIDE the card now — one contains() covers both.
      if (el.contains(target)) return;
      close();
    },
    { signal },
  );
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && open) {
        // One layer per press: an open help popover inside this picker
        // consumes the Escape first (its own handler closes it); the
        // picker itself stays for the next press.
        if (variantHelp?.popup.classList.contains("open")) return;
        close();
      }
    },
    { signal },
  );

  const handle: PickerPopupHandleInternal = { close };

  // Skeleton order: header first, then the persistent popup (the same
  // child order the prototype's fsel keeps). The popup STAYS mounted —
  // closed is `display:none` through the card's class, exactly like
  // AppSelect's list.
  el.append(popup);
  renderHeader();
  renderRows();
  renderStatus();

  return {
    el,
    render(next) {
      props = next;
      renderHeader();
      renderStatus();
      if (open) renderRows();
    },
    open: openPicker,
    close,
    destroy() {
      open = false;
      openPickers.delete(handle);
      listeners.abort();
      variantHelp?.popup.remove();
      el.remove();
    },
  };
}
