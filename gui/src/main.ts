import "./app.css";
import { mountTopbar } from "./ui/topbar";
import { mountRail } from "./ui/rail";
import { mountContent } from "./ui/content";
import { mountStatsbar } from "./ui/statsbar";

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
