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
 * Repair f6 (round 2): the fit is re-run whenever the card's own size
 * changes while open, and a clamped card's visible area always ends on
 * a whole worked-table row (never a partial one).
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

  // Repair f6 (round 2): the tall weight card can settle TALLER only
  // after it opened, and fitPopup's one-shot measurement then left the
  // card unclamped — it painted past the frame's bottom edge, and the
  // viewport sliced the last worked-table row mid-glyph (G8 f1-02).
  // position() therefore re-runs when the card's own size changes while
  // open (ResizeObserver below) and once the pop-in animation ends.
  // The whole-row pass needs resting coordinates — the pop-in transform
  // scales getBoundingClientRect — so it skips while one is live.
  const position = (): void => {
    fitPopup(popup, anchor.getBoundingClientRect());
    if (getComputedStyle(popup).transform === "none") fitWholeRows(popup);
  };

  const setOpen = (next: boolean): void => {
    if (open === next) return;
    open = next;
    anchor.setAttribute("aria-expanded", String(next));
    if (next) {
      popup.classList.add("open");
      position();
      // Re-fit on resting coordinates once the 0.2s pop-in ends.
      popup.addEventListener("animationend", position, { once: true });
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
  // Late layout growth (the f6 overshoot): re-fit while the card is
  // open whenever its rendered size changes, so the frame clamp always
  // matches the card's real height. Idempotent — a re-run writes the
  // same maxHeight and does not fire the observer again.
  new ResizeObserver(() => {
    if (open) position();
  }).observe(popup);
  document.addEventListener("pointerdown", (e) => {
    if (!open) return;
    const target = e.target as Node;
    if (!target.isConnected) return;
    if (popup.contains(target) || anchor.contains(target)) return;
    setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) {
      // One layer per press (round 7): this Escape closes the help
      // ONLY. stopImmediatePropagation keeps later-registered handlers
      // (the host surface underneath — e.g. an open picker popup) from
      // also closing; earlier-registered ones have already had their
      // turn and closed their own layer.
      e.stopImmediatePropagation();
      setOpen(false);
    }
  });

  return {
    anchor,
    popup,
    open: () => setOpen(true),
    close: () => setOpen(false),
  };
}

/**
 * Whole-row containment for a clamped (scrolling) help card (repair
 * f6, round 2). When the scrollport's bottom content edge slices a
 * worked-table row mid-height — G8 showed only the top 25-30% of the
 * weight card's last row — shrink the clamp so the edge lands on that
 * row's top border instead: the visible area ends on whole rows (the
 * kit grid's "whole rows, never a partial row" discipline, applied to
 * the help cards) and the hidden rows stay reachable by scroll. No-op
 * when the card fits without scrolling.
 */
function fitWholeRows(popup: HTMLElement): void {
  if (popup.scrollHeight <= popup.clientHeight + 1) return;
  const style = getComputedStyle(popup);
  // Sizing is border-box (tokens.css), so maxHeight covers the bottom
  // padding + border as well as the content it must stop short of.
  const innerBottom =
    (parseFloat(style.borderBottomWidth) || 0) +
    (parseFloat(style.paddingBottom) || 0);
  const edge = popup.getBoundingClientRect().bottom - innerBottom;
  for (const row of popup.querySelectorAll<HTMLElement>(".kit-wtab tr")) {
    const rect = row.getBoundingClientRect();
    if (rect.top < edge - 0.5 && rect.bottom > edge + 0.5) {
      const maxHeight = Math.max(
        rect.top - popup.getBoundingClientRect().top + innerBottom,
        220,
      );
      popup.style.maxHeight = `${maxHeight}px`;
      break;
    }
  }
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

/**
 * A small explanatory paragraph inside the popover. An ARRAY joins its
 * lines with `<br>` (the prototype's multi-line paragraphs) — only the
 * caller's own literal strings ever arrive here, so the innerHTML is
 * as safe as textContent.
 */
export function helpNote(
  text: string | readonly string[],
  className?: string,
): HTMLElement {
  const p = document.createElement("p");
  p.className = className ?? "kit-sub";
  if (typeof text === "string") {
    p.textContent = text;
  } else {
    p.innerHTML = text
      .map((line) => line.replace(/&/g, "&amp;").replace(/</g, "&lt;"))
      .join("<br>");
  }
  return p;
}
