import { store, selectedCoverage } from "../state";
import { completeRules } from "../precedence/model";
import { categoryName, pageCountFor } from "../unicode/blocks";

/**
 * Persistent bottom stats bar. Numbers use tabular numerals (ADR-0004);
 * every value is plain text — nothing lives in hover-only tooltips.
 */
export function mountStatsbar(root: HTMLElement): void {
  root.innerHTML = `
    <span class="stat">字体 <b data-stat="fonts">0</b></span>
    <span class="stat">已选覆盖 <b data-stat="coverage">0</b> 码位</span>
    <span class="stat">自定义规则 <b data-stat="rules">0</b></span>
    <span class="stat" data-stat="category">分类：全部</span>
    <span class="stat" data-stat="page" style="margin-left: auto">第 1 / 1 页</span>
  `;

  const q = (name: string): HTMLElement =>
    root.querySelector(`[data-stat="${name}"]`)!;

  const render = (): void => {
    const state = store.get();
    q("fonts").textContent = String(state.fonts.length);
    q("coverage").textContent = selectedCoverage(state).length.toLocaleString(
      "en-US",
    );
    // Complete rules only — a row still being typed is not a rule yet,
    // and this count is what the recipe will declare.
    q("rules").textContent = String(completeRules(state.rules).length);
    q("category").textContent = `分类：${categoryName(state.categoryId)}`;
    q("page").textContent = `第 ${state.page} / ${pageCountFor(state.categoryId)} 页`;
  };
  store.subscribe(render);
  render();
}
