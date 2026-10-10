/**
 * The recipe draft: the builder-side model of a `fontalloy` recipe.
 *
 * Mirrors the schema `core/fontalloy_core/recipe.py` parses (issues #2,
 * #3, #6, #10): base + donors as font references (path, optional TTC
 * face), precedence rules at three granularities (preset set / custom
 * range / single codepoint) with an ordered font list referencing
 * `base` or `donor-<join index>`, and output naming (family + format).
 *
 * Extension points for in-flight siblings, kept deliberately open:
 * - `weight` mapping overrides land with issue #9 — the builder carries
 *   a placeholder section, not a field, until the schema exists;
 * - normalization switches land with issue #8 — same treatment.
 */

/** One catalog entry as statically rendered at build time. */
export interface CatalogEntry {
  family: string;
  variant: string;
  version: string;
  file: string;
  /** Where `fontalloy assets fetch` unpacks this artifact. */
  path_hint: string;
  license_spdx: string;
  rfn: boolean;
}

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

/** A selected font (the base or one donor), catalog-backed but path-based. */
export interface FontSlot {
  /** The catalog entry picked in the builder (display + provenance). */
  catalog: CatalogEntry | null;
  /** Recipe-relative font file path — what the YAML actually writes. */
  path: string;
  /** TTC face index (`null` = not a collection reference). */
  face: number | null;
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
  /** `grid` (the terminal 2:1 default) or `optical`. */
  mode: "grid" | "optical";
  /** Han ink to cap-height ratio; only meaningful in optical mode. */
  opticalRatio: number | null;
  /** Fullwidth quotes/dashes (CJK convention) or halfwidth (UAX #11). */
  quoteDashWidth: "halfwidth" | "fullwidth";
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
  normalization: NormalizationDraft;
  weights: WeightSlotDraft[];
  output: { family: string; format: OutputFormat };
}

/** The core's defaults — the writer omits an all-defaults block. */
export const DEFAULT_OPTICAL_RATIO = 1.23;

/** The recipe font-reference string: `path` or the compact `path#face`. */
export function fontRef(slot: FontSlot): string {
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
    normalization: {
      mode: "grid",
      opticalRatio: DEFAULT_OPTICAL_RATIO,
      quoteDashWidth: "halfwidth",
    },
    weights: [],
    // The fixed brand default (spec: never derived from source names).
    output: { family: "ChHsich", format: "ttf" },
  };
}

/** Every font ref a rule may currently reference, in join order. */
export function availableRefs(draft: RecipeDraft): string[] {
  return ["base", ...draft.donors.map((_, i) => donorRef(i))];
}

/** Human label for a font ref, for the rule editor rows. */
export function refLabel(draft: RecipeDraft, ref: string): string {
  if (ref === "base") {
    return draft.base.catalog
      ? `base · ${draft.base.catalog.family} ${draft.base.catalog.variant}`
      : "base · 基底字体";
  }
  const index = Number(ref.slice("donor-".length));
  const slot = draft.donors[index];
  return slot?.catalog
    ? `${ref} · ${slot.catalog.family} ${slot.catalog.variant}`
    : `${ref} · 供体 ${index + 1}`;
}
