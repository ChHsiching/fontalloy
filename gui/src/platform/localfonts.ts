/**
 * Local font picking (issue #16): under Tauri the native file dialog
 * returns REAL absolute paths — exactly what a recipe needs to name the
 * file — and the bytes travel the raw IPC pipe (`read_font_file`), so
 * no fs-scope widening beyond the catalog is required. The plain
 * browser keeps the HTML file input (bytes only, no path — the
 * synthesize flow then resolves the path against the service listing).
 */

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
    // The raw IPC response arrives as an ArrayBuffer — no JSON encoding
    // of font bytes (the documented fast path for binary payloads).
    const buffer = (await invoke("read_font_file", { path })) as ArrayBuffer;
    const parts = path.replace(/\\/g, "/").split("/");
    picked.push({ fileName: parts[parts.length - 1] ?? path, buffer, path });
  }
  return picked;
}
