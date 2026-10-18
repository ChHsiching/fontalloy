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
 *   so rows self-render without the page ever holding font bytes;
 * - `GET /catalog/stars` — the launch-cached GitHub star counts (user
 *   story 25): the SERVE runs the once-per-launch repo sweep and this
 *   module merely polls it while it fetches, overlaying whatever
 *   landed onto the picker meta lines (the deleted frontend stars
 *   fetcher's curated seed in data/curated-meta.json stays the
 *   offline fallback).
 *
 * Picking a family (ticket #32, the MEMORY RED LINE) registers the
 * cut's faces as URL FontFaces straight from the family document —
 * one per (weight, style) slot winner, each with its descriptor, lazy
 * per used descriptor. The page NEVER constructs an ArrayBuffer for a
 * catalog font: no byte fetch, no sfnt parse, no cmap enumeration in
 * the pick path (the registry record carries the document's own
 * metadata; the store's `codepoints` stay empty, and the serve's
 * resolve answers remain the coloring truth — ticket #35). Unloading
 * the pick evicts the faces (fonts/registry.evictCssFamily, wired by
 * the picker's repeat-click unload).
 *
 * Observability (the round-30 diagnostic, formalized): the boot sets
 * `data-catalog-sweep` = running/done on <html> — the settle signal
 * the e2e suite waits on — and every status/families fetch carries an
 * abort timeout (a hung fetch must never leave the pickers empty for
 * minutes; the round-30 lesson).
 */

import {
  store,
  type CatalogFaceDoc,
  type CatalogFamilyDoc,
  type CatalogFamilyProgress,
  type CatalogState,
  type LoadedFont,
} from "../state";
import { registerCatalogUrlFaces } from "../fonts/registry";
import type { CpIntervals } from "../state";
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

/* ---------- the stars overlay (the serve's own launch sweep) ---------- */

/** The GET /catalog/stars document (always a snapshot, never an error). */
interface CatalogStarsDoc {
  state: "fetching" | "done" | "disabled";
  stars: Record<string, number>;
}

const serveStars = new Map<string, number>();
const starListeners = new Set<() => void>();

/**
 * The serve-side star count a picker row shows (undefined when the
 * launch sweep has not landed one — the curated seed decides then).
 */
export function starsFor(family: string): number | undefined {
  return serveStars.get(family);
}

/** Subscribe to serve star-count updates (the pickers re-render). */
export function subscribeStars(fn: () => void): () => void {
  starListeners.add(fn);
  return () => starListeners.delete(fn);
}

/**
 * Poll the serve's launch-cached stars while its sweep runs: the
 * successor of the deleted frontend fetcher (catalog/stars.ts — one
 * bounded GitHub sweep per SERVE launch now, spec #25 story 25). The
 * page's only job is to pick up whatever landed; a transport failure
 * ends the poll (offline is a state, not an error — the curated seed
 * in the picker's display data stands).
 */
async function pollStars(base: string): Promise<void> {
  for (;;) {
    let doc: CatalogStarsDoc;
    try {
      doc = await getJson<CatalogStarsDoc>(`${base}/catalog/stars`);
    } catch {
      return;
    }
    let changed = false;
    for (const [family, count] of Object.entries(doc.stars)) {
      if (serveStars.get(family) !== count) {
        serveStars.set(family, count);
        changed = true;
      }
    }
    if (changed) for (const fn of [...starListeners]) fn();
    if (doc.state !== "fetching") return;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/* ---------- the boot poller ---------- */

let started = false;

/**
 * Boot the serve catalog: fire-and-forget from main.ts — nothing here
 * may delay the workspace. Waits for the service connection (the
 * synthesize flow's own probe), then polls the status machine until it
 * settles, refreshing the family documents (and their preview faces)
 * along the way. The stars poller rides along — independent on
 * purpose: the sweep-attribute settle signal is the catalog status's
 * own truth and never waits on the stars sweep.
 */
export function startCatalogServe(): void {
  if (started) return;
  started = true;
  const begin = (base: string): void => {
    void runCatalogPoll(base);
    void pollStars(base);
  };
  const unsubscribe = synthStore.subscribe(() => {
    const client = synthStore.get().service.client;
    if (client !== null) {
      unsubscribe();
      begin(client.baseUrl);
    }
  });
  if (synthStore.get().service.client !== null) {
    unsubscribe();
    begin(synthStore.get().service.client!.baseUrl);
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

/* ---------- the pick path (ticket #32: URL FontFaces only) ---------- */

/** The cut a pick resolves to: the variant's own, else the default. */
function cutOf(doc: CatalogFamilyDoc, variant: string | null): CatalogFamilyDoc["cuts"][number] | null {
  const exact =
    variant !== null ? doc.cuts.find((cut) => cut.variant === variant) : null;
  return exact ?? doc.cuts.find((cut) => cut.def) ?? doc.cuts[0] ?? null;
}

/**
 * The cut's (weight, style) slot winners (ticket #32): the document's
 * face list can carry several faces for one slot (the round-29
 * side-cut layout — sheared ink under upright flags); one face per
 * slot keeps the browser's match deterministic, exactly like the local
 * path's resolveStyleSlots. The winner prefers a face the placeholder
 * rules trust (the document's own honest-coverage flag), file order
 * among equals — the serve's scan order is stable.
 */
function slotWinners(
  faces: readonly CatalogFaceDoc[],
): CatalogFaceDoc[] {
  const winners = new Map<string, CatalogFaceDoc>();
  for (const face of faces) {
    const key = `${face.weight}/${face.italic ? "italic" : "normal"}`;
    const held = winners.get(key);
    if (held === undefined || (held.placeholder && !face.placeholder)) {
      winners.set(key, face);
    }
  }
  return [...winners.values()];
}

/**
 * Make one catalog family selectable (ticket #32): register the cut's
 * slot winners as URL FontFaces under the manifest family id — one per
 * (weight, style), each with its descriptor, lazy per used descriptor
 * — and record ONE document-driven registry entry. No byte is ever
 * fetched into the page here: the browser pulls a face when something
 * renders in its weight/style. Returns the registered css family, or
 * null when the family carries no usable face.
 */
export function ensureCatalogRegistered(
  family: string,
  variant: string | null,
): string | null {
  const client = synthStore.get().service.client;
  if (client === null) return null;
  const doc = store
    .get()
    .catalog.documents.find((entry) => entry.family === family);
  if (doc === undefined) return null;
  const cut = cutOf(doc, variant);
  if (cut === null) return null;
  const identity = { family, variant: cut.variant || null };
  const existing = store
    .get()
    .fonts.find(
      (font) =>
        font.catalog?.family === identity.family &&
        font.catalog?.variant === identity.variant,
    );
  if (existing !== undefined) return existing.cssFamily;
  const winners = slotWinners(cut.faces);
  if (winners.length === 0) return null;
  // The coverage the counters read (ticket #36): the representative
  // face's scanned run-length intervals — the same face the record's
  // fileName names, falling back to the first slot winner (a dropped
  // side-cut is never the representative in practice).
  const coverageFace =
    winners.find((face) => face.file === cut.representative) ?? winners[0]!;
  registerCatalogUrlFaces(
    family,
    winners.map((face) => ({
      url: `${client.baseUrl}${face.href}`,
      weight: face.weight,
      style: face.italic ? ("italic" as const) : ("normal" as const),
    })),
  );
  // The registry record: document-driven metadata only. `names` rides
  // the serve's own name-table scan (display_name); the coverage is
  // the representative face's run-length intervals from the same scan
  // (ticket #36 — the counters and the missing view compute over
  // them, never a page-side cmap parse).
  // The picked cut's OWN display name wins: a non-default cut (e.g. the
  // NF cut) must not be shadowed by the family-level display_name — the
  // pre-merge pick path parsed the picked binary's own name table, and
  // the family name only stands in when the cut carries none.
  const displayName =
    cut.display_name ?? doc.display_name ?? cut.label ?? family;
  const font: LoadedFont = {
    cssFamily: family,
    family,
    names: { family: displayName, display: displayName },
    fileName: cut.representative ?? winners[0]!.file,
    origin: "catalog",
    catalog: identity,
    intervals: coverageFace.coverage.intervals as unknown as CpIntervals,
    placeholderIntervals: coverageFace.coverage
      .placeholder_intervals as unknown as CpIntervals,
  };
  // One record per catalog family: a prior pick of another variant is
  // the stale identity — every label surface resolves by css family
  // (find-first), so the record must follow the LATEST pick, exactly as
  // the pre-merge pick path's per-binary name key moved with the cut.
  store.set({
    fonts: [
      ...store.get().fonts.filter((prior) => prior.catalog?.family !== family),
      font,
    ],
  });
  return family;
}
