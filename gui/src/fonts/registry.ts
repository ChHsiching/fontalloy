import { store, type LoadedFont } from "../state";
import { readConfig } from "../platform/config";
import { cssFamily } from "../kit/pickerPopup";

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

/**
 * The abort budget for a pick's default-slot font load (the round-30
 * hung-fetch lesson, applied to the one await the serve client cannot
 * reach): a URL-source FontFace's byte fetch rides the BROWSER's font
 * loader, not {@link ServeClient} — an endpoint that accepts the
 * connection and never answers leaves the face in ``loading`` forever,
 * parking `document.fonts.load` AND `document.fonts.ready` with it at
 * zero CPU (the J11.3 wedge, ticket #37 / spec #25). Every pick's
 * default-slot load runs under this budget: a service that cannot
 * deliver the face within it reads as a failed load, the family's
 * registration is evicted (a stuck-loading face must come OFF
 * document.fonts, or the set's ready promise stays parked for the rest
 * of the page's life), and the caller surfaces the error loudly.
 */
export const FONT_LOAD_BUDGET_MS = 30_000;

/**
 * The default-slot load's budget expired: the face's byte fetch never
 * settled within {@link FONT_LOAD_BUDGET_MS} and the family's
 * registration was evicted with it. Consumers treat it as a failed
 * load (their existing error surfaces state it); the local-load flow
 * additionally drops its representative pick, since the family it
 * would select no longer exists.
 */
export class FontLoadBudgetError extends Error {}

/**
 * Load one registered css family's default slot within
 * {@link FONT_LOAD_BUDGET_MS} (the spec the pick paths use:
 * ``16px <family>``). Resolves when the face renders; on budget expiry
 * the family's faces are evicted and the rejection carries the
 * timeout, so the caller's existing error handling (the picker's error
 * line, the outcome card) states it — the flow fails loudly instead of
 * hanging. A genuine load REJECTION (corrupt bytes, a 404) passes
 * through untouched: only the never-settling fetch warrants eviction.
 * The config seam `testFontLoadBudgetMs` overrides the budget for the
 * e2e regression specs only.
 */
export async function loadDefaultSlotWithBudget(cssKey: string): Promise<void> {
  const budgetMs = readConfig().testFontLoadBudgetMs ?? FONT_LOAD_BUDGET_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      document.fonts.load(`16px ${cssFamily(cssKey)}`),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new FontLoadBudgetError(
                `字体载入超时（${Math.round(budgetMs / 1000)} 秒内服务未返回字体数据）。`,
              ),
            ),
          budgetMs,
        );
      }),
    ]);
  } catch (err) {
    if (err instanceof FontLoadBudgetError) {
      // The stuck face must leave the set: a loading FontFace parked
      // on document.fonts keeps the set's ready promise pending
      // forever — the very wedge this budget exists to end.
      evictCssFamily(cssKey);
    }
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
