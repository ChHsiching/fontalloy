/**
 * The custom window controls (round 4, GUI/PRODUCT-EXTENSION — the web
 * target never mounts these): with the native title bar hidden
 * (`decorations: false` in tauri.conf.json) the top bar's right end
 * carries our own 最小化/最大化/关闭 buttons, and the top bar itself
 * doubles as the drag region.
 *
 * Styling follows the kit's ghost-button language (the theme toggle's
 * scale: 30px hit height, 7px radius, sf2 hover; the close button's
 * hover is the danger red, the universal convention). The window API is
 * imported dynamically so the shared bundle never touches Tauri APIs
 * outside the shell — in a browser `mountWindowControls` is a no-op.
 */

import { isTauri } from "../platform/config";

interface TauriWindowLike {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  /** onChange listener handle (used to swap the maximize glyph). */
  onResized(cb: () => void): Promise<() => void>;
  isMaximized(): Promise<boolean>;
}

async function currentWindow(): Promise<TauriWindowLike> {
  const api = await import("@tauri-apps/api/window");
  return api.getCurrentWindow() as unknown as TauriWindowLike;
}

/** 16-grid glyphs, the close-× stroke weight of the kit's icon family. */
const GLYPHS = {
  minimize: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3.5 8h9"/></svg>',
  maximize: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>',
  restore: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 5.5h6v6h-6z"/><path d="M10.8 3.5H3.5v7.3"/></svg>',
  close: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
} as const;

export interface WindowControls {
  readonly el: HTMLElement;
  destroy(): void;
}

/**
 * Mount the three controls into `host` (the top bar's end). Returns
 * null outside Tauri — the web build renders nothing and calls no
 * window APIs.
 *
 * The drag region itself is NOT handled here: Tauri's injected drag.js
 * (verified present in the `tauri dev` page) owns `mousedown` on
 * `data-tauri-drag-region` elements — press-drag moves the window,
 * double-press toggles maximize — gated by the
 * `core:window:allow-start-dragging` capability.
 */
export function mountWindowControls(host: HTMLElement): WindowControls | null {
  if (!isTauri()) return null;

  const el = document.createElement("div");
  el.className = "win-controls";
  el.dataset.role = "window-controls";

  const make = (
    kind: "minimize" | "maximize" | "close",
    aria: string,
    onClick: (win: TauriWindowLike) => Promise<void> | void,
  ): HTMLButtonElement => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `win-ctl win-${kind}`;
    btn.dataset.role = `win-${kind}`;
    btn.setAttribute("aria-label", aria);
    btn.title = aria;
    btn.innerHTML = GLYPHS[kind];
    btn.addEventListener("click", () => {
      void (async () => {
        try {
          await onClick(await currentWindow());
        } catch {
          // A lost race with a closing window: nothing to recover.
        }
      })();
    });
    return btn;
  };

  const maxBtn = make("maximize", "最大化 / 还原", (win) => win.toggleMaximize());
  const drawMax = (maximized: boolean): void => {
    maxBtn.innerHTML = maximized ? GLYPHS.restore : GLYPHS.maximize;
  };

  el.append(
    make("minimize", "最小化", (win) => win.minimize()),
    maxBtn,
    make("close", "关闭", (win) => win.close()),
  );
  host.appendChild(el);

  // Keep the maximize glyph in sync with the real window state.
  let unlisten: (() => void) | null = null;
  let dead = false;
  void (async () => {
    try {
      const win = await currentWindow();
      drawMax(await win.isMaximized());
      unlisten = await win.onResized(() => {
        void win.isMaximized().then(drawMax);
      });
      if (dead) unlisten?.();
    } catch {
      // The dynamic import failing outside the shell is not reachable
      // (isTauri gate); a missing permission surfaces in the console.
    }
  })();

  return {
    el,
    destroy() {
      dead = true;
      unlisten?.();
      el.remove();
    },
  };
}
