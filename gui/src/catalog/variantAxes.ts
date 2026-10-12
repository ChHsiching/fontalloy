/**
 * The variant-cut model (round 7 chips, round 8 final form): one FAMILY
 * ROW per typeface whose chips are its CUTS — the distinct releases the
 * manifest actually pins (Maple NF / NF-CN, Noto Sans SC HW / Mono /
 * Variable, the WenKai group's kai × mono × screen × GB members).
 *
 * Round 9 (owner item 2): chip LABELS are the data's own words — the
 * registered cut's name-table name after the family's shared base
 * (「Maple Mono NF CN」 vs 「Maple Mono NF」 → CN), else the manifest's
 * variant word (NF / NF-CN / GB / Plus …), else the release asset's own
 * suffix (LXGWWenKaiScreen → Screen). No translated or hand-built
 * tokens — 屏幕版-style labels are gone; the author's spelling (Screen)
 * ships instead.
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
   * The data's own label (round 9): the manifest's variant word when it
   * names the cut, else the release asset's own suffix, else 标准. Live
   * name-table refinement happens in `cutLabels` at render time.
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
 * Variant strings that NAME the cut officially (used verbatim as the
 * chip label). Weight names and the unmodified-cut names (Regular,
 * Standard, Nerd Font) do not — the cut then derives its label from
 * the contrasting axes.
 */
function isOfficialCutName(variant: string): boolean {
  return (
    variant !== "" &&
    !WEIGHT_NAMES.has(variant) &&
    variant !== "Standard" &&
    variant !== "Nerd Font"
  );
}

/** The words the release ASSET itself uses after the family prefix. */
function assetSuffixWords(file: string, groupId: string): string {
  const stem = file.replace(/\.[^.]+$/, "");
  const rest =
    groupId.length > 0 && stem.toLowerCase().startsWith(groupId.toLowerCase())
      ? stem.slice(groupId.length)
      : stem;
  return rest.replace(/^[-_.]+/, "").replace(/[-_](?=[^-_]*$)/, " ").trim();
}

/**
 * The cut's DATA label (round 9, owner item 2): the manifest variant's
 * own word when it names the cut, else the release asset's own suffix
 * (LXGWWenKaiScreen after LXGWWenKai → Screen). 标准 when the data
 * names nothing distinguishing (the row default always reads 标准).
 */
export function dataCutLabel(
  entry: CatalogEntryLike,
  def: boolean,
  groupId: string,
): string {
  if (def) return "标准";
  if (isOfficialCutName(entry.variant)) return entry.variant;
  const suffix = assetSuffixWords(entry.file, groupId);
  return suffix || "标准";
}

/** Words of `name` after the word prefix it shares with `base`. */
function suffixWords(name: string, base: string): string {
  const a = name.split(/\s+/);
  const b = base.split(/\s+/);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(i).join(" ");
}

/**
 * The chip labels of one display family (round 9, owner item 2): each
 * cut in the AUTHOR'S OWN words — the registered cut's name-table
 * display after the words it shares with the default cut's registered
 * name — falling back to the data label when either side is not
 * registered yet. The default cut always reads 标准.
 *
 * `nameOf` returns the registered font's name-table display string for
 * a cut whose face is registered, undefined otherwise.
 */
export function cutLabels(
  cuts: readonly VariantCut[],
  groupId: string,
  nameOf: (cut: VariantCut) => string | undefined,
): Map<string, string> {
  const def = cuts.find((cut) => cut.def) ?? cuts[0];
  const defName = def !== undefined ? nameOf(def) : undefined;
  const out = new Map<string, string>();
  for (const cut of cuts) {
    if (cut.def) {
      out.set(cut.id, "标准");
      continue;
    }
    const live = nameOf(cut);
    const suffix =
      live !== undefined && defName !== undefined
        ? suffixWords(live, defName)
        : "";
    out.set(cut.id, suffix || dataCutLabel(cut.entry, cut.def, groupId));
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
 * The picker-level variant help (round 8 final form; round 9 words):
 * what a variant IS, one sentence, plus one row per word the chips can
 * carry — the data's own vocabulary (the author's words and the
 * manifest's variant strings), with plain-word meanings. No weight row
 * (the axis is not a chip).
 */
export const TOKEN_HELP_ROWS: ReadonlyArray<readonly [string, string]> = [
  ["NF / NL", "内置 Nerd Font 图标 / 无连字的版本"],
  ["Mono / HW", "中文字符按等宽或半宽占位"],
  ["SC / TC / JP", "收录简体、繁体或日文地区字形"],
  ["Screen", "为屏幕显示优化的版本"],
  ["GB / Lite", "收录字库的范围"],
  ["标准", "家族默认版本（无标注）"],
];
