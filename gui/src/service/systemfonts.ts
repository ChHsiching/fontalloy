/**
 * System font discovery (round 24, owner item 3; ticket #34: fully on
 * the API path). The service — the desktop sidecar, or any serve with
 * the same endpoints — enumerates the platform's font directories
 * (`/system-fonts`) and now also GROUPS the scan core-side: one family
 * entry per name-table family, representative first (400-upright
 * preferred), with the family's latin/cjk flags riding its faces'
 * ACTUAL coverage (the owner's ruling: 微软雅黑 belongs in both
 * pickers; wanting only its Chinese is a legitimate pick). The
 * frontend consumes the groups — it no longer re-derives the
 * semantics page-side.
 *
 * Enumeration registers NOTHING — the rows are metadata like unfetched
 * catalog rows. A PICK registers the family's faces as URL FontFaces
 * through the serve's `/system-fonts/file` byte source (one per
 * (weight, style) slot, lazy per used descriptor — the same
 * registration the catalog pick path uses; no ArrayBuffer ever enters
 * the page), and unloading the pick evicts them.
 */

import { registerCatalogUrlFaces } from "../fonts/registry";
import { store, type CpIntervals, type LoadedFont } from "../state";
import { patchService, synthStore } from "./state";
import type { ServeClient } from "./client";

/** One face as the serve's `/system-fonts` reports it. */
export interface SystemFaceDoc {
  path: string;
  file: string;
  face: number;
  family: string;
  subfamily: string;
  weight: number;
  italic: boolean;
  latin: boolean;
  cjk: boolean;
  /**
   * The face's coverage as run-length intervals (ticket #36 — the
   * counters' data, computed by the scan that already reads the cmap).
   */
  intervals: number[][];
  /** The serve-relative byte URL (`GET /system-fonts/file?path=&index=`). */
  href: string;
}

/** One installed family, as the serve GROUPED it (ticket #34). */
export interface SystemFontFamily {
  /** The name-table family — the css key a pick registers under. */
  family: string;
  /** Every face of the family, representative first (scan order). */
  faces: SystemFaceDoc[];
  /** The representative (400-upright preferred) the pick leads with. */
  representative: SystemFaceDoc;
  latin: boolean;
  cjk: boolean;
}

/** The raw family entry of the document (the representative embedded). */
export interface SystemFontFamilyDoc {
  family: string;
  latin: boolean;
  cjk: boolean;
  representative: SystemFaceDoc;
  faces: SystemFaceDoc[];
}

/** The fetch runs once per service connection; failures stay silent. */
let requested = false;

/**
 * Ask the service for the installed fonts (background, idempotent).
 *
 * Round 25: the serve scans on a background thread and answers
 * ``ready: false`` until it lands — the first-ever scan of a real
 * machine's font directory takes a while, so this POLLS quietly
 * (2s apart, bounded) instead of holding one request open. Ticket
 * #34: the ready document already GROUPS the scan; the page stores
 * the groups verbatim.
 */
export async function ensureSystemFonts(client: ServeClient): Promise<void> {
  if (requested) return;
  requested = true;
  patchService({ systemFontsPending: true });
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      const doc = await client.systemFonts();
      if (doc.ready) {
        patchService({
          systemFonts: doc.families.map((family) => ({
            family: family.family,
            faces: family.faces,
            representative: family.representative,
            latin: family.latin,
            cjk: family.cjk,
          })),
          systemFontsPending: false,
        });
        return;
      }
    } catch {
      // No enumeration endpoint (older service) — the feature is
      // simply absent; nothing else changes.
      patchService({ systemFontsPending: false });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  // Bounded poll exhausted (the scan never answered ready) — the
  // loading row stands down rather than promising forever.
  patchService({ systemFontsPending: false });
}

/** Reset the once-guard when a new service connects (tests). */
export function resetSystemFontsRequest(): void {
  requested = false;
}

/**
 * The face's display-safe file name: a collection's per-face entries
 * carry the `#N` suffix the synthesize flow strips (the app's own
 * bookkeeping, never part of any path).
 */
function faceFileName(
  face: SystemFaceDoc,
  facesPerPath: number,
): string {
  return facesPerPath > 1 ? `${face.file}#${face.face + 1}` : face.file;
}

/**
 * Load and register one picked system family (ticket #34): one URL
 * FontFace per (weight, style) slot — the document's representative
 * -first order decides among equals — under the family's own
 * name-table name, plus ONE registry record for the representative
 * and data-only records for the other faces (the sibling discipline:
 * names only, no rows of their own). Returns the family's css key —
 * the existing record when an earlier source (catalog, local)
 * already registered the same name-table family under it.
 */
export function registerSystemFamily(
  client: ServeClient,
  family: SystemFontFamily,
): string | null {
  const faces = family.faces;
  if (faces.length === 0) return null;
  const existing = store.get().fonts.find(
    (font) => font.cssFamily === family.family,
  );
  if (existing !== undefined) return existing.cssFamily;

  // One face per (weight, style) slot: the representative-first order
  // means the plainest face wins a contested slot (the same
  // first-winner rule the catalog document's slot picker applies).
  const winners = new Map<string, SystemFaceDoc>();
  for (const face of faces) {
    const key = `${face.weight}/${face.italic ? "italic" : "normal"}`;
    if (!winners.has(key)) winners.set(key, face);
  }
  const kept = [...winners.values()];
  const facesPerPath = faces.filter(
    (face) => face.path === family.representative.path,
  ).length;
  registerCatalogUrlFaces(
    family.family,
    kept.map((face) => ({
      url: `${client.baseUrl}${face.href}`,
      weight: face.weight,
      style: face.italic ? ("italic" as const) : ("normal" as const),
    })),
  );
  const rep = family.representative;
  const record: LoadedFont = {
    cssFamily: family.family,
    family: family.family,
    names: {
      family: family.family,
      display: family.family,
    },
    fileName: faceFileName(rep, facesPerPath),
    origin: "system",
    path: rep.path,
    intervals: rep.intervals as unknown as CpIntervals,
  };
  const siblings: LoadedFont[] = kept
    .filter((face) => face !== rep)
    .map((face) => ({
      cssFamily: family.family,
      family: family.family,
      names: {
        family: face.family,
        display:
          face.subfamily && face.subfamily !== "Regular"
            ? `${face.family} ${face.subfamily}`
            : face.family,
      },
      fileName: faceFileName(face, facesPerPath),
      origin: "system" as const,
      path: face.path,
      intervals: [],
    }));
  store.set({ fonts: [...store.get().fonts, record, ...siblings] });
  return family.family;
}

/** The service's system families, when the enumeration has landed. */
export function systemFamilies(): SystemFontFamily[] {
  return synthStore.get().service.systemFonts ?? [];
}

/**
 * Round 30: true while the enumeration poll is out (the pickers'
 * 系统字体扫描中 loading row); false once it lands, on services
 * without the endpoint, and when the bounded poll gives up.
 */
export function systemFontsPending(): boolean {
  return synthStore.get().service.systemFontsPending;
}
