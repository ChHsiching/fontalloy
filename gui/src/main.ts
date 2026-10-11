import "./kit/tokens.css";
import "./kit/kit.css";
import "./app.css";
import { mountTopbar } from "./ui/topbar";
import { mountRail } from "./ui/rail";
import { mountContent } from "./ui/content";
import { mountStatsbar } from "./ui/statsbar";
import { mountBuildPanel } from "./ui/buildpanel";
import { mountCatalogScreen } from "./catalog/screen";
import { CatalogManager, setDefaultManager } from "./catalog/manager";
import { createStorage } from "./platform/storage";
import { readConfig } from "./platform/config";
import { connectService } from "./service/synthesize";
import { installUndoShortcuts } from "./history";
import { store } from "./state";

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

// Ctrl+Z / Cmd+Z triggers rule undo (issue #20); the selection undo
// stack has its own click entry point in the batch editor.
installUndoShortcuts();

// The build panel (issue #16): synthesis progress + verification
// report as a non-modal overlay on <body> — the workspace stays usable.
mountBuildPanel();

// The merge service connection (issue #16): under Tauri the shell's
// sidecar; in tests the injected config. Fire-and-forget on purpose —
// nothing here may delay or block the workspace, and a failed probe
// leaves a fully usable app with the reason as page text.
void connectService();

// The first-run catalog screen mounts last: the workspace must be fully
// usable underneath it before any download starts (failures never block).
mountCatalogScreen();

// Catalog bootstrap: under Tauri the GitHub release tag; elsewhere only when
// an injected config names an origin (tests / future WebApp build). The run
// is fire-and-forget on purpose — nothing here may delay the workspace.
const config = readConfig();
const bootstrapUrl = config.catalogBootstrapUrl;
if (bootstrapUrl !== null) {
  void (async () => {
    try {
      const manager = new CatalogManager({ storage: await createStorage() });
      setDefaultManager(manager);
      await manager.run(bootstrapUrl);
    } catch (err) {
      store.set({
        catalog: {
          ...store.get().catalog,
          status: "unavailable",
          bootstrapError: err instanceof Error ? err.message : String(err),
        },
      });
    }
  })();
}
