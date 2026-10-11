# FontAlloy kit — the shared frontend component library

`gui/src/kit` is the component library abstracted from the **validated
prototype** (`gui/prototype/index.html`, accepted 2026-10). The prototype is
the design contract; the kit is its clean, typed, prop-driven form. Both the
GUI (`gui/src`) and the WebApp (`web/`) screens assemble kit components only —
fidelity becomes structural rather than aspirational.

What is extracted, never ported: exact colors, spacing, radii, shadows,
typography, copy strings, theme lists, table chrome, and interaction
architecture (open/close transitions, clamping, node persistence). What is
rewritten: all code — TypeScript modules in the repo's established
no-framework style (mount functions returning handles, `render(props)`
re-renders, store pattern in `gui/src/state.ts`).

## Layout

| Module | Exports |
| --- | --- |
| `tokens.ts` | `LIGHT_PALETTE` / `DARK_PALETTE` (teal-on-iron + off-white/teal), `RADIUS`, `FONT`, `MOTION`, `GRID_PAGE_SIZE`, `TERMINAL_THEMES` (14), `EDITOR_THEMES` (10) |
| `tokens.css` | The palettes as CSS custom properties (`--page --sf --ink --ac …`), scene-theme variable blocks (`.kit-term[data-t=…]`, `.kit-code[data-ct=…]`), springs, keyframes, `.theming` transition killer, base resets |
| `kit.css` | Component chrome for every component below |
| `theme.ts` | `getAppTheme` / `applyAppTheme` / `toggleAppTheme` (with the two-frame `.theming` guard), `TERMINAL_THEME_OPTIONS` / `EDITOR_THEME_OPTIONS`, `applyTerminalTheme` / `applyEditorTheme` |
| `position.ts` | `fitPopup` (the prototype's fitPop: below → flip above → cap, clamped to the `[data-kit-frame]` element or viewport), `attachPopupBelow` (picker-style seamless attach) |
| `icons.ts` | `icon(name)` — the prototype's linear icon family + specials (star, chevron, GitHub mark, theme sun) |
| `appSelect.ts` | `mountAppSelect` — custom dropdown, glow, keyboard/Escape, allow-discrete open animation, exclusivity |
| `metaLine.ts` | `metaLine(FontMeta)`, `formatStars` — the no-pills baseline row (accent stars, license, trait) |
| `pickerPopup.ts` | `mountPickerPopup` — card + portaled popup: search header, inner scroll, footer OUTSIDE the scroll, self-rendering rows, node persistence, frame clamping. Stage-2 extensions: `note`/`error` status lines above the footer, and `PickerFont.disabled` + `note` render an unpickable row with its status tag (未下载 states) |
| `helpPopover.ts` | `mountHelpPopover` (circular ? button + pop chrome), `workedTable` (`.kit-wtab` chrome verbatim), `helpNote` |
| `settingsTopics.ts` | The three synthesis-settings topics with ADR-corrected table content (see below) |
| `categoryChips.ts` | `mountCategoryChips` — two-level chips with counts, 全部/缺失 aggregates, danger styling |
| `actionBar.ts` | `mountActionBar`, `segmentedControl`, `gridPager`, `undoAllButton` — per-group/per-block segments, 多选/编码/撤销, pager, 已调整 legend, 按编码指定, batch variant |
| `grid.ts` | `gridCell`, `mountCharGrid`, `PAGE_SIZE` (1024) — hover neutral, accent selected, `.ov` corner dot, `.miss` dashed danger, `.cur` details-cursor inner ring, codepoint row. Stage-2 extensions: `cp` (data-cp label) + `attrs` (provenance data attributes) land on the cell dataset |
| `statusBar.ts` | `mountStatusBar` — color-coded 字符/英文/中文/已调整/缺失/覆盖 counters, tabular-nums, change pop |
| `sceneCard.ts` | `mountSceneCard` (stacked cards, theme AppSelect, 全屏查看), `mountFullscreenScene` |
| `sceneContent.ts` | `buildTerminal` / `buildCode` / `buildDocument` — the prototype's sample content, per-char effective-font rendering, NBSP alignment, code tokenizer. Stage-2 extension: `spanAttrs` puts consumer provenance (winner/via/kind) on every character span |
| `topBar.ts` | `mountTopBar` + parts: `brandPart`, `fontPairTags`, `githubLink`, `themeToggle`, `fontNameInput` (default `ChHsich`), `synthesizeButton` |
| `demo/` | The demo page (`gui/kit-demo.html`, dev-only): every component assembled with realistic data. Run `npm run dev` and open `/kit-demo.html`. This is the design-acceptance capture surface. |

## Component contracts (summary)

Every component follows the same shape:

```ts
const handle = mountThing(host, initialProps); // appends into host
handle.render(nextProps);                      // re-render, nodes survive
handle.open?.(); handle.close?.();             // overlays only
```

- Popups/selects close on outside `pointerdown` (with the still-connected
  guard) and on `Escape`; opening one closes the others of its kind.
- Open/close run through `display` transitions with `allow-discrete` +
  `@starting-style`; popup nodes persist across re-renders (rows rebuild
  only) and are removed ~240ms after close so the exit transition plays.
- All positioning clamps to the frame element marked `data-kit-frame`
  (fall back to the viewport when the app fills the window).

## Table-content policy (ADR corrections)

Help-popover tables carry the prototype's CHROME verbatim (`.kit-wtab`) but
the CONTENT is the ADR-corrected version wherever the draft was superseded —
each such table is marked with a `CONTENT CORRECTED` comment in
`settingsTopics.ts`:

- **weight** (ADR-0006): output weight slots come only from the base font's
  faces — `仅保留中文字体提供的字重 → 常规（仅保留两种字体共有的档位）`;
  the prototype's `中等` output row is dropped.
- **baseline / cjk-width** (ADR-0003): one shared baseline and 2:1 wide
  advance are invariants — the knobs are the scale school and the
  fullwidth-quotes convention; the prototype's 1.8×/1.5× width options are
  marked inexpressible.

## Consuming from gui / web

Import the CSS once per app entry (`tokens.css` + `kit.css`), then compose:

```ts
import "./kit/tokens.css";
import "./kit/kit.css";
import { mountPickerPopup } from "./kit/pickerPopup";
```

Stage 2 (screen refactor) replaces `gui/src/ui/*` internals with kit
compositions; the store stays `gui/src/state.ts`.

## Tests

`gui/tests/kit.spec.ts` drives the demo page with the suite's mandatory
conventions: real pointer events with elementFromPoint guards, DOM
textContent / computed-style / geometry assertions, zero-JS-errors gate.
Covers open/close transitions (`transition-behavior: allow-discrete`),
frame clamping, escape/outside close, node survival + deferred removal,
meta-line rendering, theme switching, and the scene theme option counts
(14 terminal / 10 editor).
