/**
 * The environment adapter: one shared frontend source, two build targets.
 *
 * The same `src/` tree compiles into the Tauri GUI (gui/index.html +
 * src-tauri) and the static WebApp (web/index.html). Everything outside
 * this directory must stay environment-agnostic: no `window.__TAURI__`
 * probes, no web-only API assumptions. Capabilities that differ per
 * target (local-file access, the serve probe, the sidecar) are decided
 * here so feature code asks, never sniffs.
 */

export type FrontendTarget = "tauri" | "web";

/** The Tauri shell injects this global before any frontend module runs. */
declare global {
  // eslint-disable-next-line no-var
  var __TAURI_INTERNALS__: unknown;
}

export function detectTarget(): FrontendTarget {
  return typeof globalThis !== "undefined" &&
    "__TAURI_INTERNALS__" in globalThis
    ? "tauri"
    : "web";
}

/** The target this bundle runs in (fixed at load). */
export const target: FrontendTarget = detectTarget();

export interface PlatformCapabilities {
  /** Local font files can be opened directly (the Tauri dialog). */
  localFilePicker: boolean;
  /** The core runs as a bundled sidecar binary. */
  sidecar: boolean;
}

export function capabilities(t: FrontendTarget = target): PlatformCapabilities {
  return t === "tauri"
    ? { localFilePicker: true, sidecar: true }
    : { localFilePicker: false, sidecar: false };
}
