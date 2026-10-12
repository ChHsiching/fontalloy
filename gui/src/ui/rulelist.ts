/**
 * The rail's two rule surfaces, both prototype-parity read-only
 * summaries of the shared rule state in `store`:
 *
 * - 文字范围 (mountPresetSection): the four one-click language chips —
 *   简体中文 / 繁体中文 / 日文 / 韩文, nothing else surfaced (round 5,
 *   owner item 3: the 341-language fc-lang extension lives on in the
 *   recipe/core only, never in this UI);
 * - 自定义规则 (mountRulesSection): the human sentence list —
 *   `{子类}用英文字体` block rows (merged to `所有{组}字符用…` when a
 *   whole group agrees), range rows in the round-8 VERBATIM form
 *   (`U+827A 艺 - U+828F 芏 用中文字体`; a single-codepoint range reads
 *   `U+827A 艺 用中文字体`), the dashed `单个字符 N` summary — round 8:
 *   an EXPANDABLE group whose children are the per-character rows in
 *   the same verbatim form — and the 全部恢复默认 reset. Editing
 *   happens through the workspace's own affordances (the toolbar
 *   segments, the char popup, the 按编码指定 popup, the preset chips)
 *   — every one of them writes the same rule state through
 *   `mutateRules`, so one undo entry covers each change and Ctrl+Z /
 *   the toolbar's 撤销 steps them back.
 */

import { store } from "../state";
import {
  newRule,
  type EditorRule,
} from "../precedence/model";
import { pickRefs } from "../precedence/picks";
import { mutateRules } from "../history";
import { undoAllButton } from "../kit/actionBar";
import { mountLangChips, type LangChips } from "../kit/langChips";
import { ruleEmptyState, ruleRow, ruleSoloRow } from "../kit/ruleRows";
import { ALL_BLOCKS, BLOCK_GROUPS, type UnicodeBlock } from "../unicode/blocks";
import presetsData from "../data/presets.json";
import { liveNotice } from "./live";
import { formatCp } from "./charmap";

/* ------------------------- store patches ---------------------------- */

function removeRule(id: number): void {
  mutateRules(store.get().rules.filter((rule) => rule.id !== id));
}

/* ------------------- 文字范围 (the language chips) ------------------- */

/**
 * The prototype's one-click language set (rLangs): the four 文字范围
 * chips, verbatim labels and counts — 简体中文 6,765 / 繁体中文
 * 13,063 / 日文 2,314 / 韩文 2,442 (each the fc-lang orth's real
 * codepoint count, comma-grouped). A chip is pressed when the
 * language's preset rule is declared; clicking toggles the rule through
 * `mutateRules` (one undo entry per toggle). The last declared language
 * cannot be removed — the guard announces 至少保留一种 through the
 * live region and keeps the rule.
 */
const LANG_CHIPS: ReadonlyArray<{ preset: string; label: string }> = [
  { preset: "zh_cn", label: "简体中文" },
  { preset: "zh_tw", label: "繁体中文" },
  { preset: "ja", label: "日文" },
  { preset: "ko", label: "韩文" },
];

const PRESETS_BY_NAME = new Map(
  presetsData.presets.map((preset) => [preset.name, preset]),
);

/** The preset's total codepoint count (the chip's small dim number). */
function presetCount(name: string): number {
  const preset = PRESETS_BY_NAME.get(name);
  if (!preset) return 0;
  return preset.sub_blocks.reduce((sum, block) => sum + block.codepoints, 0);
}

/** Every preset rule currently declared (the pressed languages). */
function presetRules(rules: readonly EditorRule[]): EditorRule[] {
  return rules.filter((rule) => rule.target.kind === "preset");
}

/** Toggle one of the four languages through the rule state. */
function toggleLanguage(name: string): void {
  const rules = store.get().rules;
  const declared = presetRules(rules);
  const existing = declared.find(
    (rule) => rule.target.kind === "preset" && rule.target.name === name,
  );
  if (existing) {
    if (declared.length === 1) {
      liveNotice("至少保留一种");
      return;
    }
    mutateRules(rules.filter((rule) => rule.id !== existing.id));
    return;
  }
  const preset = PRESETS_BY_NAME.get(name);
  if (!preset) return;
  const refs = pickRefs().refs;
  mutateRules([
    ...rules,
    newRule(
      { kind: "preset", name, blocks: preset.sub_blocks.map((b) => b.name) },
      refs.length > 0 ? refs : ["base", "donor-0"],
    ),
  ]);
}

/** The 文字范围 section: the four language chips, nothing else. */
export function mountPresetSection(root: HTMLElement): void {
  const chips: LangChips = mountLangChips(root, {
    chips: LANG_CHIPS.map(({ preset, label }) => ({
      id: preset,
      label,
      count: presetCount(preset).toLocaleString("en-US"),
    })),
    isPressed: () => false,
    onToggle: toggleLanguage,
  });

  const render = (): void => {
    const declared = new Set(
      presetRules(store.get().rules).map((rule) => {
        if (rule.target.kind !== "preset") return "";
        return rule.target.name;
      }),
    );
    chips.render({
      chips: LANG_CHIPS.map(({ preset, label }) => ({
        id: preset,
        label,
        count: presetCount(preset).toLocaleString("en-US"),
      })),
      isPressed: (id) => declared.has(id),
      onToggle: toggleLanguage,
    });
  };
  store.subscribe(render);
  render();
}

/* ------------------ 自定义规则 (the summary list) -------------------- */

/** The side an assignment rule carries ("" when it carries none). */
function ruleSide(rule: EditorRule): "base" | "donor" | "" {
  // Round 6: assignments carry the preference list `[side, other]`
  // (sideRuleFonts) — the side is the FIRST font.
  if (rule.fonts.length < 1 || rule.fonts.length > 2) return "";
  const ref = rule.fonts[0]!;
  if (ref === "base") return "base";
  if (ref === "donor-0") return "donor";
  return "";
}

/** True when `rule` is a complete range rule over exactly `block`. */
function isExactBlockRule(rule: EditorRule, block: UnicodeBlock): boolean {
  if (rule.target.kind !== "range") return false;
  const { start, end } = rule.target;
  if (start === null || end === null) return false;
  return (
    Math.min(start, end) === block.start && Math.max(start, end) === block.end
  );
}

const sideLabel = (side: "base" | "donor"): string =>
  side === "base" ? "英文" : "中文";

/** The verbatim codepoint label: `U+827A 艺` (round 8, owner item 3). */
function cpLabel(cp: number): string {
  return `${formatCp(cp)} ${String.fromCodePoint(cp)}`;
}

/**
 * The block-assignment summaries: per group, the blocks explicitly
 * assigned (exact single-font range rules). A group whose every block
 * carries the same side merges into one `所有{组}字符用…` sentence
 * (prototype parity); a partially-assigned group lists its blocks.
 */
function blockSummaryRows(rules: readonly EditorRule[]): HTMLElement[] {
  const rows: HTMLElement[] = [];
  for (const group of BLOCK_GROUPS) {
    const assigned = new Map<string, { side: "base" | "donor"; rule: EditorRule }>();
    for (const block of group.blocks) {
      for (const rule of rules) {
        if (!isExactBlockRule(rule, block)) continue;
        const side = ruleSide(rule);
        if (side === "") continue;
        assigned.set(block.id, { side, rule });
      }
    }
    if (assigned.size === 0) continue;
    const sides = new Set([...assigned.values()].map((entry) => entry.side));
    if (assigned.size === group.blocks.length && sides.size === 1) {
      const side = [...sides][0]!;
      rows.push(
        ruleRow({
          kind: "group",
          icon: "layers",
          text: `所有${group.name}字符用${sideLabel(side)}字体`,
          onRemove: () =>
            mutateRules(
              rules.filter(
                (rule) =>
                  !group.blocks.some((block) => isExactBlockRule(rule, block)),
              ),
            ),
        }),
      );
      continue;
    }
    for (const block of group.blocks) {
      const entry = assigned.get(block.id);
      if (!entry) continue;
      rows.push(
        ruleRow({
          kind: "block",
          icon: "tag",
          text: `${block.name}用${sideLabel(entry.side)}字体`,
          onRemove: () => removeRule(entry.rule.id),
        }),
      );
    }
  }
  return rows;
}

/**
 * The 自定义规则 section: the summary sentence list (block
 * assignments, custom ranges, the dashed single-character summary —
 * round 8: an expandable group) and the 全部恢复默认 reset — one
 * mutation each, all through the shared rule state. Empty: 暂无自定义
 * 规则。 (preset rules live in the 文字范围 chips, not here).
 */

/** The solo group's expansion state (persists across re-renders). */
let soloExpanded = false;

export function mountRulesSection(root: HTMLElement): void {
  const list = document.createElement("div");
  list.className = "kit-rules";
  root.appendChild(list);

  const render = (): void => {
    const { rules } = store.get();
    const blockRows = blockSummaryRows(rules);
    const rangeRules = rules.filter(
      (rule) =>
        rule.target.kind === "range" &&
        !ALL_BLOCKS.some((block) => isExactBlockRule(rule, block)) &&
        rule.target.start !== null &&
        rule.target.end !== null,
    );
    const codepointRules = rules.filter(
      (rule) => rule.target.kind === "codepoint" && rule.target.cp !== null,
    );

    const items = [...blockRows];
    for (const rule of rangeRules) {
      const target = rule.target as {
        kind: "range";
        start: number;
        end: number;
      };
      const side = ruleSide(rule);
      if (side === "") continue; // not a side rule the UI can state
      const lo = Math.min(target.start, target.end);
      const hi = Math.max(target.start, target.end);
      // The round-8 verbatim sentence: 「U+827A 艺 - U+828F 芏 用中文字体」
      // (a single-codepoint range drops the dash half).
      const chars = lo === hi ? cpLabel(lo) : `${cpLabel(lo)} - ${cpLabel(hi)}`;
      items.push(
        ruleRow({
          kind: "range",
          icon: "range",
          text: `${chars} 用${sideLabel(side)}字体`,
          onRemove: () => removeRule(rule.id),
        }),
      );
    }

    const fragment = document.createDocumentFragment();
    if (items.length === 0 && codepointRules.length === 0) {
      fragment.appendChild(ruleEmptyState());
      list.replaceChildren(fragment);
      return;
    }
    for (const row of items) fragment.appendChild(row);
    if (codepointRules.length > 0) {
      fragment.appendChild(
        ruleSoloRow(codepointRules.length, {
          expanded: soloExpanded,
          onToggle: () => {
            soloExpanded = !soloExpanded;
            render();
          },
          // Round 9 (owner item 6): the aggregate's OWN × deletes the
          // whole single-character group in ONE undoable mutation.
          onRemove: () =>
            mutateRules(rules.filter((rule) => rule.target.kind !== "codepoint")),
        }),
      );
      if (soloExpanded) {
        // The group's children: each single-character rule as its own
        // verbatim row (「U+827A 艺 用中文字体」), removable one by one.
        for (const rule of codepointRules) {
          const side = ruleSide(rule);
          const cp = (rule.target as { cp: number }).cp;
          fragment.appendChild(
            ruleRow({
              kind: "codepoint",
              icon: "pen",
              text: `${cpLabel(cp)} 用${side === "" ? "英文" : sideLabel(side)}字体`,
              onRemove: () => removeRule(rule.id),
            }),
          );
        }
      }
    }
    // 全部恢复默认: clears block assignments, custom ranges, and
    // single-character overrides in ONE undoable mutation (the preset
    // scope under 文字范围 is the universe, not a customization).
    fragment.appendChild(
      undoAllButton(() => {
        mutateRules(rules.filter((rule) => rule.target.kind === "preset"));
      }),
    );
    list.replaceChildren(fragment);
  };
  store.subscribe(render);
  render();
}
