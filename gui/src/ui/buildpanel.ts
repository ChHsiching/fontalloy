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
 *   lives where it applies: 「A → B」 and 「—」 in the metrics
 *   popover, 「X ← Y」 in the weight-slot one.
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
  ["grafting", "移植字形", "把中文字形缩放到英文字体尺寸后搬进成品，并重建码位对照表。"],
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
 * The ONE line under the stepper (round 10): the current stage term
 * with its ≤30-char note, the queue position while queued, the saver
 * note while the artifact hands off — and nothing once the row has
 * settled (the saved line / error box own those states).
 */
function stageLineText(row: BuildRow): string {
  switch (row.status) {
    case "queued":
      return row.queuePosition !== null && row.queuePosition > 1
        ? `排队中（第 ${row.queuePosition} 位）`
        : "排队中";
    case "running":
      if (row.stage === null) return "正在合成";
      const note = stageNote(row.stage);
      return note === null
        ? stageLabel(row.stage)
        : `${stageLabel(row.stage)} — ${note}`;
    case "saving":
      return "正在保存 — 把成品字体写入磁盘。";
    default:
      return "";
  }
}

/** Number rendering; null/missing fields render as an em dash (v2
 *  omits or nulls metric fields it could not compute). */
function fmt(value: number | null | undefined): string {
  return typeof value === "number" ? value.toLocaleString("en-US") : "—";
}

function basename(path: string | undefined): string {
  if (path === undefined) return "—";
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
    note: "对照规则要求，逐项看哪些码位没做进去。",
    headers: ["项目", "是什么"],
    rows: [
      ["要求覆盖", "规则要求合并进来的码位数量"],
      ["实际覆盖", "成品里真的收录了的码位数量"],
      ["缺失", "要求覆盖、但成品里没有的码位"],
    ],
  },
  metrics: {
    note: "描述字体高矮、深浅、行距的一组数值。",
    legend: {
      headers: ["写法", "意思"],
      rows: [
        ["A → B", "合并前的值 → 合并后的值"],
        ["—", "该项原本没有值"],
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
        ["X ← Y", "借用来源：Y 这款字体提供了这一档"],
        ["直立 / 斜体", "这一档的样式：不倾斜 / 向右倾斜"],
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

/** A labeled value line (no ? — the section heading carries the one). */
function fact(label: string, value: string): HTMLDivElement {
  const line = document.createElement("div");
  line.className = "report-fact";
  const name = document.createElement("span");
  name.className = "report-fact-label";
  name.textContent = label;
  const val = document.createElement("span");
  val.textContent = value;
  line.append(name, val);
  return line;
}

/** The output-format label with its plain-Chinese qualifier. */
function formatLabel(format: string | undefined): string {
  switch (format) {
    case "ttc":
      return "ttc（多字体合集）";
    case "woff2":
      return "woff2（网页用）";
    case "ttf":
    default:
      return "ttf（通用）";
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
  output.append(fact("输出格式", formatLabel(report.output?.format)));
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
  const face = report.metrics?.faces?.[0];
  if (face !== undefined) {
    const section = document.createElement("div");
    section.className = "report-section";
    section.appendChild(sectionHeading("字体尺寸对比", "metrics", helpAnchors));
    const pair = (
      label: string,
      p: { base?: number; output?: number } | undefined,
    ): void => {
      if (p?.base !== undefined || p?.output !== undefined) {
        section.append(fact(label, `${fmt(p?.base)} → ${fmt(p?.output)}`));
      }
    };
    pair("UPM", face.upem);
    pair("英文宽度", face.latin_advance);
    pair("中文宽度", face.cjk_advance);
    if (face.grid_ratio !== undefined) {
      section.append(fact("中英宽度比", fmt(face.grid_ratio)));
    }
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
    for (const slot of report.weights) {
      const borrows = (slot.borrows ?? [])
        .map(
          (borrow) =>
            `${borrow.family ?? borrow.donor ?? "?"} ← ${fmt(borrow.weight)}（${viaLabel(borrow.via)}）`,
        )
        .join("；");
      section.append(
        fact(
          `${fmt(slot.weight)} · ${slot.style === "italic" ? "斜体" : "直立"}`,
          borrows || "这一档没有用中文字体",
        ),
      );
    }
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
 * signatures, and identical signatures render NOTHING.
 */
function renderSignature(row: BuildRow): string {
  return [
    row.family,
    row.status,
    row.stage ?? "",
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

  // The ONE line under the stepper: current stage + note, queue
  // position while queued, the saver note while saving — hidden once
  // the row settles (the saved line / error box own those states).
  const stageLine = rowEl.querySelector<HTMLElement>("[data-build-stage-line]")!;
  const line = stageLineText(row);
  if (stageLine.textContent !== line) stageLine.textContent = line;
  stageLine.hidden = line === "";

  const errorEl = rowEl.querySelector<HTMLElement>("[data-build-error]")!;
  errorEl.hidden = row.error === null;
  errorEl.textContent = row.error ?? "";

  // The saved line (round 12): the FULL path as page text (a default
  // directory only the app knows about would be a path nobody can
  // find), with the 另存为 affordance on the completed row — visible
  // whenever the artifact is on disk and no handoff is in flight (the
  // row's own state narrates an in-flight one).
  const savedEl = rowEl.querySelector<HTMLElement>("[data-build-saved]")!;
  savedEl.hidden = row.savedPath === null;
  const savedPathEl = rowEl.querySelector<HTMLElement>(
    "[data-build-saved-path]",
  )!;
  if (row.savedPath !== null) {
    const line = `已保存：${row.savedPath}`;
    if (savedPathEl.textContent !== line) savedPathEl.textContent = line;
  }
  const saveAsEl = rowEl.querySelector<HTMLButtonElement>(
    "[data-build-saveas]",
  )!;
  saveAsEl.hidden = row.savedPath === null || handoff;

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
      <div class="build-stage-line" data-build-stage-line></div>
      <div class="build-error" data-build-error role="alert" hidden></div>
      <div class="build-saved" data-build-saved hidden>
        <span class="build-saved-path" data-build-saved-path></span>
        <button class="build-saveas" data-build-saveas type="button" hidden>另存为</button>
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
