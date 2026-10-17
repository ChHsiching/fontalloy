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
 * Plain-browser PRODUCTION builds deliberately default to NO catalog
 * bootstrap — a deployed page must never start pulling the real ~375 MB
 * catalog from GitHub. The Vite DEV server is the one exception: it
 * serves a small fixture catalog itself (host fonts), so `npm run dev`
 * boots a working catalog; the e2e web server opts out via
 * VITE_DEV_CATALOG=0. `tauri dev` loads the frontend from that same
 * dev server, so it boots the real dev catalog too (round 4) — only a
 * PRODUCTION Tauri build (or an explicit injected config) turns the
 * real GitHub downloader on.
 *
 * Issue #16 adds two more injectable seams on the same object:
 * - `serveUrl` — where the merge service answers (`http://127.0.0.1:<port>`).
 *   Under Tauri the shell's sidecar resolves it (the `serve_url` command);
 *   in tests the bootstrap injects the address of the REAL `fontalloy
 *   serve` subprocess it spawned. Unset + the plain web target = the
 *   #22 detection probe (`?serve=`, default port 7777) — a refused
 *   connection is a handled state, and the browser's own console line
 *   for the refused probe is declared benign by the e2e gates. Explicit
 *   `null` disables the service entirely (no probe, status "none").
 * - `saveArtifact` — the DEFAULT-PATH saver the synthesize flow hands the
 *   built font to (round 12: saving writes straight to the configured
 *   output directory, no dialog). Under Tauri it parks the joined
 *   default-dir path and streams the bytes over the raw IPC pipe; tests
 *   inject a stand-in through `page.exposeFunction`.
 * - `saveArtifactAs` — the 另存为 saver (the native save dialog). Tests
 *   inject a stand-in to observe that the DEFAULT flow never touches it
 *   (the no-dialog contract) and to drive the dialog-unavailable
 *   fallback.
 * - `readFontPath` — the typed-path loader (round 20): resolves a
 *   pasted absolute path, FILE or directory, into the font files it
 *   names. Under Tauri the shell's `read_font_path` command resolves
 *   and the bytes travel the raw pipe; tests inject a stand-in against
 *   real fixture files on disk. Its presence also unhides the picker's
 *   path-input fallback (Linux without a DBus file manager).
 * - `testFontLoadDelayMs` — test-only pacing for the local-load path
 *   (round 21): every event-loop yield between faces also sleeps this
 *   many milliseconds, so an e2e spec can observe the inline load
 *   indicator and drive the workspace DURING a load, deterministically.
 *   Never set outside tests.
 */

/** GitHub Releases tag carrying the consolidated catalog (ADR-0005, #14). */
export const CATALOG_TAG = "font-catalog-v1";
export const CATALOG_REPO = "ChHsiching/fontalloy";

/**
 * The dev-server REAL catalog (see gui/scripts/dev-catalog.mjs): the
 * repo manifest's families zipped from a local fonts directory, served
 * by vite (dev AND preview) at this path so a plain `npm run dev` and
 * the built WebApp under `vite preview` boot the real catalog — picker
 * rows with real meta, real glyph rendering. Opt out with
 * VITE_DEV_CATALOG=0 — the gui e2e suite's web server does, keeping its
 * pages catalog-free unless a test injects its own origin.
 */
export const DEV_CATALOG_URL = "/dev-catalog/catalog-release.json";

/**
 * Ticket #30: the RELEASE-DOCUMENT ORIGINS the Tauri sidecar hands the
 * serve (`--catalog-release-origin`, the base the serve's catalog sync
 * fetches `catalog-release.json` and the family zips from). Dev builds
 * point at the vite dev server's own /dev-catalog (same origin the
 * classic page-side bootstrap used); a production build points at the
 * GitHub Releases tag the classic flow encoded here all along. The
 * Rust shell duplicates these two constants verbatim (gui/src-tauri/
 * src/lib.rs) — the shell spawns the sidecar before any webview code
 * can run, so they cannot be shared at runtime.
 */
export const DEV_CATALOG_ORIGIN_PATH = "/dev-catalog";
/** The vite dev server's port (`tauri dev` loads the webview from it). */
export const DEV_SERVER_PORT = "5173";

/** The dev-stack catalog origin (tag constant, dev-server flavored). */
export function devCatalogOrigin(port: string = DEV_SERVER_PORT): string {
  return `http://localhost:${port}${DEV_CATALOG_ORIGIN_PATH}`;
}

/** The production catalog origin: the GitHub Releases tag's directory. */
export const CATALOG_RELEASE_ORIGIN = `https://github.com/${CATALOG_REPO}/releases/download/${CATALOG_TAG}`;

/** The result of handing a built font to the platform saver. */
export interface ArtifactSaveResult {
  saved: boolean;
  /** Where the bytes landed (null when canceled or not saved). */
  path: string | null;
  /**
   * A plain-Chinese notice shown beside the saved line (round 12: the
   * 另存为 fallback to the default directory explains itself here).
   */
  notice?: string;
}

/**
 * The pre-flight existence check on the default-path save target
 * (round 17, owner item 3): does a file already sit where this save
 * would land, and where exactly is that? The answer drives the
 * same-name collision prompt — never a silent overwrite.
 */
export interface ArtifactProbe {
  /** True when the resolved target already holds a file. */
  exists: boolean;
  /** The resolved target path (display copy for the collision card). */
  path: string;
}

/** Answers the pre-flight question for one suggested artifact name. */
export type ArtifactProber = (suggestedName: string) => Promise<ArtifactProbe>;

/**
 * Saves one built artifact. `bytes` is the font file exactly as the
 * service produced it; `suggestedName` is e.g. `ChHsich.ttf`.
 */
export type ArtifactSaver = (
  suggestedName: string,
  bytes: Uint8Array,
) => Promise<ArtifactSaveResult>;

/** One font file a typed path resolved to (round 20). */
export interface FontPathFile {
  fileName: string;
  buffer: ArrayBuffer;
  /** The absolute path (always set on the Tauri path). */
  path: string;
}

/** What a typed path resolved to (round 20). */
export interface FontPathRead {
  /** True when the path named a directory (every font file inside). */
  isDirectory: boolean;
  files: FontPathFile[];
}

/**
 * The typed-path resolver (round 20): a font FILE resolves to itself; a
 * DIRECTORY resolves to the font files it holds (the same suffix sweep
 * the sibling scan uses). Throws with a user-readable reason when the
 * path does not exist or cannot be read.
 */
export type FontPathReader = (path: string) => Promise<FontPathRead>;

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
  /** The default-path saver (injected by tests; Tauri default otherwise). */
  saveArtifact?: ArtifactSaver;
  /** The 另存为 dialog saver (injected by tests; Tauri dialog otherwise). */
  saveArtifactAs?: ArtifactSaver;
  /**
   * The collision pre-flight (round 17): injected by tests against a
   * real save directory; the Tauri `artifact_exists` command otherwise.
   */
  probeArtifact?: ArtifactProber;
  /**
   * The typed-path resolver (round 20): injected by tests against real
   * fixture files; the Tauri `read_font_path` command otherwise.
   */
  readFontPath?: FontPathReader;
  /**
   * Test-only per-face pacing for the local-load path (round 21):
   * every yield between faces also sleeps this long. Never set by the
   * app itself.
   */
  testFontLoadDelayMs?: number;
}

declare global {
  interface Window {
    __FONTALLOY_CONFIG__?: Partial<FontalloyConfig>;
  }
}

function githubBootstrapUrl(): string {
  return `${CATALOG_RELEASE_ORIGIN}/catalog-release.json`;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * The web target's default serve probe address (issue #22): the `?serve=`
 * query parameter — restricted to loopback http origins — or, without
 * it, the well-known port `fontalloy serve --port 7777` listens on. The
 * Tauri shell never uses this (its sidecar resolves the real address).
 */
export const DEFAULT_SERVE_ADDRESS = "http://127.0.0.1:7777";

/** The `?serve=` parameter, validated to a loopback http origin. */
export function serveProbeAddress(): string {
  const raw =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("serve")
      : null;
  if (raw !== null && raw.trim() !== "") {
    try {
      const url = new URL(raw);
      const loopback =
        url.hostname === "127.0.0.1" || url.hostname === "localhost";
      if (url.protocol === "http:" && loopback) {
        return url.origin;
      }
    } catch {
      // An unparseable value falls through to the default probe target.
    }
  }
  return DEFAULT_SERVE_ADDRESS;
}

export function readConfig(): FontalloyConfig {
  const injected =
    typeof window !== "undefined" ? window.__FONTALLOY_CONFIG__ : undefined;
  const devCatalog =
    import.meta.env.DEV && import.meta.env.VITE_DEV_CATALOG !== "0";
  const devDefault = devCatalog ? DEV_CATALOG_URL : null;
  // The static WebApp build (web/) ships the same dev-catalog bootstrap:
  // its vite config defines VITE_WEB_CATALOG=1 so `vite preview` of the
  // built site boots the real catalog too. Other plain-browser builds
  // (a gui dist opened outside Tauri) deliberately default to NONE.
  const webStaticDefault =
    import.meta.env.VITE_WEB_CATALOG === "1" ? DEV_CATALOG_URL : null;
  const bootstrap =
    injected?.catalogBootstrapUrl !== undefined
      ? injected.catalogBootstrapUrl
      : isTauri()
        ? // `tauri dev` loads the frontend FROM the vite dev server, so
          // the same-origin dev catalog is exactly what it sees — the
          // app boots with the real 81-family catalog while the GitHub
          // release tag it would otherwise await does not exist yet.
          // A production Tauri build (vite build → frontendDist) is DEV
          // false and keeps the real release flow unchanged.
          (devCatalog
            ? DEV_CATALOG_URL
            : githubBootstrapUrl())
        : (devDefault ?? webStaticDefault);
  return {
    catalogBootstrapUrl: bootstrap ?? null,
    serveUrl: injected?.serveUrl,
    saveArtifact: injected?.saveArtifact,
    saveArtifactAs: injected?.saveArtifactAs,
    probeArtifact: injected?.probeArtifact,
    readFontPath: injected?.readFontPath,
    testFontLoadDelayMs: injected?.testFontLoadDelayMs,
  };
}
