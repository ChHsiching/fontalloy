import {
  store,
  type CatalogFamilyEntry,
  type CatalogState,
} from "../state";
import { registerFontBytes } from "../fonts/registry";
import type { LoadedFont } from "../state";
import type { BlobStorage } from "../platform/storage";
import { parseCatalogRelease, type CatalogRelease, type ReleaseFamily, type ReleaseOrigin } from "./release";
import { unzip } from "./zip";

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
  private async registerVerified(release: CatalogRelease): Promise<void> {
    for (const family of release.families) {
      const entry = store
        .get()
        .catalog.families.find((f) => f.family === family.family);
      if (!entry || entry.status !== "verified") continue;
      await this.ensureRegistered(family, { silent: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    this.flushPendingRegistrations();
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
   * Make one catalog family selectable: read its primary face from storage,
   * register it through the same FontFace(arrayBuffer) path as local files,
   * and record family -> cssFamily for the picker rows. Idempotent —
   * including mid-sweep, through the pending map (the sweep defers its
   * store patches). Returns the cssFamily, or null when the family is not
   * usable. `silent` skips both store patches (the sweep batches its own).
   */
  async ensureRegistered(
    family: ReleaseFamily,
    opts: { silent?: boolean } = {},
  ): Promise<string | null> {
    const existing =
      store.get().catalog.registered[family.family] ??
      this.pendingRegistrations.get(family.family);
    if (existing) return existing;

    const dir = familyDir(family.family);
    const primary =
      family.files.find((f) => /regular/i.test(f.file)) ?? family.files[0];
    const buffer = await this.deps.storage.read(`${dir}/${primary.file}`);
    if (!buffer) return null;
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
        catalog: { family: family.family, variant: family.variant ?? null },
      });
      if (opts.silent) {
        // The sweep collects these and patches the store once at the end.
        this.pendingRegistrations.set(family.family, font.cssFamily);
        this.pendingFonts.push(font);
      } else {
        this.patchCatalog({
          registered: {
            ...store.get().catalog.registered,
            [family.family]: font.cssFamily,
          },
        });
      }
      return font.cssFamily;
    } catch {
      // A stored face that no longer parses stays a plain picker row.
      return null;
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
