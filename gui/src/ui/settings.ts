import { store, type SynthesisSettings } from "../state";
import type { AppSelect } from "../kit/appSelect";
import { SETTINGS_TOPICS, mountSettingRow } from "../kit/settingsTopics";

/**
 * The synthesis settings (issue #19, ADR-0004 left column): weight
 * merge mode, CJK–Latin baseline alignment, and CJK character width —
 * the prototype's three settings rows, each assembled from the kit
 * (mountSettingRow: label + ?-popover + AppSelect; the weight topic
 * keeps its single ADR-0006 correction — output weight slots come only
 * from the base font's faces). The screen owns only the VALUE wiring.
 */

/** The store key of each kit topic ("weight" is the store's weightMode). */
const STORE_KEY: Record<string, keyof SynthesisSettings> = {
  weight: "weightMode",
  baseline: "baseline",
  cjkWidth: "cjkWidth",
};

export function mountSettings(root: HTMLElement): void {
  const selects: Partial<Record<keyof SynthesisSettings, AppSelect>> = {};

  for (const topic of SETTINGS_TOPICS) {
    const key = STORE_KEY[topic.key]!;
    const row = mountSettingRow(topic, {
      // The cjkWidth topic's values are the numeric width factor's
      // string form (2 / 1.8 / 1.5); the store keeps the number.
      value:
        key === "cjkWidth"
          ? String(store.get().settings[key])
          : store.get().settings[key],
      onChange: (value) => {
        store.set({
          settings: {
            ...store.get().settings,
            [key]: key === "cjkWidth" ? Number(value) : value,
          },
        });
      },
    });
    row.el.dataset.setting = key;
    // The ?-button's data-role follows the store key (the popup's
    // data-help-popup keeps the kit topic id).
    row.helpAnchor.dataset.role = `help-${key}`;
    row.select.el.dataset.role = `select-${key}`;
    root.appendChild(row.el);
    selects[key] = row.select;
  }

  const render = (): void => {
    const { settings } = store.get();
    for (const [key, select] of Object.entries(selects)) {
      if (!select) continue;
      const value = settings[key as keyof SynthesisSettings];
      select.value =
        key === "cjkWidth" ? String(value) : (value as string);
    }
  };
  store.subscribe(render);
  render();
}
