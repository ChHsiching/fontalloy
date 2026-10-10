import { store, selectedCoverage, type AppState } from "../state";
import { completeRules } from "../precedence/model";
import {
  ALL_CATEGORY_ID,
  categorySize,
  findBlock,
  categoryName,
  pageCountFor,
} from "../unicode/blocks";

/**
 * Persistent bottom stats bar (ADR-0004): live coverage and rule counts,
 * every number in tabular numerals, updating as fonts, rules, selection,
 * and the browsing context change. Every value is plain text — nothing
 * lives in hover-only tooltips.
 *
 * Since issue #20 the numbers are complete: per-category coverage
 * (covered codepoints of the ACTIVE category over its size) joins the
 * pick-union coverage, the complete-rule count, and the live
 * multi-selection count.
 */

/** Coverage counts of the picked fonts' union, memoized on its inputs. */
let coverageMemo: { signature: string; union: number[] } | null = null;

function coverageUnion(state: AppState): number[] {
  const signature = `${state.fonts.length}:${state.selected.en ?? ""}:${state.selected.cjk ?? ""}:${state.fonts
    .map((font) => `${font.cssFamily}:${font.codepoints.length}`)
    .join("|")}`;
  if (coverageMemo && coverageMemo.signature === signature) {
    return coverageMemo.union;
  }
  const union = selectedCoverage(state);
  coverageMemo = { signature, union };
  return union;
}

/**
 * Covered codepoints within the active category. Blocks intersect the
 * sorted union; the aggregate view's enumeration covers every scalar
 * value, so its count is the union itself.
 */
function categoryCoverage(categoryId: string, union: readonly number[]): number {
  if (categoryId === ALL_CATEGORY_ID) return union.length;
  const block = findBlock(categoryId);
  if (!block) return 0;
  let count = 0;
  for (const cp of union) {
    if (cp < block.start) continue;
    if (cp > block.end) break;
    count++;
  }
  return count;
}

export function mountStatsbar(root: HTMLElement): void {
  root.innerHTML = `
    <span class="stat">字体 <b data-stat="fonts">0</b></span>
    <span class="stat">已选覆盖 <b data-stat="coverage">0</b> 码位</span>
    <span class="stat">分类覆盖 <b data-stat="category-coverage">0</b> / <b data-stat="category-size">0</b></span>
    <span class="stat">自定义规则 <b data-stat="rules">0</b></span>
    <span class="stat">选中 <b data-stat="selection">0</b> 码位</span>
    <span class="stat" data-stat="category">分类：全部</span>
    <span class="stat" data-stat="page" style="margin-left: auto">第 1 / 1 页</span>
  `;

  const q = (name: string): HTMLElement =>
    root.querySelector(`[data-stat="${name}"]`)!;

  const render = (): void => {
    const state = store.get();
    q("fonts").textContent = String(state.fonts.length);
    const union = coverageUnion(state);
    q("coverage").textContent = union.length.toLocaleString("en-US");
    q("category-coverage").textContent = categoryCoverage(
      state.categoryId,
      union,
    ).toLocaleString("en-US");
    q("category-size").textContent = categorySize(
      state.categoryId,
    ).toLocaleString("en-US");
    // Complete rules only — a row still being typed is not a rule yet,
    // and this count is what the recipe will declare.
    q("rules").textContent = String(completeRules(state.rules).length);
    q("selection").textContent = state.selection.length.toLocaleString("en-US");
    q("category").textContent = `分类：${categoryName(state.categoryId)}`;
    q("page").textContent = `第 ${state.page} / ${pageCountFor(state.categoryId)} 页`;
  };
  store.subscribe(render);
  render();
}
