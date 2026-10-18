/**
 * Local families by scan (ticket #34): a LOCAL pick hands absolute
 * PATHS to the serve's local-font scan (`POST /local-fonts`); the
 * returned family documents — real name-table identity, weight/style,
 * server-side TTC expansion, one face per (weight, style) slot with
 * the side-cut drops already applied — drive the SAME URL FontFace
 * registration the catalog pick path uses. The page never reads a
 * picked file's bytes: the scan is JSON in, documents out, and a face
 * streams from the serve only when something renders in its
 * weight/style slot.
 *
 * The module's older role — same-directory sibling discovery
 * (round 13, owner item 7) — is subsumed by the scan: files submitted
 * together pool into their shared family SERVER-SIDE, so a
 * multi-select dialog pick or a typed DIRECTORY path loads the whole
 * family without any page-side sweep. The browser fallback flow (the
 * hidden HTML file input, bytes-only, no paths) keeps a residual
 * index-driven sweep below — its discovery ran against the service's
 * /fonts listing all along and needs no shell command.
 */

import { store, type LoadedFont } from "../state";
import { synthStore } from "../service/state";
import { composeDisplay, type FontNames } from "./sfnt";
import { registerCatalogUrlFaces } from "./registry";
import { readConfig } from "../platform/config";
import { cssFamily } from "../kit/pickerPopup";

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
  /** Distinct name-table families the run's paths span. */
  families: number;
  /**
   * The faces' total glyph count (the scan's own maxp counts summed
   * over every registered face) — the outcome card's 字形 figure.
   */
  glyphs: number;
}

/** Options for {@link registerLocalFontPaths}. */
export interface LocalLoadOptions {
  /**
   * Per-face progress: called with the faces completed so far and the
   * run's planned face total, in the same two phases the picker's
   * footer renders — `reading` (the scan request is out; the count
   * scale is the submitted paths) then `registering` (the returned
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
}

/** Basename of a path, Windows or POSIX separators. */
function baseName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1]!.toLowerCase();
}

/** Dirname of a path (POSIX-normalized), "" for a bare name. */
function dirName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  parts.pop();
  return parts.join("/");
}

/**
 * The local loading path (ticket #34): scan the paths server-side,
 * then register each family document the way a catalog pick
 * registers — one URL FontFace per scanned face under the family's
 * own name-table name (lazy per used descriptor), a representative
 * record (the 400-upright member when one exists, else the document's
 * first face) every surface reads, and data-only records for the
 * other faces (the sibling discipline: names only, no rows of their
 * own). The run yields to the event loop between faces — the
 * workspace stays interactive throughout; progress lands in
 * `onProgress` after every face, and the config's test seam slows
 * every yield deterministically.
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
  const reason = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);
  // One macrotask between faces — the event loop serves input between
  // every step. The test seam's delay rides the same yield.
  const delayMs = readConfig().testFontLoadDelayMs ?? 0;
  const yieldBetweenFaces = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, delayMs));
  const failures: string[] = [];

  // The reading phase: the scan request itself (the count scale is
  // the submitted paths — the face total only exists once the
  // documents come back).
  if (paths.length > 0) options.onProgress?.(0, paths.length, "reading");
  const scanDocument = await client.localFonts(paths);
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
        url: `${client.baseUrl}${face.href}`,
        fileName: shared > 1 ? `${face.file}#${face.face_index + 1}` : face.file,
        path: face.path,
        family: face.family,
        subfamily: face.subfamily,
        weight: face.weight,
        italic: face.italic,
        glyphs: face.glyphs,
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
            codepoints: [],
          };
          store.set({ fonts: [...store.get().fonts, repRecord] });
        } else {
          siblings.push({
            cssFamily: family,
            family,
            names: {
              family: plan.family,
              display: composeDisplay(
                plan.family,
                plan.subfamily || undefined,
              ),
            },
            fileName: plan.fileName,
            origin: "local",
            path: plan.path,
            codepoints: [],
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
  // longer serve surfaces here instead of as a silent blank.
  const first = representative;
  if (first !== null) {
    try {
      await document.fonts.load(`16px ${cssFamily(first.cssFamily)}`);
    } catch (err) {
      failures.push(`无法加载 ${first.cssFamily}：${reason(err)}`);
    }
  }
  return { representative, failures, faces, families: plans.size, glyphs };
}

/* ---------- the browser fallback's residual sibling sweep ---------- */

/** One discovered sibling face: where it is, and its own names. */
interface SiblingFace {
  fileName: string;
  /** The on-disk path (always known for a discovered sibling). */
  path: string;
  names: FontNames;
}

/** The event-loop yield between sibling parses (the sweep's pacemaker). */
const yieldFrame = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Wait (bounded) for a connecting service to settle: a font loaded in
 * the first moments of a page can outrun the boot probe, and the
 * browser discovery reads the index the probe fills. connectService
 * always settles; the cap is pure belt-and-braces so a stuck probe can
 * never pin a background sweep.
 */
async function waitForServiceSettled(): Promise<void> {
  if (synthStore.get().service.status !== "connecting") return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => done(), 5_000);
    const done = (): void => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const unsubscribe = synthStore.subscribe((state) => {
      if (state.service.status !== "connecting") done();
    });
  });
}

/**
 * The browser discovery: the service's /fonts index stands in for the
 * directory listing (the plain browser has no directory access).
 * Faces of the representative's own name-table family, in the
 * representative's resolved directory, one record per distinct file
 * (a TTC contributes one sibling, not one per face).
 *
 * Round 19 note: a face extracted from a picked COLLECTION carries the
 * per-face name `file.ttc#N`, which matches no index basename — the
 * representative stays unresolved and the sweep degrades to nothing,
 * exactly right: the collection's faces already registered as faces
 * of their own through the load path, and re-reading them as
 * data-only siblings would duplicate them.
 *
 * Ticket #34: this residual sweep serves the BROWSER file-input
 * fallback only. Path-driven picks (the dialog, the typed path) pool
 * their files server-side — the scan replaced the sweep — and the
 * shell's directory lister is retired.
 */
function indexSiblings(font: LoadedFont): SiblingFace[] {
  const index = synthStore.get().service.fontsIndex;
  if (index === null) return [];
  const representative =
    font.path !== undefined
      ? font.path
      : index.families
          .flatMap((family) => family.faces)
          .find((face) => baseName(face.path) === baseName(font.fileName))
          ?.path;
  if (representative === undefined) return [];
  const directory = dirName(representative);
  const byFile = new Map<string, SiblingFace>();
  for (const family of index.families) {
    for (const face of family.faces) {
      if (face.family !== font.cssFamily) continue;
      if (dirName(face.path) !== directory) continue;
      if (baseName(face.path) === baseName(representative)) continue;
      if (!byFile.has(face.path)) {
        byFile.set(face.path, {
          fileName: face.path.replace(/\\/g, "/").split("/").pop() ?? face.path,
          path: face.path,
          // The index's own strings ARE the name table (the core's
          // scanner parsed them); the display name composes the same
          // family + subfamily join every surface reads.
          names: {
            family: face.family,
            ...(face.subfamily ? { subfamily: face.subfamily } : {}),
            display: composeDisplay(face.family, face.subfamily || undefined),
          },
        });
      }
    }
  }
  return [...byFile.values()];
}

/** Sweeps in flight (one per representative file). */
const sweeps = new Set<string>();

/**
 * Discover and register a browser file-input pick's family faces —
 * fire-and-forget from that fallback load path. Idempotent per
 * representative file and per sibling: an earlier sweep's records, a
 * mid-flight sweep, and files that fail to resolve are all skipped.
 */
export async function sweepLocalFamily(font: LoadedFont): Promise<void> {
  if (font.origin !== "local") return;
  const runKey = `${font.cssFamily}::${font.path ?? font.fileName}`;
  if (sweeps.has(runKey)) return;
  sweeps.add(runKey);
  try {
    // The index the browser discovery reads may still be mid-probe.
    await waitForServiceSettled();
    const siblings = indexSiblings(font);
    const recorded = (sibling: SiblingFace): boolean =>
      store.get().fonts.some(
        (f) =>
          f.origin === "local" &&
          f.cssFamily === font.cssFamily &&
          (f.path ?? f.fileName) === sibling.path,
      );
    const faces: LoadedFont[] = [];
    for (const sibling of siblings) {
      if (recorded(sibling)) continue;
      faces.push({
        cssFamily: font.cssFamily,
        family: font.cssFamily,
        names: sibling.names,
        fileName: sibling.fileName,
        origin: "local",
        path: sibling.path,
        codepoints: [],
      });
      await yieldFrame();
    }
    if (faces.length > 0) {
      store.set({ fonts: [...store.get().fonts, ...faces] });
    }
  } finally {
    sweeps.delete(runKey);
  }
}
