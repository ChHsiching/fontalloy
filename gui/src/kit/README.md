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

## The invariant rule

> **Every kit part is either PROTOTYPE-DERIVED (a 1:1 origin in the
> validated prototype, cited in the mapping table below) or explicitly
> marked PRODUCT-EXTENSION. A component with no prototype origin and no
> extension mark is a bug.**

New UI must first land in the prototype (and be re-validated) or enter the
extension group by an explicit, recorded decision — never silently. The
`parity-matrix.md` audit in `fontalloy-notes` is the cross-check: its §3
"invented" list is exactly the extension group, nothing more.

## Mapping table (kit → prototype origin)

Inventory numbers cite the 62-item prototype inventory in
`fontalloy-notes/parity-matrix.md` §1.

### Tokens & foundations

| Part | Origin |
| --- | --- |
| `tokens.css` | The prototype's CSS custom properties: both app palettes (light off-white/teal `#0f766e`, dark "teal on iron" `#4ade9e`), hairlines, radii-in-use, spring curves, keyframes, the `.theming` transition killer, scene-theme variable blocks. **The single home of the base tokens** — the typed duplicate was deleted (this pass); only data TypeScript needs stays in `tokens.ts`. |
| `tokens.ts` | The scene-theme DATA in typed form: `TERMINAL_THEMES` (14), `EDITOR_THEMES` (10), `AppTheme` (inv. 51–52, 61). |
| `theme.ts` | Theme apply/toggle with the two-frame `.theming` guard (inv. 4), scene theme option lists and locked-palette lookups (inv. 51–52). |
| `position.ts` | The prototype's `fitPop` discipline: below → flip above → cap, clamped to the `[data-kit-frame]` element. |
| `icons.ts` | The prototype's linear icon family + specials (star, chevron, GitHub mark, theme sun, close ×, pen). The unused `LINEAR_ICON_NAMES` export was deleted (this pass). |

### Components — PROTOTYPE-DERIVED

| Module | Prototype origin |
| --- | --- |
| `topBar.ts` | Top bar (inv. 1–7): brand mark (round 4: the hand-drawn A×永 SVG mark, teal accent, replacing the solid placeholder), font-pair tags, GitHub ghost link (verbatim repo + aria), theme toggle (`切换明暗`), font-name input (`ChHsich`), `合成字体` shimmer button. |
| `metaLine.ts` | The picker MetaLine (inv. 12–13): `X.Xk` stars in accent, license without `-1.1`, trait tag. |
| `pickerPopup.ts` | The 英文字体/中文字体 card + popup (inv. 11–17): round 4 presents the popup in the SAME anchor-fused dropdown-list form as AppSelect — a persistent CHILD of the card (top:100%, left/right −1px, no top border, class-driven display transitions with allow-discrete + @starting-style; no portal, no deferred removal). Self-rendering rows, `搜索字体` 120 ms debounce, footer `加载本地字体文件` outside the scroll, check on selected. |
| `helpPopover.ts` | The circular `?` buttons + popovers (inv. 28–30 chrome): widths 380/340, `.kit-wtab` worked-table chrome verbatim. |
| `settingsTopics.ts` | The three 合成设置 topics (inv. 25–27) — labels, option lists, popover copy — plus `mountSettingRow` (the `.set` row: label + `?` + AppSelect, extracted this pass from duplicated app/demo glue). See the correction note below. |
| `categoryChips.ts` | The two-level chip bar (inv. 31–33) — see the taxonomy deviation below. |
| `actionBar.ts` | The tool row (inv. 34–43): `所有{组}字符` group segment, block segment, `{名} · {n} 字符` note, `缺失字符无法指定来源`, `多选`/`编码`/`撤销`, pager `‹ 第 n/m 页 ›`, `已调整` legend, `按编码指定`, the batch variant (`已选 {n} 个`, hint, 取消/撤销), `undoAllButton` (`全部恢复默认`, inv. 23), `segmentedControl`. |
| `grid.ts` | The 40 px cell vocabulary (inv. 44–46): hover neutral, `.ov` dot, `.sel` ring, dashed-danger missing (codepoint always shown), `.cur` cursor ring, codepoint row, 1024/page. |
| `statusBar.ts` | The status counters (inv. 58): 字符/英文/中文/已调整/缺失/覆盖 %, tabular numerals, change pop. |
| `sceneCard.ts` | Scene cards + fullscreen (inv. 50, 53, 57): captions 终端/代码编辑器/文档, theme selects, `全屏查看`, `上一项/下一项/关闭`. |
| `sceneContent.ts` | The sample content (inv. 54–56): terminal/code/document listings verbatim, per-char effective font, code tokenizer. |
| `charPopup.ts` | `#charpop` (inv. 48, P0-2): opens AT the clicked cell, 44 px glyph in the winning font, `U+XXXX` in accent mono, `来自 X`, one-click `用英文字体`/`用中文字体` (carried side hidden), underlined `恢复默认`, missing copy incl. the Nerd Font PUA sentence. Extracted from `ui/charmap.ts` (this pass). |
| `rangePopup.ts` | `#rangepop` (inv. 49, P1-2): title `按编码指定`, hint `输入编码或范围，窄范围优先于整类。`, `U+0030 或 0` / `留空=单个` inputs (empty end = single codepoint), side select, primary `添加`, invalid → danger border. Extracted from `ui/charmap.ts` (this pass). |
| `langChips.ts` | The rLangs row (inv. 19–20, P0-1): always-visible chips `简体中文 6,765`… with small dim counts, pressed = declared. Extracted from `ui/rulelist.ts` (this pass). |
| `ruleRows.ts` | The rRules summary rows (inv. 21–22, 24, P1-3/P1-4): icon + sentence + dim tabular `U+…` suffix + delete × (danger on hover), the dashed `单个字符 N` aggregate, the `暂无自定义规则。` empty state. Extracted from `ui/rulelist.ts` (this pass). |
| `appSelect.ts` | The custom select (used throughout the prototype's settings + scene theme selects): glow, keyboard/Escape, allow-discrete open animation, exclusivity. |

### PRODUCT-EXTENSION parts (marked, no prototype origin)

These exist because the product does work the demo prototype never modeled.
They are deliberate, marked, and must not grow without a decision:

| Part | What it adds | Why it exists |
| --- | --- | --- |
| `pickerPopup.ts` extension props | `note`/`error` status lines, `PickerFont.disabled` + `note` rows, `keywords`, `destroy()` | Catalog download states (未下载/下载中/失败) on picker rows; regions that rebuild. |
| `appSelect.ts` `destroy()` | Full teardown | Regions that rebuild. |
| `grid.ts` `cp` + `attrs` data attributes | Provenance (winner/via/kind) on the cell dataset | Test-facing walkability (parity-matrix §3.13, benign). |
| `sceneContent.ts` `spanAttrs` | Per-char provenance attributes | Same instrumentation discipline. |

App-level PRODUCT-EXTENSION surfaces (NOT kit — they live in `gui/src/ui` /
`gui/src/catalog` with chrome in `app.css`, and must stay marked): the build
panel (`ui/buildpanel.ts`), the no-service CLI panel (`ui/noservice.ts`),
the first-run catalog screen (`catalog/screen.ts`), the synthesize notice strip
(`ui/topbar.ts`), the language-preset picker popup + `添加语言预设…` entry
(`ui/presetpicker.ts`, `ui/rulelist.ts`), and the custom window controls
(`ui/wincontrols.ts`, round 4: minimize/maximize/close + drag region for the
undecorated Tauri window — never mounted in the web target). Layout glue
(workspace split, rail sections, charmap layout) is neither component chrome
nor extension — it is assembly, and it stays in `app.css`.

## Table-content policy — the ONE retained correction

Help-popover tables carry the prototype's CHROME verbatim (`.kit-wtab`).
Exactly one content correction is retained, each affected table marked with a
`CONTENT CORRECTED` comment in `settingsTopics.ts`:

- **weight tables (ADR-0006)**: output weight slots come only from the base
  font's faces — `仅保留中文字体提供的字重 → 常规（仅保留两种字体共有的档位）`;
  the prototype's `中等` output row is dropped, the nearest-match paragraph
  follows. The superseded draft rows stay in the prototype until the owner
  back-ports the correction there.

Everything else is verbatim — including the cjk-width options `1.8 倍英文宽`
/ `1.5 倍英文宽` (real pipeline behavior, `normalization.width_factor`).
The baseline/cjk-width copy is the prototype's own.

## The owner-endorsed taxonomy deviation

`categoryChips.ts` renders a **real Unicode-block taxonomy**
(`unicode/blocks.ts`: 拉丁与欧洲文字 / 通用符号 / 中日韩文字 / 其他文字 and
their block names) instead of the prototype's 字母/数字与符号/图标/中文/日韩
chip labels. This is the single accepted deviation from the prototype's
content — owner-praised (parity-matrix §3 preamble) — and it is recorded here
so the invariant rule has its one sanctioned exception on the content axis
(the chip chrome, counts, aggregates, and 缺失-danger styling remain
prototype-derived).

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
  `@starting-style`; overlay nodes persist across re-renders (rows
  rebuild only) so both directions of the transition always play.
- All positioning clamps to the frame element marked `data-kit-frame`
  (fall back to the viewport when the app fills the window).
- FACTS (data, state, gestures) are the consumer's; the kit renders what it
  is given and reports the actions. Screens assemble kit only — when a
  screen finds itself hand-rolling a prototype surface, that surface moves
  into the kit with its mapping row (this is how charPopup, rangePopup,
  langChips, ruleRows, and mountSettingRow were born).

## Consuming from gui / web

Import the CSS once per app entry (`tokens.css` + `kit.css`), then compose:

```ts
import "./kit/tokens.css";
import "./kit/kit.css";
import { mountPickerPopup } from "./kit/pickerPopup";
```

The store stays `gui/src/state.ts`; `web/index.html` mounts the same
`gui/src/main.ts` workspace (only the platform adapter differs).

## Tests

`gui/tests/kit.spec.ts` drives the demo page with the suite's mandatory
conventions: real pointer events with elementFromPoint guards, DOM
textContent / computed-style / geometry assertions, zero-JS-errors gate.
Covers open/close transitions (`transition-behavior: allow-discrete`),
frame clamping, escape/outside close, node survival + deferred removal,
meta-line rendering, theme switching, scene theme option counts (14/10), and
— since the extraction pass — the lang-chip guard (至少保留一种), the rule
summary rows + empty state, the char popup at the cell, the range popup
contract (placeholders, invalid danger border, single-codepoint add), and
the settings row assembly.

The demo page (`gui/kit-demo.html`, dev-only — `npm run dev`, open
`/kit-demo.html`) assembles **every** kit component with realistic data; it
is the design-acceptance capture surface and must stay in sync with the kit
(a new kit part without a demo presence is an omission).
