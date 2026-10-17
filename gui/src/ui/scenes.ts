import { store } from "../state";
import {
  liveDocument,
  lookupEntry,
  precedenceStore,
  precedenceVersion,
} from "../precedence/document";
import { pickRefs, refFont } from "../precedence/picks";
import { cssFamily } from "../kit/pickerPopup";
import {
  mountSceneCard,
  mountFullscreenScene,
  type FullscreenScene,
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
 * the same landed precedence document the preview grid reads (ticket
 * #35: `POST /precedence-resolve` once per picks/rules change; never
 * a separate resolution path) — and carries its resolution as DOM
 * attributes (`data-winner` / `data-via` / `data-kind`), so the scenes
 * are walkable exactly like the grid.
 *
 * Cards render in place with no entrance choreography (round 4: the
 * charmap has none; parallel surfaces behave alike). A signature guard
 * still skips no-op re-renders.
 *
 * Fullscreen (round 5, owner items 9 + 10): the overlay never covers
 * the top bar (its host is bounded below it — see main.ts), its zoomed
 * type stays comfortable, its bar carries the THEME select, and
 * prev/next swap the content IN PLACE — no close-then-reopen
 * choreography. Theme changes made in the fullscreen bar flow back
 * into the cards (one shared themeState).
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

/** The live fullscreen overlay (null while none is open). */
let fullscreen: FullscreenScene | null = null;

const KINDS: SceneKind[] = ["terminal", "code", "document"];

/** The kind the fullscreen overlay currently shows (null while closed). */
let fullscreenKind: SceneKind | null = null;

/** Re-renders the stacked cards (set by mountScenes; the fullscreen
 *  bar's theme changes call it so both surfaces stay in sync). */
let renderCards: (() => void) | null = null;

/** The fullscreen props for one scene kind. */
function fullscreenProps(kind: SceneKind): Parameters<FullscreenScene["render"]>[0] {
  return {
    kind,
    caption: CAPTIONS[kind],
    themeId: kind === "document" ? "" : themeState[kind],
    content: contentProps(),
    onThemeChange: (id: string): void => {
      if (kind !== "document") themeState[kind] = id;
      renderCards?.();
    },
    onPrev: (): void => step(-1),
    onNext: (): void => step(1),
    onClose: (): void => undefined,
  };
}

/** Open the fullscreen overlay on one scene (fresh entry each time). */
function openFullscreen(kind: SceneKind): void {
  if (!zoomHost) return;
  fullscreen?.close();
  fullscreenKind = kind;
  fullscreen = mountFullscreenScene(zoomHost, fullscreenProps(kind));
}

/** Prev/next IN PLACE: swap the content, keep the overlay mounted. */
function step(delta: number): void {
  if (fullscreen === null || fullscreenKind === null) return;
  const index = KINDS.indexOf(fullscreenKind);
  fullscreenKind = KINDS[(index + delta + KINDS.length) % KINDS.length]!;
  fullscreen.render(fullscreenProps(fullscreenKind));
}

const MONO_TAIL = "Consolas,ui-monospace,monospace";
const SANS_TAIL = '"Segoe UI","Microsoft YaHei",sans-serif';

function isCjkChar(ch: string): boolean {
  return /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch);
}

/** The content props resolving every character through the landed
 *  precedence document (the same one the grid reads). */
function contentProps(): SceneContentProps {
  const picks = pickRefs();
  const doc = liveDocument();
  return {
    customText: store.get().customPreview || undefined,
    resolveFont: (ch) => {
      const cp = ch.codePointAt(0)!;
      const entry = doc !== null ? lookupEntry(doc, cp) : null;
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
    spanAttrs: (ch): Record<string, string> | undefined => {
      // Every span carries its codepoint (walkable like the grid); the
      // winner/via/kind provenance marks the covered ones — an uncovered
      // character is a span with data-cp and no data-winner.
      const cp = ch.codePointAt(0)!;
      const entry = doc !== null ? lookupEntry(doc, cp) : null;
      if (!entry) return { cp: formatCp(cp) };
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

  let lastSignature: string | null = null;

  const render = (): void => {
    const { rules, customPreview } = store.get();
    const picks = pickRefs();
    // The document's version rides in the signature: a landed resolve
    // re-renders the characters even when the store itself stood still.
    const signature = `${rules.length}:${rules
      .map((r) => `${r.id}:${JSON.stringify(r.target)}:${r.fonts.join(",")}`)
      .join("|")}:${picks.base?.cssFamily ?? ""}:${picks.donor?.cssFamily ?? ""}:${customPreview}:${precedenceVersion()}`;
    if (signature === lastSignature) return;
    lastSignature = signature;
    for (const [kind, card] of cards) {
      card.render(cardProps(kind));
    }
    // An open fullscreen overlay follows the same state in place.
    if (fullscreen !== null && fullscreenKind !== null) {
      fullscreen.render(fullscreenProps(fullscreenKind));
    }
  };
  renderCards = render;
  store.subscribe(render);
  precedenceStore.subscribe(render);
  render();
}
