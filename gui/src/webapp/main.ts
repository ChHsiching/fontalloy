/**
 * The WebApp entry (the `web/` build target): mounts the recipe-builder
 * experience from the shared frontend source. The GUI entry
 * (gui/src/main.ts) mounts the split-pane workspace from the same tree;
 * only this file is web-only.
 */

import "../app.css";
import "./webapp.css";
import { mountBuilder } from "./builder";
import { mountResult } from "./result";
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
      本地服务：未连接 —— 使用 CLI 方案
    </div>
  </header>
  <main class="webapp-main">
    <div class="webapp-builder"></div>
    <div class="wb-result-slot"></div>
  </main>
`;

mountBuilder(app.querySelector<HTMLElement>(".webapp-builder")!);
mountResult(app.querySelector<HTMLElement>(".wb-result-slot")!);
