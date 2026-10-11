import { store } from "../state";
import { synthStore } from "../service/state";
import { synthesize, synthesizeReady } from "../service/synthesize";
import { mountTopBar, type TopBar } from "../kit/topBar";
import { applyAppTheme, type AppTheme } from "../kit/theme";

/**
 * Top bar (ADR-0004 + the validated prototype's chrome): the brand, the
 * current font pair as text tags, the GitHub repo link, the light/dark
 * theme toggle, the output font-name field (default ChHsich, feeding the
 * recipe's output.family — ADR-0005), and the primary 合成字体 action —
 * assembled from the kit's TopBar parts, wired to the app's stores.
 *
 * The explanation for a disabled action is click-reachable page text,
 * never a hover-only tooltip (ADR-0004).
 */

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

/** The boot theme: the OS preference (the demo page's convention). */
function initialTheme(): AppTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function mountTopbar(root: HTMLElement): TopBar {
  applyAppTheme(initialTheme());

  const topBar = mountTopBar(root, {
    base: "—",
    donor: "—",
    fontName: store.get().outputFamily,
    onFontName: (value) => store.set({ outputFamily: value.trim() }),
    onSynthesize: () => {
      const reason = disabledReason();
      if (reason !== null) {
        notice.querySelector<HTMLElement>(".notice-text")!.textContent = reason;
        notice.hidden = false;
        return;
      }
      void synthesize();
    },
  });

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
  notice
    .querySelector<HTMLButtonElement>(".notice-close")!
    .addEventListener("click", () => {
      notice.hidden = true;
    });

  const synthesizeEl = topBar.el.querySelector<HTMLButtonElement>(
    "[data-role='synthesize']",
  )!;

  const render = (): void => {
    const { fonts, selected } = store.get();
    const label = (key: string | null): string => {
      const font = fonts.find((f) => f.cssFamily === key);
      return font ? font.family : "—";
    };
    topBar.setPair(label(selected.en), label(selected.cjk));
    // The service state and the pick pair both feed the enablement.
    synthesizeEl.setAttribute("aria-disabled", String(!synthesizeReady()));
  };
  store.subscribe(render);
  synthStore.subscribe(render);
  render();
  return topBar;
}
