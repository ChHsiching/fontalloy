/**
 * Recipe JSON generation: draft -> the recipe-shaped JSON body the
 * WebApp submits to `POST /builds` (the serve contract, issue #11/#22).
 *
 * The same builder state that the YAML writer (yaml.ts) serializes for
 * the CLI, as JSON parsed by the exact same `fontalloy_core.parse_recipe`
 * serve submissions go through — same fields, same defaults-omission
 * rule (a block sitting at the core defaults is simply not sent). The
 * shape is pinned from both ends: `tests/test_webapp_recipe.py` proves
 * the checked-in JSON samples parse through the strict parser, and the
 * seam-3 web suite proves the browser sends the same body for the same
 * builder state (`web/tests/fixtures/sample-recipe.json`).
 */

import {
  DEFAULT_OPTICAL_RATIO,
  DEFAULT_WIDTH_FACTOR,
  fontRef,
  type RecipeDraft,
} from "./model";
import { normalizeFamilyName } from "./validate";

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

  // Normalization: omitted entirely at the core defaults, mirroring the
  // YAML writer (a recipe without the block builds with the defaults).
  const normalization: Record<string, unknown> = {};
  if (draft.normalization.mode !== "grid") {
    normalization.mode = draft.normalization.mode;
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
  // slot (null weight) serializes as null — the service's strict
  // parser names it, and the submission gate blocks it long before.
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
