/**
 * FontAlloy kit — theme system.
 *
 * Two layers, both carried from the prototype:
 *
 * 1. The APP theme: a light/dark toggle on <html data-theme>. Switching
 *    parks a `.theming` class for two frames (transition killer — a
 *    permanent `[data-theme] *{transition:none}` rule silently kills
 *    same-specificity transitions; prototype r30 lesson).
 *
 * 2. The SCENE themes: 14 terminal palettes + 10 editor palettes. The
 *    "" id means follow the app theme. Data lives in tokens.ts; these
 *    helpers convert it to option lists and data attributes.
 */

import {
  EDITOR_THEMES,
  TERMINAL_THEMES,
  type AppTheme,
} from "./tokens";

export type { AppTheme };

/* ---------- app theme ---------- */

export function getAppTheme(): AppTheme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/** Apply the app theme with the two-frame transition killer around it. */
export function applyAppTheme(theme: AppTheme): void {
  const root = document.documentElement;
  root.classList.add("theming");
  root.dataset.theme = theme;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => root.classList.remove("theming")),
  );
}

export function toggleAppTheme(): AppTheme {
  const next: AppTheme = getAppTheme() === "light" ? "dark" : "light";
  applyAppTheme(next);
  return next;
}

/* ---------- the three-state preference (round 5, owner item 8) ------ */

/**
 * The theme PREFERENCE: 自动 (follow the system) → 浅色 → 深色, cycling
 * on the toggle. The icon always shows the EFFECTIVE theme (sun in
 * light, moon in dark) and carries a tiny 自动 badge while the
 * preference is auto. Persisted across launches in localStorage.
 */
export type ThemePreference = "auto" | "light" | "dark";

const THEME_STORAGE_KEY = "fontalloy-theme-preference";

function readStoredPreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === "auto" || raw === "light" || raw === "dark") return raw;
  } catch {
    // Storage can be absent (privacy modes): the in-memory default stands.
  }
  return "auto";
}

let preference: ThemePreference = readStoredPreference();

/** The current theme preference. */
export function getThemePreference(): ThemePreference {
  return preference;
}

/** The theme a preference resolves to right now. */
export function effectiveTheme(pref: ThemePreference): AppTheme {
  if (pref !== "auto") return pref;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function storePreference(pref: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    // Unpersistable is fine for the session.
  }
}

/** The preference's announce label (the button's title/tooltip text). */
export function themePreferenceLabel(pref: ThemePreference): string {
  if (pref === "auto") return "自动";
  return pref === "light" ? "浅色" : "深色";
}

/** Set the preference: applies it and persists the choice. */
export function setThemePreference(pref: ThemePreference): ThemePreference {
  preference = pref;
  storePreference(pref);
  applyAppTheme(effectiveTheme(pref));
  return pref;
}

/** The toggle's cycle: 自动 → 浅色 → 深色 → 自动. */
export function cycleThemePreference(): ThemePreference {
  const order: ThemePreference[] = ["auto", "light", "dark"];
  return setThemePreference(
    order[(order.indexOf(preference) + 1) % order.length]!,
  );
}

// While the preference is 自动, the app follows the system live (the
// OS flip applies with the same transition killer as a manual toggle).
window
  .matchMedia("(prefers-color-scheme: dark)")
  .addEventListener("change", () => {
    if (preference === "auto") applyAppTheme(effectiveTheme("auto"));
  });

/** Apply the persisted preference at boot (the ui/topbar entry point). */
export function applyStoredThemePreference(): ThemePreference {
  return setThemePreference(preference);
}

/* ---------- scene themes ---------- */

export interface ThemeOption {
  value: string;
  label: string;
}

/** Terminal theme options for the scene card's AppSelect (14 total). */
export const TERMINAL_THEME_OPTIONS: readonly ThemeOption[] =
  TERMINAL_THEMES.map((t) => ({ value: t.id, label: t.label }));

/** Editor theme options for the scene card's AppSelect (10 total). */
export const EDITOR_THEME_OPTIONS: readonly ThemeOption[] =
  EDITOR_THEMES.map((t) => ({ value: t.id, label: t.label }));

/** Look up a terminal theme by id ("" = follow the app theme). */
export function terminalTheme(id: string) {
  return TERMINAL_THEMES.find((t) => t.id === id);
}

/** Look up an editor theme by id ("" = follow the app theme). */
export function editorTheme(id: string) {
  return EDITOR_THEMES.find((t) => t.id === id);
}

/** Lock or unlock a terminal palette: "" removes the lock. */
export function applyTerminalTheme(el: HTMLElement, id: string): void {
  if (id) el.dataset.t = id;
  else delete el.dataset.t;
}

/** Lock or unlock an editor palette: "" removes the lock. */
export function applyEditorTheme(el: HTMLElement, id: string): void {
  if (id) el.dataset.ct = id;
  else delete el.dataset.ct;
}
