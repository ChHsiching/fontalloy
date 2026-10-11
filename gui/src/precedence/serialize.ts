/**
 * GUI rule state -> recipe draft (issue #18): the synthesize flow
 * consumes the SAME rule state the preview grid resolves — one source
 * of truth. This module is the bridge: it turns the edited rules into
 * the shared `BuilderRule[]` (issue #21's model) plus, when needed,
 * user-defined named sets.
 *
 * Partial sub-block unions: a preset rule with every block enabled
 * references the built-in set by name (`set: zh_hk`). A rule whose
 * enabled blocks no longer form a built-in set (e.g. only zh_tw of
 * zh_hk) is expressed exactly, as a recipe `sets:` entry carrying the
 * union's intervals — so the backend resolves the very union the grid
 * showed, however the toggles stand. When the union happens to equal a
 * single built-in set (one block survives, and that block is itself a
 * named set — ticket #7 makes every sub-block independently
 * selectable), the built-in name is referenced directly instead.
 */

import type { BuilderRule, Preset, RecipeDraft } from "../recipe/model";
import presets from "../data/presets.json";
import {
  completeRules,
  effectiveSetName,
  type EditorRule,
} from "./model";
import {
  intervalLabels,
  unionOfSets,
} from "./sets";

interface PresetIndex {
  byName: Map<string, Preset>;
}

const PRESET_INDEX: PresetIndex = {
  byName: new Map(
    (presets.presets as Preset[]).map((preset) => [preset.name, preset]),
  ),
};

/** The built-in name a union equals, when it equals one at all. */
function builtinNameForUnion(
  preset: Preset,
  blocks: readonly string[],
): string | null {
  const all = preset.sub_blocks.map((block) => block.name);
  if (all.length === blocks.length) return preset.name;
  // One surviving block: its union is exactly that block's set, and
  // every sub-block is itself a built-in named set (ticket #7).
  if (blocks.length === 1) return blocks[0]!;
  return null;
}

/**
 * Write the GUI's rule state into `draft` (rules + custom named sets).
 * Incomplete rows are skipped; complete rules keep declaration order,
 * so the recipe's rule numbering matches the grid's `via` ids.
 */
export function applyRulesToDraft(
  draft: RecipeDraft,
  rules: readonly EditorRule[],
): void {
  const sets: Record<string, string[]> = {};
  const out: BuilderRule[] = [];
  for (const { rule } of completeRules(rules)) {
    const target = rule.target;
    if (target.kind === "preset") {
      const preset = PRESET_INDEX.byName.get(target.name);
      const builtin = preset ? builtinNameForUnion(preset, target.blocks) : null;
      let name = builtin;
      if (name === null && preset) {
        name = effectiveSetName(preset, target.blocks);
        sets[name] = intervalLabels(unionOfSets(target.blocks));
      }
      if (name === null) continue; // unknown preset: not serializable
      out.push({
        id: rule.id,
        target: { kind: "preset", name },
        fonts: [...rule.fonts],
      });
    } else if (target.kind === "range") {
      const lo = Math.min(target.start!, target.end!);
      const hi = Math.max(target.start!, target.end!);
      out.push({
        id: rule.id,
        target: { kind: "range", start: lo, end: hi },
        fonts: [...rule.fonts],
      });
    } else {
      out.push({
        id: rule.id,
        target: { kind: "codepoint", cp: target.cp! },
        fonts: [...rule.fonts],
      });
    }
  }
  draft.rules = out;
  draft.sets = sets;
}
