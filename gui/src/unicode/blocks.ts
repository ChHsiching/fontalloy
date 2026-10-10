/**
 * Curated Unicode block hierarchy for the character map.
 *
 * "Hierarchical categories and the 'all' aggregate view coexist" (ADR-0004):
 * `all` spans U+0020..U+10FFFF excluding the surrogate gap, so unassigned and
 * astral codepoints are browsable too — the grid renders whatever the loaded
 * fonts provide and falls back visually elsewhere.
 */

export interface UnicodeBlock {
  id: string;
  /** UI (Chinese) name. */
  name: string;
  /** English name, for reference/debugging. */
  en: string;
  start: number;
  end: number;
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

export function findBlock(id: string): UnicodeBlock | undefined {
  return BLOCK_BY_ID.get(id);
}

export function categoryName(id: string): string {
  if (id === ALL_CATEGORY_ID) return "全部";
  return BLOCK_BY_ID.get(id)?.name ?? id;
}

/** Codepoint count of a category (all = union minus the surrogate gap). */
export function categorySize(id: string): number {
  if (id === ALL_CATEGORY_ID) {
    const bmp = 0xd7ff - ALL_RANGE.start + 1;
    const astral = ALL_RANGE.end - 0xe000 + 1;
    return bmp + astral;
  }
  const b = BLOCK_BY_ID.get(id);
  return b ? b.end - b.start + 1 : 0;
}

/** The nth codepoint (0-based) of a category, skipping the surrogate gap. */
export function nthCodepoint(id: string, n: number): number {
  if (id === ALL_CATEGORY_ID) {
    const bmpEnd = 0xd7ff;
    if (n < bmpEnd - ALL_RANGE.start + 1) return ALL_RANGE.start + n;
    return 0xe000 + (n - (bmpEnd - ALL_RANGE.start + 1));
  }
  const b = BLOCK_BY_ID.get(id);
  if (!b) return ALL_RANGE.start;
  return b.start + n;
}

/**
 * The 0-based index of `cp` within a category's enumeration (the inverse
 * of nthCodepoint), or null when the codepoint is outside the category.
 * Shift-range selection (issue #20) maps its endpoints through this so the
 * aggregate view's surrogate gap is never selected through.
 */
export function codepointIndex(id: string, cp: number): number | null {
  if (id === ALL_CATEGORY_ID) {
    if (cp < ALL_RANGE.start || cp > ALL_RANGE.end) return null;
    if (cp >= 0xd800 && cp <= 0xdfff) return null;
    const bmpEnd = 0xd7ff;
    return cp <= bmpEnd
      ? cp - ALL_RANGE.start
      : cp - 0xe000 + (bmpEnd - ALL_RANGE.start + 1);
  }
  const b = BLOCK_BY_ID.get(id);
  if (!b || cp < b.start || cp > b.end) return null;
  return cp - b.start;
}

export const CELLS_PER_PAGE = 1024;

export function pageCountFor(id: string): number {
  return Math.max(1, Math.ceil(categorySize(id) / CELLS_PER_PAGE));
}
