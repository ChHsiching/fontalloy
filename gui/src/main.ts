import "./app.css";
import { mountTopbar } from "./ui/topbar";
import { mountRail } from "./ui/rail";
import { mountContent } from "./ui/content";
import { mountStatsbar } from "./ui/statsbar";
import { mountCatalogScreen } from "./catalog/screen";
import { CatalogManager, setDefaultManager } from "./catalog/manager";
import { createStorage } from "./platform/storage";
import { readConfig } from "./platform/config";
import { store } from "./state";

const app = document.getElementById("app");
if (!app) throw new Error("#app root missing in index.html");

app.innerHTML = `
  <header class="topbar"></header>
  <div class="workspace">
    <aside class="workspace-rail"></aside>
    <main class="workspace-content"></main>
  </div>
  <footer class="statsbar enter" style="animation-delay: 120ms"></footer>
`;

mountTopbar(app.querySelector<HTMLElement>(".topbar")!);
mountRail(app.querySelector<HTMLElement>(".workspace-rail")!);
mountContent(app.querySelector<HTMLElement>(".workspace-content")!);
mountStatsbar(app.querySelector<HTMLElement>(".statsbar")!);

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
