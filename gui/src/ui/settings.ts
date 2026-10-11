import { store, type SynthesisSettings } from "../state";
import { mountAppSelect, type AppSelect } from "../kit/appSelect";
import { mountHelpPopover } from "../kit/helpPopover";
import { SETTINGS_TOPICS } from "../kit/settingsTopics";

/**
 * The synthesis settings (issue #19, ADR-0004 left column): weight
 * merge mode, CJK–Latin baseline alignment, and CJK character width —
 * the three ratified settings, each a kit AppSelect plus a ?-popover
 * whose worked-example tables state HONESTLY what the option does in
 * this pipeline (the kit's ADR-corrected topics), never a faked knob.
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
    const row = document.createElement("div");
    row.className = "setting-row";
    row.dataset.setting = key;

    const head = document.createElement("div");
    head.className = "setting-head";
    const name = document.createElement("span");
    name.className = "setting-name";
    name.textContent = topic.name;
    head.appendChild(name);
    // The ?-button: its popup node mounts on <body> once (ADR-0004).
    // The anchor's data-role follows the store key (the popup's
    // data-help-popup keeps the kit topic id).
    const help = mountHelpPopover({
      id: topic.topic.id,
      title: topic.topic.title,
      buttonLabel: topic.topic.buttonLabel,
      width: topic.topic.width,
      build: topic.topic.build,
    });
    help.anchor.dataset.role = `help-${key}`;
    head.appendChild(help.anchor);
    row.appendChild(head);

    const select = mountAppSelect({
      label: topic.name,
      // The cjkWidth topic's values are the numeric width factor's
      // string form (2 / 1.8 / 1.5); the store keeps the number.
      value:
        key === "cjkWidth"
          ? String(store.get().settings[key])
          : store.get().settings[key],
      options: topic.options,
      onChange: (value) => {
        store.set({
          settings: {
            ...store.get().settings,
            [key]: key === "cjkWidth" ? Number(value) : value,
          },
        });
      },
    });
    select.el.dataset.role = `select-${key}`;
    row.appendChild(select.el);
    selects[key] = select;

    root.appendChild(row);
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
