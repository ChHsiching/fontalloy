/**
 * FontAlloy kit — SceneCard.
 *
 * The stacked scene cards of the preview mode: caption, per-card theme
 * select (terminal / editor only — the document card has none), the
 * 全屏查看 expand button, and the scene body. Cards enter with a
 * staggered rise; the consumer gates replay with the no-in class
 * (content-only re-renders must not replay the entrance).
 *
 * The fullscreen expand itself is a kit part too (mountFullscreenScene):
 * the same body builders at full size, with prev/next/close chrome.
 */

import { mountAppSelect } from "./appSelect";
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
  /** Optional prev/next navigation between scenes. */
  onPrev?(): void;
  onNext?(): void;
  onClose(): void;
}

/**
 * Mount the fullscreen scene overlay inside `host` (a positioned
 * ancestor — the app frame). Enter rises; close sinks and fades, the
 * node is removed after the exit transition.
 */
export function mountFullscreenScene(
  host: HTMLElement,
  props: FullscreenSceneProps,
): { close(): void } {
  host.innerHTML = "";
  const zf = document.createElement("div");
  zf.className = "kit-zf";
  zf.setAttribute("role", "dialog");
  zf.setAttribute("aria-modal", "true");
  const bar = document.createElement("div");
  bar.className = "kit-zf-b";
  if (props.onPrev) {
    const prev = document.createElement("button");
    prev.type = "button";
    prev.className = "kit-btn sm";
    prev.textContent = "上一项";
    prev.addEventListener("click", props.onPrev);
    bar.appendChild(prev);
  }
  if (props.onNext) {
    const next = document.createElement("button");
    next.type = "button";
    next.className = "kit-btn sm";
    next.textContent = "下一项";
    next.addEventListener("click", props.onNext);
    bar.appendChild(next);
  }
  const title = document.createElement("span");
  title.className = "t";
  title.textContent = props.caption;
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

  let closed = false;
  const fill = (): void => {
    bodyHost.innerHTML = "";
    const content = { ...props.content, full: true };
    bodyHost.appendChild(
      props.kind === "terminal"
        ? buildTerminal(content)
        : props.kind === "code"
          ? buildCode(content)
          : buildDocument(content),
    );
    title.textContent = props.caption;
  };

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

  fill();
  closeBtn.focus();
  return { close };
}
