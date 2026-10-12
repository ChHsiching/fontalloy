/**
 * FontAlloy kit — the 自定义规则 summary rows (the rRules parts).
 *
 * The prototype's read-only rule reflection: one bordered row per rule
 * (category icon + sentence + optional dim tabular U+… suffix + the
 * delete ×, VISIBLY present on every row — round 9, owner item 6: the
 * × renders at a readable size and contrast in BOTH themes, never a
 * hover-only ghost), the dashed 单个字符 N aggregate row (round 9: it
 * carries its OWN ×, deleting the whole group as one undo step), and
 * the 暂无自定义规则。 empty state. Rows are static snapshots — the
 * consumer rebuilds the list when the rule state changes; the merged
 * 所有{组}字符用… sentence vs per-block sentences is the consumer's
 * decision (the prototype merges in rRules).
 *
 * Round 8 (owner item 3): the dashed 单个字符 N row is a GROUP HEADER —
 * a real toggle (aria-expanded, the chevron rotates) whose consumer
 * expands into the per-character rows (the same verbatim
 * `U+827A 艺 用中文字体` sentence the range rows carry). The count
 * carries the CJK↔digit half-width space (「单个字符 N」), the kit-level
 * spacing rule every digit↔CJK join follows.
 */

import { icon, type IconName } from "./icons";

export interface RuleRowProps {
  /** Row kind for instrumentation ("group" | "block" | "range" | "codepoint"). */
  kind: string;
  icon: IconName;
  text: string;
  /** Dim tabular suffix (U+4E00 至 U+9F99). */
  suffix?: string;
  onRemove?(): void;
}

/** One summary row: icon + sentence (+ dim suffix) + the delete ×. */
export function ruleRow(props: RuleRowProps): HTMLElement {
  const row = document.createElement("div");
  row.className = "kit-rl";
  row.dataset.role = "rule-row";
  row.dataset.kind = props.kind;
  row.title = props.suffix ? `${props.text} ${props.suffix}` : props.text;
  const ic = document.createElement("span");
  ic.className = "kit-rl-ic";
  ic.innerHTML = icon(props.icon);
  row.appendChild(ic);
  const text = document.createElement("span");
  text.className = "kit-tx";
  text.textContent = props.text;
  row.appendChild(text);
  if (props.suffix !== undefined) {
    const suffix = document.createElement("span");
    suffix.className = "kit-us kit-num";
    suffix.textContent = props.suffix;
    row.appendChild(suffix);
  }
  if (props.onRemove) {
    const del = ruleDeleteButton(props.kind);
    del.addEventListener("click", props.onRemove);
    row.appendChild(del);
  }
  return row;
}

/**
 * The delete × button every removable rule row carries (round 9, owner
 * item 6): a REAL, VISIBLE control — the close glyph at a readable
 * size, a resting contrast the row's own text color carries, danger red
 * on hover. It is an icon-only button (aria-label 删除规则; no text
 * content), so the row's textContent stays its sentence verbatim.
 */
export function ruleDeleteButton(kind = "single"): HTMLButtonElement {
  const del = document.createElement("button");
  del.type = "button";
  del.className = "kit-del";
  del.dataset.role = "remove-rule";
  del.dataset.kind = kind;
  del.setAttribute("aria-label", "删除规则");
  del.title = "删除规则";
  del.innerHTML = icon("close");
  return del;
}

/** The dashed single-character aggregate as an expandable group head. */
export interface RuleSoloProps {
  /** The group is expanded (the per-character rows follow). */
  expanded?: boolean;
  /** Toggle the group (absent renders the old passive row). */
  onToggle?(): void;
  /**
   * Delete the WHOLE group as one undo step (round 9, owner item 6):
   * the aggregate row's own ×, next to its chevron.
   */
  onRemove?(): void;
}

/**
 * The dashed single-character aggregate: pen icon + 单个字符 + N + the
 * chevron + its own delete ×. The row is a GROUP (a div carrying
 * aria-expanded) whose TOGGLE is the wide button covering the sentence
 * — the × never nests inside it (nested buttons are invalid HTML).
 * Round 9 (owner item 6): the × deletes every single-character rule in
 * ONE undoable mutation; the icon-only button keeps the row's
 * textContent 「单个字符 N」 verbatim.
 */
export function ruleSoloRow(
  count: number,
  props: RuleSoloProps = {},
): HTMLElement {
  const expanded = props.expanded ?? false;
  const row = document.createElement("div");
  row.className = "kit-rl dashed kit-rl-solo";
  row.dataset.role = "rule-solo";
  row.setAttribute("aria-expanded", String(expanded));
  row.title = expanded ? "收起单个字符列表" : "展开单个字符列表";
  const pen = document.createElement("span");
  pen.className = "kit-rl-ic";
  pen.innerHTML = icon("pen");
  row.appendChild(pen);
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "kit-rl-toggle";
  toggle.dataset.role = "rule-solo-toggle";
  toggle.setAttribute("aria-expanded", String(expanded));
  toggle.title = expanded ? "收起单个字符列表" : "展开单个字符列表";
  const text = document.createElement("span");
  text.className = "kit-tx";
  text.textContent = "单个字符";
  toggle.appendChild(text);
  // The kit's digit↔CJK spacing rule: a real half-width space, so the
  // textContent reads 「单个字符 N」 however the row is walked.
  toggle.appendChild(document.createTextNode(" "));
  const n = document.createElement("span");
  n.className = "kit-us kit-num";
  n.textContent = String(count);
  toggle.appendChild(n);
  const chevron = document.createElement("span");
  chevron.className = "kit-rl-chev";
  chevron.innerHTML = icon("chevron");
  toggle.appendChild(chevron);
  if (props.onToggle) {
    toggle.addEventListener("click", () => props.onToggle!());
  }
  row.appendChild(toggle);
  if (props.onRemove) {
    const del = ruleDeleteButton("solo");
    del.setAttribute("aria-label", "删除全部单个字符规则");
    del.title = "删除全部单个字符规则";
    del.addEventListener("click", props.onRemove);
    row.appendChild(del);
  }
  return row;
}

/** The empty state (暂无自定义规则。). */
export function ruleEmptyState(): HTMLElement {
  const el = document.createElement("div");
  el.className = "kit-rl-empty";
  el.textContent = "暂无自定义规则。";
  return el;
}
