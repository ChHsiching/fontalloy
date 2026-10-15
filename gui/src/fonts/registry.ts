import { parseFontMeta, type FontMeta } from "./sfnt";
import {
  collectionFaceOffsets,
  extractFaceAtOffset,
  isFontCollection,
} from "./ttc";
import { store, type FontCatalogIdentity, type LoadedFont } from "../state";
import { readConfig } from "../platform/config";

/**
 * The user-facing name of a registered font (round 9, owner item 2):
 * the font's OWN name-table strings, verbatim — never a curated or
 * constructed display name. Fonts whose bytes could not be read carry
 * no names and fall back to their metadata family. Round 21: the
 * display the parse composes prefers the TYPOGRAPHIC family (nameID16)
 * over the legacy nameID1, so a variable release's default-instance
 * naming never leaks into a row.
 */
export function fontDisplayName(font: LoadedFont): string {
  return font.names?.display ?? font.family;
}

export interface LoadResult {
  font: LoadedFont;
  /** True when this family was not present before. */
  isNewFamily: boolean;
}

/** The FontFace descriptors one face registers under (round 20). */
export interface FaceDescriptors {
  /** The OS/2 usWeightClass ("400" … "900"). */
  weight: number;
  style: "normal" | "italic";
}

export interface RegisterOptions {
  /**
   * Display family name. Defaults to the parsed name-table family (local
   * file behavior); the catalog path passes the metadata family so picker
   * rows are metadata-driven.
   */
  family?: string;
  /**
   * The css family key (round 20). Defaults to the parsed name-table
   * family — the local path pins the collection family's shared key
   * explicitly (faces of one family register under ONE css family).
   */
  cssFamily?: string;
  fileName: string;
  origin: "local" | "catalog" | "system";
  /**
   * The on-disk path, when the platform knows one (the catalog storage
   * layout; the Tauri file dialog). Recipes reference it verbatim.
   */
  path?: string;
  /**
   * The catalog identity (manifest family + variant, round 6): carried
   * on the LoadedFont so the synthesize flow can emit a catalog-family
   * recipe reference instead of a bare file name.
   */
  catalog?: FontCatalogIdentity;
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
  /**
   * The FontFace weight/style descriptors (round 20). Absent — the
   * catalog path — registers exactly as before, descriptor-less.
   */
  descriptors?: FaceDescriptors;
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
  const cssFamily = options.cssFamily ?? meta.family;

  const state = store.get();
  const existing = state.fonts.find((f) => f.cssFamily === cssFamily);
  if (existing) return { font: existing, isNewFamily: false };

  const face =
    options.descriptors === undefined
      ? new FontFace(cssFamily, buffer)
      : new FontFace(cssFamily, buffer, {
          weight: String(options.descriptors.weight),
          style: options.descriptors.style,
        });
  if (options.lazy) {
    document.fonts.add(face);
  } else {
    await face.load();
    document.fonts.add(face);
  }

  const font: LoadedFont = {
    cssFamily,
    family: options.family ?? meta.family,
    names: meta.names,
    fileName: options.fileName,
    origin: options.origin,
    path: options.path,
    catalog: options.catalog,
    codepoints: meta.codepoints,
    placeholderCodepoints: meta.placeholderCodepoints,
  };
  if (!options.silent) {
    store.set({ fonts: [...store.get().fonts, font] });
  }
  return { font, isNewFamily: true };
}

/** What a local load run registered (round 20; stats round 21). */
export interface LocalLoadOutcome {
  /**
   * The pick: the FIRST family's representative face, when at least one
   * face loaded. The caller selects it in the hosting slot.
   */
  representative: LoadedFont | null;
  /** Per-face/per-file failure lines (无法加载 file#N：…), for the picker. */
  failures: string[];
  /** FontFaces this run put on document.fonts. */
  faces: number;
  /** Distinct name-table families the run's files span (round 21). */
  families: number;
  /**
   * The faces' total glyph count (maxp numGlyphs summed over every
   * loadable face, round 21) — the outcome card's 字形 figure.
   */
  glyphs: number;
}

/** Options for {@link registerLocalFontFiles} (round 21). */
export interface LocalLoadOptions {
  /**
   * Per-face progress: called with the faces completed so far and the
   * run's planned face total — the picker footer's inline count
   * indicator. Round 23 (owner item 6a) splits the run into two
   * phases, each ticking 0→total on the same scale: `reading` (a
   * collection's faces are extracted and parsed one by one) then
   * `registering` (the faces register onto document.fonts). The first
   * call of each phase is (0, total).
   */
  onProgress?: (
    loaded: number,
    total: number,
    phase?: "reading" | "registering",
  ) => void;
  /**
   * Round 24 (owner item 3): mark the run's records `system` instead
   * of `local` — the system-font picker loads installed families
   * through this same path (byte source and grouping are identical;
   * only the origin trait differs).
   */
  systemOrigin?: boolean;
}

/** One loadable face between the parse and the registry (round 20). */
interface FacePlan {
  buffer: ArrayBuffer;
  fileName: string;
  path?: string;
  meta: FontMeta;
}

/**
 * The local loading path (round 20; round 21, owner item 2): expand
 * the picked files (a collection contributes EVERY face), group the
 * faces by their own name-table family, and register each family the
 * way the catalog registers a family pick —
 *
 * - the REPRESENTATIVE face (the 400-upright member when one exists,
 *   else the family's first face) registers non-lazily under the
 *   family's css key and becomes the LoadedFont every surface reads;
 * - the family's OTHER faces register as FontFaces under the SAME css
 *   family with their own weight/style descriptors — a real collection
 *   (the pipeline's own 16-face ChHsich.ttc, one family, sixteen
 *   weights) renders each weight at its own face instead of collapsing
 *   sixteen faces onto the first — plus data-only records (the sweep's
 *   sibling discipline: names parsed, no coverage enumeration, no
 *   picker rows of their own);
 * - a load of a collection whose families differ (the round-19
 *   three-family fixture) yields one representative per family, so the
 *   picker lists one row per family exactly as before.
 *
 * Round 21: the run YIELDS to the event loop between faces (and
 * between the per-face parses), so the workspace stays interactive
 * throughout — never a synchronous multi-second loop on the main
 * thread. Progress lands in `onProgress` after every face; the
 * config's test seam can slow every yield deterministically.
 *
 * Idempotent per face: a re-load of the same file reuses everything
 * already registered. Never throws — every failure lands in
 * `failures`, named per face (`file.ttc#N`), never killing siblings.
 */
export async function registerLocalFontFiles(
  files: readonly { buffer: ArrayBuffer; fileName: string; path?: string }[],
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
  const plans: FacePlan[] = [];

  // Round 23 (owner item 6a): the expansion is INCREMENTAL, one face
  // per step with a yield and a progress tick after each — a big
  // collection (the pipeline's own 428MB 16-face ChHsich.ttc) spent
  // its first seconds in one synchronous extract-everything loop
  // before, freezing the window before the spinner could ever paint.
  // The face TOTAL comes cheap from the ttcf headers up front, so the
  // reading phase counts real faces, not bytes.
  const plannedFaces = (file: {
    buffer: ArrayBuffer;
    fileName: string;
  }): number => {
    if (!isFontCollection(file.buffer)) return 1;
    try {
      return collectionFaceOffsets(file.buffer).length;
    } catch {
      return 1; // the unreadable header counts as its one failure below
    }
  };
  const total = files.reduce((sum, file) => sum + plannedFaces(file), 0);
  if (total > 0) options.onProgress?.(0, total, "reading");
  let read = 0;
  const noteRead = (): void => {
    read++;
    options.onProgress?.(read, total, "reading");
  };
  for (const file of files) {
    if (!isFontCollection(file.buffer)) {
      try {
        plans.push({
          buffer: file.buffer,
          fileName: file.fileName,
          path: file.path,
          // Names + style only here — the coverage enumeration is the
          // expensive half and only the representatives need it (below).
          meta: parseFontMeta(file.buffer, { coverage: false }),
        });
      } catch (err) {
        failures.push(`无法加载 ${file.fileName}：${reason(err)}`);
      }
      noteRead();
      await yieldBetweenFaces();
      continue;
    }
    let offsets: number[];
    try {
      offsets = collectionFaceOffsets(file.buffer);
    } catch (err) {
      failures.push(
        `无法加载 ${file.fileName}：${reason(err) ?? "不是有效的字体文件"}`,
      );
      noteRead();
      await yieldBetweenFaces();
      continue;
    }
    for (let i = 0; i < offsets.length; i++) {
      const fileName = `${file.fileName}#${i + 1}`;
      try {
        const face = extractFaceAtOffset(file.buffer, offsets[i]!);
        plans.push({
          buffer: face.buffer,
          fileName,
          path: file.path,
          meta: parseFontMeta(face.buffer, { coverage: false }),
        });
      } catch (err) {
        failures.push(`无法加载 ${fileName}：${reason(err)}`);
      }
      noteRead();
      await yieldBetweenFaces();
    }
  }

  const glyphs = plans.reduce((sum, plan) => sum + plan.meta.numGlyphs, 0);

  // Families in first-appearance order; within a family the
  // representative first (400-upright preferred — the OS's own
  // default-match face, the catalog's pick discipline), then the rest.
  const families = new Map<string, FacePlan[]>();
  for (const plan of plans) {
    const group = families.get(plan.meta.family);
    if (group === undefined) families.set(plan.meta.family, [plan]);
    else group.push(plan);
  }

  let representative: LoadedFont | null = null;
  let faces = 0;
  let loaded = 0;
  if (total > 0) options.onProgress?.(0, total, "registering");
  for (const [family, group] of families) {
    const rep =
      group.find((p) => p.meta.weight === 400 && !p.meta.italic) ?? group[0]!;
    const ordered = [rep, ...group.filter((p) => p !== rep)];
    // The family's representative record, when an earlier load already
    // made one — the faces that follow then land as descriptor faces +
    // data-only records, never as a second representative. It stays
    // the family's PICK even when every face was already registered
    // (an idempotent re-load still selects the family).
    let repRecord = store.get().fonts.find((f) => f.cssFamily === family);
    // The family's sibling data-only records land in ONE store patch
    // (round 23): a 16-face collection otherwise rebuilds every store
    // subscriber fifteen times in a row.
    const siblings: LoadedFont[] = [];
    for (const plan of ordered) {
      if (
        store
          .get()
          .fonts.some(
            (f) => f.cssFamily === family && f.fileName === plan.fileName,
          )
      ) {
        continue; // this exact face is already registered
      }
      try {
        if (repRecord === undefined) {
          const result = await registerFontBytes(plan.buffer, {
            cssFamily: family,
            fileName: plan.fileName,
            origin: options.systemOrigin ? "system" : "local",
            path: plan.path,
            descriptors: {
              weight: plan.meta.weight,
              style: plan.meta.italic ? "italic" : "normal",
            },
          });
          if (result.isNewFamily) faces++;
          repRecord = result.font;
        } else {
          // A sibling face of the family: the FontFace rides the shared
          // css family with its own descriptors (lazy — nothing renders
          // in it until the family is asked for that weight); the
          // record is data-only, exactly the sweep's sibling shape.
          document.fonts.add(
            new FontFace(
              family,
              plan.buffer,
              plan.meta.italic
                ? { weight: String(plan.meta.weight), style: "italic" }
                : { weight: String(plan.meta.weight) },
            ),
          );
          faces++;
          siblings.push({
            cssFamily: family,
            family,
            names: plan.meta.names,
            fileName: plan.fileName,
            origin: options.systemOrigin ? "system" : "local",
            path: plan.path,
            codepoints: [],
          } satisfies LoadedFont);
        }
      } catch (err) {
        failures.push(`无法加载 ${plan.fileName}：${reason(err)}`);
      }
      loaded++;
      options.onProgress?.(loaded, total, "registering");
      await yieldBetweenFaces();
    }
    if (siblings.length > 0) {
      store.set({ fonts: [...store.get().fonts, ...siblings] });
    }
    // The first family that has a record — fresh or from an earlier
    // load — is the pick.
    representative ??= repRecord ?? null;
  }
  return { representative, failures, faces, families: families.size, glyphs };
}

/** The local load path's file/face entry types (see ./ttc). */
export type { LocalFontFile, LocalFontEntry } from "./ttc";
