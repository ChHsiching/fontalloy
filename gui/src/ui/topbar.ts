import { store } from "../state";

/**
 * Top bar: brand, font-pair tags, primary synthesize action.
 *
 * The synthesize action is disabled until the local merge service (sidecar,
 * a later ticket) exists — but the explanation is click-reachable page text,
 * never a hover-only tooltip (ADR-0004).
 */
export function mountTopbar(root: HTMLElement): void {
  root.innerHTML = `
    <div class="brand enter" style="animation-delay: 0ms">
      <span class="brand-mark" aria-hidden="true">Fa</span>
      <span class="brand-name">FontAlloy</span>
    </div>
    <div class="font-pair-tags enter" style="animation-delay: 40ms">
      <span class="pair-tag" data-role="pair-en"></span>
      <span class="pair-x" aria-hidden="true">×</span>
      <span class="pair-tag" data-role="pair-cjk"></span>
    </div>
    <button class="synthesize enter" style="animation-delay: 80ms" aria-disabled="true">合成</button>
  `;

  const pairEn = root.querySelector<HTMLElement>('[data-role="pair-en"]')!;
  const pairCjk = root.querySelector<HTMLElement>('[data-role="pair-cjk"]')!;
  const synthesize = root.querySelector<HTMLButtonElement>(".synthesize")!;

  // The notice lives in the document (not inside the button) so the text is
  // real page content reachable by a click.
  const notice = document.createElement("div");
  notice.className = "synthesize-notice";
  notice.hidden = true;
  notice.innerHTML = `
    <button class="notice-close" aria-label="关闭">×</button>
    合成功能尚未启用：本地合成服务（sidecar）将在后续版本接入，
    届时即可在此合并所选字体。当前版本可加载本地字体并浏览字符映射。
  `;
  document.body.appendChild(notice);

  synthesize.addEventListener("click", () => {
    notice.hidden = false;
  });
  notice
    .querySelector<HTMLButtonElement>(".notice-close")!
    .addEventListener("click", () => {
      notice.hidden = true;
    });

  const render = (): void => {
    const { fonts, selected } = store.get();
    const label = (key: string | null, prefix: string): string => {
      const font = fonts.find((f) => f.cssFamily === key);
      return font ? `${prefix} ${font.family}` : `${prefix} 未选择`;
    };
    pairEn.textContent = label(selected.en, "EN");
    pairCjk.textContent = label(selected.cjk, "CJK");
    pairEn.classList.toggle("is-set", selected.en !== null);
    pairCjk.classList.toggle("is-set", selected.cjk !== null);
  };
  store.subscribe(render);
  render();
}
