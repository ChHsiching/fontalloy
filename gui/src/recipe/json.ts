/**
 * Recipe JSON generation: draft -> the recipe-shaped JSON body the
 * WebApp submits to `POST /builds` (the serve contract, issue #11/#22).
 *
 * Ticket #29 (core unification): this is the recipe module's ONLY
 * serializer — the API's request format and, in the no-service panel,
 * the downloadable recipe file (the CLI command runs it as-is; YAML
 * loading is a JSON superset). The client-side YAML writer and the
 * validation mirror are deleted: the serve's submit-time validation is
 * the single gate, and this module emits the draft as declared. The
 * shape is pinned from both ends: `tests/test_webapp_recipe.py` proves
 * the checked-in JSON samples parse through the strict parser
 * (`fontalloy_core.parse_recipe`), and the seam-3 web suite proves the
 * browser sends the same body for the same builder state
 * (`web/tests/fixtures/sample-recipe.json`).
 */

import {
  DEFAULT_OPTICAL_RATIO,
  DEFAULT_WIDTH_FACTOR,
  fontRef,
  type RecipeDraft,
} from "./model";

/** Normalize like the core: whitespace runs -> single hyphens, trimmed. */
export function normalizeFamilyName(input: string): string {
  return input
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join("-");
}

/** Uppercase `0x`-prefixed hex (the interval string syntax). */
function hex(value: number): string {
  return `0x${value.toString(16).toUpperCase()}`;
}

/** The serve submission body for `draft` (as declared, not as gated). */
export function recipeJson(draft: RecipeDraft): Record<string, unknown> {
  const rules = draft.rules.map((rule) => {
    const target = rule.target;
    const entry: Record<string, unknown> = {};
    if (target.kind === "preset") {
      entry.set = target.name;
    } else if (target.kind === "range") {
      entry.range = `${hex(target.start)}-${hex(target.end)}`;
    } else {
      entry.codepoint = target.cp;
    }
    entry.fonts = [...rule.fonts];
    return entry;
  });

  const out: Record<string, unknown> = {
    base: fontRef(draft.base),
    donors: draft.donors.map(fontRef),
    rules,
  };

  // User-defined named sets (issue #18: partial preset sub-block unions).
  // Sent only when declared — a recipe without `sets` uses built-ins.
  if (Object.keys(draft.sets).length > 0) {
    out.sets = draft.sets;
  }

  // Normalization: omitted entirely at the core defaults (a recipe
  // without the block builds with the defaults).
  // "plain" IS the core default (round 26 — direct combination), so it
  // stays omitted; the explicit schools (auto/grid/optical) are written
  // out. The optical_ratio knob rides along whenever it applies (auto
  // caps by it, optical anchors at it; plain and bare grid ignore it).
  const normalization: Record<string, unknown> = {};
  if (draft.normalization.mode !== "plain") {
    normalization.mode = draft.normalization.mode;
  }
  if (
    draft.normalization.mode === "auto" ||
    draft.normalization.mode === "optical"
  ) {
    const ratio = draft.normalization.opticalRatio;
    if (ratio !== null && Number.isFinite(ratio) && ratio !== DEFAULT_OPTICAL_RATIO) {
      normalization.optical_ratio = Number(ratio);
    }
  }
  if (draft.normalization.quoteDashWidth !== "halfwidth") {
    normalization.quote_dash_width = draft.normalization.quoteDashWidth;
  }
  if (draft.normalization.widthFactor !== DEFAULT_WIDTH_FACTOR) {
    normalization.width_factor = draft.normalization.widthFactor;
  }
  if (Object.keys(normalization).length > 0) {
    out.normalization = normalization;
  }

  // Weight matrix: sent only when a slot is declared. An incomplete
  // slot (null weight) serializes as null — the serve's strict parser
  // names it at submit time; there is no client-side gate (ticket #29).
  if (draft.weights.length > 0) {
    out.weights = draft.weights.map((slot) => {
      const entry: Record<string, unknown> = { weight: slot.weight };
      if (slot.style === "italic") entry.style = "italic";
      const overrides = Object.fromEntries(
        Object.entries(slot.donors).filter(([, weight]) => weight !== null),
      );
      if (Object.keys(overrides).length > 0) entry.donors = overrides;
      return entry;
    });
  }

  out.output = {
    // "auto" never serializes — the draft builder resolves it
    // (multi-face family pick = ttc); the guard is belt-and-braces.
    format: draft.output.format === "auto" ? "ttf" : draft.output.format,
    family: normalizeFamilyName(draft.output.family),
  };
  return out;
}

/** Recipe file name derived from the normalized output family. */
export function recipeFileName(draft: RecipeDraft): string {
  const family = normalizeFamilyName(draft.output.family);
  return `${family || "fontalloy-recipe"}.json`;
}
