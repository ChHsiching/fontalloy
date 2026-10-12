/**
 * FontAlloy kit — MessageStack (PRODUCT-EXTENSION, round 8).
 *
 * The kit-level message system the build panel's row mechanism
 * generalizes into (owner item 2): a fixed, non-modal stack of
 * dismissable plain-word messages — one corner card per operation
 * outcome, never a modal, never hover-only. Consumers push structured
 * messages (an optional title + plain-text lines); the stack owns the
 * chrome (the card, the × dismiss, the enter animation, the cap).
 *
 * Layout discipline: the stack is `position: fixed` (never in the flow
 * — pushing a message can never thrash the workspace layout), columns
 * bottom-up (newest nearest the bottom edge, like a conversation), and
 * caps the visible count (the oldest card drops first) so an
 * operation-heavy session cannot grow an unbounded column. Enter
 * animates transform/opacity only.
 */

/** One dismissable message. */
export interface KitMessage {
  /** Card heading (e.g. 已应用：基本拉丁 用英文字体). */
  title?: string;
  /** Body lines, plain text, one row each. */
  lines: readonly string[];
}

export interface MessageStack {
  /** Append a message (the oldest drops past the visible cap). */
  push(message: KitMessage): void;
}

/** How many cards stay stacked (the oldest is dropped past it). */
const VISIBLE_CAP = 4;

export function mountMessageStack(
  host: HTMLElement = document.body,
): MessageStack {
  const stack = document.createElement("div");
  stack.className = "kit-msgs";
  stack.setAttribute("role", "status");
  stack.setAttribute("aria-live", "polite");
  stack.setAttribute("aria-label", "操作消息");
  host.appendChild(stack);

  const dismiss = (card: HTMLElement): void => {
    card.classList.remove("enter");
    card.classList.add("leave");
    // The leave transition is opacity-only; remove when it settles (or
    // immediately when transitions are unavailable — display:none never
    // participates, so the card must actually detach).
    const done = (): void => {
      card.remove();
    };
    card.addEventListener("transitionend", done, { once: true });
    setTimeout(done, 200);
  };

  const push = (message: KitMessage): void => {
    while (stack.children.length >= VISIBLE_CAP) {
      stack.firstElementChild?.remove();
    }
    const card = document.createElement("div");
    card.className = "kit-msg enter";
    card.dataset.role = "message";
    if (message.title !== undefined) {
      const title = document.createElement("div");
      title.className = "kit-msg-title";
      title.textContent = message.title;
      card.appendChild(title);
    }
    for (const line of message.lines) {
      const row = document.createElement("div");
      row.className = "kit-msg-line";
      row.textContent = line;
      card.appendChild(row);
    }
    // The card BODY is pointer-transparent (CSS pointer-events: none —
    // the workspace underneath stays fully interactive; a message must
    // never mask the grid or the rail). Only the × dismiss is a real
    // hit target (pointer-events: auto on the button).
    const close = document.createElement("button");
    close.type = "button";
    close.className = "kit-msg-close";
    close.dataset.role = "message-dismiss";
    close.setAttribute("aria-label", "关闭消息");
    close.textContent = "×";
    close.addEventListener("click", () => dismiss(card));
    card.appendChild(close);
    stack.appendChild(card);
  };

  return { push };
}
