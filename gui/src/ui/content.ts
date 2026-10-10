import { store, type ContentMode } from "../state";
import { mountCharmap } from "./charmap";
import { mountScenes } from "./scenes";

/**
 * Right content area (ADR-0004): mode tabs (character map / real-world
 * scenes) and the stage. The scene previews (issue #19) render with the
 * same effective result as the grid; the scene tab itself lives in the
 * store, so mode round trips preserve it.
 *
 * The stage is rebuilt only on mode changes — the character map and the
 * scenes each manage their own re-renders so their containers survive
 * state updates. Mode switches never reset the merge state: rules,
 * picks, and settings live in the store, not in either stage.
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
      stage.innerHTML = `<div class="scenes"></div>`;
      mountScenes(stage.querySelector<HTMLElement>(".scenes")!);
    }
  };
  store.subscribe(render);
  render();
}
