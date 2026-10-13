/**
 * FontAlloy kit — CharPopup (the cell's character popup).
 *
 * The prototype's #charpop, ported whole: opens AT the clicked grid
 * cell (the fitPop discipline: below → flip above → cap, clamped to
 * the app frame) with the 44px glyph in the winning font, the U+XXXX
 * code in accent mono, the 来自 X line (plus the round-7
 * ineffective-assignment `note` under it when a declared side cannot
 * supply the glyph), the one-click 用英文字体/用中文字体 buttons (the
 * carried side is the consumer's to hide), and the underlined 恢复默认.
 *
 * Round 8 (owner item 1): a side button whose font LACKS the codepoint
 * is never a working action — it renders DISABLED with the plain-words
 * reason attached to it (「X字体不含此码位」, visible the moment the
 * popup opens, no extra clicks), instead of an enabled button whose
 * assignment could never take effect.
 *
 * Round 11 (owner item 8): "attached" must mean PAINTED — the show
 * path sets an explicit inline `display:block` (clearing the inline
 * style fell through to the sheet's `display:none` default, so the
 * copy existed in the DOM but never rendered), and the disabled dim
 * lives in the label's color so the reason keeps legible contrast.
 *
 * The FACTS — including the three action callbacks, which close over
 * the open codepoint — are the consumer's; the kit renders what it is
 * given, reports the actions, and closes after each.
 */

import { fitPopup } from "./position";

export interface CharPopupFacts {
  /** The character (rendered large in `glyphFamily`). */
  glyph: string;
  /**
   * Font stack for the glyph; omitted for the missing treatment (the
   * dim 'Microsoft YaHei' system reference face, like the prototype).
   */
  glyphFamily?: string;
  /** True when no pick covers the glyph (the dim missing treatment). */
  missing?: boolean;
  /** Code label ("U+4E2D"), rendered in the accent mono. */
  code: string;
  /** The 来自 X line / the missing-glyph copy. */
  from: string;
  /**
   * Ineffective-assignment reason (round 7): when a rule declares a
   * side whose font lacks this codepoint (absence never overrides), a
   * plain-words second line under 来自 states it — e.g.
   * 「英文字体不含此码位，仍由中文字体补字」. Omitted otherwise.
   */
  note?: string;
  showBase: boolean;
  showDonor: boolean;
  /**
   * Round 8: the shown side's font lacks this codepoint — the button
   * renders DISABLED with the reason attached under its label (「英文
   * 字体不含此码位」), visible on open. Omitted when the button works.
   */
  baseReason?: string;
  donorReason?: string;
  showReset: boolean;
  onBase?(): void;
  onDonor?(): void;
  onReset?(): void;
}

export interface CharPopup {
  openAt(cell: HTMLElement, facts: CharPopupFacts): void;
  close(): void;
}

export function mountCharPopup(): CharPopup {
  const popup = document.createElement("div");
  popup.className = "kit-pop";
  popup.dataset.charPopup = "";
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-label", "字符详情");

  const glyph = document.createElement("div");
  glyph.className = "kit-pop-glyph";
  glyph.dataset.role = "char-glyph";

  const code = document.createElement("div");
  code.className = "kit-pop-code";
  code.dataset.role = "char-code";

  const from = document.createElement("div");
  from.className = "kit-pop-from";
  from.dataset.role = "char-from";

  const note = document.createElement("div");
  note.className = "kit-pop-note";
  note.dataset.role = "char-note";

  const btns = document.createElement("div");
  btns.className = "kit-pop-btns";
  const sideButton = (role: string, label: string): HTMLButtonElement => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "kit-btn sm kit-pop-side";
    btn.dataset.role = role;
    const text = document.createElement("span");
    text.className = "kit-pop-side-label";
    text.textContent = label;
    btn.appendChild(text);
    // The round-8 disabled reason line (visible inside the button).
    const reason = document.createElement("span");
    reason.className = "kit-pop-side-reason";
    reason.dataset.role = `${role}-reason`;
    btn.appendChild(reason);
    return btn;
  };
  const baseBtn = sideButton("char-base", "用英文字体");
  const donorBtn = sideButton("char-donor", "用中文字体");
  btns.append(baseBtn, donorBtn);

  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "kit-pop-rest";
  reset.dataset.role = "char-reset";
  reset.textContent = "恢复默认";

  popup.append(glyph, code, from, note, btns, reset);
  document.body.appendChild(popup);

  let anchorCell: HTMLElement | null = null;
  let facts: CharPopupFacts | null = null;

  const close = (): void => {
    if (facts === null) return;
    facts = null;
    anchorCell = null;
    popup.classList.remove("open");
  };

  const render = (next: CharPopupFacts): void => {
    glyph.textContent = next.glyph;
    code.textContent = next.code;
    from.textContent = next.from;
    note.textContent = next.note ?? "";
    // Show = an EXPLICIT inline "block". Clearing the inline style
    // ("") would fall back to the sheet's `display:none` default
    // (both lines are hidden-by-default in kit.css) and the copy
    // would never render — round 11, owner item 8.
    note.style.display = next.note ? "block" : "none";
    if (next.missing || !next.glyphFamily) {
      glyph.style.fontFamily = "'Microsoft YaHei',serif";
      glyph.style.color = next.missing ? "var(--ink3)" : "";
    } else {
      glyph.style.fontFamily = next.glyphFamily;
      glyph.style.color = "";
    }
    baseBtn.style.display = next.showBase ? "" : "none";
    donorBtn.style.display = next.showDonor ? "" : "none";
    // Round 8: a side whose font lacks this codepoint disables its
    // button and states the reason IN it (visible on open).
    baseBtn.disabled = Boolean(next.baseReason);
    donorBtn.disabled = Boolean(next.donorReason);
    const reasonText = (btn: HTMLButtonElement, text: string | undefined): void => {
      const node = btn.querySelector<HTMLElement>(".kit-pop-side-reason")!;
      node.textContent = text ?? "";
      // The same explicit-"block" rule as the note line above: the
      // sheet hides the reason by default, so "" would keep it hidden.
      node.style.display = text ? "block" : "none";
    };
    reasonText(baseBtn, next.baseReason);
    reasonText(donorBtn, next.donorReason);
    reset.style.display = next.showReset ? "" : "none";
  };

  const openAt = (cell: HTMLElement, next: CharPopupFacts): void => {
    if (facts !== null && facts !== next) close();
    anchorCell = cell;
    facts = next;
    render(next);
    popup.classList.add("open");
    fitPopup(popup, cell.getBoundingClientRect());
  };

  baseBtn.addEventListener("click", () => {
    facts?.onBase?.();
    close();
  });
  donorBtn.addEventListener("click", () => {
    facts?.onDonor?.();
    close();
  });
  reset.addEventListener("click", () => {
    facts?.onReset?.();
    close();
  });

  popup.addEventListener("pointerdown", (e) => e.stopPropagation());
  document.addEventListener("pointerdown", (e) => {
    if (facts === null) return;
    const target = e.target as Node;
    if (!target.isConnected) return;
    // A click on any cell (re-opens at that cell) or inside the popup
    // keeps it; everything else closes it.
    if (
      popup.contains(target) ||
      (target instanceof Element && target.closest(".kit-cell"))
    ) {
      return;
    }
    close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && facts !== null) close();
  });
  window.addEventListener("resize", () => {
    if (facts !== null && anchorCell !== null && anchorCell.isConnected) {
      fitPopup(popup, anchorCell.getBoundingClientRect());
    }
  });

  return { openAt, close };
}
