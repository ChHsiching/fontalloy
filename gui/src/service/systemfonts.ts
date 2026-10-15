/**
 * System font discovery (round 24, owner item 3): the pickers' third
 * source beside the catalog and local file loads. The service — the
 * desktop sidecar, or any serve with the same endpoints — enumerates
 * the platform's font directories (`/system-fonts`) and serves the
 * bytes of the files it scanned (`/system-fonts/file?path=`), so the
 * feature needs no Tauri IPC and works wherever the service runs.
 *
 * Classification is the owner's ruling: a face with Latin coverage
 * lists in the EN picker, one with CJK coverage in the CJK picker,
 * and a face with both belongs in BOTH (微软雅黑's Chinese is a
 * legitimate CJK-only pick). The flags ride the family record; the
 * pickers filter per role.
 *
 * Faces group into families by name-table family (the local-load
 * discipline: the 400-upright member is the representative when one
 * exists, else the first face). Enumeration registers NOTHING — the
 * rows are metadata like unfetched catalog rows; a PICK loads the
 * family's file(s) and registers faces through the same bytes path
 * local loads use (a collection registers every extracted face).
 */

import { registerLocalFontFiles } from "../fonts/registry";
import { patchService, synthStore } from "./state";
import type { ServeClient } from "./client";

/** One face as the service's `/system-fonts` reports it. */
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
}

/** One installed family: its faces grouped, with the row's flags. */
export interface SystemFontFamily {
  /** The name-table family — the css key a pick registers under. */
  family: string;
  /** Every face of the family in scan order, representative first. */
  faces: SystemFaceDoc[];
  /** The representative (400-upright preferred) the pick loads. */
  representative: SystemFaceDoc;
  latin: boolean;
  cjk: boolean;
}

/** Group the flat scan into families (representative first). */
export function groupSystemFamilies(
  faces: readonly SystemFaceDoc[],
): SystemFontFamily[] {
  const groups = new Map<string, SystemFaceDoc[]>();
  for (const face of faces) {
    const group = groups.get(face.family);
    if (group === undefined) groups.set(face.family, [face]);
    else group.push(face);
  }
  const families: SystemFontFamily[] = [];
  for (const [family, group] of groups) {
    const rep =
      group.find((f) => f.weight === 400 && !f.italic) ?? group[0]!;
    const ordered = [rep, ...group.filter((f) => f !== rep)];
    families.push({
      family,
      faces: ordered,
      representative: rep,
      latin: group.some((f) => f.latin),
      cjk: group.some((f) => f.cjk),
    });
  }
  return families;
}

/** The fetch runs once per service connection; failures stay silent. */
let requested = false;

/** Ask the service for the installed fonts (background, idempotent). */
export async function ensureSystemFonts(client: ServeClient): Promise<void> {
  if (requested) return;
  requested = true;
  try {
    const doc = await client.systemFonts();
    patchService({ systemFonts: groupSystemFamilies(doc.faces) });
  } catch {
    // No enumeration (older service, scan failure) — the feature is
    // simply absent; nothing else changes.
  }
}

/** Reset the once-guard when a new service connects (tests). */
export function resetSystemFontsRequest(): void {
  requested = false;
}

/**
 * Load and register one picked system family. The representative's
 * FILE is read whole; a collection contributes every face through the
 * local-load path (extraction, family grouping, representative-first
 * registration). Returns the family's css key — the existing record
 * when an earlier source (catalog, local) already registered the same
 * name-table family under it.
 */
export async function registerSystemFamily(
  client: ServeClient,
  family: SystemFontFamily,
): Promise<string | null> {
  const rep = family.representative;
  let buffer: ArrayBuffer;
  try {
    buffer = await client.systemFontBytes(rep.path);
  } catch {
    return null;
  }
  const outcome = await registerLocalFontFiles(
    [
      {
        buffer,
        fileName: rep.file,
        path: rep.path,
      },
    ],
    { systemOrigin: true },
  );
  return outcome.representative?.cssFamily ?? null;
}

/** The service's system families, when the enumeration has landed. */
export function systemFamilies(): SystemFontFamily[] {
  return synthStore.get().service.systemFonts ?? [];
}
