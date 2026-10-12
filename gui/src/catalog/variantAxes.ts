/**
 * The variant-chip model (round 7, the catalog expansion): one FAMILY
 * ROW per typeface with typed variant chips — icons plain/NF, CJK
 * width mono/hw, region, charset, rendering, weight — computed off the
 * manifest mirror (`data/catalog.json`, whose entries carry an optional
 * `axes` object rendered from `assets/fonts.manifest.json`).
 *
 * The chips are the research's observed publisher matrices (Maple
 * NF/NL/CN, Nerd Fonts icon-width naming, Sarasa Gothic/Mono/Term/
 * Fixed, Source Han Sans HW, yuru7's base/NF, LXGW's mono/screen/GB
 * cross product realized as separate repos): one axis value per chip,
 * values straight from the manifest's typed `axes`, impossible
 * combinations simply never resolve (the chip disables — exactly the
 * "no such row" rule).
 *
 * WenKai's six manifest families (kai × mono × screen × GB, separate
 * upstream repos) collapse onto ONE display row through the curated
 * `groups` table in curated-meta.json; the group's entries are the
 * member families' entries, and a chip resolves to the exact member's
 * {family, variant}.
 */

import catalogManifest from "../data/catalog.json";

/** The typed axis ids the manifest carries (the chip taxonomy). */
export type AxisId =
  | "icons"
  | "ligature"
  | "cjk_width"
  | "style"
  | "region"
  | "charset"
  | "rendering"
  | "weight";

/** One axis value as the manifest records it. */
export type AxisValue = string;

/** The `axes` object one manifest entry carries (all keys optional). */
export type Axes = Partial<Record<AxisId, AxisValue>>;

/**
 * The chip label vocabulary (round 7 redesign, owner item 2 — "看不懂"):
 * full Chinese terms only, real words per the report-copy style
 * (`fontalloy-notes/report-copy.md` §4). No raw axis ids ever render;
 * the only Latin that may appear is vendor casing the community
 * already uses (NF, GB, Term, Fixed, Light/Medium — §4.9).
 */
const CHIP_LABELS: Record<string, string> = {
  // icons (plain is the implicit default; it labels when contrasting)
  "icons:plain": "无图标",
  "icons:nf": "NF 图标",
  "icons:nf-mono": "NF 图标（等宽）",
  "icons:nf-propo": "NF 图标（比例）",
  // ligature
  "ligature:liga": "连字",
  "ligature:nl": "无连字",
  // cjk_width（中文字符宽度）
  "cjk_width:prop": "比例",
  "cjk_width:mono": "等宽",
  "cjk_width:hw": "半宽",
  "cjk_width:term": "Term（终端）",
  "cjk_width:fixed": "Fixed（定宽）",
  // region（简繁地区）
  "region:SC": "简体中文",
  "region:TC": "繁体中文",
  "region:JP": "日文",
  "region:KR": "韩文",
  "region:HK": "香港",
  // charset（收录字库）
  "charset:full": "全集",
  "charset:GB": "GB 字库",
  "charset:Lite": "Lite 字库",
  // rendering（屏显优化）
  "rendering:print": "印刷",
  "rendering:screen": "屏显优化",
  // weight (values are the vendor's standard names, §4.9)
  "weight:Thin": "Thin",
  "weight:ExtraLight": "ExtraLight",
  "weight:Light": "Light",
  "weight:Regular": "Regular",
  "weight:Medium": "Medium",
  "weight:SemiBold": "SemiBold",
  "weight:Bold": "Bold",
  "weight:ExtraBold": "ExtraBold",
  "weight:Black": "Black",
};

/** Chip label for one axis value (axis defaults fall back to the value). */
export function chipLabel(axis: AxisId, value: AxisValue): string {
  return CHIP_LABELS[`${axis}:${value}`] ?? value;
}

/**
 * The picker-level variant help (round 7): what a variant IS, one
 * sentence, plus one row per axis the chips can carry. The terms are
 * the report-copy vocabulary (图标 / 连字 / 宽度 / 地区 / 字库 / 用途 /
 * 字重) — never the axis ids.
 */
export const AXIS_HELP_ROWS: ReadonlyArray<readonly [string, string]> = [
  ["图标", "是否内置 Nerd Font 图标（NF 图标）"],
  ["连字", "多个字符连写成一个字形"],
  ["宽度", "中文字符按等宽还是比例占位"],
  ["地区", "收录简体、繁体或日韩的字形"],
  ["字库", "收录字符的范围（全集、GB 字库）"],
  ["用途", "为屏幕显示或印刷优化"],
  ["字重", "笔画的粗细（Light、Regular、Medium…）"],
];

/**
 * The axes that render as chips ONLY when the family carries more than
 * one value: a uniform axis (every entry SC, every entry sans) is the
 * row's identity, not a chip. `weight` is exempt: its values come from
 * the variant names of multi-weight families (WenKai Light/Medium).
 */
const CONTRASTING_AXES: readonly AxisId[] = [
  "icons",
  "ligature",
  "cjk_width",
  "region",
  "charset",
  "rendering",
  "weight",
];

/**
 * The value an entry effectively carries on an axis: the recorded one,
 * else the axis's implicit default (a family with no width axes is the
 * proportional/plain cut). `weight` falls back to the variant name.
 */
const AXIS_DEFAULTS: Partial<Record<AxisId, AxisValue>> = {
  icons: "plain",
  ligature: "liga",
  cjk_width: "prop",
  charset: "full",
  rendering: "print",
};

/** The default value of an axis over a value list (weight prefers Regular). */
function defaultValue(axis: AxisId, values: AxisValue[]): AxisValue {
  if (axis === "weight" && values.includes("Regular")) return "Regular";
  const fallback = AXIS_DEFAULTS[axis];
  if (fallback !== undefined && values.includes(fallback)) return fallback;
  return values[0]!;
}

/** The effective axes of one entry (defaults filled in). */
function effectiveAxes(entry: CatalogEntryLike): Required<Pick<Axes, never>> & Axes {
  return {
    icons: AXIS_DEFAULTS.icons,
    ligature: AXIS_DEFAULTS.ligature,
    cjk_width: AXIS_DEFAULTS.cjk_width,
    charset: AXIS_DEFAULTS.charset,
    rendering: AXIS_DEFAULTS.rendering,
    weight: entryWeight(entry),
    ...entry.axes,
  };
}

/** Manifest mirror entry as this module consumes it. */
export interface CatalogEntryLike {
  family: string;
  variant: string;
  file: string;
  version: string;
  axes?: Axes;
}

const ENTRIES = catalogManifest.families as CatalogEntryLike[];

/** All manifest entries of one family, in manifest (sorted) order. */
export function familyEntries(family: string): CatalogEntryLike[] {
  return ENTRIES.filter((entry) => entry.family === family);
}

/** One display row: one typeface, its entries, its resolved chips. */
export interface DisplayFamily {
  /** The row id: the manifest family, or the group id for a group. */
  id: string;
  /** The manifest families the row spans (one entry for plain rows). */
  families: string[];
  entries: CatalogEntryLike[];
}

/**
 * Build the display families: manifest families minus grouped members,
 * plus the curated groups (the WenKai collapse). Group definitions are
 * `{ [groupId]: [memberFamily, ...] }`; the group id is also the row
 * label fallback and the primary member.
 */
export function displayFamilies(groups: Record<string, string[]>): DisplayFamily[] {
  const grouped = new Set(Object.values(groups).flat());
  const rows: DisplayFamily[] = [];
  for (const entry of ENTRIES) {
    if (grouped.has(entry.family)) continue;
    if (rows.at(-1)?.id === entry.family) continue;
    rows.push({
      id: entry.family,
      families: [entry.family],
      entries: familyEntries(entry.family),
    });
  }
  for (const [id, members] of Object.entries(groups)) {
    const entries = members.flatMap((member) => familyEntries(member));
    if (entries.length === 0) continue;
    rows.push({ id, families: members, entries });
  }
  return rows;
}

/** The values one axis takes over a row's entries, default-first. */
export function axisValues(family: DisplayFamily, axis: AxisId): AxisValue[] {
  const seen: AxisValue[] = [];
  for (const entry of family.entries) {
    const value = effectiveAxes(entry)[axis];
    if (value !== undefined && !seen.includes(value)) seen.push(value);
  }
  if (seen.length === 0) return seen;
  const head = defaultValue(axis, seen);
  return [head, ...seen.filter((value) => value !== head)];
}

/** The axes that render chips on one row (more than one value present). */
export function chipAxes(family: DisplayFamily): Array<{ axis: AxisId; values: AxisValue[] }> {
  return CONTRASTING_AXES.map((axis) => ({ axis, values: axisValues(family, axis) }))
    .filter(({ values }) => values.length > 1);
}

/** One axis selection (at most one value per axis; none = the default). */
export type VariantSelection = Partial<Record<AxisId, AxisValue>>;

/**
 * Resolve a selection to the exact entry: the unique entry whose
 * EFFECTIVE axes agree with every selected value. Unselected axes take
 * the row's default value (first of `axisValues` — prop/plain/print/
 * full/Regular), so picking {mono} on the WenKai row yields the plain
 * mono cut, not the GB screen one. Returns null when no entry matches
 * (the impossible combination — the chip disables).
 */
export function resolveVariant(
  family: DisplayFamily,
  selection: VariantSelection,
): CatalogEntryLike | null {
  const required: Partial<Record<AxisId, AxisValue>> = {};
  for (const { axis, values } of chipAxes(family)) {
    required[axis] = selection[axis] ?? values[0]!;
  }
  const matches = family.entries.filter((entry) => {
    const effective = effectiveAxes(entry);
    return (Object.keys(required) as AxisId[]).every(
      (axis) => effective[axis] === required[axis],
    );
  });
  return matches.length >= 1 ? (matches[0] as CatalogEntryLike) : null;
}

/**
 * The weight of an entry when the axes do not carry one: WenKai's
 * Light/Regular/Medium variants name it (the manifest's weight axis for
 * existing multi-weight families). Variant strings that are NOT weight
 * names (NF, Standard, GB, Plus …) are axis data, never weights — they
 * collapse to Regular so they cannot leak in as a phantom weight axis.
 */
const WEIGHT_NAMES: ReadonlySet<string> = new Set([
  "Thin",
  "ExtraLight",
  "Light",
  "Regular",
  "Medium",
  "SemiBold",
  "Bold",
  "ExtraBold",
  "Black",
]);

export function entryWeight(entry: CatalogEntryLike): AxisValue {
  const recorded = entry.axes?.weight;
  if (recorded !== undefined) return recorded;
  return WEIGHT_NAMES.has(entry.variant) ? entry.variant : "Regular";
}
