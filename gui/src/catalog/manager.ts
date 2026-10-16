import {
  store,
  type CatalogFamilyEntry,
  type CatalogState,
} from "../state";
import { registerFontBytes } from "../fonts/registry";
import { parseFontMeta } from "../fonts/sfnt";
import type { LoadedFont } from "../state";
import type { BlobStorage } from "../platform/storage";
import { parseCatalogRelease, type CatalogRelease, type ReleaseFamily, type ReleaseOrigin } from "./release";
import {
  faceMatchesVariant,
  pickVariantRepresentative,
  variantFaceFiles,
} from "./faceSet";
import { familyEntries, variantCuts } from "./variantAxes";
import { unzip } from "./zip";
import curatedMeta from "../data/curated-meta.json";

/** How many families the boot sweep registers between store flushes. */
const SWEEP_FLUSH_WAVE = 8;

/** The curated front per picker role: these families register FIRST. */
const CURATED_FRONT = (curatedMeta as {
  front: { en: string[]; cjk: string[] };
}).front;

export interface CatalogManagerDeps {
  storage: BlobStorage;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
}

/** Written LAST, after every face of the family passed its sha256 check. */
const COMPLETE_MARKER = ".complete";

/** Storage key namespace: `catalog/families/<encoded family>`. */
function familyDir(family: string): string {
  return `catalog/families/${encodeURIComponent(family)}`;
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer-backed view: digest rejects views whose
  // buffer could be shared, and our data never is.
  const view = data instanceof Uint8Array ? data : new Uint8Array(data);
  const bytes = new Uint8Array(view.byteLength);
  bytes.set(view);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Every face of a family+variant (round 12, owner item 8) and the
 * cut's representative pick (round 20: the plainest Regular of the
 * cut's OWN faces) live in ./faceSet (pure, spec-exercised) — the IFF
 * cut discriminators (nf/cn/hw/mono/variable/gb/tc/screen/plus) too.
 */

/**
 * The first-run catalog downloader (issue #17, ADR-0005).
 *
 * Every launch runs the same flow — there is no special "first" launch:
 *
 * 1. Fetch `catalog-release.json` from the bootstrap URL (the release tag
 *    on GitHub under Tauri; an injected config elsewhere). Failure leaves
 *    the app in `unavailable` and never blocks the workspace.
 * 2. Compare metadata against storage: a family is verified when its
 *    `.complete` marker and every face are present. Verified families are
 *    skipped — which IS the retry-on-later-launches mechanism: only missing
 *    (never-downloaded or failed) families download again.
 * 3. Download missing families sequentially through the ordered origin
 *    list, verifying the zip sha256, extracting, verifying each face's
 *    sha256 IN MEMORY, and only then writing to storage. Failures mark the
 *    family `failed` and move on — startup is never blocked.
 * 4. Register every verified family's primary face as a lazy FontFace so
 *    picker rows self-render; the interactive path loads on selection.
 *
 * All progress lands in `store.catalog`; the progress screen and pickers
 * subscribe and render themselves.
 */
export class CatalogManager {
  private release: CatalogRelease | null = null;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly deps: CatalogManagerDeps) {
    this.fetchFn = deps.fetchFn ?? ((...args: Parameters<typeof fetch>) =>
      fetch(...args));
  }

  /** The release metadata of the last successful bootstrap (null before). */
  getRelease(): CatalogRelease | null {
    return this.release;
  }

  async run(bootstrapUrl: string): Promise<void> {
    this.patchCatalog({ status: "bootstrapping", bootstrapError: undefined, families: [], screen: false });

    let text: string;
    try {
      const res = await this.fetchFn(bootstrapUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } catch (err) {
      // Offline / origin down / bad HTTP: the workspace stays fully usable.
      this.patchCatalog({ status: "unavailable", bootstrapError: describe(err) });
      return;
    }

    let release: CatalogRelease;
    try {
      release = parseCatalogRelease(text);
    } catch (err) {
      this.patchCatalog({ status: "unavailable", bootstrapError: describe(err) });
      return;
    }
    this.release = release;

    // Best-effort copy of the metadata next to the families (layout only).
    try {
      await this.deps.storage.write(
        "catalog/catalog-release.json",
        new TextEncoder().encode(text).buffer as ArrayBuffer,
      );
    } catch {
      // Non-fatal: the catalog itself is the source of truth.
    }

    const entries: CatalogFamilyEntry[] = [];
    for (const family of release.families) {
      const verified = await this.isVerified(family);
      entries.push({ family: family.family, status: verified ? "verified" : "pending" });
    }

    const pending = entries.filter((e) => e.status === "pending");
    if (pending.length > 0) {
      this.patchCatalog({ status: "downloading", families: entries, screen: true });
      for (const entry of pending) {
        this.patchFamily(entry.family, { status: "downloading", error: undefined });
        const family = release.families.find((f) => f.family === entry.family)!;
        try {
          await this.downloadFamily(release.origins, family);
          this.patchFamily(entry.family, { status: "verified" });
        } catch (err) {
          // Retry next launch: no marker is written, so the family stays
          // "missing" and downloads again (spec: failures never block).
          this.patchFamily(entry.family, { status: "failed", error: describe(err) });
        }
      }
      const failed = store.get().catalog.families.some((f) => f.status === "failed");
      this.patchCatalog({ status: failed ? "settled-partial" : "settled-complete", screen: false });
    } else {
      this.patchCatalog({ status: "settled-complete", families: entries });
    }

    await this.registerVerified(release);
  }

  /** Dismiss the progress screen; downloads continue in the background. */
  skip(): void {
    this.patchCatalog({ screen: false });
  }

  /** True when the family's marker and every metadata face are stored. */
  private async isVerified(family: ReleaseFamily): Promise<boolean> {
    const dir = familyDir(family.family);
    const keys = await this.deps.storage.list(`${dir}/`);
    const present = new Set(keys.map((key) => key.slice(dir.length + 1)));
    if (!present.has(COMPLETE_MARKER)) return false;
    return family.files.every((file) => present.has(file.file));
  }

  /** Fetch a zip through the ordered origin list, sha256-verified. */
  private async fetchVerified(
    origins: ReleaseOrigin[],
    zipName: string,
    sha256: string,
  ): Promise<ArrayBuffer> {
    const reasons: string[] = [];
    for (const origin of origins) {
      const url = `${origin.baseUrl.replace(/\/+$/, "")}/${zipName}`;
      try {
        const res = await this.fetchFn(url);
        if (!res.ok) {
          reasons.push(`${origin.id}: HTTP ${res.status}`);
          continue;
        }
        const buffer = await res.arrayBuffer();
        if ((await sha256Hex(buffer)) !== sha256) {
          reasons.push(`${origin.id}: sha256 mismatch`);
          continue;
        }
        return buffer;
      } catch (err) {
        reasons.push(`${origin.id}: ${describe(err)}`);
      }
    }
    throw new Error(`所有下载源均失败（${reasons.join("；")}）`);
  }

  private async downloadFamily(
    origins: ReleaseOrigin[],
    family: ReleaseFamily,
  ): Promise<void> {
    const zipBuffer = await this.fetchVerified(origins, family.zip, family.sha256);
    const entries = await unzip(zipBuffer);

    // Verify every face IN MEMORY before writing anything: a partially
    // written family must never look complete on a later launch.
    const verified = new Map<string, ArrayBuffer>();
    for (const file of family.files) {
      const data = entries.get(file.file);
      if (!data) throw new Error(`${family.zip} 中缺少 ${file.file}`);
      const actual = await sha256Hex(data);
      if (actual !== file.sha256) {
        throw new Error(`${file.file} sha256 校验失败`);
      }
      verified.set(
        file.file,
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
      );
    }

    const dir = familyDir(family.family);
    for (const [file, data] of verified) {
      await this.deps.storage.write(`${dir}/${file}`, data);
    }
    await this.deps.storage.write(`${dir}/${COMPLETE_MARKER}`, new ArrayBuffer(0));
  }

  /**
   * Register every verified family's primary face (Regular preferred) as a
   * LAZY FontFace: rows self-render, and the browser loads each face only
   * when something actually renders in it. Yields between families so a
   * large catalog never blocks the UI thread, and patches the store ONCE
   * at the end — one notification for the whole sweep (fonts + the
   * registered map together), not two per family (156 patches would
   * rebuild every picker row over and over for identical-looking
   * intermediate states).
   */
  /**
   * Register every verified family's faces as lazy FontFaces.
   *
   * Round 23 (owner items 1+6): the sweep runs in WAVES — the
   * curated-front families FIRST (they are the rows the open picker
   * shows), the rest in release order, flushing the accumulated
   * registrations every {@link SWEEP_FLUSH_WAVE} families so rows
   * refine from artifact stems to the fonts' own names progressively
   * instead of one late cliff at the very end (a full cold catalog
   * kept EVERY row on its stem for the whole sweep before). The
   * progress is observable: `data-catalog-sweep` on <html> reads
   * "running"/"done" (the e2e suite waits on it; a fresh boot paints
   * real names within the first wave).
   */
  private async registerVerified(release: CatalogRelease): Promise<void> {
    const front = new Set([
      ...CURATED_FRONT.en,
      ...CURATED_FRONT.cjk,
    ]);
    const ordered = [...release.families].sort(
      (a, b) =>
        (front.has(b.family) ? 1 : 0) - (front.has(a.family) ? 1 : 0),
    );
    const sweep =
      typeof document !== "undefined" ? document.documentElement : null;
    sweep?.setAttribute("data-catalog-sweep", "running");
    let sinceFlush = 0;
    for (const family of ordered) {
      const entry = store
        .get()
        .catalog.families.find((f) => f.family === family.family);
      if (!entry || entry.status !== "verified") continue;
      await this.ensureRegistered(family, { silent: true });
      // Round 23 (owner item 1): a multi-entry manifest family registers
      // every CUT's representative too — the picker's chips then read
      // the cuts' own name-table names straight away, without a click
      // to register them first. Weight-collapsed families count as
      // well: a group row (the WenKai collapse) shows the member's one
      // canonical cut as a chip, so its exact `family::variant` key
      // must exist. The cost mirrors the sweep's own (one storage read
      // + names-only parse per cut); single-entry families need
      // nothing here (the bare registration above already carries
      // them), and a cut whose variant word matches none of the
      // family's stored files is skipped — never silently registered
      // onto another cut's face.
      const manifestEntries = familyEntries(family.family);
      if (manifestEntries.length > 1) {
        const cuts = variantCuts({
          id: family.family,
          families: [family.family],
          entries: manifestEntries,
        });
        for (const cut of cuts) {
          if (
            !family.files.some((file) =>
              faceMatchesVariant(file, cut.entry.variant, family.family),
            )
          ) {
            continue;
          }
          await this.ensureRegistered(family, {
            silent: true,
            variant: cut.entry.variant,
          });
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
      sinceFlush++;
      if (sinceFlush >= SWEEP_FLUSH_WAVE) {
        this.flushPendingRegistrations();
        sinceFlush = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    this.flushPendingRegistrations();
    sweep?.setAttribute("data-catalog-sweep", "done");
  }

  /** The sweep's deferred state (see registerVerified), applied at once. */
  private pendingFonts: LoadedFont[] = [];
  private readonly pendingRegistrations = new Map<string, string>();

  private flushPendingRegistrations(): void {
    if (this.pendingFonts.length === 0 && this.pendingRegistrations.size === 0) {
      return;
    }
    const state = store.get();
    store.set({
      fonts: [...state.fonts, ...this.pendingFonts],
      catalog: {
        ...state.catalog,
        registered: {
          ...state.catalog.registered,
          ...Object.fromEntries(this.pendingRegistrations),
        },
      },
    });
    this.pendingFonts = [];
    this.pendingRegistrations.clear();
  }

  /**
   * Make one catalog family selectable (round 12, owner item 8): a pick
   * is the FAMILY, not one face. The representative face (Regular
   * preferred) registers through the same FontFace(arrayBuffer) path as
   * local files — it is the pick key, the preview face, and the identity
   * every surface reads — while the variant's OTHER stored faces
   * register as data-only records (no FontFace: they would collide with
   * the representative under the shared css family, and nothing renders
   * in them; the weight matrix comes from the service). Idempotent —
   * including mid-sweep, through the pending map (the sweep defers its
   * store patches). Returns the representative's cssFamily, or null
   * when the family is not usable. `silent` skips both store patches
   * (the sweep batches its own) AND the face set — the boot sweep
   * registers preview faces only, never a whole catalog's weights.
   *
   * `variant` (round 7, the variant chips): the manifest VARIANT the
   * user picked. It selects the stored faces whose file names match the
   * variant (the production release zip carries every variant's faces;
   * token matching — NF→NerdFont, Mono, HW, Screen, GB, TC, weights)
   * and rides the registration as the catalog identity, so the recipe
   * reference names exactly the chip's variant. Falls back to the
   * release document's own variant and the Regular-preferring primary.
   */
  async ensureRegistered(
    family: ReleaseFamily,
    opts: { silent?: boolean; variant?: string } = {},
  ): Promise<string | null> {
    const variant = opts.variant ?? family.variant ?? null;
    const cacheKey =
      variant === null ? family.family : `${family.family}::${variant}`;
    const existing =
      store.get().catalog.registered[cacheKey] ??
      this.pendingRegistrations.get(cacheKey);
    if (existing) return existing;

    const dir = familyDir(family.family);
    const primary = pickVariantRepresentative(family.files, variant, family.family);
    if (primary === undefined) return null;
    const buffer = await this.deps.storage.read(`${dir}/${primary.file}`);
    if (!buffer) return null;
    // The representative's OWN parsed family: the cut the face set
    // keeps (a release zip may carry several sub-variants' faces; only
    // the representative's family is the pick).
    const repFamily = parseFontMeta(buffer, { coverage: false }).family;
    try {
      const { font } = await registerFontBytes(buffer, {
        family: family.family,
        fileName: primary.file,
        origin: "catalog",
        lazy: true,
        silent: opts.silent,
        // The on-disk path (Tauri layout): recipes reference the exact
        // file the sidecar's --font-dir already scans. Null in browser
        // storage — the synthesize flow falls back to the listing match.
        path: this.deps.storage.absPath?.(`${dir}/${primary.file}`) ?? undefined,
        // The catalog identity (round 6): the synthesize flow names the
        // manifest family + variant in the recipe when the service can
        // resolve it, instead of a bare file name.
        catalog: { family: family.family, variant },
      });
      if (opts.silent) {
        // The sweep collects these and patches the store once at the end.
        this.pendingRegistrations.set(cacheKey, font.cssFamily);
        this.pendingFonts.push(font);
      } else {
        this.patchCatalog({
          registered: {
            ...store.get().catalog.registered,
            [cacheKey]: font.cssFamily,
          },
        });
      }
      // The pick's face set (round 12): every fetched face of the
      // family+variant, registered in the BACKGROUND so the pick itself
      // stays instant — the rail card and the grid only ever wait on
      // the representative. Never on the boot sweep (silent).
      if (!opts.silent) {
        void this.registerFamilyFaces(family, variant, primary.file, repFamily);
      }
      return font.cssFamily;
    } catch {
      // A stored face that no longer parses stays a plain picker row.
      return null;
    }
  }

  /** Family face-set sweeps in flight (one per family+variant). */
  private readonly faceSetRuns = new Set<string>();

  /**
   * Register the variant's non-representative faces as data-only
   * records (round 12, owner item 8). Yields between faces so a large
   * family never blocks the UI thread; patches the store ONCE at the
   * end. Faces whose own name-table family differs from the
   * representative's cut are skipped — a pick carries ONE family, the
   * one the user picked (a Nerd Fonts zip mixes NL/Mono/Propo cuts in
   * one artifact). Idempotent per file: already-recorded faces (an
   * earlier pick, a mid-flight sweep) are not re-registered.
   */
  private async registerFamilyFaces(
    family: ReleaseFamily,
    variant: string | null,
    repFile: string,
    repCssFamily: string,
  ): Promise<void> {
    const runKey = `${family.family}::${variant}`;
    if (this.faceSetRuns.has(runKey)) return;
    this.faceSetRuns.add(runKey);
    try {
      const dir = familyDir(family.family);
      const identity = { family: family.family, variant };
      const recorded = (file: string): boolean =>
        store
          .get()
          .fonts.some(
            (f) =>
              f.catalog?.family === identity.family &&
              f.catalog?.variant === identity.variant &&
              f.fileName === file,
          );
      // Round 29: parse the whole cut first (the representative's own
      // file included), resolve the (weight, style) slots, and register
      // only the winners. A cut that pools a publisher's style
      // side-cuts (Oblique faces flagged upright, Upright-Italic faces
      // flagged italic — one umbrella typographic family) otherwise
      // puts two FontFaces on one descriptor and the browser's slot
      // match becomes arbitrary: normal text can land on slanted ink
      // (the round-29 report). The face whose flags describe its ink
      // keeps the slot, exactly like the core build's resolver.
      interface FacePlan {
        file: string;
        buffer: ArrayBuffer;
        weight: number;
        italic: boolean;
        consistent: boolean;
        names: ReturnType<typeof parseFontMeta>["names"];
      }
      const plans: FacePlan[] = [];
      for (const face of variantFaceFiles(family.files, variant, family.family)) {
        if (recorded(face.file)) continue;
        const buffer = await this.deps.storage.read(`${dir}/${face.file}`);
        if (buffer === null) continue;
        try {
          // Names only — the cmap enumeration is the expensive half of
          // the parse and no consumer reads a sibling's coverage (the
          // grid renders the representative; the matrix comes from the
          // service). One read per face, one yield between faces.
          const meta = parseFontMeta(buffer, { coverage: false });
          if (meta.family !== repCssFamily) continue;
          plans.push({
            file: face.file,
            buffer,
            weight: meta.weight,
            italic: meta.italic,
            consistent: meta.styleConsistent,
            names: meta.names,
          });
        } catch {
          // A face that no longer parses is simply absent from the set.
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const winners = new Map<string, FacePlan>();
      for (const plan of plans) {
        const key = `${plan.weight}/${plan.italic ? "italic" : "normal"}`;
        const held = winners.get(key);
        if (held === undefined || (!held.consistent && plan.consistent)) {
          winners.set(key, plan);
        }
      }
      const faces: LoadedFont[] = [];
      for (const plan of winners.values()) {
        if (plan.file === repFile) continue; // the representative is the pick
        // Round 28 (owner item: bold parity): the sibling registers
        // as a REAL FontFace with its own weight/style descriptor —
        // the same discipline local loads follow since round 20.
        // Before, a bold-weight sibling was a data-only record, the
        // family resolved to its single 400 face, and the scene
        // preview drew the browser's SYNTHETIC bold where the real
        // face existed — the preview lied about the font.
        document.fonts.add(
          new FontFace(
            repCssFamily,
            plan.buffer,
            plan.italic
              ? { weight: String(plan.weight), style: "italic" }
              : { weight: String(plan.weight) },
          ),
        );
        faces.push({
          cssFamily: repCssFamily,
          family: family.family,
          names: plan.names,
          fileName: plan.file,
          origin: "catalog",
          path: this.deps.storage.absPath?.(`${dir}/${plan.file}`) ?? undefined,
          catalog: { family: identity.family, variant: identity.variant },
          codepoints: [],
        });
      }
      if (faces.length > 0) {
        store.set({ fonts: [...store.get().fonts, ...faces] });
      }
    } finally {
      this.faceSetRuns.delete(runKey);
    }
  }

  private patchCatalog(patch: Partial<CatalogState>): void {
    store.set({ catalog: { ...store.get().catalog, ...patch } });
  }

  private patchFamily(family: string, patch: Partial<CatalogFamilyEntry>): void {
    const families = store
      .get()
      .catalog.families.map((f) => (f.family === family ? { ...f, ...patch } : f));
    this.patchCatalog({ families });
  }
}

/* ---------- module singleton (the pickers reach the live manager) ---------- */

let defaultManager: CatalogManager | null = null;

export function setDefaultManager(manager: CatalogManager): void {
  defaultManager = manager;
}

export function getDefaultManager(): CatalogManager | null {
  return defaultManager;
}
