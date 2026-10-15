/**
 * The variant-cut model (round 7 chips, round 8 final form): one FAMILY
 * ROW per typeface whose chips are its CUTS — the distinct releases the
 * manifest actually pins (Maple NF / NF-CN, Noto Sans SC HW / Mono /
 * Variable, the WenKai group's kai × mono × screen × GB members).
 *
 * Round 23 (owner item 1): chip LABELS are the font's OWN names — the
 * registered cut's full name-table display string, verbatim, the
 * default cut included. No alias token (标准/HW/Mono-style words are
 * gone), no shared-base subtraction: the chip reads what the font
 * itself is called. A cut whose face is not registered yet falls back
 * to the release artifact's own stem.
 *
 * Round-8 rulings baked in (owner items 6+7):
 *
 * - WEIGHT IS NOT A CHIP, anywhere. Multi-weight families (WenKai
 *   Light/Medium/Regular) collapse onto one cut; the canonical member
 *   prefers the Regular-weight face.
 * - The default cut renders PLAIN — no dashed ring, no 默认 marker.
 *   Only an EXPLICIT pick carries the accent.
 * - Every chip resolves to a real manifest entry, so an impossible
 *   combination never appears (the round-7 greyed-out impossible chips
 *   are gone by construction). A cut whose member family is not
 *   fetched renders disabled with the 未下载 tag.
 * - Identity surfaces (rail card, pair tags, picker header, report and
 *   message source names) render the registered font's own name-table
 *   display string (fonts/registry.ts fontDisplayName) — never a
 *   curated or constructed name.
 *
 * WenKai's six manifest families (kai × mono × screen × GB, separate
 * upstream repos) collapse onto ONE display row through the curated
 * `groups` table in curated-meta.json; the group's entries are the
 * member families' entries, and a chip resolves to the exact member's
 * {family, variant} (recipe references keep that pair verbatim).
 */

import catalogManifest from "../data/catalog.json";

/** The typed axis ids the manifest carries (weight is data, not a chip). */
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

/** The axes a cut's identity spans (weight NEVER — round 8). */
const CUT_AXES: readonly AxisId[] = [
  "icons",
  "ligature",
  "cjk_width",
  "region",
  "charset",
  "rendering",
];

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

/* ---------------- the cut model ---------------- */

/** One selectable cut of a display family (one chip on its row). */
export interface VariantCut {
  /** Stable id: `${family}::${variant}` of the canonical entry. */
  id: string;
  /**
   * The data's own label (round 23): the release artifact's stem,
   * shown until the cut's face is registered — `cutLabels` then
   * refines every chip to the font's own name-table display name.
   */
  label: string;
  /** The exact manifest entry picking this cut resolves to. */
  entry: CatalogEntryLike;
  /** True when this cut is the row's default (the plain chip). */
  def: boolean;
}

/**
 * The weight of an entry when the axes do not carry one: WenKai's
 * Light/Regular/Medium variants name it. Variant strings that are NOT
 * weight names (NF, Standard, GB, Plus …) are axis data, never weights
 * — they collapse to Regular so they cannot leak in as a phantom cut
 * axis.
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

/** The value an entry effectively carries on an axis (implicit defaults filled). */
function effectiveAxis(entry: CatalogEntryLike, axis: AxisId): AxisValue | undefined {
  if (axis === "weight") return entryWeight(entry);
  const defaults: Partial<Record<AxisId, AxisValue>> = {
    icons: "plain",
    ligature: "liga",
    cjk_width: "prop",
    charset: "full",
    rendering: "print",
  };
  return entry.axes?.[axis] ?? defaults[axis];
}

/**
 * The cut's DATA label (round 23, owner item 1): the release artifact's
 * OWN stem — the manifest entry's file name without its extension and
 * the catalog's leading index numbering (`14_SourceHanSansHWSC.zip` →
 * `SourceHanSansHWSC`). Never a translated token and never an invented
 * word: it is the data's own name for the release, shown only until
 * the cut's face is registered and its name-table name takes over
 * (see `cutLabels`).
 */
export function dataCutLabel(
  entry: CatalogEntryLike,
  def: boolean,
  groupId: string,
): string {
  void def;
  void groupId;
  const stem = entry.file
    .replace(/\.[^.]+$/, "")
    .replace(/^\d+_/, "")
    .replace(/[-_]v?\d+(\.\d+)+([-_].*)?$/, "");
  return stem || entry.variant;
}

/**
 * The chip labels of one display family (round 23, owner item 1): each
 * cut in its OWN registered name — the cut's full name-table display
 * string, verbatim, the default cut included. No shared-base
 * subtraction, no alias token: the chip reads what the font itself is
 * called. A cut whose face is not registered yet falls back to the
 * release artifact's own stem (`dataCutLabel`).
 *
 * `nameOf` returns the registered font's name-table display string for
 * a cut whose face is registered, undefined otherwise.
 */
export function cutLabels(
  cuts: readonly VariantCut[],
  groupId: string,
  nameOf: (cut: VariantCut) => string | undefined,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const cut of cuts) {
    out.set(cut.id, nameOf(cut) ?? dataCutLabel(cut.entry, cut.def, groupId));
  }
  return out;
}

/**
 * The cuts of one display family, DEFAULT FIRST: entries collapsed by
 * their non-weight axes (WenKai Light/Medium/Regular are ONE cut whose
 * canonical member prefers the Regular face), each labeled officially.
 * Memoized per display id — the manifest mirror is static data.
 */
const cutCache = new Map<string, VariantCut[]>();

export function variantCuts(family: DisplayFamily): VariantCut[] {
  const cached = cutCache.get(family.id);
  if (cached !== undefined) return cached;
  const cuts = computeVariantCuts(family);
  cutCache.set(family.id, cuts);
  return cuts;
}

function computeVariantCuts(family: DisplayFamily): VariantCut[] {
  if (family.entries.length === 0) return [];

  // Collapse by the non-weight axis vector, keeping manifest order.
  const buckets = new Map<string, CatalogEntryLike[]>();
  for (const entry of family.entries) {
    const key = CUT_AXES.map((axis) => effectiveAxis(entry, axis) ?? "").join("|");
    const bucket = buckets.get(key);
    if (bucket) bucket.push(entry);
    else buckets.set(key, [entry]);
  }
  const canonical = [...buckets.values()].map(
    (members) =>
      members.find((m) => entryWeight(m) === "Regular") ?? members[0]!,
  );

  // The default vector: for every axis the cuts disagree on, the
  // family's implicit default value (icons plain, width prop, charset
  // full, rendering print, ligature liga; region has none — the
  // manifest-first value leads).
  const values = (axis: AxisId): AxisValue[] => {
    const seen: AxisValue[] = [];
    for (const entry of canonical) {
      const value = effectiveAxis(entry, axis);
      if (value !== undefined && !seen.includes(value)) seen.push(value);
    }
    return seen;
  };
  const contrasting = CUT_AXES.filter((axis) => values(axis).length > 1);
  const implicit: Partial<Record<AxisId, AxisValue>> = {
    icons: "plain",
    ligature: "liga",
    cjk_width: "prop",
    charset: "full",
    rendering: "print",
  };
  const defaultVector = new Map(
    contrasting.map((axis) => {
      const list = values(axis);
      const preferred =
        implicit[axis] !== undefined && list.includes(implicit[axis]!)
          ? implicit[axis]!
          : list[0]!;
      return [axis, preferred];
    }),
  );

  const defEntry =
    canonical.find((entry) =>
      contrasting.every(
        (axis) => effectiveAxis(entry, axis) === defaultVector.get(axis),
      ),
    ) ?? canonical[0]!;

  const cuts: VariantCut[] = canonical.map((entry) => {
    const isDef = entry === defEntry;
    return {
      id: `${entry.family}::${entry.variant}`,
      label: dataCutLabel(entry, isDef, family.id),
      entry,
      def: isDef,
    };
  });
  // Default cut first, the rest in manifest order.
  return [cuts.find((cut) => cut.def)!, ...cuts.filter((cut) => !cut.def)];
}

/**
 * The picker-level variant help (round 8 final form; round 23 words):
 * what a variant IS, one sentence, plus one row per word that appears
 * INSIDE the cuts' own names (NF, Mono, HW … are the releases' own
 * vocabulary — the table decodes them, the chips no longer use them as
 * labels). No weight row (the axis is not a chip).
 */
export const TOKEN_HELP_ROWS: ReadonlyArray<readonly [string, string]> = [
  ["NF / NL", "内置 Nerd Font 图标 / 无连字的版本"],
  ["Mono / HW", "中文字符按等宽或半宽占位"],
  ["SC / TC / JP", "收录简体、繁体或日文地区字形"],
  ["Screen", "为屏幕显示优化的版本"],
  ["GB / Lite", "收录字库的范围"],
];
