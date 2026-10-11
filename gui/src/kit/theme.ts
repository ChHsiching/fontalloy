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
