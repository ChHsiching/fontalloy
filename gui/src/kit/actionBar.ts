/**
 * FontAlloy kit — ActionBar (the character-map toolbar) plus its
 * reusable parts: the segmented control and the grid pager.
 *
 * Carried from the prototype's toolrow:
 * - per-GROUP segment (所有中文字符 → 全部用英文字体 / 全部用中文字体);
 * - per-BLOCK segment (汉字区 → 用英文字体 / 用中文字体), or a passive
 *   count note for aggregate views, or the missing-glyph notice;
 * - 多选 / 编码 toggles (active = primary styling), 撤销 (disabled when
 *   the stack is empty);
 * - the pager (‹ 第 n/m 页 ›), the 已调整 legend with its dot, the
 *   codepoint locate field, and 按编码指定;
 * - the batch variant: 已选 n 个 + apply segments + 取消 / 撤销选择 +
 *   the drag hint (按住拖动连选 · Shift+点击 范围选择).
 */

import { icon } from "./icons";

export type FontSide = "base" | "donor";

/* ---------- segmented control (mseg) ---------- */

export interface SegmentedProps {
  options: readonly { value: string; label: string }[];
  /** Active value (matches aria-pressed). */
  value: string;
  onSelect(value: string): void;
  /** Extra class on the tray. */
  className?: string;
}

export function segmentedControl(props: SegmentedProps): HTMLElement {
  const tray = document.createElement("div");
  tray.className = props.className ? `kit-mseg ${props.className}` : "kit-mseg";
  for (const option of props.options) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = option.label;
    btn.setAttribute("aria-pressed", String(option.value === props.value));
    btn.dataset.value = option.value;
    btn.addEventListener("click", () => props.onSelect(option.value));
    tray.appendChild(btn);
  }
  return tray;
}

/* ---------- grid pager (pgc) ---------- */

export interface PagerProps {
  /** Zero-based page index. */
  page: number;
  count: number;
  onPage(delta: 1 | -1): void;
}

export function gridPager(props: PagerProps): HTMLElement {
  const pager = document.createElement("span");
  pager.className = "kit-pgc";
  const prev = document.createElement("button");
  prev.type = "button";
  prev.textContent = "‹";
  prev.setAttribute("aria-label", "上一页");
  prev.disabled = props.page <= 0;
  prev.addEventListener("click", () => props.onPage(-1));
  const label = document.createElement("span");
  label.className = "kit-num";
  label.dataset.pagerLabel = "";
  label.textContent = `第 ${props.page + 1}/${props.count} 页`;
  const next = document.createElement("button");
  next.type = "button";
  next.textContent = "›";
  next.setAttribute("aria-label", "下一页");
  next.disabled = props.page >= props.count - 1;
  next.addEventListener("click", () => props.onPage(1));
  pager.append(prev, label, next);
  return pager;
}

/* ---------- action bar ---------- */

export interface ActionBarProps {
  /** Group segment (omitted outside a group / in missing view). */
  group?: {
    label: string;
    allBase: boolean;
    allDonor: boolean;
    onAssign(side: FontSide): void;
  };
  /** Block segment; aggregate views pass a passive note instead. */
  block?:
    | {
        label: string;
        aggregate?: false;
        /** "" = neither side pressed (no explicit assignment). */
        value: FontSide | "";
        onAssign(side: FontSide): void;
      }
    | {
        label: string;
        aggregate: true;
        count: number;
      };
  /** Missing view replaces both segments with a notice. */
  missingView?: boolean;
  multi: boolean;
  onToggleMulti(): void;
  showCodepoints: boolean;
  onToggleCodepoints(): void;
  canUndo: boolean;
  onUndo(): void;
  /** Pager; omitted on single-page views. */
  page?: PagerProps;
  /** True shows the 已调整 legend with the accent dot. */
  adjustedLegend?: boolean;
  /** Locate field (定位 永 或 U+6C38); fires on Enter. */
  onLocate?(query: string): void;
  locatePlaceholder?: string;
  /** 按编码指定. */
  onRangeSpecify?(): void;
  /** Batch (multi-select) mode replaces the whole row. */
  batch?: {
    count: number;
    canUndoPick: boolean;
    onApply(side: FontSide | "clear"): void;
    onUndoPick(): void;
  };
}

export interface ActionBar {
  readonly el: HTMLElement;
  render(props: ActionBarProps): void;
}

function labelSpan(text: string, dim = false): HTMLElement {
  const span = document.createElement("span");
  span.className = dim ? "kit-lab dim" : "kit-lab";
  span.textContent = text;
  return span;
}

function toggleButton(
  text: string,
  active: boolean,
  onClick: () => void,
  extraData?: string,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `kit-btn sm${active ? " pri" : ""}`;
  btn.textContent = text;
  if (extraData) btn.dataset.role = extraData;
  btn.addEventListener("click", onClick);
  return btn;
}

export function mountActionBar(
  host: HTMLElement,
  initial: ActionBarProps,
): ActionBar {
  const el = document.createElement("div");
  el.className = "kit-toolrow";
  host.appendChild(el);

  let props: ActionBarProps = initial;

  const render = (): void => {
    el.innerHTML = "";

    if (props.batch) {
      const count = document.createElement("span");
      count.className = "kit-cnt";
      count.dataset.role = "batch-count";
      count.textContent = `已选 ${props.batch.count} 个`;
      el.appendChild(count);
      for (const [side, label] of [
        ["base", "用英文字体"],
        ["donor", "用中文字体"],
      ] as const) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "kit-btn sm";
        btn.textContent = label;
        btn.dataset.role = `batch-${side}`;
        btn.addEventListener("click", () => props.batch!.onApply(side));
        el.appendChild(btn);
      }
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "kit-btn sm gh";
      clear.textContent = "取消";
      clear.dataset.role = "batch-clear";
      clear.addEventListener("click", () => props.batch!.onApply("clear"));
      el.appendChild(clear);
      const undoPick = document.createElement("button");
      undoPick.type = "button";
      undoPick.className = "kit-btn sm";
      undoPick.textContent = "撤销";
      undoPick.dataset.role = "undo-pick";
      undoPick.disabled = !props.batch.canUndoPick;
      undoPick.addEventListener("click", () => props.batch!.onUndoPick());
      el.appendChild(undoPick);
      const range = document.createElement("button");
      range.type = "button";
      range.className = "kit-btn sm";
      range.textContent = "按编码指定";
      range.addEventListener("click", () => props.onRangeSpecify?.());
      el.appendChild(range);
      const grow = document.createElement("span");
      grow.className = "kit-grow";
      el.appendChild(grow);
      const hint = labelSpan("按住拖动连选 · Shift+点击 范围选择", true);
      hint.style.fontSize = "11px";
      hint.style.color = "var(--ink3)";
      el.appendChild(hint);
      return;
    }

    if (props.missingView) {
      const notice = labelSpan("缺失字符无法指定来源", true);
      notice.style.fontSize = "12px";
      el.appendChild(notice);
    } else {
      if (props.group) {
        el.appendChild(labelSpan(`所有${props.group.label}字符`));
        el.appendChild(
          segmentedControl({
            options: [
              { value: "base", label: "全部用英文字体" },
              { value: "donor", label: "全部用中文字体" },
            ],
            value: props.group.allBase
              ? "base"
              : props.group.allDonor
                ? "donor"
                : "",
            onSelect: (v) => props.group!.onAssign(v as FontSide),
          }),
        );
        const div = document.createElement("span");
        div.className = "kit-div";
        el.appendChild(div);
      }
      if (props.block) {
        if (props.block.aggregate) {
          el.appendChild(
            labelSpan(
              `${props.block.label} · ${props.block.count.toLocaleString("en-US")} 字符`,
              true,
            ),
          );
        } else {
          el.appendChild(labelSpan(props.block.label));
          el.appendChild(
            segmentedControl({
              options: [
                { value: "base", label: "用英文字体" },
                { value: "donor", label: "用中文字体" },
              ],
              value: props.block.value,
              onSelect: (v) => {
                if (!props.block || props.block.aggregate) return;
                props.block.onAssign(v as FontSide);
              },
            }),
          );
        }
      }
    }

    el.appendChild(
      toggleButton("多选", props.multi, props.onToggleMulti, "toggle-multi"),
    );
    el.appendChild(
      toggleButton(
        "编码",
        props.showCodepoints,
        props.onToggleCodepoints,
        "toggle-codepoints",
      ),
    );
    const undo = document.createElement("button");
    undo.type = "button";
    undo.className = "kit-btn sm";
    undo.textContent = "撤销";
    undo.dataset.role = "undo";
    undo.disabled = !props.canUndo;
    undo.addEventListener("click", props.onUndo);
    el.appendChild(undo);

    const grow = document.createElement("span");
    grow.className = "kit-grow";
    el.appendChild(grow);

    if (props.page && props.page.count > 1) {
      el.appendChild(gridPager(props.page));
    }

    if (props.adjustedLegend) {
      const legend = document.createElement("span");
      legend.className = "kit-legend";
      const dot = document.createElement("span");
      dot.className = "dot";
      legend.append(dot, document.createTextNode("已调整"));
      el.appendChild(legend);
    }

    if (props.onLocate) {
      const input = document.createElement("input");
      input.placeholder = props.locatePlaceholder ?? "永 U+6C38";
      input.setAttribute("aria-label", "定位");
      input.style.minWidth = "120px";
      input.dataset.role = "locate";
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") props.onLocate!(input.value);
      });
      el.appendChild(input);
    }

    if (props.onRangeSpecify) {
      const range = document.createElement("button");
      range.type = "button";
      range.className = "kit-btn sm";
      range.textContent = "按编码指定";
      range.dataset.role = "range-specify";
      range.addEventListener("click", () => props.onRangeSpecify!());
      el.appendChild(range);
    }
  };

  render();

  return {
    el,
    render(next) {
      props = next;
      render();
    },
  };
}

/** The undo icon + label button used by rule lists (re-exported part). */
export function undoAllButton(onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "kit-btn sm gh";
  btn.style.width = "100%";
  btn.innerHTML = icon("undo");
  btn.appendChild(document.createTextNode("全部恢复默认"));
  btn.addEventListener("click", onClick);
  return btn;
}
