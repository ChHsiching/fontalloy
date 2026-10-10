import { store } from "../state";

export type PickerRole = "en" | "cjk";

export interface PickerOptions {
  role: PickerRole;
  /** Section label shown above the anchor. */
  label: string;
  /** Anchor text before any font is loaded. */
  emptyText: string;
}

export interface FontPicker {
  open(): void;
  close(): void;
}

/**
 * A font picker: an anchor row plus a popup listbox.
 *
 * Minimal slice: the anchor renders the current selection. The popup (outer
 * clipping layer, inner scroll, out-of-scroll local-file footer, clamped
 * positioning, node survival) arrives with the font-loading slice.
 */
export function mountPicker(
  root: HTMLElement,
  options: PickerOptions,
): FontPicker {
  root.innerHTML = `
    <button class="picker-anchor" aria-haspopup="listbox" aria-expanded="false">
      <span class="picker-current"></span>
      <span class="picker-caret" aria-hidden="true">▾</span>
    </button>
  `;

  const anchor = root.querySelector<HTMLButtonElement>(".picker-anchor")!;
  const current = anchor.querySelector<HTMLElement>(".picker-current")!;

  const render = (): void => {
    const { fonts, selected } = store.get();
    const font = fonts.find((f) => f.cssFamily === selected[options.role]);
    current.textContent = font ? font.family : options.emptyText;
    current.style.fontFamily = font
      ? `"${font.cssFamily}", sans-serif`
      : "";
  };
  store.subscribe(render);
  render();

  return {
    open() {},
    close() {},
  };
}
