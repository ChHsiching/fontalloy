import { store } from "../state";
import { synthStore } from "../service/state";
import { synthesize, synthesizeReady } from "../service/synthesize";

/**
 * Top bar: brand, font-pair tags, the service state, and the primary
 * synthesize action (issue #16: it drives real merges over the serve
 * contract once a service is connected and both fonts are picked).
 *
 * The explanation for a disabled action is click-reachable page text,
 * never a hover-only tooltip (ADR-0004); the service state is always
 * visible as plain text next to the action.
 */

/** The service chip's text for each connection state. */
function serviceText(status: string, error?: string): string {
  switch (status) {
    case "connected":
      return "本地服务：已连接";
    case "connecting":
      return "本地服务：连接中";
    case "unavailable":
      return error === undefined ? "本地服务：未连接" : `本地服务：未连接（${error}）`;
    default:
      return "本地服务：未连接";
  }
}

/** Why the synthesize action cannot run right now (null when it can). */
function disabledReason(): string | null {
  const { service } = synthStore.get();
  const { selected } = store.get();
  if (service.status === "none") {
    return (
      "未连接本地合成服务（fontalloy serve）。桌面版会随应用自动启动服务；" +
      "当前环境未提供服务地址，无法进行合成。可继续加载字体并浏览字符映射。"
    );
  }
  if (service.status === "connecting") {
    return "正在连接本地合成服务，请稍候。";
  }
  if (service.status === "unavailable") {
    return (
      "本地合成服务不可用" +
      (service.error ? `（${service.error}）` : "") +
      "。合成功能需要服务运行；字体加载与字符映射不受影响。"
    );
  }
  if (selected.en === null || selected.cjk === null) {
    return "请先选择英文字体与中文字体，再进行合成。";
  }
  return null;
}

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
    <span class="service-state" data-role="service-state">本地服务：未连接</span>
    <button class="synthesize enter" style="animation-delay: 80ms" aria-disabled="true">合成</button>
  `;

  const pairEn = root.querySelector<HTMLElement>('[data-role="pair-en"]')!;
  const pairCjk = root.querySelector<HTMLElement>('[data-role="pair-cjk"]')!;
  const serviceEl = root.querySelector<HTMLElement>('[data-role="service-state"]')!;
  const synthesizeButton = root.querySelector<HTMLButtonElement>(".synthesize")!;

  // The notice lives in the document (not inside the button) so the text is
  // real page content reachable by a click.
  const notice = document.createElement("div");
  notice.className = "synthesize-notice";
  notice.hidden = true;
  notice.innerHTML = `
    <button class="notice-close" aria-label="关闭">×</button>
    <span class="notice-text"></span>
  `;
  document.body.appendChild(notice);

  synthesizeButton.addEventListener("click", () => {
    const reason = disabledReason();
    if (reason !== null) {
      notice.querySelector<HTMLElement>(".notice-text")!.textContent = reason;
      notice.hidden = false;
      return;
    }
    void synthesize();
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

    const { service } = synthStore.get();
    serviceEl.textContent = serviceText(service.status, service.error);
    const ready = synthesizeReady();
    synthesizeButton.setAttribute("aria-disabled", String(!ready));
  };
  store.subscribe(render);
  synthStore.subscribe(render);
  render();
}
