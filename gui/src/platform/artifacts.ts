/**
 * The artifact saver (issue #16, round 12): hands a built font to the
 * platform.
 *
 * Round 12 (owner-ratified direction) splits saving into two flows:
 *
 * - **The default-path save (`saveArtifact`)** — what synthesis uses.
 *   The font writes straight into the CONFIGURED output directory (the
 *   设置 entry 输出目录; default `<OS Downloads>/fontalloy`, resolved
 *   by the Rust shell) with NO dialog anywhere in the path. The
 *   completion line shows the full path; a dialog is never a
 *   dependency of saving.
 * - **The 另存为 save (`saveArtifactAs`)** — the explicit export: the
 *   NATIVE save dialog (`prepare_save`, Rust side) picks a path and
 *   the bytes travel the raw IPC pipe to `save_artifact` — no JSON
 *   serialization of a multi-MB font, no fs-scope widening beyond the
 *   catalog. When the dialog is unavailable or errors (headless
 *   Linux, a broken dialog backend) the CALLER falls back to the
 *   default path with a plain notice (see synthesize.ts).
 *
 * Backends, in priority order:
 * 1. An injected saver (`window.__FONTALLOY_CONFIG__.saveArtifact` /
 *    `saveArtifactAs`) — the Playwright suites route these through
 *    `page.exposeFunction` so the saved file lands on real disk where
 *    the test can parse it.
 * 2. Tauri: the commands above.
 * 3. Plain browser: an anchor download (the browser's own save flow) —
 *    both flows map onto it here; the browser manages where downloads
 *    land, so the 输出目录 setting does not render on this target.
 */

import {
  isTauri,
  readConfig,
  type ArtifactProbe,
  type ArtifactSaveResult,
} from "./config";

export type { ArtifactProbe, ArtifactSaveResult };

/* ---------------- output directory (the 设置 entry 输出目录) ------------- */

/** The localStorage key holding the user's output-directory override. */
export const OUTPUT_DIR_KEY = "fontalloy.outputDir";

/** The persisted override, when the user changed the output directory. */
export function configuredOutputDir(): string | null {
  try {
    const value = localStorage.getItem(OUTPUT_DIR_KEY);
    return value !== null && value.trim() !== "" ? value : null;
  } catch {
    // Storage unavailable (privacy mode): behave as if never configured.
    return null;
  }
}

/** Persist (or, with null, clear) the output-directory override. */
export function setConfiguredOutputDir(dir: string | null): void {
  try {
    if (dir === null) localStorage.removeItem(OUTPUT_DIR_KEY);
    else localStorage.setItem(OUTPUT_DIR_KEY, dir);
  } catch {
    // A failed persist degrades to the default directory next launch.
  }
}

/**
 * The directory the default-path save writes into, RIGHT NOW: the
 * persisted override when one is set, else the shell's default
 * (`<OS Downloads>/fontalloy`, created on demand — see
 * `default_output_dir` in the Rust shell). Tauri only; the web target
 * never asks (its save is the browser download).
 */
export async function resolveOutputDir(): Promise<string> {
  const override = configuredOutputDir();
  if (override !== null) return override;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("default_output_dir");
}

/**
 * Open the native directory picker for the 输出目录 setting.
 * The chosen directory (null when canceled); throws when no dialog
 * could be opened at all.
 */
export async function pickOutputDir(): Promise<string | null> {
  const { invoke } = await import("@tauri-apps/api/core");
  return (await invoke<string | null>("pick_output_dir")) as string | null;
}

/* ---------------- the savers ---------------- */

/**
 * The same-name collision pre-flight (round 17, owner item 3): does a
 * file already sit at the default-path save target this name resolves
 * to? Runs BEFORE any write — the caller asks the user when it fires,
 * never silently overwriting or suffixing. Backends mirror the savers:
 * the injected prober (tests, against a real save directory), the
 * Tauri `artifact_exists` command (which joins the configured output
 * dir and stats the target), and — on the plain web target — always
 * "no": the browser's own download manager renames on its own, so
 * there is no collision for the app to ask about.
 */
export async function probeArtifact(
  suggestedName: string,
): Promise<ArtifactProbe> {
  const injected = readConfig().probeArtifact;
  if (injected !== undefined) return injected(suggestedName);
  if (isTauri()) {
    const dir = await resolveOutputDir();
    const { invoke } = await import("@tauri-apps/api/core");
    const [exists, path] = await invoke<[boolean, string]>(
      "artifact_exists",
      { dir, name: suggestedName },
    );
    return { exists, path };
  }
  return { exists: false, path: suggestedName };
}

async function tauriSaveToDefault(
  suggestedName: string,
  bytes: Uint8Array,
): Promise<ArtifactSaveResult> {
  const dir = await resolveOutputDir();
  const { invoke } = await import("@tauri-apps/api/core");
  // Park the joined default-dir path (no dialog), then stream the
  // bytes to it through the raw IPC pipe.
  const path = await invoke<string>("park_save_path", {
    dir,
    name: suggestedName,
  });
  await invoke("save_artifact", bytes);
  return { saved: true, path };
}

async function tauriSaveWithDialog(
  suggestedName: string,
  bytes: Uint8Array,
): Promise<ArtifactSaveResult> {
  const { invoke } = await import("@tauri-apps/api/core");
  const path = (await invoke<string | null>("prepare_save", {
    defaultName: suggestedName,
  })) as string | null;
  if (path === null) return { saved: false, path: null };
  await invoke("save_artifact", bytes);
  return { saved: true, path };
}

function browserSave(
  suggestedName: string,
  bytes: Uint8Array,
): ArtifactSaveResult {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy.buffer], { type: "font/ttf" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = suggestedName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return { saved: true, path: suggestedName };
}

/**
 * Save one built artifact through the platform's DEFAULT-PATH flow —
 * the configured output directory, never a dialog.
 */
export async function saveArtifact(
  suggestedName: string,
  bytes: Uint8Array,
): Promise<ArtifactSaveResult> {
  const injected = readConfig().saveArtifact;
  if (injected !== undefined) return injected(suggestedName, bytes);
  if (isTauri()) return tauriSaveToDefault(suggestedName, bytes);
  return browserSave(suggestedName, bytes);
}

/**
 * Save one built artifact through the EXPLICIT 另存为 flow — the
 * native save dialog. A canceled dialog resolves `{saved: false}`;
 * a dialog that cannot open REJECTS (the caller falls back to the
 * default path with a plain notice).
 */
export async function saveArtifactAs(
  suggestedName: string,
  bytes: Uint8Array,
): Promise<ArtifactSaveResult> {
  const injected = readConfig().saveArtifactAs;
  if (injected !== undefined) return injected(suggestedName, bytes);
  if (isTauri()) return tauriSaveWithDialog(suggestedName, bytes);
  // The browser's own save flow (a second download of the same bytes;
  // whether the browser prompts is the browser's setting, not ours).
  return browserSave(suggestedName, bytes);
}
