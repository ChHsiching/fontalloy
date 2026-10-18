/**
 * Local font picking (issue #16; ticket #34: the path+URL model).
 * This module is now a THIN path source — it never touches font
 * bytes:
 *
 * - under Tauri the native file dialog (`pick_font_files`) returns
 *   REAL absolute paths — exactly what a recipe needs to name the
 *   file — and those paths are handed to the serve's local-font scan
 *   (POST /local-fonts), whose family documents drive the same URL
 *   FontFace registration the catalog pick path uses;
 * - the typed absolute path entry point (round 20, file or directory
 *   — `readFontPathInput`) resolves through the same-shaped seam,
 *   PATHS ONLY: the shell's `read_font_path` command, or the config
 *   bootstrap's test stand-in. The bytes live behind the serve.
 *
 * The retired raw IPC byte pipe (`read_font_file`) and the sibling
 * directory lister (`list_font_dir`) are gone from the shell; the
 * plain browser keeps its HTML file input (bytes only, no path — the
 * one remaining page-side byte flow, narrowed by ticket #34 to the
 * browser fallback). Window drag-and-drop (round 20) was removed in
 * round 23: the pickers are the app's only load entry points.
 */

import { readConfig, type FontPathRead } from "./config";

/** True when this environment has the native dialog commands. */
export function canPickWithDialog(): boolean {
  return (
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
  );
}

/**
 * Open the native multi-select font dialog. Returns the picked
 * absolute PATHS (no bytes — the serve scans the files); an empty
 * list when the user canceled; null when a dialog could not be opened
 * at all.
 */
export async function pickLocalFonts(): Promise<string[] | null> {
  const { invoke } = await import("@tauri-apps/api/core");
  const paths = (await invoke<string[] | null>("pick_font_files")) as
    | string[]
    | null;
  if (paths === null || paths.length === 0) return paths === null ? null : [];
  return paths;
}

/**
 * Resolve a typed/pasted absolute font path (round 20): a font file
 * is itself; a DIRECTORY is the font files it holds (the same suffix
 * sweep the dialog filters on). The config seam wins when injected
 * (tests stand it in over real fixture files); the Tauri
 * `read_font_path` command resolves otherwise. The answer carries
 * PATHS ONLY. Throws with a plain reason when the path does not exist
 * or cannot be read — the picker renders it on its error line.
 */
export async function readFontPathInput(path: string): Promise<FontPathRead> {
  const seam = readConfig().readFontPath;
  if (seam !== undefined) return seam(path);
  const { invoke } = await import("@tauri-apps/api/core");
  return (await invoke<{ isDirectory: boolean; paths: string[] }>(
    "read_font_path",
    { path },
  )) as { isDirectory: boolean; paths: string[] };
}
