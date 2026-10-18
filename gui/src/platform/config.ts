/**
 * Runtime configuration for the shared frontend.
 *
 * The frontend runs in two environments (ADR-0002): inside the Tauri shell
 * and as a plain browser page (Vite dev server, the static WebApp build).
 * Ticket #33 deleted the last reader of the classic page-side catalog
 * bootstrap seam (`catalogBootstrapUrl`): the catalog arrives through the
 * serve (`serveUrl` below) and nothing else — the vite dev server's
 * /dev-catalog fixture origin is served to the SERVE, never fetched by
 * the page. The seam-3 Playwright suite drives the app OUTSIDE Tauri by
 * injecting a config object before the app boots:
 *
 * ```ts
 * await page.addInitScript(() => {
 *   window.__FONTALLOY_CONFIG__ = { serveUrl: "http://127.0.0.1:…" };
 * });
 * ```
 *
 * The injectable seams on the object:
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
 * - `readFontPath` — the typed-path resolver (round 20; ticket #34):
 *   resolves a pasted absolute path, FILE or directory, into the font
 *   file PATHS it names — never bytes (the serve's local-font scan
 *   reads the files). Under Tauri the shell's `read_font_path`
 *   command resolves; tests inject a stand-in against real fixture
 *   files on disk. Its presence also unhides the picker's path-input
 *   fallback (Linux without a DBus file manager).
 * - `testFontLoadDelayMs` — test-only pacing for the local-load path
 *   (round 21): every event-loop yield between faces also sleeps this
 *   many milliseconds, so an e2e spec can observe the inline load
 *   indicator and drive the workspace DURING a load, deterministically.
 *   Never set outside tests.
 * - `testFontLoadBudgetMs` — test-only override of the default-slot
 *   font-load abort budget (the r30 lesson applied to FontFace loads):
 *   a URL face's byte fetch rides the BROWSER's loader, not the serve
 *   client, so an endpoint that accepts the connection and never
 *   answers would park `document.fonts.load` (and with it
 *   `document.fonts.ready`) forever. The budget makes every pick's
 *   default-slot load fail loudly instead. Never set outside tests.
 */

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

/** What a typed path resolved to (round 20; ticket #34: paths only). */
export interface FontPathRead {
  /** True when the path named a directory (every font file inside). */
  isDirectory: boolean;
  /** The absolute font file paths the path named — never bytes. */
  paths: string[];
}

/**
 * The typed-path resolver (round 20; ticket #34): a font FILE resolves
 * to itself; a DIRECTORY resolves to the font files it holds (the same
 * suffix sweep the shell's dialog filters on). The resolution carries
 * PATHS ONLY — the bytes live behind the serve's local-font scan, so
 * nothing readable ever crosses this seam. Throws with a user-readable
 * reason when the path does not exist or cannot be read.
 */
export type FontPathReader = (path: string) => Promise<FontPathRead>;

export interface FontalloyConfig {
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
  /**
   * Test-only override of the default-slot font-load abort budget —
   * see {@link FONT_LOAD_BUDGET_MS} in fonts/registry. Never set by
   * the app itself.
   */
  testFontLoadBudgetMs?: number;
}

declare global {
  interface Window {
    __FONTALLOY_CONFIG__?: Partial<FontalloyConfig>;
  }
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
  return {
    serveUrl: injected?.serveUrl,
    saveArtifact: injected?.saveArtifact,
    saveArtifactAs: injected?.saveArtifactAs,
    probeArtifact: injected?.probeArtifact,
    readFontPath: injected?.readFontPath,
    testFontLoadDelayMs: injected?.testFontLoadDelayMs,
    testFontLoadBudgetMs: injected?.testFontLoadBudgetMs,
  };
}
