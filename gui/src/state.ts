/**
 * App state: one store, region-scoped re-renders.
 *
 * The store is deliberately tiny — no framework. ADR-0004 requires precise
 * DOM node control (the font-picker popup node must survive re-renders, rows
 * rebuild only), so each UI region subscribes and patches itself.
 */

import type { EditorRule } from "./precedence/model";
import { newRule } from "./precedence/model";
import type { CpInterval, CpIntervals } from "./unicode/intervalMath";

export type { CpInterval, CpIntervals };
import { unionIntervals } from "./unicode/intervalMath";
import presetsData from "./data/presets.json";

export type ContentMode = "charmap" | "scene";

/* ---------- name-table identity (document-derived, ticket #36) ---------- */

/**
 * The name-table strings one registered font carries. Since the
 * mirrors died, these strings arrive from the SERVE's own name-table
 * scan (the family/local/system documents' identity fields) — the
 * record keeps the shape every display surface already reads.
 */
export interface FontNames {
  /** The name-table family (the document's scanned family/display). */
  family: string;
  /** The name-table subfamily, when the document carried one. */
  subfamily?: string;
  /** The composed display name (family + distinguishing subfamily). */
  display: string;
}

/**
 * The user-facing display name of a family + subfamily pair: the
 * author's own full name, with nothing appended when the subfamily is
 * the everyday member (Regular / 标准) or already part of the family
 * string.
 */
export function composeDisplay(
  family: string,
  subfamily: string | undefined,
): string {
  if (subfamily === undefined || /^(regular|标准)$/i.test(subfamily)) {
    return family;
  }
  return family.includes(subfamily) ? family : `${family} ${subfamily}`;
}

/* ---------- synthesis settings (issue #19) ---------- */

/**
 * Weight merge mode — the ratified design's three options. Maps onto the
 * recipe `weights` selection: the output's weight slots can only come
 * from the base (English) font's faces (ADR-0006); donors contribute
 * glyphs per slot by nearest match, never new slots.
 */
export type WeightMergeMode = "nearest" | "base" | "donor";

/**
 * CJK–Latin baseline alignment — the vertical/scale school. The shared
 * baseline and the em box are ADR-0003 invariants; this chooses the
 * scale school (`normalization.mode`): `plain` the DEFAULT (round 26,
 * owner ruling — direct combination: donor glyphs verbatim, their own
 * advances; the preview shows exactly what lands in the output), with
 * the harmonization schools opt-in — `auto` the grid-scale-capped-by-
 * the-optical-ratio (round 20's fix), `grid` the bare terminal-grid
 * school, `optical` the Han-ink-at-ratio one.
 */
export type BaselineMode = "plain" | "auto" | "grid" | "optical";

/**
 * CJK character width — the wide-advance factor over the Latin cell
 * (the prototype's 三档 setting: 2 / 1.8 / 1.5). A real pipeline knob
 * (`normalization.width_factor`); 2 is the UAX #11 default.
 */
export type CjkWidthMode = 2 | 1.8 | 1.5;

/**
 * Output format — the artifact's container (the recipe's
 * `output.format`; round 12, owner item 7). The machine layer already
 * builds all three; the setting only chooses.
 */
export type OutputFormat = "auto" | "ttf" | "ttc" | "woff2";

export interface SynthesisSettings {
  weightMode: WeightMergeMode;
  baseline: BaselineMode;
  cjkWidth: CjkWidthMode;
  outputFormat: OutputFormat;
}

export const DEFAULT_SETTINGS: SynthesisSettings = {
  weightMode: "nearest",
  baseline: "plain",
  cjkWidth: 2,
  outputFormat: "auto",
};

/** How a font face entered the registry (local file vs catalog download). */
/**
 * Round 24 (owner item 3): fonts installed in the OPERATING SYSTEM,
 * enumerated by the service from the platform's font directories.
 */
export type FontOrigin = "local" | "catalog" | "system";

/**
 * The catalog identity of a downloaded font (round 6): the manifest
 * family + variant the recipe's catalog-family reference names. Only
 * catalog-origin fonts carry it; local files resolve to paths.
 */
export interface FontCatalogIdentity {
  family: string;
  /** The manifest variant (null when the release metadata carried none). */
  variant: string | null;
}

/** One font face registered through a URL FontFace path. */
export interface LoadedFont {
  /** CSS font-family key the face is registered under (the parsed family). */
  cssFamily: string;
  /**
   * The metadata family: the scanned name-table family for local and
   * system fonts, the catalog manifest family for catalog picks.
   * NOT the display name — every display surface reads `names.display`
   * (round 9, owner item 2).
   */
  family: string;
  /** The name-table strings the serve's own scan read (round 9). */
  names?: FontNames;
  fileName: string;
  origin: FontOrigin;
  /**
   * The on-disk path when the platform knows one (the Tauri file
   * dialog; the serve's scan path for local and uploaded picks —
   * recipes reference it verbatim against the serve).
   */
  path?: string;
  /** The catalog identity (manifest family + variant), for catalog picks. */
  catalog?: FontCatalogIdentity;
  /**
   * The face's honest (placeholder-filtered) coverage as sorted,
   * disjoint run-length intervals from the serve's scan (ticket #36)
   * — the counters and the missing view compute over these; the
   * representative record carries them, data-only siblings do not.
   */
  intervals: CpIntervals;
  /**
   * The suspected-placeholder codepoints, same run shape: the grid
   * keeps rendering the font's own glyph under the missing style for
   * these (round 20). Absent for the data-only sibling records.
   */
  placeholderIntervals?: CpIntervals;
}

/* ---------- catalog (ticket #30: the serve-owned catalog) ---------- */

/**
 * The serve sync's per-family progress states (`GET /catalog/status`),
 * verbatim from the state machine (issue #26): pending → downloading
 * → extracting → verifying → done | failed.
 */
export type CatalogFamilySyncState =
  | "pending"
  | "downloading"
  | "extracting"
  | "verifying"
  | "done"
  | "failed";

/** One family's sync progress inside the status document. */
export interface CatalogFamilyProgress {
  family: string;
  state: CatalogFamilySyncState;
  /** The serve's own failure reason (shown inline, never hover-only). */
  error?: string | null;
}

/** One interval of the run-length coverage documents carry. */
export type FaceInterval = CpInterval;

/**
 * The honest coverage summary one scanned face carries — ticket #36
 * adds the run-length `intervals` (and `placeholder_intervals`): the
 * counters' and missing view's data, compressed like the precedence
 * document so a full CJK face costs a few hundred entries, never a
 * page-side cmap parse.
 */
export interface CatalogFaceCoverage {
  codepoints: number;
  placeholders: number;
  latin: boolean;
  cjk: boolean;
  intervals: number[][];
  placeholder_intervals: number[][];
}

/** One face of a cut, as the family document reports it (issue #38). */
export interface CatalogFaceDoc {
  file: string;
  face_index: number;
  sha256: string;
  href: string;
  family: string;
  subfamily: string;
  weight: number;
  italic: boolean;
  variable: boolean;
  coverage: CatalogFaceCoverage;
  placeholder: boolean;
}

/** One cut of a family document: variant, label, faces, readiness. */
export interface CatalogCutDoc {
  variant: string;
  def: boolean;
  /** The release artifact's own stem (shown until the scan lands). */
  label: string;
  file: string;
  version: string | null;
  sha256: string;
  axes: Record<string, string>;
  upstream_url: string | null;
  /** The cut's own name-table name, once scanned. */
  display_name: string | null;
  representative: string | null;
  faces: CatalogFaceDoc[];
}

/**
 * One family's picker document (`GET /catalog/families`, issue #38):
 * everything a row needs — display names from the REAL name tables,
 * the cuts, per-family readiness — without the page touching font
 * bytes.
 */
export interface CatalogFamilyDoc {
  family: string;
  /** The family's readiness: a sync state, or unsynced/absent. */
  readiness: CatalogFamilySyncState | "unsynced" | "absent";
  error: string | null;
  scanned: boolean;
  display_name: string | null;
  display_names: string[];
  /** The family's preview-subset URL (self-rendering rows). */
  preview: string | null;
  cuts: CatalogCutDoc[];
}

export type CatalogStatus =
  /** No serve catalog configured (no serve, or a serve without one). */
  | "none"
  /** Waiting for the serve's first status answer. */
  | "connecting"
  /** The serve's sync is running (first run and repairs alike). */
  | "bootstrapping"
  /** The serve's sync finished; every family is complete. */
  | "ready"
  /** The serve's sync finished (or could not run) with an error. */
  | "unavailable";

export interface CatalogState {
  status: CatalogStatus;
  /**
   * The catalog's failure reason. When the serve reports unavailable
   * this is the serve's error string VERBATIM (the picker footer
   * shows exactly it); for transport failures it is the fetch error.
   */
  error?: string;
  /**
   * The serve status document's per-family progress (the first-run
   * screen renders it).
   */
  progress: CatalogFamilyProgress[];
  /** The serve's family documents (the picker's row source). */
  documents: CatalogFamilyDoc[];
  /** True while the serve is still scanning family documents. */
  scanning: boolean;
  /** First-run progress screen visible (dismissable; never blocks). */
  screen: boolean;
}

export interface AppState {
  /** All successfully loaded local fonts (the picker rows). */
  fonts: LoadedFont[];
  /** Selected cssFamily keys for the base (en) and donor (cjk) pickers. */
  selected: { en: string | null; cjk: string | null };
  mode: ContentMode;
  /** The scene mode's custom preview text (自定义预览文字). */
  customPreview: string;
  /**
   * The output font name (the top bar's field, feeding the recipe's
   * output.family — ADR-0005: never derived from the source fonts).
   */
  outputFamily: string;
  /** Active unicode block id ("all" = the aggregate view). */
  categoryId: string;
  /** 1-based page within the active category. */
  page: number;
  /** Codepoint currently selected in the grid (details strip). */
  selectedCodepoint: number | null;
  /**
   * The multi-selection on the grid (issue #20), always sorted ascending:
   * built by drag-paint and shift-range, consumed by batch apply. Kept
   * separate from `selectedCodepoint` — the details cell is a cursor,
   * the selection is a set.
   */
  selection: number[];
  /** The anchor cell shift-range extends from (a codepoint, not an index). */
  selectionAnchor: number | null;
  /**
   * The precedence rules under edit (issue #18): the single rule state
   * the preview grid resolves client-side AND the synthesize flow
   * serializes — one source of truth.
   */
  rules: EditorRule[];
  /** Synthesis settings (issue #19): weight mode, baseline, CJK width. */
  settings: SynthesisSettings;
  catalog: CatalogState;
}

type Listener<T> = (state: T) => void;

export interface Store<T> {
  get(): T;
  set(patch: Partial<T>): void;
  subscribe(fn: Listener<T>): () => void;
}

/* ---------- the boot preset (prototype parity) ---------- */

/** The preset a fresh state declares under 文字范围: fc-lang `zh_cn`. */
const BOOT_PRESET = "zh_cn";

/**
 * The boot preset rule: the validated prototype's boot frame ships with
 * the 简体中文 (zh_cn) scope declared under 文字范围, so a fresh state
 * carries one zh_cn preset rule (all sub-blocks on, the union). Its
 * font list is the join order `["base", "donor-0"]` — exactly what the
 * 文字范围 chips declare with a full pair, and resolution-neutral
 * under the default precedence (base keeps, donor fills).
 *
 * Seeded ONLY into the first-ever initial state: afterwards the rule is
 * ordinary user state — removing or editing it is a plain rule
 * mutation, and nothing ever re-seeds over the user's rules.
 */function bootRules(): EditorRule[] {
  const preset = (
    presetsData.presets as Array<{
      name: string;
      sub_blocks: Array<{ name: string }>;
    }>
  ).find((entry) => entry.name === BOOT_PRESET);
  if (!preset) return [];
  return [
    newRule(
      { kind: "preset", name: preset.name, blocks: preset.sub_blocks.map((b) => b.name) },
      ["base", "donor-0"],
    ),
  ];
}

/** Generic store factory: the GUI workspace and the web recipe builder
 *  (the absorbed CLI panel's cached draft) follow the same pattern. */
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
  customPreview: "",
  outputFamily: "ChHsich",
  categoryId: "all",
  page: 1,
  selectedCodepoint: null,
  selection: [],
  selectionAnchor: null,
  rules: bootRules(),
  settings: { ...DEFAULT_SETTINGS },
  catalog: {
    status: "none",
    progress: [],
    documents: [],
    scanning: false,
    screen: false,
  },
});

/**
 * The union of the two selected fonts' coverage intervals (the picks'
 * run-length data merged — view-model arithmetic, ticket #36).
 */
export function selectedCoverageIntervals(state: AppState): CpIntervals {
  const picks = [state.selected.en, state.selected.cjk]
    .map((key) => state.fonts.find((f) => f.cssFamily === key))
    .filter((f): f is LoadedFont => f !== undefined);
  if (picks.length === 0) return [];
  let union: CpIntervals = picks[0]!.intervals;
  for (let i = 1; i < picks.length; i++) {
    union = unionIntervals(union, picks[i]!.intervals);
  }
  return union;
}
