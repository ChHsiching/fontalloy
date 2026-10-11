/**
 * FontAlloy kit — SceneCard.
 *
 * The stacked scene cards of the preview mode: caption, per-card theme
 * select (terminal / editor only — the document card has none), the
 * 全屏查看 expand button, and the scene body. Cards render in place —
 * no entrance choreography (round 4: the charmap has none; parallel
 * surfaces behave alike).
 *
 * The fullscreen expand itself is a kit part too (mountFullscreenScene):
 * the same body builders at full size, with prev/next/close chrome.
 */

import { mountAppSelect, type AppSelect } from "./appSelect";
import { icon } from "./icons";
import {
  buildCode,
  buildDocument,
  buildTerminal,
  type SceneContentProps,
} from "./sceneContent";
import {
  applyEditorTheme,
  applyTerminalTheme,
  EDITOR_THEME_OPTIONS,
  TERMINAL_THEME_OPTIONS,
} from "./theme";

export type SceneKind = "terminal" | "code" | "document";

export interface SceneCardProps {
  kind: SceneKind;
  /** Card caption (终端 / 代码编辑器 / 文档). */
  caption: string;
  /** Locked scene theme id; "" follows the app theme. */
  themeId?: string;
  onThemeChange?(id: string): void;
  onExpand?(kind: SceneKind): void;
  /** Forwarded to the content builders. */
  content?: SceneContentProps;
}

export interface SceneCard {
  readonly el: HTMLElement;
  render(props: SceneCardProps): void;
}

export function mountSceneCard(
  host: HTMLElement,
  initial: SceneCardProps,
): SceneCard {
  const el = document.createElement("article");
  el.className = "kit-sc";
  el.dataset.scene = initial.kind;
  host.appendChild(el);

  let props: SceneCardProps = initial;
  let body: HTMLElement | null = null;

  const buildBody = (): HTMLElement => {
    const content = props.content ?? {};
    if (props.kind === "terminal") return buildTerminal(content);
    if (props.kind === "code") return buildCode(content);
    return buildDocument(content);
  };

  const render = (): void => {
    el.innerHTML = "";
    const head = document.createElement("div");
    head.className = "kit-sc-h";
    const cap = document.createElement("span");
    cap.className = "kit-cap";
    cap.textContent = props.caption;
    head.appendChild(cap);

    if (props.kind === "terminal" || props.kind === "code") {
      const select = mountAppSelect({
        label: props.kind === "terminal" ? "终端主题" : "编辑器主题",
        value: props.themeId ?? "",
        options:
          props.kind === "terminal"
            ? TERMINAL_THEME_OPTIONS
            : EDITOR_THEME_OPTIONS,
        onChange: (id) => {
          props.themeId = id;
          if (body) {
            if (props.kind === "terminal") applyTerminalTheme(body, id);
            else applyEditorTheme(body, id);
          }
          props.onThemeChange?.(id);
        },
      });
      head.appendChild(select.el);
    }

    const expand = document.createElement("button");
    expand.type = "button";
    expand.className = "kit-zb";
    expand.setAttribute("aria-label", "全屏查看");
    expand.innerHTML = icon("expand");
    expand.addEventListener("click", () => props.onExpand?.(props.kind));
    head.appendChild(expand);

    el.appendChild(head);
    body = buildBody();
    if (props.themeId && props.kind === "terminal") {
      applyTerminalTheme(body, props.themeId);
    }
    if (props.themeId && props.kind === "code") {
      applyEditorTheme(body, props.themeId);
    }
    el.appendChild(body);
  };

  render();

  return {
    el,
    render(next) {
      props = next;
      render();
    },
  };
}

/* ---------- fullscreen scene view ---------- */

export interface FullscreenSceneProps {
  kind: SceneKind;
  caption: string;
  content?: SceneContentProps;
  /** Locked scene theme id (terminal/code only); "" follows the app theme. */
  themeId?: string;
  /** Theme change from the fullscreen bar (round 5, owner item 10). */
  onThemeChange?(id: string): void;
  /** Optional prev/next navigation between scenes. */
  onPrev?(): void;
  onNext?(): void;
  onClose(): void;
}

export interface FullscreenScene {
  /** Swap the shown scene IN PLACE — no close/reopen choreography. */
  render(props: FullscreenSceneProps): void;
  close(): void;
}

/**
 * Mount the fullscreen scene overlay inside `host` (a positioned
 * ancestor — the app frame, bounded BELOW the top bar so the window
 * chrome stays clickable). Enter rises; close sinks and fades, the
 * node is removed after the exit transition.
 *
 * Round 5 (owner items 9 + 10): the bar carries the scene THEME select
 * while zoomed (terminal/code), and `render()` swaps the content in
 * place — prev/next never closes and reopens the overlay.
 */
export function mountFullscreenScene(
  host: HTMLElement,
  props: FullscreenSceneProps,
): FullscreenScene {
  host.innerHTML = "";
  const zf = document.createElement("div");
  zf.className = "kit-zf";
  zf.setAttribute("role", "dialog");
  zf.setAttribute("aria-modal", "true");
  const bar = document.createElement("div");
  bar.className = "kit-zf-b";
  const prev = document.createElement("button");
  prev.type = "button";
  prev.className = "kit-btn sm";
  prev.textContent = "上一项";
  prev.addEventListener("click", () => current.onPrev?.());
  bar.appendChild(prev);
  const next = document.createElement("button");
  next.type = "button";
  next.className = "kit-btn sm";
  next.textContent = "下一项";
  next.addEventListener("click", () => current.onNext?.());
  bar.appendChild(next);
  // The theme select lives in the fullscreen bar for the two themed
  // cards (the document card has none, exactly like the scene cards).
  const themeHost = document.createElement("div");
  bar.appendChild(themeHost);
  const title = document.createElement("span");
  title.className = "t";
  bar.appendChild(title);
  const grow = document.createElement("span");
  grow.className = "kit-grow";
  bar.appendChild(grow);
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "kit-btn sm";
  closeBtn.textContent = "关闭";
  closeBtn.dataset.role = "fullscreen-close";
  bar.appendChild(closeBtn);

  const bodyHost = document.createElement("div");
  bodyHost.className = "kit-zf-w";
  zf.append(bar, bodyHost);
  host.appendChild(zf);

  let current: FullscreenSceneProps = props;
  let themeSelect: AppSelect | null = null;

  const syncChrome = (): void => {
    title.textContent = current.caption;
    prev.style.display = current.onPrev ? "" : "none";
    next.style.display = current.onNext ? "" : "none";
    themeHost.innerHTML = "";
    themeSelect = null;
    if (current.kind === "terminal" || current.kind === "code") {
      themeSelect = mountAppSelect({
        label: current.kind === "terminal" ? "终端主题" : "编辑器主题",
        value: current.themeId ?? "",
        options:
          current.kind === "terminal"
            ? TERMINAL_THEME_OPTIONS
            : EDITOR_THEME_OPTIONS,
        onChange: (id) => {
          current.themeId = id;
          const body = bodyHost.firstElementChild;
          if (body) {
            if (current.kind === "terminal") applyTerminalTheme(body as HTMLElement, id);
            else applyEditorTheme(body as HTMLElement, id);
          }
          current.onThemeChange?.(id);
        },
      });
      themeSelect.el.dataset.role = "fullscreen-theme";
      themeHost.appendChild(themeSelect.el);
    }
  };

  const fill = (): void => {
    bodyHost.innerHTML = "";
    const content = { ...current.content, full: true };
    const body =
      current.kind === "terminal"
        ? buildTerminal(content)
        : current.kind === "code"
          ? buildCode(content)
          : buildDocument(content);
    if (current.themeId && current.kind === "terminal") {
      applyTerminalTheme(body, current.themeId);
    }
    if (current.themeId && current.kind === "code") {
      applyEditorTheme(body, current.themeId);
    }
    bodyHost.appendChild(body);
  };

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    zf.classList.add("out");
    setTimeout(() => {
      if (host.contains(zf)) host.innerHTML = "";
    }, 170);
  };

  closeBtn.addEventListener("click", close);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !closed) close();
  });

  syncChrome();
  fill();
  closeBtn.focus();
  return {
    render(next) {
      if (closed) return;
      current = next;
      // Content swaps IN PLACE: only the body and the bar labels move,
      // the overlay itself never closes and reopens (round 5).
      syncChrome();
      fill();
    },
    close,
  };
}
