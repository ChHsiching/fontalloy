import { store, type CatalogFamilyProgress } from "../state";
import { skipCatalogScreen } from "./serve";
import { brandMark } from "../kit/topBar";
import { sep } from "../kit/icons";

/**
 * The first-run progress screen (issue #17, ADR-0005; ticket #30):
 * a dismissable overlay showing the SERVE's per-family sync progress
 * while the full catalog arrives. It never blocks the workspace — the
 * workspace is mounted and functional underneath, the 跳过 button
 * dismisses at any time, and the screen closes itself once the serve's
 * state machine settles (failures never block; missing families are
 * repaired by later sync runs).
 *
 * The node is created once and appended to <body>; only the family rows
 * rebuild (the picker-popup discipline, ADR-0004).
 */

const STATUS_TEXT: Record<CatalogFamilyProgress["state"], string> = {
  pending: "等待下载",
  downloading: "下载中",
  extracting: "解压中",
  verifying: "校验中",
  done: "已完成",
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
        <h2 class="catalog-title"><span>首次运行</span>${sep().outerHTML}<span>正在下载字体目录</span></h2>
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

  // Round 7: the panel head carries the brand mark (logo adoption).
  screen.querySelector(".catalog-title")!.prepend(brandMark(22));

  const list = screen.querySelector<HTMLElement>(".catalog-list")!;
  const done = screen.querySelector<HTMLElement>("[data-stat='catalog-done']")!;
  const total = screen.querySelector<HTMLElement>("[data-stat='catalog-total']")!;
  const skip = screen.querySelector<HTMLButtonElement>(".catalog-skip")!;

  skip.addEventListener("click", () => skipCatalogScreen());

  const render = (): void => {
    const { catalog } = store.get();
    screen.hidden = !catalog.screen;
    const families = catalog.progress;
    done.textContent = String(families.filter((f) => f.state === "done").length);
    total.textContent = String(families.length);

    const fragment = document.createDocumentFragment();
    for (const family of families) {
      const row = document.createElement("div");
      row.className = "catalog-family";
      row.dataset.family = family.family;
      row.dataset.status = family.state;
      const name = document.createElement("span");
      name.className = "catalog-family-name";
      name.textContent = family.family;
      const status = document.createElement("span");
      status.className = "catalog-family-status";
      status.textContent = STATUS_TEXT[family.state];
      row.append(name, status);
      // Failures state the serve's own reason inline — nothing lives in
      // hover-only tooltips (ADR-0004).
      if (family.state === "failed" && family.error) {
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
