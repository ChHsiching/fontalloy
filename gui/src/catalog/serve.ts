/**
 * The serve-owned catalog, page side (ticket #30, spec #25).
 *
 * The old first-run downloader (manager.ts — deleted by #33) fetched
 * the release document, the zips, and every font byte into the page.
 * This module is its REPLACEMENT: a thin poller over the serve's own
 * catalog endpoints. The page consumes
 *
 * - `GET /catalog/status` — the sync state machine (issue #26):
 *   bootstrapping → ready | unavailable + error string; the first-run
 *   progress screen, the picker loading row, and the picker footer are
 *   all driven by it, and when the catalog is unavailable the footer
 *   shows the serve's error string VERBATIM;
 * - `GET /catalog/families` — the family documents (issue #38): the
 *   display names from the REAL name tables, the cuts, per-family
 *   readiness. The picker's rows render from these;
 * - `GET /catalog/families/{family}/preview` — the name-glyph subset
 *   each row registers as its OWN lazy URL FontFace (`fa-cat-<family>`),
 *   so rows self-render without the page ever holding font bytes.
 *
 * Picking a family still goes through the EXISTING registry path
 * (fonts/registry.registerFontBytes): the representative's bytes are
 * fetched from `GET /catalog/faces/{family}/{file}` on demand and
 * registered exactly like a local file (ticket #32 reworks that path).
 *
 * Observability (the round-30 diagnostic, formalized): the boot sets
 * `data-catalog-sweep` = running/done on <html> — the settle signal
 * the e2e suite waits on — and every status/families fetch carries an
 * abort timeout (a hung fetch must never leave the pickers empty for
 * minutes; the round-30 lesson).
 */

import {
  store,
  type CatalogFamilyDoc,
  type CatalogFamilyProgress,
  type CatalogState,
} from "../state";
import { registerFontBytes } from "../fonts/registry";
import { synthStore } from "../service/state";

/** The GET /catalog/status document (issue #26's state machine). */
export interface CatalogStatusDoc {
  state: "bootstrapping" | "ready" | "unavailable";
  configured: boolean;
  error: string | null;
  tag: string | null;
  catalog_dir: string | null;
  families: Array<{ family: string; state: CatalogFamilyProgress["state"]; error: string | null }>;
}

/** The GET /catalog/families document (issue #38). */
export interface CatalogFamiliesDoc {
  scanning: boolean;
  families: CatalogFamilyDoc[];
}

/** Poll cadence while the sync runs / the documents scan. */
const POLL_MS = 500;
/** Every control fetch is bounded (the round-30 hung-fetch lesson). */
const FETCH_TIMEOUT_MS = 30_000;

function timeoutInit(): RequestInit {
  return typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
    ? { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
    : {};
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function getJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, timeoutInit());
  } catch (err) {
    throw new Error(
      err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")
        ? `目录状态获取超时（${Math.round(FETCH_TIMEOUT_MS / 1000)} 秒）。`
        : "目录服务不可达。",
    );
  }
  if (!res.ok) {
    throw new Error(`目录状态获取失败：HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

function patchCatalog(patch: Partial<CatalogState>): void {
  store.set({ catalog: { ...store.get().catalog, ...patch } });
}

/* ---------- the preview-subset FontFaces (self-rendering rows) ---------- */

/** The css family a catalog family's preview subset registers under. */
export function previewCssFamily(family: string): string {
  return `fa-cat-${family}`;
}

const previewRegistered = new Set<string>();

/**
 * Register every scanned family's preview subset as its OWN lazy URL
 * FontFace — the row's font-family stack. The browser fetches the tiny
 * subset only when something actually renders in it, so a full catalog
 * costs 96 URL faces, not 96 font binaries.
 */
function registerPreviewFonts(documents: readonly CatalogFamilyDoc[], base: string): void {
  if (typeof document === "undefined") return;
  for (const doc of documents) {
    if (doc.preview === null || previewRegistered.has(doc.family)) continue;
    previewRegistered.add(doc.family);
    try {
      document.fonts.add(
        new FontFace(previewCssFamily(doc.family), `url(${base}${doc.preview})`),
      );
    } catch {
      previewRegistered.delete(doc.family);
    }
  }
}

/* ---------- the boot poller ---------- */

let started = false;

/**
 * Boot the serve catalog: fire-and-forget from main.ts — nothing here
 * may delay the workspace. Waits for the service connection (the
 * synthesize flow's own probe), then polls the status machine until it
 * settles, refreshing the family documents (and their preview faces)
 * along the way.
 */
export function startCatalogServe(): void {
  if (started) return;
  started = true;
  const unsubscribe = synthStore.subscribe(() => {
    const client = synthStore.get().service.client;
    if (client !== null) {
      unsubscribe();
      void runCatalogPoll(client.baseUrl);
    }
  });
  if (synthStore.get().service.client !== null) {
    unsubscribe();
    void runCatalogPoll(synthStore.get().service.client!.baseUrl);
  }
}

let screenDismissed = false;

/** Dismiss the first-run progress screen; the serve's sync continues. */
export function skipCatalogScreen(): void {
  screenDismissed = true;
  patchCatalog({ screen: false });
}

/**
 * One poll pass over the serve's catalog endpoints, looping while the
 * sync runs or the documents scan. The loop is the ONLY writer of the
 * catalog's status fields; every patch is a full snapshot.
 */
async function runCatalogPoll(base: string): Promise<void> {
  const sweep =
    typeof document !== "undefined" ? document.documentElement : null;
  patchCatalog({ status: "connecting" });
  sweep?.setAttribute("data-catalog-sweep", "running");
  for (;;) {
    let status: CatalogStatusDoc;
    try {
      status = await getJson<CatalogStatusDoc>(`${base}/catalog/status`);
    } catch (err) {
      patchCatalog({
        status: "unavailable",
        error: describe(err),
        screen: false,
      });
      break;
    }
    if (!status.configured) {
      // A serve without a catalog (local-fonts-only): no rows, no
      // note, no screen — exactly the no-catalog pages of before.
      patchCatalog({ status: "none", error: undefined, screen: false });
      break;
    }
    patchCatalog({
      status: status.state,
      error: status.state === "unavailable" ? (status.error ?? "") : undefined,
      progress: status.families,
      screen: status.state === "bootstrapping" && !screenDismissed,
    });
    let scanning = false;
    try {
      const doc = await getJson<CatalogFamiliesDoc>(`${base}/catalog/families`);
      scanning = doc.scanning;
      patchCatalog({ documents: doc.families, scanning });
      registerPreviewFonts(doc.families, base);
    } catch {
      // The status is the truth; documents refresh on the next pass.
    }
    if (
      (status.state === "ready" && !scanning) ||
      status.state === "unavailable"
    ) {
      patchCatalog({ screen: false });
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  sweep?.setAttribute("data-catalog-sweep", "done");
}

/* ---------- the pick path (the EXISTING registry path) ---------- */

/** The cut a pick resolves to: the variant's own, else the default. */
function cutOf(doc: CatalogFamilyDoc, variant: string | null): CatalogFamilyDoc["cuts"][number] | null {
  const exact =
    variant !== null ? doc.cuts.find((cut) => cut.variant === variant) : null;
  return exact ?? doc.cuts.find((cut) => cut.def) ?? doc.cuts[0] ?? null;
}

/**
 * Make one catalog family selectable: fetch the cut's representative
 * face from the serve (the page's ONLY font-byte fetch, on the user's
 * click) and register it through the same FontFace path local files
 * take (fonts/registry.registerFontBytes — reworked by #32). Returns
 * the registered css family, or null when the family is not usable.
 */
export async function ensureCatalogRegistered(
  family: string,
  variant: string | null,
): Promise<string | null> {
  const client = synthStore.get().service.client;
  if (client === null) return null;
  const doc = store
    .get()
    .catalog.documents.find((entry) => entry.family === family);
  if (doc === undefined) return null;
  const cut = cutOf(doc, variant);
  if (cut === null) return null;
  const file = cut.representative ?? cut.faces[0]?.file ?? null;
  if (file === null) return null;
  const identity = { family, variant: cut.variant || null };
  const existing = store
    .get()
    .fonts.find(
      (font) =>
        font.catalog?.family === identity.family &&
        font.catalog?.variant === identity.variant,
    );
  if (existing !== undefined) return existing.cssFamily;
  let bytes: ArrayBuffer;
  try {
    const res = await fetch(
      `${client.baseUrl}/catalog/faces/${family}/${file}`,
      timeoutInit(),
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = await res.arrayBuffer();
  } catch (err) {
    throw new Error(`无法载入目录字体 ${family}：${describe(err)}`);
  }
  try {
    const { font } = await registerFontBytes(bytes, {
      family,
      fileName: file,
      origin: "catalog",
      catalog: identity,
    });
    return font.cssFamily;
  } catch {
    return null;
  }
}
