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
 */

import { synthStore, removeBuild, type BuildRow } from "../service/state";

/** The pipeline stages, in order — the progress stepper's dots. */
const STAGES: ReadonlyArray<readonly [string, string]> = [
  ["loading", "读取字体"],
  ["planning", "规划槽位"],
  ["resolving", "解析规则"],
  ["grafting", "嫁接字形"],
  ["rewriting", "重写表"],
  ["saving", "保存产物"],
  ["reporting", "生成报告"],
] as const;

function stageLabel(stage: string): string {
  const found = STAGES.find(([key]) => key === stage);
  if (found) return found[1];
  if (stage === "done") return "完成";
  return stage;
}

/** What the row's status line says for the row's current state. */
function statusText(row: BuildRow): string {
  switch (row.status) {
    case "queued":
      return row.queuePosition !== null && row.queuePosition > 1
        ? `排队中（第 ${row.queuePosition} 位）`
        : "排队中";
    case "running":
      return row.stage === null ? "运行中" : stageLabel(row.stage);
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

function fmt(value: number | undefined): string {
  return value === undefined ? "—" : value.toLocaleString("en-US");
}

function basename(path: string | undefined): string {
  if (path === undefined) return "—";
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? path;
}

/** One <dt>-style labeled value line. */
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

/**
 * Render the verification report — the machine JSON, structured. Every
 * section degrades to omission when the schema lacks it, so a report
 * from an older or newer core still renders what it carried (the human
 * rendering from issue #12 will replace the internals of this
 * function, not its contract).
 */
function renderReport(
  container: HTMLElement,
  row: BuildRow,
): void {
  container.replaceChildren();
  const report = row.report;
  if (report === null) return;

  const heading = document.createElement("div");
  heading.className = "report-heading";
  heading.textContent = "验证报告";
  container.appendChild(heading);

  const output = document.createElement("div");
  output.className = "report-section";
  output.append(fact("输出", report.output?.format ?? "ttf"));
  if (report.output?.sha256) {
    output.append(fact("sha256", report.output.sha256.slice(0, 12)));
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
      sources.append(
        fact(
          source.id ?? source.role ?? "字体",
          `${basename(source.path)} · ${fmt(source.codepoints)} 码位`,
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
    title.textContent = "覆盖摘要";
    section.appendChild(title);
    section.append(fact("码位总数", fmt(summary.codepoints_total)));
    section.append(fact("来自基底", fmt(summary.from_base)));
    section.append(fact("来自供体", fmt(summary.from_donors)));
    section.append(fact("输出码位", fmt(summary.output_codepoints)));
    container.appendChild(section);
  }

  const counts = report.precedence?.counts;
  if (counts !== undefined) {
    const section = document.createElement("div");
    section.className = "report-section";
    const title = document.createElement("div");
    title.className = "report-section-title";
    title.textContent = "优先级";
    section.appendChild(title);
    section.append(fact("基底保留", fmt(counts.base)));
    section.append(fact("空缺填充", fmt(counts.fill)));
    section.append(fact("显式覆写", fmt(counts.override)));
    const conflicts = report.precedence?.same_layer_conflicts?.length ?? 0;
    section.append(fact("同层冲突", fmt(conflicts)));
    container.appendChild(section);
  }

  if (report.weights && report.weights.length > 0) {
    const section = document.createElement("div");
    section.className = "report-section";
    const title = document.createElement("div");
    title.className = "report-section-title";
    title.textContent = "字重槽位";
    section.appendChild(title);
    for (const slot of report.weights) {
      const borrows = (slot.borrows ?? [])
        .map(
          (borrow) =>
            `${borrow.donor ?? "?"} ← ${fmt(borrow.weight)}（${
              borrow.via ?? "?"
            }）`,
        )
        .join("；");
      section.append(
        fact(
          `${fmt(slot.weight)} ${slot.style === "italic" ? "italic" : "upright"}`,
          borrows || "无供体借用",
        ),
      );
    }
    container.appendChild(section);
  }

  // The machine form, verbatim — nothing hidden behind a hover.
  const details = document.createElement("details");
  details.className = "report-raw";
  const summaryEl = document.createElement("summary");
  summaryEl.textContent = "原始报告（JSON）";
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

  // The stepper: one dot per pipeline stage, filled once passed.
  const steps = rowEl.querySelector<HTMLElement>(".build-steps")!;
  const order = STAGES.map(([key]) => key);
  const current = row.status === "queued" ? -1 : order.indexOf(row.stage ?? "");
  const dots = steps.querySelectorAll<HTMLElement>(".build-step");
  dots.forEach((dot, index) => {
    const passed =
      row.status === "saved" ||
      row.status === "done" ||
      (current >= 0 && index <= current);
    dot.classList.toggle("is-passed", passed);
    dot.classList.toggle("is-current", index === current && row.status === "running");
  });

  const errorEl = rowEl.querySelector<HTMLElement>("[data-build-error]")!;
  errorEl.hidden = row.error === null;
  errorEl.textContent = row.error ?? "";

  const savedEl = rowEl.querySelector<HTMLElement>("[data-build-saved]")!;
  savedEl.hidden = row.savedPath === null;
  if (row.savedPath !== null) savedEl.textContent = `已保存：${row.savedPath}`;

  renderReport(rowEl.querySelector<HTMLElement>("[data-build-report]")!, row);
}

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

  const rowsEl = panel.querySelector<HTMLElement>(".build-rows")!;

  const buildRowEl = (): HTMLElement => {
    const row = document.createElement("article");
    row.className = "build-row enter";
    row.dataset.buildRow = "";
    row.innerHTML = `
      <div class="build-row-head">
        <span class="build-family"></span>
        <span class="build-stage" data-build-stage></span>
        <button class="build-dismiss" aria-label="关闭此构建" type="button">×</button>
      </div>
      <div class="build-steps">
        ${STAGES.map(([, label]) => `<span class="build-step" title="${label}"></span>`).join("")}
      </div>
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
