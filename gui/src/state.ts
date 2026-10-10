/**
 * App state: one store, region-scoped re-renders.
 *
 * The store is deliberately tiny — no framework. ADR-0004 requires precise
 * DOM node control (the font-picker popup node must survive re-renders, rows
 * rebuild only), so each UI region subscribes and patches itself.
 */

export type ContentMode = "charmap" | "scene";

/** One local font file loaded through the FontFace(arrayBuffer) path. */
export interface LoadedFont {
  /** CSS font-family key the face is registered under (the parsed family). */
  cssFamily: string;
  /** Display family name (name table, nameID 16 preferred over 1). */
  family: string;
  fileName: string;
  /** Sorted covered codepoints from the cmap table. */
  codepoints: number[];
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
}

type Listener = (state: AppState) => void;

export interface Store {
  get(): AppState;
  set(patch: Partial<AppState>): void;
  subscribe(fn: Listener): () => void;
}

export function createStore(initial: AppState): Store {
  let state = initial;
  const listeners = new Set<Listener>();
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

export const store = createStore({
  fonts: [],
  selected: { en: null, cjk: null },
  mode: "charmap",
  categoryId: "all",
  page: 1,
  selectedCodepoint: null,
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
