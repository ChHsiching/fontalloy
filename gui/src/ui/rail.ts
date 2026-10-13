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

  syncScrollFade(root);
  return { en, cjk };
}

/**
 * Round 13, owner item 1: the rail scrolls without ever SHOWING a
 * scrollbar (app.css hides it in both engines); the affordance is a
 * pair of gradient fade masks the scroll position drives — a top fade
 * once the rail is scrolled down, a bottom fade while more content
 * sits below, neither at rest at an end. The listener only toggles
 * two 0/1 custom properties; the mask and its easing are pure CSS.
 * A ResizeObserver re-syncs when the content grows or shrinks under
 * the user (rules added, the Tauri-only 输出目录 row mounting, a
 * viewport resize) — those change scrollability without a scroll
 * event ever firing.
 */
function syncScrollFade(root: HTMLElement): void {
  const update = (): void => {
    const more = root.scrollHeight - root.clientHeight - root.scrollTop;
    root.style.setProperty("--rail-fade-top", root.scrollTop > 0.5 ? "1" : "0");
    root.style.setProperty("--rail-fade-bottom", more > 1 ? "1" : "0");
  };
  root.addEventListener("scroll", update, { passive: true });
  const observer = new ResizeObserver(update);
  observer.observe(root); // the box itself: viewport resizes
  for (const child of root.children) {
    if (child instanceof Element) observer.observe(child); // content growth
  }
  update();
}
