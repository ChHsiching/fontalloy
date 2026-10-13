/**
 * FontAlloy kit — the synthesis-settings topics (content data).
 *
 * The three settings (weight merge, baseline alignment, CJK width) with
 * their ?-popover copy. Prose structure and tables follow the validated
 * prototype VERBATIM — including the weight topic's tables (round 5,
 * owner item 11: help content is the prototype's text, full stop — no
 * engineering notes in user-facing popovers; the ADR-0006 correction
 * lives in the docs and the pipeline, not here).
 */

import { mountAppSelect, type AppSelect, type AppSelectOption } from "./appSelect";
import { mountHelpPopover, helpNote, workedTable } from "./helpPopover";

export interface SettingsTopic {
  key: string;
  /** Row label (设置行的名字). */
  name: string;
  /** AppSelect options for the setting. */
  options: readonly AppSelectOption[];
  /** The ?-popover definition. */
  topic: {
    id: string;
    title: string;
    buttonLabel: string;
    /** Popover width in px (prototype: 380 weight, 340 others). */
    width: number;
    build(): HTMLElement;
  };
}

export const SETTINGS_TOPICS: readonly SettingsTopic[] = [
  {
    key: "weight",
    name: "字重合并方式",
    options: [
      { value: "nearest", label: "双方字重全部保留", badge: "推荐" },
      { value: "base", label: "仅保留英文字体提供的字重" },
      { value: "donor", label: "仅保留中文字体提供的字重" },
    ],
    topic: {
      id: "weight",
      title: "什么是字重",
      buttonLabel: "什么是字重",
      width: 380,
      build() {
        const wrap = document.createElement("div");
        wrap.append(
          helpNote(["字重，就是字的笔画粗细。", "比如：细、常规、中等、粗体。"]),
          helpNote("当一套字体里同时有英文和中文时，英文和中文可用的字重可能不一样。举例："),
          helpNote(["英文字体有：细、常规、粗体", "中文字体有：常规、中等"]),
          helpNote("合并成一套字体时，可以选择保留哪些字重："),
          // Verbatim prototype table (inventory item 28, round 5).
          workedTable(["选项", "成品字重"], [
            ["双方字重全部保留 · 推荐", "细、常规、中等、粗体"],
            ["仅保留英文字体提供的字重", "细、常规、粗体"],
            ["仅保留中文字体提供的字重", "常规、中等"],
          ]),
          helpNote("如果某个成品字重在某种语言里没有对应字重，就用最接近的字重代替："),
          // Verbatim prototype table — including the 中等 row the earlier
          // ADR-0006 correction dropped (owner ruling, round 5).
          workedTable(["成品字重", "英文用", "中文用"], [
            ["细", "细", "常规"],
            ["常规", "常规", "常规"],
            ["中等", "常规", "中等"],
            ["粗体", "粗体", "中等"],
          ]),
          helpNote(
            "例如：成品要粗体，英文有粗体，所以用英文粗体；中文没有粗体，所以用中文中等。成品要中等，中文有中等，所以用中文中等；英文没有中等，所以用英文常规。",
          ),
          helpNote("即使某个字重没有单独保留，字也不会丢，只是会用最接近的字重显示。"),
        );
        return wrap;
      },
    },
  },
  {
    key: "baseline",
    name: "中英文的基线对齐",
    options: [
      { value: "auto", label: "自动", badge: "推荐" },
      { value: "grid", label: "中文字和英文底边一样高" },
      { value: "optical", label: "中文字缩小一点更匀称" },
    ],
    topic: {
      id: "baseline",
      title: "中英文的基线对齐",
      buttonLabel: "什么是基线对齐",
      width: 340,
      build() {
        const wrap = document.createElement("div");
        wrap.append(
          helpNote(
            "一行文字里，中文字和英文字的底边不一定在同一个高度，大小比例也不一样。这个设置决定中文放在什么高度、缩放到多大：",
          ),
          // Verbatim prototype table (inventory item 29).
          workedTable(["选项", "效果"], [
            ["自动 · 推荐", "按两款字体自带的尺寸数据自动选择"],
            ["底边一样高", "中文的底边精确落在英文的底线上，不缩放"],
            ["缩小一点更匀称", "中文稍微缩小，中英混排不会显得中文偏大"],
          ]),
          helpNote(
            "这个设置管的是竖直方向；中文字横向占多宽由“中文字符宽度”决定，两者不冲突。",
          ),
        );
        return wrap;
      },
    },
  },
  {
    key: "cjkWidth",
    name: "中文字符宽度",
    options: [
      { value: "2", label: "两倍英文宽", badge: "推荐" },
      { value: "1.8", label: "1.8 倍英文宽" },
      { value: "1.5", label: "1.5 倍英文宽" },
    ],
    topic: {
      id: "cjk-width",
      title: "中文字符宽度是什么",
      buttonLabel: "中文字符宽度是什么",
      width: 340,
      build() {
        const wrap = document.createElement("div");
        wrap.append(
          helpNote(
            "等宽环境里，每个字符占的位置按英文字符的宽度计算。中文字形比英文宽，通常占 2 个位置：",
          ),
          // Verbatim prototype table (inventory item 30): the 1.8x /
          // 1.5x rows are the pipeline's `normalization.width_factor`.
          workedTable(["选项", "效果"], [
            ["两倍英文宽 · 推荐", "标准等宽，一个中文正好对齐两个英文"],
            ["1.8 倍英文宽", "稍紧凑，一行能多放几个字"],
            ["1.5 倍英文宽", "很窄，一行能放更多中文"],
          ]),
        );
        return wrap;
      },
    },
  },
];

/* -------------------------------------------------------------------- */
/* The settings ROW (prototype L428–443): label + ? + AppSelect.         */
/* -------------------------------------------------------------------- */

export interface SettingRow {
  readonly el: HTMLElement;
  readonly select: AppSelect;
  /** The ?-button's anchor (consumers annotate data-role on it). */
  readonly helpAnchor: HTMLElement;
}

/**
 * One settings row — the prototype's `.set` chrome: the label with the
 * circular ? help button beside it, the kit AppSelect under it. The
 * consumer owns the VALUE wiring (render on store change).
 */
export function mountSettingRow(
  topic: SettingsTopic,
  props: {
    value: string;
    onChange(value: string): void;
  },
): SettingRow {
  const el = document.createElement("div");
  el.className = "kit-setrow";

  const head = document.createElement("div");
  head.className = "kit-sethead";
  const name = document.createElement("span");
  name.className = "kit-setname";
  name.textContent = topic.name;
  head.appendChild(name);
  const help = mountHelpPopover({
    id: topic.topic.id,
    title: topic.topic.title,
    buttonLabel: topic.topic.buttonLabel,
    width: topic.topic.width,
    build: topic.topic.build,
  });
  head.appendChild(help.anchor);
  el.appendChild(head);

  const select = mountAppSelect({
    label: topic.name,
    value: props.value,
    options: topic.options,
    onChange: props.onChange,
  });
  el.appendChild(select.el);

  return { el, select, helpAnchor: help.anchor };
}
