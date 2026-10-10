import { store, type CatalogFamilyStatus } from "../state";
import { getDefaultManager } from "./manager";

/**
 * The first-run progress screen (issue #17, ADR-0005): a dismissable
 * overlay showing per-family download status while the full catalog
 * arrives. It never blocks the workspace — the workspace is mounted and
 * functional underneath, the 跳过 button dismisses at any time, and the
 * screen closes itself once the run settles (missing families retry on
 * the next launch and are shown as such in the pickers).
 *
 * The node is created once and appended to <body>; only the family rows
 * rebuild (the picker-popup discipline, ADR-0004).
 */

const STATUS_TEXT: Record<CatalogFamilyStatus, string> = {
  pending: "等待下载",
  downloading: "下载中",
  verified: "已完成",
  failed: "下载失败",
};

export function mountCatalogScreen(): void {
  const screen = document.createElement("div");
  screen.className = "catalog-screen";
  screen.setAttribute("role", "dialog");
  screen.setAttribute("aria-modal", "false");
  screen.setAttribute("aria-label", "首次运行：下载字体目录");
  screen.innerHTML = `
    <div class="catalog-panel">
      <div class="catalog-head">
        <h2 class="catalog-title">首次运行 · 正在下载字体目录</h2>
        <div class="catalog-progress">已完成 <b data-stat="catalog-done">0</b> / <span data-stat="catalog-total">0</span> 个字体家族</div>
      </div>
      <div class="catalog-list"></div>
      <div class="catalog-actions">
        <button class="catalog-skip" type="button">跳过，稍后再说</button>
      </div>
    </div>
  `;
  screen.hidden = true;
  document.body.appendChild(screen);

  const list = screen.querySelector<HTMLElement>(".catalog-list")!;
  const done = screen.querySelector<HTMLElement>("[data-stat='catalog-done']")!;
  const total = screen.querySelector<HTMLElement>("[data-stat='catalog-total']")!;
  const skip = screen.querySelector<HTMLButtonElement>(".catalog-skip")!;

  skip.addEventListener("click", () => getDefaultManager()?.skip());

  const render = (): void => {
    const { catalog } = store.get();
    screen.hidden = !catalog.screen;
    const families = catalog.families;
    done.textContent = String(families.filter((f) => f.status === "verified").length);
    total.textContent = String(families.length);

    const fragment = document.createDocumentFragment();
    for (const family of families) {
      const row = document.createElement("div");
      row.className = "catalog-family";
      row.dataset.family = family.family;
      row.dataset.status = family.status;
      const name = document.createElement("span");
      name.className = "catalog-family-name";
      name.textContent = family.family;
      const status = document.createElement("span");
      status.className = "catalog-family-status";
      status.textContent = STATUS_TEXT[family.status];
      row.append(name, status);
      // Failures state their reason inline — nothing lives in hover-only
      // tooltips (ADR-0004).
      if (family.status === "failed" && family.error) {
        const error = document.createElement("span");
        error.className = "catalog-family-error";
        error.textContent = family.error;
        row.appendChild(error);
      }
      fragment.appendChild(row);
    }
    list.replaceChildren(fragment);
  };
  store.subscribe(render);
  render();
}
