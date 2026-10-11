/**
 * The recipe builder (issue #21): base/donor selection from the catalog
 * manifest, precedence rules including the fc-lang language presets,
 * output naming with the validation mirror, and the weight/normalization
 * extension points for the in-flight core tickets (#9, #8).
 *
 * Since the design-fidelity repair the presentation is the kit's design
 * language: catalog pickers are kit PickerPopups (card + seamless popup,
 * self-rendering rows with the MetaLine), selects are kit AppSelects,
 * the preset picker is an app-level popup on the kit's .kit-pop chrome
 * (presetPopup.ts), and the two semantics-heavy sections carry kit
 * HelpPopovers with worked-example tables. The webapp is a compact tool
 * page: fields stay inline rows, not the workspace's rail sections.
 *
 * Follows the shared-frontend region pattern: every section subscribes
 * to the builder store and re-renders itself from a signature, so text
 * inputs never lose focus on state updates. Regions that rebuild rows
 * (donors, rules, weight slots) destroy their mounted kit components
 * first — the kit's destroy() detaches document listeners and removes
 * body-level popup nodes.
 */

import catalogJson from "../data/catalog.json";
import presetsJson from "../data/presets.json";
import {
  availableRefs,
  donorRef,
  refLabel,
  type CatalogEntry,
  type Preset,
  type RecipeDraft,
  type RuleTarget,
} from "../recipe/model";
import { parseHexScalar, validateFamilyName } from "../recipe/validate";
import { builderStore, retargetRule, takeId, updateDraft, updateRule } from "./state";
import { mountAppSelect, type AppSelect } from "../kit/appSelect";
import {
  mountPickerPopup,
  type PickerFont,
  type PickerPopup,
} from "../kit/pickerPopup";
import { mountHelpPopover, workedTable, helpNote } from "../kit/helpPopover";
import {
  mountPresetPicker,
  type PresetPicker,
} from "./presetPopup";

const CATALOG = catalogJson.families as CatalogEntry[];
const PRESETS = presetsJson.presets as Preset[];
const FEATURED = presetsJson.featured as string[];
const STANDALONE_SETS = presetsJson.standalone_sets as string[];

const count = new Intl.NumberFormat("en-US");

/** Catalog manifest provenance — the picker's always-visible note. */
const CATALOG_NOTE =
  "目录数据来自清单（assets/fonts.manifest.json）的静态快照。";

/** One catalog entry as a kit picker row (license cleaned like the GUI). */
function catalogRow(entry: CatalogEntry): PickerFont {
  return {
    id: `${entry.family}::${entry.variant}`,
    name: `${entry.family} · ${entry.variant}`,
    // Users type "Family Variant" — the display's middle dot would
    // otherwise hide the row from the search.
    keywords: `${entry.family} ${entry.variant}`,
    meta: {
      license: entry.license_spdx
        .replace(/-1\.1$/, "")
        .replace(/-(no-)?RFN$/, ""),
      trait: entry.version,
    },
  };
}

/** One font slot editor: kit catalog PickerPopup + path + optional TTC face. */
function mountSlotEditor(
  root: HTMLElement,
  opts: {
    anchorRole: string;
    pathRole: string;
    faceRole: string;
    emptyText: string;
    get: () => RecipeDraft["base"];
    set: (slot: RecipeDraft["base"]) => void;
  },
): PickerPopup {
  root.className = "wb-slot";

  const buildProps = () => ({
    role: opts.anchorRole,
    fonts: CATALOG.map(catalogRow),
    selectedId: (() => {
      const slot = opts.get();
      return slot.catalog
        ? `${slot.catalog.family}::${slot.catalog.variant}`
        : null;
    })(),
    emptyLabel: opts.emptyText,
    searchPlaceholder: "搜索字体家族…",
    emptyText: "目录中没有匹配的字体。",
    note: CATALOG_NOTE,
    onPick: (id: string) => {
      const [family, variant] = id.split("::");
      const entry =
        CATALOG.find((c) => c.family === family && c.variant === variant) ??
        null;
      if (!entry) return;
      const slot = opts.get();
      opts.set({
        ...slot,
        catalog: entry,
        // Seed the path with the fetch layout hint; the user completes
        // the file name for the face they fetched.
        path: slot.path.trim() === "" ? `${entry.path_hint}/` : slot.path,
      });
    },
  });

  const popup = mountPickerPopup(root, buildProps());

  const pathBox = document.createElement("label");
  pathBox.className = "wb-field";
  const pathLabel = document.createElement("span");
  pathLabel.className = "wb-field-label";
  pathLabel.textContent = "字体文件路径";
  const pathInput = document.createElement("input");
  pathInput.type = "text";
  pathInput.className = "wb-input wb-path-input";
  pathInput.dataset.role = opts.pathRole;
  pathInput.placeholder = "fonts/<家族>/<字体文件>.ttf";
  pathInput.spellcheck = false;
  pathInput.addEventListener("input", () => {
    const slot = opts.get();
    opts.set({ ...slot, path: pathInput.value });
  });
  pathBox.append(pathLabel, pathInput);
  root.appendChild(pathBox);

  const faceBox = document.createElement("label");
  faceBox.className = "wb-field wb-field-narrow";
  const faceLabel = document.createElement("span");
  faceLabel.className = "wb-field-label";
  faceLabel.textContent = "TTC face";
  const faceInput = document.createElement("input");
  faceInput.type = "number";
  faceInput.min = "0";
  faceInput.step = "1";
  faceInput.className = "wb-input";
  faceInput.dataset.role = opts.faceRole;
  faceInput.addEventListener("input", () => {
    const slot = opts.get();
    const text = faceInput.value.trim();
    const value = text === "" ? null : Number.parseInt(text, 10);
    opts.set({ ...slot, face: value !== null && Number.isNaN(value) ? slot.face : value });
  });
  faceBox.append(faceLabel, faceInput);
  root.appendChild(faceBox);

  // Only the picker props re-render; inputs are never rebuilt.
  const render = (): void => {
    const slot = opts.get();
    popup.render(buildProps());
    if (pathInput.value !== slot.path && document.activeElement !== pathInput) {
      pathInput.value = slot.path;
    }
  };
  builderStore.subscribe(render);
  render();
  return popup;
}

function section(
  root: HTMLElement,
  title: string,
  desc: string,
  help?: { id: string; label: string; width: number; build(): HTMLElement },
): HTMLElement {
  const el = document.createElement("section");
  el.className = "wb-section";
  const h = document.createElement("h3");
  h.className = "wb-section-title";
  h.textContent = title;
  if (help) {
    const popover = mountHelpPopover({
      id: help.id,
      title: help.label,
      buttonLabel: help.label,
      width: help.width,
      build: help.build,
    });
    const head = document.createElement("div");
    head.className = "wb-section-head";
    head.append(h, popover.anchor);
    el.appendChild(head);
  } else {
    el.appendChild(h);
  }
  const d = document.createElement("div");
  d.className = "wb-section-desc";
  d.textContent = desc;
  el.appendChild(d);
  root.appendChild(el);
  return el;
}

/** Base + donors. */
function mountFonts(root: HTMLElement): void {
  const baseSec = section(
    root,
    "基底字体",
    "合成结果的容器：输出继承它的度量与身份（base）。",
  );
  const baseSlot = document.createElement("div");
  baseSec.appendChild(baseSlot);
  mountSlotEditor(baseSlot, {
    anchorRole: "base-catalog",
    pathRole: "base-path",
    faceRole: "base-face",
    emptyText: "从目录选择基底字体…",
    get: () => builderStore.get().draft.base,
    set: (slot) => updateDraft((draft) => ({ ...draft, base: slot })),
  });

  const donorSec = section(
    root,
    "供体字体",
    "按加入顺序提供缺失码位的字形（donor-0、donor-1…）；路径相对于配方文件。",
  );
  const donorList = document.createElement("div");
  donorList.className = "wb-donor-list";
  const addDonor = document.createElement("button");
  addDonor.type = "button";
  addDonor.className = "kit-btn sm wb-add-button";
  addDonor.dataset.role = "add-donor";
  addDonor.textContent = "＋ 添加供体";
  addDonor.addEventListener("click", () => {
    updateDraft((draft) => ({
      ...draft,
      donors: [
        ...draft.donors,
        { catalog: null, path: "", face: null },
      ],
    }));
  });
  donorSec.append(donorList, addDonor);

  let mountedPickers: PickerPopup[] = [];
  const renderDonors = (): void => {
    const { donors } = builderStore.get().draft;
    const signature = donors.length.toString();
    if (donorList.dataset.signature === signature) return;
    donorList.dataset.signature = signature;
    // Pickers whose cards are about to be replaced must be torn down,
    // or duplicates with the same data-picker-popup accumulate on body.
    for (const picker of mountedPickers) picker.destroy();
    mountedPickers = [];
    donorList.replaceChildren();
    donors.forEach((_slot, index) => {
      const row = document.createElement("div");
      row.className = "wb-donor-row";
      row.dataset.donorIndex = String(index);
      const head = document.createElement("div");
      head.className = "wb-donor-head";
      const tag = document.createElement("span");
      tag.className = "wb-tag";
      tag.textContent = `供体 ${index + 1}（${donorRef(index)}）`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "kit-btn gh sm wb-remove-button";
      remove.dataset.role = `remove-donor-${index}`;
      remove.setAttribute("aria-label", `移除供体 ${index + 1}`);
      remove.textContent = "移除";
      remove.addEventListener("click", () => {
        updateDraft((draft) => {
          const donors = draft.donors.filter((_d, i) => i !== index);
          // Rules keep their refs valid: renumber and drop stale refs.
          const renumber = (ref: string): string | null => {
            if (ref === "base") return ref;
            const i = Number(ref.slice("donor-".length));
            if (i === index) return null;
            return donorRef(i > index ? i - 1 : i);
          };
          return {
            ...draft,
            donors,
            rules: draft.rules.map((rule) => ({
              ...rule,
              fonts: rule.fonts
                .map(renumber)
                .filter((ref): ref is string => ref !== null),
            })),
          };
        });
      });
      head.append(tag, remove);
      row.appendChild(head);
      const slotEditor = document.createElement("div");
      row.appendChild(slotEditor);
      donorList.appendChild(row);
      mountedPickers.push(
        mountSlotEditor(slotEditor, {
          anchorRole: `donor-catalog-${index}`,
          pathRole: `donor-path-${index}`,
          faceRole: `donor-face-${index}`,
          emptyText: "从目录选择供体字体…",
          get: () => builderStore.get().draft.donors[index],
          set: (slot) =>
            updateDraft((draft) => ({
              ...draft,
              donors: draft.donors.map((d, i) => (i === index ? slot : d)),
            })),
        }),
      );
    });
    if (donors.length === 0) {
      const empty = document.createElement("div");
      empty.className = "wb-empty-note";
      empty.textContent = "尚未添加供体——纯基底（无合并）也是合法配方。";
      donorList.appendChild(empty);
    }
  };
  builderStore.subscribe(renderDonors);
  renderDonors();
}

/** Precedence rules: preset / range / codepoint targets + font order. */
function mountRules(root: HTMLElement): void {
  const sec = section(
    root,
    "优先级规则",
    "“码位 → 有序字体列表”；最窄者胜，同层后声明者胜。空缺默认由基底与供体顺序填补，声明即覆盖。",
  );
  const ruleList = document.createElement("div");
  ruleList.className = "wb-rule-list";
  const addRule = document.createElement("button");
  addRule.type = "button";
  addRule.className = "kit-btn sm wb-add-button";
  addRule.dataset.role = "add-rule";
  addRule.textContent = "＋ 添加规则";
  addRule.addEventListener("click", () => {
    const id = takeId();
    updateDraft((draft) => ({
      ...draft,
      rules: [
        ...draft.rules,
        { id, target: { kind: "preset", name: "" }, fonts: [] },
      ],
    }));
  });
  sec.append(ruleList, addRule);

  interface RuleWidgets {
    kind: AppSelect;
    preset: PresetPicker | null;
  }
  let widgets: RuleWidgets[] = [];
  const teardown = (): void => {
    for (const w of widgets) {
      w.kind.destroy();
      w.preset?.destroy();
    }
    widgets = [];
  };

  const presetLabel = (name: string): string => {
    const preset = PRESETS.find((p) => p.name === name);
    const standalone = STANDALONE_SETS.includes(name);
    return preset
      ? `${preset.name} · ${count.format(preset.codepoints)} 码位`
      : standalone
        ? `${name}（补充区块）`
        : "选择语言预设…";
  };

  const renderRules = (): void => {
    const draft = builderStore.get().draft;
    // Values typed into inputs are state, not structure: exclude them
    // from the signature so typing never rebuilds (and unfocuses).
    const signature = JSON.stringify([
      draft.donors.map((d) => (d.catalog ? `${d.catalog.family}/${d.catalog.variant}` : "")).join("|"),
      draft.base.catalog?.family ?? "",
      draft.rules.map((rule) => [
        rule.id,
        rule.target.kind,
        rule.target.kind === "preset" ? rule.target.name : "",
        rule.fonts,
      ]),
    ]);
    if (ruleList.dataset.signature === signature) return;
    ruleList.dataset.signature = signature;
    teardown();
    ruleList.replaceChildren();

    if (draft.rules.length === 0) {
      const empty = document.createElement("div");
      empty.className = "wb-empty-note";
      empty.textContent =
        "尚未声明规则——空缺码位将按默认优先级（基底优先，随后供体按加入顺序）填补。";
      ruleList.appendChild(empty);
      return;
    }

    for (const rule of draft.rules) {
      const row = document.createElement("div");
      row.className = "wb-rule";
      row.dataset.ruleId = String(rule.id);

      const head = document.createElement("div");
      head.className = "wb-rule-head";
      const tag = document.createElement("span");
      tag.className = "wb-tag";
      tag.textContent = `规则 ${draft.rules.indexOf(rule) + 1}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "kit-btn gh sm wb-remove-button";
      remove.dataset.role = "remove-rule";
      remove.setAttribute("aria-label", "删除规则");
      remove.textContent = "删除";
      remove.addEventListener("click", () => {
        updateDraft((d) => ({
          ...d,
          rules: d.rules.filter((r) => r.id !== rule.id),
        }));
      });
      head.append(tag, remove);
      row.appendChild(head);

      const kindRow = document.createElement("div");
      kindRow.className = "wb-rule-target";

      const KIND_OPTIONS = [
        { value: "preset", label: "语言预设" },
        { value: "range", label: "码位区间" },
        { value: "codepoint", label: "单码位" },
      ] as const;
      const kind = mountAppSelect({
        label: "规则目标类型",
        value: rule.target.kind,
        options: KIND_OPTIONS,
        onChange: (value) => {
          const next: RuleTarget =
            value === "preset"
              ? { kind: "preset", name: "" }
              : value === "range"
                ? { kind: "range", start: NaN, end: NaN }
                : { kind: "codepoint", cp: NaN };
          retargetRule(rule.id, next);
        },
      });
      kind.el.dataset.role = `rule-kind-${rule.id}`;
      kindRow.appendChild(kind.el);

      const target = rule.target;
      let presetPicker: PresetPicker | null = null;
      if (target.kind === "preset") {
        presetPicker = mountPresetPicker({
          role: `rule-preset-${rule.id}`,
          searchPlaceholder: "搜索语言（fc-lang）…",
          emptyText: "没有匹配的语言预设。",
          footerNote: "预设为 fc-lang 语料（fontconfig）的静态快照。",
          currentLabel: () => presetLabel(target.name),
          options: (query) => {
            const all: Array<{
              id: string;
              title: string;
              sub: string;
              featured: boolean;
            }> = [];
            for (const preset of PRESETS) {
              const composition =
                preset.sub_blocks.length > 1
                  ? ` = ${preset.sub_blocks
                      .map((b) => `${b.name} ${count.format(b.codepoints)}`)
                      .join(" + ")}`
                  : "";
              all.push({
                id: preset.name,
                title: preset.name,
                sub: `${count.format(preset.codepoints)} 码位${composition}`,
                featured: FEATURED.includes(preset.name),
              });
            }
            for (const name of STANDALONE_SETS) {
              all.push({
                id: name,
                title: name,
                sub: "独立可选的补充区块",
                featured: false,
              });
            }
            const hits = all.filter((o) => query === "" || o.title.toLowerCase().includes(query));
            hits.sort((a, b) => {
              const fa = FEATURED.includes(a.id) ? 0 : 1;
              const fb = FEATURED.includes(b.id) ? 0 : 1;
              return fa !== fb ? fa - fb : a.title.localeCompare(b.title);
            });
            return hits;
          },
          onPick: (name) => {
            updateRule(rule.id, (r) => ({
              ...r,
              target: { kind: "preset", name },
            }));
          },
        });
        kindRow.appendChild(presetPicker.anchor);
        widgets.push({ kind, preset: presetPicker });
      } else {
        widgets.push({ kind, preset: null });
      }

      if (target.kind === "range") {
        const wrap = document.createElement("span");
        wrap.className = "wb-range-box";
        const error = document.createElement("span");
        error.className = "wb-inline-error";
        error.dataset.role = `rule-range-error-${rule.id}`;
        const makeInput = (
          role: string,
          placeholder: string,
          apply: (value: number) => void,
        ): HTMLInputElement => {
          const input = document.createElement("input");
          input.type = "text";
          input.className = "wb-input wb-hex-input";
          input.dataset.role = role;
          input.placeholder = placeholder;
          input.spellcheck = false;
          input.addEventListener("input", () => {
            const parsed = parseHexScalar(input.value);
            if (input.value.trim() !== "" && parsed === null) {
              error.textContent = "需为十六进制 Unicode 标量值（如 0x2100）。";
            } else {
              error.textContent = "";
              if (parsed !== null) apply(parsed);
            }
          });
          return input;
        };
        const start = makeInput(
          `rule-range-start-${rule.id}`,
          "0x2100",
          (value) =>
            updateRule(rule.id, (r) =>
              r.target.kind === "range"
                ? { ...r, target: { kind: "range", start: value, end: r.target.end } }
                : r,
            ),
        );
        const end = makeInput(
          `rule-range-end-${rule.id}`,
          "0x214F",
          (value) =>
            updateRule(rule.id, (r) =>
              r.target.kind === "range"
                ? { ...r, target: { kind: "range", start: r.target.start, end: value } }
                : r,
            ),
        );
        const dash = document.createElement("span");
        dash.className = "wb-range-dash";
        dash.textContent = "–";
        wrap.append(start, dash, end, error);
        kindRow.appendChild(wrap);
      } else if (target.kind === "codepoint") {
        const error = document.createElement("span");
        error.className = "wb-inline-error";
        error.dataset.role = `rule-cp-error-${rule.id}`;
        const input = document.createElement("input");
        input.type = "text";
        input.className = "wb-input wb-hex-input";
        input.dataset.role = `rule-codepoint-${rule.id}`;
        input.placeholder = "0x4E2D";
        input.spellcheck = false;
        input.addEventListener("input", () => {
          const parsed = parseHexScalar(input.value);
          if (input.value.trim() !== "" && parsed === null) {
            error.textContent = "需为十六进制 Unicode 标量值。";
          } else {
            error.textContent = "";
            if (parsed !== null) {
              updateRule(rule.id, (r) =>
                r.target.kind === "codepoint"
                  ? { ...r, target: { kind: "codepoint", cp: parsed } }
                  : r,
              );
            }
          }
        });
        kindRow.append(input, error);
      }
      row.appendChild(kindRow);

      // Ordered font list: checked rows (top-down) are the YAML order.
      const fontsBox = document.createElement("div");
      fontsBox.className = "wb-rule-fonts";
      const fontsTitle = document.createElement("div");
      fontsTitle.className = "wb-rule-fonts-title";
      fontsTitle.textContent = "字体顺序（列表顶部者优先持有该码位的字形）";
      fontsBox.appendChild(fontsTitle);
      const ordered = [
        ...rule.fonts,
        ...availableRefs(draft).filter((ref) => !rule.fonts.includes(ref)),
      ];
      ordered.forEach((ref) => {
        const included = rule.fonts.includes(ref);
        const line = document.createElement("div");
        line.className = "wb-rule-font";
        const label = document.createElement("label");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = included;
        checkbox.dataset.role = `rule-font-${rule.id}-${ref}`;
        checkbox.addEventListener("change", () => {
          updateRule(rule.id, (r) => {
            const fonts = checkbox.checked
              ? [...r.fonts, ref]
              : r.fonts.filter((f) => f !== ref);
            return { ...r, fonts };
          });
        });
        const text = document.createElement("span");
        text.textContent = refLabel(draft, ref);
        label.append(checkbox, text);
        line.appendChild(label);
        if (included) {
          const rank = rule.fonts.indexOf(ref);
          const up = document.createElement("button");
          up.type = "button";
          up.className = "kit-btn sm wb-move-button";
          up.dataset.role = `rule-font-up-${rule.id}-${ref}`;
          up.setAttribute("aria-label", `${ref} 上移`);
          up.textContent = "↑";
          up.disabled = rank === 0;
          up.addEventListener("click", () => {
            updateRule(rule.id, (r) => {
              const fonts = [...r.fonts];
              const i = fonts.indexOf(ref);
              if (i > 0) [fonts[i - 1], fonts[i]] = [fonts[i], fonts[i - 1]];
              return { ...r, fonts };
            });
          });
          const down = document.createElement("button");
          down.type = "button";
          down.className = "kit-btn sm wb-move-button";
          down.dataset.role = `rule-font-down-${rule.id}-${ref}`;
          down.setAttribute("aria-label", `${ref} 下移`);
          down.textContent = "↓";
          down.disabled = rank === rule.fonts.length - 1;
          down.addEventListener("click", () => {
            updateRule(rule.id, (r) => {
              const fonts = [...r.fonts];
              const i = fonts.indexOf(ref);
              if (i >= 0 && i < fonts.length - 1)
                [fonts[i + 1], fonts[i]] = [fonts[i], fonts[i + 1]];
              return { ...r, fonts };
            });
          });
          line.append(up, down);
        }
        fontsBox.appendChild(line);
      });
      row.appendChild(fontsBox);
      ruleList.appendChild(row);
    }
  };
  builderStore.subscribe(renderRules);
  renderRules();
}

/** Output naming with the instant validation mirror. */
function mountOutput(root: HTMLElement): void {
  const sec = section(
    root,
    "输出",
    "输出名默认为固定品牌默认值 ChHsich（不取自源字体名，尊重 RFN）；空格会转换为连字符。",
  );
  const box = document.createElement("div");
  box.className = "wb-output-box";
  sec.appendChild(box);

  const familyField = document.createElement("label");
  familyField.className = "wb-field";
  const familyLabel = document.createElement("span");
  familyLabel.className = "wb-field-label";
  familyLabel.textContent = "输出家族名";
  const familyInput = document.createElement("input");
  familyInput.type = "text";
  familyInput.className = "wb-input";
  familyInput.dataset.role = "output-family";
  familyInput.value = builderStore.get().draft.output.family;
  const familyFeedback = document.createElement("span");
  familyFeedback.className = "wb-field-feedback";
  familyFeedback.dataset.role = "output-family-feedback";
  familyInput.addEventListener("input", () => {
    updateDraft((draft) => ({
      ...draft,
      output: { ...draft.output, family: familyInput.value },
    }));
    const check = validateFamilyName(familyInput.value);
    familyFeedback.textContent = check.ok
      ? `将写入为：${check.normalized}`
      : check.error;
    familyFeedback.classList.toggle("is-error", !check.ok);
  });
  familyField.append(familyLabel, familyInput, familyFeedback);
  box.appendChild(familyField);
  // Initial feedback for the prefilled brand default (visible without
  // any interaction — no hover-only or type-only information).
  {
    const check = validateFamilyName(familyInput.value);
    familyFeedback.textContent = check.ok
      ? `将写入为：${check.normalized}`
      : check.error;
    familyFeedback.classList.toggle("is-error", !check.ok);
  }

  const formatField = document.createElement("div");
  formatField.className = "wb-field wb-field-narrow";
  const formatLabel = document.createElement("span");
  formatLabel.className = "wb-field-label";
  formatLabel.textContent = "输出格式";
  const formatSelect = mountAppSelect({
    label: "输出格式",
    value: builderStore.get().draft.output.format,
    options: [
      { value: "ttf", label: "TTF（必选档）" },
      { value: "ttc", label: "TTC（集合）" },
      { value: "woff2", label: "WOFF2（可选档）" },
    ],
    onChange: (value) => {
      updateDraft((draft) => ({
        ...draft,
        output: {
          ...draft.output,
          format: value as RecipeDraft["output"]["format"],
        },
      }));
    },
  });
  formatSelect.el.dataset.role = "output-format";
  formatField.append(formatLabel, formatSelect.el);
  box.appendChild(formatField);
}

/**
 * Normalization switches (the #8 recipe schema): grid/optical school,
 * the optical ratio, and the fullwidth quotes/dashes policy. The block
 * is omitted from the YAML while everything sits at the core defaults.
 */
function mountNormalization(root: HTMLElement): void {
  const sec = section(
    root,
    "规范化开关",
    "全部保持默认时配方不写该块（核心默认：网格 2:1、半角引号与破折号）；改动后仅写入非默认项。",
    {
      id: "normalization",
      label: "网格与光学缩放",
      width: 340,
      build() {
        const wrap = document.createElement("div");
        wrap.append(
          helpNote(
            "中英文永远共用同一条基线，行高完全继承英文字体（ADR-0003 不变量）；这里选择的只是中文的缩放学派：",
          ),
          workedTable(["模式", "效果"], [
            [
              "网格（默认）",
              "中文按 2:1 网格比例缩放，底边落在共享基线上，不额外缩小",
            ],
            [
              "光学",
              "中文按「汉字墨高 / 大写高度」比例略缩（默认 1.23）",
            ],
          ]),
          helpNote(
            "全角引号与破折号：半角 = 记一格（UAX #11 默认）；全角 = 占两格（中文排版习惯）。宽字符固定整 2 格，其他比例在本管线中不可表达。",
          ),
        );
        return wrap;
      },
    },
  );
  const body = document.createElement("div");
  body.className = "wb-output-box";
  sec.appendChild(body);

  const modeBox = document.createElement("div");
  modeBox.className = "wb-field wb-field-narrow";
  const modeLabel = document.createElement("span");
  modeLabel.className = "wb-field-label";
  modeLabel.textContent = "规范化模式";
  const modeSelect = mountAppSelect({
    label: "规范化模式",
    value: builderStore.get().draft.normalization.mode,
    options: [
      { value: "grid", label: "网格（2:1，默认）" },
      { value: "optical", label: "光学（按比例）" },
    ],
    onChange: (value) => {
      const mode = value as RecipeDraft["normalization"]["mode"];
      updateDraft((draft) => ({
        ...draft,
        normalization: { ...draft.normalization, mode },
      }));
      renderRatioVisibility();
    },
  });
  modeSelect.el.dataset.role = "normalization-mode";
  modeBox.append(modeLabel, modeSelect.el);
  body.appendChild(modeBox);

  const ratioBox = document.createElement("label");
  ratioBox.className = "wb-field wb-field-narrow";
  const ratioLabel = document.createElement("span");
  ratioLabel.className = "wb-field-label";
  ratioLabel.textContent = "光学比例";
  const ratioInput = document.createElement("input");
  ratioInput.type = "number";
  ratioInput.min = "0";
  ratioInput.step = "0.01";
  ratioInput.className = "wb-input";
  ratioInput.dataset.role = "normalization-ratio";
  ratioInput.value = String(
    builderStore.get().draft.normalization.opticalRatio ?? "",
  );
  const ratioNote = document.createElement("span");
  ratioNote.className = "wb-field-feedback";
  ratioNote.textContent = "汉字墨高 / 大写高度（默认 1.23）";
  ratioInput.addEventListener("input", () => {
    const text = ratioInput.value.trim();
    const value = text === "" ? null : Number(text);
    updateDraft((draft) => ({
      ...draft,
      normalization: { ...draft.normalization, opticalRatio: value },
    }));
  });
  ratioBox.append(ratioLabel, ratioInput, ratioNote);
  body.appendChild(ratioBox);

  const quoteBox = document.createElement("div");
  quoteBox.className = "wb-field";
  const quoteLabel = document.createElement("span");
  quoteLabel.className = "wb-field-label";
  quoteLabel.textContent = "全角引号与破折号";
  const quoteSelect = mountAppSelect({
    label: "全角引号与破折号",
    value: builderStore.get().draft.normalization.quoteDashWidth,
    options: [
      { value: "halfwidth", label: "半角（UAX #11 默认）" },
      { value: "fullwidth", label: "全角（CJK 习惯）" },
    ],
    onChange: (value) => {
      updateDraft((draft) => ({
        ...draft,
        normalization: {
          ...draft.normalization,
          quoteDashWidth: value as RecipeDraft["normalization"]["quoteDashWidth"],
        },
      }));
    },
  });
  quoteSelect.el.dataset.role = "normalization-quote-dash";
  quoteBox.append(quoteLabel, quoteSelect.el);
  body.appendChild(quoteBox);

  const renderRatioVisibility = (): void => {
    const optical = builderStore.get().draft.normalization.mode === "optical";
    ratioBox.hidden = !optical;
  };
  renderRatioVisibility();
}

/**
 * The weight/style matrix (the #9 recipe schema): explicit output
 * slots; each slot may rewrite the per-donor weight mapping (an exact
 * demand — never a silent nearest approximation). No slots declared
 * means the core's implicit default (one output per base face,
 * nearest-match donors), and the recipe omits the block.
 */
function mountWeights(root: HTMLElement): void {
  const sec = section(
    root,
    "字重映射",
    "默认按 OS/2 usWeightClass 就近匹配（不写 weights 块）；声明槽位即按需求精确供体字重，每次借用都会在构建报告中明示。",
    {
      id: "recipe-weights",
      label: "字重槽位与覆写",
      width: 380,
      build() {
        const wrap = document.createElement("div");
        wrap.append(
          helpNote(
            "每个槽位声明一个成品字重（usWeightClass）与样式；供体默认按最接近的字重并入。覆写是精确需求——管线不会悄悄换成最近字重，每笔借用都会写进构建报告（#9）。",
          ),
          workedTable(["成品槽位", "供体默认（就近）", "覆写后（精确）"], [
            ["400 · 正体", "donor-0 → 400", "donor-0 → 700"],
            ["700 · 斜体", "donor-0 → 700", "donor-0 → 400"],
          ]),
          helpNote(
            "不声明槽位 = 基底每个字面一个输出，供体按 OS/2 usWeightClass 就近匹配；声明的档位集合只能来自基底已有的字面（ADR-0006）。",
          ),
        );
        return wrap;
      },
    },
  );
  const slotList = document.createElement("div");
  slotList.className = "wb-rule-list";
  const addSlot = document.createElement("button");
  addSlot.type = "button";
  addSlot.className = "kit-btn sm wb-add-button";
  addSlot.dataset.role = "add-weight-slot";
  addSlot.textContent = "＋ 添加字重槽位";
  addSlot.addEventListener("click", () => {
    const id = takeId();
    updateDraft((draft) => ({
      ...draft,
      weights: [
        ...draft.weights,
        { id, weight: 400, style: "upright", donors: {} },
      ],
    }));
  });
  sec.append(slotList, addSlot);

  let styleSelects: AppSelect[] = [];
  const renderSlots = (): void => {
    const draft = builderStore.get().draft;
    // Inputs (weight numbers, overrides) are state, not structure.
    const signature = JSON.stringify([
      draft.weights.map((slot) => [slot.id, slot.style]),
      draft.donors.map((d) =>
        d.catalog ? `${d.catalog.family}/${d.catalog.variant}` : "",
      ),
    ]);
    if (slotList.dataset.signature === signature) return;
    slotList.dataset.signature = signature;
    for (const select of styleSelects) select.destroy();
    styleSelects = [];
    slotList.replaceChildren();

    if (draft.weights.length === 0) {
      const empty = document.createElement("div");
      empty.className = "wb-empty-note";
      empty.textContent =
        "未声明字重槽位——构建默认为基底每个字面一个输出，供体按就近字重匹配。";
      slotList.appendChild(empty);
      return;
    }

    for (const slot of draft.weights) {
      const row = document.createElement("div");
      row.className = "wb-rule";
      row.dataset.weightSlotId = String(slot.id);

      const head = document.createElement("div");
      head.className = "wb-rule-head";
      const tag = document.createElement("span");
      tag.className = "wb-tag";
      tag.textContent = `字重槽位 ${draft.weights.indexOf(slot) + 1}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "kit-btn gh sm wb-remove-button";
      remove.dataset.role = "remove-weight-slot";
      remove.setAttribute("aria-label", "删除字重槽位");
      remove.textContent = "删除";
      remove.addEventListener("click", () => {
        updateDraft((d) => ({
          ...d,
          weights: d.weights.filter((s) => s.id !== slot.id),
        }));
      });
      head.append(tag, remove);
      row.appendChild(head);

      const controls = document.createElement("div");
      controls.className = "wb-rule-target";

      const weightField = document.createElement("label");
      weightField.className = "wb-field wb-field-narrow";
      const weightLabel = document.createElement("span");
      weightLabel.className = "wb-field-label";
      weightLabel.textContent = "字重（usWeightClass）";
      const weightInput = document.createElement("input");
      weightInput.type = "number";
      weightInput.min = "1";
      weightInput.max = "1000";
      weightInput.step = "1";
      weightInput.className = "wb-input";
      weightInput.dataset.role = `weight-slot-weight-${slot.id}`;
      weightInput.value = slot.weight === null ? "" : String(slot.weight);
      weightInput.addEventListener("input", () => {
        const text = weightInput.value.trim();
        const value = text === "" ? null : Number(text);
        updateDraft((d) => ({
          ...d,
          weights: d.weights.map((s) =>
            s.id === slot.id ? { ...s, weight: value } : s,
          ),
        }));
      });
      weightField.append(weightLabel, weightInput);
      controls.appendChild(weightField);

      const styleField = document.createElement("div");
      styleField.className = "wb-field wb-field-narrow";
      const styleLabel = document.createElement("span");
      styleLabel.className = "wb-field-label";
      styleLabel.textContent = "样式";
      const styleSelect = mountAppSelect({
        label: "槽位样式",
        value: slot.style,
        options: [
          { value: "upright", label: "正体（默认）" },
          { value: "italic", label: "斜体" },
        ],
        onChange: (value) => {
          updateDraft((d) => ({
            ...d,
            weights: d.weights.map((s) =>
              s.id === slot.id
                ? {
                    ...s,
                    style: value as RecipeDraft["weights"][number]["style"],
                  }
                : s,
            ),
          }));
        },
      });
      styleSelect.el.dataset.role = `weight-slot-style-${slot.id}`;
      styleSelects.push(styleSelect);
      styleField.append(styleLabel, styleSelect.el);
      controls.appendChild(styleField);
      row.appendChild(controls);

      if (draft.donors.length > 0) {
        const overrides = document.createElement("div");
        overrides.className = "wb-rule-fonts";
        const title = document.createElement("div");
        title.className = "wb-rule-fonts-title";
        title.textContent = "供体字重覆写（留空 = 就近匹配）";
        overrides.appendChild(title);
        for (let index = 0; index < draft.donors.length; index++) {
          const ref = donorRef(index);
          const line = document.createElement("label");
          line.className = "wb-rule-font";
          const text = document.createElement("span");
          text.textContent = `${refLabel(draft, ref)} → 字重`;
          const input = document.createElement("input");
          input.type = "number";
          input.min = "1";
          input.max = "1000";
          input.step = "1";
          input.className = "wb-input wb-hex-input";
          input.dataset.role = `weight-override-${slot.id}-${ref}`;
          const current = slot.donors[ref];
          input.value =
            current === null || current === undefined ? "" : String(current);
          input.addEventListener("input", () => {
            const text2 = input.value.trim();
            const value = text2 === "" ? null : Number(text2);
            updateDraft((d) => ({
              ...d,
              weights: d.weights.map((s) =>
                s.id === slot.id
                  ? { ...s, donors: { ...s.donors, [ref]: value } }
                  : s,
              ),
            }));
          });
          line.append(text, input);
          overrides.appendChild(line);
        }
        row.appendChild(overrides);
      }
      slotList.appendChild(row);
    }
  };
  builderStore.subscribe(renderSlots);
  renderSlots();
}

export function mountBuilder(root: HTMLElement): void {
  mountFonts(root);
  mountRules(root);
  mountWeights(root);
  mountNormalization(root);
  mountOutput(root);
}
