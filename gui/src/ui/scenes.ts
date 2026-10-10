import { store } from "../state";
import { liveResolver } from "../precedence/live";
import { refFont } from "../precedence/picks";
import { cssFamily } from "./picker";
import { formatCp } from "./charmap";

/**
 * The real-world scene previews (issue #19, ADR-0004): terminal / code /
 * document samples of mixed CJK+Latin text, each character rendered in
 * the font that would WIN it in the merge — the same memoized
 * `EffectiveResolver` the preview grid resolves through, never a
 * separate path. Every character carries its resolution as DOM
 * attributes (`data-winner` / `data-via` / `data-kind`), so the scenes
 * are walkable exactly like the grid.
 *
 * The samples are honest about being a PRE-merge approximation: the
 * per-codepoint winner fonts render side by side, but normalization
 * (the 2:1 grid, scale schools) belongs to the built font — the note
 * line above the stage says so in plain text.
 */

/** One line of a monospaced scene (terminal / code). */
interface SceneLine {
  text: string;
}

interface SceneDef {
  id: "terminal" | "code" | "document";
  tab: string;
  /** Line numbers rendered in a gutter (the code scene). */
  lineNumbers?: boolean;
  /** Hard lines (terminal / code) or paragraph flow (the document). */
  lines?: SceneLine[];
  paragraphs?: string[];
  heading?: string;
}

const TERMINAL: SceneDef = {
  id: "terminal",
  tab: "终端",
  lines: [
    { text: "fontalloy ~ ❯ ls -la" },
    { text: "total 48" },
    { text: "drwxr-xr-x  12 chen  staff   384 10月 10 09:41 ." },
    { text: "drwxr-xr-x   8 chen  staff   256 10月  9 18:03 .." },
    { text: "-rw-r--r--   1 chen  staff  6148 10月  8 22:17 .gitignore" },
    { text: "-rw-r--r--   1 chen  staff  8192 10月 10 09:12 README.md" },
    { text: "-rw-r--r--   1 chen  staff  1024 10月 10 09:12 字体清单.txt" },
    { text: "-rw-r--r--   1 chen  staff  2048 10月  9 21:55 recipe.yaml" },
    { text: "fontalloy ~ ❯ fontalloy build recipe.yaml" },
    { text: "读取配方 recipe.yaml …" },
    { text: "基底 JetBrains Mono · 供体 Source Han Sans SC" },
    { text: "[1/7] 加载字体    [2/7] 解析规则" },
    { text: "[3/7] 子集化供体  [4/7] 度量归一" },
    { text: "[5/7] 嫁接字形    [6/7] 重写表" },
    { text: "[7/7] 输出并校验" },
    { text: "✓ ChHsich-Regular.ttf 已生成（1,024 码位）" },
    { text: "fontalloy ~ ❯ ls 一下 ChHsich-Regular.ttf" },
    { text: "ChHsich-Regular.ttf" },
    { text: "fontalloy ~ ❯ _" },
  ],
};

const CODE: SceneDef = {
  id: "code",
  tab: "代码",
  lineNumbers: true,
  lines: [
    { text: "// merge.ts — 将中文字体并入英文等宽字体（三个约定，窄者胜）" },
    { text: 'import { loadFaces, resolveRules, graft } from "@fontalloy/core";' },
    { text: "" },
    { text: "export function merge(recipe: Recipe): Font {" },
    { text: "  // 基底是容器：供体字形按码位嫁接，输出继承基底的度量" },
    { text: "  const base = loadFaces(recipe.base);" },
    { text: "  const donors = recipe.donors.map(loadFaces);" },
    { text: "" },
    { text: "  // 优先级：单码位 > 自定义区间 > 语言预设 > 全局默认" },
    { text: "  const table = resolveRules(recipe.rules, { base, donors });" },
    { text: "" },
    { text: "  // 缺位不覆盖：字体缺少字形时跳过，回落交给下一位持有者" },
    { text: "  const merged = graft(base, donors, table);" },
    { text: "" },
    { text: "  if (import.meta.env.DEV) {" },
    { text: '    console.debug(`merged ${table.size} codepoints`);' },
    { text: "  }" },
    { text: "  return merged; // 行高继承基底，usWinAscent 只增不减" },
    { text: "}" },
  ],
};

const DOCUMENT: SceneDef = {
  id: "document",
  tab: "文档",
  heading: "字体合成的三个承诺",
  paragraphs: [
    "FontAlloy 以一款英文等宽字体为容器，把中文字体按码位嫁接进来：写代码时看到的英文不变，中文回落不再交给系统随机挑选。合并的规则只有一个形状——码位范围映射到有序的字体列表。",
    "其一，窄者胜。码位规则的优先级由窄到广：单码位高于区间，区间高于语言预设，预设之上才是全局默认；同一层里，后声明的胜过先声明的。其二，缺位不覆盖。字体缺少某个字形时绝不顶掉已有的字形，回落交给列表里的下一位持有者。其三，所见即所得。预览网格与实景预览走同一条解析路径，一格一字，从不撒谎。",
    "在终端里，每个汉字恰好占两个英文字符的宽度（2:1 网格）；全角引号与破折号占一格还是两格，由「中文字符宽度」设置决定。中文与英文共用同一条基线，上下不一、大小失衡的老问题就此收场。",
  ],
};

const SCENES: SceneDef[] = [TERMINAL, CODE, DOCUMENT];

function sceneById(id: string): SceneDef {
  return SCENES.find((scene) => scene.id === id) ?? TERMINAL;
}

/** The fallback stack for characters no build font covers. */
function fallbackStack(
  scene: SceneDef,
  en: string | null,
  cjk: string | null,
): string {
  const monoTail = ['"Cascadia Mono"', '"Consolas"', "monospace"];
  const sansTail = ['"Segoe UI"', "Microsoft YaHei", "sans-serif"];
  const tail = scene.id === "document" ? sansTail : monoTail;
  return [en, cjk]
    .map((key) => (key ? cssFamily(key) : ""))
    .filter(Boolean)
    .concat(tail)
    .join(",");
}

export function mountScenes(root: HTMLElement): void {
  root.innerHTML = `
    <div class="scene-tabs" role="tablist" aria-label="实景类型">
      ${SCENES.map(
        (scene) =>
          `<button class="scene-tab" role="tab" data-scene="${scene.id}" aria-selected="false">${scene.tab}</button>`,
      ).join("")}
    </div>
    <div class="scene-note" data-role="scene-note"></div>
    <div class="scene-stage"></div>
  `;

  const tabs = [...root.querySelectorAll<HTMLButtonElement>(".scene-tab")];
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      if (store.get().sceneId !== tab.dataset.scene) {
        store.set({ sceneId: tab.dataset.scene as typeof TERMINAL.id });
      }
    });
  }
  const note = root.querySelector<HTMLElement>("[data-role='scene-note']")!;
  const stage = root.querySelector<HTMLElement>(".scene-stage")!;

  let lastSignature: string | null = null;
  const render = (): void => {
    const { sceneId, selected, rules } = store.get();
    const scene = sceneById(sceneId);
    for (const tab of tabs) {
      tab.setAttribute("aria-selected", String(tab.dataset.scene === scene.id));
      tab.classList.toggle("is-selected", tab.dataset.scene === scene.id);
    }

    const { picks, resolver } = liveResolver();
    const effective = picks.base !== null && picks.donor !== null;
    note.textContent = effective
      ? "实景以各码位的生效字体原样渲染（合成前的近似预览，未模拟度量归一与字重并入）。"
      : "选择英文字体与中文字体后，此处将以合成后的实际效果渲染。";

    const signature = `${scene.id}:${rules.length}:${rules
      .map((r) => `${r.id}:${JSON.stringify(r.target)}:${r.fonts.join(",")}`)
      .join("|")}:${picks.base?.cssFamily ?? ""}:${picks.donor?.cssFamily ?? ""}`;
    if (signature === lastSignature) return;
    lastSignature = signature;

    const panel = document.createElement("div");
    panel.className = `scene-panel scene-${scene.id}`;
    panel.dataset.scene = scene.id;

    if (scene.id === "terminal") {
      const chrome = document.createElement("div");
      chrome.className = "scene-chrome";
      chrome.innerHTML = `
        <span class="scene-dot" aria-hidden="true"></span>
        <span class="scene-dot" aria-hidden="true"></span>
        <span class="scene-dot" aria-hidden="true"></span>
        <span class="scene-chrome-title">fontalloy — zsh</span>
      `;
      panel.appendChild(chrome);
    }

    const body = document.createElement("div");
    body.className = "scene-body";
    body.style.fontFamily = fallbackStack(
      scene,
      selected.en,
      selected.cjk,
    );

    if (scene.paragraphs) {
      if (scene.heading) {
        const h = document.createElement("h2");
        h.className = "scene-doc-heading";
        h.textContent = scene.heading;
        body.appendChild(h);
      }
      for (const text of scene.paragraphs) {
        const p = document.createElement("p");
        p.className = "scene-doc-paragraph";
        renderInto(p, text, resolver, picks, ", sans-serif");
        body.appendChild(p);
      }
    } else {
      for (const [index, line] of (scene.lines ?? []).entries()) {
        const lineEl = document.createElement("div");
        lineEl.className = "scene-line";
        if (scene.lineNumbers) {
          const no = document.createElement("span");
          no.className = "scene-lineno";
          no.textContent = String(index + 1);
          lineEl.appendChild(no);
        }
        const text = document.createElement("span");
        text.className = "scene-line-text";
        renderInto(text, line.text, resolver, picks, ", monospace");
        lineEl.appendChild(text);
        body.appendChild(lineEl);
      }
    }
    panel.appendChild(body);
    stage.replaceChildren(panel);
  };
  store.subscribe(render);
  render();
}

/**
 * Render `text` as one span per codepoint, each resolved through the
 * live effective resolver: the winner's own face renders it, and the
 * resolution is exposed as DOM attributes (the grid's vocabulary).
 */
function renderInto(
  container: HTMLElement,
  text: string,
  resolver: ReturnType<typeof liveResolver>["resolver"],
  picks: ReturnType<typeof liveResolver>["picks"],
  stackTail: string,
): void {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const span = document.createElement("span");
    span.className = "scene-char";
    span.dataset.cp = formatCp(cp);
    span.textContent = ch;
    const entry = resolver ? resolver.resolve(cp) : null;
    if (entry) {
      span.dataset.winner = entry.winner;
      span.dataset.via = entry.via;
      span.dataset.kind = entry.kind;
      const font = refFont(entry.winner, picks);
      if (font) {
        span.style.fontFamily = `${cssFamily(font.cssFamily)}${stackTail}`;
      }
    } else {
      span.classList.add("is-uncovered");
    }
    container.appendChild(span);
  }
}
