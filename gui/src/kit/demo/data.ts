/**
 * Kit demo fixtures — realistic data carried from the prototype's demo
 * sets (font list, language presets, category structure, sample copy).
 * Demo-only; the real app reads its own catalog/state.
 */

import type { PickerFont } from "../pickerPopup";
import type { CategoryBlock, CategoryGroup } from "../categoryChips";
import type { GridCellData } from "../grid";
import type { StatusBarStats } from "../statusBar";

/* ---------- fonts ---------- */

export const EN_FONTS: readonly PickerFont[] = [
  { id: "jbmono", name: "JetBrains Mono", family: "JetBrains Mono", meta: { trait: "连字" } },
  { id: "firacode", name: "Fira Code", family: "Fira Code", meta: { trait: "连字" } },
  { id: "cascadia", name: "Cascadia Code", family: "Cascadia Code", meta: { trait: "微软" } },
  { id: "iosevka", name: "Iosevka", family: "Iosevka", meta: { trait: "超窄" } },
  { id: "hack", name: "Hack", family: "Hack", meta: { trait: "经典" } },
  { id: "scp", name: "Source Code Pro", family: "Source Code Pro", meta: { trait: "Adobe" } },
  { id: "plex", name: "IBM Plex Mono", family: "IBM Plex Mono", meta: { trait: "IBM" } },
  { id: "victor", name: "Victor Mono", family: "Victor Mono", meta: { trait: "手写" } },
];

export const CJK_FONTS: readonly PickerFont[] = [
  {
    id: "maple",
    name: "Maple Mono CN",
    family: "Microsoft YaHei",
    meta: { stars: 29170, license: "OFL-1.1", trait: "圆角等宽" },
  },
  {
    id: "lxgw",
    name: "霞鹜文楷 Screen",
    family: "Microsoft YaHei",
    meta: { stars: 2176, license: "OFL-1.1", trait: "楷体" },
  },
  {
    id: "noto",
    name: "思源黑体",
    family: "Microsoft YaHei",
    meta: { stars: 4090, license: "OFL-1.1", trait: "黑体" },
  },
];

/* ---------- languages ---------- */

export interface LanguagePreset {
  id: string;
  label: string;
  count: string;
}

export const LANGUAGES: readonly LanguagePreset[] = [
  { id: "zh_cn", label: "简体中文", count: "6,765" },
  { id: "zh_tw", label: "繁体中文", count: "13,063" },
  { id: "ja", label: "日文", count: "2,314" },
  { id: "ko", label: "韩文", count: "2,442" },
];

/* ---------- categories ---------- */

const range = (start: number, end: number): string =>
  Array.from({ length: end - start + 1 }, (_, i) =>
    String.fromCodePoint(start + i),
  ).join("");

/** The common-hanzi fill string (demo slice of the prototype's list). */
const COMMON =
  "的一是了我不人在他有这上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因很给名法间斯知世什两次使身者被高亲其进此话常与活正感见明问力理尔点文几定本公特做外孩相西果走将月十实向声车全信重三机工物气每并别真打太新比才便夫再书部水像眼等体却加电主界门利海受听表德少克代员许先口由死安写性马光白或住难望教命花结乐色更拉东神记处让母父应直字场平报友关放至张认接告入笑内军候民岁往何度山觉路带万男边风解叫任金快原吃妈变通师立象数四失满战远格士音轻目条呢病始达深完今提求清王化空业思切怎非找片罗钱吗语元喜曾离飞科言干流欢约各即指合反题必该论交终林请医晚制球决传画保读运及则房早院量苦火布品近坐产答星精视五连司巴管类未朋且婚台夜青北队久乎越观落尽形影红爸百令周吧识步希亚术留市半热送兴造谈容极随演收首根讲整式取照办强石古华拿计您装似足双妻尼转诉米称丽客南领节衣站黑刻统断福城故历惊脸选包紧争另建维绝树系伤示愿持千史谁准联妇纪基买志静阿诗独复痛消社算义竟确酒需单治卡幸兰念举仅钟怕共毛句息功官待究跟穿室易游程号居考突皮哪费倒价图具刚脑永歌响商礼细专黄块脚味灵改据般破引食仍存众注笔甚某沉血备习校默务土微娘须试怀料调广苏显赛查密议底列富梦错座参八跑除蓝亮轮余额扣款成功注释里也写中文等宽对齐变量函数返回值字体合成预览覆盖缺失已调整报告配方";

/** Deterministic hanzi pool: common list first, then sequential fill. */
function hanziPool(size: number): string[] {
  const set = new Set<string>([...COMMON]);
  for (let cp = 0x4e00; set.size < size; cp++) {
    set.add(String.fromCodePoint(cp));
  }
  return [...set].sort();
}

export interface DemoBlock {
  id: string;
  label: string;
  count: number;
  chars: readonly string[];
  groupId: string;
  groupLabel: string;
  /** Default side: CJK-ish blocks come from the donor. */
  side: "base" | "donor";
}

function makeBlocks(): DemoBlock[] {
  const upper = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
  const lower = [..."abcdefghijklmnopqrstuvwxyz"];
  const greek = [..."ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρστυφχψω"];
  const digits = [..."0123456789"];
  const punct = [".", ",", ";", ":", "!", "?", "'", '"', "(", ")", "-", "–", "—", "…"];
  const math = [..."+-*/=<>≈≠≤≥±×÷√∑∏∫∞∝"];
  const brackets = [..."()[]{}<>«»‹›「」【】"];
  const special = [..."@#$%^&*_~|/`"];
  const arrows = [..."←↑→↓↔↕↖↗↘↙⇐⇒⇔"];
  const box = [..."─│┌┐└┘├┤┬┴┼═║╔╗╚╝"];
  const nf = [0xe000, 0xe00a, 0xe0a0, 0xe0a3, 0xe0b0, 0xe0c8, 0xe0d4, 0xe200, 0xe2a9, 0xe300, 0xe3e3, 0xe5fa, 0xe6bb, 0xe700, 0xe958, 0xea60, 0xea88, 0xf000, 0xf385, 0xf400, 0xf533].flatMap(
    (start) =>
      Array.from({ length: Math.min(12, 0xf533 - start + 1) }, (_, i) =>
        String.fromCodePoint(start + i),
      ),
  );
  const fullwidth = [...range(0xff10, 0xff19), ...range(0xff21, 0xff3a), ...range(0xff41, 0xff5a)];
  const cpPunct = [..."，。、；：？!“”‘’（）《》【】「」『』——……·～￥〈〉"];
  const hanzi = hanziPool(6765);

  const def = (
    id: string,
    label: string,
    chars: readonly string[],
    groupId: string,
    groupLabel: string,
    side: "base" | "donor",
  ): DemoBlock => ({ id, label, chars, groupId, groupLabel, side, count: chars.length });

  return [
    def("upper", "大写", upper, "letters", "字母", "base"),
    def("lower", "小写", lower, "letters", "字母", "base"),
    def("greek", "希腊", greek, "letters", "字母", "base"),
    def("digits", "数字", digits, "nums", "数字与符号", "base"),
    def("punct", "标点", punct, "nums", "数字与符号", "base"),
    def("math", "数学", math, "nums", "数字与符号", "base"),
    def("brackets", "括号", brackets, "nums", "数字与符号", "base"),
    def("special", "特殊", special, "nums", "数字与符号", "base"),
    def("arrows", "箭头", arrows, "nums", "数字与符号", "base"),
    def("box", "制表", box, "nums", "数字与符号", "base"),
    def("nf", "Nerd Font", nf, "icons", "图标", "base"),
    def("fw", "全角形式", fullwidth, "cjk", "中文", "donor"),
    def("cp", "中文标点", cpPunct, "cjk", "中文", "donor"),
    def("hanzi", "汉字区", hanzi, "cjk", "中文", "donor"),
  ];
}

export const DEMO_BLOCKS: readonly DemoBlock[] = makeBlocks();

/** Two deliberately missing glyphs (demo of the dashed danger cell). */
export const MISSING_CHARS = new Set(["烎", "烏"]);

/** A few deliberately adjusted codepoints (demo of the corner dot). */
export const ADJUSTED_CHARS = new Set(["的", "一", "是", "A", "永"]);

export function demoGroups(): CategoryGroup[] {
  const groups: CategoryGroup[] = [
    {
      id: "all",
      label: "全部",
      count: DEMO_BLOCKS.reduce((a, b) => a + b.count, 0),
      icon: "all",
    },
  ];
  for (const gid of ["letters", "nums", "icons", "cjk"]) {
    const subs = DEMO_BLOCKS.filter((b) => b.groupId === gid);
    groups.push({
      id: gid,
      label: subs[0].groupLabel,
      count: subs.reduce((a, b) => a + b.count, 0),
      icon:
        gid === "letters"
          ? "type"
          : gid === "nums"
            ? "calc"
            : gid === "icons"
              ? "shapes"
              : "lang",
    });
  }
  groups.push({ id: "miss", label: "缺失", count: MISSING_CHARS.size, icon: "warn", danger: true });
  return groups;
}

const SUB_ICONS: Record<string, string> = {
  upper: "up", lower: "down", greek: "sigma", digits: "hash", punct: "dots",
  math: "inf", brackets: "braces", special: "at", arrows: "arrow", box: "grid",
  nf: "star", fw: "wide", cp: "circdot", hanzi: "lines",
};

export function demoBlocksFor(groupId: string | null): CategoryBlock[] {
  if (!groupId) return [];
  const subs = DEMO_BLOCKS.filter((b) => b.groupId === groupId);
  if (subs.length === 0) return [];
  const out: CategoryBlock[] = [
    {
      id: `g:${groupId}`,
      label: "全部",
      count: subs.reduce((a, b) => a + b.count, 0),
      icon: "all",
    },
  ];
  for (const sub of subs) {
    out.push({
      id: sub.id,
      label: sub.label,
      count: sub.count,
      icon: (SUB_ICONS[sub.id] ?? "tag") as never,
    });
  }
  return out;
}

/* ---------- grid ---------- */

export interface DemoCellModel {
  ch: string;
  side: "base" | "donor";
  missing: boolean;
  adjusted: boolean;
}

/** The demo's effective font stacks (base / donor winners). */
export const BASE_STACK = "Consolas,ui-monospace,monospace";
export const DONOR_STACK = "'Microsoft YaHei',sans-serif";

/** The demo's picker names for the char popup's 来自 line. */
export const BASE_NAME = EN_FONTS[0]!.name;
export const DONOR_NAME = CJK_FONTS[0]!.name;

export function gridCellData(model: DemoCellModel, selected: boolean): GridCellData {
  return {
    ch: model.ch,
    state: model.missing ? "none" : model.side,
    adjusted: model.adjusted,
    selected,
    fontFamily: model.side === "donor" ? DONOR_STACK : BASE_STACK,
  };
}

/* ---------- stats ---------- */

export function demoStats(selectionCount: number): StatusBarStats {
  let en = 0;
  let cjk = 0;
  let missing = 0;
  let adjusted = 0;
  const seen = new Set<string>();
  for (const block of DEMO_BLOCKS) {
    for (const ch of block.chars) {
      seen.add(ch);
      if (MISSING_CHARS.has(ch)) {
        missing++;
        continue;
      }
      if (block.side === "base") en++;
      else cjk++;
      if (ADJUSTED_CHARS.has(ch)) adjusted++;
    }
  }
  // Missing glyphs may sit outside every block — they still count.
  for (const ch of MISSING_CHARS) {
    if (!seen.has(ch)) missing++;
  }
  const total = en + cjk + missing;
  const pct = ((100 * (total - missing)) / total).toFixed(2);
  return { total, en, cjk, adjusted: adjusted + selectionCount, missing, coveragePct: pct };
}
