/**
 * The rail's rule-editing sections (issue #18): language presets (with
 * sub-block toggles, union semantics per ticket #7) under 字符范围, and
 * the editable rule list (custom ranges, single codepoints, preset
 * rules — add / edit / reorder fonts / remove) under 自定义规则.
 *
 * Every edit writes the shared rule state in `store` — the same state
 * the grid resolves and the synthesize flow serializes — through
 * `mutateRules`, which snapshots the prior state into the rule undo
 * stack (issue #20). Batch applies live in the charmap's selection
 * editor; 撤销规则 below is the rule undo stack's click entry point
 * (Ctrl+Z is the keyboard one).
 *
 * The preset picker follows the ADR-0004 popup pattern: one body-level
 * node created at mount, rows rebuild, positioning clamps to the frame.
 */

import { store } from "../state";
import {
  effectiveSetName,
  newRule,
  parseCodepointInput,
  targetLabel,
  type EditorRule,
} from "../precedence/model";
import { pickRefs, refLabel } from "../precedence/picks";
import { canUndoRules, mutateRules, undoRules } from "../history";
import presetsData from "../data/presets.json";
import { mountPresetPicker } from "./presetpicker";

/* ------------------------- store patches ---------------------------- */

function patchRule(id: number, patch: (rule: EditorRule) => EditorRule): void {
  mutateRules(
    store.get().rules.map((rule) => (rule.id === id ? patch(rule) : rule)),
  );
}

function removeRule(id: number): void {
  mutateRules(store.get().rules.filter((rule) => rule.id !== id));
}

/* --------------------- shared font-list editor ----------------------- */

/**
 * The ordered font list of one rule: one line per ref (checked =
 * member, in precedence order), with move-up/down controls. The first
 * listed font holding a codepoint wins — absence never overrides.
 */
function buildFontList(
  rule: EditorRule,
  onChange: (fonts: string[]) => void,
): HTMLElement {
  const picks = pickRefs();
  const list = document.createElement("div");
  list.className = "rule-fonts";
  const order = [
    ...rule.fonts,
    ...picks.refs.filter((ref) => !rule.fonts.includes(ref)),
  ];
  for (const ref of order) {
    const checked = rule.fonts.includes(ref);
    const line = document.createElement("div");
    line.className = "rule-font-line";
    line.dataset.fontRef = ref;
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.dataset.role = `rule-font-${rule.id}-${ref}`;
    box.checked = checked;
    box.addEventListener("change", () => {
      onChange(
        box.checked
          ? [...rule.fonts, ref]
          : rule.fonts.filter((entry) => entry !== ref),
      );
    });
    label.appendChild(box);
    label.appendChild(document.createTextNode(` ${refLabel(ref, picks)}`));
    line.appendChild(label);
    for (const [direction, delta] of [
      ["up", -1],
      ["down", 1],
    ] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "rule-font-move kit-btn sm gh";
      button.dataset.role = `rule-font-${direction}-${rule.id}-${ref}`;
      button.textContent = delta < 0 ? "↑" : "↓";
      button.disabled = !checked;
      button.addEventListener("click", () => {
        const from = rule.fonts.indexOf(ref);
        const to = from + delta;
        if (from < 0 || to < 0 || to >= rule.fonts.length) return;
        const fonts = [...rule.fonts];
        fonts.splice(to, 0, fonts.splice(from, 1)[0]!);
        onChange(fonts);
      });
      line.appendChild(button);
    }
    list.appendChild(line);
  }
  return list;
}

/** One text input bound to a parse-and-patch handler (live editing). */
function codepointInput(
  value: number | null,
  role: string,
  onParsed: (cp: number | null) => void,
): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "search";
  input.className = "rule-cp-input";
  input.dataset.role = role;
  input.placeholder = "如 0x4E2D";
  input.value = value === null ? "" : `0x${value.toString(16).toUpperCase()}`;
  input.addEventListener("input", () => {
    const text = input.value.trim();
    onParsed(text === "" ? null : parseCodepointInput(text));
  });
  return input;
}

/* --------------------------- rule rows ------------------------------ */

/** Whether a rule's target is fully specified (resolvable, serializable). */
function ruleComplete(rule: EditorRule): boolean {
  const target = rule.target;
  if (target.kind === "codepoint") return target.cp !== null;
  if (target.kind === "range") return target.start !== null && target.end !== null;
  return true;
}

function buildRuleRow(rule: EditorRule): HTMLElement {
  const row = document.createElement("div");
  row.className = "rule-row";
  row.dataset.ruleId = String(rule.id);
  // Test/a11y oracle: a half-typed row is not a rule yet (the complete
  // count is what the recipe will declare).
  row.dataset.complete = String(ruleComplete(rule));
  row.setAttribute(
    "data-role",
    rule.target.kind === "preset" ? "preset-rule" : "custom-rule",
  );

  const head = document.createElement("div");
  head.className = "rule-row-head";
  const target = rule.target;

  if (target.kind === "preset") {
    row.classList.add("is-preset");
    const name = document.createElement("span");
    name.className = "rule-target-label";
    name.textContent = target.name;
    head.appendChild(name);
    const effective = document.createElement("span");
    effective.className = "rule-effective-set";
    effective.textContent = `生效集合：${effectiveSetName(
      PRESETS_BY_NAME.get(target.name),
      target.blocks,
    )}`;
    head.appendChild(effective);
  } else if (target.kind === "range") {
    const label = document.createElement("span");
    label.className = "rule-target-label";
    label.textContent = targetLabel(rule);
    head.appendChild(label);
    const start = codepointInput(target.start, `rule-start-${rule.id}`, (cp) =>
      patchRule(rule.id, (r) => ({
        ...r,
        target: { kind: "range", start: cp, end: r.target.kind === "range" ? r.target.end : null },
      })),
    );
    start.classList.add("rule-range-input");
    head.appendChild(start);
    head.appendChild(document.createTextNode(" – "));
    const end = codepointInput(target.end, `rule-end-${rule.id}`, (cp) =>
      patchRule(rule.id, (r) => ({
        ...r,
        target: { kind: "range", start: r.target.kind === "range" ? r.target.start : null, end: cp },
      })),
    );
    end.classList.add("rule-range-input");
    head.appendChild(end);
  } else {
    const label = document.createElement("span");
    label.className = "rule-target-label";
    label.textContent = targetLabel(rule);
    head.appendChild(label);
    head.appendChild(
      codepointInput(target.cp, `rule-codepoint-${rule.id}`, (cp) =>
        patchRule(rule.id, (r) => ({
          ...r,
          target: { kind: "codepoint", cp },
        })),
      ),
    );
  }

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "rule-remove kit-btn sm gh";
  remove.dataset.role = "remove-rule";
  remove.textContent = "移除";
  remove.addEventListener("click", () => removeRule(rule.id));
  head.appendChild(remove);
  row.appendChild(head);

  // Preset rows carry their sub-block toggles (union semantics).
  if (target.kind === "preset") {
    const preset = PRESETS_BY_NAME.get(target.name);
    if (preset && preset.sub_blocks.length > 1) {
      const blocks = document.createElement("div");
      blocks.className = "rule-subblocks";
      for (const block of preset.sub_blocks) {
        const label = document.createElement("label");
        label.className = "rule-subblock";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.dataset.role = `subblock-${block.name}`;
        box.checked = target.blocks.includes(block.name);
        // The union must stay non-empty: the last enabled block holds.
        box.disabled = target.blocks.length === 1 && box.checked;
        box.addEventListener("change", () => {
          patchRule(rule.id, (r) => ({
            ...r,
            target:
              r.target.kind === "preset"
                ? {
                    kind: "preset",
                    name: r.target.name,
                    blocks: box.checked
                      ? [...r.target.blocks, block.name]
                      : r.target.blocks.filter((name) => name !== block.name),
                  }
                : r.target,
          }));
        });
        label.appendChild(box);
        label.appendChild(
          document.createTextNode(` ${block.name} ${block.codepoints.toLocaleString("en-US")}`),
        );
        blocks.appendChild(label);
      }
      row.appendChild(blocks);
    }
  }

  row.appendChild(
    buildFontList(rule, (fonts) =>
      patchRule(rule.id, (r) => ({ ...r, fonts })),
    ),
  );
  return row;
}

/* --------------------------- sections ------------------------------- */

const PRESETS_BY_NAME = new Map(
  presetsData.presets.map((preset) => [preset.name, preset]),
);

/** The 语言预设 section: one button opening the preset picker. */
export function mountPresetSection(root: HTMLElement): void {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "add-rule-button kit-btn sm";
  button.dataset.role = "add-preset";
  button.textContent = "添加语言预设…";
  root.appendChild(button);
  mountPresetPicker(button);
}

/**
 * The 自定义规则 section: add buttons + the rule list (every rule in
 * declaration order — preset rules included — each editable in place).
 */
export function mountRulesSection(root: HTMLElement): void {
  const actions = document.createElement("div");
  actions.className = "rule-actions";
  const addRange = document.createElement("button");
  addRange.type = "button";
  addRange.className = "add-rule-button kit-btn sm";
  addRange.dataset.role = "add-range-rule";
  addRange.textContent = "新增区间规则";
  addRange.addEventListener("click", () => {
    const refs = pickRefs().refs;
    mutateRules([
      ...store.get().rules,
      newRule({ kind: "range", start: null, end: null }, refs),
    ]);
  });
  actions.appendChild(addRange);
  const addCp = document.createElement("button");
  addCp.type = "button";
  addCp.className = "add-rule-button kit-btn sm";
  addCp.dataset.role = "add-cp-rule";
  addCp.textContent = "新增码位规则";
  addCp.addEventListener("click", () => {
    const refs = pickRefs().refs;
    mutateRules([
      ...store.get().rules,
      newRule({ kind: "codepoint", cp: null }, refs),
    ]);
  });
  actions.appendChild(addCp);
  // Rule undo's click entry point (Ctrl+Z is the keyboard one): every
  // rules write went through mutateRules, so one click steps back one
  // mutation — rail edits, cell applies, batch applies alike.
  const undo = document.createElement("button");
  undo.type = "button";
  undo.className = "add-rule-button kit-btn sm";
  undo.dataset.role = "rules-undo";
  undo.textContent = "撤销规则";
  undo.disabled = !canUndoRules();
  undo.addEventListener("click", () => undoRules());
  actions.appendChild(undo);
  root.appendChild(actions);

  const list = document.createElement("div");
  list.className = "rule-list";
  root.appendChild(list);

  const render = (): void => {
    // The undo affordance follows the stack, even when the list itself
    // is being kept alive for a focused text input (see below).
    undo.disabled = !canUndoRules();
    // While a rule's text input is being typed into, keep the node (a
    // rebuild would drop focus); the grid still updates live — regions
    // re-render independently. focusout triggers the catch-up rebuild.
    const active = document.activeElement;
    if (
      active instanceof HTMLInputElement &&
      active.type !== "checkbox" &&
      root.contains(active)
    ) {
      // The node stays (a rebuild would drop focus) — but its
      // completeness oracle follows the store, not the stale node.
      for (const rowEl of list.querySelectorAll<HTMLElement>("[data-rule-id]")) {
        const rule = store.get().rules.find((r) => String(r.id) === rowEl.dataset.ruleId);
        if (rule) rowEl.dataset.complete = String(ruleComplete(rule));
      }
      return;
    }
    const { rules } = store.get();
    const fragment = document.createDocumentFragment();
    if (rules.length === 0) {
      const empty = document.createElement("div");
      empty.className = "rule-list-empty";
      empty.textContent = "尚未声明规则 —— 空缺码位由默认优先级填充。";
      fragment.appendChild(empty);
    } else {
      for (const rule of rules) fragment.appendChild(buildRuleRow(rule));
    }
    list.replaceChildren(fragment);
  };
  root.addEventListener("focusout", () => {
    // A microtask later: let the change/patch land, then rebuild.
    setTimeout(render, 0);
  });
  store.subscribe(render);
  render();
}
