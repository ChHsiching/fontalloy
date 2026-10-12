/**
 * Curated Unicode block hierarchy for the character map.
 *
 * "Hierarchical categories and the 'all' aggregate view coexist" (ADR-0004):
 * `all` spans the browsable scalar space; unassigned and astral codepoints
 * are browsable too — the grid renders whatever the loaded fonts provide
 * and falls back visually elsewhere.
 *
 * Since the design-fidelity repair the paradigm is the validated
 * prototype's horizontal two-level chip bar: a category is one of
 *
 * - `all` — the full aggregate view,
 * - a BLOCK id — one Unicode block,
 * - `g:<group id>` — a GROUP AGGREGATE (the chip bar's "全部" of one
 *   group), enumerated as the group's blocks in declaration order.
 *
 * Round 5 (owner items 1 + 5):
 *
 * - **Visible-only enumeration.** Every category enumerates VISIBLE
 *   codepoints only (see ./visible.ts): control, format, separator,
 *   surrogate, and unassigned scalars never become cells — the
 *   prototype's hand-curated blocks contain none, so a raw block range
 *   would render meaningless blanks (U+0020, U+007F–U+00A0 & co). The
 *   BLOCK BOUNDS stay raw: block rules target the full Unicode block,
 *   exactly like a recipe written by hand.
 * - **Responsive page size.** Pages hold `perPage` cells where
 *   `perPage` is a multiple of the grid's live column count, so every
 *   page is exactly full except the final partial one (the nominal
 *   ceiling stays CELLS_PER_PAGE).
 */

import { VISIBLE_INTERVALS } from "./visible";

export interface UnicodeBlock {
  id: string;
  /** UI (Chinese) name. */
  name: string;
  /** English name, for reference/debugging. */
  en: string;
  start: number;
  end: number;
  /**
   * Curated enumeration intervals (round 6, the 图标 group): when a
   * block's browsable content is a CURATED subset of its raw envelope
   * (the Nerd Font PUA allocations — 22 disjoint ranges inside
   * 0xE000–0xF533), these replace the envelope for ENUMERATION and the
   * browsed-universe scope. Rules still target the full envelope
   * (`start`–`end`), exactly like every other block.
   */
  intervals?: ReadonlyArray<readonly [number, number]>;
}

export interface BlockGroup {
  id: string;
  name: string;
  blocks: UnicodeBlock[];
}

function block(id: string, name: string, en: string, start: number, end: number): UnicodeBlock {
  return { id, name, en, start, end };
}

export const ALL_CATEGORY_ID = "all";

export const ALL_RANGE = { start: 0x20, end: 0x10ffff };

/**
 * The Nerd Font PUA allocations (round 6, the 图标 group): the
 * prototype's own `NF_RANGES` verbatim — the icon planes the patched
 * coding fonts actually carry. The block's raw envelope is
 * 0xE000–0xF533 (what a rule targets); the curated intervals are what
 * the grid pages through and the browsed universe counts, so the ~1.8k
 * non-NF private-use codepoints in between stay out of the view (the
 * prototype's hand-curated lists never had them).
 */
const NF_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0xe000, 0xe00a],
  [0xe0a0, 0xe0a3],
  [0xe0b0, 0xe0c8],
  [0xe0ca, 0xe0ca],
  [0xe0cc, 0xe0d2],
  [0xe0d4, 0xe0d4],
  [0xe0d6, 0xe0d7],
  [0xe200, 0xe2a9],
  [0xe300, 0xe3e3],
  [0xe5fa, 0xe6bb],
  [0xe700, 0xe958],
  [0xea60, 0xea88],
  [0xea8a, 0xea8c],
  [0xea8f, 0xeac7],
  [0xeac9, 0xeac9],
  [0xeacc, 0xeb09],
  [0xeb0b, 0xeb4e],
  [0xeb50, 0xec5e],
  [0xec60, 0xec84],
  [0xed00, 0xefcf],
  [0xf000, 0xf385],
  [0xf400, 0xf533],
];

export const BLOCK_GROUPS: BlockGroup[] = [
  {
    id: "latin-europe",
    name: "拉丁与欧洲文字",
    blocks: [
      block("basic-latin", "基本拉丁", "Basic Latin", 0x20, 0x7f),
      block("latin-1", "拉丁补充", "Latin-1 Supplement", 0x80, 0xff),
      block("latin-ext-a", "拉丁扩展 A", "Latin Extended-A", 0x100, 0x17f),
      block("latin-ext-b", "拉丁扩展 B", "Latin Extended-B", 0x180, 0x24f),
      block("ipa", "国际音标扩展", "IPA Extensions", 0x250, 0x2af),
      block("greek", "希腊与科普特", "Greek and Coptic", 0x370, 0x3ff),
      block("cyrillic", "西里尔", "Cyrillic", 0x400, 0x4ff),
    ],
  },
  {
    id: "symbols",
    name: "通用符号",
    blocks: [
      block("general-punct", "常用标点", "General Punctuation", 0x2000, 0x206f),
      block("superscripts", "上标与下标", "Superscripts and Subscripts", 0x2070, 0x209f),
      block("currency", "货币符号", "Currency Symbols", 0x20a0, 0x20cf),
      block("arrows", "箭头", "Arrows", 0x2190, 0x21ff),
      block("math", "数学运算符", "Mathematical Operators", 0x2200, 0x22ff),
      block("box-drawing", "制表符", "Box Drawing", 0x2500, 0x257f),
      block("block-elements", "方块元素", "Block Elements", 0x2580, 0x259f),
      block("geometric-shapes", "几何图形", "Geometric Shapes", 0x25a0, 0x25ff),
      block("misc-symbols", "杂项符号", "Miscellaneous Symbols", 0x2600, 0x26ff),
      block("dingbats", "装饰符号", "Dingbats", 0x2700, 0x27bf),
    ],
  },
  {
    id: "icons",
    name: "图标",
    blocks: [
      {
        ...block("nf-icons", "Nerd Font", "Nerd Font PUA", 0xe000, 0xf533),
        intervals: NF_RANGES,
      },
    ],
  },
  {
    id: "cjk",
    name: "中日韩文字",
    blocks: [
      block("cjk-punct", "CJK 符号和标点", "CJK Symbols and Punctuation", 0x3000, 0x303f),
      block("hiragana", "平假名", "Hiragana", 0x3040, 0x309f),
      block("katakana", "片假名", "Katakana", 0x30a0, 0x30ff),
      block("cjk-compat", "CJK 兼容表意文字", "CJK Compatibility Ideographs", 0xf900, 0xfaff),
      block("cjk-unified", "CJK 统一表意文字", "CJK Unified Ideographs", 0x4e00, 0x9fff),
      block("cjk-ext-a", "CJK 扩展 A", "CJK Unified Ideographs Extension A", 0x3400, 0x4dbf),
      block("hangul-syllables", "谚文音节", "Hangul Syllables", 0xac00, 0xd7a3),
      block("halfwidth-fullwidth", "半形与全形字符", "Halfwidth and Fullwidth Forms", 0xff00, 0xffef),
      block("cjk-ext-b", "CJK 扩展 B", "CJK Unified Ideographs Extension B", 0x20000, 0x2a6df),
    ],
  },
  {
    id: "other-scripts",
    name: "其他文字",
    blocks: [
      block("arabic", "阿拉伯", "Arabic", 0x600, 0x6ff),
      block("hebrew", "希伯来", "Hebrew", 0x590, 0x5ff),
      block("thai", "泰文", "Thai", 0xe00, 0xe7f),
      block("devanagari", "天城文", "Devanagari", 0x900, 0x97f),
      block("emoji", "表情符号", "Emoticons / Emoji", 0x1f300, 0x1f9ff),
    ],
  },
];

export const ALL_BLOCKS: UnicodeBlock[] = BLOCK_GROUPS.flatMap((g) => g.blocks);

const BLOCK_BY_ID = new Map(ALL_BLOCKS.map((b) => [b.id, b]));
const GROUP_BY_ID = new Map(BLOCK_GROUPS.map((g) => [g.id, g]));

export const GROUP_CATEGORY_PREFIX = "g:";

/** The group-aggregate category id of a block group (`cjk` → `g:cjk`). */
export function groupCategoryId(gid: string): string {
  return GROUP_CATEGORY_PREFIX + gid;
}

/** The group of a group-aggregate category id, when there is one. */
export function findGroupCategory(id: string): BlockGroup | undefined {
  if (!id.startsWith(GROUP_CATEGORY_PREFIX)) return undefined;
  return GROUP_BY_ID.get(id.slice(GROUP_CATEGORY_PREFIX.length));
}

export function findBlock(id: string): UnicodeBlock | undefined {
  return BLOCK_BY_ID.get(id);
}

/** The group a block belongs to (undefined for aggregate ids). */
export function blockGroup(id: string): BlockGroup | undefined {
  const block = BLOCK_BY_ID.get(id);
  if (block) {
    return BLOCK_GROUPS.find((g) => g.blocks.some((b) => b.id === id));
  }
  return findGroupCategory(id);
}

/** The RAW codepoint intervals of a category, in enumeration order. */
export function categoryIntervals(
  id: string,
): Array<{ start: number; end: number }> {
  if (id === ALL_CATEGORY_ID) {
    return [
      { start: ALL_RANGE.start, end: 0xd7ff },
      { start: 0xe000, end: ALL_RANGE.end },
    ];
  }
  const group = findGroupCategory(id);
  if (group) {
    // A group's aggregate is the union of its blocks' ENUMERATION
    // intervals (curated intervals included — the 图标 group's 全部
    // counts the Nerd Font planes, not the raw envelope).
    return group.blocks.flatMap((b) =>
      b.intervals
        ? b.intervals.map(([start, end]) => ({ start, end }))
        : [{ start: b.start, end: b.end }],
    );
  }
  const block = BLOCK_BY_ID.get(id);
  if (!block) return [];
  // A curated block enumerates its curated intervals, not the envelope.
  return block.intervals
    ? block.intervals.map(([start, end]) => ({ start, end }))
    : [{ start: block.start, end: block.end }];
}

export function categoryName(id: string): string {
  if (id === ALL_CATEGORY_ID) return "全部";
  const group = findGroupCategory(id);
  if (group) return group.name;
  return BLOCK_BY_ID.get(id)?.name ?? id;
}

/* ---------------- visible-span enumeration (round 5) ------------------ */

/**
 * One browsable span: a visible interval of a category, with the count
 * of visible codepoints BEFORE it (a prefix sum — nth/index math is a
 * binary search over these).
 */
interface VisibleSpan {
  start: number;
  end: number;
  /** Visible codepoints in the spans strictly before this one. */
  before: number;
}

const spanCache = new Map<string, VisibleSpan[]>();

/** First index of VISIBLE_INTERVALS whose interval can overlap `from`. */
function firstVisibleFrom(from: number): number {
  let lo = 0;
  let hi = VISIBLE_INTERVALS.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (VISIBLE_INTERVALS[mid]![1] < from) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function intersectVisible(
  intervals: ReadonlyArray<{ start: number; end: number }>,
): VisibleSpan[] {
  // Blocks are declared in TAXONOMY order, not codepoint order (the CJK
  // group lists the compatibility block before the unified one), so
  // each interval finds its starting visible interval by search — a
  // shared forward cursor would skip everything after a backwards step.
  const raw: Array<{ start: number; end: number }> = [];
  for (const interval of intervals) {
    for (
      let j = firstVisibleFrom(interval.start);
      j < VISIBLE_INTERVALS.length;
      j++
    ) {
      const [visStart, visEnd] = VISIBLE_INTERVALS[j]!;
      if (visStart > interval.end) break;
      const start = Math.max(visStart, interval.start);
      const end = Math.min(visEnd, interval.end);
      if (start <= end) raw.push({ start, end });
    }
  }
  // Enumeration follows CODEPOINT order within a category (the spans
  // carry prefix sums, so the binary searches need them sorted). The
  // chip bar still lists blocks in taxonomy order; the GRID browsing a
  // group aggregate walks its codepoints ascending.
  raw.sort((a, b) => a.start - b.start);
  const spans: VisibleSpan[] = [];
  let before = 0;
  for (const { start, end } of raw) {
    spans.push({ start, end, before });
    before += end - start + 1;
  }
  return spans;
}

/** The visible spans of a category (memoized; declaration order). */
function visibleSpans(id: string): VisibleSpan[] {
  let spans = spanCache.get(id);
  if (spans === undefined) {
    spans = intersectVisible(categoryIntervals(id));
    spanCache.set(id, spans);
  }
  return spans;
}

/** True when `cp` renders real ink (see ./visible.ts). */
export function isVisibleCodepoint(cp: number): boolean {
  let lo = 0;
  let hi = VISIBLE_INTERVALS.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const [start, end] = VISIBLE_INTERVALS[mid]!;
    if (cp < start) hi = mid;
    else if (cp > end) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Visible codepoint count of a category. */
export function categorySize(id: string): number {
  const spans = visibleSpans(id);
  const last = spans[spans.length - 1];
  if (!last) return 0;
  return last.before + (last.end - last.start + 1);
}

/** The nth (0-based) VISIBLE codepoint of a category. */
export function nthCodepoint(id: string, n: number): number {
  const spans = visibleSpans(id);
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const span = spans[mid]!;
    const size = span.end - span.start + 1;
    if (n < span.before) hi = mid - 1;
    else if (n >= span.before + size) lo = mid + 1;
    else return span.start + (n - span.before);
  }
  return ALL_RANGE.start;
}

/**
 * The 0-based VISIBLE index of `cp` within a category (the inverse of
 * nthCodepoint), or null when the codepoint is outside the category or
 * itself invisible. Shift-range selection (issue #20) maps its endpoints
 * through this so the aggregate view never selects a gap.
 */
export function codepointIndex(id: string, cp: number): number | null {
  const spans = visibleSpans(id);
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const span = spans[mid]!;
    if (cp < span.start) hi = mid - 1;
    else if (cp > span.end) lo = mid + 1;
    else return span.before + (cp - span.start);
  }
  return null;
}

/** The nominal grid page: 1024 cells (the live page may be smaller). */
export const CELLS_PER_PAGE = 1024;

/** Page count of a category at `perPage` cells per page. */
export function pageCountFor(id: string, perPage = CELLS_PER_PAGE): number {
  return Math.max(1, Math.ceil(categorySize(id) / perPage));
}
