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
import {
  cycleThemePreference,
  effectiveTheme,
  getThemePreference,
  themePreferenceLabel,
  type ThemePreference,
} from "./theme";

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
 * alike. Drawn on a 24 grid with ≥2px strokes so it stays crisp from
 * 16 to 24px+. Round 7 adopts it product-wide (owner: the top-bar mark
 * was 好小 and 只有左上角): 22px in the top bar, and the same mark
 * heads the first-run / build / no-service panels, the web favicon,
 * and the generated Tauri icon set (gui/scripts/make-icons.mjs).
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
  brand.appendChild(brandMark(22));
  brand.appendChild(document.createTextNode("FontAlloy"));
  return brand;
}

/**
 * The mark at an explicit size, outside the top bar (round 7): panel
 * headers (first-run catalog, build, no-service) adopt the same SVG at
 * their own scale. The svg keeps the kit-brand-mark class so walkers
 * and CSS find it everywhere.
 */
export function brandMark(size: number): HTMLElement {
  const holder = document.createElement("span");
  holder.className = "kit-mark";
  holder.dataset.role = "brand-mark";
  holder.innerHTML = BRAND_MARK_SVG;
  const svg = holder.firstElementChild as SVGSVGElement;
  svg.style.width = `${size}px`;
  svg.style.height = `${size}px`;
  return holder;
}

/**
 * The base + donor pair: two tags joined by the kit's plus glyph
 * (icon-purge round: a dimmed text `+` used to sit here). Empty sides
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
  plus.className = "kit-pair-plus";
  plus.innerHTML = icon("plus");
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

export interface GithubLinkProps {
  /**
   * Intercept the navigation (returning true suppresses the anchor's
   * own navigation — e.g. the Tauri shell routes the click to the
   * system browser). The plain web target never passes one.
   */
  onNavigate?(url: string): boolean;
}

/**
 * The GitHub repo ghost link (the prototype's top bar, same spot: after
 * the grow spacer, before the theme toggle). In the plain web target it
 * is a normal link; under Tauri the consumer intercepts the click and
 * opens the system browser (round 5, owner item 12) — the kit itself
 * stays environment-agnostic.
 */
export function githubLink(props: GithubLinkProps = {}): HTMLAnchorElement {
  const link = document.createElement("a");
  link.className = "kit-btn gh";
  link.href = GITHUB_URL;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.setAttribute("aria-label", `GitHub 仓库 ${GITHUB_REPO}`);
  link.style.fontSize = "12px";
  link.innerHTML = icon("github");
  link.appendChild(document.createTextNode(GITHUB_REPO));
  link.addEventListener("click", (event) => {
    if (props.onNavigate?.(GITHUB_URL) === true) {
      event.preventDefault();
    }
  });
  return link;
}

export interface ThemeToggleProps {
  /** Notified with the new preference after each cycle step. */
  onPreference?(pref: ThemePreference): void;
}

/**
 * The theme toggle (round 5, owner item 8): a THREE-STATE cycle
 * 自动 → 浅色 → 深色 → 自动. The icon shows the EFFECTIVE theme (sun in
 * light, moon in dark) whatever the preference, and a tiny 自动 badge
 * marks the follow-system state. `data-theme-mode` carries the
 * preference for walkers; the aria-label stays the prototype's
 * 切换明暗 with the current mode in the title.
 */
export function themeToggle(props: ThemeToggleProps = {}): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  // Standard bordered button chrome in BOTH themes — the borderless "gh"
  // link style left the light-theme sun as a bare floating glyph.
  btn.className = "kit-btn";
  btn.dataset.role = "theme-toggle";

  const draw = (): void => {
    const pref = getThemePreference();
    const effective = effectiveTheme(pref);
    btn.dataset.themeMode = pref;
    btn.setAttribute("aria-label", "切换明暗");
    btn.title = `主题：${themePreferenceLabel(pref)}${pref === "auto" ? "（跟随系统）" : ""}，点击切换`;
    btn.innerHTML =
      icon(effective === "dark" ? "moon" : "theme") +
      (pref === "auto" ? '<span class="kit-theme-auto">自动</span>' : "");
  };

  btn.addEventListener("click", () => {
    cycleThemePreference();
    draw();
    props.onPreference?.(getThemePreference());
  });

  draw();
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

/**
 * Focus the font-name input and flash it (round 17, owner item 3):
 * the same-name gate's 改个名字 path (round 18: the ask moved to the
 * click) lands the user on the field they need to edit — focused (no
 * scroll-jumping: the top bar is always on screen, so the focus
 * carries preventScroll) and pulsing its accent halo for ~1s via the
 * kit-flash class. The class drops on animationend (with a timeout
 * net for environments without animation events), so a later prompt
 * can flash it again.
 */
export function flashFontNameInput(): HTMLInputElement | null {
  const input = document.querySelector<HTMLInputElement>(
    "input[data-role='font-name']",
  );
  if (input === null) return null;
  input.focus({ preventScroll: true });
  input.classList.remove("kit-flash");
  // Force a style flush so a re-triggered flash restarts the keyframes.
  void input.offsetWidth;
  input.classList.add("kit-flash");
  const clear = (): void => input.classList.remove("kit-flash");
  input.addEventListener("animationend", clear, { once: true });
  setTimeout(clear, 2_000);
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
  /** Notified on every theme cycle step (round 5). */
  onThemePreference?(pref: ThemePreference): void;
  /** GitHub link navigation intercept (the Tauri shell opens the system
   *  browser; see githubLink). */
  onGithubNavigate?(url: string): boolean;
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
    githubLink({ onNavigate: props.onGithubNavigate }),
    themeToggle({ onPreference: props.onThemePreference }),
    fontNameInput({ value: props.fontName, onChange: props.onFontName }),
    synthesizeButton({ onClick: props.onSynthesize }),
  );
  host.appendChild(el);
  return { el, setPair: pair.set };
}
