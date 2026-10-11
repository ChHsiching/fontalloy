/**
 * FontAlloy kit — the synthesis-settings topics (content data).
 *
 * The three ratified settings (weight merge, baseline alignment, CJK
 * width) with their ?-popover copy. Prose structure and table CHROME
 * follow the validated prototype; table CONTENT is the
 * semantically-corrected version wherever the prototype's draft tables
 * were superseded by the ADRs — each such table is marked with a
 * `CONTENT CORRECTED` comment so Stage 2 and the owner can find them:
 *
 * - weight tables: ADR-0006 (output weight slots come only from the
 *   base font's faces; donors borrow by nearest match and never create
 *   slots — the prototype's "细、常规、中等、粗体" row and the 中等
 *   output row are unreachable and dropped);
 * - baseline/cjk-width tables: ADR-0003 (one shared baseline and 2:1
 *   wide advance are invariants; the knob is the scale school / the
 *   fullwidth-quotes convention — the prototype's 1.8× / 1.5× width
 *   options are inexpressible in this pipeline).
 */

import type { AppSelectOption } from "./appSelect";
import { helpNote, workedTable } from "./helpPopover";

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
      { value: "nearest", label: "双方字重全部保留 · 推荐" },
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
          helpNote(
            "字重，就是字的笔画粗细。比如：细、常规、中等、粗体。",
          ),
          helpNote(
            "当一套字体里同时有英文和中文时，英文和中文可用的字重可能不一样。举例：英文字体有：细、常规、粗体；中文字体有：常规、中等。",
          ),
          helpNote("合并成一套字体时，可以选择保留哪些字重："),
          // CONTENT CORRECTED (ADR-0006): the prototype's first row
          // claimed 双方字重全部保留 → 细、常规、中等、粗体, i.e. a
          // donor-only weight creating an output slot. Output slots come
          // only from the base font's faces; the donor-only row reads
          // 共有档位 semantics instead. Table chrome stays verbatim.
          workedTable(["选项", "成品字重"], [
            [
              "双方字重全部保留 · 推荐",
              "细、常规、粗体（档位来自英文字体，每一档的中文取最接近的字重并入）",
            ],
            [
              "仅保留英文字体提供的字重",
              "细、常规、粗体（显式声明与上一项相同的档位集合）",
            ],
            ["仅保留中文字体提供的字重", "常规（仅保留两种字体共有的档位）"],
          ]),
          helpNote(
            "如果某个成品字重在某种语言里没有对应字重，就用最接近的字重代替：",
          ),
          // CONTENT CORRECTED (ADR-0006): the prototype's 中等 output row
          // is dropped — a donor-only weight can never be an output slot.
          workedTable(["成品字重", "英文用", "中文用"], [
            ["细", "细", "常规（最近）"],
            ["常规", "常规", "常规"],
            ["粗体", "粗体", "中等（最近）"],
          ]),
          helpNote(
            "例如：成品要粗体，英文有粗体，所以用英文粗体；中文没有粗体，所以用中文中等。成品要常规，两种字体都有常规，所以都用常规。",
          ),
          helpNote(
            "管线约束（ADR-0006）：成品字重只能来自英文字体已有的字面，中文字体独有的档位不会新增成品字重——每笔借用都写入构建报告。即使某个字重没有单独保留，字也不会丢，只是会用最接近的字重显示。",
          ),
        );
        return wrap;
      },
    },
  },
  {
    key: "baseline",
    name: "中英文的基线对齐",
    options: [
      { value: "auto", label: "自动 · 推荐" },
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
          // CONTENT CORRECTED (ADR-0003): 共享基线与行高是不变量，
          // 选项选择的是缩放学派；prototype 的表格未说明这一点。
          workedTable(["选项", "效果"], [
            ["自动 · 推荐", "按管线默认选择：网格学派（ADR-0003 定为默认）"],
            [
              "中文字和英文底边一样高",
              "网格学派：中文按 2:1 网格比例缩放，底边落在共享基线上，不额外缩小",
            ],
            [
              "中文字缩小一点更匀称",
              "光学学派：中文按「汉字墨迹 ≈ 1.23 × 大写高度」略缩",
            ],
          ]),
          helpNote(
            "固定不变（ADR-0003）：中英文永远共用同一条基线（零竖直位移），行高完全继承英文字体——本设置只选择缩放学派，不移动基线。",
          ),
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
      { value: "halfwidth", label: "两倍英文宽 · 推荐（引号破折号半角）" },
      { value: "fullwidth", label: "两倍英文宽（引号破折号全角 · 中文习惯）" },
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
          // CONTENT CORRECTED (ADR-0003): the prototype offered 2 / 1.8 /
          // 1.5 倍 widths; wide CJK advance is fixed at exactly 2 cells
          // (correctness, not taste). The adjustable item is the
          // fullwidth quotes/dashes convention.
          workedTable(["选项", "效果"], [
            [
              "两倍英文宽（引号破折号半角）· 推荐",
              "标准 2:1 等宽，一个中文正好对齐两个英文；全角引号与破折号记为一格",
            ],
            [
              "两倍英文宽（引号破折号全角）",
              "2:1 不变；引号、破折号等全角标点占两格（中文排版习惯）",
            ],
            [
              "任意其他比例（如 1.8 倍、1.5 倍）",
              "不可用：宽字符按 UAX #11 固定为整 2 格（ADR-0003），设计稿中的其他比例在本管线中不可表达",
            ],
          ]),
          helpNote(
            "半角与窄字符占一格；模糊宽度且英文已覆盖的码位保持英文字体（缺位不覆盖的推论）。",
          ),
        );
        return wrap;
      },
    },
  },
];
