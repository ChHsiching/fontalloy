/**
 * The live merge driver (issue #22): when the local service answered
 * the detection probe, the WebApp drives a real merge end-to-end —
 * submit the builder's recipe as the serve JSON body, poll progress
 * (250ms while running, 1s while queued, per the serve contract), and
 * download the output font plus the verification report, which is
 * rendered from the machine JSON the service returned. Failures at any
 * step surface inline as page text.
 *
 * The journal is append-only by design: it keeps every observed state
 * transition of a run, so the page (and the tests) can see progress
 * after the fact, not only the latest poll result.
 */

import presetsJson from "../data/presets.json";
import type { Preset } from "../recipe/model";
import { recipeJson } from "../recipe/json";
import { validateDraft } from "../recipe/validate";
import { builderStore } from "./state";
import { serviceStore } from "./service";

const PRESETS = presetsJson.presets as Preset[];

/** The build pipeline's stages, in order (the progress callback's set). */
const STAGE_LABELS: Record<string, string> = {
  loading: "加载",
  planning: "规划",
  resolving: "解析",
  grafting: "嫁接",
  rewriting: "重写",
  saving: "保存",
  reporting: "报告",
  done: "完成",
};

/** Poll cadence from the serve contract guidance (ticket #11). */
const RUNNING_POLL_MS = 250;
const QUEUED_POLL_MS = 1_000;

/** One polled GET /builds/{id} document (the fields the UI consumes). */
interface BuildDocument {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  stage: string | null;
  queue_position: number | null;
  error: string | null;
  font: { filename: string; size: number; sha256: string } | null;
  report: { filename: string } | null;
}

/** The verification report's machine JSON (rendered, not trusted). */
interface ReportDocument {
  schema?: string;
  summary?: {
    codepoints_total?: number;
    from_base?: number;
    from_donors?: number;
    output_codepoints?: number;
  };
  sources?: Array<{ id?: string; role?: string; codepoints?: number }>;
  /** Report v2 (issue #12): the read-back coverage accounting. */
  coverage?: {
    requested?: number;
    covered?: number;
    missing_total?: number;
    missing_truncated?: boolean;
  };
}

const count = new Intl.NumberFormat("en-US");

function log(journal: HTMLElement, text: string): void {
  const line = document.createElement("div");
  line.className = "wb-journal-line";
  line.textContent = text;
  journal.appendChild(line);
  journal.scrollTop = journal.scrollHeight;
}

/** Download bytes from the service as a browser download. */
async function downloadArtifact(
  address: string,
  buildId: string,
  kind: "font" | "report",
  filename: string,
): Promise<void> {
  const response = await fetch(`${address}/builds/${buildId}/${kind}`);
  if (!response.ok) {
    throw new Error(`下载失败（HTTP ${response.status}）`);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

/** Render the report from the machine JSON: what exists, no more. */
function renderReport(root: HTMLElement, report: ReportDocument): void {
  const lines: string[] = [];
  if (report.schema !== undefined) lines.push(`报告格式：${report.schema}`);
  const summary = report.summary;
  if (summary !== undefined) {
    lines.push(
      `共 ${count.format(summary.codepoints_total ?? 0)} 码位：基底 ` +
        `${count.format(summary.from_base ?? 0)}、供体 ` +
        `${count.format(summary.from_donors ?? 0)}；输出覆盖 ` +
        `${count.format(summary.output_codepoints ?? 0)} 码位。`,
    );
  }
  if (report.coverage !== undefined) {
    const missing = report.coverage.missing_total ?? 0;
    lines.push(
      `覆盖核对：请求 ${count.format(report.coverage.requested ?? 0)} 码位，` +
        `实际覆盖 ${count.format(report.coverage.covered ?? 0)}，缺失 ` +
        `${count.format(missing)}` +
        (missing > 0 && report.coverage.missing_truncated ? "（列表见报告 JSON）" : "") +
        "。",
    );
  }
  if (report.sources !== undefined && report.sources.length > 0) {
    lines.push(
      `来源 ${report.sources.length} 个：` +
        report.sources
          .map((source) => `${source.id ?? "?"}（${count.format(source.codepoints ?? 0)} 码位）`)
          .join("、") +
        "。",
    );
  }
  root.replaceChildren(
    ...lines.map((text) => {
      const line = document.createElement("div");
      line.textContent = text;
      return line;
    }),
  );
}

export function mountLiveMerge(root: HTMLElement): void {
  root.className = "wb-live";
  root.dataset.testid = "live-merge-panel";
  root.hidden = true;

  const title = document.createElement("div");
  title.className = "wb-result-label";
  title.textContent = "实时合成（本地服务）";
  root.appendChild(title);

  const actions = document.createElement("div");
  actions.className = "wb-actions";
  const mergeButton = document.createElement("button");
  mergeButton.type = "button";
  mergeButton.className = "synthesize";
  mergeButton.dataset.testid = "live-merge";
  mergeButton.textContent = "实时合成";
  actions.appendChild(mergeButton);
  root.appendChild(actions);

  const status = document.createElement("div");
  status.className = "wb-live-status";
  status.dataset.testid = "live-status";
  status.setAttribute("role", "status");
  status.textContent = "未开始。";
  root.appendChild(status);

  const journal = document.createElement("div");
  journal.className = "wb-journal";
  journal.dataset.testid = "live-journal";
  root.appendChild(journal);

  const error = document.createElement("div");
  error.className = "wb-live-error";
  error.dataset.testid = "live-error";
  error.setAttribute("role", "alert");
  root.appendChild(error);

  const result = document.createElement("div");
  result.className = "wb-live-result";
  result.dataset.testid = "live-result";
  root.appendChild(result);

  const report = document.createElement("div");
  report.className = "wb-live-report";
  report.dataset.testid = "live-report";
  root.appendChild(report);

  const hint = document.createElement("div");
  hint.className = "wb-result-hint";
  hint.textContent =
    "实时合成按配方原样提交：字体路径相对于 serve 进程的工作目录解析，" +
    "请使用绝对路径（serve 契约）。构建产物保留最近 10 次，请及时下载。";
  root.appendChild(hint);

  let ready = false;
  let run = 0; // the active run's token; a new submit invalidates the old loop

  const reset = (): void => {
    run += 1;
    journal.replaceChildren();
    error.textContent = "";
    result.replaceChildren();
    report.replaceChildren();
  };

  const renderResult = async (
    address: string,
    doc: BuildDocument,
    token: number,
  ): Promise<void> => {
    const font = doc.font;
    if (font === null) return;
    const fontLine = document.createElement("div");
    fontLine.textContent =
      `字体：${font.filename}（${count.format(font.size)} 字节，` +
      `sha256 ${font.sha256.slice(0, 12)}…）`;
    const buttons = document.createElement("div");
    buttons.className = "wb-actions";
    const fontButton = document.createElement("button");
    fontButton.type = "button";
    fontButton.className = "synthesize";
    fontButton.dataset.testid = "download-font";
    fontButton.textContent = `下载字体（${font.filename}）`;
    const reportButton = document.createElement("button");
    reportButton.type = "button";
    reportButton.className = "synthesize";
    reportButton.dataset.testid = "download-report";
    reportButton.textContent = `下载验证报告（${doc.report?.filename ?? "report.json"}）`;
    buttons.append(fontButton, reportButton);
    result.append(fontLine, buttons);

    fontButton.addEventListener("click", () => {
      void downloadArtifact(address, doc.id, "font", font.filename).catch((e: unknown) => {
        error.textContent = `字体下载失败：${e instanceof Error ? e.message : String(e)}`;
      });
    });
    reportButton.addEventListener("click", () => {
      void downloadArtifact(
        address,
        doc.id,
        "report",
        doc.report?.filename ?? `${font.filename}.report.json`,
      ).catch((e: unknown) => {
        error.textContent = `报告下载失败：${e instanceof Error ? e.message : String(e)}`;
      });
    });

    // The report renders from the machine JSON (the page never guesses).
    try {
      const response = await fetch(`${address}/builds/${doc.id}/report`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      renderReport(report, (await response.json()) as ReportDocument);
    } catch (e) {
      if (token === run) {
        report.textContent = `报告获取失败：${e instanceof Error ? e.message : String(e)}`;
      }
    }
  };

  const poll = (address: string, buildId: string, token: number): void => {
    if (token !== run) return;
    void (async () => {
      let doc: BuildDocument;
      try {
        const response = await fetch(`${address}/builds/${buildId}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        doc = (await response.json()) as BuildDocument;
      } catch (e) {
        if (token === run) {
          status.textContent = "状态未知。";
          error.textContent = `构建状态获取失败：${e instanceof Error ? e.message : String(e)}`;
        }
        return;
      }
      if (token !== run) return;
      if (doc.status === "queued") {
        const position = doc.queue_position ?? 1;
        status.textContent = `排队中（第 ${position} 位）…`;
        log(journal, `排队中（第 ${position} 位）`);
        window.setTimeout(() => poll(address, buildId, token), QUEUED_POLL_MS);
      } else if (doc.status === "running") {
        const stage = doc.stage ?? "";
        const label = STAGE_LABELS[stage] ?? stage;
        status.textContent = `进行中：${label}`;
        log(journal, `进行中：${label}`);
        window.setTimeout(() => poll(address, buildId, token), RUNNING_POLL_MS);
      } else if (doc.status === "done") {
        status.textContent = "完成。";
        log(journal, "完成");
        void renderResult(address, doc, token);
      } else {
        status.textContent = "失败。";
        log(journal, "失败");
        error.textContent = `构建失败：${doc.error ?? "未知错误"}`;
      }
    })();
  };

  const submit = (): void => {
    if (!ready) return;
    const { address } = serviceStore.get();
    const draft = builderStore.get().draft;
    reset();
    const token = run;
    status.textContent = "提交中…";
    log(journal, `已提交到 ${address}`);
    void (async () => {
      let submitted: { id?: string };
      try {
        const response = await fetch(`${address}/builds`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(recipeJson(draft)),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${response.status}`);
        }
        submitted = (await response.json()) as { id?: string };
      } catch (e) {
        if (token === run) {
          status.textContent = "提交失败。";
          error.textContent = `服务拒绝了配方：${e instanceof Error ? e.message : String(e)}`;
        }
        return;
      }
      if (token !== run) return;
      const buildId = submitted.id ?? "";
      log(journal, `服务已受理（build ${buildId.slice(0, 8)}）`);
      poll(address, buildId, token);
    })();
  };

  mergeButton.addEventListener("click", submit);

  const render = (): void => {
    const issues = validateDraft(builderStore.get().draft, PRESETS);
    ready = issues.length === 0;
    mergeButton.setAttribute("aria-disabled", String(!ready));
    mergeButton.classList.toggle("is-blocked", !ready);
  };
  builderStore.subscribe(render);
  render();
}
