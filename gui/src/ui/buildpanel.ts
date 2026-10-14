/**
 * The build panel (issue #16): synthesis progress and the verification
 * report — as a fixed, non-modal panel above the stats bar. The
 * workspace underneath stays fully interactive while builds run
 * (queueing more, browsing, editing); failures and reports are inline
 * page text, never hover-only, never modal.
 *
 * The panel node is created once; row nodes are keyed by build id and
 * updated in place (the same node-survival invariant every popup
 * follows).
 *
 * Round 10 (the build-panel repair — the stepper IS the progress):
 *
 * - **One render per state transition.** The 250 ms poll spreads a new
 *   row object every tick; the render is now signature-gated (status /
 *   stage / queue position / error / saved path / report presence), so
 *   an unchanged poll tick mutates NOTHING — no re-parenting, no
 *   reflow, no animation restarts (the old code rebuilt the row list
 *   every tick, restarting the entrance animation and oscillating the
 *   scrollbars).
 * - **Fixed panel height.** The panel never sizes to its content; the
 *   rows region owns the scrolling (reserved gutter). A build can grow,
 *   settle, and render its report without the panel's clientHeight or
 *   scrollbars ever moving. (Superseded by round 11 below: the panel
 *   now sizes to content while calm — the no-flicker machinery is what
 *   survives, not the fixed height.)
 * - **The stepper is the progress.** Upcoming faint / current active /
 *   done lit-solid, plus ONE current-stage line (stage term + ≤30-char
 *   note, doubling as the queue-position line while queued). The
 *   append-only vertical journal is gone — it duplicated the stepper.
 * - **One ? per section heading.** The ? anchors sit optically centered
 *   with their heading (flex + align-items: center — the inline
 *   baseline rides high); their popovers stack ABOVE the panel
 *   (`.build-help-pop`, z-index 890 vs the panel's 880) so the panel
 *   can never cover its own help.
 * - **No raw JSON.** The report renders as the human glossary only,
 *   collapsed behind a 查看报告 disclosure so a completed row stays
 *   calm (saved line first). The machine JSON froze the app for tens
 *   of seconds when stringified into a <pre>; it is gone from the UI.
 *
 * Round 11 (the sizing + terminology round):
 *
 * - **Content-sized while calm.** The panel sizes to its content (the
 *   compact idle/progress state) with the round-10 max as the ceiling,
 *   and grows to that ceiling ONLY while a report disclosure is open
 *   (`.is-report-open`). The signature-gated rendering, the reserved
 *   stage-line block and the reserved scrollbar gutter all survive, so
 *   the poll still moves nothing — the height changes only on real
 *   state transitions (a row settling, the disclosure toggling), never
 *   frame to frame.
 * - **Panel close ×.** The title row carries the kit close glyph with
 *   the toast ×'s own treatment; it clears every row any time —
 *   running builds included (the serve has no abort endpoint; the UI
 *   simply stops tracking them) — and the next synthesize re-opens
 *   the panel fresh.
 * - **英文字体 / 中文字体, real words only** (the round-11 ruling):
 *   user-facing copy never says 基底 or 供体 — those stay in the
 *   machine layer (JSON keys `base`/`donor-*`, the glossary doc, code
 *   identifiers). With exactly one donor the source list drops the
 *   role numbering entirely and reads the fonts' real names.
 * - **Full ?-popovers.** One ? per section heading (the round-10
 *   ruling stands), each popover carrying the title explanation PLUS
 *   every sub-item of its section as a compact worked table (the
 *   round-6 verbatim style, no essays) — and the notation legend
 *   lives where it applies: 「A → B」 in the metrics popover, 「X ← Y」
 *   in the weight-slot one.
 *
 * Round 12 (the copy-structure round):
 *
 * - **No dash-joins anywhere.** The stage line is TWO lines (the stage
 *   name, the dim note under it — the reserved-height discipline
 *   survives); every 「 — 」 single-line join in the panel and report
 *   was restructured as stacked lines/rows. Nothing relies on an
 *   em-dash to separate.
 * - **Borrow direction corrected.** The weight-slot rows read the
 *   ratified 「成品档位 ← 来源字体」 notation (「400 ← Maple Mono CN ·
 *   自动取最近」), not the inverted family-first form; the via
 *   qualifier rides after a ·.
 * - **「无」 for no-value.** A before-value the machine layer could not
 *   compute reads 「无」 (the metrics rows are 合并前 / 合并后 lines);
 *   the dash placeholder and its legend row are gone.
 * - **Section headings regain weight** (600, full ink — distinct from
 *   the rows in both themes).
 *
 * Round 12 (the save flow):
 *
 * - **The stepper keeps its lit segments through the save** (owner
 *   item 2): the artifact handoff rides the 保存输出 stage — segments
 *   already done stay lit while a dialog (or the default-directory
 *   write) is in flight and after it; only the current segment
 *   pulses. The old stage lookup indexed the serve's terminal
 *   `stage: "done"`, which no stepper segment matches — the whole
 *   stepper blanked exactly while the dialog stood open.
 * - **Default-path save, dialog optional** (owner item 3): the saved
 *   line carries the FULL path (已保存：…), the completed row owns a
 *   另存为 button (the native dialog on demand), and a fallback
 *   notice line (`data-build-notice`) explains a dialog that could
 *   not open. The orchestration lives in synthesize.ts
 *   (`saveBuildAs`); the 设置 entry 输出目录 lives in ui/settings.ts.
 *
 * Round 13 (the living-progress round — apple-design + better-series
 * mandate: springs, not scripted animation; state never carried by
 * motion alone; continuous feedback; every element earns its place):
 *
 * - **The saved line is TWO rows** (owner item 4): 「已保存」 on the
 *   first row (with the 另存为 affordance at its right), the FULL path
 *   on the row under it — never label and path joined by an auto-wrap.
 *   The path middle-ellipsizes when it overflows (the whole path rides
 *   the title attribute), keeping both the head and the file name of
 *   even a deep temp path readable.
 * - **Living progress** (owner item 5): the stepper segments light up
 *   through a ~300ms critically-damped transition instead of snapping
 *   (opacity/fill; `prefers-reduced-motion` falls back to an
 *   opacity-only cross-fade), and the current-stage block carries live
 *   quantitative data right-aligned opposite the two-line stage
 *   title/description: the elapsed time (mm:ss, ticking) plus the
 *   stage facts the serve's progress payload now carries (读取字体:
 *   file count + sizes; 规划字重: slot count; 解析规则: rule count,
 *   joined by the effective codepoint count once resolved; 移植字形:
 *   slots + codepoints; 改写名称表: output faces; 保存输出: format +
 *   an estimated size; 生成报告: check count). The GUI renders what is
 *   present and degrades to elapsed-only when a stage carries no
 *   facts; under reduced motion there is no per-second ticker — the
 *   values still update on every real state change.
 * - **The metrics section is a real table** (owner item 6): rows are
 *   the metrics, the two data columns 合并前 / 合并后 are stated ONCE
 *   in a header row, values are column-aligned (tabular-nums), the
 *   「无」 placeholder stays, and zero · separators appear anywhere in
 *   the section — the ?-popover explains the two columns once.
 *
 * Round 17 (the tag round, owner item 2): the report's parenthetical
 * qualifiers — 「ttc（多字体合集）」, 「…（自动取最近）」, the per-cell
 * 「family · via」 — never ride the value text as brackets or dot-joins
 * again. Each qualifier is a small badge TAG beside the text
 * (`.report-tag`, the picker's 未下载 chip idiom: tiny, muted border +
 * fill on theme tokens, no shadows), carried by a stable
 * `data-role="report-tag"`. The tag is a decorative qualifier of the
 * adjacent text: a real span, never nested inside an ellipsizing text
 * span, never wrapping mid-word. Stage-note enumerations inside a
 * sentence (「按选定格式（ttf / ttc / woff2）」) are NOT qualifiers and
 * keep their brackets.
 *
 * Wording follows the owner-ratified copy spec
 * (`fontalloy-notes/report-copy.md`): real words only, the round-10
 * ruling trims the ?-popovers to one per section heading.
 */

import { synthStore, removeBuild, type BuildRow } from "../service/state";
import { saveBuildAs } from "../service/synthesize";
import {
  mountHelpPopover,
  helpNote,
  workedTable,
  type HelpPopover,
} from "../kit/helpPopover";
import { brandMark } from "../kit/topBar";
import { icon } from "../kit/icons";
import { store } from "../state";
import { variantDisplayName } from "./picker";

/**
 * The pipeline stages (report-copy §1): the key drives the serve's
 * stage string, the label is the 阶段名, and the note is the ≤30-char
 * line shown while the stage is current.
 */
const STAGES: ReadonlyArray<readonly [string, string, string]> = [
  ["loading", "读取字体", "打开英文与中文字体，读取字重、样式和字符范围。"],
  ["planning", "规划字重", "确定成品要生成哪些字重与样式，每个档位用哪款字体出字。"],
  ["resolving", "解析规则", "把规则展开成一张对照表：每个码位最终由哪款字体提供。"],
  ["grafting", "移植字形", "中文字形缩放到英文字体尺寸后并入成品，重建码位对照表。"],
  ["rewriting", "改写名称表", "给成品写入自己的字体名和样式名，并校正字体的尺寸标记。"],
  ["saving", "保存输出", "按选定格式（ttf / ttc / woff2）把成品字体写入磁盘。"],
  ["reporting", "生成报告", "重新打开写好的文件核对一遍，生成这份验证报告。"],
] as const;

function stageLabel(stage: string): string {
  const found = STAGES.find(([key]) => key === stage);
  if (found) return found[1];
  if (stage === "done") return "完成";
  return stage;
}

/** The current stage's ≤30-char explanation (report-copy §1). */
function stageNote(stage: string): string | null {
  const found = STAGES.find(([key]) => key === stage);
  return found ? found[2] : null;
}

/** What the row's head status term says for the row's current state. */
function statusText(row: BuildRow): string {
  switch (row.status) {
    case "queued":
      return "排队中";
    case "running":
      return row.stage === null ? "正在合成" : stageLabel(row.stage);
    case "saving":
      return "正在保存";
    case "saved":
    case "done":
      return "完成";
    case "failed":
    case "error":
      return "失败";
  }
}

/**
 * The TWO lines under the stepper (round 12, owner item 1): the stage
 * term on its own line, the dim ≤30-char note on the line under it —
 * never one line joined by a dash (nothing in the panel relies on an
 * em-dash to separate). The queue position while queued and the saver
 * note while the artifact hands off follow the same two-line shape;
 * nothing renders once the row has settled (the saved line / error box
 * own those states).
 */
function stageLineParts(row: BuildRow): { name: string; note: string } {
  switch (row.status) {
    case "queued":
      return {
        name:
          row.queuePosition !== null && row.queuePosition > 1
            ? `排队中（第 ${row.queuePosition} 位）`
            : "排队中",
        note: "",
      };
    case "running":
      if (row.stage === null) return { name: "正在合成", note: "" };
      return { name: stageLabel(row.stage), note: stageNote(row.stage) ?? "" };
    case "saving":
      return { name: "正在保存", note: "把成品字体写入磁盘。" };
    default:
      return { name: "", note: "" };
  }
}

/**
 * Number rendering; a field the machine layer omitted or nulled reads
 * as the single word 「无」 (round 12, owner item 5 as corrected by the
 * owner: the no-value placeholder is 无, never a dash — v2 omits or
 * nulls metric fields it could not compute).
 */
const NO_VALUE = "无";

function fmt(value: number | null | undefined): string {
  return typeof value === "number" ? value.toLocaleString("en-US") : NO_VALUE;
}

/* -- round 13, owner item 5: the live facts column ----------------- */

/** How one stage's fact renders (the label word + the value format). */
interface FactRender {
  label: string;
  format: (value: string | number) => string;
}

/** Bytes as a short human scale (4.4 MB, 820 KB). */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

const plain = (value: string | number): string => String(value);

/**
 * The serve's fact keys per stage, in display order, with their label
 * word and value format. Unknown stages or keys render nothing — the
 * panel degrades forward-compatibly (an older GUI simply ignores a
 * newer core's extra keys). At most TWO facts render per stage: the
 * reserved live column holds elapsed + two fact lines.
 */
const STAGE_FACTS: Readonly<Record<string, Readonly<Record<string, FactRender>>>> = {
  loading: {
    files: { label: "文件", format: (v) => `${v} 个` },
    bytes: { label: "大小", format: (v) => formatBytes(Number(v)) },
  },
  planning: {
    slots: { label: "档位", format: (v) => `${v} 个` },
  },
  resolving: {
    rules: { label: "规则", format: (v) => `${v} 条` },
    codepoints: { label: "生效码位", format: (v) => Number(v).toLocaleString("en-US") },
  },
  grafting: {
    slots: { label: "档位", format: (v) => `${v} 个` },
    codepoints: { label: "码位", format: (v) => Number(v).toLocaleString("en-US") },
  },
  rewriting: {
    faces: { label: "输出面", format: (v) => `${v} 个` },
  },
  saving: {
    format: { label: "格式", format: plain },
    bytes_est: { label: "估计大小", format: (v) => formatBytes(Number(v)) },
  },
  reporting: {
    checks: { label: "检查", format: (v) => `${v} 项` },
  },
};

/**
 * The current stage's fact lines (`「label value」` strings, at most
 * two). Absent facts — an older serve, or a stage that carries none —
 * render nothing and the column shows the elapsed timer alone.
 */
function stageFactLines(
  stage: string | null,
  facts: Readonly<Record<string, string | number>> | null | undefined,
): string[] {
  if (stage === null || facts === null || facts === undefined) return [];
  const renders = STAGE_FACTS[stage];
  if (renders === undefined) return [];
  const lines: string[] = [];
  for (const key of Object.keys(renders)) {
    const value = facts[key];
    if (value === undefined) continue;
    const render = renders[key]!;
    lines.push(`${render.label} ${render.format(value)}`);
    if (lines.length === 2) break;
  }
  return lines;
}

/** Elapsed since an ISO timestamp, as ticking mm:ss (null if unparseable). */
function elapsedLabel(startedIso: string): string | null {
  const start = Date.parse(startedIso);
  if (Number.isNaN(start)) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
  const mm = Math.floor(seconds / 60);
  const ss = String(seconds % 60).padStart(2, "0");
  return `用时 ${mm}:${ss}`;
}

/* -- round 13, owner item 4: the two-row saved line ---------------- */

/**
 * Fit a path in its element by MIDDLE-ellipsizing it: the whole path
 * rides the title attribute (the hover/copy source of truth), the
 * visible text keeps the head and the tail (the file name survives —
 * the part a person reads). Binary search over code-point halves, so
 * surrogate pairs (a CJK directory name) never split.
 */
function fitMiddleEllipsis(el: HTMLElement, text: string): void {
  el.textContent = text;
  el.title = text;
  if (el.scrollWidth <= el.clientWidth) return;
  const chars = Array.from(text);
  let fitted = "…";
  let lo = 1;
  let hi = Math.floor(chars.length / 2);
  while (lo <= hi) {
    const half = (lo + hi) >> 1;
    const candidate = `${chars.slice(0, half).join("")}…${chars
      .slice(chars.length - half)
      .join("")}`;
    el.textContent = candidate;
    if (el.scrollWidth <= el.clientWidth) {
      fitted = candidate;
      lo = half + 1;
    } else {
      hi = half - 1;
    }
  }
  el.textContent = fitted;
}

function basename(path: string | undefined): string {
  if (path === undefined) return "未知文件";
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? path;
}

/**
 * One report source's display name (round 9, owner item 2): the picked
 * font's OWN name-table string (「Maple Mono NF CN」) whenever the
 * source maps onto a pick (its file basename matches, or its role names
 * the current pick); the serve's file basename otherwise.
 */
function sourceName(id: string | undefined, path: string | undefined): string {
  const { fonts, selected } = store.get();
  const byFile = fonts.find(
    (font) => font.path !== undefined && basename(font.path) === basename(path),
  );
  const roleKey =
    id === "base" ? selected.en : id === "donor-0" ? selected.cjk : null;
  const byRole =
    roleKey !== null ? fonts.find((f) => f.cssFamily === roleKey) : undefined;
  const font = byFile ?? byRole;
  if (font !== undefined) return variantDisplayName(font);
  return basename(path);
}

/**
 * One report section's ?-popover content (round 11, owner items 4–5):
 * the section title's explanation (`note`, the report-copy §2 glossary
 * sentence) plus EVERY sub-item the section renders, as a compact
 * worked table — the round-6 verbatim style, no essays. `legend` is
 * the notation table that leads the popover where the section's rows
 * carry notation: 「A → B」 / 「—」 for the metrics pairs, 「X ← Y」 for
 * the weight-slot borrows. Every explanation string is the glossary's
 * own sentence (report-copy §2), lightly prefaced for its row.
 */
interface SectionHelp {
  note: string;
  headers: readonly string[];
  rows: readonly (readonly string[])[];
  legend?: {
    headers: readonly string[];
    rows: readonly (readonly string[])[];
  };
}

const SECTION_HELP: Record<string, SectionHelp> = {
  report: {
    note: "合成完成后自动生成的核对结果。",
    headers: ["各部分", "是什么"],
    rows: [
      ["成品文件", "生成的字体文件、格式与校验值"],
      ["来源字体", "参与合并的英文与中文字体"],
      ["合并统计", "码位各来自哪款字体、各有多少"],
      ["规则优先级", "保留、补字、替换、重叠各多少"],
      ["覆盖检查", "要求覆盖、实际覆盖与缺失"],
      ["字体尺寸对比", "合并前后尺寸数值的变化"],
      ["字重档位", "每一档的字形由哪款字体提供"],
    ],
  },
  "built-font": {
    note: "本次合成生成的那份字体文件。",
    headers: ["项目", "是什么"],
    rows: [
      ["输出格式", "成品的文件格式，决定体积和用途"],
      ["SHA-256 校验值", "文件的数字指纹；改动一个字节，值就会变"],
    ],
  },
  "source-fonts": {
    note: "英文字体作合并容器，中文字体提供补充字形。",
    headers: ["项目", "是什么"],
    rows: [
      ["英文字体", "作为合并容器的字体；成品沿用它的字体名和行高"],
      ["中文字体", "提供补充字形的字体"],
      ["N 个码位", "这款字体在本次合并里提供的码位数量"],
    ],
  },
  merge: {
    note: "把多款字体里的字形按规则拼成一套新字体。",
    headers: ["项目", "是什么"],
    rows: [
      ["参与合并的码位", "本次合成逐一定过出处的码位总数"],
      ["英文字体提供", "沿用英文字体原本字形的码位数"],
      ["中文字体补充", "由中文字体补进来的码位数"],
      ["成品收录", "成品里真的收录了的码位数量"],
    ],
  },
  precedence: {
    note: "多条规则同时管到一个字时，谁的规则先算。",
    headers: ["项目", "是什么"],
    rows: [
      ["保留", "这个码位用英文字体原本的字形，不做改动"],
      ["补字", "英文字体没有这个字，用中文字体补上"],
      ["替换", "这个码位改用中文字体字形，通常是你指定的"],
      ["规则重叠", "两条同级规则管到同一批字，后写的那条生效"],
    ],
  },
  "coverage-check": {
    // Round 18 (owner item 2b): the 缺失 gloss gains the placeholder
    // rule — a font may DRAW something (a box, a boxed X) at a
    // codepoint it does not cover; those read as missing.
    note:
      "对照规则要求，逐项看哪些码位没做进去。" +
      "部分字体会在缺失的码位画出占位符（方框、叉号等）；这些码位按缺失计。",
    headers: ["项目", "是什么"],
    rows: [
      ["要求覆盖", "规则要求合并进来的码位数量"],
      ["实际覆盖", "成品里真的收录了的码位数量"],
      ["缺失", "要求覆盖、但成品里没有的码位"],
    ],
  },
  metrics: {
    note: "描述字体高矮、深浅、行距的一组数值。",
    // Round 13 (owner item 6): the notation legend explains the table's
    // two data COLUMNS once — the 「A → B」 pair form is gone with the
    // pair rows themselves; 无 stays, explained.
    legend: {
      headers: ["列", "意思"],
      rows: [
        ["合并前", "合并之前，英文字体自己的数值"],
        ["合并后", "合并之后，从成品文件读回的数值"],
        ["无", "该项在合并前没有数值"],
      ],
    },
    headers: ["项目", "是什么"],
    rows: [
      ["UPM", "字体坐标系的刻度，常用 1000 或 2048 格"],
      ["英文宽度", "英文字符占的宽度"],
      ["中文宽度", "中文字符占的宽度"],
      ["中英宽度比", "一个汉字宽度相当于几个英文字符，等宽标准是 2"],
      ["行高保持不变", "行高数值完全沿用英文字体，没有改写"],
    ],
  },
  "weight-slot": {
    note: "成品要生成的一套字重与样式，如“粗体·斜体”。",
    legend: {
      headers: ["写法", "意思"],
      rows: [
        ["常规 / 斜体", "这一档的样式：不倾斜 / 向右倾斜"],
        ["✓", "这一档的中文字形取自来源行写的字体"],
        ["无", "成品里没有这一档"],
      ],
    },
    headers: ["项目", "是什么"],
    rows: [
      ["字重编号", "字重的数字编号，400 是常规、700 是粗体"],
      ["自动取最近", "自动挑笔画粗细最接近的那一款"],
      ["指定字重", "按你指定的字重精确选取，不做近似"],
      ["锁定", "不看其他条件，固定用你锁定的那一款"],
    ],
  },
};

/**
 * The section heading's ?-anchor: title `X 是什么`, body the note plus
 * the compact sub-item tables (and the notation legend first, where the
 * section carries one). The popup carries `.build-help-pop` so it
 * stacks ABOVE this panel (the popups live on <body>, where the
 * panel's own z-index 880 would otherwise cover them).
 */
function helpAnchor(
  label: string,
  helpKey: string,
  helpAnchors: HelpPopover[],
): HTMLElement {
  const help = mountHelpPopover({
    id: helpKey,
    title: `${label}是什么`,
    buttonLabel: `${label}是什么`,
    width: 340,
    build: () => {
      const wrap = document.createElement("div");
      const def = SECTION_HELP[helpKey]!;
      wrap.append(helpNote(def.note));
      if (def.legend !== undefined) {
        wrap.append(workedTable(def.legend.headers, def.legend.rows));
      }
      wrap.append(workedTable(def.headers, def.rows));
      return wrap;
    },
  });
  help.popup.classList.add("build-help-pop");
  helpAnchors.push(help);
  return help.anchor;
}

/**
 * A section heading: the term plus its one ?-anchor, laid out as a flex
 * row with align-items: center so the circle sits optically centered
 * with the text (never on the inline baseline, which rides high).
 */
function sectionHeading(
  text: string,
  helpKey: string,
  helpAnchors: HelpPopover[],
): HTMLElement {
  const title = document.createElement("div");
  title.className = "report-section-title";
  const label = document.createElement("span");
  label.textContent = text;
  title.append(label, helpAnchor(text, helpKey, helpAnchors));
  return title;
}

/**
 * A labeled value line (no ? — the section heading carries the one).
 * The value is text, or a pre-built element (a text-plus-tags value
 * from `taggedValue`, round 17); every string call site renders
 * exactly as before.
 */
function fact(label: string, value: string | HTMLElement): HTMLDivElement {
  const line = document.createElement("div");
  line.className = "report-fact";
  const name = document.createElement("span");
  name.className = "report-fact-label";
  name.textContent = label;
  if (typeof value === "string") {
    const val = document.createElement("span");
    val.textContent = value;
    line.append(name, val);
  } else {
    line.append(name, value);
  }
  return line;
}

/**
 * Round 18 (owner item 2b): the dim line under a source's count when
 * the placeholder heuristic suspected some of its codepoints — they
 * never entered the count above, and the line says so. Right-aligned
 * so it sits under the count it qualifies, `--ink3` at the panel's
 * small size (the same dim register the stage notes use). A real
 * element with a stable data-role for tests.
 */
function placeholderNote(count: string): HTMLDivElement {
  const note = document.createElement("div");
  note.className = "report-fact-note";
  note.dataset.role = "report-placeholder-note";
  note.textContent = `疑似占位 ${count} 个码位，未计入覆盖`;
  return note;
}

/**
 * One report qualifier TAG (round 17, owner item 2): what used to ride
 * the value as bracket text — 「ttc（多字体合集）」 — renders as a small
 * badge chip BESIDE it (the owner: tags, not brackets). The idiom is
 * the picker's 未下载 chip (`kit-vchip`): tiny, muted border + fill on
 * theme tokens, no shadows, never wrapping mid-word. Decorative
 * qualifier of the adjacent text — a real span with a stable
 * data-role for tests, no aria-label of its own, and never nested
 * inside an ellipsizing text span (the nowrap chip must not clip).
 */
function reportTag(text: string): HTMLElement {
  const tag = document.createElement("span");
  tag.className = "report-tag";
  tag.dataset.role = "report-tag";
  tag.textContent = text;
  return tag;
}

/**
 * A fact value as plain text plus qualifier tags: the text rides its
 * own span (a shrinking or ellipsizing value could never clip a tag),
 * every qualifier a tag after it.
 */
function taggedValue(text: string, tags: readonly string[]): HTMLElement {
  const value = document.createElement("span");
  value.className = "report-fact-value";
  const label = document.createElement("span");
  label.className = "report-fact-value-text";
  label.textContent = text;
  value.append(label);
  for (const qualifier of tags) value.append(reportTag(qualifier));
  return value;
}

/** The output format's plain word (the qualifier rides a tag). */
function formatWord(format: string | undefined): string {
  switch (format) {
    case "ttc":
      return "ttc";
    case "woff2":
      return "woff2";
    case "ttf":
    default:
      return "ttf";
  }
}

/** The output format's plain-Chinese qualifier (report-copy §3.1). */
function formatQualifier(format: string | undefined): string {
  switch (format) {
    case "ttc":
      return "多字体合集";
    case "woff2":
      return "网页用";
    case "ttf":
    default:
      return "通用";
  }
}

/** The borrow row's via qualifier (report-copy §3.1). */
function viaLabel(via: string | undefined): string {
  switch (via) {
    case "nearest":
      return "自动取最近";
    case "override":
      return "指定字重";
    case "pinned":
      return "锁定";
    default:
      return via ?? "?";
  }
}

/**
 * The metrics comparison as a REAL table (round 13, owner item 6):
 * rows are the metrics, the two data columns 合并前 / 合并后 are
 * stated ONCE in a header row, values are column-aligned
 * (tabular-nums), the 「无」 placeholder stays for a value the machine
 * layer could not compute, and zero · separators appear anywhere in
 * the section — each row is three plain cells.
 */
function metricTable(
  rows: ReadonlyArray<readonly [string, string, string]>,
): HTMLTableElement {
  const table = document.createElement("table");
  table.className = "report-mtable";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  const corner = document.createElement("th");
  corner.scope = "col";
  corner.textContent = "指标";
  headRow.append(corner);
  for (const label of ["合并前", "合并后"]) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = label;
    headRow.append(th);
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  for (const [label, before, after] of rows) {
    const tr = document.createElement("tr");
    const name = document.createElement("th");
    name.scope = "row";
    name.textContent = label;
    tr.append(name);
    for (const value of [before, after]) {
      const td = document.createElement("td");
      td.textContent = value;
      if (value === NO_VALUE) td.classList.add("is-none");
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(head, body);
  return table;
}

/**
 * One weight-grid cell (round 17): plain cells stay plain strings — ✓ /
 * 「无」 / 「没用中文字体」 — while a differing slot's source line is its
 * family text plus the via qualifier as a TAG (the old 「family · via」
 * dot-join is gone, like the bracket forms above).
 */
type WeightCell = string | { text: string; tags: readonly string[] };

/**
 * The weight-slot grid (round 16, owner): one row per weight, one
 * column per style — 常规 / 斜体, the words Word's Chinese UI uses for
 * the style axis (直立 is retired). Same skeleton and .report-mtable
 * skin as the metrics table; a cell is ✓ (borrowed from the stated
 * source), a per-slot source label, 「没用中文字体」, or 「无」 (round
 * 12's no-value word — never a dash) when the build carries no such
 * slot.
 */
function weightTable(
  rows: ReadonlyArray<readonly [string, WeightCell, WeightCell]>,
): HTMLTableElement {
  const table = document.createElement("table");
  table.className = "report-mtable";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  const corner = document.createElement("th");
  corner.scope = "col";
  corner.textContent = "字重";
  headRow.append(corner);
  for (const label of ["常规", "斜体"]) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = label;
    headRow.append(th);
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  for (const [weight, upright, italic] of rows) {
    const tr = document.createElement("tr");
    const name = document.createElement("th");
    name.scope = "row";
    name.textContent = weight;
    tr.append(name);
    for (const value of [upright, italic]) {
      const td = document.createElement("td");
      if (typeof value === "string") {
        td.textContent = value;
        if (value === NO_VALUE) td.classList.add("is-none");
      } else {
        const text = document.createElement("span");
        text.className = "report-cell-text";
        text.textContent = value.text;
        td.append(text);
        for (const qualifier of value.tags) td.append(reportTag(qualifier));
      }
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(head, body);
  return table;
}

/**
 * Render the verification report — the machine JSON (schema v2),
 * structured. Every section degrades to omission when the schema lacks
 * it, so a report from an older or newer core still renders what it
 * carried. Labels follow report-copy §3.1 (the data binding is
 * unchanged — every label reads exactly the field the old one read).
 * The whole report sits behind a 查看报告 disclosure (a completed row
 * stays calm: the saved line first, the report on demand), and the raw
 * JSON form is GONE (round 10 — users cannot read it and rendering it
 * froze the app). Rendered ONCE per report object (see renderRow's
 * signature memo) so the poll never reflows it.
 */
function renderReport(
  container: HTMLElement,
  row: BuildRow,
  helpAnchors: HelpPopover[],
  onToggle: () => void,
): void {
  container.replaceChildren();
  const report = row.report;
  if (report === null) return;

  const details = document.createElement("details");
  details.className = "report-details";
  // Round 11 (panel sizing): the disclosure drives the panel's expanded
  // state — the panel grows to its ceiling only while a report is open.
  details.addEventListener("toggle", onToggle);

  const body = document.createElement("div");
  body.className = "report-body";

  const heading = document.createElement("div");
  heading.className = "report-heading";
  const headingLabel = document.createElement("span");
  headingLabel.textContent = "验证报告";
  heading.append(headingLabel, helpAnchor("验证报告", "report", helpAnchors));
  body.appendChild(heading);

  const output = document.createElement("div");
  output.className = "report-section";
  output.appendChild(sectionHeading("成品文件", "built-font", helpAnchors));
  // Round 17 (owner item 2): the format word plus its qualifier TAG —
  // 「ttc」 + 「多字体合集」, never 「ttc（多字体合集）」.
  output.append(
    fact(
      "输出格式",
      taggedValue(formatWord(report.output?.format), [
        formatQualifier(report.output?.format),
      ]),
    ),
  );
  if (report.output?.sha256) {
    output.append(fact("SHA-256 校验值", report.output.sha256.slice(0, 12)));
  }
  body.appendChild(output);

  if (report.sources && report.sources.length > 0) {
    const sources = document.createElement("div");
    sources.className = "report-section";
    sources.appendChild(sectionHeading("来源字体", "source-fonts", helpAnchors));
    // Round 11 (owner item 2): with exactly ONE donor the list drops
    // the role labels and numbering entirely — the rows read the fonts'
    // real names (the picker has exactly two slots; the names say which
    // is which). Numbered 中文字体 N labels exist only once a second
    // donor joins a report.
    const donorCount = report.sources.filter((source) =>
      (source.id ?? source.role ?? "").startsWith("donor"),
    ).length;
    const plainNames = donorCount === 1;
    let donorOrdinal = 0;
    for (const source of report.sources) {
      const id = source.id ?? source.role ?? "字体";
      const name = sourceName(id, source.path);
      const label = plainNames
        ? name
        : id === "base"
          ? "英文字体"
          : id.startsWith("donor")
            ? `中文字体 ${++donorOrdinal}`
            : id;
      sources.append(
        fact(
          label,
          plainNames
            ? `${fmt(source.codepoints)} 个码位`
            : `${name} · ${fmt(source.codepoints)} 个码位`,
        ),
      );
      // Round 18 (owner item 2b): a source that fakes coverage with a
      // placeholder glyph states it — one dim line under its count,
      // never inside it (the count is the honest kind already).
      if ((source.placeholder_codepoints ?? 0) > 0) {
        sources.append(
          placeholderNote(fmt(source.placeholder_codepoints ?? 0)),
        );
      }
    }
    body.appendChild(sources);
  }

  const summary = report.summary;
  if (summary !== undefined) {
    const section = document.createElement("div");
    section.className = "report-section";
    section.appendChild(sectionHeading("合并统计", "merge", helpAnchors));
    section.append(fact("参与合并的码位", fmt(summary.codepoints_total)));
    section.append(fact("英文字体提供", fmt(summary.from_base)));
    section.append(fact("中文字体补充", fmt(summary.from_donors)));
    section.append(fact("成品收录", fmt(summary.output_codepoints)));
    body.appendChild(section);
  }

  const counts = report.precedence?.counts;
  if (counts !== undefined) {
    const section = document.createElement("div");
    section.className = "report-section";
    section.appendChild(sectionHeading("规则优先级", "precedence", helpAnchors));
    section.append(fact("保留", fmt(counts.base)));
    section.append(fact("补字", fmt(counts.fill)));
    section.append(fact("替换", fmt(counts.override)));
    const conflicts = report.precedence?.same_layer_conflicts?.length ?? 0;
    section.append(fact("规则重叠", fmt(conflicts)));
    body.appendChild(section);
  }

  // v2's coverage scope: the effective table versus the built cmap –
  // the honest readback (a nonzero missing means the graft dropped
  // something it had resolved).
  const overall = report.coverage?.overall;
  if (overall !== undefined) {
    const section = document.createElement("div");
    section.className = "report-section";
    section.appendChild(sectionHeading("覆盖检查", "coverage-check", helpAnchors));
    section.append(fact("要求覆盖", fmt(overall.requested)));
    section.append(fact("实际覆盖", fmt(overall.covered)));
    section.append(fact("缺失", fmt(overall.missing_total)));
    body.appendChild(section);
  }

  // v2's before/after metrics, face 0 (the flat sections describe it).
  // Round 13 (owner item 6): the metrics render as a real TABLE — the
  // 合并前 / 合并后 columns stated once in the header, values
  // column-aligned, 「无」 for a value v2 could not compute, no ·
  // separators anywhere in the section.
  const face = report.metrics?.faces?.[0];
  if (face !== undefined) {
    const section = document.createElement("div");
    section.className = "report-section";
    section.appendChild(sectionHeading("字体尺寸对比", "metrics", helpAnchors));
    const metricRows: Array<[string, string, string]> = [];
    const pair = (label: string, p: { base?: number; output?: number } | undefined): void => {
      if (p?.base !== undefined || p?.output !== undefined) {
        metricRows.push([label, fmt(p?.base), fmt(p?.output)]);
      }
    };
    pair("UPM", face.upem);
    pair("英文宽度", face.latin_advance);
    pair("中文宽度", face.cjk_advance);
    // The ratio is the OUTPUT's (the machine layer computes no
    // before-ratio) — a Latin base has no CJK advance to ratio, so
    // 合并前 reads 「无」.
    if (face.grid_ratio !== undefined) {
      metricRows.push(["中英宽度比", NO_VALUE, fmt(face.grid_ratio)]);
    }
    if (metricRows.length > 0) section.appendChild(metricTable(metricRows));
    const untouched = face.line_height_untouched;
    if (untouched?.hhea || untouched?.typo) {
      section.append(fact("行高保持不变", "是：完全沿用英文字体"));
    }
    body.appendChild(section);
  }

  if (report.weights && report.weights.length > 0) {
    const section = document.createElement("div");
    section.className = "report-section";
    section.appendChild(sectionHeading("字重档位", "weight-slot", helpAnchors));
    // Round 16 (owner): the old per-slot list printed the weight twice
    // per slot and, with one donor, the same source line for all sixteen
    // slots. The grid states each weight once with one column per style;
    // the source is stated ONCE above when every slot borrows from the
    // same place, and only a differing slot carries its own source in
    // its cell (「没用中文字体」 for a slot the donor did not feed).
    // Round 17 (owner item 2): the via qualifier rides a TAG beside
    // the text — the uniform sentence's brackets and the per-cell
    // 「family · via」 dot-join are gone. The uniformity key stays a
    // plain string (dedup only, never rendered).
    const slotKey = (slot: (typeof report.weights)[number]): string =>
      (slot.borrows ?? [])
        .map((b) => `${b.family ?? b.donor ?? "?"}|${b.via ?? "?"}`)
        .join(";");
    const cellOf = (slot: (typeof report.weights)[number]): WeightCell => {
      const borrows = slot.borrows ?? [];
      if (borrows.length === 0) return "没用中文字体";
      return {
        text: borrows.map((b) => b.family ?? b.donor ?? "?").join("；"),
        tags: borrows.map((b) => viaLabel(b.via)),
      };
    };
    const slots = [...report.weights].sort(
      (a, b) => (a.weight ?? 0) - (b.weight ?? 0),
    );
    const fed = slots.filter((s) => (s.borrows ?? []).length > 0);
    const sources = new Set(fed.map(slotKey));
    const uniform = fed.length === slots.length && sources.size === 1;
    if (uniform) {
      const borrow = fed[0]!.borrows![0]!;
      section.append(
        fact(
          "中文字形来源",
          taggedValue(
            `${slots.length} 档全部取自 ${borrow.family ?? borrow.donor ?? "?"}`,
            [viaLabel(borrow.via)],
          ),
        ),
      );
    }
    const byWeight = new Map<number, { upright?: WeightCell; italic?: WeightCell }>();
    for (const slot of slots) {
      const row = byWeight.get(slot.weight ?? 0) ?? {};
      const cell: WeightCell =
        (slot.borrows ?? []).length === 0
          ? "没用中文字体"
          : uniform
            ? "✓"
            : cellOf(slot);
      row[slot.style === "italic" ? "italic" : "upright"] = cell;
      byWeight.set(slot.weight ?? 0, row);
    }
    section.append(
      weightTable(
        [...byWeight.entries()].map(([weight, cells]) => [
          fmt(weight),
          cells.upright ?? NO_VALUE,
          cells.italic ?? NO_VALUE,
        ]),
      ),
    );
    body.appendChild(section);
  }

  const summaryEl = document.createElement("summary");
  summaryEl.textContent = "查看报告";
  details.append(summaryEl, body);
  container.appendChild(details);
}

/**
 * Everything a row can render, collapsed into one comparable string —
 * the poll's 250 ms ticks produce new row objects with IDENTICAL
 * signatures, and identical signatures render NOTHING. The stage facts
 * serialize by CONTENT (a fresh facts object with the same numbers is
 * the same signature); the elapsed timer is excluded on purpose — it
 * updates directly, outside the render.
 */
function renderSignature(row: BuildRow): string {
  return [
    row.family,
    row.status,
    row.stage ?? "",
    JSON.stringify(row.stageFacts ?? null),
    row.queuePosition ?? "",
    row.error ?? "",
    row.savedPath ?? "",
    row.savedNotice ?? "",
    row.report === null ? "" : "report",
  ].join("|");
}

/** Render one build row's content in place (the row node survives). */
function renderRow(
  rowEl: HTMLElement,
  row: BuildRow,
  onReportToggle: () => void,
): void {
  const signature = renderSignature(row);
  if (rowEl.dataset.renderSignature === signature) return;
  rowEl.dataset.renderSignature = signature;
  rowEl.dataset.buildStatus = row.status;

  rowEl.querySelector<HTMLElement>(".build-family")!.textContent = row.family;

  const stageEl = rowEl.querySelector<HTMLElement>("[data-build-stage]")!;
  stageEl.textContent = statusText(row);
  stageEl.classList.toggle("is-done", row.status === "saved" || row.status === "done");
  stageEl.classList.toggle(
    "is-failed",
    row.status === "failed" || row.status === "error",
  );

  // The stepper (round 6): upcoming faint / current active / done
  // lit-solid. A settled build lights every step — never all-gray at
  // save; a failed one keeps the completed steps lit and turns the
  // failing step danger.
  //
  // Round 12 (owner item 2): the artifact handoff (status "saving")
  // rides the 保存输出 stage — segments already done STAY lit through
  // the save (the handoff lasts exactly as long as a user might keep
  // a dialog open) and only that segment pulses. The old code indexed
  // the row's raw `stage` field, which the serve leaves at "done"
  // after its final poll — `order.indexOf("done") === -1`, so every
  // segment dropped BOTH classes and the whole stepper went faint
  // exactly while the dialog stood open, refilling only after the
  // save settled. Not focus loss, not a re-render: the stage index
  // fell out of the stepper's vocabulary.
  const steps = rowEl.querySelector<HTMLElement>(".build-steps")!;
  const order = STAGES.map(([key]) => key);
  const handoff = row.status === "saving";
  const stageKey = handoff ? "saving" : (row.stage ?? "");
  const current = row.status === "queued" ? -1 : order.indexOf(stageKey);
  const settled = row.status === "saved" || row.status === "done";
  const failed = row.status === "failed" || row.status === "error";
  const active = row.status === "running" || handoff;
  const dots = steps.querySelectorAll<HTMLElement>(".build-step");
  dots.forEach((dot, index) => {
    const passed = settled || (current >= 0 && index < current);
    const isCurrent =
      !settled && !failed && current >= 0 && index === current && active;
    const isFailing = failed && (current < 0 || index === current);
    dot.classList.toggle("is-passed", passed);
    dot.classList.toggle("is-current", isCurrent);
    dot.classList.toggle("is-failed", isFailing);
  });

  // The TWO lines under the stepper (round 12, owner item 1): the
  // stage name on the first line, the dim note on the line under it —
  // never one dash-joined line. The queue position while queued, the
  // saver note while saving — hidden once the row settles (the saved
  // line / error box own those states).
  //
  // Round 13 (owner item 5): the LIVE column sits right-aligned
  // opposite those two lines — the elapsed timer (mm:ss, ticking while
  // queued/running) plus up to two stage facts the serve's payload
  // carries. The artifact handoff (saving) shows no live column: the
  // handoff is not pipeline time, and the row's own saver note
  // narrates it. The whole block reserves three lines from the row's
  // first paint, so differing fact counts never move the rows
  // underneath (the reserved-height discipline, extended).
  const stageLine = rowEl.querySelector<HTMLElement>("[data-build-stage-line]")!;
  const stageName = rowEl.querySelector<HTMLElement>(
    "[data-build-stage-name]",
  )!;
  const stageNote = rowEl.querySelector<HTMLElement>(
    "[data-build-stage-note]",
  )!;
  const liveEl = rowEl.querySelector<HTMLElement>("[data-build-stage-live]")!;
  const elapsedEl = rowEl.querySelector<HTMLElement>(
    "[data-build-elapsed]",
  )!;
  const factEls = rowEl.querySelectorAll<HTMLElement>("[data-build-fact]");
  const parts = stageLineParts(row);
  if (stageName.textContent !== parts.name) stageName.textContent = parts.name;
  if (stageNote.textContent !== parts.note) stageNote.textContent = parts.note;
  stageNote.hidden = parts.note === "";
  stageLine.hidden = parts.name === "" && parts.note === "";
  const timing = row.status === "queued" || row.status === "running";
  liveEl.hidden = !timing;
  elapsedEl.hidden = !timing;
  if (timing) {
    elapsedEl.dataset.elapsedFrom = row.submittedAt;
    const label = elapsedLabel(row.submittedAt);
    if (label !== null && elapsedEl.textContent !== label) {
      elapsedEl.textContent = label;
    }
  }
  const factLines = timing
    ? stageFactLines(row.status === "running" ? row.stage : null, row.stageFacts)
    : [];
  factEls.forEach((el, index) => {
    const line = factLines[index];
    el.hidden = line === undefined;
    if (line !== undefined && el.textContent !== line) el.textContent = line;
  });

  const errorEl = rowEl.querySelector<HTMLElement>("[data-build-error]")!;
  errorEl.hidden = row.error === null;
  errorEl.textContent = row.error ?? "";

  // The saved line (round 12; round 13, owner item 4): TWO rows — the
  // 「已保存」 label on the first (the 另存为 affordance at its right),
  // the FULL path on the row under it, middle-ellipsized when it
  // overflows with the whole path in the title attribute (a default
  // directory only the app knows about would be a path nobody can
  // find). Since round 17 the block also renders for a settled row
  // whose artifact never reached the disk (the same-name collision
  // prompt was dismissed): the label honestly says 「未保存」 with no
  // path line, and the 另存为 button stays reachable — the dialog is
  // that row's recovery path, so a dismissed question never strands
  // the built font.
  const savedEl = rowEl.querySelector<HTMLElement>("[data-build-saved]")!;
  savedEl.hidden = row.savedPath === null && row.status !== "done";
  const savedLabelEl = rowEl.querySelector<HTMLElement>(
    "[data-build-saved-label]",
  )!;
  // The label word is WRITTEN, not templated: the DOM of a running row
  // must not carry 「已保存」 at all (hidden text still matches text
  // locators — a waiting test would read a running build as saved).
  const labelWord = row.savedPath !== null ? "已保存" : "未保存";
  if (savedLabelEl.textContent !== labelWord) {
    savedLabelEl.textContent = labelWord;
  }
  const savedPathEl = rowEl.querySelector<HTMLElement>(
    "[data-build-saved-path]",
  )!;
  savedPathEl.hidden = row.savedPath === null;
  if (row.savedPath !== null) {
    if (savedPathEl.title !== row.savedPath) fitMiddleEllipsis(savedPathEl, row.savedPath);
  }
  const saveAsEl = rowEl.querySelector<HTMLButtonElement>(
    "[data-build-saveas]",
  )!;
  saveAsEl.hidden =
    (row.savedPath === null && row.status !== "done") || handoff;

  // The plain notice beside the saved line (round 12): the 另存为
  // fallback to the default directory explains itself here, never as
  // a modal or a toast the user can miss only by luck.
  const noticeEl = rowEl.querySelector<HTMLElement>("[data-build-notice]")!;
  noticeEl.hidden = row.savedNotice === null;
  if (row.savedNotice !== null && noticeEl.textContent !== row.savedNotice) {
    noticeEl.textContent = row.savedNotice;
  }

  // The report renders ONCE per report object: the report REFERENCE is
  // set exactly once when the fetch lands — identity memoization means
  // the report (and its ?-popover anchors) builds once.
  const reportEl = rowEl.querySelector<HTMLElement>("[data-build-report]")!;
  reportEl.hidden = row.report === null;
  const rendered = renderedReports.get(rowEl);
  if (rendered !== row.report) {
    const previous = reportAnchors.get(rowEl);
    if (previous) {
      for (const help of previous) help.popup.remove();
      reportAnchors.delete(rowEl);
    }
    const anchors: HelpPopover[] = [];
    renderReport(reportEl, row, anchors, onReportToggle);
    reportAnchors.set(rowEl, anchors);
    renderedReports.set(rowEl, row.report);
  }
}

/** The report each row element last rendered (identity memo). */
const renderedReports = new WeakMap<HTMLElement, unknown>();

/** The live ?-popovers of each row's rendered report (teardown on re-render). */
const reportAnchors = new WeakMap<HTMLElement, HelpPopover[]>();

export function mountBuildPanel(): void {
  const panel = document.createElement("section");
  panel.className = "build-panel";
  panel.dataset.testid = "build-panel";
  panel.setAttribute("aria-label", "合成任务");
  panel.hidden = true;
  panel.innerHTML = `
    <div class="build-panel-title">合成任务<button class="build-close" aria-label="关闭面板" type="button">${icon("close")}</button></div>
    <div class="build-rows" role="status" aria-live="polite"></div>
  `;
  document.body.appendChild(panel);
  // Round 7: the panel head carries the brand mark (logo adoption).
  panel.querySelector(".build-panel-title")!.prepend(brandMark(18));

  const rowsEl = panel.querySelector<HTMLElement>(".build-rows")!;

  // Round 13 (owner item 5): the elapsed ticker. One interval for the
  // whole panel walks the live elapsed cells (their start timestamp
  // rides data-elapsed-from) and rewrites the mm:ss text directly —
  // never through a re-render, so nothing else in a row can move.
  // Under prefers-reduced-motion there is NO ticking: the interval
  // stands down and the elapsed value still refreshes on every real
  // state change (the render writes it too).
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  window.setInterval(() => {
    if (reducedMotion.matches) return;
    for (const el of rowsEl.querySelectorAll<HTMLElement>("[data-build-elapsed]")) {
      if (el.hidden) continue;
      const from = el.dataset.elapsedFrom;
      if (from === undefined) continue;
      const label = elapsedLabel(from);
      if (label !== null && el.textContent !== label) el.textContent = label;
    }
  }, 1000);

  // Round 11 (panel sizing): the panel is content-sized (compact) while
  // calm and takes its full ceiling ONLY while a report disclosure is
  // open. The class flips on the details' toggle events and after every
  // store render (a dismissed row may have been the open one).
  const syncPanelSize = (): void => {
    const reportOpen =
      rowsEl.querySelector("details.report-details[open]") !== null;
    panel.classList.toggle("is-report-open", reportOpen);
  };

  // Round 11 (owner item 6): the panel's own close × — the kit close
  // glyph with the toast ×'s treatment. It clears every row any time
  // (running builds included: the serve exposes no abort endpoint, so
  // closing means the UI stops tracking them) and hides the panel; the
  // next synthesize re-opens it fresh.
  panel
    .querySelector<HTMLButtonElement>(".build-close")!
    .addEventListener("click", () => {
      for (const row of [...synthStore.get().builds]) removeBuild(row.id);
    });

  const buildRowEl = (): HTMLElement => {
    const row = document.createElement("article");
    row.className = "build-row enter";
    row.dataset.buildRow = "";
    row.innerHTML = `
      <div class="build-row-head">
        <span class="build-family"></span>
        <span class="build-stage" data-build-stage></span>
        <button class="build-dismiss" aria-label="关闭这条记录" type="button">×</button>
      </div>
      <div class="build-steps">
        ${STAGES.map(([, label]) => `<span class="build-step" title="${label}"></span>`).join("")}
      </div>
      <div class="build-stage-line" data-build-stage-line>
        <div class="build-stage-row">
          <span class="build-stage-name" data-build-stage-name></span>
          <div class="build-stage-live" data-build-stage-live hidden>
          <span class="build-stage-elapsed" data-build-elapsed hidden></span>
          <span class="build-stage-fact" data-build-fact="0" hidden></span>
          <span class="build-stage-fact" data-build-fact="1" hidden></span>
          </div>
        </div>
        <span class="build-stage-note" data-build-stage-note></span>
      </div>
      <div class="build-error" data-build-error role="alert" hidden></div>
      <div class="build-saved" data-build-saved hidden>
        <div class="build-saved-head">
          <span class="build-saved-label" data-build-saved-label></span>
          <button class="build-saveas" data-build-saveas type="button" hidden>另存为</button>
        </div>
        <span class="build-saved-path" data-build-saved-path></span>
      </div>
      <div class="build-notice" data-build-notice role="status" hidden></div>
      <div class="build-report" data-build-report hidden></div>
    `;
    // The entrance animation plays ONCE: once it ends the class drops,
    // so no later DOM move can ever restart it (the round-10 flicker
    // class — a re-parented node replays its animations).
    row.addEventListener(
      "animationend",
      () => row.classList.remove("enter"),
      { once: true },
    );
    row
      .querySelector<HTMLButtonElement>(".build-dismiss")!
      .addEventListener("click", () => {
        removeBuild(row.dataset.buildId ?? "");
      });
    // 另存为 (round 12, owner item 3): the explicit export on the
    // completed row — the native dialog when it can open, the default
    // directory with a plain notice when it cannot (saveBuildAs owns
    // that fallback; this wiring only fires it).
    row
      .querySelector<HTMLButtonElement>("[data-build-saveas]")!
      .addEventListener("click", () => {
        void saveBuildAs(row.dataset.buildId ?? "");
      });
    return row;
  };

  const render = (): void => {
    const { builds } = synthStore.get();
    panel.hidden = builds.length === 0;

    // Rows are keyed by build id and updated IN PLACE. Builds append
    // and dismissals filter, so DOM order tracks data order without
    // ever rebuilding the list (the old per-tick replaceChildren
    // re-parented every row each poll, restarting animations — the
    // "keeps refreshing" flicker).
    const byId = new Map<string, HTMLElement>();
    for (const el of [...rowsEl.children]) {
      const id = (el as HTMLElement).dataset.buildId;
      if (id) byId.set(id, el as HTMLElement);
    }

    // The submit flow swaps a row's local placeholder id for the
    // service id IN POSITION; adopt the orphaned node instead of
    // destroying it (a rebuild would replay the entrance animation).
    const orphans: HTMLElement[] = [];
    const liveIds = new Set(builds.map((row) => row.id));
    for (const [id, el] of byId) {
      if (liveIds.has(id)) continue;
      byId.delete(id);
      orphans.push(el);
    }
    let adopt = 0;
    for (const row of builds) {
      if (byId.has(row.id)) continue;
      const el = orphans[adopt++];
      if (!el) break;
      el.dataset.buildId = row.id;
      byId.set(row.id, el);
    }
    // Whatever no build claimed was dismissed: drop it and its
    // body-mounted report popovers.
    for (; adopt < orphans.length; adopt++) {
      const el = orphans[adopt];
      for (const help of reportAnchors.get(el) ?? []) help.popup.remove();
      reportAnchors.delete(el);
      renderedReports.delete(el);
      el.remove();
    }

    for (const row of builds) {
      let el = byId.get(row.id);
      if (!el) {
        el = buildRowEl();
        el.dataset.buildId = row.id;
        byId.set(row.id, el);
        rowsEl.appendChild(el);
      }
      renderRow(el, row, syncPanelSize);
    }
    // A dismissed row may have been the one holding the open report —
    // re-sync the expanded state after every store render.
    syncPanelSize();
  };

  synthStore.subscribe(render);
  render();
}
