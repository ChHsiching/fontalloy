/**
 * The precedence rule model the GUI edits (issue #18): the single rule
 * state the preview grid resolves and the synthesize flow serializes —
 * one source of truth.
 *
 * Mirrors the semantics pinned by `core/fontalloy_core/precedence.py`
 * (GLOSSARY "precedence rule"): a codepoint target mapped to an ordered
 * font list, at one of three granularities (single codepoint, custom
 * range, named set / language preset). Rule ids in the effective table
 * (`via`) number the COMPLETE rules in declaration order — the exact
 * subset that serializes into a recipe — so a half-edited row never
 * shifts the ids the backend would report.
 */

import type { Preset } from "../recipe/model";

/** A rule target while it is being edited; null fields = incomplete. */
export type EditorTarget =
  | { kind: "codepoint"; cp: number | null }
  | { kind: "range"; start: number | null; end: number | null }
  | { kind: "preset"; name: string; blocks: string[] };

/** One precedence rule under edit: target + ordered font refs. */
export interface EditorRule {
  /** DOM-stable id (row keys, data-role names); NOT the via id. */
  id: number;
  target: EditorTarget;
  /**
   * Ordered font refs (`base`, `donor-0`): the first holder of a
   * codepoint wins — absence never overrides.
   */
  fonts: string[];
}

let nextRuleId = 1;

/** The next DOM-stable rule id. */
export function takeRuleId(): number {
  return nextRuleId++;
}

/**
 * A complete rule — one that can resolve and serialize. Incomplete rows
 * (a range or codepoint still being typed) are skipped by resolution,
 * by serialization, and by rule-id numbering alike.
 */
export interface CompleteRule {
  rule: EditorRule;
  /** The stable backend id: `rule-<declaration index among complete rules>`. */
  via: string;
  /** The resolved target of a preset rule (union of enabled blocks). */
  intervals?: readonly { start: number; end: number }[];
}

/** The complete rules in declaration order, with their `rule-N` ids. */
export function completeRules(rules: readonly EditorRule[]): CompleteRule[] {
  const out: CompleteRule[] = [];
  for (const rule of rules) {
    const target = rule.target;
    if (target.kind === "codepoint") {
      if (target.cp === null) continue;
    } else if (target.kind === "range") {
      if (target.start === null || target.end === null) continue;
    }
    out.push({ rule, via: `rule-${out.length}` });
  }
  return out;
}

/** A new rule with the default font list (all refs, join order). */
export function newRule(
  target: EditorTarget,
  refs: readonly string[],
): EditorRule {
  return { id: takeRuleId(), target, fonts: [...refs] };
}

/** The recipe-syntax target label (also the row's display form). */
export function targetLabel(rule: EditorRule): string {
  const target = rule.target;
  if (target.kind === "codepoint") {
    return target.cp === null ? "码位…" : `0x${target.cp.toString(16).toUpperCase()}`;
  }
  if (target.kind === "range") {
    if (target.start === null || target.end === null) return "区间…";
    const lo = Math.min(target.start, target.end);
    const hi = Math.max(target.start, target.end);
    return `0x${lo.toString(16).toUpperCase()}-0x${hi.toString(16).toUpperCase()}`;
  }
  return target.name;
}

/**
 * The name of the effective set a preset rule currently covers: the
 * preset itself when every sub-block is enabled, the single block when
 * only it survives, else the explicit composite.
 */
export function effectiveSetName(
  preset: Preset | undefined,
  blocks: readonly string[],
): string {
  if (!preset) return blocks.join("+");
  const all = preset.sub_blocks.map((block) => block.name);
  if (all.length === blocks.length) return preset.name;
  if (blocks.length === 1) return blocks[0]!;
  return `${preset.name}+${[...blocks].sort().join("+")}`;
}

/** Parse a user-typed codepoint: `4E2D`, `0x4E2D`, `U+4E2D` (case-free). */
export function parseCodepointInput(raw: string): number | null {
  const text = raw.trim().replace(/^[uU]\+/, "").replace(/^0[xX]/, "");
  if (!/^[0-9a-fA-F]{1,6}$/.test(text)) return null;
  const value = Number.parseInt(text, 16);
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return null;
  if (value >= 0xd800 && value <= 0xdfff) return null;
  return value;
}
