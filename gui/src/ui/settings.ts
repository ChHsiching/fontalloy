import { store, type SynthesisSettings } from "../state";
import type { AppSelect } from "../kit/appSelect";
import { SETTINGS_TOPICS, mountSettingRow } from "../kit/settingsTopics";
import { mountHelpPopover, helpNote, workedTable } from "../kit/helpPopover";
import { icon } from "../kit/icons";
import { capabilities } from "../platform";
import {
  configuredOutputDir,
  pickOutputDir,
  resolveOutputDir,
  setConfiguredOutputDir,
} from "../platform/artifacts";

/**
 * The synthesis settings (issue #19, ADR-0004 left column): weight
 * merge mode, CJK–Latin baseline alignment, CJK character width, and
 * the output format (round 12, owner item 7) — the prototype's three
 * settings rows plus the format picker, each assembled from the kit
 * (mountSettingRow: label + ?-popover + AppSelect; the weight topic
 * keeps its single ADR-0006 correction — output weight slots come only
 * from the base font's faces). The screen owns only the VALUE wiring.
 *
 * Round 12 (owner item 3) adds one more row on targets that have a
 * real output directory (the Tauri shell): 输出目录 — where 合成字体
 * writes its artifacts, no dialog in the path. The plain browser
 * never renders it (its save is the browser's own download flow).
 * Round 13 (owner item 3) makes that row a single line — see
 * `middleEllipsize` below.
 */

/** The store key of each kit topic ("weight" is the store's weightMode). */
const STORE_KEY: Record<string, keyof SynthesisSettings> = {
  weight: "weightMode",
  baseline: "baseline",
  cjkWidth: "cjkWidth",
  outputFormat: "outputFormat",
};

/**
 * The 输出目录 row (round 12): the kit settings-row chrome (label +
 * ?-popover) over a read-only directory line with 更改 / 恢复默认 —
 * the native directory picker behind 更改, the localStorage override
 * behind both.
 *
 * Round 13 (owner item 3) keeps the value a SINGLE line: the path is
 * middle-ellipsized in the render (root + trailing segments always
 * visible — CSS text-overflow cannot truncate the middle), the full
 * path rides the title attribute, and a quiet kit-icon copy button
 * puts the full path on the clipboard with a brief icon-swap state
 * (no toast).
 */

/** The path as the one-line value shows it (round 13, owner item 3).
 *
 * CSS text-overflow cannot truncate the MIDDLE, so the render does:
 * the first and last path segments stay (the root side and the
 * filename-ish tail), a single ellipsis replaces the middle. The
 * original separators are carried from the path itself — a Windows
 * path stays backslashed, a POSIX path stays slashed, a mixed one
 * keeps its own mix; no separator is hardcoded. Paths of up to four
 * segments fit the line and pass through verbatim.
 */
export function middleEllipsize(path: string, keep = 2): string {
  // Tokenize into [segment, sep, segment, sep, …, segment]; each part
  // keeps ITS OWN separator, so joining slices reconstructs the
  // original text exactly (leading empties are roots: "/" and "\\").
  const parts = path.split(/([\\/])/);
  const segments = Math.ceil(parts.length / 2);
  if (segments <= keep * 2) return path;
  const head = parts.slice(0, keep * 2).join(""); // seg sep seg sep
  const tail = parts.slice(-keep * 2).join(""); // sep seg sep seg
  return `${head}…${tail}`;
}

/**
 * Clipboard write with the legacy execCommand fallback; resolves false
 * when neither path works (the caller then does nothing — a rare
 * headless failure is not worth a toast).
 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall through to the legacy selection copy.
  }
  try {
    const scratch = document.createElement("textarea");
    scratch.value = text;
    scratch.setAttribute("readonly", "");
    scratch.style.position = "fixed";
    scratch.style.opacity = "0";
    document.body.appendChild(scratch);
    scratch.select();
    const ok = document.execCommand("copy");
    scratch.remove();
    return ok;
  } catch {
    return false;
  }
}

function mountOutputDirRow(): HTMLElement {
  const el = document.createElement("div");
  el.className = "kit-setrow settings-outdir";
  el.dataset.setting = "outputDir";

  const head = document.createElement("div");
  head.className = "kit-sethead";
  const name = document.createElement("span");
  name.className = "kit-setname";
  name.textContent = "输出目录";
  head.appendChild(name);
  const help = mountHelpPopover({
    id: "output-dir",
    title: "输出目录是什么",
    buttonLabel: "输出目录是什么",
    width: 340,
    build: () => {
      const wrap = document.createElement("div");
      wrap.append(
        helpNote(
          "每次合成完成的字体文件会自动保存到这里，不需要每次弹窗选择位置。",
        ),
        workedTable(["项目", "是什么"], [
          ["默认位置", "系统“下载”文件夹里的 fontalloy 子文件夹"],
          ["更改", "换一个你指定的文件夹"],
          ["另存为", "合成完成后想把某一份存到别处时用"],
        ]),
      );
      return wrap;
    },
  });
  head.appendChild(help.anchor);
  el.appendChild(head);

  const valueRow = document.createElement("div");
  valueRow.className = "settings-outdir-value";
  const value = document.createElement("span");
  value.className = "settings-outdir-path";
  value.dataset.role = "output-dir-path";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "settings-outdir-copy";
  copy.dataset.role = "output-dir-copy";
  copy.setAttribute("aria-label", "复制路径");
  copy.title = "复制路径";
  copy.innerHTML = icon("copy");
  const change = document.createElement("button");
  change.type = "button";
  change.className = "settings-outdir-btn";
  change.dataset.role = "output-dir-change";
  change.textContent = "更改";
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "settings-outdir-btn";
  reset.dataset.role = "output-dir-reset";
  reset.hidden = true;
  reset.textContent = "恢复默认";
  valueRow.append(value, copy, change, reset);
  el.appendChild(valueRow);

  // The full path the copy button and the title carry (the line itself
  // shows the middle-ellipsized form).
  let fullPath = "";
  let copyResetTimer = 0;

  const render = (dir: string, overridden: boolean): void => {
    fullPath = dir;
    value.textContent = middleEllipsize(dir);
    value.title = dir;
    reset.hidden = !overridden;
  };

  copy.addEventListener("click", () => {
    if (fullPath === "") return;
    const path = fullPath;
    void writeClipboard(path).then((ok) => {
      if (!ok) return;
      // The brief copied state is the ONLY feedback (round 13: no
      // toast spam) — icon and label swap to a check for a moment.
      window.clearTimeout(copyResetTimer);
      copy.classList.add("copied");
      copy.setAttribute("aria-label", "已复制路径");
      copy.title = "已复制路径";
      copy.innerHTML = icon("check");
      copyResetTimer = window.setTimeout(() => {
        copy.classList.remove("copied");
        copy.setAttribute("aria-label", "复制路径");
        copy.title = "复制路径";
        copy.innerHTML = icon("copy");
      }, 1600);
    });
  });

  // The displayed dir: the override when set, else the shell default.
  void resolveOutputDir()
    .then((dir) => render(dir, configuredOutputDir() !== null))
    .catch(() => render("（无法定位）", false));

  change.addEventListener("click", () => {
    void pickOutputDir()
      .then((picked) => {
        if (picked === null) return; // canceled: keep the current dir.
        setConfiguredOutputDir(picked);
        render(picked, true);
      })
      .catch(() => {
        render("（无法打开目录选择）", configuredOutputDir() !== null);
      });
  });
  reset.addEventListener("click", () => {
    setConfiguredOutputDir(null);
    void resolveOutputDir()
      .then((dir) => render(dir, false))
      .catch(() => {
        /* the previous display stands */
      });
  });

  return el;
}

export function mountSettings(root: HTMLElement): void {
  // The prototype paces the three rows generously (its wrapper gap is
  // 10px; round 4 errs a touch wider — cramped rows were an owner
  // complaint). The chrome itself stays in the kit's mountSettingRow.
  root.className = "settings-rows";
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

  // Round 12: the output-directory row, only where a real output
  // directory exists (the Tauri shell; the browser download flow has
  // none — the row would promise something it cannot honor).
  if (capabilities().outputDirPicker) {
    root.appendChild(mountOutputDirRow());
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
