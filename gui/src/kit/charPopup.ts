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
  const baseBtn = document.createElement("button");
  baseBtn.type = "button";
  baseBtn.className = "kit-btn sm";
  baseBtn.dataset.role = "char-base";
  baseBtn.textContent = "用英文字体";
  const donorBtn = document.createElement("button");
  donorBtn.type = "button";
  donorBtn.className = "kit-btn sm";
  donorBtn.dataset.role = "char-donor";
  donorBtn.textContent = "用中文字体";
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
    note.style.display = next.note ? "" : "none";
    if (next.missing || !next.glyphFamily) {
      glyph.style.fontFamily = "'Microsoft YaHei',serif";
      glyph.style.color = next.missing ? "var(--ink3)" : "";
    } else {
      glyph.style.fontFamily = next.glyphFamily;
      glyph.style.color = "";
    }
    baseBtn.style.display = next.showBase ? "" : "none";
    donorBtn.style.display = next.showDonor ? "" : "none";
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
