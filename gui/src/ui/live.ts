/**
 * The app's live region (the prototype's `#live`): an sr-only
 * `role="status"` node the interaction surfaces announce through — the
 * 文字范围 guard (至少保留一种), the batch apply (批量调整完成), the
 * synthesize demo feedback, the local-font failure notice. One node,
 * created on first use, polite politeness — the prototype's exact
 * pattern, ported as kit language.
 */

let region: HTMLElement | null = null;

/** The singleton live region (mounted on <body> on first use). */
function ensureRegion(): HTMLElement {
  if (region === null) {
    const node = document.createElement("div");
    node.className = "kit-sr";
    node.setAttribute("role", "status");
    node.setAttribute("aria-live", "polite");
    node.dataset.role = "live";
    document.body.appendChild(node);
    region = node;
  }
  return region;
}

/** Announce `text` to assistive tech (and only there). */
export function liveNotice(text: string): void {
  ensureRegion().textContent = text;
}
