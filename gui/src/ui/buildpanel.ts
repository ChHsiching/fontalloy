/**
 * The build panel (issue #16): synthesis progress, results, and the
 * verification report — as a fixed, non-modal panel above the stats
 * bar. The workspace underneath stays fully interactive while builds
 * run (queueing more, browsing, editing); failures and reports are
 * inline page text, never hover-only, never modal.
 *
 * The panel subscribes to the synthesis store and re-renders row
 * content in place — the panel node itself is created once (the same
 * node-survival invariant every popup follows).
 *
 * Round 6:
 *
 * - **Stable layout** — the report region renders ONCE per report
 *   object (the 250 ms poll used to rebuild it every tick: text
 *   reflowed, the open 完整原始报告 details collapsed, the scrollbars
 *   toggled — the flicker/oscillation). The scroll regions reserve
 *   their gutter (`scrollbar-gutter: stable`), so content width never
 *   changes when a bar appears.
 * - **Stepper state model** — upcoming faint / current active / done
 *   lit-solid; a settled build lights every step (never all-gray at
 *   save), a failed build keeps the completed steps lit and turns the
 *   failing one danger.
 * - **Wording** — every stage name, status, and report label follows
 *   the owner-ratified copy spec (`fontalloy-notes/report-copy.md`):
 *   real words only, and every noun carries a ?-popover
 *   (`gui/src/kit/helpPopover.ts`, title `X 是什么`).
 */

import { synthStore, removeBuild, type BuildRow } from "../service/state";
import { mountHelpPopover, type HelpPopover } from "../kit/helpPopover";
import { brandMark } from "../kit/topBar";

/**
 * The pipeline stages (report-copy §1): the key drives the serve's
 * stage string, the label is the 阶段名, and the note is the ≤30-char
 * line shown while the stage is current.
 */
const STAGES: ReadonlyArray<readonly [string, string, string]> = [
  ["loading", "读取字体", "打开基底与供体字体，读取字重、样式和字符范围。"],
  ["planning", "规划字重", "确定成品要生成哪些字重与样式，每个档位用哪款字体出字。"],
  ["resolving", "解析规则", "把规则展开成一张对照表：每个码位最终由哪款字体提供。"],
  ["grafting", "移植字形", "把供体字形缩放到基底尺寸后搬进成品，并重建码位对照表。"],
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

/** What the row's status line says for the row's current state. */
function statusText(row: BuildRow): string {
  switch (row.status) {
    case "queued":
      return row.queuePosition !== null && row.queuePosition > 1
        ? `排队中（第 ${row.queuePosition} 位）`
        : "排队中";
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
 * The report glossary (report-copy §2, verbatim bodies): one entry per
 * noun the report shows; the `?` anchors follow the kit's HelpPopover.
 */
const GLOSSARY: Record<string, string> = {
  report: "合成完成后自动生成的核对结果。",
  "output-format": "成品的文件格式，决定体积和用途。",
  sha256: "文件的数字指纹；改动一个字节，值就会变。",
  "base-font": "作为合并容器的字体；成品沿用它的字体名和行高。",
  "donor-font": "提供补充字形的字体。",
  "built-font": "本次合成生成的那份字体文件。",
  merge: "把多款字体里的字形按规则拼成一套新字体。",
  codepoint: "字符在 Unicode 里的编号，如“中”是 U+4E2D。",
  precedence: "多条规则同时管到一个字时，谁的规则先算。",
  "kind-base": "这个码位用基底字体原本的字形，不做改动。",
  "kind-fill": "基底字体没有这个字，用供体字形补上。",
  "kind-override": "这个码位改用供体字形，通常是你指定的。",
  "rule-overlap": "两条同级规则管到同一批字，后写的那条生效。",
  "coverage-check": "对照规则要求，逐项看哪些码位没做进去。",
  requested: "规则要求合并进来的码位数量。",
  covered: "成品里真的收录了的码位数量。",
  missing: "要求覆盖、但成品里没有的码位。",
  metrics: "描述字体高矮、深浅、行距的一组数值。",
  upem: "字体坐标系的刻度，常用 1000 或 2048 格。",
  "advance-width": "一个字符占的宽度：排字时光标向右移动的距离。",
  "grid-ratio": "一个汉字宽度相当于几个英文字符，等宽标准是 2。",
  "line-height": "两行文字基线之间的距离。",
  "weight-slot": "成品要生成的一套字重与样式，如“粗体·斜体”。",
  "weight-number": "字重的数字编号，400 是常规、700 是粗体。",
  italic: "字形向右倾斜的样式。",
  upright: "不倾斜的常规形态，与斜体相对。",
  borrow: "这一档的字形来自哪款字体、哪个字重。",
  "via-nearest": "自动挑笔画粗细最接近的那一款。",
  "via-override": "按你指定的字重精确选取，不做近似。",
  "via-pinned": "不看其他条件，固定用你锁定的那一款。",
  "raw-report": "给程序看的完整数据，出问题时供排查。",
};

/**
 * A labeled value line; with a glossary key it carries the ?-popover
 * anchor (title `X 是什么`, body the glossary entry).
 */
function fact(
  label: string,
  value: string,
  helpKey?: string,
  helpAnchors: HelpPopover[] = [],
): HTMLDivElement {
  const line = document.createElement("div");
  line.className = "report-fact";
  const name = document.createElement("span");
  name.className = "report-fact-label";
  name.textContent = label;
  if (helpKey && GLOSSARY[helpKey]) {
    const help = mountHelpPopover({
      id: helpKey,
      title: `${label}是什么`,
      buttonLabel: `${label}是什么`,
      build: () => {
        const p = document.createElement("p");
        p.className = "kit-sub";
        p.textContent = GLOSSARY[helpKey]!;
        return p;
      },
    });
    name.append(" ", help.anchor);
    helpAnchors.push(help);
  }
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
 * unchanged — every new label reads exactly the field the old one
 * read); every noun carries its ?-popover. Rendered ONCE per report
 * object (see the renderRow memo) so the poll never reflows it.
 */
function renderReport(
  container: HTMLElement,
  row: BuildRow,
  helpAnchors: HelpPopover[],
): void {
  container.replaceChildren();
  const report = row.report;
  if (report === null) return;

  const heading = document.createElement("div");
  heading.className = "report-heading";
  heading.textContent = "验证报告";
  const headingHelp = mountHelpPopover({
    id: "report",
    title: "验证报告是什么",
    buttonLabel: "验证报告是什么",
    build: () => {
      const p = document.createElement("p");
      p.className = "kit-sub";
      p.textContent = GLOSSARY["report"]!;
      return p;
    },
  });
  heading.append(" ", headingHelp.anchor);
  helpAnchors.push(headingHelp);
  container.appendChild(heading);

  const output = document.createElement("div");
  output.className = "report-section";
  output.append(fact("输出格式", formatLabel(report.output?.format), "output-format", helpAnchors));
  if (report.output?.sha256) {
    output.append(
      fact("SHA-256 校验值", report.output.sha256.slice(0, 12), "sha256", helpAnchors),
    );
  }
  container.appendChild(output);

  if (report.sources && report.sources.length > 0) {
    const sources = document.createElement("div");
    sources.className = "report-section";
    const title = document.createElement("div");
    title.className = "report-section-title";
    title.textContent = "来源字体";
    sources.appendChild(title);
    for (const source of report.sources) {
      const id = source.id ?? source.role ?? "字体";
      const label =
        id === "base" ? "基底" : id.startsWith("donor") ? `供体 ${Number(id.slice("donor-".length)) + 1}` : id;
      const key = id === "base" ? "base-font" : id.startsWith("donor") ? "donor-font" : undefined;
      sources.append(
        fact(
          label,
          `${basename(source.path)} · ${fmt(source.codepoints)} 个码位`,
          key,
          helpAnchors,
        ),
      );
    }
    container.appendChild(sources);
  }

  const summary = report.summary;
  if (summary !== undefined) {
    const section = document.createElement("div");
    section.className = "report-section";
    const title = document.createElement("div");
    title.className = "report-section-title";
    title.textContent = "合并统计";
    const titleHelp = mountHelpPopover({
      id: "merge",
      title: "合并统计是什么",
      buttonLabel: "合并统计是什么",
      build: () => {
        const p = document.createElement("p");
        p.className = "kit-sub";
        p.textContent = GLOSSARY.merge!;
        return p;
      },
    });
    title.append(" ", titleHelp.anchor);
    helpAnchors.push(titleHelp);
    section.appendChild(title);
    section.append(fact("参与合并的码位", fmt(summary.codepoints_total), "codepoint", helpAnchors));
    section.append(fact("基底提供", fmt(summary.from_base), "base-font", helpAnchors));
    section.append(fact("供体补充", fmt(summary.from_donors), "donor-font", helpAnchors));
    section.append(fact("成品收录", fmt(summary.output_codepoints), "built-font", helpAnchors));
    container.appendChild(section);
  }

  const counts = report.precedence?.counts;
  if (counts !== undefined) {
    const section = document.createElement("div");
    section.className = "report-section";
    const title = document.createElement("div");
    title.className = "report-section-title";
    title.textContent = "规则优先级";
    const titleHelp = mountHelpPopover({
      id: "precedence",
      title: "规则优先级是什么",
      buttonLabel: "规则优先级是什么",
      build: () => {
        const p = document.createElement("p");
        p.className = "kit-sub";
        p.textContent = GLOSSARY.precedence!;
        return p;
      },
    });
    title.append(" ", titleHelp.anchor);
    helpAnchors.push(titleHelp);
    section.appendChild(title);
    section.append(fact("保留基字形", fmt(counts.base), "kind-base", helpAnchors));
    section.append(fact("补字", fmt(counts.fill), "kind-fill", helpAnchors));
    section.append(fact("替换字形", fmt(counts.override), "kind-override", helpAnchors));
    const conflicts = report.precedence?.same_layer_conflicts?.length ?? 0;
    section.append(fact("规则重叠", fmt(conflicts), "rule-overlap", helpAnchors));
    container.appendChild(section);
  }

  // v2's coverage scope: the effective table versus the built cmap —
  // the honest readback (a nonzero missing means the graft dropped
  // something it had resolved).
  const overall = report.coverage?.overall;
  if (overall !== undefined) {
    const section = document.createElement("div");
    section.className = "report-section";
    const title = document.createElement("div");
    title.className = "report-section-title";
    title.textContent = "覆盖检查";
    const titleHelp = mountHelpPopover({
      id: "coverage-check",
      title: "覆盖检查是什么",
      buttonLabel: "覆盖检查是什么",
      build: () => {
        const p = document.createElement("p");
        p.className = "kit-sub";
        p.textContent = GLOSSARY["coverage-check"]!;
        return p;
      },
    });
    title.append(" ", titleHelp.anchor);
    helpAnchors.push(titleHelp);
    section.appendChild(title);
    section.append(fact("要求覆盖", fmt(overall.requested), "requested", helpAnchors));
    section.append(fact("实际覆盖", fmt(overall.covered), "covered", helpAnchors));
    section.append(fact("缺失", fmt(overall.missing_total), "missing", helpAnchors));
    container.appendChild(section);
  }

  // v2's before/after metrics, face 0 (the flat sections describe it).
  const face = report.metrics?.faces?.[0];
  if (face !== undefined) {
    const section = document.createElement("div");
    section.className = "report-section";
    const title = document.createElement("div");
    title.className = "report-section-title";
    title.textContent = "字体尺寸对比";
    const titleHelp = mountHelpPopover({
      id: "metrics",
      title: "字体尺寸对比是什么",
      buttonLabel: "字体尺寸对比是什么",
      build: () => {
        const p = document.createElement("p");
        p.className = "kit-sub";
        p.textContent = GLOSSARY.metrics!;
        return p;
      },
    });
    title.append(" ", titleHelp.anchor);
    helpAnchors.push(titleHelp);
    section.appendChild(title);
    const pair = (
      label: string,
      key: string | undefined,
      p: { base?: number; output?: number } | undefined,
    ): void => {
      if (p?.base !== undefined || p?.output !== undefined) {
        section.append(fact(label, `${fmt(p?.base)} → ${fmt(p?.output)}`, key, helpAnchors));
      }
    };
    pair("UPM", "upem", face.upem);
    pair("英文宽度", "advance-width", face.latin_advance);
    pair("中文宽度", "advance-width", face.cjk_advance);
    if (face.grid_ratio !== undefined) {
      section.append(fact("中英宽度比", fmt(face.grid_ratio), "grid-ratio", helpAnchors));
    }
    const untouched = face.line_height_untouched;
    if (untouched?.hhea || untouched?.typo) {
      section.append(
        fact("行高保持不变", "是：完全沿用基底字体", "line-height", helpAnchors),
      );
    }
    container.appendChild(section);
  }

  if (report.weights && report.weights.length > 0) {
    const section = document.createElement("div");
    section.className = "report-section";
    const title = document.createElement("div");
    title.className = "report-section-title";
    title.textContent = "字重档位";
    const titleHelp = mountHelpPopover({
      id: "weight-slot",
      title: "字重档位是什么",
      buttonLabel: "字重档位是什么",
      build: () => {
        const p = document.createElement("p");
        p.className = "kit-sub";
        p.textContent = GLOSSARY["weight-slot"]!;
        return p;
      },
    });
    title.append(" ", titleHelp.anchor);
    helpAnchors.push(titleHelp);
    section.appendChild(title);
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
          borrows || "这一档没有用供体字形",
          slot.style === "italic" ? "italic" : "upright",
          helpAnchors,
        ),
      );
    }
    container.appendChild(section);
  }

  // The machine form, verbatim — nothing hidden behind a hover.
  const details = document.createElement("details");
  details.className = "report-raw";
  const summaryEl = document.createElement("summary");
  summaryEl.textContent = "完整原始报告（JSON）";
  details.appendChild(summaryEl);
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(report, null, 2);
  details.appendChild(pre);
  container.appendChild(details);
}

/** Render one build row's content in place (the row node survives). */
function renderRow(
  rowEl: HTMLElement,
  row: BuildRow,
): void {
  rowEl.dataset.buildStatus = row.status;
  const stageEl = rowEl.querySelector<HTMLElement>("[data-build-stage]")!;
  stageEl.textContent = statusText(row);
  stageEl.classList.toggle("is-done", row.status === "saved" || row.status === "done");
  stageEl.classList.toggle(
    "is-failed",
    row.status === "failed" || row.status === "error",
  );

  // The journal (issue #22, absorbed): append-only, one line per
  // OBSERVED state transition, so the run's history stays readable
  // after the fact — not only the latest poll result.
  const journal = rowEl.querySelector<HTMLElement>("[data-build-journal]")!;
  const signature = `${row.status}:${row.stage ?? ""}:${row.queuePosition ?? ""}`;
  if (rowEl.dataset.journalSignature !== signature) {
    rowEl.dataset.journalSignature = signature;
    const line = document.createElement("div");
    line.textContent = statusText(row);
    journal.appendChild(line);
    journal.scrollTop = journal.scrollHeight;
  }

  // The stepper (round 6): upcoming faint / current active / done
  // lit-solid. A settled build lights every step — never all-gray at
  // save; a failed one keeps the completed steps lit and turns the
  // failing step danger.
  const steps = rowEl.querySelector<HTMLElement>(".build-steps")!;
  const order = STAGES.map(([key]) => key);
  const current = row.status === "queued" ? -1 : order.indexOf(row.stage ?? "");
  const settled = row.status === "saved" || row.status === "done";
  const failed = row.status === "failed" || row.status === "error";
  const dots = steps.querySelectorAll<HTMLElement>(".build-step");
  dots.forEach((dot, index) => {
    const passed = settled || (current >= 0 && index < current);
    const isCurrent =
      !settled && !failed && current >= 0 && index === current && row.status === "running";
    const isFailing = failed && (current < 0 || index === current);
    dot.classList.toggle("is-passed", passed);
    dot.classList.toggle("is-current", isCurrent);
    dot.classList.toggle("is-failed", isFailing);
  });

  // The ONE current-stage line (report-copy §1): the stage name and
  // its ≤30-char explanation, only while a stage is actually current.
  const stageLine = rowEl.querySelector<HTMLElement>("[data-build-stage-line]")!;
  const note = row.status === "running" && row.stage !== null ? stageNote(row.stage) : null;
  const stageLineText = note === null ? "" : `${stageLabel(row.stage!)} — ${note}`;
  if (stageLine.textContent !== stageLineText) {
    stageLine.textContent = stageLineText;
  }
  stageLine.hidden = stageLineText === "";

  const errorEl = rowEl.querySelector<HTMLElement>("[data-build-error]")!;
  errorEl.hidden = row.error === null;
  errorEl.textContent = row.error ?? "";

  const savedEl = rowEl.querySelector<HTMLElement>("[data-build-saved]")!;
  savedEl.hidden = row.savedPath === null;
  if (row.savedPath !== null) savedEl.textContent = `已保存：${row.savedPath}`;

  // The report renders ONCE per report object (round 6): the poll
  // re-renders the row every tick (patchBuild spreads a new row object
  // each time), but the report REFERENCE is set exactly once when the
  // fetch lands — content-addressing on it means the report (and its
  // ?-popover anchors) builds once. Rebuilding it every tick reflowed
  // the text, collapsed the open raw-JSON details, and toggled the
  // scrollbars on and off — the flicker.
  const reportEl = rowEl.querySelector<HTMLElement>("[data-build-report]")!;
  const rendered = renderedReports.get(rowEl);
  if (rendered !== row.report) {
    const previous = reportAnchors.get(rowEl);
    if (previous) {
      for (const help of previous) help.popup.remove();
      reportAnchors.delete(rowEl);
    }
    const anchors: HelpPopover[] = [];
    renderReport(reportEl, row, anchors);
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
    <div class="build-panel-title">合成任务</div>
    <div class="build-rows" role="status" aria-live="polite"></div>
  `;
  document.body.appendChild(panel);
  // Round 7: the panel head carries the brand mark (logo adoption).
  panel.querySelector(".build-panel-title")!.prepend(brandMark(18));

  const rowsEl = panel.querySelector<HTMLElement>(".build-rows")!;

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
      <div class="build-stage-line" data-build-stage-line hidden></div>
      <div class="build-journal" data-build-journal></div>
      <div class="build-error" data-build-error role="alert" hidden></div>
      <div class="build-saved" data-build-saved hidden></div>
      <div class="build-report" data-build-report hidden></div>
    `;
    row
      .querySelector<HTMLButtonElement>(".build-dismiss")!
      .addEventListener("click", () => {
        removeBuild(row.dataset.buildId ?? "");
      });
    return row;
  };

  const render = (): void => {
    const { builds } = synthStore.get();
    panel.hidden = builds.length === 0;

    // Rows are keyed by build id: existing nodes update in place, new
    // builds append, dismissed rows drop. The panel node never rebuilds.
    const existing = new Map<string, HTMLElement>();
    for (const el of [...rowsEl.children]) {
      const id = (el as HTMLElement).dataset.buildId;
      if (id && builds.some((row) => row.id === id)) existing.set(id, el as HTMLElement);
    }
    const fragment = document.createDocumentFragment();
    for (const row of builds) {
      let el = existing.get(row.id);
      if (!el) {
        el = buildRowEl();
        el.dataset.buildId = row.id;
      }
      el.querySelector<HTMLElement>(".build-family")!.textContent = row.family;
      const reportEl = el.querySelector<HTMLElement>("[data-build-report]")!;
      reportEl.hidden = row.report === null;
      renderRow(el, row);
      fragment.appendChild(el);
    }
    rowsEl.replaceChildren(fragment);
  };

  synthStore.subscribe(render);
  render();
}
