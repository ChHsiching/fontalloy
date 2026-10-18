import { store, type LoadedFont } from "../state";

/**
 * The user-facing name of a registered font (round 9, owner item 2):
 * the name-table strings the SERVE's scan read, verbatim — never a
 * curated or constructed display name. The record's own `names.display`
 * (built from the document's identity fields) is what every surface
 * reads, falling back to the metadata family.
 */
export function fontDisplayName(font: LoadedFont): string {
  return font.names?.display ?? font.family;
}

/** One catalog/local/system face to register by URL: href + its slot. */
export interface CatalogFaceUrl {
  /** The serve's absolute face URL (streamed bytes, cache headers). */
  url: string;
  /** The face's OS/2 weight, as the family document reports it. */
  weight: number;
  style: "normal" | "italic";
}

/**
 * Register a family's faces as URL FontFaces (ticket #32, the MEMORY
 * RED LINE): one FontFace per (weight, style) slot winner, each
 * carrying its descriptor and a `url(...)` source — the page holds NO
 * bytes; the browser fetches a face only when something actually
 * renders in that weight/style (lazy per used descriptor). Nothing is
 * awaited: load errors surface at use time, exactly like the preview
 * subsets' own lazy faces. This is the ONLY FontFace construction left
 * in the frontend (ticket #36: the byte fallback died with the upload
 * endpoint; the conformance guard pins a zero non-URL budget).
 *
 * The eviction counterpart is {@link evictCssFamily}.
 */
export function registerCatalogUrlFaces(
  cssFamily: string,
  faces: readonly CatalogFaceUrl[],
): void {
  for (const face of faces) {
    document.fonts.add(
      new FontFace(cssFamily, `url(${JSON.stringify(face.url)})`, {
        weight: String(face.weight),
        style: face.style,
      }),
    );
  }
}

/**
 * The css family name as the FontFace API reports it. A URL-source
 * FontFace's ``family`` is re-serialized through the CSS grammar — a
 * spaced family like ``Alloy Wide`` reads back as ``"Alloy Wide"``
 * WITH quotes, so every family-keyed comparison normalizes the quotes
 * away first.
 */
function reportedFamily(face: FontFace): string {
  const name = face.family;
  return name.length > 1 && name.startsWith('"') && name.endsWith('"')
    ? name.slice(1, -1)
    : name;
}

/**
 * Evict one css family's registration (ticket #32): every face of the
 * family comes off document.fonts — the browser releases the native
 * font data behind them — and the store's records for the family drop,
 * so a re-pick re-registers from scratch. Repeat-click unload keeps
 * working across the whole cycle.
 *
 * Scoped to one css family key; a catalog family's key is its manifest
 * id, so a same-named LOCAL load colliding with it (a family whose
 * manifest id equals its name-table family) is evicted with it — the
 * acceptable edge, re-loadable from either side.
 */
export function evictCssFamily(cssFamily: string): void {
  for (const face of [...document.fonts]) {
    if (reportedFamily(face) === cssFamily) document.fonts.delete(face);
  }
  const before = store.get().fonts;
  const after = before.filter((font) => font.cssFamily !== cssFamily);
  if (after.length !== before.length) store.set({ fonts: after });
}
