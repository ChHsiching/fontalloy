/**
 * Local families by scan (ticket #34; ticket #36 closes the last byte
 * flow): EVERY local-load entry point hands the serve's local-font
 * scan something it can name — absolute PATHS (the native dialog, the
 * typed path) or the file's own BYTES through the upload endpoint (the
 * plain browser's file input, which has no paths). Both return the
 * SAME family documents — real name-table identity, weight/style,
 * server-side TTC expansion, one face per (weight, style) slot with
 * the side-cut drops already applied, run-length coverage intervals —
 * and drive the SAME URL FontFace registration the catalog pick path
 * uses. The page never reads a picked file's bytes: the scan is JSON
 * or a streamed upload in, documents out, and a face streams from the
 * serve only when something renders in its weight/style slot.
 *
 * The module's older role — same-directory sibling discovery (round
 * 13, owner item 7) — died with the byte fallback: files submitted
 * together pool into their shared family SERVER-SIDE, so a
 * multi-select dialog pick or a multi-file upload loads the whole
 * family without any page-side sweep.
 */

import { store, type LoadedFont, type CpIntervals } from "../state";
import { synthStore } from "../service/state";
import {
  registerCatalogUrlFaces,
  loadDefaultSlotWithBudget,
  FontLoadBudgetError,
} from "./registry";
import { readConfig } from "../platform/config";
import type { LocalFontsDocument } from "../service/client";

/** What a local load run registered (the picker's outcome card). */
export interface LocalLoadOutcome {
  /**
   * The pick: the FIRST family's representative record, when at least
   * one family registered. The caller selects it in the hosting slot.
   */
  representative: LoadedFont | null;
  /** Per-file failure lines (无法加载 file：…), for the picker. */
  failures: string[];
  /** FontFaces this run put on document.fonts. */
  faces: number;
  /** Distinct name-table families the run's files span. */
  families: number;
  /**
   * The faces' total glyph count (the scan's own maxp counts summed
   * over every registered face) — the outcome card's 字形 figure.
   */
  glyphs: number;
}

/** Options for the load entry points. */
export interface LocalLoadOptions {
  /**
   * Per-face progress: called with the faces completed so far and the
   * run's planned face total, in the same two phases the picker's
   * footer renders — `reading` (the scan request is out; the count
   * scale is the submitted files) then `registering` (the returned
   * faces register onto document.fonts, one tick per face). The first
   * call of each phase is (0, total).
   */
  onProgress?: (
    loaded: number,
    total: number,
    phase?: "reading" | "registering",
  ) => void;
}

/** One loadable face between the scan document and the registry. */
interface FacePlan {
  url: string;
  fileName: string;
  path: string;
  family: string;
  subfamily: string;
  weight: number;
  italic: boolean;
  glyphs: number;
  intervals: CpIntervals;
  placeholderIntervals: CpIntervals;
}

/** Basename of a path, Windows or POSIX separators. */
function baseName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1]!.toLowerCase();
}

/**
 * The local loading path (ticket #34): scan the paths server-side,
 * then register each family document the way a catalog pick
 * registers — one URL FontFace per scanned face under the family's
 * own name-table name (lazy per used descriptor), a representative
 * record (the 400-upright member when one exists, else the document's
 * first face) every surface reads, and data-only records for the
 * other faces (the sibling discipline: names only, no rows of their
 * own).
 *
 * Idempotent per family: a re-load of the same paths reuses what is
 * already registered. Never throws for font-level trouble — every
 * failure (a rejected path is a ServeError from the scan itself; an
 * unreadable file rides the document's `skipped` list; a family whose
 * default slot cannot render) lands in `failures` — but a missing
 * service surfaces as the single thrown error the picker's line owns.
 */
export async function registerLocalFontPaths(
  paths: readonly string[],
  options: LocalLoadOptions = {},
): Promise<LocalLoadOutcome> {
  const client = synthStore.get().service.client;
  if (client === null) {
    throw new Error("本地字体加载需要本地服务（未连接）。");
  }
  if (paths.length > 0) options.onProgress?.(0, paths.length, "reading");
  const document = await client.localFonts(paths);
  return registerScannedFamilies(document, options);
}

/**
 * The browser fallback's local loading (ticket #36): the picked File
 * objects themselves stream to the serve's upload endpoint — the page
 * NEVER constructs an ArrayBuffer (the fetch body IS the File; the
 * browser streams it) — and the returned documents register exactly
 * like a path pick. One upload per file, sequentially, so a
 * multi-file pick pools its families server-side per request and the
 * progress scale stays the picked file count.
 */
export async function registerLocalFontFiles(
  files: readonly File[],
  options: LocalLoadOptions = {},
): Promise<LocalLoadOutcome> {
  const client = synthStore.get().service.client;
  if (client === null) {
    throw new Error("本地字体加载需要本地服务（未连接）。");
  }
  const failures: string[] = [];
  if (files.length > 0) options.onProgress?.(0, files.length, "reading");
  let read = 0;
  let merged: LocalFontsDocument = { families: [], skipped: [] };
  for (const file of files) {
    try {
      const document = await client.localFontsUpload(file);
      merged = {
        families: [...merged.families, ...document.families],
        skipped: [...merged.skipped, ...document.skipped],
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failures.push(`无法加载 ${file.name}：${reason}`);
    }
    read++;
    options.onProgress?.(read, files.length, "reading");
  }
  const outcome = await registerScannedFamilies(merged, options);
  return { ...outcome, failures: [...failures, ...outcome.failures] };
}

/** The shared registration over one scan's family documents. */
async function registerScannedFamilies(
  scanDocument: LocalFontsDocument,
  options: LocalLoadOptions = {},
): Promise<LocalLoadOutcome> {
  const reason = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);
  // One macrotask between faces — the event loop serves input between
  // every step. The test seam's delay rides the same yield.
  const delayMs = readConfig().testFontLoadDelayMs ?? 0;
  const yieldBetweenFaces = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, delayMs));
  const failures: string[] = [];
  for (const skip of scanDocument.skipped) {
    failures.push(`无法加载 ${baseName(skip.path)}：${reason(skip.error)}`);
  }

  // The registering phase: one tick per face, document order
  // (families in first-appearance order, representative first inside
  // each — the scan's own ordering).
  const plans = new Map<string, FacePlan[]>();
  for (const family of scanDocument.families) {
    const cut = family.cuts[0];
    if (cut === undefined) continue;
    const group: FacePlan[] = [];
    const perPath = new Map<string, number>();
    for (const face of cut.faces) {
      perPath.set(face.path, (perPath.get(face.path) ?? 0) + 1);
    }
    for (const face of cut.faces) {
      const shared = perPath.get(face.path) ?? 1;
      group.push({
        url: face.href,
        fileName: shared > 1 ? `${face.file}#${face.face_index + 1}` : face.file,
        path: face.path,
        family: face.family,
        subfamily: face.subfamily,
        weight: face.weight,
        italic: face.italic,
        glyphs: face.glyphs,
        intervals: face.coverage.intervals as unknown as CpIntervals,
        placeholderIntervals: face.coverage.placeholder_intervals as unknown as CpIntervals,
      });
    }
    plans.set(family.family, group);
  }

  let representative: LoadedFont | null = null;
  let faces = 0;
  let glyphs = 0;
  const total = [...plans.values()].reduce(
    (sum, group) => sum + group.length,
    0,
  );
  if (total > 0) options.onProgress?.(0, total, "registering");
  let loaded = 0;
  for (const [family, group] of plans) {
    const displayName =
      scanDocument.families.find((doc) => doc.family === family)?.display_name ??
      family;
    let repRecord = store.get().fonts.find((f) => f.cssFamily === family);
    const newly: FacePlan[] = [];
    const siblings: LoadedFont[] = [];
    for (const plan of group) {
      glyphs += plan.glyphs;
      const already = store
        .get()
        .fonts.some(
          (f) => f.cssFamily === family && f.fileName === plan.fileName,
        );
      if (!already) {
        newly.push(plan);
        if (repRecord === undefined) {
          repRecord = {
            cssFamily: family,
            family,
            names: {
              family: displayName,
              display: displayName,
            },
            fileName: plan.fileName,
            origin: "local",
            path: plan.path,
            intervals: plan.intervals,
            placeholderIntervals: plan.placeholderIntervals,
            weight: plan.weight,
            italic: plan.italic,
          };
          store.set({ fonts: [...store.get().fonts, repRecord] });
        } else {
          siblings.push({
            cssFamily: family,
            family,
            fileName: plan.fileName,
            origin: "local",
            path: plan.path,
            intervals: [],
            weight: plan.weight,
            italic: plan.italic,
          } satisfies LoadedFont);
        }
      }
      loaded++;
      options.onProgress?.(loaded, total, "registering");
      await yieldBetweenFaces();
    }
    if (newly.length > 0) {
      registerCatalogUrlFaces(
        family,
        newly.map((plan) => ({
          url: plan.url,
          weight: plan.weight,
          style: plan.italic ? ("italic" as const) : ("normal" as const),
        })),
      );
      faces += newly.length;
    }
    if (siblings.length > 0) {
      store.set({ fonts: [...store.get().fonts, ...siblings] });
    }
    representative ??= repRecord ?? null;
  }

  // The rendered default slot of the FIRST new family is awaited —
  // the pick renders in it immediately, and a face the serve can no
  // longer serve surfaces here instead of as a silent blank. The
  // shared abort budget rides it (a parked byte fetch must fail
  // loudly, never hang the load — the r30 lesson's FontFace half); a
  // BUDGET expiry also evicted the family, so its representative must
  // not become the pick (the record no longer exists).
  const first = representative;
  if (first !== null) {
    try {
      await loadDefaultSlotWithBudget(first.cssFamily);
    } catch (err) {
      if (err instanceof FontLoadBudgetError) representative = null;
      failures.push(`无法加载 ${first.cssFamily}：${reason(err)}`);
    }
  }
  return { representative, failures, faces, families: plans.size, glyphs };
}
