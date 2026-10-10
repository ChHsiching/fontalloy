/**
 * Recipe JSON serialization: draft -> the recipe-shaped JSON body
 * `POST /builds` parses (issue #11; the same schema `parse_recipe`
 * reads, JSON instead of YAML — the GUI synthesize flow submits it,
 * issue #16).
 *
 * The YAML writer (yaml.ts) and this serializer share the draft model
 * and the field semantics: a v0 draft (base + donors) emits exactly the
 * fields the strict loader accepts, optional blocks only when declared.
 */

import { fontRef, type RecipeDraft } from "./model";
import { normalizeFamilyName } from "./validate";

/** One rule as the JSON schema declares it (exactly one target field). */
function ruleObject(
  rule: RecipeDraft["rules"][number],
): Record<string, unknown> {
  const target =
    rule.target.kind === "preset"
      ? { set: rule.target.name }
      : rule.target.kind === "range"
        ? {
            range: `0x${rule.target.start
              .toString(16)
              .toUpperCase()}-${rule.target.end.toString(16).toUpperCase()}`,
          }
        : { codepoint: rule.target.cp };
  return { ...target, fonts: rule.fonts };
}

/** The POST /builds body for `draft` (paths as declared, never rewritten). */
export function recipeJson(draft: RecipeDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {
    base: fontRef(draft.base),
    donors: draft.donors.map((slot) => {
      if (slot.face === null) return { path: slot.path };
      return { path: slot.path, face: slot.face };
    }),
  };

  if (draft.rules.length > 0) {
    body.rules = draft.rules.map(ruleObject);
  }

  const normalization: Record<string, unknown> = {};
  if (draft.normalization.mode !== "grid") {
    normalization.mode = draft.normalization.mode;
    if (draft.normalization.opticalRatio !== null) {
      normalization.optical_ratio = draft.normalization.opticalRatio;
    }
  }
  if (draft.normalization.quoteDashWidth !== "halfwidth") {
    normalization.quote_dash_width = draft.normalization.quoteDashWidth;
  }
  if (Object.keys(normalization).length > 0) {
    body.normalization = normalization;
  }

  if (draft.weights.length > 0) {
    body.weights = draft.weights.map((slot) => {
      const entry: Record<string, unknown> = { weight: slot.weight };
      if (slot.style === "italic") entry.style = "italic";
      const overrides = Object.entries(slot.donors).filter(
        ([, weight]) => weight !== null,
      );
      if (overrides.length > 0) {
        entry.donors = Object.fromEntries(overrides);
      }
      return entry;
    });
  }

  body.output = {
    format: draft.output.format,
    family: normalizeFamilyName(draft.output.family),
  };
  return body;
}
