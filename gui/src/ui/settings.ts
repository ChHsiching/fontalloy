import { store, type SynthesisSettings } from "../state";
import { helpNote, mountHelpPopover, workedTable } from "./helpPopover";

/**
 * The synthesis settings (issue #19, ADR-0004 left column): weight
 * merge mode, CJK–Latin baseline alignment, and CJK character width —
 * the three ratified settings, each a click-reachable select plus a
 * ?-popover whose worked-example tables state HONESTLY what the option
 * does in this pipeline (including what is fixed by the ADRs and what
 * is not expressible), never a faked knob.
 */

interface SettingDef<K extends keyof SynthesisSettings> {
  key: K;
  name: string;
  options: Array<{ value: SynthesisSettings[K]; label: string }>;
  topic: {
    title: string;
    buttonLabel: string;
    build(): HTMLElement;
  };
}

const WEIGHT: SettingDef<"weightMode"> = {
  key: "weightMode",
  name: "字重合并方式",
  options: [
    { value: "nearest", label: "双方字重全部保留 · 推荐" },
    { value: "base", label: "仅保留英文字体提供的字重" },
    { value: "donor", label: "仅保留中文字体提供的字重" },
  ],
  topic: {
    title: "什么是字重合并",
    buttonLabel: "什么是字重合并",
    build() {
      const wrap = document.createElement("div");
      wrap.append(
        helpNote(
          "字重就是笔画的粗细，比如细体、常规、中等、粗体。当英文与中文字体可用的字重不一样时，合并成品要决定保留哪些档位。",
        ),
        helpNote(
          "举例：英文字体有细、常规、粗体；中文字体有常规、中等。合并成一套字体时：",
        ),
        workedTable(["选项", "成品字重"], [
          [
            "双方字重全部保留 · 推荐",
            "细、常规、粗体（英文全部档位；每一档的中文取最接近的字重并入）",
          ],
          [
            "仅保留英文字体提供的字重",
            "细、常规、粗体（显式声明与上一项相同的档位集合）",
          ],
          ["仅保留中文字体提供的字重", "常规（仅保留两种字体共有的档位）"],
        ]),
        helpNote(
          "管线约束（ADR-0006）：成品字重只能来自英文字体已有的字面，中文字体独有的档位（如上例的「中等」）不会新增成品字重——中文按「最近字重」并入每一档，每笔借用都写入构建报告。",
        ),
        workedTable(["成品字重", "英文用", "中文用"], [
          ["细", "细", "常规（最近）"],
          ["常规", "常规", "常规"],
          ["粗体", "粗体", "中等（最近）"],
        ]),
        helpNote(
          "例如：成品要粗体，英文有粗体就用英文粗体；中文没有粗体，就用最接近的中文中等。即使某个字重没有单独保留，字也不会丢，只是用最接近的字重显示。",
        ),
      );
      return wrap;
    },
  },
};

const BASELINE: SettingDef<"baseline"> = {
  key: "baseline",
  name: "中英文的基线对齐",
  options: [
    { value: "auto", label: "自动 · 推荐" },
    { value: "grid", label: "中文字和英文底边一样高" },
    { value: "optical", label: "中文字缩小一点更匀称" },
  ],
  topic: {
    title: "中英文的基线对齐",
    buttonLabel: "什么是基线对齐",
    build() {
      const wrap = document.createElement("div");
      wrap.append(
        helpNote(
          "一行文字里，中文与英文的底边高度和大小比例由「缩放学派」决定：本设置选择学派，不移动基线。",
        ),
        workedTable(["选项", "效果"], [
          [
            "自动 · 推荐",
            "按管线默认选择：网格学派（ADR-0003 定为默认，与下一项一致）",
          ],
          [
            "中文字和英文底边一样高",
            "网格学派：中文按 2:1 网格比例缩放，底边落在共享基线上，不额外缩小",
          ],
          [
            "中文字缩小一点更匀称",
            "光学学派：中文按「汉字墨迹 ≈ 1.23 × 大写高度」略缩（normalization.mode = optical）",
          ],
        ]),
        helpNote(
          "固定不变（ADR-0003，非可调项）：中英文永远共用同一条基线（零竖直位移），汉字 em 盒固定为 [−0.12em, +0.88em]，行高完全继承英文字体——本设置只选择缩放学派。",
        ),
        helpNote(
          "这个设置管的是竖直方向；中文字横向占多宽由「中文字符宽度」决定，两者不冲突。",
        ),
      );
      return wrap;
    },
  },
};

const CWIDTH: SettingDef<"cjkWidth"> = {
  key: "cjkWidth",
  name: "中文字符宽度",
  options: [
    { value: "halfwidth", label: "两倍英文宽 · 推荐（引号破折号半角）" },
    { value: "fullwidth", label: "两倍英文宽（引号破折号全角 · 中文习惯）" },
  ],
  topic: {
    title: "中文字符宽度是什么",
    buttonLabel: "中文字符宽度是什么",
    build() {
      const wrap = document.createElement("div");
      wrap.append(
        helpNote(
          "等宽环境里，每个位置按英文字符的宽度计算；中文字形比英文宽，通常占两个位置。",
        ),
        workedTable(["选项", "效果"], [
          [
            "两倍英文宽（引号破折号半角）· 推荐",
            "标准 2:1 等宽；全角引号与破折号按 UAX #11 记为半角（一格）",
          ],
          [
            "两倍英文宽（引号破折号全角）",
            "2:1 不变；引号、破折号等全角标点占两格（quote_dash_width = fullwidth，适合中文排版习惯）",
          ],
          [
            "任意其他比例（如 1.8 倍、1.5 倍）",
            "不可用：宽字符按 UAX #11 固定为整 2 格（ADR-0003——2:1 在终端里是正确性，不是口味），设计稿中的其他比例在本管线中不可表达",
          ],
        ]),
        helpNote(
          "半角与窄字符占一格；模糊宽度且英文已覆盖的码位保持英文字体（缺位不覆盖的推论）。",
        ),
      );
      return wrap;
    },
  },
};

export function mountSettings(root: HTMLElement): void {
  const defs: Array<
    SettingDef<"weightMode"> | SettingDef<"baseline"> | SettingDef<"cjkWidth">
  > = [WEIGHT, BASELINE, CWIDTH];

  const selects: Record<string, HTMLSelectElement> = {};

  for (const def of defs) {
    const row = document.createElement("div");
    row.className = "setting-row";
    row.dataset.setting = def.key;

    const head = document.createElement("div");
    head.className = "setting-head";
    const name = document.createElement("span");
    name.className = "setting-name";
    name.textContent = def.name;
    head.appendChild(name);
    // The ?-button: its popup node mounts on <body> once (ADR-0004).
    head.appendChild(
      mountHelpPopover({ id: def.key, ...def.topic }).anchor,
    );
    row.appendChild(head);

    const select = document.createElement("select");
    select.className = "setting-select";
    select.dataset.role = `select-${def.key}`;
    select.setAttribute("aria-label", def.name);
    for (const option of def.options) {
      const el = document.createElement("option");
      el.value = option.value;
      el.textContent = option.label;
      select.appendChild(el);
    }
    select.addEventListener("change", () => {
      const value = select.value as SynthesisSettings[typeof def.key];
      store.set({ settings: { ...store.get().settings, [def.key]: value } });
    });
    row.appendChild(select);
    selects[def.key] = select;

    root.appendChild(row);
  }

  const render = (): void => {
    const { settings } = store.get();
    selects.weightMode.value = settings.weightMode;
    selects.baseline.value = settings.baseline;
    selects.cjkWidth.value = settings.cjkWidth;
  };
  store.subscribe(render);
  render();
}
