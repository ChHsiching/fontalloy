/**
 * FontAlloy kit — MessageStack (PRODUCT-EXTENSION, round 8; round 9
 * items 3+7; the structured-card redesign).
 *
 * The kit-level message system the build panel's row mechanism
 * generalizes into: a fixed, non-modal stack of dismissable outcome
 * cards — one corner card per operation outcome, never a modal, never
 * hover-only. Consumers push STRUCTURED messages (a status icon, an
 * action title, compact stat pairs, an optional reason line, an undo
 * hint); the stack owns the chrome (the card, the × dismiss, the
 * enter/leave motion, the cap).
 *
 * Why structured (the owner's vision pass): the round-9 prose line —
 * 「中日韩文字 → 英文：0 生效 / 41,289 未变（无字形）· Ctrl+Z 撤销」 —
 * read as log soup: auto-wrapped, Unicode glyphs (·, →) posing as
 * icons and separators, information dumped like a log line. The card
 * is now a small structure, not a sentence:
 *
 *   [status icon]  action title (weight 600)
 *   95 生效   41,289 未变          ← tabular-nums figures, dim labels
 *   英文字体不含此码位              ← dim reason, ONLY when nonzero
 *   [Ctrl+Z] 撤销                  ← kbd-styled chip + verb
 *
 * Layout discipline: every line is `white-space: nowrap` — nothing
 * ever auto-wraps. The card has a fixed max-width (~360px); a line
 * that would overflow truncates with an ellipsis and carries its full
 * text as a `title` tooltip. Separators are CSS gaps (flex margins),
 * never glyphs; the icons are kit/icons SVGs.
 *
 * The stack stays `position: fixed` (never in the flow — pushing a
 * message can never thrash the workspace layout), columns bottom-up
 * (newest nearest the bottom edge, like a conversation), and caps the
 * visible count (the oldest card drops first) so an operation-heavy
 * session cannot grow an unbounded column. Enter/leave animate
 * transform/opacity only (a critically-damped settle, no overshoot;
 * plain fade under prefers-reduced-motion).
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

import { icon, type IconName } from "./icons";

/** One figure of the outcome row: the number, and its dim label. */
export interface KitMessageStat {
  /** The figure, pre-formatted by the producer (e.g. "41,289"). */
  value: string;
  /** The dim word beside it (e.g. 生效 / 未变 / 恢复). */
  label: string;
}

/** One dismissable outcome card. */
export interface KitMessage {
  /**
   * Status icon (the at-a-glance verdict). Defaults to `check`; a
   * partially-ineffective outcome passes `warn` — the tone colors it.
   */
  icon?: IconName;
  /** The action, one heading (e.g. 中日韩文字用英文字体). */
  title?: string;
  /** The outcome as compact stat pairs — numbers first, labels dim. */
  stats?: readonly KitMessageStat[];
  /**
   * A dim reason sub-line under the stats, shown ONLY when set — the
   * producer omits it when the count it explains is zero.
   */
  reason?: string;
  /**
   * The undo hint's verb (e.g. 撤销). When set, the card renders the
   * keyboard shortcut as a small kbd-styled chip beside it — never as
   * inline prose.
   */
  undo?: string;
  /**
   * Plain body lines (the simple variant): one nowrap row each,
   * ellipsized with a `title` tooltip. The structured fields above
   * render first when both are given.
   */
  lines?: readonly string[];
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

/** The shortcut the undo hint chips (the app's global rule undo). */
const UNDO_SHORTCUT = "Ctrl+Z";

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

/**
 * One nowrap text row that truncates instead of wrapping: the element
 * plus a `title` tooltip carrying the full string (the no-log-soup
 * contract — overflow degrades to ellipsis, never to a wrapped mess).
 */
function nowrapRow(
  className: string,
  text: string,
  role?: string,
): HTMLElement {
  const row = document.createElement("div");
  row.className = className;
  row.textContent = text;
  row.title = text;
  if (role !== undefined) row.dataset.role = role;
  return row;
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
    // The leave transition is transform+opacity; remove when it
    // settles (or immediately when transitions are unavailable —
    // display:none never participates, so the card must actually
    // detach).
    const done = (): void => {
      card.remove();
    };
    card.addEventListener("transitionend", done, { once: true });
    setTimeout(done, 280);
  };

  const push = (message: KitMessage): void => {
    while (stack.children.length >= VISIBLE_CAP) {
      stack.firstElementChild?.remove();
    }
    const card = document.createElement("div");
    card.className = "kit-msg enter";
    card.dataset.role = "message";

    // The head: the status icon (SVG, never a text glyph) beside the
    // action title, with the × dismiss closing the row — alignment by
    // flex, not by absolute offsets.
    const head = document.createElement("div");
    head.className = "kit-msg-head";
    const statusIcon = document.createElement("span");
    statusIcon.className = "kit-msg-icon";
    statusIcon.dataset.icon = message.icon ?? "check";
    statusIcon.innerHTML = icon(message.icon ?? "check");
    head.appendChild(statusIcon);
    if (message.title !== undefined) {
      head.appendChild(
        nowrapRow("kit-msg-title", message.title, "message-title"),
      );
    }
    // The × dismiss: a real hit target (the card body is hoverable for
    // the pause; the × closes instantly). Icon-only, like the rule
    // rows' delete — the card's copy stays exactly its text.
    const close = document.createElement("button");
    close.type = "button";
    close.className = "kit-msg-close";
    close.dataset.role = "message-dismiss";
    close.setAttribute("aria-label", "关闭消息");
    close.innerHTML = icon("close");
    head.appendChild(close);
    card.appendChild(head);

    // The outcome: compact stat pairs in one nowrap row — figures in
    // tabular-nums, labels dim, separated by CSS gaps. The row carries
    // the full figures as its `title` tooltip for the ellipsized edge
    // case (a tooltip only — never a second copy of the text).
    if (message.stats !== undefined && message.stats.length > 0) {
      const statsRow = document.createElement("div");
      statsRow.className = "kit-msg-stats";
      statsRow.dataset.role = "message-stats";
      statsRow.title = message.stats
        .map((s) => `${s.value} ${s.label}`)
        .join(" ");
      for (const stat of message.stats) {
        const pair = document.createElement("span");
        pair.className = "kit-msg-stat";
        const num = document.createElement("span");
        num.className = "kit-msg-num";
        num.textContent = stat.value;
        const label = document.createElement("span");
        label.className = "kit-msg-label";
        label.textContent = stat.label;
        pair.append(num, label);
        statsRow.appendChild(pair);
      }
      card.appendChild(statsRow);
    }

    // The reason sub-line: rendered ONLY when the producer passes one
    // (a nonzero ineffective count) — never repeating for zero.
    if (message.reason !== undefined && message.reason !== "") {
      card.appendChild(
        nowrapRow("kit-msg-reason", message.reason, "message-reason"),
      );
    }

    // The plain-lines variant (the simple card): one nowrap row each.
    for (const line of message.lines ?? []) {
      card.appendChild(nowrapRow("kit-msg-line", line));
    }

    // The undo hint: the shortcut as a kbd-styled chip (border +
    // radius + tabular figures), the verb as dim text beside it.
    if (message.undo !== undefined && message.undo !== "") {
      const undo = document.createElement("div");
      undo.className = "kit-msg-undo";
      undo.dataset.role = "message-undo";
      const kbd = document.createElement("span");
      kbd.className = "kit-msg-kbd";
      kbd.textContent = UNDO_SHORTCUT;
      const verb = document.createElement("span");
      verb.className = "kit-msg-verb";
      verb.textContent = message.undo;
      undo.append(kbd, verb);
      card.appendChild(undo);
    }

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
