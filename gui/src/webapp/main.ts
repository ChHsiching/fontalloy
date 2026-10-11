/**
 * The WebApp entry (the `web/` build target): mounts the recipe-builder
 * experience from the shared frontend source. The GUI entry
 * (gui/src/main.ts) mounts the split-pane workspace from the same tree;
 * only this file is web-only.
 *
 * Issue #22: on load the local service is probed (service.ts) and the
 * topbar chip renders the published status — the page state (live
 * merging vs the copy-CLI fallback) follows it everywhere.
 */

// The pre-kit chrome (old app.css verbatim): the webapp keeps its
// hand-rolled look until Stage 3 swaps it onto the kit.
import "./app-chrome.css";
import "./webapp.css";
import { mountBuilder } from "./builder";
import { mountResult } from "./result";
import { detectService, serviceStore } from "./service";
import { target } from "../platform";

if (target !== "web") {
  // The static bundle only ever runs on the web target; the guard keeps
  // the platform adapter honest (and is free at runtime otherwise).
  console.warn("fontalloy webapp: unexpected runtime target", target);
}

const app = document.getElementById("app");
if (!app) throw new Error("#app root missing in web/index.html");

app.innerHTML = `
  <header class="webapp-topbar">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">Fa</span>
      <span class="brand-name">FontAlloy</span>
      <span class="webapp-title">配方构建器</span>
    </div>
    <div class="webapp-service-chip" data-testid="service-chip">
      本地服务：检测中…
    </div>
  </header>
  <main class="webapp-main">
    <div class="webapp-builder"></div>
    <div class="wb-result-slot"></div>
  </main>
`;

const chip = app.querySelector<HTMLElement>('[data-testid="service-chip"]')!;
const renderChip = (): void => {
  const status = serviceStore.get();
  chip.textContent =
    status.state === "available"
      ? "本地服务：已连接"
      : status.state === "checking"
        ? "本地服务：检测中…"
        : "本地服务：未连接 —— 使用 CLI 方案";
};
serviceStore.subscribe(renderChip);
renderChip();

mountBuilder(app.querySelector<HTMLElement>(".webapp-builder")!);
mountResult(app.querySelector<HTMLElement>(".wb-result-slot")!);

// Detection on load; a refused connection is a handled state.
void detectService();
