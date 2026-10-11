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
