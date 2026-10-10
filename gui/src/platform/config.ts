/**
 * Runtime configuration for the shared frontend.
 *
 * The frontend runs in two environments (ADR-0002): inside the Tauri shell
 * and as a plain browser page (Vite dev server, future WebApp build). The
 * catalog bootstrap differs per environment, and the seam-3 Playwright
 * suite drives the whole first-run flow OUTSIDE Tauri by injecting a config
 * object before the app boots:
 *
 * ```ts
 * await page.addInitScript(() => {
 *   window.__FONTALLOY_CONFIG__ = { catalogBootstrapUrl: "https://…" };
 * });
 * ```
 *
 * Plain-browser builds deliberately default to NO catalog bootstrap — a dev
 * page must never start pulling the real ~375 MB catalog from GitHub. Only
 * the Tauri shell (or an explicit injected config) turns the downloader on.
 */

/** GitHub Releases tag carrying the consolidated catalog (ADR-0005, #14). */
export const CATALOG_TAG = "font-catalog-v1";
export const CATALOG_REPO = "ChHsiching/fontalloy";

export interface FontalloyConfig {
  /**
   * Where `catalog-release.json` is fetched from on every launch. `null`
   * disables the catalog entirely (plain-browser default).
   */
  catalogBootstrapUrl: string | null;
}

declare global {
  interface Window {
    __FONTALLOY_CONFIG__?: Partial<FontalloyConfig>;
  }
}

function githubBootstrapUrl(): string {
  return `https://github.com/${CATALOG_REPO}/releases/download/${CATALOG_TAG}/catalog-release.json`;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function readConfig(): FontalloyConfig {
  const injected =
    typeof window !== "undefined" ? window.__FONTALLOY_CONFIG__ : undefined;
  const bootstrap =
    injected?.catalogBootstrapUrl !== undefined
      ? injected.catalogBootstrapUrl
      : isTauri()
        ? githubBootstrapUrl()
        : null;
  return { catalogBootstrapUrl: bootstrap ?? null };
}
