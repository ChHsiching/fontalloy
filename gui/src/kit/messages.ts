/**
 * FontAlloy kit — MessageStack (PRODUCT-EXTENSION, round 8; round 9
 * items 3+7).
 *
 * The kit-level message system the build panel's row mechanism
 * generalizes into: a fixed, non-modal stack of dismissable plain-word
 * messages — one corner card per operation outcome, never a modal,
 * never hover-only. Consumers push structured messages (an optional
 * title + plain-text lines); the stack owns the chrome (the card, the
 * × dismiss, the enter animation, the cap).
 *
 * Layout discipline: the stack is `position: fixed` (never in the flow
 * — pushing a message can never thrash the workspace layout), columns
 * bottom-up (newest nearest the bottom edge, like a conversation), and
 * caps the visible count (the oldest card drops first) so an
 * operation-heavy session cannot grow an unbounded column. Enter
 * animates transform/opacity only.
 *
 * Round 9 (owner item 7) — the auto-dismiss countdown: every card
 * closes itself after ~6s, announced by a thin progress bar shrinking
 * along the card's bottom edge. Hovering the card PAUSES the countdown
 * (the bar freezes at its current width); leaving resumes; the × still
 * closes instantly. A message may opt out (e.g. a settled build
 * result a user needs to keep reading) with `autoDismiss: false`.
 * Because hover must land, a card is a real hit target — the stack's
 * empty area stays pointer-transparent so the workspace underneath
 * keeps working around the cards.
 */

import { icon } from "./icons";

/** One dismissable message. */
export interface KitMessage {
  /** Card heading (rare — the round-9 copy is one line). */
  title?: string;
  /** Body lines, plain text, one row each. */
  lines: readonly string[];
  /**
   * Auto-dismiss delay in ms (round 9). `false` opts the card out
   * (it stays until dismissed); default 6000 — the ~6s countdown.
   */
  autoDismiss?: number | false;
}

export interface MessageStack {
  /** Append a message (the oldest drops past the visible cap). */
  push(message: KitMessage): void;
}

/** How many cards stay stacked (the oldest is dropped past it). */
const VISIBLE_CAP = 4;

/** The default countdown (round 9, owner item 7). */
const DEFAULT_DISMISS_MS = 6000;

/** One countdown's controller: rAF-driven so a hover can freeze it. */
class Countdown {
  private remaining: number;
  private lastTick: number | null = null;
  private raf = 0;
  private running = false;

  constructor(
    private readonly total: number,
    private readonly bar: HTMLElement,
    private readonly onDone: () => void,
  ) {
    this.remaining = total;
    this.bar.style.transform = "scaleX(1)";
  }

  start(): void {
    if (this.running || this.remaining <= 0) return;
    this.running = true;
    this.lastTick = performance.now();
    const tick = (now: number): void => {
      if (!this.running) return;
      const dt = now - (this.lastTick ?? now);
      this.lastTick = now;
      this.remaining = Math.max(0, this.remaining - dt);
      this.bar.style.transform = `scaleX(${this.remaining / this.total})`;
      if (this.remaining <= 0) {
        this.running = false;
        this.onDone();
        return;
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  pause(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  stop(): void {
    this.pause();
  }
}

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
    // The × dismiss: a real hit target (the card body is hoverable for
    // the pause; the × closes instantly). Icon-only, like the rule
    // rows' delete — the card's textContent stays exactly its copy.
    const close = document.createElement("button");
    close.type = "button";
    close.className = "kit-msg-close";
    close.dataset.role = "message-dismiss";
    close.setAttribute("aria-label", "关闭消息");
    close.innerHTML = icon("close");
    card.appendChild(close);
    // The countdown bar (round 9): a thin edge progress strip along
    // the card's bottom. Hover pauses, leave resumes, × stops outright.
    const autoDismiss = message.autoDismiss === undefined ? DEFAULT_DISMISS_MS : message.autoDismiss;
    let countdown: Countdown | null = null;
    if (autoDismiss !== false) {
      const bar = document.createElement("div");
      bar.className = "kit-msg-bar";
      card.appendChild(bar);
      countdown = new Countdown(autoDismiss, bar, () => dismiss(card));
      countdown.start();
      card.addEventListener("pointerenter", () => countdown?.pause());
      card.addEventListener("pointerleave", () => countdown?.start());
      card.dataset.autoDismiss = String(autoDismiss);
    } else {
      card.dataset.autoDismiss = "none";
    }
    close.addEventListener("click", () => {
      countdown?.stop();
      dismiss(card);
    });
    stack.appendChild(card);
  };

  return { push };
}
