import { store, type ContentMode } from "../state";
import { mountCharmap } from "./charmap";

/**
 * Right content area: mode tabs (character map / real-world scenes) and the
 * stage. Scene previews render with the effective merged font once the merge
 * pipeline exists; for now the tab is a visible placeholder.
 *
 * The stage is rebuilt only on mode changes — the character map manages its
 * own re-renders so the grid container survives page/category updates.
 */
export function mountContent(root: HTMLElement): void {
  root.innerHTML = `
    <div class="content-mode-tabs" role="tablist">
      <button class="mode-tab" role="tab" data-mode="charmap" aria-selected="true">字符映射</button>
      <button class="mode-tab" role="tab" data-mode="scene" aria-selected="false">实景预览</button>
    </div>
    <div class="content-stage"></div>
  `;

  const stage = root.querySelector<HTMLElement>(".content-stage")!;
  const tabs = [...root.querySelectorAll<HTMLButtonElement>(".mode-tab")];

  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      if (store.get().mode !== tab.dataset.mode) {
        store.set({ mode: tab.dataset.mode as ContentMode });
      }
    });
  }

  let lastMode: ContentMode | null = null;
  const render = (): void => {
    const { mode } = store.get();
    for (const tab of tabs) {
      tab.setAttribute("aria-selected", String(tab.dataset.mode === mode));
    }
    if (mode === lastMode) return;
    lastMode = mode;
    if (mode === "charmap") {
      stage.dataset.mode = "charmap";
      stage.innerHTML = `<div class="charmap"></div>`;
      mountCharmap(stage.querySelector<HTMLElement>(".charmap")!);
    } else {
      stage.dataset.mode = "scene";
      stage.innerHTML = `
        <div class="scene-placeholder">
          实景预览（终端 / 代码 / 文档）将以合成后的字体渲染。<br>
          该功能将在本地合成管线就绪后提供。
        </div>
      `;
    }
  };
  store.subscribe(render);
  render();
}
