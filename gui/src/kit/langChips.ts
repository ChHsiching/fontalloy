/**
 * FontAlloy kit — LangChips (the 文字范围 row).
 *
 * The prototype's rLangs row: the always-visible one-click language
 * chips (label + small dim count, pressed = declared). The toggle
 * GESTURE — including the last-language guard and its 至少保留一种
 * notice — is app state; the kit renders the row from props and
 * reports clicks.
 */

export interface LangChip {
  /** Stable preset id (the chip's data-preset). */
  id: string;
  /** Chip label (简体中文 …). */
  label: string;
  /** The small dim count, pre-formatted ("6,765"). */
  count: string;
}

export interface LangChipsProps {
  chips: readonly LangChip[];
  /** True when the chip's language is declared. */
  isPressed(id: string): boolean;
  onToggle(id: string): void;
}

export interface LangChips {
  readonly el: HTMLElement;
  render(props: LangChipsProps): void;
}

export function mountLangChips(
  host: HTMLElement,
  initial: LangChipsProps,
): LangChips {
  const el = document.createElement("div");
  el.className = "kit-chiprow";
  el.dataset.role = "lang-chips";
  host.appendChild(el);

  let props: LangChipsProps = initial;

  const render = (): void => {
    el.innerHTML = "";
    for (const chip of props.chips) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "kit-lchip";
      btn.dataset.role = "lang-chip";
      btn.dataset.preset = chip.id;
      btn.setAttribute("aria-pressed", String(props.isPressed(chip.id)));
      btn.appendChild(document.createTextNode(chip.label));
      const count = document.createElement("span");
      count.className = "n kit-num";
      count.textContent = chip.count;
      btn.appendChild(count);
      btn.addEventListener("click", () => props.onToggle(chip.id));
      el.appendChild(btn);
    }
  };

  render();

  return {
    el,
    render(next) {
      props = next;
      render();
    },
  };
}
