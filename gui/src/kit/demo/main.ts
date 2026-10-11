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
import { mountAppSelect } from "../appSelect";
import { mountHelpPopover } from "../helpPopover";
import { SETTINGS_TOPICS } from "../settingsTopics";
import { mountCategoryChips, type CategoryChips } from "../categoryChips";
import { mountActionBar, segmentedControl, undoAllButton, type ActionBar } from "../actionBar";
import { mountCharGrid, type CharGrid } from "../grid";
import { mountStatusBar, type StatusBar } from "../statusBar";
import { mountSceneCard, mountFullscreenScene, type SceneCard } from "../sceneCard";
import { mountTopBar } from "../topBar";
import { icon } from "../icons";
import type { SceneKind } from "../sceneCard";
import { applyAppTheme, type AppTheme } from "../theme";
import type { FontSide } from "../actionBar";
import {
  ADJUSTED_CHARS,
  CJK_FONTS,
  DEMO_BLOCKS,
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

const PAGE_SIZE = 1024;
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

const pickerEn: PickerPopup = mountPickerPopup(enHost, {
  role: "en",
  fonts: EN_FONTS,
  selectedId: state.enId,
  footer: { label: "加载本地字体文件", onClick: () => (live.textContent = "演示环境未接入文件选择") },
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

const pickerCjk: PickerPopup = mountPickerPopup(cjkHost, {
  role: "cjk",
  fonts: CJK_FONTS,
  selectedId: state.cjkId,
  footer: { label: "加载本地字体文件", onClick: () => (live.textContent = "演示环境未接入文件选择") },
  onPick: (id) => {
    state.cjkId = id;
    topBar.setPair(enName(), cjkName());
    pickerCjk.render({
      role: "cjk",
      fonts: CJK_FONTS,
      selectedId: state.cjkId,
      footer: { label: "加载本地字体文件", onClick: () => (live.textContent = "演示环境未接入文件选择") },
      onPick: (next) => pickerOnPickCjk(next),
    });
  },
});

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

/* ---------- rail: language chips ---------- */

const langHost = section("文字范围");
const hint = document.createElement("div");
hint.className = "hint2";
hint.textContent = "勾选的文字由中文字体提供，并入成品";
langHost.appendChild(hint);
const langRow = document.createElement("div");
langRow.className = "kit-chiprow";
langHost.appendChild(langRow);

function renderLangs(): void {
  langRow.innerHTML = "";
  for (const lang of LANGUAGES) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "kit-lchip";
    chip.dataset.lang = lang.id;
    chip.setAttribute("aria-pressed", String(state.langSelection.has(lang.id)));
    chip.innerHTML = `${lang.label}<span class="n">${lang.count}</span>`;
    chip.addEventListener("click", () => {
      if (state.langSelection.has(lang.id) && state.langSelection.size === 1) {
        live.textContent = "至少保留一种";
        return;
      }
      if (state.langSelection.has(lang.id)) state.langSelection.delete(lang.id);
      else state.langSelection.add(lang.id);
      renderLangs();
    });
    langRow.appendChild(chip);
  }
}
renderLangs();

/* ---------- rail: rules (assembled from kit primitives) ---------- */

const rulesHost = section("自定义规则");
const rulesEl = document.createElement("div");
rulesEl.className = "demo-rules";
rulesHost.appendChild(rulesEl);

function renderRules(): void {
  rulesEl.innerHTML = "";
  const rules: Array<{ icn: string; text: string; us?: string }> = [
    { icn: "layers", text: "所有中文字符用中文字体" },
    { icn: "star", text: "Nerd Font用英文字体" },
    { icn: "range", text: "一 至 龙 用中文字体", us: "U+4E00 至 U+9F99" },
    { icn: "pen", text: "单个字符" },
  ];
  for (const rule of rules) {
    const row = document.createElement("div");
    row.className = "demo-rl";
    row.innerHTML = icon(rule.icn as never);
    const tx = document.createElement("span");
    tx.className = "tx";
    tx.textContent = rule.text;
    row.appendChild(tx);
    if (rule.us) {
      const us = document.createElement("span");
      us.className = "us";
      us.textContent = rule.us;
      row.appendChild(us);
    }
    const del = document.createElement("button");
    del.type = "button";
    del.className = "del";
    del.setAttribute("aria-label", "删除规则");
    del.innerHTML = icon("close");
    row.appendChild(del);
    rulesEl.appendChild(row);
  }
  rulesEl.appendChild(
    undoAllButton(() => {
      live.textContent = "已全部恢复默认";
    }),
  );
}
renderRules();

/* ---------- rail: synthesis settings ---------- */

const settingsHost = section("合成设置");
const settingsWrap = document.createElement("div");
settingsWrap.className = "demo-setting-row";
settingsHost.appendChild(settingsWrap);

for (const topic of SETTINGS_TOPICS) {
  const row = document.createElement("div");
  const label = document.createElement("div");
  label.className = "demo-setting-label";
  label.appendChild(document.createTextNode(topic.name));
  const help = mountHelpPopover({
    id: topic.topic.id,
    title: topic.topic.title,
    buttonLabel: topic.topic.buttonLabel,
    width: topic.topic.width,
    build: topic.topic.build,
  });
  label.appendChild(help.anchor);
  row.appendChild(label);
  const select = mountAppSelect({
    label: topic.name,
    value: topic.options[0].value,
    options: topic.options,
    onChange: (value) => {
      row.dataset.value = value;
      live.textContent = `${topic.name}：${topic.options.find((o) => o.value === value)?.label ?? value}`;
    },
  });
  select.el.dataset.role = `select-${topic.key}`;
  row.appendChild(select.el);
  settingsWrap.appendChild(row);
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
  onRangeSpecify: () => (live.textContent = "按编码指定：演示环境未接入"),
});

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
      onRangeSpecify: () => (live.textContent = "按编码指定：演示环境未接入"),
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
      onRangeSpecify: () => (live.textContent = "按编码指定：演示环境未接入"),
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
    onCellClick: (data) => {
      if (state.multi) {
        if (state.selection.has(data.ch)) state.selection.delete(data.ch);
        else state.selection.add(data.ch);
        undoDepth.picks += 1;
        renderGridArea();
      } else {
        live.textContent = `${data.ch} U+${data.ch
          .codePointAt(0)!
          .toString(16)
          .toUpperCase()
          .padStart(4, "0")}`;
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

function openFullscreen(kind: SceneKind): void {
  const captions: Record<SceneKind, string> = {
    terminal: "终端",
    code: "代码编辑器",
    document: "文档",
  };
  const kinds: SceneKind[] = ["terminal", "code", "document"];
  let index = kinds.indexOf(kind);
  mountFullscreenScene(zoomHost, {
    kind,
    caption: captions[kind],
    content: { customText: state.customPreview || undefined },
    onPrev: () => {
      index = (index - 1 + kinds.length) % kinds.length;
      openFullscreen(kinds[index]);
    },
    onNext: () => {
      index = (index + 1) % kinds.length;
      openFullscreen(kinds[index]);
    },
    onClose: () => undefined,
  });
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

const initialTheme: AppTheme = window.matchMedia("(prefers-color-scheme: dark)").matches
  ? "dark"
  : "light";
applyAppTheme(initialTheme);
previewInput.style.display = "none";
sceneWrap.style.display = "none";
renderGridArea();
