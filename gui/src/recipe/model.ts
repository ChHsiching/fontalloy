/**
 * The recipe draft: the builder-side model of a `fontalloy` recipe.
 *
 * Mirrors the schema `core/fontalloy_core/recipe.py` parses (issues #2,
 * #3, #6, #10): base + donors as font references (path, optional TTC
 * face), precedence rules at three granularities (preset set / custom
 * range / single codepoint) with an ordered font list referencing
 * `base` or `donor-<join index>`, and output naming (family + format).
 *
 * The schema sections that once lagged behind are draft fields now:
 * `normalization` (issue #8, ADR-0003) and `weights` (issue #9, the
 * weight/style matrix) are parsed by the core, edited in the builder's
 * settings scene, and serialized into the recipe like every other
 * section.
 */

/** One fc-lang preset as statically rendered at build time. */
export interface PresetSubBlock {
  name: string;
  codepoints: number;
}

export interface Preset {
  name: string;
  codepoints: number;
  sub_blocks: PresetSubBlock[];
}

/**
 * A catalog-family reference (round 6): how a catalog-picked font
 * enters a recipe — `{family, variant}` naming what the committed
 * manifest pins, optionally narrowed by a bare-filename `pattern`
 * (the picked face, for the base whose ttf output is single-face).
 * Only local files emit paths.
 */
export interface CatalogRef {
  family: string;
  /** The manifest variant (omitted from the recipe when null). */
  variant: string | null;
}

/** A selected font (the base or one donor): a path or a catalog family. */
export interface FontSlot {
  /**
   * The catalog identity when the pick came from the catalog (round 6):
   * the recipe then names `{family, variant[, pattern]}` instead of a
   * path — the service resolves it against its own manifest and the
   * fetched, sha256-verified catalog.
   */
  catalog: CatalogRef | null;
  /** Recipe-relative font file path — what local picks write. */
  path: string;
  /** TTC face index (`null` = not a collection reference). */
  face: number | null;
  /**
   * Bare-filename glob narrowing the reference to a face SET: the
   * catalog artifact's faces (a catalog pick's variant cut), or —
   * round 13, owner item 7 — the named path's same-directory sibling
   * font files (a local family pick's whole weight matrix).
   */
  pattern?: string;
}

export type RuleTarget =
  | { kind: "preset"; name: string }
  | { kind: "range"; start: number; end: number }
  | { kind: "codepoint"; cp: number };

export interface BuilderRule {
  id: number;
  target: RuleTarget;
  /** Ordered font refs (`base`, `donor-0`, …) — first holder wins. */
  fonts: string[];
}

export type OutputFormat = "ttf" | "ttc" | "woff2";

/** Normalization switches (ADR-0003 / issue #8 recipe schema). */
export interface NormalizationDraft {
  /**
   * `auto` (the default: the grid term capped by the optical ratio, so
   * the Han ink stays inside the Noto-school zone), `grid` (the bare
   * terminal-grid scale), or `optical` (Han ink pinned at the ratio).
   */
  /**
   * Round 26 (owner ruling): `plain` is the default — direct
   * combination, donor glyphs verbatim with their own advances.
   */
  mode: "plain" | "auto" | "grid" | "optical";
  /**
   * Han ink to cap-height ratio; the optical school's anchor and the
   * auto school's cap (meaningless in bare grid mode).
   */
  opticalRatio: number | null;
  /** Fullwidth quotes/dashes (CJK convention) or halfwidth (UAX #11). */
  quoteDashWidth: "halfwidth" | "fullwidth";
  /**
   * The grid school's CJK advance as a multiple of the Latin advance
   * (the prototype's 两倍/1.8 倍/1.5 倍 English-width setting; 2 is the
   * UAX #11 two-cell default the writers omit).
   */
  widthFactor: number;
}

/** One weight/style matrix slot (issue #9 recipe schema). */
export interface WeightSlotDraft {
  id: number;
  /** The base face's OS/2 usWeightClass for this output. */
  weight: number | null;
  style: "upright" | "italic";
  /** Per-donor demanded weights (donor ref → weight); empty = nearest. */
  donors: Record<string, number | null>;
}

export interface RecipeDraft {
  base: FontSlot;
  donors: FontSlot[];
  rules: BuilderRule[];
  /**
   * User-defined named sets (issue #18): name -> interval labels in
   * recipe syntax. The GUI writes partial preset sub-block unions here
   * (a union that is not itself a built-in set); the builder leaves it
   * empty. Serialized only when non-empty (the core defaults rule).
   */
  sets: Record<string, string[]>;
  normalization: NormalizationDraft;
  weights: WeightSlotDraft[];
  output: { family: string; format: OutputFormat | "auto" };
}

/** The core's defaults — the writer omits an all-defaults block. */
export const DEFAULT_OPTICAL_RATIO = 1.23;
export const DEFAULT_WIDTH_FACTOR = 2;

/**
 * The recipe font reference: a path string (`path` or the compact
 * `path#face`), the catalog-family mapping `{family, variant,
 * pattern}` when the slot names a catalog pick (round 6), or — when a
 * path-form slot carries a pattern (round 13) — the `{path, pattern}`
 * mapping the same schema parses for a local family's same-directory
 * siblings. All three are the exact schema `fontalloy_core` accepts.
 */
export function fontRef(slot: FontSlot): string | Record<string, unknown> {
  if (slot.catalog !== null) {
    const ref: Record<string, unknown> = { family: slot.catalog.family };
    if (slot.catalog.variant !== null) ref.variant = slot.catalog.variant;
    if (slot.pattern !== undefined) ref.pattern = slot.pattern;
    return ref;
  }
  if (slot.pattern !== undefined) {
    const ref: Record<string, unknown> = { path: slot.path, pattern: slot.pattern };
    if (slot.face !== null) ref.face = slot.face;
    return ref;
  }
  return slot.face === null ? slot.path : `${slot.path}#${slot.face}`;
}

/** Ref label shown in rule editors: `base` or `donor-<index>`. */
export function donorRef(index: number): string {
  return `donor-${index}`;
}

export function defaultDraft(): RecipeDraft {
  return {
    base: { catalog: null, path: "", face: null },
    donors: [],
    rules: [],
    sets: {},
    normalization: {
      mode: "plain",
      opticalRatio: DEFAULT_OPTICAL_RATIO,
      quoteDashWidth: "halfwidth",
      widthFactor: DEFAULT_WIDTH_FACTOR,
    },
    weights: [],
    // The fixed brand default (spec: never derived from source names).
    output: { family: "ChHsich", format: "auto" },
  };
}

/** Every font ref a rule may currently reference, in join order. */
export function availableRefs(draft: RecipeDraft): string[] {
  return ["base", ...draft.donors.map((_, i) => donorRef(i))];
}

/** Human label for a font ref, for the rule editor rows. */
export function refLabel(draft: RecipeDraft, ref: string): string {
  const slotLabel = (slot: FontSlot | undefined): string | null =>
    slot?.catalog
      ? `${slot.catalog.family} ${slot.catalog.variant ?? ""}`.trim()
      : null;
  if (ref === "base") {
    return `base：${slotLabel(draft.base) ?? "基底字体"}`;
  }
  const index = Number(ref.slice("donor-".length));
  return `${ref}：${slotLabel(draft.donors[index]) ?? `供体 ${index + 1}`}`;
}
