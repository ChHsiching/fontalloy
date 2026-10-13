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
 *   scrollbars ever moving.
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
 * Wording follows the owner-ratified copy spec
 * (`fontalloy-notes/report-copy.md`): real words only, the round-10
 * ruling trims the ?-popovers to one per section heading.
 */

import { synthStore, removeBuild, type BuildRow } from "../service/state";
import { mountHelpPopover, type HelpPopover } from "../kit/helpPopover";
import { brandMark } from "../kit/topBar";
import { store } from "../state";
import { variantDisplayName } from "./picker";

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
 * The section-heading glossary (report-copy §2, one entry per report
 * section — the round-10 ruling: ONE ? per section heading, the
 * per-fact ?'s are gone).
 */
const GLOSSARY: Record<string, string> = {
  report: "合成完成后自动生成的核对结果。",
  "built-font": "本次合成生成的那份字体文件。",
  "source-fonts": "基底字体作合并容器，供体字体提供补充字形。",
  merge: "把多款字体里的字形按规则拼成一套新字体。",
  precedence: "多条规则同时管到一个字时，谁的规则先算。",
  "coverage-check": "对照规则要求，逐项看哪些码位没做进去。",
  metrics: "描述字体高矮、深浅、行距的一组数值。",
  "weight-slot": "成品要生成的一套字重与样式，如“粗体·斜体”。",
};

/**
 * The section heading's ?-anchor: title `X 是什么`, body the glossary
 * entry. The popup carries `.build-help-pop` so it stacks ABOVE this
 * panel (the popups live on <body>, where the panel's own z-index 880
 * would otherwise cover them).
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
    build: () => {
      const p = document.createElement("p");
      p.className = "kit-sub";
      p.textContent = GLOSSARY[helpKey]!;
      return p;
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
): void {
  container.replaceChildren();
  const report = row.report;
  if (report === null) return;

  const details = document.createElement("details");
  details.className = "report-details";

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
    for (const source of report.sources) {
      const id = source.id ?? source.role ?? "字体";
      const label =
        id === "base" ? "基底" : id.startsWith("donor") ? `供体 ${Number(id.slice("donor-".length)) + 1}` : id;
      sources.append(
        fact(
          label,
          `${sourceName(source.id ?? source.role, source.path)} · ${fmt(source.codepoints)} 个码位`,
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
    section.append(fact("基底提供", fmt(summary.from_base)));
    section.append(fact("供体补充", fmt(summary.from_donors)));
    section.append(fact("成品收录", fmt(summary.output_codepoints)));
    body.appendChild(section);
  }

  const counts = report.precedence?.counts;
  if (counts !== undefined) {
    const section = document.createElement("div");
    section.className = "report-section";
    section.appendChild(sectionHeading("规则优先级", "precedence", helpAnchors));
    section.append(fact("保留基字形", fmt(counts.base)));
    section.append(fact("补字", fmt(counts.fill)));
    section.append(fact("替换字形", fmt(counts.override)));
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
      section.append(fact("行高保持不变", "是：完全沿用基底字体"));
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
          borrows || "这一档没有用供体字形",
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
    row.report === null ? "" : "report",
  ].join("|");
}

/** Render one build row's content in place (the row node survives). */
function renderRow(
  rowEl: HTMLElement,
  row: BuildRow,
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

  const savedEl = rowEl.querySelector<HTMLElement>("[data-build-saved]")!;
  savedEl.hidden = row.savedPath === null;
  if (row.savedPath !== null) savedEl.textContent = `已保存：${row.savedPath}`;

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
      <div class="build-stage-line" data-build-stage-line></div>
      <div class="build-error" data-build-error role="alert" hidden></div>
      <div class="build-saved" data-build-saved hidden></div>
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
      renderRow(el, row);
    }
  };

  synthStore.subscribe(render);
  render();
}
