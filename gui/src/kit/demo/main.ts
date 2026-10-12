/**
 * Kit demo — every kit component assembled with realistic data, in the
 * validated workspace composition (top bar / rail / content / stats).
 * Dev-only page (gui/kit-demo.html); this is the surface the design
 * acceptance screenshots capture against the prototype.
 */

import "../tokens.css";
import "../kit.css";
import "./demo.css";

import { mountPickerPopup, type PickerPopup } from "../pickerPopup";
import { SETTINGS_TOPICS, mountSettingRow } from "../settingsTopics";
import { mountCategoryChips, type CategoryChips } from "../categoryChips";
import { mountActionBar, segmentedControl, undoAllButton, type ActionBar } from "../actionBar";
import {
  formatCodepoint,
  mountCharGrid,
  PAGE_SIZE,
  type CharGrid,
  type GridCellData,
} from "../grid";
import { mountStatusBar, type StatusBar } from "../statusBar";
import { mountSceneCard, mountFullscreenScene, type SceneCard } from "../sceneCard";
import { mountTopBar } from "../topBar";
import { mountLangChips } from "../langChips";
import { ruleEmptyState, ruleRow, ruleSoloRow } from "../ruleRows";
import { mountCharPopup, type CharPopupFacts } from "../charPopup";
import { mountRangePopup } from "../rangePopup";
import type { IconName } from "../icons";
import type { SceneKind } from "../sceneCard";
import { applyStoredThemePreference } from "../theme";
import type { FontSide } from "../actionBar";
import {
  ADJUSTED_CHARS,
  BASE_NAME,
  BASE_STACK,
  CJK_FONTS,
  DEMO_BLOCKS,
  DONOR_NAME,
  DONOR_STACK,
  EN_FONTS,
  LANGUAGES,
  MISSING_CHARS,
  demoBlocksFor,
  demoGroups,
  demoStats,
  gridCellData,
} from "./data";

/* ---------- demo state ---------- */

interface DemoState {
  mode: "grid" | "scene";
  group: string | null;
  block: string; // block id or "all" or "g:<gid>"
  page: number;
  multi: boolean;
  showCodepoints: boolean;
  selection: Set<string>;
  langSelection: Set<string>;
  enId: string;
  cjkId: string;
  customPreview: string;
  termTheme: string;
  edTheme: string;
}

const state: DemoState = {
  mode: "grid",
  group: "cjk",
  block: "hanzi",
  page: 0,
  multi: false,
  showCodepoints: false,
  selection: new Set(),
  langSelection: new Set(["zh_cn"]),
  enId: "jbmono",
  cjkId: "maple",
  customPreview: "",
  termTheme: "",
  edTheme: "",
};

let sceneEntrance = true;
const undoDepth = { rules: 2, picks: 0 };

const live = document.createElement("div");
live.className = "kit-sr";
live.setAttribute("role", "status");
live.setAttribute("aria-live", "polite");

/* ---------- frame ---------- */

const app = document.createElement("div");
app.className = "kit-app";
app.dataset.kitFrame = "";
document.body.appendChild(app);
document.body.appendChild(live);

const topBar = mountTopBar(app, {
  base: EN_FONTS[0].name,
  donor: CJK_FONTS[0].name,
  onFontName: () => undefined,
  onSynthesize: () => {
    live.textContent = "正在合成";
    window.setTimeout(() => {
      live.textContent = "已保存，核对报告已生成";
    }, 800);
  },
});

const main = document.createElement("div");
main.className = "demo-main";
app.appendChild(main);

const side = document.createElement("aside");
side.className = "demo-side";
const content = document.createElement("div");
content.className = "demo-content";
main.append(side, content);

/* ---------- rail: pickers ---------- */

const section = (title: string): HTMLElement => {
  const s = document.createElement("section");
  const h = document.createElement("h3");
  h.textContent = title;
  s.appendChild(h);
  side.appendChild(s);
  return s;
};

const enHost = section("英文字体");
const cjkHost = section("中文字体");

/** The round-7 picker-level variant help (demo presence). */
const PICKER_HELP = {
  title: "变体是什么",
  buttonLabel: "变体是什么",
  build: () => {
    const body = document.createElement("div");
    const p = document.createElement("p");
    p.className = "kit-sub";
    p.textContent =
      "同一款字体常有多个发行版本，称为变体；点击字体行下方的标签即可切换。带「默认」的是家族默认。";
    body.append(p);
    return body;
  },
};

const pickerEn: PickerPopup = mountPickerPopup(enHost, {
  role: "en",
  fonts: EN_FONTS,
  selectedId: state.enId,
  footer: { label: "加载本地字体文件", onClick: () => (live.textContent = "演示环境未接入文件选择") },
  help: PICKER_HELP,
  onPick: (id) => {
    state.enId = id;
    topBar.setPair(enName(), cjkName());
    pickerEn.render({
      role: "en",
      fonts: EN_FONTS,
      selectedId: state.enId,
      footer: { label: "加载本地字体文件", onClick: () => (live.textContent = "演示环境未接入文件选择") },
      onPick: (next) => pickerOnPickEn(next),
    });
  },
});

/** The Maple row's live chip selection (round 8: the picked CUT id). */
const chipState = new Map<string, string>();
const MAPLE_CHIPS: Array<{ id: string; label: string }> = [
  { id: "MapleMono::NF", label: "标准" },
  { id: "MapleMono::NF-CN", label: "CN" },
];

/** CJK_FONTS with the Maple chips recomputed from the live selection. */
function cjkFonts() {
  return CJK_FONTS.map((font) =>
    font.id === "maple"
      ? {
          ...font,
          // Round 9: the row name is the picked cut's own name-table
          // string (the default cut reads the family's own name).
          name:
            chipState.get("maple") === MAPLE_CHIPS[1]!.id
              ? "Maple Mono NF CN"
              : "Maple Mono NF",
          chips: MAPLE_CHIPS.map(({ id, label }) => ({
            id,
            label,
            on: chipState.get("maple") === id,
          })),
        }
      : font,
  );
}

const pickerCjk: PickerPopup = mountPickerPopup(cjkHost, {
  role: "cjk",
  fonts: cjkFonts(),
  selectedId: state.cjkId,
  footer: { label: "加载本地字体文件", onClick: () => (live.textContent = "演示环境未接入文件选择") },
  help: PICKER_HELP,
  onPick: (id) => {
    state.cjkId = id;
    topBar.setPair(enName(), cjkName());
    pickerCjk.render({
      role: "cjk",
      fonts: cjkFonts(),
      selectedId: state.cjkId,
      footer: { label: "加载本地字体文件", onClick: () => (live.textContent = "演示环境未接入文件选择") },
      onPick: (next) => pickerOnPickCjk(next),
      onChip: onDemoChip,
    });
  },
  onChip: onDemoChip,
});

/** A demo chip click: toggle the row's explicit cut selection and re-render. */
function onDemoChip(_rowId: string, chipId: string): void {
  const chip = MAPLE_CHIPS.find((c) => c.id === chipId);
  if (!chip) return;
  if (chipState.get("maple") === chip.id) chipState.delete("maple");
  else chipState.set("maple", chip.id);
  pickerCjk.render({
    role: "cjk",
    fonts: cjkFonts(),
    selectedId: state.cjkId,
    footer: { label: "加载本地字体文件", onClick: () => (live.textContent = "演示环境未接入文件选择") },
    onPick: (next) => pickerOnPickCjk(next),
    onChip: onDemoChip,
  });
}

function pickerOnPickEn(id: string): void {
  state.enId = id;
  topBar.setPair(enName(), cjkName());
}

function pickerOnPickCjk(id: string): void {
  state.cjkId = id;
  topBar.setPair(enName(), cjkName());
}

function enName(): string {
  return EN_FONTS.find((f) => f.id === state.enId)?.name ?? "—";
}
function cjkName(): string {
  return CJK_FONTS.find((f) => f.id === state.cjkId)?.name ?? "—";
}

/* ---------- rail: language chips (kit/langChips) ---------- */

const langHost = section("文字范围");
const hint = document.createElement("div");
hint.className = "hint2";
hint.textContent = "勾选的文字由中文字体提供，并入成品";
langHost.appendChild(hint);

const langChips = mountLangChips(langHost, {
  chips: LANGUAGES.map(({ id, label, count }) => ({ id, label, count })),
  isPressed: (id) => state.langSelection.has(id),
  onToggle: (id) => toggleLang(id),
});

function toggleLang(id: string): void {
  if (state.langSelection.has(id) && state.langSelection.size === 1) {
    live.textContent = "至少保留一种";
    return;
  }
  if (state.langSelection.has(id)) state.langSelection.delete(id);
  else state.langSelection.add(id);
  langChips.render({
    chips: LANGUAGES.map(({ id: lid, label, count }) => ({
      id: lid,
      label,
      count,
    })),
    isPressed: (lid) => state.langSelection.has(lid),
    onToggle: (lid) => toggleLang(lid),
  });
}

/* ---------- rail: rules (kit/ruleRows + the kit's undoAllButton) ----- */

const rulesHost = section("自定义规则");
const rulesEl = document.createElement("div");
rulesEl.className = "kit-rules";
rulesHost.appendChild(rulesEl);

/** The demo's rule state — removable rows + a solo-character count. */
interface DemoRule {
  kind: "group" | "block" | "range";
  icon: IconName;
  text: string;
  suffix?: string;
}
const DEMO_RULES: DemoRule[] = [
  { kind: "group", icon: "layers", text: "所有中文字符用中文字体" },
  { kind: "block", icon: "tag", text: "Nerd Font 用英文字体" },
  {
    kind: "range",
    icon: "range",
    // Round 8: the verbatim range sentence.
    text: "U+4E00 一 - U+9F99 龙 用中文字体",
  },
];

/** The demo's single-character rules (the expandable group's children). */
const DEMO_SOLOS = [
  { cp: 0x4e2d, side: "中文" as const },
  { cp: 0x6c38, side: "英文" as const },
];

let soloExpanded = false;

function renderRules(): void {
  const fragment = document.createDocumentFragment();
  for (const [index, rule] of DEMO_RULES.entries()) {
    fragment.appendChild(
      ruleRow({
        ...rule,
        onRemove: () => {
          DEMO_RULES.splice(index, 1);
          renderRules();
        },
      }),
    );
  }
  if (DEMO_SOLOS.length > 0) {
    // Round 8: the dashed aggregate expands into its per-character
    // rows. Round 9 (owner item 6): it carries its own × deleting the
    // whole group in one move.
    fragment.appendChild(
      ruleSoloRow(DEMO_SOLOS.length, {
        expanded: soloExpanded,
        onToggle: () => {
          soloExpanded = !soloExpanded;
          renderRules();
        },
        onRemove: () => {
          DEMO_SOLOS.length = 0;
          renderRules();
        },
      }),
    );
    if (soloExpanded) {
      for (const [index, solo] of DEMO_SOLOS.entries()) {
        const label = `U+${solo.cp
          .toString(16)
          .toUpperCase()
          .padStart(4, "0")} ${String.fromCodePoint(solo.cp)} 用${solo.side}字体`;
        fragment.appendChild(
          ruleRow({
            kind: "codepoint",
            icon: "pen",
            text: label,
            onRemove: () => {
              DEMO_SOLOS.splice(index, 1);
              renderRules();
            },
          }),
        );
      }
    }
  }
  if (DEMO_RULES.length === 0 && DEMO_SOLOS.length === 0) {
    fragment.appendChild(ruleEmptyState());
  }
  fragment.appendChild(
    undoAllButton(() => {
      DEMO_SOLOS.length = 0;
      // The prototype's 全部恢复默认 clears EVERYTHING (block rules,
      // ranges, single-character overrides) — the empty state follows.
      DEMO_RULES.length = 0;
      renderRules();
      live.textContent = "已全部恢复默认";
    }),
  );
  rulesEl.replaceChildren(fragment);
}
renderRules();

/* ---------- rail: synthesis settings (kit mountSettingRow) ---------- */

const settingsHost = section("合成设置");
const settingsWrap = document.createElement("div");
settingsWrap.className = "demo-settings";
settingsHost.appendChild(settingsWrap);

for (const topic of SETTINGS_TOPICS) {
  const row = mountSettingRow(topic, {
    value: topic.options[0].value,
    onChange: (value) => {
      row.el.dataset.value = value;
      live.textContent = `${topic.name}：${
        topic.options.find((o) => o.value === value)?.label ?? value
      }`;
    },
  });
  row.select.el.dataset.role = `select-${topic.key}`;
  settingsWrap.appendChild(row.el);
}

/* ---------- content: mode bar ---------- */

const modeBar = document.createElement("div");
modeBar.className = "kit-modebar";
content.appendChild(modeBar);

const modeSeg = segmentedControl({
  options: [
    { value: "grid", label: "字符表" },
    { value: "scene", label: "实际场景" },
  ],
  value: "grid",
  onSelect: (v) => setMode(v as "grid" | "scene"),
});
modeSeg.dataset.role = "mode-seg";
modeBar.appendChild(modeSeg);
const modeGrow = document.createElement("span");
modeGrow.className = "kit-grow";
modeBar.appendChild(modeGrow);
const previewInput = document.createElement("input");
previewInput.placeholder = "自定义预览文字";
previewInput.setAttribute("aria-label", "自定义预览文字");
previewInput.dataset.role = "preview-text";
previewInput.addEventListener("input", () => {
  state.customPreview = previewInput.value.trim();
  if (state.mode === "scene") renderScenes(false);
});
modeBar.appendChild(previewInput);
const gotoInput = document.createElement("input");
gotoInput.placeholder = "定位 永 或 U+6C38";
gotoInput.setAttribute("aria-label", "定位");
gotoInput.style.minWidth = "140px";
gotoInput.dataset.role = "goto";
gotoInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const parsed = parseCodepoint(gotoInput.value);
  if (parsed === null) return;
  locate(String.fromCodePoint(parsed));
});
modeBar.appendChild(gotoInput);

function parseCodepoint(raw: string): number | null {
  const s = raw.trim();
  if (/^u\+[0-9a-f]{4,6}$/i.test(s)) return parseInt(s.slice(2), 16);
  const chars = [...s];
  if (chars.length === 1) return chars[0].codePointAt(0) ?? null;
  return null;
}

function locate(ch: string): void {
  const block = DEMO_BLOCKS.find((b) => b.chars.includes(ch));
  if (!block) return;
  state.group = block.groupId;
  state.block = block.id;
  state.page = Math.floor(block.chars.indexOf(ch) / PAGE_SIZE);
  setMode("grid");
  renderGridArea();
  window.setTimeout(() => {
    const cell = grid.cellAt(ch);
    if (cell) {
      cell.style.outline = "2px solid var(--ac)";
      cell.scrollIntoView({ block: "center" });
      window.setTimeout(() => {
        cell.style.outline = "";
      }, 2000);
    }
  }, 60);
}

/* ---------- content: grid view ---------- */

const gridView = document.createElement("div");
gridView.className = "demo-grid-view";
content.appendChild(gridView);

const catChips: CategoryChips = mountCategoryChips(gridView, {
  groups: demoGroups(),
  blocks: demoBlocksFor(state.group),
  activeGroupId: state.group,
  activeBlockId: state.block,
  onGroup: (id) => {
    state.group = id;
    state.block = id ? (id === "miss" ? "miss" : `g:${id}`) : "all";
    state.page = 0;
    renderGridArea();
  },
  onBlock: (id) => {
    state.block = id;
    state.page = 0;
    renderGridArea();
  },
});

const actionBar: ActionBar = mountActionBar(gridView, {
  multi: state.multi,
  showCodepoints: state.showCodepoints,
  canUndo: undoDepth.rules > 0,
  onUndo: () => (live.textContent = "已撤销上一步"),
  onToggleMulti: () => {
    state.multi = !state.multi;
    state.selection.clear();
    renderGridArea();
  },
  onToggleCodepoints: () => {
    state.showCodepoints = !state.showCodepoints;
    renderGridArea();
  },
  onLocate: (query) => {
    const parsed = parseCodepoint(query);
    if (parsed !== null) locate(String.fromCodePoint(parsed));
  },
  onRangeSpecify: () => rangePopup.toggle(),
});

/* ---------- the char popup + the range popup (kit parts) ---------- */

const charPopup = mountCharPopup();

const rangePopup = mountRangePopup(actionBar.el, {
  onApply: (start, end, side) => {
    const s = parseCodepoint(start);
    const e = end.trim() === "" ? s : parseCodepoint(end);
    if (s === null || e === null || e < s) return false;
    live.textContent = `已添加区间规则（${
      side === "base" ? "英文" : "中文"
    }字体）`;
    return true;
  },
});

/** The demo's char-popup facts for a cell (the kit renders them). */
function demoCharFacts(data: GridCellData): CharPopupFacts {
  const cp = data.ch.codePointAt(0)!;
  const code = data.cp ?? `U+${formatCodepoint(data.ch)}`;
  if (data.state === "none") {
    const missingCopy =
      cp >= 0xe000 && cp <= 0xf8ff
        ? "这是一个 Nerd Font 图标字符，位于专用区编码。只有英文字体包含这类图标，合成时保留英文字体的图标。"
        : "两个字体均不含该字形";
    return {
      glyph: data.ch,
      missing: true,
      code,
      from: missingCopy,
      showBase: false,
      showDonor: false,
      showReset: false,
    };
  }
  const winnerIsBase = data.state !== "donor";
  return {
    glyph: data.ch,
    glyphFamily: winnerIsBase ? BASE_STACK : DONOR_STACK,
    code,
    from: `来自 ${winnerIsBase ? BASE_NAME : DONOR_NAME}`,
    showBase: !winnerIsBase,
    showDonor: winnerIsBase,
    showReset: ADJUSTED_CHARS.has(data.ch),
    onBase: () => (live.textContent = `${data.ch} 已指定为英文字体`),
    onDonor: () => (live.textContent = `${data.ch} 已指定为中文字体`),
    onReset: () => (live.textContent = `${data.ch} 已恢复默认`),
  };
}

const grid: CharGrid = mountCharGrid(gridView);

/** Chars of the active view (block, group aggregate, all, or missing). */
interface ActiveView {
  chars: string[];
  sideOf(ch: string): FontSide;
  label: string;
  groupLabel: string | null;
  aggregate: boolean;
}

function activeChars(): ActiveView {
  if (state.block === "miss") {
    return {
      chars: [...MISSING_CHARS],
      sideOf: () => "base",
      label: "缺失",
      groupLabel: null,
      aggregate: false,
    };
  }
  if (state.block === "all") {
    return {
      chars: DEMO_BLOCKS.flatMap((b) => [...b.chars]),
      sideOf: (ch) => (isCjk(ch) ? "donor" : "base"),
      label: "全部",
      groupLabel: null,
      aggregate: true,
    };
  }
  if (state.block.startsWith("g:")) {
    const gid = state.block.slice(2);
    const subs = DEMO_BLOCKS.filter((b) => b.groupId === gid);
    return {
      chars: subs.flatMap((b) => [...b.chars]),
      sideOf: (ch) => (gid === "cjk" || isCjk(ch) ? "donor" : "base"),
      label: "全部",
      groupLabel: subs[0]?.groupLabel ?? null,
      aggregate: true,
    };
  }
  const block =
    DEMO_BLOCKS.find((b) => b.id === state.block) ??
    DEMO_BLOCKS[DEMO_BLOCKS.length - 1];
  return {
    chars: [...block.chars],
    sideOf: () => block.side,
    label: block.label,
    groupLabel: block.groupLabel,
    aggregate: false,
  };
}

function isCjk(ch: string): boolean {
  return /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch);
}

function renderGridArea(): void {
  const view = activeChars();
  catChips.render({
    groups: demoGroups(),
    blocks: state.group ? demoBlocksFor(state.group) : [],
    activeGroupId: state.group,
    activeBlockId: state.block,
    onGroup: (id) => {
      state.group = id;
      state.block = id ? (id === "miss" ? "miss" : `g:${id}`) : "all";
      state.page = 0;
      renderGridArea();
    },
    onBlock: (id) => {
      state.block = id;
      state.page = 0;
      renderGridArea();
    },
  });

  const pages = Math.max(1, Math.ceil(view.chars.length / PAGE_SIZE));
  if (state.page >= pages) state.page = pages - 1;
  const pageChars = view.chars.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);

  if (state.multi && state.selection.size > 0) {
    actionBar.render({
      multi: state.multi,
      showCodepoints: state.showCodepoints,
      canUndo: undoDepth.rules > 0,
      onUndo: () => (live.textContent = "已撤销上一步"),
      onToggleMulti: () => {
        state.multi = !state.multi;
        state.selection.clear();
        renderGridArea();
      },
      onToggleCodepoints: () => {
        state.showCodepoints = !state.showCodepoints;
        renderGridArea();
      },
      batch: {
        count: state.selection.size,
        canUndoPick: undoDepth.picks > 0,
        onApply: (side) => {
          if (side === "clear") {
            state.selection.clear();
          } else {
            live.textContent = "批量调整完成";
            state.selection.clear();
          }
          renderGridArea();
        },
        onUndoPick: () => (live.textContent = "已撤销选择"),
      },
      onRangeSpecify: () => rangePopup.toggle(),
    });
  } else {
    actionBar.render({
      group:
        view.groupLabel && state.block !== "miss"
          ? {
              label: view.groupLabel,
              allBase: false,
              allDonor: view.groupLabel === "中文",
              onAssign: (side) =>
                (live.textContent = `整组已设为${side === "base" ? "英文" : "中文"}字体`),
            }
          : undefined,
      block: state.block === "miss"
        ? undefined
        : view.aggregate
          ? { label: view.label, aggregate: true, count: view.chars.length }
          : {
              label: view.label,
              aggregate: false,
              value: view.sideOf("一"),
              onAssign: (side) =>
                (live.textContent = `${view.label}已设为${side === "base" ? "英文" : "中文"}字体`),
            },
      missingView: state.block === "miss",
      multi: state.multi,
      showCodepoints: state.showCodepoints,
      canUndo: undoDepth.rules > 0,
      onUndo: () => (live.textContent = "已撤销上一步"),
      onToggleMulti: () => {
        state.multi = !state.multi;
        state.selection.clear();
        renderGridArea();
      },
      onToggleCodepoints: () => {
        state.showCodepoints = !state.showCodepoints;
        renderGridArea();
      },
      page: {
        page: state.page,
        count: pages,
        onPage: (d) => {
          state.page = Math.max(0, Math.min(pages - 1, state.page + d));
          renderGridArea();
        },
      },
      adjustedLegend: true,
      onLocate: (query) => {
        const parsed = parseCodepoint(query);
        if (parsed !== null) locate(String.fromCodePoint(parsed));
      },
      onRangeSpecify: () => rangePopup.toggle(),
    });
  }

  grid.render({
    cells: pageChars.map((ch) =>
      gridCellData(
        {
          ch,
          side: view.sideOf(ch),
          missing: MISSING_CHARS.has(ch),
          adjusted: ADJUSTED_CHARS.has(ch),
        },
        state.selection.has(ch),
      ),
    ),
    showCodepoints: state.showCodepoints,
    cellSize: 40,
    onCellClick: (data, cell) => {
      if (state.multi) {
        if (state.selection.has(data.ch)) state.selection.delete(data.ch);
        else state.selection.add(data.ch);
        undoDepth.picks += 1;
        renderGridArea();
      } else {
        // A plain click opens the char popup AT the cell (the kit's
        // CharPopup; the demo facts come from the cell's state).
        charPopup.openAt(cell, demoCharFacts(data));
      }
    },
  });

  statusBar.render(demoStats(state.selection.size));
}

/* ---------- content: scene view ---------- */

const sceneWrap = document.createElement("div");
sceneWrap.className = "kit-scene-wrap";
content.appendChild(sceneWrap);

const sceneCards = new Map<SceneKind, SceneCard>();
for (const [kind, caption] of [
  ["terminal", "终端"],
  ["code", "代码编辑器"],
  ["document", "文档"],
] as const) {
  sceneCards.set(
    kind,
    mountSceneCard(sceneWrap, {
      kind,
      caption,
      themeId: kind === "terminal" ? state.termTheme : state.edTheme,
      onThemeChange: (id) => {
        if (kind === "terminal") state.termTheme = id;
        else state.edTheme = id;
      },
      onExpand: (k) => openFullscreen(k),
      content: { customText: state.customPreview || undefined },
    }),
  );
}

function renderScenes(withEntrance: boolean): void {
  sceneWrap.classList.toggle("no-in", !withEntrance);
  for (const [kind, card] of sceneCards) {
    card.render({
      kind,
      caption: kind === "terminal" ? "终端" : kind === "code" ? "代码编辑器" : "文档",
      themeId: kind === "terminal" ? state.termTheme : state.edTheme,
      onThemeChange: (id) => {
        if (kind === "terminal") state.termTheme = id;
        else state.edTheme = id;
      },
      onExpand: (k) => openFullscreen(k),
      content: { customText: state.customPreview || undefined },
    });
  }
}

const zoomHost = document.createElement("div");
zoomHost.className = "demo-zoom-host";
app.appendChild(zoomHost);

let zoomOverlay: ReturnType<typeof mountFullscreenScene> | null = null;

const ZOOM_CAPTIONS: Record<SceneKind, string> = {
  terminal: "终端",
  code: "代码编辑器",
  document: "文档",
};
const ZOOM_KINDS: SceneKind[] = ["terminal", "code", "document"];
let zoomKind: SceneKind = "terminal";

/** The fullscreen props for one scene kind (prev/next step in place). */
function zoomProps(kind: SceneKind): Parameters<ReturnType<typeof mountFullscreenScene>["render"]>[0] {
  return {
    kind,
    caption: ZOOM_CAPTIONS[kind],
    content: { customText: state.customPreview || undefined },
    onPrev: () => {
      const i = ZOOM_KINDS.indexOf(zoomKind);
      zoomKind = ZOOM_KINDS[(i - 1 + ZOOM_KINDS.length) % ZOOM_KINDS.length]!;
      zoomOverlay?.render(zoomProps(zoomKind));
    },
    onNext: () => {
      const i = ZOOM_KINDS.indexOf(zoomKind);
      zoomKind = ZOOM_KINDS[(i + 1) % ZOOM_KINDS.length]!;
      zoomOverlay?.render(zoomProps(zoomKind));
    },
    onClose: () => undefined,
  };
}

function openFullscreen(kind: SceneKind): void {
  zoomOverlay?.close();
  zoomKind = kind;
  zoomOverlay = mountFullscreenScene(zoomHost, zoomProps(kind));
}

/* ---------- status bar + mode switching ---------- */

const statusBar: StatusBar = mountStatusBar(app);

function setMode(mode: "grid" | "scene"): void {
  if (mode === state.mode) return;
  if (mode === "scene") sceneEntrance = true;
  state.mode = mode;
  modeSeg.dataset.value = mode;
  for (const btn of modeSeg.querySelectorAll("button")) {
    btn.setAttribute("aria-pressed", String(btn.dataset.value === mode));
  }
  previewInput.style.display = mode === "scene" ? "" : "none";
  gridView.style.display = mode === "scene" ? "none" : "flex";
  sceneWrap.style.display = mode === "scene" ? "" : "none";
  if (mode === "scene") renderScenes(sceneEntrance);
  sceneEntrance = false;
}

/* ---------- boot ---------- */

// Round 5: boot from the persisted 3-state preference (自动 follows the
// system live) — the same policy the app's top bar uses.
applyStoredThemePreference();
previewInput.style.display = "none";
sceneWrap.style.display = "none";
renderGridArea();
