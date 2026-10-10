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
 *
 * Issue #16 adds two more injectable seams on the same object:
 * - `serveUrl` — where the merge service answers (`http://127.0.0.1:<port>`).
 *   Under Tauri the shell's sidecar resolves it (the `serve_url` command);
 *   in tests the bootstrap injects the address of the REAL `fontalloy
 *   serve` subprocess it spawned. Unset + not Tauri = no service, no probe
 *   (a refused probe would log a console error; the default page stays
 *   silent).
 * - `saveArtifact` — the artifact saver the synthesize flow hands the
 *   built font to. Under Tauri it is the native save dialog + a raw IPC
 *   write; tests inject a stand-in through `page.exposeFunction`.
 */

/** GitHub Releases tag carrying the consolidated catalog (ADR-0005, #14). */
export const CATALOG_TAG = "font-catalog-v1";
export const CATALOG_REPO = "ChHsiching/fontalloy";

/** The result of handing a built font to the platform saver. */
export interface ArtifactSaveResult {
  saved: boolean;
  /** Where the bytes landed (null when canceled or not saved). */
  path: string | null;
}

/**
 * Saves one built artifact. `bytes` is the font file exactly as the
 * service produced it; `suggestedName` is e.g. `ChHsich.ttf`.
 */
export type ArtifactSaver = (
  suggestedName: string,
  bytes: Uint8Array,
) => Promise<ArtifactSaveResult>;

export interface FontalloyConfig {
  /**
   * Where `catalog-release.json` is fetched from on every launch. `null`
   * disables the catalog entirely (plain-browser default).
   */
  catalogBootstrapUrl: string | null;
  /**
   * The merge service address. `undefined` = not injected (the Tauri
   * shell resolves it); `null` = explicitly disabled.
   */
  serveUrl?: string | null;
  /** The artifact saver (injected by tests; Tauri default otherwise). */
  saveArtifact?: ArtifactSaver;
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
  return {
    catalogBootstrapUrl: bootstrap ?? null,
    serveUrl: injected?.serveUrl,
    saveArtifact: injected?.saveArtifact,
  };
}
