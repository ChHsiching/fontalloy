import { store, type ContentMode } from "../state";
import { segmentedControl } from "../kit/actionBar";
import { mountCharmap } from "./charmap";
import { mountScenes } from "./scenes";

/**
 * Right content area (ADR-0004): the prototype's mode bar — the
 * 字符表/实际场景 segmented control, then the 自定义预览文字 field
 * (feeding the document scene) — and the stage. The scene previews
 * (issue #19) render with the same effective result as the grid; the
 * mode itself lives in the store, so mode round trips preserve it.
 *
 * The stage is rebuilt only on mode changes — the character map and the
 * scenes each manage their own re-renders so their containers survive
 * state updates. Mode switches never reset the merge state: rules,
 * picks, and settings live in the store, not in either stage.
 */
export function mountContent(root: HTMLElement, fullscreenHost: HTMLElement): void {
  root.innerHTML = `
    <div class="kit-modebar"></div>
    <div class="content-stage"></div>
  `;

  const modebar = root.querySelector<HTMLElement>(".kit-modebar")!;
  const stage = root.querySelector<HTMLElement>(".content-stage")!;

  const seg = segmentedControl({
    options: [
      { value: "charmap", label: "字符表" },
      { value: "scene", label: "实际场景" },
    ],
    value: store.get().mode,
    onSelect: (value) => {
      if (store.get().mode !== value) {
        store.set({ mode: value as ContentMode });
      }
    },
  });
  modebar.appendChild(seg);

  const previewInput = document.createElement("input");
  previewInput.placeholder = "自定义预览文字";
  previewInput.setAttribute("aria-label", "自定义预览文字");
  previewInput.dataset.role = "preview-text";
  previewInput.addEventListener("input", () => {
    store.set({ customPreview: previewInput.value });
  });
  modebar.appendChild(previewInput);

  let lastMode: ContentMode | null = null;
  const render = (): void => {
    const { mode, customPreview } = store.get();
    for (const button of seg.querySelectorAll("button")) {
      button.setAttribute("aria-pressed", String(button.dataset.value === mode));
    }
    previewInput.style.display = mode === "scene" ? "" : "none";
    if (previewInput.value !== customPreview) previewInput.value = customPreview;
    if (mode === lastMode) return;
    lastMode = mode;
    if (mode === "charmap") {
      stage.dataset.mode = "charmap";
      stage.innerHTML = `<div class="charmap"></div>`;
      mountCharmap(stage.querySelector<HTMLElement>(".charmap")!);
    } else {
      stage.dataset.mode = "scene";
      stage.innerHTML = `<div class="scenes"></div>`;
      mountScenes(stage.querySelector<HTMLElement>(".scenes")!, fullscreenHost);
    }
  };
  store.subscribe(render);
  render();
}
