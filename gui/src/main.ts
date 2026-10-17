import "./kit/tokens.css";
import "./kit/kit.css";
import "./app.css";
import { mountTopbar } from "./ui/topbar";
import { mountRail } from "./ui/rail";
import { mountContent } from "./ui/content";
import { mountStatsbar } from "./ui/statsbar";
import { mountBuildPanel } from "./ui/buildpanel";
import { mountCatalogScreen } from "./catalog/screen";
import { startCatalogServe } from "./catalog/serve";
import { readConfig } from "./platform/config";
import { connectService } from "./service/synthesize";
import { refreshStars } from "./catalog/stars";
import { installUndoShortcuts } from "./history";
import { mountContextMenu } from "./kit/contextMenu";

const app = document.getElementById("app");
if (!app) throw new Error("#app root missing in index.html");

// The kit frame: every kit popup/select/help popover clamps to this
// element instead of the viewport (the app window IS the frame here).
app.dataset.kitFrame = "";

app.innerHTML = `
  <header class="topbar"></header>
  <div class="workspace">
    <aside class="workspace-rail"></aside>
    <main class="workspace-content"></main>
  </div>
  <div class="statsbar-slot"></div>
  <div class="zoom-host"></div>
`;

mountTopbar(app.querySelector<HTMLElement>(".topbar")!);
mountRail(app.querySelector<HTMLElement>(".workspace-rail")!);
mountContent(
  app.querySelector<HTMLElement>(".workspace-content")!,
  app.querySelector<HTMLElement>(".zoom-host")!,
);
mountStatsbar(app.querySelector<HTMLElement>(".statsbar-slot")!);

// The fullscreen scene overlay never covers the custom top bar (round
// 5, owner item 9): its host starts BELOW the bar, so the window
// controls (minimize / maximize / close) stay visible and clickable
// while a scene is zoomed. The bar's height is content-driven — track
// it live rather than hard-coding a number.
{
  const topbar = app.querySelector<HTMLElement>(".topbar")!;
  const zoomHost = app.querySelector<HTMLElement>(".zoom-host")!;
  const syncBounds = (): void => {
    zoomHost.style.top = `${topbar.offsetHeight}px`;
  };
  new ResizeObserver(syncBounds).observe(topbar);
  syncBounds();
}

// Ctrl+Z / Cmd+Z triggers rule undo (issue #20); the selection undo
// stack has its own click entry point in the batch editor.
installUndoShortcuts();

// Round 18 (owner item 1): the webview's DEFAULT context menu is
// replaced everywhere by the kit context menu (never merely hidden) —
// 复制 / 剪切 / 粘贴, enablement contextual to what is under the
// pointer. Works on any surface; keyboard-invoked menus (Shift+F10 /
// Menu, clientX/Y 0) anchor at the focused element instead.
const contextMenu = mountContextMenu();
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (e.clientX === 0 && e.clientY === 0) {
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      const rect = active.getBoundingClientRect();
      contextMenu.openAt(rect.left, rect.bottom, active);
      return;
    }
  }
  contextMenu.openAt(e.clientX, e.clientY, e.target);
});

// The build panel (issue #16): synthesis progress + verification
// report as a non-modal overlay on <body> — the workspace stays usable.
mountBuildPanel();

// The merge service connection (issue #16): under Tauri the shell's
// sidecar; in tests the injected config. Fire-and-forget on purpose —
// nothing here may delay or block the workspace, and a failed probe
// leaves a fully usable app with the reason as page text.
void connectService();

// The first-run catalog screen mounts last: the workspace must be fully
// usable underneath it before any sync shows (failures never block).
mountCatalogScreen();

// The catalog boot (ticket #30, spec #25): the SERVE owns the catalog —
// the page polls its status machine and family documents and lists its
// rows from them. The old page-side downloader (release document, zips,
// font bytes into storage — catalog/manager.ts) is no longer called
// from the boot path; ticket #33 deletes the module. Fire-and-forget
// like every boot task: nothing here may delay the workspace, and a
// failing catalog leaves a fully usable app with the serve's reason as
// the picker footer's text.
startCatalogServe();

// Live GitHub stars (round 5): one bounded refresh per launch, from the
// repos the catalog manifest pins; cached to storage for offline runs.
// Fire-and-forget like every boot task — the curated seed shows until
// (and unless) fresh counts land. Still gated on the classic bootstrap
// URL seam (dev builds; a serve-backed page without one stays quiet).
if (readConfig().catalogBootstrapUrl !== null) void refreshStars();
