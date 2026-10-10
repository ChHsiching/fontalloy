/**
 * A ?-button popover (issue #19, ADR-0004): static, click-opened
 * explanatory content — the worked-example tables of the synthesis
 * settings. The mechanics are the carried popup constraints, verbatim:
 *
 * - the popup node is created ONCE and appended to <body> (never inside
 *   the rail), so it survives every store-driven re-render — only its
 *   visibility flips;
 * - open/close are discrete `allow-discrete` + `@starting-style`
 *   transitions (see .help-popup in app.css);
 * - positioning clamps to the app frame: below the anchor first, flip
 *   above when it does not fit, cap the height with internal scrolling;
 * - outside pointerdown and Escape close it; nothing is hover-only.
 */

export interface HelpTopic {
  /** Stable id: the popup node's `data-help-popup` key. */
  id: string;
  title: string;
  /** The aria-label of the ? button. */
  buttonLabel: string;
  /**
   * Build the popup content (called once — the content is static).
   * Returns the node placed inside the scrollable area.
   */
  build(): HTMLElement;
}

export interface HelpButton {
  open(): void;
  close(): void;
  readonly popup: HTMLElement;
  readonly anchor: HTMLButtonElement;
}

export function mountHelpPopover(topic: HelpTopic): HelpButton {
  const anchor = document.createElement("button");
  anchor.type = "button";
  anchor.className = "setting-help";
  anchor.dataset.role = `help-${topic.id}`;
  anchor.setAttribute("aria-label", topic.buttonLabel);
  anchor.setAttribute("aria-expanded", "false");
  anchor.textContent = "?";

  // The popup lives on <body> (the app frame root): fixed positioning
  // is immune to rail overflow and entrance-animation stacking contexts.
  const popup = document.createElement("div");
  popup.className = "help-popup";
  popup.dataset.helpPopup = topic.id;
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-label", topic.title);
  const clip = document.createElement("div");
  clip.className = "help-clip";
  const heading = document.createElement("h5");
  heading.textContent = topic.title;
  clip.appendChild(heading);
  clip.appendChild(topic.build());
  popup.appendChild(clip);
  document.body.appendChild(popup);

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

  /** Clamp to the app frame: below first, flip above, then cap. */
  const position = (): void => {
    const margin = 8;
    const gap = 6;
    popup.style.maxHeight = "";
    const anchorRect = anchor.getBoundingClientRect();
    const pw = popup.offsetWidth;
    const ph = popup.offsetHeight;
    const frameW = window.innerWidth;
    const frameH = window.innerHeight;

    // Prefer opening to the anchor's right; clamp into the frame.
    let left = anchorRect.right + gap;
    if (left + pw > frameW - margin) left = anchorRect.left - pw - gap;
    if (left + pw > frameW - margin) left = frameW - pw - margin;
    if (left < margin) left = margin;

    // Below first, flip above, cap the height with internal scroll.
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

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    popup,
    anchor,
  };
}

/** A worked-example table (option -> outcome), the popover's core. */
export function workedTable(
  headers: string[],
  rows: string[][],
): HTMLElement {
  const table = document.createElement("table");
  table.className = "worked-table";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const header of headers) {
    const th = document.createElement("th");
    th.textContent = header;
    headRow.appendChild(th);
  }
  head.appendChild(headRow);
  table.appendChild(head);
  const body = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const cell of row) {
      const td = document.createElement("td");
      td.textContent = cell;
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  table.appendChild(body);
  return table;
}

/** A small explanatory paragraph inside a popover. */
export function helpNote(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "help-note";
  p.textContent = text;
  return p;
}
