/**
 * The no-service CLI panel (issue #22's absorption, repair round 2):
 * when no local merge service is detected, the synthesize flow offers
 * the copy-CLI alternative as the workspace's OWN state — a kit-styled,
 * non-modal panel above the stats bar (the same surface discipline as
 * the build panel) carrying:
 *
 * - the service statement (why live merging is unavailable at the
 *   probed address) with a click-reachable re-probe;
 * - the recipe YAML built from the SAME workspace state the service
 *   flow submits (picks, rail rules, settings — one recipe model);
 * - the `fontalloy build` command that reproduces the same merge, as
 *   copyable DOM text, and the recipe file as a browser download.
 *
 * Download/copy stay gated on a problem-free draft (the strict-loader
 * mirror in recipe/validate.ts); while problems remain the buttons
 * carry `aria-disabled` and a click-reachable explanation.
 */

import { store, type LoadedFont } from "../state";
import { synthStore } from "../service/state";
import { buildWorkspaceDraft, connectService } from "../service/synthesize";
import { buildCommand, recipeFileName, recipeYaml } from "../recipe/yaml";
import { validateDraft } from "../recipe/validate";
import type { FontSlot, Preset } from "../recipe/model";
import { brandMark } from "../kit/topBar";
import presetsJson from "../data/presets.json";
import catalogManifest from "../data/catalog.json";

const PRESETS = presetsJson.presets as Preset[];

/**
 * The recipe-side path of a pick WITHOUT a service: the platform's own
 * on-disk path when it has one (Tauri catalog storage / file dialog),
 * else — for catalog families — the `fontalloy assets fetch` layout
 * hint seeded with the stored face's file name (the old builder's
 * convention: the user completes the exact face they fetched).
 * Local browser files have no path: null (a stated validation problem,
 * never an invented one).
 */
function recipePathHint(font: LoadedFont | undefined): string | null {
  if (!font) return null;
  if (font.path !== undefined) return font.path;
  if (font.origin === "catalog") {
    const entry = catalogManifest.families.find((f) => f.family === font.family);
    if (entry) return `${entry.path_hint}/${font.fileName}`;
  }
  return null;
}

/**
 * The no-service draft from the workspace state: null only while a PICK
 * is missing; a picked font whose path cannot be resolved (a local
 * browser file) contributes an empty path so validation names it
 * precisely (缺少字体文件路径), never a silent gap. The CLI panel stays
 * path-based (round 6 ruling): a YAML someone runs by hand names files
 * they can see, not a manifest they must fetch first — the catalog
 * reference form is the connected service's contract.
 */
function workspaceCliDraft(): ReturnType<typeof buildWorkspaceDraft> | null {
  const { fonts, selected } = store.get();
  const en = fonts.find((f) => f.cssFamily === selected.en);
  const cjk = fonts.find((f) => f.cssFamily === selected.cjk);
  if (!en || !cjk) return null;
  const slot = (font: LoadedFont): FontSlot => ({
    catalog: null,
    path: recipePathHint(font) ?? "",
    face: null,
  });
  return buildWorkspaceDraft({ en: slot(en), cjk: slot(cjk) });
}

/* ---------------- the panel singleton ---------------- */

let panel: HTMLElement | null = null;

/** Open (and lazily mount) the panel; re-opens are no-ops. */
export function openCliPanel(): void {
  if (panel === null) mountCliPanel();
  panel!.hidden = false;
}

export function mountCliPanel(): void {
  if (panel !== null) return;
  const root = document.createElement("section");
  root.className = "cli-panel";
  root.dataset.testid = "cli-panel";
  root.setAttribute("aria-label", "离线合成 · CLI 方案");
  root.hidden = true;
  root.innerHTML = `
    <div class="cli-head">
      <span class="cli-title">离线合成 · CLI 方案</span>
      <button class="cli-close" type="button" aria-label="关闭">×</button>
    </div>
    <div class="cli-notice" data-testid="service-notice"></div>
    <div class="cli-actions">
      <button class="kit-btn gh sm" type="button" data-testid="reprobe">重新检测本地服务</button>
    </div>
    <ul class="cli-problems" data-testid="problems"></ul>
    <div class="cli-label">配方预览（YAML）</div>
    <pre class="cli-yaml" data-testid="recipe-yaml"></pre>
    <div class="cli-label">CLI 命令（同一合并）</div>
    <div class="cli-command-box"><code data-testid="cli-command"></code></div>
    <div class="cli-actions">
      <button class="kit-btn pri" type="button" data-testid="copy-command">复制 CLI 命令</button>
      <button class="kit-btn pri" type="button" data-testid="download-recipe">下载配方文件</button>
    </div>
    <div class="cli-status" data-testid="copy-status" role="status"></div>
    <div class="cli-hint">
      先运行 fontalloy assets fetch 获取目录字体，并按配方中的相对路径放置字体文件；
      配方路径相对于配方文件所在目录解析。
    </div>
  `;
  document.body.appendChild(root);
  // Round 7: the panel head carries the brand mark (logo adoption).
  root.querySelector(".cli-head")!.prepend(brandMark(18));
  panel = root;

  root
    .querySelector<HTMLButtonElement>(".cli-close")!
    .addEventListener("click", () => {
      root.hidden = true;
    });
  root
    .querySelector<HTMLButtonElement>('[data-testid="reprobe"]')!
    .addEventListener("click", () => {
      void connectService();
    });

  const notice = root.querySelector<HTMLElement>('[data-testid="service-notice"]')!;
  const problems = root.querySelector<HTMLElement>('[data-testid="problems"]')!;
  const yamlPre = root.querySelector<HTMLElement>('[data-testid="recipe-yaml"]')!;
  const commandCode = root.querySelector<HTMLElement>('[data-testid="cli-command"]')!;
  const copyButton = root.querySelector<HTMLButtonElement>(
    '[data-testid="copy-command"]',
  )!;
  const downloadButton = root.querySelector<HTMLButtonElement>(
    '[data-testid="download-recipe"]',
  )!;
  const copyStatus = root.querySelector<HTMLElement>('[data-testid="copy-status"]')!;

  const renderNotice = (): void => {
    const { service } = synthStore.get();
    if (service.status === "connected") {
      notice.textContent =
        `已连接本地服务（${service.url ?? ""}）——可直接使用顶栏的 合成字体 实时合成。`;
      return;
    }
    const address = service.url ?? "";
    if (service.status === "connecting") {
      notice.textContent = `正在检测本地服务${address ? `（${address}）` : ""}…`;
      return;
    }
    if (service.status === "none") {
      notice.textContent =
        "当前环境未提供服务地址，无法实时合成。桌面版会随应用自动启动服务；" +
        "网页版检测 fontalloy serve（仅监听 127.0.0.1，并以 --allow-origin 允许本站来源）。" +
        "可使用下方的“复制 CLI 命令”方案，在本地完成同一次合并。";
      return;
    }
    notice.textContent =
      "实时合成需要本地服务（fontalloy serve，仅监听 127.0.0.1，" +
      "并以 --allow-origin 允许本站来源）；未检测到本地服务" +
      `${address ? `（${address} 无响应：连接被拒绝或被 CORS 拦截）` : ""}。` +
      "可使用下方的“复制 CLI 命令”方案，在本地完成同一次合并。";
  };
  synthStore.subscribe(renderNotice);
  renderNotice();

  let yamlText = "";
  let ready = false;

  /** Copy via the clipboard API; fall back to selecting the text. */
  const copyCommand = async (): Promise<void> => {
    const command = commandCode.textContent ?? "";
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
    if (cachedDraft === null) return;
    const blob = new Blob([yamlText], { type: "text/yaml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = recipeFileName(cachedDraft);
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

  /** The last render's draft (null while a pick or its path is missing). */
  let cachedDraft: ReturnType<typeof buildWorkspaceDraft> | null = null;

  const render = (): void => {
    cachedDraft = workspaceCliDraft();
    // Without both picks there is no recipe at all: the YAML preview
    // stays empty and the problems state what is missing.
    const draft =
      cachedDraft ??
      buildWorkspaceDraft({
        en: { catalog: null, path: "", face: null },
        cjk: { catalog: null, path: "", face: null },
      });
    yamlText = recipeYaml(draft);
    yamlPre.textContent = cachedDraft === null ? "" : yamlText;
    commandCode.textContent = buildCommand(draft);

    const issues = validateDraft(draft, PRESETS);
    problems.replaceChildren(
      ...issues.map((issue) => {
        const li = document.createElement("li");
        li.textContent = `${issue.where}：${issue.message}`;
        return li;
      }),
    );
    ready = issues.length === 0 && cachedDraft !== null;
    const disabled = !ready;
    copyButton.setAttribute("aria-disabled", String(disabled));
    downloadButton.setAttribute("aria-disabled", String(disabled));
    copyButton.classList.toggle("is-blocked", disabled);
    downloadButton.classList.toggle("is-blocked", disabled);
    // Click-reachable explanation while blocked (page text, not hover).
    copyStatus.textContent = disabled
      ? cachedDraft === null
        ? "请先在左侧选择英文字体与中文字体，再复制命令与下载配方。"
        : `尚有 ${issues.length} 个问题待解决，解决后即可复制命令与下载配方。`
      : "";
  };
  store.subscribe(render);
  synthStore.subscribe(render);
  render();
}
