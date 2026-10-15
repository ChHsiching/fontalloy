/**
 * Local font picking (issue #16): under Tauri the native file dialog
 * returns REAL absolute paths — exactly what a recipe needs to name the
 * file — and the bytes travel the raw IPC pipe (`read_font_file`), so
 * no fs-scope widening beyond the catalog is required. The plain
 * browser keeps the HTML file input (bytes only, no path — the
 * synthesize flow then resolves the path against the service listing).
 *
 * Round 20 added the TYPED absolute path entry point (file or
 * directory — `readFontPathInput`) for environments the native dialog
 * cannot serve (Linux without a DBus file manager). Window drag-and-
 * drop (round 20) was removed in round 23: the pickers are the app's
 * only load entry points.
 */

import { readConfig, type FontPathRead } from "./config";

export interface PickedFont {
  fileName: string;
  buffer: ArrayBuffer;
  /** The absolute path (always set on the Tauri path). */
  path: string;
}

/** True when this environment has the native dialog commands. */
export function canPickWithDialog(): boolean {
  return (
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
  );
}

/**
 * Open the native multi-select font dialog and read every picked file.
 * Returns an empty list when the user canceled; null when a dialog
 * could not be opened at all.
 */
export async function pickLocalFonts(): Promise<PickedFont[] | null> {
  const { invoke } = await import("@tauri-apps/api/core");
  const paths = (await invoke<string[] | null>("pick_font_files")) as
    | string[]
    | null;
  if (paths === null || paths.length === 0) return paths === null ? null : [];

  const picked: PickedFont[] = [];
  for (const path of paths) {
    picked.push({
      ...(await readPickedFont(path)),
    });
  }
  return picked;
}

/**
 * Read one on-disk font file (the raw IPC pipe — no JSON encoding of
 * font bytes). Shared by the dialog flow and the local family
 * discovery sweep (round 13: a picked file's same-directory siblings).
 */
export async function readPickedFont(path: string): Promise<PickedFont> {
  const { invoke } = await import("@tauri-apps/api/core");
  // The raw IPC response arrives as an ArrayBuffer — no JSON encoding
  // of font bytes (the documented fast path for binary payloads).
  const buffer = (await invoke("read_font_file", { path })) as ArrayBuffer;
  const parts = path.replace(/\\/g, "/").split("/");
  return { fileName: parts[parts.length - 1] ?? path, buffer, path };
}

/**
 * Read the font files a typed/pasted absolute path names (round 20):
 * a font file is itself; a DIRECTORY is the font files it holds (the
 * same suffix sweep the sibling scan uses). The config seam wins when
 * injected (tests stand it in over real fixture files); the Tauri
 * `read_font_path` command resolves otherwise, and the bytes travel
 * the same raw pipe the dialog flow uses. Throws with a plain reason
 * when the path does not exist or cannot be read — the picker renders
 * it on its error line.
 */
export async function readFontPathInput(path: string): Promise<FontPathRead> {
  const seam = readConfig().readFontPath;
  if (seam !== undefined) return seam(path);
  const { invoke } = await import("@tauri-apps/api/core");
  const resolution = (await invoke<{ isDirectory: boolean; paths: string[] }>(
    "read_font_path",
    { path },
  )) as { isDirectory: boolean; paths: string[] };
  const files = await Promise.all(resolution.paths.map(readPickedFont));
  return { isDirectory: resolution.isDirectory, files };
}

/**
 * List the font files of a picked file's directory (round 13, owner
 * item 7): the shell scans the parent of a file the user explicitly
 * picked, filtered to the font suffixes, so the workspace can discover
 * the picked family's sibling faces. Returns null outside Tauri (the
 * plain browser has no directory access — discovery then runs against
 * the service's /fonts index) and when the listing fails (the sweep
 * degrades to a single-face pick).
 */
export async function listFontDirectory(path: string): Promise<string[] | null> {
  if (!canPickWithDialog()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke<string[] | null>("list_font_dir", { path })) as
      | string[]
      | null;
  } catch {
    return null;
  }
}
