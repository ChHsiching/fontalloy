/**
 * FontAlloy kit — TopBar parts.
 *
 * The prototype's top bar, as composable parts: brand mark, the current
 * font-pair tags (base + donor with the + separator), the GitHub repo
 * link, the light/dark theme toggle, the output font-name input
 * (defaulting to the brand default `ChHsich`), and the primary
 * 合成字体 action (with its shimmer + glow). mountTopBar assembles
 * them in the validated order.
 */

import { icon } from "./icons";
import { toggleAppTheme } from "./theme";

export const GITHUB_REPO = "ChHsiching/fontalloy";
export const GITHUB_URL = `https://github.com/${GITHUB_REPO}`;
/** The fixed brand default output name (ADR-0005; never derived). */
export const DEFAULT_FONT_NAME = "ChHsich";

/* ---------- parts ---------- */

/**
 * The brand mark (round 4): a hand-drawn "A" built from 永-style brush
 * strokes inside a rounded glyph cell — the product in one mark (a
 * monospace Latin letterform whose strokes are CJK calligraphy). The
 * 捺 press-stroke and the detached 点 dot carry the teal accent; the
 * rest follows the text color, so the mark reads on dark and light
 * alike. Drawn on a 24 grid with ≥2px strokes so it stays crisp at the
 * 16px topbar size (and up to 24px+ elsewhere). The owner finalizes
 * the concept later — today it must simply not be a placeholder block.
 */
const BRAND_MARK_SVG = `
<svg class="kit-brand-mark" viewBox="0 0 24 24" aria-hidden="true">
  <rect x="2.75" y="2.75" width="18.5" height="18.5" rx="5"
        fill="none" stroke="var(--ln2)" stroke-width="1.5"></rect>
  <path d="M12.2 5.8C10.4 9.6 8.9 14 7.6 18.6"
        fill="none" stroke="currentColor" stroke-width="2.2"
        stroke-linecap="round"></path>
  <path d="M12.2 5.8C13.9 9.8 15.6 14.1 17.2 18.6"
        fill="none" stroke="var(--ac)" stroke-width="2.2"
        stroke-linecap="round"></path>
  <path d="M8.8 14.6H15.8"
        fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round"></path>
  <circle cx="17.7" cy="8.1" r="1.5" fill="var(--ac)"></circle>
</svg>`;

export function brandPart(): HTMLElement {
  const brand = document.createElement("div");
  brand.className = "kit-brand";
  brand.innerHTML = BRAND_MARK_SVG;
  brand.appendChild(document.createTextNode("FontAlloy"));
  return brand;
}

/**
 * The base + donor pair: two tags joined by a dimmed `+`. Empty sides
 * hide their tag (and the separator) — the prototype never shows a
 * placeholder: its tags always carry real picks, so the honest empty
 * state is no pill at all, not an em-dash one.
 */
export function fontPairTags(
  base: string,
  donor: string,
): { el: HTMLElement; set(base: string, donor: string): void } {
  const el = document.createElement("span");
  el.dataset.role = "font-pair";
  const baseTag = document.createElement("span");
  baseTag.className = "kit-tag";
  baseTag.dataset.pair = "base";
  const plus = document.createElement("span");
  plus.style.color = "var(--ink3)";
  plus.textContent = "+";
  const donorTag = document.createElement("span");
  donorTag.className = "kit-tag";
  donorTag.dataset.pair = "donor";
  el.append(baseTag, plus, donorTag);
  const set = (b: string, d: string): void => {
    baseTag.textContent = b;
    donorTag.textContent = d;
    baseTag.style.display = b ? "" : "none";
    donorTag.style.display = d ? "" : "none";
    plus.style.display = b && d ? "" : "none";
  };
  set(base, donor);
  return { el, set };
}

export function githubLink(): HTMLAnchorElement {
  const link = document.createElement("a");
  link.className = "kit-btn gh";
  link.href = GITHUB_URL;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.setAttribute("aria-label", `GitHub 仓库 ${GITHUB_REPO}`);
  link.style.fontSize = "12px";
  link.innerHTML = icon("github");
  link.appendChild(document.createTextNode(GITHUB_REPO));
  return link;
}

export interface ThemeToggleProps {
  onToggle?: () => void;
}

export function themeToggle(props: ThemeToggleProps = {}): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "kit-btn gh";
  btn.dataset.role = "theme-toggle";
  btn.setAttribute("aria-label", "切换明暗");
  btn.innerHTML = icon("theme");
  btn.addEventListener("click", () => {
    toggleAppTheme();
    props.onToggle?.();
  });
  return btn;
}

export interface FontNameInputProps {
  value?: string;
  onChange?(value: string): void;
}

/** The output font-name field — letters, digits, hyphens only. */
export function fontNameInput(
  props: FontNameInputProps = {},
): HTMLInputElement {
  const input = document.createElement("input");
  input.dataset.role = "font-name";
  input.value = props.value ?? DEFAULT_FONT_NAME;
  input.spellcheck = false;
  input.setAttribute("aria-label", "输出字体名");
  input.title = "字体名只能用英文字母、数字和连字符";
  input.className = "kit-fontname-input";
  input.addEventListener("input", () => props.onChange?.(input.value));
  return input;
}

export interface SynthesizeButtonProps {
  onClick(): void;
}

export function synthesizeButton(
  props: SynthesizeButtonProps,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "kit-btn pri";
  btn.dataset.role = "synthesize";
  btn.textContent = "合成字体";
  btn.addEventListener("click", () => props.onClick());
  return btn;
}

/* ---------- assembly ---------- */

export interface TopBarProps {
  base: string;
  donor: string;
  fontName?: string;
  onFontName?(value: string): void;
  onSynthesize(): void;
  onThemeToggle?(): void;
}

export interface TopBar {
  readonly el: HTMLElement;
  setPair(base: string, donor: string): void;
}

export function mountTopBar(host: HTMLElement, props: TopBarProps): TopBar {
  const el = document.createElement("header");
  el.className = "kit-topbar";
  const pair = fontPairTags(props.base, props.donor);
  const grow = document.createElement("span");
  grow.className = "kit-grow";
  el.append(
    brandPart(),
    pair.el,
    grow,
    githubLink(),
    themeToggle({ onToggle: props.onThemeToggle }),
    fontNameInput({ value: props.fontName, onChange: props.onFontName }),
    synthesizeButton({ onClick: props.onSynthesize }),
  );
  host.appendChild(el);
  return { el, setPair: pair.set };
}
