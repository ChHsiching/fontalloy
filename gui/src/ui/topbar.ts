import { store } from "../state";
import { synthStore } from "../service/state";
import { synthesize, synthesizeReady } from "../service/synthesize";
import { mountTopBar, type TopBar } from "../kit/topBar";
import { applyStoredThemePreference } from "../kit/theme";
import { variantDisplayName } from "./picker";
import { openCliPanel } from "./noservice";
import { mountWindowControls } from "./wincontrols";
import { isTauri } from "../platform/config";

/**
 * Top bar (ADR-0004 + the validated prototype's chrome): the brand, the
 * current font pair as text tags, the GitHub repo link, the light/dark
 * theme toggle, the output font-name field (default ChHsich, feeding the
 * recipe's output.family — ADR-0005), and the primary 合成字体 action —
 * assembled from the kit's TopBar parts, wired to the app's stores.
 *
 * The explanation for a disabled action is click-reachable page text,
 * never a hover-only tooltip (ADR-0004).
 *
 * Under Tauri the native title bar is hidden (round 4): the bar's empty
 * stretches become the drag region and its right end carries the custom
 * 最小化/最大化/关闭 controls. The web target mounts none of this.
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

export function mountTopbar(root: HTMLElement): TopBar {
  // Round 5 (owner item 8): the boot theme is the PERSISTED preference
  // (自动 by default — following the system, live).
  applyStoredThemePreference();

  const topBar = mountTopBar(root, {
    base: "",
    donor: "",
    fontName: store.get().outputFamily,
    onFontName: (value) => store.set({ outputFamily: value.trim() }),
    // Round 5 (owner item 12): under Tauri the webview cannot open
    // tabs — the GitHub link routes through the shell's open_external
    // and the SYSTEM browser launches. The web target keeps the normal
    // anchor navigation (no intercept).
    onGithubNavigate: isTauri()
      ? (url) => {
          void (async () => {
            const { invoke } = await import("@tauri-apps/api/core");
            try {
              await invoke("open_external", { url });
            } catch {
              // Stay inert; a dead link must not error into the bar.
            }
          })();
          return true;
        }
      : undefined,
    onSynthesize: () => {
      const reason = disabledReason();
      if (reason !== null) {
        notice.querySelector<HTMLElement>(".notice-text")!.textContent = reason;
        notice.hidden = false;
        // Without a service the flow offers the CLI alternative (the
        // absorbed #22 builder): copy-CLI command + recipe YAML
        // download as the workspace's own no-service state.
        const { service } = synthStore.get();
        if (service.status === "none" || service.status === "unavailable") {
          openCliPanel();
        }
        return;
      }
      void synthesize();
    },
  });

  // The custom window chrome (round 4, GUI only): the bar itself and
  // its grow spacer drag the undecorated window; the controls live at
  // its right end. `data-tauri-drag-region` must sit on the element
  // the press actually lands on, hence both the bar and the spacer.
  // The whole block is Tauri-gated — the web target carries no window
  // chrome at all.
  if (isTauri()) {
    topBar.el.dataset.tauriDragRegion = "";
    topBar.el
      .querySelector<HTMLElement>(".kit-grow")
      ?.setAttribute("data-tauri-drag-region", "");
    mountWindowControls(topBar.el);
  }

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
      // Empty picks hide their tag (the kit's set() treats "" as absent).
      // Catalog picks render the VARIANT'S REAL NAME (round 8, owner
      // item 7) — the display family plus the cut's official label
      // (「Maple Mono NF-CN」), the same identity the rail card and the
      // report carry, never the raw manifest id or a hardcoded suffix.
      return font ? variantDisplayName(font) : "";
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
