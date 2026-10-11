import { parseFontMeta } from "./sfnt";
import { store, type LoadedFont } from "../state";

export interface LoadResult {
  font: LoadedFont;
  /** True when this family was not present before. */
  isNewFamily: boolean;
}

export interface RegisterOptions {
  /**
   * Display family name. Defaults to the parsed name-table family (local
   * file behavior); the catalog path passes the metadata family so picker
   * rows are metadata-driven.
   */
  family?: string;
  fileName: string;
  origin: "local" | "catalog";
  /**
   * The on-disk path, when the platform knows one (the catalog storage
   * layout; the Tauri file dialog). Recipes reference it verbatim.
   */
  path?: string;
  /**
   * When true the FontFace is added WITHOUT awaiting load(): the browser
   * lazily loads the face the first time something renders in it (the
   * picker self-rendering path for dozens of catalog families). The
   * interactive path (a user picking a font) registers non-lazily.
   */
  lazy?: boolean;
  /**
   * Skip the store patch (the catalog's registration sweep batches its
   * fonts + registered map into one notification; the caller owns the
   * accumulated state).
   */
  silent?: boolean;
}

/**
 * The shared FontFace(arrayBuffer) registration path (ticket #15 for local
 * files, ticket #17 for catalog downloads): parse the sfnt metadata (family
 * name, cmap coverage), register the face on document.fonts, and record it
 * in the store.
 *
 * Registration is idempotent per css family: when the same underlying face
 * is already registered (e.g. a local file that also exists in the
 * catalog), the existing entry is reused and counted once.
 */
export async function registerFontBytes(
  buffer: ArrayBuffer,
  options: RegisterOptions,
): Promise<LoadResult> {
  const meta = parseFontMeta(buffer);

  const state = store.get();
  const existing = state.fonts.find((f) => f.cssFamily === meta.family);
  if (existing) return { font: existing, isNewFamily: false };

  const face = new FontFace(meta.family, buffer);
  if (options.lazy) {
    document.fonts.add(face);
  } else {
    await face.load();
    document.fonts.add(face);
  }

  const font: LoadedFont = {
    cssFamily: meta.family,
    family: options.family ?? meta.family,
    fileName: options.fileName,
    origin: options.origin,
    path: options.path,
    codepoints: meta.codepoints,
  };
  if (!options.silent) {
    store.set({ fonts: [...store.get().fonts, font] });
  }
  return { font, isNewFamily: true };
}

/**
 * The local font loading path: read the file bytes and register them.
 */
export async function loadLocalFontFile(file: File): Promise<LoadResult> {
  const buffer = await file.arrayBuffer();
  return registerFontBytes(buffer, {
    fileName: file.name,
    origin: "local",
  });
}
