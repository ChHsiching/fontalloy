/**
 * FontAlloy kit — scene content builders.
 *
 * The three real-world preview bodies (terminal / code editor /
 * document) with the prototype's sample content, which is part of the
 * design contract. Rendering rules carried from the validated
 * prototype:
 *
 * - every character renders as its own span with the EFFECTIVE font
 *   for that codepoint (`resolveFont`), so the preview shows the merge
 *   result itself;
 * - spaces inside styled spans are NBSP — raw text-node spaces inherit
 *   the UI font (narrower) and collapse across span boundaries, both of
 *   which misalign monospace columns (docker ps table);
 * - the code scene tokenizes keywords / strings / numbers / types /
 *   comments for the editor theme classes (k / s / n / t / cm).
 */

/** CSS font stack for one character (the effective merge preview). */
export type FontResolver = (ch: string) => string;

/** Extra data attributes for one character span (winner/via/kind...). */
export type SpanAttrs = (ch: string) => Record<string, string> | undefined;

export interface SceneContentProps {
  /** Resolve the font for each character; default: CJK vs base split. */
  resolveFont?: FontResolver;
  /**
   * Data attributes for each character span (e.g. the effective
   * resolution provenance), so consumers' scenes walk the DOM exactly
   * like their grids. Absent keys leave the attribute unset.
   */
  spanAttrs?: SpanAttrs;
  /** Full variant (fullscreen view) adds the extra sections. */
  full?: boolean;
  /** The document scene's custom preview text (自定义预览文字). */
  customText?: string;
}

const MONO_BASE = "Consolas,ui-monospace,monospace";
const MONO_CJK = "'Microsoft YaHei',sans-serif";

function defaultResolveFont(ch: string): string {
  return /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch)
    ? MONO_CJK
    : MONO_BASE;
}

/* ---------- terminal ---------- */

export interface TerminalLine {
  text: string;
  className: string;
}

export const TERMINAL_LINES: readonly TerminalLine[] = [
  { text: "❯ git log --oneline -7", className: "t-p" },
  { text: "  a3f8e2d feat: 添加中文标点支持", className: "" },
  { text: "  7b1c4af fix: 修复全角数字宽度不对齐", className: "" },
  { text: "  e9d3f01 refactor: 抽取编码范围解析", className: "" },
  { text: "  4c2a8be docs: 更新 README 中的安装说明", className: "" },
  { text: "  f8d1e3c chore: 升级 fontTools 到 4.53", className: "" },
  { text: "  2b9f4d1 feat: 支持 Nerd Font 图标合并", className: "t-c" },
  { text: "  c7e5a09 initial commit", className: "t-d" },
  { text: "", className: "" },
  { text: "❯ docker ps", className: "t-p" },
  { text: "  CONTAINER   IMAGE          STATUS         PORTS", className: "t-d" },
  { text: "  fontalloy   fontalloy:dev  Up 2 hours     0.0.0.0:3000->3000/tcp", className: "t-w" },
  { text: "  postgres    pg:16          Up 2 hours     5432/tcp", className: "t-w" },
  { text: "", className: "" },
  { text: "❯ npm run build", className: "t-p" },
  { text: "  ✔ compiled 42 modules in 1.2s", className: "t-c" },
  { text: "  ✔ dist/fontalloy.js  284.1 kB", className: "t-c" },
  { text: "  ✔ dist/fontalloy.css 12.3 kB", className: "t-c" },
  { text: "", className: "" },
  { text: "❯ echo \"Hello 世界 fontalloy\"", className: "t-p" },
  { text: "  Hello 世界 fontalloy", className: "t-w" },
  { text: "  ←→↑↓ ⇔⇒⇕ ✔✘ ≈≠≤≥ ±×÷", className: "t-c" },
];

export const TERMINAL_LINES_FULL: readonly TerminalLine[] = [
  ...TERMINAL_LINES,
  { text: "", className: "" },
  { text: "❯ fontalloy --help", className: "t-p" },
  { text: "  Usage: fontalloy [command] [options]", className: "t-d" },
  { text: "  build     合成字体", className: "t-w" },
  { text: "  preview   预览合成效果", className: "t-w" },
  { text: "  export    导出配方文件", className: "t-w" },
  { text: "  list      列出可用的字体", className: "t-w" },
];

export function buildTerminal(props: SceneContentProps = {}): HTMLElement {
  const resolve = props.resolveFont ?? defaultResolveFont;
  const term = document.createElement("div");
  term.className = "kit-term";
  const lines = props.full ? TERMINAL_LINES_FULL : TERMINAL_LINES;
  for (const line of lines) {
    for (const ch of line.text) {
      const span = document.createElement("span");
      if (line.className) span.className = line.className;
      span.textContent = ch === " " ? "\u00A0" : ch;
      span.style.fontFamily = resolve(ch);
      applySpanAttrs(span, ch, props.spanAttrs);
      term.appendChild(span);
    }
    term.appendChild(document.createElement("br"));
  }
  return term;
}

/** Dataset attributes from the consumer's spanAttrs (dataset = safe keys). */
function applySpanAttrs(
  span: HTMLElement,
  ch: string,
  spanAttrs: SpanAttrs | undefined,
): void {
  if (!spanAttrs) return;
  const attrs = spanAttrs(ch);
  if (!attrs) return;
  for (const [key, value] of Object.entries(attrs)) {
    span.dataset[key] = value;
  }
}

/* ---------- code editor ---------- */

export const CODE_LINES: readonly string[] = [
  'import { FC, useState, useMemo, useCallback } from "react";',
  'import { FontCard, CharacterGrid, Toolbar } from "./components";',
  'import { useFontMerge, useFontPreview } from "./hooks";',
  'import type { MergeConfig, CharSource } from "./types";',
  "",
  "/** 字体合成工作区：管理合成配置与字符来源 */",
  "interface WorkspaceProps {",
  "  initialConfig?: Partial<MergeConfig>;",
  "  onConfigChange?: (config: MergeConfig) => void;",
  "}",
  "",
  "const FontWorkspace: FC<WorkspaceProps> = ({ initialConfig }) => {",
  "  // 英文字体提供骨架，中文字体补齐汉字与标点",
  "  const [config, setConfig] = useState<MergeConfig>({",
  '    baseFont: "JetBrains Mono",',
  '    cjkFont: "Maple Mono CN",',
  "    coverage: 0.9997, // 目标覆盖率",
  "    overrides: new Map<string, CharSource>(),",
  "    ...initialConfig,",
  "  });",
  "",
  "  const { result, isLoading } = useFontMerge(config);",
  "  const { preview, setPreviewSize } = useFontPreview(result);",
  "",
  "  // 统计总字符数、缺失字符与手动调整数量",
  "  const stats = useMemo(() => ({",
  "    total: result?.characterCount ?? 0,",
  "    missing: result?.missingChars ?? [],",
  "    adjusted: config.overrides.size,",
  "  }), [result, config.overrides]);",
  "",
  "  // 单个字符改用另一侧字体时更新覆盖表",
  "  const handleOverride = useCallback((char: string, source: CharSource) => {",
  "    setConfig(prev => ({",
  "      ...prev,",
  "      overrides: new Map(prev.overrides).set(char, source),",
  "    }));",
  "  }, []);",
  "",
  '  if (isLoading) return <LoadingSpinner label="正在合成字体" />;',
  "",
  "  return (",
  '    <div className="workspace" data-theme={config.theme}>',
  "      <Toolbar",
  "        config={config}",
  "        onConfigChange={setConfig}",
  "        onBuild={() => buildFont(config)}",
  "      />",
  "      <CharacterGrid",
  "        characters={result?.grid ?? []}",
  "        onOverride={handleOverride}",
  "        showCodepoints={config.showCodepoints}",
  "      />",
  "      <StatusBar stats={stats} />",
  "    </div>",
  "  );",
  "};",
  "",
  "export default FontWorkspace;",
];

const KEYWORDS = new Set([
  "import", "export", "const", "function", "return", "if", "else",
  "type", "interface", "extends", "new", "throw", "async", "await", "from",
]);
const TYPES = new Set([
  "string", "number", "boolean", "React", "FC", "Props", "Node",
  "CSSProperties",
]);

const TOKEN_RE =
  /"(?:[^"]*)"|\/\/.*$|\/\*.*?\*\/|\b(?:import|export|const|function|return|if|else|type|interface|extends|new|throw|async|await|from)\b|\b(?:string|number|boolean|React|FC|Props|Node|CSSProperties)\b|[\u4e00-\u9fff]+|\b\d+\b|\s+|[^\s"/]+/g;

function tokenClass(token: string): string {
  if (token.startsWith('"')) return "s";
  if (token.startsWith("//") || token.startsWith("/*")) return "cm";
  if (KEYWORDS.has(token)) return "k";
  if (TYPES.has(token)) return "t";
  if (/^[\u4e00-\u9fff]+$/.test(token)) return "";
  if (/^\d+$/.test(token)) return "n";
  return "";
}

export function buildCode(props: SceneContentProps = {}): HTMLElement {
  const resolve = props.resolveFont ?? defaultResolveFont;
  const code = document.createElement("div");
  code.className = "kit-code";
  const lines = props.full ? CODE_LINES : CODE_LINES.slice(0, 16);
  lines.forEach((text, index) => {
    const line = document.createElement("div");
    line.className = "ln";
    const no = document.createElement("span");
    no.textContent = String(index + 1);
    line.appendChild(no);
    const content = document.createElement("span");
    if (text) {
      TOKEN_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = TOKEN_RE.exec(text)) !== null) {
        const cls = tokenClass(match[0]);
        for (const ch of match[0]) {
          const span = document.createElement("span");
          if (cls) span.className = cls;
          span.textContent = ch === " " ? "\u00A0" : ch;
          span.style.fontFamily = resolve(ch);
          applySpanAttrs(span, ch, props.spanAttrs);
          content.appendChild(span);
        }
      }
    } else {
      content.innerHTML = "&nbsp;";
    }
    line.appendChild(content);
    code.appendChild(line);
  });
  return code;
}

/* ---------- document ---------- */

export function buildDocument(props: SceneContentProps = {}): HTMLElement {
  const resolve = props.resolveFont ?? defaultResolveFont;
  const doc = document.createElement("div");
  doc.className = "kit-doc";

  const richText = (text: string): HTMLElement => {
    const p = document.createElement("p");
    for (const ch of text) {
      const span = document.createElement("span");
      span.textContent = ch === " " ? "\u00A0" : ch;
      span.style.fontFamily = resolve(ch);
      applySpanAttrs(span, ch, props.spanAttrs);
      p.appendChild(span);
    }
    return p;
  };

  const el = (tag: string, html?: string): HTMLElement => {
    const node = document.createElement(tag);
    if (html !== undefined) node.innerHTML = html;
    return node;
  };

  if (props.customText) {
    doc.appendChild(richText(props.customText));
    return doc;
  }

  doc.appendChild(el("h2", "FontAlloy 使用指南"));
  doc.appendChild(
    richText(
      "把英文编程字体和优秀的中文字体合成为一个字体，让终端和编辑器里的中文不再依赖字体回退。",
    ),
  );
  doc.appendChild(el("h3", "快速开始"));
  doc.appendChild(
    el(
      "ul",
      "<li>在左侧选择英文字体和中文字体</li><li>勾选需要补充的文字范围</li><li>在字符表中微调单个字符的来源</li><li>点击「合成字体」生成并安装</li>",
    ),
  );
  doc.appendChild(el("h3", "命令行"));
  doc.appendChild(
    el(
      "pre",
      "<code>fontalloy build --base JetBrainsMono --cjk MapleMonoCN\nfontalloy export recipe.yaml</code>",
    ),
  );
  doc.appendChild(el("h3", "支持的语言"));
  doc.appendChild(
    el(
      "table",
      "<tr><th>语言</th><th>字符数</th><th>来源</th></tr><tr><td>简体中文</td><td>6,765</td><td>fc-lang zh_cn.orth</td></tr><tr><td>繁体中文</td><td>13,063</td><td>fc-lang zh_tw.orth</td></tr><tr><td>日文</td><td>2,314</td><td>fc-lang ja.orth</td></tr><tr><td>韩文</td><td>2,442</td><td>fc-lang ko.orth</td></tr>",
    ),
  );
  const quote = el("blockquote");
  quote.appendChild(
    richText("字体名只能用英文字母、数字和连字符，例如 ChHsich-SC。"),
  );
  doc.appendChild(quote);
  if (props.full) {
    doc.appendChild(el("h3", "Nerd Font 图标"));
    doc.appendChild(
      richText("合成后的字体包含 Nerd Font 的图标字符，可在终端提示符和状态栏中使用："),
    );
    doc.appendChild(
      el("pre", "<code>❯ git:(main) ✔  docker: running  ⚡ 99.97%</code>"),
    );
    doc.appendChild(el("h3", "常见问题"));
    doc.appendChild(
      el(
        "ul",
        "<li><strong>中英文宽度不对齐？</strong> 中文默认采用 2:1 宽度比，可在设置中调整。</li><li><strong>某些字缺失？</strong> 两个字体都不包含这些字符，合成时会跳过并在报告中列出。</li><li><strong>支持 WOFF2 吗？</strong> 支持，输出格式可选 TTF 或 WOFF2。</li>",
      ),
    );
  }
  return doc;
}
