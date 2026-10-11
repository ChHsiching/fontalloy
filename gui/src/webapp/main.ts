/**
 * The WebApp entry (the `web/` build target): mounts the recipe-builder
 * experience from the shared frontend source. The GUI entry
 * (gui/src/main.ts) mounts the split-pane workspace from the same tree;
 * only this file is web-only.
 *
 * Since the design-fidelity repair the page wears the kit's design
 * language (kit/tokens.css + kit/kit.css): the top bar is the kit's
 * chrome (brand mark, theme toggle), surfaces and controls reference the
 * kit tokens, and the popup/dropdown/select components are kit
 * compositions. The page model stays a compact single-column tool page —
 * the workspace's fixed split-pane frame is deliberately NOT forced onto
 * it (documented in webapp.css).
 *
 * Issue #22: on load the local service is probed (service.ts) and the
 * top-bar chip renders the published status — the page state (live
 * merging vs the copy-CLI fallback) follows it everywhere.
 */

import "../kit/tokens.css";
import "../kit/kit.css";
import "./webapp.css";
import { brandPart, themeToggle } from "../kit/topBar";
import { applyAppTheme, type AppTheme } from "../kit/theme";
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

// The boot theme follows the OS preference (the workspace's convention);
// the page's own toggle (kit part) flips it afterwards.
const initialTheme: AppTheme = window.matchMedia(
  "(prefers-color-scheme: dark)",
).matches
  ? "dark"
  : "light";
applyAppTheme(initialTheme);

// The kit-topbar chrome with the webapp's own parts: brand + page title,
// the service-status tag, the theme toggle. The workspace's font pair,
// font-name field and synthesize action belong to the workspace — this
// page's actions live in the result panel.
const topbar = document.createElement("header");
topbar.className = "kit-topbar webapp-topbar";
const title = document.createElement("span");
title.className = "webapp-title";
title.textContent = "配方构建器";
const grow = document.createElement("span");
grow.className = "kit-grow";
const chip = document.createElement("span");
chip.className = "kit-tag webapp-service-chip";
chip.dataset.testid = "service-chip";
topbar.append(brandPart(), title, grow, chip, themeToggle());

const main = document.createElement("main");
main.className = "webapp-main";
const builderSlot = document.createElement("div");
builderSlot.className = "webapp-builder";
const resultSlot = document.createElement("div");
resultSlot.className = "wb-result-slot";
main.append(builderSlot, resultSlot);

app.append(topbar, main);

const renderChip = (): void => {
  const status = serviceStore.get();
  chip.classList.toggle("ok", status.state === "available");
  chip.textContent =
    status.state === "available"
      ? "本地服务：已连接"
      : status.state === "checking"
        ? "本地服务：检测中…"
        : "本地服务：未连接 —— 使用 CLI 方案";
};
serviceStore.subscribe(renderChip);
renderChip();

mountBuilder(builderSlot);
mountResult(resultSlot);

// Detection on load; a refused connection is a handled state.
void detectService();
