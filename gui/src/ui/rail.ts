import { mountPicker, type FontPicker } from "./picker";

/**
 * The fixed 260px left column (ADR-0004): English font, CJK font, character
 * scope, custom rules, synthesis settings. The last three are placeholders
 * for later tickets; their bodies state so in visible text.
 */
export function mountRail(root: HTMLElement): { en: FontPicker; cjk: FontPicker } {
  const enSlot = document.createElement("div");
  const cjkSlot = document.createElement("div");

  const sections: Array<[string, string, HTMLElement | null]> = [
    ["英文字体", "字体选择器", enSlot],
    ["中文字体", "字体选择器", cjkSlot],
    ["字符范围", "语言预设与自定义码位范围将在后续版本开放。", null],
    ["自定义规则", "码位区间到字体列表的优先级规则将在后续版本开放。", null],
    ["合成设置", "网格比例、基线与宽度策略等合成参数将在后续版本开放。", null],
  ];

  let delay = 60;
  for (const [title, note, slot] of sections) {
    const section = document.createElement("section");
    section.className = "section enter";
    section.style.animationDelay = `${delay}ms`;
    const h = document.createElement("h3");
    h.className = "section-title";
    h.textContent = title;
    section.appendChild(h);
    if (slot) {
      section.appendChild(slot);
    } else {
      const body = document.createElement("div");
      body.className = "section-body placeholder-note";
      body.textContent = note;
      section.appendChild(body);
    }
    root.appendChild(section);
    delay += 40;
  }

  const en = mountPicker(enSlot, {
    role: "en",
    label: "基底（英文）字体",
    emptyText: "尚未加载字体",
  });
  const cjk = mountPicker(cjkSlot, {
    role: "cjk",
    label: "供体（中文）字体",
    emptyText: "尚未加载字体",
  });
  return { en, cjk };
}
