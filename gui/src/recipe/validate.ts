/**
 * Client-side validation: the instant-feedback mirror of the core's
 * recipe rules, so a builder state is judged before anything is
 * downloaded or copied.
 *
 * The mirrors (kept in lockstep with `core/fontalloy_core/rewrite.py`
 * and `recipe.py`; `tests/test_webapp_recipe.py` pins the emitted YAML
 * against the strict loader):
 *
 * - output family: spaces (any run) become single hyphens, then ASCII
 *   letters / digits / hyphens only, at most 31 characters;
 * - a rule's font list must be non-empty and reference only fonts in
 *   this build (`base`, `donor-<index>` within range);
 * - ranges and codepoints must be Unicode scalar values (hex input).
 */

import type { Preset, RecipeDraft } from "./model";

export const FAMILY_MAX_CHARS = 31;

/** Normalize like the core: whitespace runs -> single hyphens, trimmed. */
export function normalizeFamilyName(input: string): string {
  return input
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join("-");
}

export interface FamilyValidation {
  ok: boolean;
  /** The name as it would be written to the recipe (when valid). */
  normalized: string;
  /** Chinese UI copy for the inline feedback (empty when valid). */
  error: string;
}

export function validateFamilyName(input: string): FamilyValidation {
  const normalized = normalizeFamilyName(input);
  if (normalized === "") {
    return { ok: false, normalized, error: "家族名不能为空。" };
  }
  if (!/^[\x20-\x7E]*$/.test(normalized)) {
    return {
      ok: false,
      normalized,
      error: "家族名仅支持 ASCII 字符（本地化名称不在 v1 范围内）。",
    };
  }
  if (!/^[A-Za-z0-9-]+$/.test(normalized)) {
    return {
      ok: false,
      normalized,
      error: "家族名仅可包含字母、数字与连字符；空格会自动转换为连字符。",
    };
  }
  if (normalized.length > FAMILY_MAX_CHARS) {
    return {
      ok: false,
      normalized,
      error: `家族名在空格转换为连字符后不得超过 ${FAMILY_MAX_CHARS} 个字符（当前 ${normalized.length} 个）。`,
    };
  }
  return { ok: true, normalized, error: "" };
}

const MAX_SCALAR = 0x10ffff;

/** OS/2 usWeightClass range the core accepts (recipe.py). */
export const WEIGHT_MIN = 1;
export const WEIGHT_MAX = 1000;

export function isValidWeight(value: number): boolean {
  return Number.isInteger(value) && value >= WEIGHT_MIN && value <= WEIGHT_MAX;
}

export function isUnicodeScalar(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_SCALAR &&
    !(value >= 0xd800 && value <= 0xdfff)
  );
}

/**
 * Parse hex input as the rule fields accept it: `0x4E2D`, `4E2D`, or
 * `U+4E2D` (case-insensitive). `null` when the text is not a scalar.
 */
export function parseHexScalar(text: string): number | null {
  const match = text.trim().match(/^(?:u\+|0x)?([0-9a-f]+)$/i);
  if (!match) return null;
  const value = Number.parseInt(match[1], 16);
  return isUnicodeScalar(value) ? value : null;
}

export interface Problem {
  /** Selector-ish locator shown to the user, e.g. "基底字体". */
  where: string;
  message: string;
}

function validateSlot(
  slot: RecipeDraft["base"],
  where: string,
  out: Problem[],
): void {
  if (slot.path.trim() === "") {
    out.push({ where, message: "缺少字体文件路径。" });
  }
  if (slot.face !== null && slot.face < 0) {
    out.push({ where, message: "TTC face 索引必须是非负整数。" });
  }
}

/** Every problem between this draft and a runnable recipe. */
export function validateDraft(
  draft: RecipeDraft,
  presets: Preset[],
): Problem[] {
  const out: Problem[] = [];
  const knownSets = new Set<string>([
    ...presets.map((p) => p.name),
    // Standalone sub-blocks (e.g. zh_hk_supplement) are selectable sets.
    ...presets.flatMap((p) => p.sub_blocks.map((b) => b.name)),
  ]);

  validateSlot(draft.base, "基底字体", out);
  draft.donors.forEach((slot, index) => {
    validateSlot(slot, `供体 ${index + 1}`, out);
  });

  const maxDonor = draft.donors.length;
  draft.rules.forEach((rule, index) => {
    const where = `规则 ${index + 1}`;
    if (rule.target.kind === "preset" && !knownSets.has(rule.target.name)) {
      out.push({ where, message: "请选择一个语言预设。" });
    }
    if (rule.target.kind === "range") {
      if (!isUnicodeScalar(rule.target.start) || !isUnicodeScalar(rule.target.end)) {
        out.push({ where, message: "区间端点必须是 Unicode 标量值（十六进制）。" });
      } else if (rule.target.start > rule.target.end) {
        out.push({ where, message: "区间起点不能超过终点。" });
      }
    }
    if (rule.target.kind === "codepoint" && !isUnicodeScalar(rule.target.cp)) {
      out.push({ where, message: "码位必须是 Unicode 标量值（十六进制）。" });
    }
    if (rule.fonts.length === 0) {
      out.push({ where, message: "字体列表不能为空——请至少勾选一个字体。" });
    }
    for (const ref of rule.fonts) {
      const donorIndex =
        ref.startsWith("donor-") ? Number(ref.slice("donor-".length)) : -1;
      if (ref !== "base" && (donorIndex < 0 || donorIndex >= maxDonor)) {
        out.push({ where, message: `字体引用 ${ref} 不在本配方中。` });
      }
    }
  });

  const family = validateFamilyName(draft.output.family);
  if (!family.ok) out.push({ where: "输出", message: family.error });

  // Normalization: the ratio must be a positive finite number when set.
  if (
    draft.normalization.mode === "optical" &&
    draft.normalization.opticalRatio !== null &&
    !(Number.isFinite(draft.normalization.opticalRatio) && draft.normalization.opticalRatio > 0)
  ) {
    out.push({ where: "规范化", message: "光学比例必须是正数（汉字墨高与大写高度之比）。" });
  }

  // Weight matrix: integer weights in range, valid donor refs, no
  // duplicate (weight, style) slots — the strict loader's rules.
  const seen = new Set<string>();
  draft.weights.forEach((slot, index) => {
    const where = `字重槽位 ${index + 1}`;
    if (slot.weight === null || !isValidWeight(slot.weight)) {
      out.push({
        where,
        message: `字重必须是 ${WEIGHT_MIN}–${WEIGHT_MAX} 的整数（OS/2 usWeightClass）。`,
      });
    }
    for (const [ref, demanded] of Object.entries(slot.donors)) {
      if (demanded === null) continue;
      const donorIndex = Number(ref.slice("donor-".length));
      if (!ref.startsWith("donor-") || Number.isNaN(donorIndex) || donorIndex < 0 || donorIndex >= draft.donors.length) {
        out.push({ where, message: `供体覆写引用 ${ref} 不在本配方中。` });
      } else if (!isValidWeight(demanded)) {
        out.push({
          where,
          message: `供体 ${ref} 的覆写字重必须是 ${WEIGHT_MIN}–${WEIGHT_MAX} 的整数。`,
        });
      }
    }
    if (slot.weight !== null && isValidWeight(slot.weight)) {
      const key = `${slot.weight}/${slot.style}`;
      if (seen.has(key)) {
        out.push({
          where,
          message: `字重 ${slot.weight}（${slot.style === "italic" ? "italic" : "upright"}）重复声明。`,
        });
      }
      seen.add(key);
    }
  });

  return out;
}
