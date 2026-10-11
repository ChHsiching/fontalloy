/**
 * FontAlloy kit — RangePopup (按编码指定).
 *
 * The prototype's #rangepop contract verbatim: the 按编码指定 title,
 * the hint 输入编码或范围，窄范围优先于整类。, the `U+0030 或 0` /
 * `留空=单个` inputs (an empty end means a single codepoint), the side
 * AppSelect, and the single primary 添加. Validation is the consumer's:
 * onApply receives the raw input strings and the chosen side, and
 * returns whether they applied — false paints the danger border on the
 * inputs and adds nothing; typing clears it. Enter commits.
 */

import { mountAppSelect, type AppSelect } from "./appSelect";
import type { FontSide } from "./actionBar";
import { fitPopup } from "./position";

export interface RangePopupProps {
  /**
   * Apply the inputs; return false when they are invalid (the danger
   * border) — the kit never parses codepoints itself.
   */
  onApply(start: string, end: string, side: FontSide): boolean;
}

export interface RangePopup {
  open(): void;
  toggle(): void;
  close(): void;
}

export function mountRangePopup(
  anchor: HTMLElement,
  props: RangePopupProps,
): RangePopup {
  const popup = document.createElement("div");
  popup.className = "kit-pop";
  popup.dataset.rangePopup = "";
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-label", "按编码指定");

  const title = document.createElement("h5");
  title.textContent = "按编码指定";
  const hint = document.createElement("p");
  hint.className = "kit-sub";
  hint.textContent = "输入编码或范围，窄范围优先于整类。";

  const row = document.createElement("div");
  row.className = "kit-rrow";
  const startInput = document.createElement("input");
  startInput.type = "text";
  startInput.spellcheck = false;
  startInput.dataset.role = "range-start";
  startInput.placeholder = "U+0030 或 0";
  startInput.setAttribute("aria-label", "起始码位");
  const endInput = document.createElement("input");
  endInput.type = "text";
  endInput.spellcheck = false;
  endInput.dataset.role = "range-end";
  endInput.placeholder = "留空=单个";
  endInput.setAttribute("aria-label", "结束码位");
  row.append(startInput, endInput);

  const actions = document.createElement("div");
  actions.className = "kit-rrow";
  const sideSelect: AppSelect = mountAppSelect({
    label: "指定字体",
    value: "base",
    options: [
      { value: "base", label: "用英文字体" },
      { value: "donor", label: "用中文字体" },
    ],
  });
  sideSelect.el.dataset.role = "range-side";
  const add = document.createElement("button");
  add.type = "button";
  add.className = "kit-btn sm pri";
  add.dataset.role = "range-add";
  add.textContent = "添加";
  actions.append(sideSelect.el, add);
  popup.append(title, hint, row, actions);
  document.body.appendChild(popup);

  let open = false;
  const position = (): void => {
    fitPopup(popup, anchor.getBoundingClientRect());
  };
  const close = (): void => {
    if (!open) return;
    open = false;
    startInput.style.borderColor = "";
    endInput.style.borderColor = "";
    popup.classList.remove("open");
  };
  const openUp = (): void => {
    if (open) return;
    open = true;
    popup.classList.add("open");
    position();
    startInput.focus();
  };
  const toggle = (): void => {
    if (open) close();
    else openUp();
  };
  const markInvalid = (): void => {
    startInput.style.borderColor = "var(--dgr)";
    endInput.style.borderColor = "var(--dgr)";
  };

  add.addEventListener("click", () => {
    const applied = props.onApply(
      startInput.value,
      endInput.value,
      sideSelect.value === "base" ? "base" : "donor",
    );
    if (!applied) {
      markInvalid();
      return;
    }
    close();
  });
  for (const input of [startInput, endInput]) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        add.click();
      }
    });
    input.addEventListener("input", () => {
      input.style.borderColor = "";
    });
  }
  // Escape with focus inside the popup (a text input may consume the
  // document-level rung): close here, before anything else.
  popup.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) {
      e.stopPropagation();
      close();
    }
  });

  // The popup's anchor element is only used for POSITIONING here; the
  // caller owns the click wiring (the toolbar's 按编码指定 buttons are
  // recreated on every action-bar render and reach toggle() through
  // ActionBarProps.onRangeSpecify — one owner of the open state).
  popup.addEventListener("pointerdown", (e) => e.stopPropagation());
  document.addEventListener("pointerdown", (e) => {
    if (!open) return;
    const target = e.target as Node;
    if (!target.isConnected) return;
    if (
      popup.contains(target) ||
      (target instanceof Element &&
        (target.closest(".kit-cselw") ||
          target.closest("[data-role='range-specify']")))
    ) {
      return;
    }
    close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) close();
  });
  window.addEventListener("resize", () => {
    if (open) position();
  });

  return { open: openUp, toggle, close };
}
