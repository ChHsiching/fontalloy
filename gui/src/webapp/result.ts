/**
 * The output panel: live YAML preview, the downloadable recipe file,
 * and the copyable `fontalloy build` command that reproduces the same
 * merge — plus, since issue #22, the live merge surface when the local
 * service answered the detection probe (merge.ts) and the plain
 * no-service statement with a click-reachable re-probe when it did not.
 *
 * Download/copy are gated on a problem-free draft (the strict-loader
 * mirror in recipe/validate.ts); while problems remain the buttons
 * carry `aria-disabled` and a click-reachable explanation, the same
 * pattern as the GUI's synthesize action.
 */

import { buildCommand, recipeFileName, recipeYaml } from "../recipe/yaml";
import { validateDraft } from "../recipe/validate";
import presetsJson from "../data/presets.json";
import type { Preset } from "../recipe/model";
import { builderStore } from "./state";
import { detectService, serviceStore } from "./service";
import { mountLiveMerge } from "./merge";

const PRESETS = presetsJson.presets as Preset[];

export function mountResult(root: HTMLElement): void {
  root.className = "wb-result";

  // The service notice: rendered from the published probe status, so
  // the page states connected / absent / checking as page text.
  const noticeBox = document.createElement("div");
  noticeBox.className = "wb-service-notice";
  noticeBox.dataset.testid = "service-notice";
  root.appendChild(noticeBox);
  const reprobeButton = document.createElement("button");
  reprobeButton.type = "button";
  reprobeButton.className = "wb-reprobe-button";
  reprobeButton.dataset.testid = "reprobe";
  reprobeButton.textContent = "重新检测本地服务";
  reprobeButton.addEventListener("click", () => {
    void detectService();
  });

  const renderNotice = (): void => {
    const status = serviceStore.get();
    reprobeButton.remove();
    if (status.state === "available") {
      noticeBox.textContent =
        `已连接本地服务（fontalloy v${status.version ?? "?"}，${status.address}）。` +
        "配方可实时合成并直接下载字体与验证报告。";
    } else if (status.state === "checking") {
      noticeBox.textContent = `正在检测本地服务（${status.address}）…`;
    } else {
      noticeBox.textContent =
        "实时合成需要本地服务（fontalloy serve，仅监听 127.0.0.1，" +
        "并以 --allow-origin 允许本站来源）；未检测到本地服务" +
        `（${status.address} 无响应：连接被拒绝或被 CORS 拦截）。` +
        "可使用下方的“复制 CLI 命令”方案，在本地完成同一次合并。";
      // The retry affordance is click-reachable, never hover-only.
      noticeBox.appendChild(reprobeButton);
    }
  };
  serviceStore.subscribe(renderNotice);
  renderNotice();

  const problems = document.createElement("ul");
  problems.className = "wb-problems";
  problems.dataset.testid = "problems";
  root.appendChild(problems);

  // The live merge surface exists only when the service answered.
  const liveSlot = document.createElement("div");
  root.appendChild(liveSlot);
  mountLiveMerge(liveSlot);
  const renderLiveVisibility = (): void => {
    liveSlot.hidden = serviceStore.get().state !== "available";
  };
  serviceStore.subscribe(renderLiveVisibility);
  renderLiveVisibility();

  const yamlLabel = document.createElement("div");
  yamlLabel.className = "wb-result-label";
  yamlLabel.textContent = "配方预览（YAML）";
  root.appendChild(yamlLabel);
  const yamlPre = document.createElement("pre");
  yamlPre.className = "wb-yaml";
  yamlPre.dataset.testid = "recipe-yaml";
  root.appendChild(yamlPre);

  const commandLabel = document.createElement("div");
  commandLabel.className = "wb-result-label";
  commandLabel.textContent = "CLI 命令（同一合并）";
  root.appendChild(commandLabel);
  const commandBox = document.createElement("div");
  commandBox.className = "wb-command-box";
  const commandCode = document.createElement("code");
  commandCode.dataset.testid = "cli-command";
  commandBox.appendChild(commandCode);
  root.appendChild(commandBox);

  const actions = document.createElement("div");
  actions.className = "wb-actions";
  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = "kit-btn pri";
  copyButton.dataset.testid = "copy-command";
  copyButton.textContent = "复制 CLI 命令";
  const downloadButton = document.createElement("button");
  downloadButton.type = "button";
  downloadButton.className = "kit-btn pri";
  downloadButton.dataset.testid = "download-recipe";
  downloadButton.textContent = "下载配方文件";
  actions.append(copyButton, downloadButton);
  root.appendChild(actions);

  const copyStatus = document.createElement("div");
  copyStatus.className = "wb-copy-status";
  copyStatus.dataset.testid = "copy-status";
  copyStatus.setAttribute("role", "status");
  root.appendChild(copyStatus);

  const hint = document.createElement("div");
  hint.className = "wb-result-hint";
  hint.textContent =
    "先运行 fontalloy assets fetch 获取目录字体，并按配方中的相对路径放置字体文件；" +
    "配方路径相对于配方文件所在目录解析。";
  root.appendChild(hint);

  let yamlText = "";
  let ready = false;

  /** Copy via the clipboard API; fall back to selecting the text. */
  const copyCommand = async (): Promise<void> => {
    const command = buildCommand(builderStore.get().draft);
    try {
      await navigator.clipboard.writeText(command);
      copyStatus.textContent = "命令已复制到剪贴板。";
      return;
    } catch {
      // Click-reachable fallback: select the command text so Ctrl+C
      // (or a long-press copy) works without any permission.
      const range = document.createRange();
      range.selectNodeContents(commandCode);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      copyStatus.textContent = "剪贴板不可用——已选中命令文本，请按 Ctrl+C 复制。";
    }
  };

  const downloadRecipe = (): void => {
    const blob = new Blob([yamlText], { type: "text/yaml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = recipeFileName(builderStore.get().draft);
    anchor.rel = "noopener";
    root.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 5_000);
  };

  copyButton.addEventListener("click", () => {
    if (ready) void copyCommand();
  });
  downloadButton.addEventListener("click", () => {
    if (ready) downloadRecipe();
  });

  const render = (): void => {
    const draft = builderStore.get().draft;
    yamlText = recipeYaml(draft);
    yamlPre.textContent = yamlText;
    commandCode.textContent = buildCommand(draft);

    const issues = validateDraft(draft, PRESETS);
    problems.replaceChildren(
      ...issues.map((issue) => {
        const li = document.createElement("li");
        li.textContent = `${issue.where}：${issue.message}`;
        return li;
      }),
    );
    ready = issues.length === 0;
    const disabled = !ready;
    copyButton.setAttribute("aria-disabled", String(disabled));
    downloadButton.setAttribute("aria-disabled", String(disabled));
    copyButton.classList.toggle("is-blocked", disabled);
    downloadButton.classList.toggle("is-blocked", disabled);
    if (disabled) {
      // Click-reachable explanation while blocked (copyStatus is page text).
      copyStatus.textContent =
        issues.length > 0
          ? `尚有 ${issues.length} 个问题待解决，解决后即可复制命令与下载配方。`
          : "";
    }
  };
  builderStore.subscribe(render);
  render();
}
