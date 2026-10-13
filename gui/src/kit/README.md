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
| `topBar.ts` | Top bar (inv. 1–7): brand mark (round 4: the hand-drawn A×永 SVG mark, teal accent, replacing the solid placeholder; round 7: 22px in the bar and the `brandMark(size)` export the panels/favicon/Tauri icons adopt), font-pair tags, GitHub ghost link (verbatim repo + aria; round 5: `onNavigate` lets the Tauri shell route the click to the system browser), theme toggle (`切换明暗`; round 5: the 3-state 自动/浅色/深色 cycle with the effective icon + 自动 badge), font-name input (`ChHsich`), `合成字体` shimmer button. |
| `metaLine.ts` | The picker MetaLine (inv. 12–13): `X.Xk` stars in accent, license without `-1.1`, trait tag. |
| `pickerPopup.ts` | The 英文字体/中文字体 card + popup (inv. 11–17): round 4 presents the popup in the SAME anchor-fused dropdown-list form as AppSelect — a persistent CHILD of the card (top:100%, left/right −1px, no top border, class-driven display transitions with allow-discrete + @starting-style; no portal, no deferred removal). Self-rendering rows, `搜索字体` 120 ms debounce, footer `加载本地字体文件` outside the scroll, check on selected. |
| `helpPopover.ts` | The circular `?` buttons + popovers (inv. 28–30 chrome): widths 380/340, `.kit-wtab` worked-table chrome verbatim. Round 6: the hover is a PURE CENTERED scale — `transform-origin` pinned center, zero translate (the round-5 status-bar anchor sat in baseline flow and read as a down-shift-then-scale; it is gone with the coverage popover, and the shared rule now forbids the class). |
| `settingsTopics.ts` | The three 合成设置 topics (inv. 25–27) — labels, option lists, popover copy — plus `mountSettingRow` (the `.set` row: label + `?` + AppSelect, extracted this pass from duplicated app/demo glue). See the correction note below. |
| `categoryChips.ts` | The two-level chip bar (inv. 31–33) — see the taxonomy deviation below. |
| `actionBar.ts` | The tool row (inv. 34–43): `所有{组}字符` group segment, block segment, `{名} · {n} 字符` note, `缺失字符无法指定来源`, `多选`/`编码`/`撤销`, pager `‹ 第 n/m 页 ›`, `已调整` legend, `按编码指定`, the batch variant (`已选 {n} 个`, hint, 取消/撤销), `undoAllButton` (`全部恢复默认`, inv. 23), `segmentedControl`. Round 6: the pager arrows are inline-SVG chevrons in flex-centered buttons (the `‹ ›` TEXT glyphs hugged the baseline and read low next to the CJK label — the same optical class as the ? fix), and the `第 n/m 页` label is click-editable jump-to-page (`onJump`: a numeric input commits clamped, Esc cancels). |
| `grid.ts` | The 40 px cell vocabulary (inv. 44–46): hover neutral, `.ov` dot, `.sel` ring, dashed-danger missing (codepoint always shown), `.cur` cursor ring, codepoint row, 1024/page; round 5 reports the live COLUMN count (`onColumns`) so the consumer pages in whole rows. |
| `statusBar.ts` | The status counters (inv. 58): 字符/英文/中文/已调整/缺失/覆盖 %, tabular numerals, change pop. The round-5 覆盖 `?` anchor is GONE (round 6, owner item 2: coverage counts the whole visible universe — normal semantics, the explanation was noise). |
| `sceneCard.ts` | Scene cards + fullscreen (inv. 50, 53, 57): captions 终端/代码编辑器/文档, theme selects, `全屏查看`, `上一项/下一项/关闭`; round 5: the fullscreen bar carries the theme select and `render()` swaps the content in place (no close/reopen choreography). |
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
| `pickerPopup.ts` extension props | `note`/`error` status lines, `PickerFont.disabled` + `note` rows, `keywords`, `chips` (span-button `PickerChip`s + `onChip`), `help` (the picker-level variant ?), `destroy()` | Catalog download states (未下载/下载中/失败) on picker rows; variant chips under a row (round 7, redesigned the same round — full-Chinese labels, the axis default's dim 默认 marker `def` vs the explicit accent `on`, axes the family actually varies on only); ONE `?` per picker explaining 变体 (owner item 2: the raw chips were 看不懂); regions that rebuild. |
| `appSelect.ts` `destroy()` | Full teardown | Regions that rebuild. |
| `grid.ts` `cp` + `attrs` data attributes | Provenance (winner/via/kind) on the cell dataset | Test-facing walkability (parity-matrix §3.13, benign). |
| `sceneContent.ts` `spanAttrs` | Per-char provenance attributes | Same instrumentation discipline. |
| `charPopup.ts` `note` | The ineffective-assignment reason line under 来自 (round 7) | Absence never overrides: the declared side cannot supply, the popup states it in glossary words (补字) instead of a silent 来自 (owner item 1). |
| `actionBar.ts` legend `?` | The 已调整 legend carries a help anchor (round 7) | The dot means DECLARED, the glyph follows the actual supplier — the legend says so (owner item 1). |

App-level PRODUCT-EXTENSION surfaces (NOT kit — they live in `gui/src/ui` /
`gui/src/catalog` with chrome in `app.css`, and must stay marked): the build
panel (`ui/buildpanel.ts`), the no-service CLI panel (`ui/noservice.ts`),
the first-run catalog screen (`catalog/screen.ts`), the synthesize notice strip
(`ui/topbar.ts`), the live GitHub stars fetch (`catalog/stars.ts`, round 5:
once per launch from the manifest's pinned repos, cached to storage, curated
values as the offline seed), and the custom window controls
(`ui/wincontrols.ts`, round 4: minimize/maximize/close + drag region for the
undecorated Tauri window — never mounted in the web target). The
language-preset picker popup left the extension group in round 5 (owner
ruling: the 文字范围 rail surfaces only the four prototype chips; the
341-language fc-lang presets remain recipe/core territory). Layout glue
(workspace split, rail sections, charmap layout) is neither component chrome
nor extension — it is assembly, and it stays in `app.css`.

## Round-5 owner rulings that deviate from the prototype's chrome

Recorded here so the invariant rule stays auditable (each is an owner
instruction from the hands-on review, not a silent drift):

- **Picker footer alignment** — `加载本地字体文件` is LEFT-aligned with the
  rows (the prototype centers it); the owner ruled the list reads as one
  column that way.
- **Theme toggle** — a THREE-STATE cycle 自动 → 浅色 → 深色 with the
  effective-theme icon (sun/moon), a tiny 自动 badge, and persistence
  (the prototype has a two-state sun toggle).
- **Scene fullscreen** — bounded BELOW the top bar (the custom window
  controls stay clickable), zoomed type at 16/14px (the prototype's 19px
  reads as a wall of text), the scene theme select available in the
  fullscreen bar, and prev/next swap content in place.
- **Picker catalogs per slot** — the EN slot lists the Nerd Fonts coding
  families, the CJK slot the CJK families (the prototype's BA/DA wiring;
  `data/curated-meta.json` `slots.cjk` names the CJK families). Local
  files stay available in both.
- **Grid page fill** — pages hold a whole number of rows (a multiple of
  the live column count, capped at 1024) so no non-final page ends on a
  partial row. The browsable universe is the VISIBLE codepoints only
  (`unicode/visible.ts`, generated): control/format/separator/unassigned
  scalars never render as blank cells.

## Round-6 owner rulings (this round)

- **The coverage `?` is gone** (owner item 2): 覆盖 counts the whole
  visible universe — normal semantics, the explanation was noise. The
  sanctioned-additions note below is superseded by this.
- **The `?` hover discipline** (owner item 1): color change plus at most
  a PURE CENTERED scale — `transform-origin: center`, zero translate, in
  every context that mounts a help anchor.
- **Pager arrows + jump-to-page** (owner item 3): SVG chevrons centered
  with the label (no baseline-riding text glyphs), and the page label is
  click-editable (Enter commits clamped, Esc cancels).
- **The 图标 group is restored** (owner item 7): the prototype's
  `图标 → Nerd Font` chip returns as a first-class category — the NF PUA
  allocations (the prototype's `NF_RANGES` verbatim) as a CURATED block
  (`unicode/blocks.ts` `intervals`): the grid pages through the curated
  planes while rules target the raw envelope, like every other block.
  The taxonomy deviation note below now carries this as its ONE
  sanctioned content exception being partially un-done (the group chrome
  stays kit-derived; the 图标 group itself is prototype content).
- **已调整 keys on the declared side** (owner item 4): the prototype's
  ov discipline — a non-preset rule declaring a side the no-rule default
  does not carry — see `precedence/resolve.ts` `isAdjusted`. Winner-only
  comparison went mute exactly where an assignment cannot move the
  winner (absence never overrides).

## Round-7 owner rulings (this round)

- **The ineffective-assignment affordance** (owner item 1): absence
  never overrides is CORRECT but was silent — 用英文字体 on CJK
  codepoints the base lacks marks the declared side (the green dot)
  while the supplier stays the CJK font. No behavior change: the char
  popup gains a reason line under 来自 (「英文字体不含此码位，仍由中文字
  体补字」 — glossary words), and the 已调整 legend carries a `?`
  (「绿点＝已声明来源；被声明的字体不含此码位时，字形以实际供给为准」).
  The journey suite now also asserts the GLYPH layer: every effective
  cell's computed font-family equals its winner's own family
  (`assertWinnerGlyphs`, J4/J5/J6), including the CJK-adjacent
  codepoints the EN base actually holds (the fullwidth braces), where
  an assignment MUST visibly flip the painted glyph.
- **The variant chips redesign** (owner item 2: 看不懂): full Chinese
  labels only (NF 图标 / 等宽 / 屏显优化 / 简繁地区 …— real terms per
  the report-copy style, NO raw axis ids), chips render ONLY the axes
  the family actually varies on, the axis default wears a dim 默认
  marker (dashed) instead of a pressed look (未选择变体时 = 家族默认),
  and ONE `?` per picker (变体是什么: one sentence + the axes table)
  replaces per-row machinery.
- **Logo adoption** (owner item 4: 好小 + 只有左上角): the top-bar mark
  enlarges 16 → 22px, and the same SVG heads the first-run catalog
  panel, the build panel, the no-service panel, the web + gui favicon
  (an inline SVG data URI), and the generated Tauri icon set
  (`gui/scripts/make-icons.mjs` rasterizes the same A×永 mark).

## Round-9 owner rulings (this round)

- **Display names are the font's own** (owner item 2 + item 5): every
  name surface — picker rows, variant chips, rail identity cards,
  top-bar pair tags, the char popup's 来自 line, the report's source
  names — reads the REGISTERED font's name table verbatim (nameID 16/1
  + 17/2, the en records; the zh-CN records ride along untranslated:
  `fonts/sfnt.ts` `FontNames`). "LXGW WenKai Screen" stays "LXGW
  WenKai Screen"; curated display names are GONE from
  `data/curated-meta.json` (stars/traits/slots stay). An unfetched row
  falls back to the upstream release artifact's own name (its stem),
  never a constructed string. Chip labels are the data's own words:
  the registered cut's name after the family's shared base, else the
  manifest variant word, else the asset's own suffix — the translated
  屏幕版 token is deleted in favor of the author's Screen.
- **Message copy is one terse line** (owner item 3): 「中日韩文字 → 英
  文：0 生效 / 41,289 未变（无字形）· Ctrl+Z 撤销」 — numbers first,
  the success count ALWAYS stated (even 0), no title, no repetition.
- **The rule-row × is visibly there** (owner item 6): an explicit 14px
  close glyph at full contrast on every summary row AND the 单个字符 N
  aggregate head (its × deletes the whole group in ONE undo step;
  `ruleRows.ts` renders the head as a group div whose wide toggle
  button carries the sentence, so the × never nests inside a button).
- **Messages auto-dismiss on a countdown** (owner item 7): ~6s, a thin
  progress bar shrinking along the card's bottom edge (rAF-driven),
  hover PAUSES (the bar freezes), leaving resumes, the × closes
  instantly; a message may opt out with `autoDismiss: false`. Cards
  are real hover targets (pointer-events on the card); the stack's
  empty area stays pointer-transparent.
- **The document scene renders on the effective fonts** (owner item
  4): headings, body, list items, and table cells resolve per
  character like the terminal/code cards — no UI-font text remains in
  the sample; the document's structure (sizes, weights, table lines)
  stays CSS.

## Round-11 owner rulings (recorded deviations)

- **「2 倍英文宽」, not 「两倍英文宽」** (owner item 7): the CJK-width
  option label — in the AppSelect options AND the help table's first
  row — uses the numeric form so it matches its sibling labels
  (1.8 倍英文宽 / 1.5 倍英文宽). This is an explicit owner ruling that
  OVERRIDES the prototype-verbatim policy for this one string; the
  deviation is recorded here per the invariant rule. The rest of the
  settings topics' copy stays verbatim (`settingsTopics.ts`).

## Table-content policy — help content is the prototype's text

Help-popover tables and prose carry the prototype's content VERBATIM
(round 5, owner ruling: "help content is the prototype's text, no
engineering notes in user-facing popovers"). The round-3/4 ADR-0006
correction of the weight tables was REVERTED to the prototype's exact
rows (including the 中等 output row); the engineering rationale lives
in `docs/adr/0006-*` and the pipeline, never in a user-facing popover.
Round 6 supersedes the one sanctioned addition: the 覆盖 scope popover
on the status bar is REMOVED (see the round-6 rulings above). The
build panel's report popovers are PRODUCT-EXTENSION surfaces (the
prototype had no report): their copy follows the owner-ratified
glossary in `fontalloy-notes/report-copy.md`, not the prototype. The
ONE content deviation inside the prototype-derived topics is the
round-11 「2 倍英文宽」 label (see the round-11 rulings above).

## The owner-endorsed taxonomy deviation

`categoryChips.ts` renders a **real Unicode-block taxonomy**
(`unicode/blocks.ts`: 拉丁与欧洲文字 / 通用符号 / 图标 / 中日韩文字 /
其他文字 and their block names) instead of the prototype's
字母/数字与符号/图标/中文/日韩 chip labels. This is the single accepted
deviation from the prototype's content — owner-praised (parity-matrix §3
preamble) — and it is recorded here so the invariant rule has its one
sanctioned exception on the content axis (the chip chrome, counts,
aggregates, and 缺失-danger styling remain prototype-derived). Round 6
(owner item 7) restores the prototype's 图标 group INSIDE the real
taxonomy: the NF PUA allocations as a curated first-class category (see
the round-6 rulings above), so the deviation no longer drops prototype
content — only the LABELS differ.

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
