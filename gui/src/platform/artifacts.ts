/**
 * The artifact saver (issue #16): hands a built font to the platform.
 *
 * Three backends, in priority order:
 * 1. An injected saver (`window.__FONTALLOY_CONFIG__.saveArtifact`) — the
 *    Playwright suite routes this through `page.exposeFunction` so the
 *    saved file lands on real disk where the test can parse it.
 * 2. Tauri: `prepare_save` runs the NATIVE save dialog (dialog plugin,
 *    Rust side) and parks the chosen path; the bytes then travel the raw
 *    IPC pipe to `save_artifact` — no JSON serialization of a multi-MB
 *    font, no fs-scope widening beyond the catalog.
 * 3. Plain browser: an anchor download (the browser's own save flow) —
 *    dev usability; the desktop path never reaches it.
 */

import {
  isTauri,
  readConfig,
  type ArtifactSaveResult,
} from "./config";

export type { ArtifactSaveResult };

async function tauriSave(
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

/** Save one built artifact through the platform's save flow. */
export async function saveArtifact(
  suggestedName: string,
  bytes: Uint8Array,
): Promise<ArtifactSaveResult> {
  const injected = readConfig().saveArtifact;
  if (injected !== undefined) return injected(suggestedName, bytes);
  if (isTauri()) return tauriSave(suggestedName, bytes);
  return browserSave(suggestedName, bytes);
}
