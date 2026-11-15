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
  /**
   * Built fonts land in a configurable output directory (round 12):
   * the 设置 entry 输出目录 exists and saves need no dialog. True only
   * where the shell really speaks the command bridge the row's
   * commands (`default_output_dir`, `pick_output_dir`) ride on — see
   * `shellHasInvokeBridge`. The plain browser keeps its own download
   * flow (the browser manages where downloads go), and so does a
   * marker-only stub without the bridge (the dev browser's test
   * fakes): neither ever renders the entry — the inventory's "dev
   * never renders" behavior. The probe is frozen at load, so the
   * answer cannot flap between mounts or captured frames.
   */
  outputDirPicker: boolean;
}

/**
 * Whether the shell behind the marker exposes the command bridge
 * (`__TAURI_INTERNALS__.invoke`) every shell command rides on; the
 * real Tauri v2 injection always defines it, while the dev browser's
 * marker-only stubs (a bare `{}`) do not. Evaluated ONCE at load,
 * beside `target`: the fact is fixed for the whole load, so the
 * outputDirPicker capability below is a stable per-load decision —
 * never a runtime flag that flips between mounts or frames.
 */
const shellHasInvokeBridge: boolean =
  target === "tauri" &&
  typeof (globalThis.__TAURI_INTERNALS__ as { invoke?: unknown } | undefined)
    ?.invoke === "function";

export function capabilities(t: FrontendTarget = target): PlatformCapabilities {
  return t === "tauri"
    ? {
        localFilePicker: true,
        sidecar: true,
        // Frozen at load (shellHasInvokeBridge): the row renders where
        // the shell can honor it, and nowhere else — deterministically.
        outputDirPicker: shellHasInvokeBridge,
      }
    : { localFilePicker: false, sidecar: false, outputDirPicker: false };
}
