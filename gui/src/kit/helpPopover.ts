/**
 * FontAlloy kit — HelpPopover.
 *
 * The circular ?-button plus its explanatory popover. The button is a
 * circle (radius 50%) carrying the drawn help glyph; the popover chrome
 * is the prototype's .pop verbatim: fixed, 12px radius, hairline-strong
 * border, deep shadow, pop-in scale, visibility transition. Positioning
 * uses the carried fitPop discipline (below → flip above → cap) against
 * the app frame. The worked-example table inside is its own component
 * (workedTable) with the prototype's .wtab chrome carried verbatim.
 */

import { icon } from "./icons";
import { fitPopup } from "./position";

export interface HelpPopoverProps {
  /** Stable id (the popup node's data-help key). */
  id: string;
  /** Popover heading (h5). */
  title: string;
  /** aria-label for the circular ? button. */
  buttonLabel: string;
  /** Popover width in px — 380 for the weight topic, 340 for the others. */
  width?: number;
  /** Build the popover body (static content, built once). */
  build(): HTMLElement;
}

export interface HelpPopover {
  readonly anchor: HTMLButtonElement;
  readonly popup: HTMLElement;
  open(): void;
  close(): void;
}

export function mountHelpPopover(props: HelpPopoverProps): HelpPopover {
  const anchor = document.createElement("button");
  anchor.type = "button";
  anchor.className = "kit-qh";
  anchor.dataset.role = `help-${props.id}`;
  anchor.setAttribute("aria-label", props.buttonLabel);
  anchor.setAttribute("aria-expanded", "false");
  anchor.innerHTML = icon("help");

  // The popup lives on <body>: fixed positioning immune to rail
  // overflow and entrance-animation stacking contexts.
  const popup = document.createElement("div");
  popup.className = "kit-pop";
  popup.dataset.helpPopup = props.id;
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-label", props.title);
  if (props.width) popup.style.width = `${props.width}px`;
  const heading = document.createElement("h5");
  heading.textContent = props.title;
  popup.append(heading, props.build());
  document.body.appendChild(popup);

  let open = false;

  const position = (): void => {
    fitPopup(popup, anchor.getBoundingClientRect());
  };

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

  anchor.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(!open);
    // The prototype blurs so the button does not keep focus ring chrome.
    if (!open) anchor.blur();
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

  return {
    anchor,
    popup,
    open: () => setOpen(true),
    close: () => setOpen(false),
  };
}

/**
 * A worked-example table — the popover's core. Chrome carried verbatim
 * from the prototype's .wtab: collapsed hairline borders, filled header
 * row, 3px/7px padding, 11px type, nowrap cells.
 */
export function workedTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): HTMLElement {
  const table = document.createElement("table");
  table.className = "kit-wtab";
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

/** A small explanatory paragraph inside the popover. */
export function helpNote(text: string, className?: string): HTMLElement {
  const p = document.createElement("p");
  p.className = className ?? "kit-sub";
  p.textContent = text;
  return p;
}
