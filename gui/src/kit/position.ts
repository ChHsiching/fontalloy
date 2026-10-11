/**
 * FontAlloy kit — fixed-popup positioning.
 *
 * `fitPopup` carries the prototype's fitPop verbatim (r31 lesson):
 * popovers clamp to the APP FRAME, not the viewport — otherwise a tall
 * popover paints past the rounded app window onto the page background.
 * Preference order: below the anchor → flip above → cap the height and
 * scroll internally; never cross the frame's edges.
 */

/**
 * The clamping frame: the element carrying data-kit-frame (the app
 * window), falling back to the viewport (Tauri / fullscreen builds,
 * where the window IS the frame).
 */
export function frameRect(): DOMRect {
  const frame = document.querySelector<HTMLElement>("[data-kit-frame]");
  if (frame) return frame.getBoundingClientRect();
  return new DOMRect(0, 0, window.innerWidth, window.innerHeight);
}

/**
 * Place `popup` (position:fixed) against `anchorRect`, clamped inside
 * the app frame. Mutates style.top / style.left / style.maxHeight.
 */
export function fitPopup(
  popup: HTMLElement,
  anchorRect: DOMRect,
  gap = 8,
): void {
  const frame = frameRect();
  popup.style.maxHeight = "";
  let h = popup.offsetHeight;
  const w = popup.offsetWidth;
  const below = frame.bottom - gap - (anchorRect.bottom + gap);
  const above = anchorRect.top - gap - (frame.top + gap);
  if (h > below && h > above) {
    popup.style.maxHeight = `${Math.max(below, above, 220)}px`;
    h = popup.offsetHeight;
  }
  let top = anchorRect.bottom + gap;
  if (h > below && h <= above) {
    top = anchorRect.top - gap - h;
  } else if (h > below && h > above) {
    top = below >= above ? frame.bottom - gap - h : frame.top + gap;
  }
  popup.style.top = `${Math.max(frame.top + gap, Math.min(top, frame.bottom - gap - h))}px`;
  popup.style.left = `${Math.max(frame.left + gap, Math.min(anchorRect.left - 6, frame.right - gap - w))}px`;
}

/**
 * Variant for popups that must ATTACH to their anchor card (the font
 * picker): aligned to the card's box with a 1px overlap so borders
 * merge, then capped so the popup never crosses the frame's bottom.
 */
export function attachPopupBelow(
  popup: HTMLElement,
  anchorRect: DOMRect,
  minVisible = 220,
): void {
  const frame = frameRect();
  const gap = 8;
  popup.style.maxHeight = "";
  const w = anchorRect.width + 2;
  popup.style.left = `${anchorRect.left - 1}px`;
  popup.style.width = `${w}px`;
  let h = popup.offsetHeight;
  const below = frame.bottom - gap - (anchorRect.bottom - 1);
  if (h > below) {
    const cap = Math.max(below, minVisible);
    popup.style.maxHeight = `${cap}px`;
    h = popup.offsetHeight;
    // If even the capped popup would cross the frame, lift it so the
    // bottom edge sits inside (top is then above the anchor — the
    // picker never scrolls off-window).
    if (anchorRect.bottom - 1 + h > frame.bottom - gap) {
      popup.style.top = `${Math.max(frame.top + gap, frame.bottom - gap - h)}px`;
      return;
    }
  }
  popup.style.top = `${anchorRect.bottom - 1}px`;
}
