/**
 * App state: one store, region-scoped re-renders.
 *
 * The store is deliberately tiny — no framework. ADR-0004 requires precise
 * DOM node control (the font-picker popup node must survive re-renders, rows
 * rebuild only), so each UI region subscribes and patches itself.
 */

export type ContentMode = "charmap" | "scene";

/** How a font face entered the registry (local file vs catalog download). */
export type FontOrigin = "local" | "catalog";

/** One font face registered through the FontFace(arrayBuffer) path. */
export interface LoadedFont {
  /** CSS font-family key the face is registered under (the parsed family). */
  cssFamily: string;
  /**
   * Display family name: the parsed name for local files, the catalog
   * metadata family for downloaded fonts (pickers are metadata-driven).
   */
  family: string;
  fileName: string;
  origin: FontOrigin;
  /**
   * The on-disk path when the platform knows one (catalog storage, the
   * Tauri file dialog). Undefined in the plain browser — the synthesize
   * flow then resolves the path against the service's font listing.
   */
  path?: string;
  /** Sorted covered codepoints from the cmap table. */
  codepoints: number[];
}

/* ---------- catalog (issue #17: first-run download) ---------- */

export type CatalogFamilyStatus = "pending" | "downloading" | "verified" | "failed";

/** One catalog family as the UI sees it (metadata family + download state). */
export interface CatalogFamilyEntry {
  family: string;
  status: CatalogFamilyStatus;
  /** Human-readable failure reason (shown inline, never hover-only). */
  error?: string;
}

export type CatalogStatus =
  /** No bootstrap configured (plain-browser builds and default tests). */
  | "none"
  /** Fetching catalog-release.json. */
  | "bootstrapping"
  /** Downloading missing families behind the progress screen. */
  | "downloading"
  /** Run finished; every metadata family is verified in storage. */
  | "settled-complete"
  /** Run finished; some families failed and retry on the next launch. */
  | "settled-partial"
  /** Bootstrap failed (offline / bad metadata); local fonts unaffected. */
  | "unavailable";

export interface CatalogState {
  status: CatalogStatus;
  bootstrapError?: string;
  families: CatalogFamilyEntry[];
  /** Metadata family -> cssFamily, once the family's face is registered. */
  registered: Record<string, string>;
  /** First-run progress screen visible (dismissable; never blocks). */
  screen: boolean;
}

export interface AppState {
  /** All successfully loaded local fonts (the picker rows). */
  fonts: LoadedFont[];
  /** Selected cssFamily keys for the base (en) and donor (cjk) pickers. */
  selected: { en: string | null; cjk: string | null };
  mode: ContentMode;
  /** Active unicode block id ("all" = the aggregate view). */
  categoryId: string;
  /** 1-based page within the active category. */
  page: number;
  /** Codepoint currently selected in the grid (details strip). */
  selectedCodepoint: number | null;
  catalog: CatalogState;
}

type Listener<T> = (state: T) => void;

export interface Store<T> {
  get(): T;
  set(patch: Partial<T>): void;
  subscribe(fn: Listener<T>): () => void;
}

/** Generic store factory: the GUI workspace and the web recipe builder
 *  (webapp/state.ts) are two instances of the same pattern. */
export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<Listener<T>>();
  return {
    get: () => state,
    set(patch) {
      state = { ...state, ...patch };
      for (const fn of listeners) fn(state);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

export const store = createStore<AppState>({
  fonts: [],
  selected: { en: null, cjk: null },
  mode: "charmap",
  categoryId: "all",
  page: 1,
  selectedCodepoint: null,
  catalog: { status: "none", families: [], registered: {}, screen: false },
});

/** Distinct codepoints covered by the two selected fonts (union). */
export function selectedCoverage(state: AppState): number[] {
  const picks = [state.selected.en, state.selected.cjk]
    .map((key) => state.fonts.find((f) => f.cssFamily === key))
    .filter((f): f is LoadedFont => f !== undefined);
  if (picks.length === 0) return [];
  const out = new Set<number>();
  for (const f of picks) for (const cp of f.codepoints) out.add(cp);
  return [...out].sort((a, b) => a - b);
}
