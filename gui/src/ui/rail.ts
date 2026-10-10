import { mountPicker, type FontPicker } from "./picker";
import { mountPresetSection, mountRulesSection } from "./rulelist";

/**
 * The fixed 260px left column (ADR-0004): English font, CJK font,
 * character scope (language presets, issue #18), custom rules (issue
 * #18), synthesis settings (placeholder for a later ticket).
 */
export function mountRail(root: HTMLElement): { en: FontPicker; cjk: FontPicker } {
  const enSlot = document.createElement("div");
  const cjkSlot = document.createElement("div");
  const presetSlot = document.createElement("div");
  const rulesSlot = document.createElement("div");

  const sections: Array<[string, string | null, HTMLElement | null]> = [
    ["英文字体", "基底：合成结果继承它的度量与身份", enSlot],
    ["中文字体", "供体：为空缺码位提供中日韩字符", cjkSlot],
    [
      "字符范围",
      "语言预设：按语言预先整理的码位集合，子块可独立开关。",
      presetSlot,
    ],
    [
      "自定义规则",
      "码位/区间 → 有序字体列表。窄者胜；同层后声明的胜；字体缺失不覆盖。",
      rulesSlot,
    ],
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
      if (note) {
        const desc = document.createElement("div");
        desc.className = "section-desc placeholder-note";
        desc.textContent = note;
        section.appendChild(desc);
      }
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
    emptyText: "尚未加载字体",
  });
  const cjk = mountPicker(cjkSlot, {
    role: "cjk",
    emptyText: "尚未加载字体",
  });
  mountPresetSection(presetSlot);
  mountRulesSection(rulesSlot);
  return { en, cjk };
}
