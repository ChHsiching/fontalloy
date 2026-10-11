import { store } from "../state";
import { liveResolver } from "../precedence/live";
import { refFont } from "../precedence/picks";
import { cssFamily } from "../kit/pickerPopup";
import {
  mountSceneCard,
  mountFullscreenScene,
  type SceneCard,
  type SceneKind,
} from "../kit/sceneCard";
import type { SceneContentProps } from "../kit/sceneContent";
import { formatCp } from "./charmap";

/**
 * The real-world scene previews (issue #19, ADR-0004): the kit's three
 * stacked scene cards — 终端 / 代码编辑器 / 文档 — each visible at once,
 * each with its own theme select (14 terminal / 10 editor palettes) and
 * its 全屏查看 expand.
 *
 * Every character renders in the font that would WIN it in the merge —
 * the same memoized `EffectiveResolver` the preview grid resolves
 * through, never a separate path — and carries its resolution as DOM
 * attributes (`data-winner` / `data-via` / `data-kind`), so the scenes
 * are walkable exactly like the grid.
 *
 * The card entrance plays once per mode switch; content-only
 * re-renders (a rule landed, a pick changed, the custom preview text
 * typed) render through the no-in gate (the prototype's r30 lesson).
 */

const CAPTIONS: Record<SceneKind, string> = {
  terminal: "终端",
  code: "代码编辑器",
  document: "文档",
};

/** Per-card scene themes ("" follows the app theme). */
const themeState: Record<"terminal" | "code", string> = {
  terminal: "",
  code: "",
};

/** The fullscreen host (a positioned ancestor — the app frame). */
let zoomHost: HTMLElement | null = null;

const KINDS: SceneKind[] = ["terminal", "code", "document"];

function openFullscreen(kind: SceneKind): void {
  if (!zoomHost) return;
  let index = KINDS.indexOf(kind);
  mountFullscreenScene(zoomHost, {
    kind,
    caption: CAPTIONS[kind],
    content: contentProps(),
    onPrev: () => {
      index = (index - 1 + KINDS.length) % KINDS.length;
      openFullscreen(KINDS[index]!);
    },
    onNext: () => {
      index = (index + 1) % KINDS.length;
      openFullscreen(KINDS[index]!);
    },
    onClose: () => undefined,
  });
}

const MONO_TAIL = "Consolas,ui-monospace,monospace";
const SANS_TAIL = '"Segoe UI","Microsoft YaHei",sans-serif';

function isCjkChar(ch: string): boolean {
  return /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch);
}

/** The content props resolving every character through the live resolver. */
function contentProps(): SceneContentProps {
  const { picks, resolver } = liveResolver();
  return {
    customText: store.get().customPreview || undefined,
    resolveFont: (ch) => {
      const cp = ch.codePointAt(0)!;
      const entry = resolver ? resolver.resolve(cp) : null;
      if (entry) {
        const font = refFont(entry.winner, picks);
        if (font) return `${cssFamily(font.cssFamily)},sans-serif`;
      }
      // The fallback stack: the picked pair (whichever holds), then the
      // system tail — the same ordering the plain grid preview uses.
      const candidates = isCjkChar(ch)
        ? [picks.donor, picks.base]
        : [picks.base, picks.donor];
      for (const font of candidates) {
        if (font && font.codepoints.includes(cp)) {
          return `${cssFamily(font.cssFamily)},${isCjkChar(ch) ? SANS_TAIL : MONO_TAIL}`;
        }
      }
      return isCjkChar(ch) ? SANS_TAIL : MONO_TAIL;
    },
    spanAttrs: (ch) => {
      const cp = ch.codePointAt(0)!;
      const entry = resolver ? resolver.resolve(cp) : null;
      if (!entry) return undefined;
      return {
        cp: formatCp(cp),
        winner: entry.winner,
        via: entry.via,
        kind: entry.kind,
      };
    },
  };
}

export function mountScenes(root: HTMLElement, fullscreenHost: HTMLElement): void {
  zoomHost = fullscreenHost;
  root.innerHTML = `<div class="kit-scene-wrap"></div>`;
  const wrap = root.querySelector<HTMLElement>(".kit-scene-wrap")!;

  const cardProps = (kind: SceneKind) => ({
    kind,
    caption: CAPTIONS[kind],
    themeId: kind === "document" ? "" : themeState[kind],
    onThemeChange: (id: string): void => {
      if (kind !== "document") themeState[kind] = id;
    },
    onExpand: (k: SceneKind): void => openFullscreen(k),
    content: contentProps(),
  });

  const cards = new Map<SceneKind, SceneCard>();
  for (const kind of KINDS) {
    cards.set(kind, mountSceneCard(wrap, cardProps(kind)));
  }

  let sceneEntrance = true;
  let lastSignature: string | null = null;

  /** Re-render the card bodies (entrance only on a fresh mode entry). */
  function renderScenes(withEntrance: boolean): void {
    wrap.classList.toggle("no-in", !withEntrance);
    for (const [kind, card] of cards) {
      card.render(cardProps(kind));
    }
  }

  const render = (): void => {
    const { rules, customPreview } = store.get();
    const { picks } = liveResolver();
    const signature = `${rules.length}:${rules
      .map((r) => `${r.id}:${JSON.stringify(r.target)}:${r.fonts.join(",")}`)
      .join("|")}:${picks.base?.cssFamily ?? ""}:${picks.donor?.cssFamily ?? ""}:${customPreview}`;
    if (signature === lastSignature) return;
    lastSignature = signature;
    renderScenes(sceneEntrance);
    sceneEntrance = false;
  };
  store.subscribe(render);
  render();
}
