/**
 * FontAlloy kit — the 自定义规则 summary rows (the rRules parts).
 *
 * The prototype's read-only rule reflection: one bordered row per rule
 * (category icon + sentence + optional dim tabular U+… suffix + the
 * delete ×, danger-red on hover), the dashed 单个字符 N aggregate row,
 * and the 暂无自定义规则。 empty state. Rows are static snapshots — the
 * consumer rebuilds the list when the rule state changes; the merged
 * 所有{组}字符用… sentence vs per-block sentences is the consumer's
 * decision (the prototype merges in rRules).
 */

import { icon, type IconName } from "./icons";

export interface RuleRowProps {
  /** Row kind for instrumentation ("group" | "block" | "range"). */
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
    const del = document.createElement("button");
    del.type = "button";
    del.className = "kit-del";
    del.dataset.role = "remove-rule";
    del.setAttribute("aria-label", "删除规则");
    del.innerHTML = icon("close");
    del.addEventListener("click", props.onRemove);
    row.appendChild(del);
  }
  return row;
}

/** The dashed single-character aggregate: pen icon + 单个字符 + count. */
export function ruleSoloRow(count: number): HTMLElement {
  const row = document.createElement("div");
  row.className = "kit-rl dashed";
  row.dataset.role = "rule-solo";
  const pen = document.createElement("span");
  pen.className = "kit-rl-ic";
  pen.innerHTML = icon("pen");
  row.appendChild(pen);
  const text = document.createElement("span");
  text.className = "kit-tx";
  text.textContent = "单个字符";
  row.appendChild(text);
  const n = document.createElement("span");
  n.className = "kit-us kit-num";
  n.textContent = String(count);
  row.appendChild(n);
  return row;
}

/** The empty state (暂无自定义规则。). */
export function ruleEmptyState(): HTMLElement {
  const el = document.createElement("div");
  el.className = "kit-rl-empty";
  el.textContent = "暂无自定义规则。";
  return el;
}
