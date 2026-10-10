import { parseFontMeta } from "./sfnt";
import { store, type LoadedFont } from "../state";

export interface LoadResult {
  font: LoadedFont;
  /** True when this family was not present before. */
  isNewFamily: boolean;
}

/**
 * The local font loading path (ticket #15): read the file bytes, parse the
 * sfnt metadata (family name, cmap coverage), register the face through
 * FontFace(arrayBuffer) on document.fonts, and record it in the store.
 */
export async function loadLocalFontFile(file: File): Promise<LoadResult> {
  const buffer = await file.arrayBuffer();
  const meta = parseFontMeta(buffer);

  const cssFamily = meta.family;
  const face = new FontFace(cssFamily, buffer);
  await face.load();
  document.fonts.add(face);

  const font: LoadedFont = {
    cssFamily,
    family: meta.family,
    fileName: file.name,
    codepoints: meta.codepoints,
  };

  const state = store.get();
  const isNewFamily = !state.fonts.some((f) => f.cssFamily === cssFamily);
  store.set({ fonts: [...state.fonts, font] });
  return { font, isNewFamily };
}
