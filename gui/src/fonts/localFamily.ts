/**
 * Local family discovery (round 13, owner item 7): a LOCAL-FILE pick
 * is the family, not one face — the same rule catalog picks follow
 * (round 12). When a file loads, its DIRECTORY is scanned for other
 * font files whose name-table FAMILY matches the loaded file's; the
 * whole set registers behind the representative exactly the way a
 * catalog family pick does:
 *
 * - the representative (the loaded file) is the pick key, the preview
 *   face, the identity every surface reads — it keeps the ONE
 *   FontFace (siblings would collide with it under the shared css
 *   family, and nothing renders in them);
 * - the siblings are DATA-ONLY LoadedFonts — names parsed, no cmap
 *   enumeration, no FontFace — appended by a BACKGROUND sweep that
 *   yields between files and patches the store ONCE, so the pick
 *   itself stays instant and a huge directory never blocks the UI;
 * - discovery never blocks and never errors visibly: a directory that
 *   cannot be listed, a service index that is not there (yet), and
 *   files that no longer parse each degrade to a single-face pick —
 *   today's behavior, correct for a one-file family.
 *
 * Where the directory listing comes from depends on the platform:
 * under Tauri the shell lists the picked file's own directory
 * (`list_font_dir`) and each candidate is parsed names-only through
 * the shared sfnt reader; in the plain browser there is no directory
 * access, so the service's /fonts index stands in — its faces already
 * carry the name-table family the core's scanner parsed, and the
 * same-directory constraint is the resolved representative path's
 * dirname.
 */

import { store, type LoadedFont } from "../state";
import { synthStore } from "../service/state";
import { composeDisplay, parseFontMeta, type FontNames } from "./sfnt";
import {
  canPickWithDialog,
  listFontDirectory,
  readPickedFont,
} from "../platform/localfonts";

/** One discovered sibling face: where it is, and its own names. */
interface SiblingFace {
  fileName: string;
  /** The on-disk path (always known for a discovered sibling). */
  path: string;
  names: FontNames;
}

/** Basename of a path, Windows or POSIX separators, lowercased. */
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
 * The Tauri discovery: list the picked file's directory through the
 * shell, read every OTHER font file, parse its names, and keep the
 * faces whose own name-table family is the representative's. One read
 * per file, one yield between files.
 */
async function platformSiblings(font: LoadedFont): Promise<SiblingFace[]> {
  const listing = await listFontDirectory(font.path!);
  if (listing === null) return [];
  const siblings: SiblingFace[] = [];
  for (const path of listing) {
    if (path.replace(/\\/g, "/") === font.path!.replace(/\\/g, "/")) continue;
    try {
      const { buffer, fileName } = await readPickedFont(path);
      // Names only — the cmap enumeration is the expensive half of the
      // parse and no consumer reads a sibling's coverage. A sibling
      // COLLECTION contributes its first face's family here (metadata
      // only): a collection's own faces register through the load
      // path's per-face expansion, never through this sweep.
      const meta = parseFontMeta(buffer, { coverage: false });
      if (meta.family !== font.cssFamily) continue;
      siblings.push({ fileName, path, names: meta.names });
    } catch {
      // A file that no longer parses is simply absent from the set.
    }
    await yieldFrame();
  }
  return siblings;
}

/**
 * The browser discovery: the service's /fonts index stands in for the
 * directory listing. Faces of the representative's own name-table
 * family, in the representative's resolved directory, one record per
 * distinct file (a TTC contributes one sibling, not one per face).
 *
 * Round 19 note: a face extracted from a picked COLLECTION carries the
 * per-face name `file.ttc#N`, which matches no index basename — the
 * representative stays unresolved and the sweep degrades to nothing,
 * exactly right: the collection's faces already registered as faces
 * of their own through the load path, and re-reading them as
 * data-only siblings would duplicate them.
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
 * Discover and register a local pick's family faces — fire-and-forget
 * from the load path (`void sweepLocalFamily(font)`). Idempotent per
 * representative file and per sibling: an earlier sweep's records, a
 * mid-flight sweep, and files that fail to parse are all skipped.
 */
export async function sweepLocalFamily(font: LoadedFont): Promise<void> {
  if (font.origin !== "local") return;
  const runKey = `${font.cssFamily}::${font.path ?? font.fileName}`;
  if (sweeps.has(runKey)) return;
  sweeps.add(runKey);
  try {
    let siblings: SiblingFace[];
    if (canPickWithDialog() && font.path !== undefined) {
      siblings = await platformSiblings(font);
    } else {
      // The index the browser discovery reads may still be mid-probe.
      await waitForServiceSettled();
      siblings = indexSiblings(font);
    }
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
    }
    if (faces.length > 0) {
      store.set({ fonts: [...store.get().fonts, ...faces] });
    }
  } finally {
    sweeps.delete(runKey);
  }
}
