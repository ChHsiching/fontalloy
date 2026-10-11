import { mountPicker, type FontPicker } from "./picker";
import { mountPresetSection, mountRulesSection } from "./rulelist";
import { mountSettings } from "./settings";

/**
 * The fixed 260px left column (ADR-0004): English font, CJK font,
 * character scope (language presets, issue #18), custom rules (issue
 * #18), synthesis settings (issue #19) — the prototype's five sections,
 * in the prototype's order and wording, with its one explanatory note
 * (under 文字范围 only; the audit's 1.6 finding).
 */
export function mountRail(root: HTMLElement): { en: FontPicker; cjk: FontPicker } {
  const enSlot = document.createElement("div");
  const cjkSlot = document.createElement("div");
  const presetSlot = document.createElement("div");
  const rulesSlot = document.createElement("div");
  const settingsSlot = document.createElement("div");

  const sections: Array<[string, string | null, HTMLElement]> = [
    ["英文字体", null, enSlot],
    ["中文字体", null, cjkSlot],
    ["文字范围", "勾选的文字由中文字体提供，并入成品", presetSlot],
    ["自定义规则", null, rulesSlot],
    ["合成设置", null, settingsSlot],
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
    if (note) {
      const desc = document.createElement("div");
      desc.className = "section-desc";
      desc.textContent = note;
      section.appendChild(desc);
    }
    section.appendChild(slot);
    root.appendChild(section);
    delay += 40;
  }

  const en = mountPicker(enSlot, { role: "en" });
  const cjk = mountPicker(cjkSlot, { role: "cjk" });
  mountPresetSection(presetSlot);
  mountRulesSection(rulesSlot);
  mountSettings(settingsSlot);
  return { en, cjk };
}
