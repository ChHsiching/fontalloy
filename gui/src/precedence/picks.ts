/**
 * The current picks as build font refs (issue #18): the EN pick is the
 * base (`base`), the CJK pick the one donor (`donor-0`) — the same join
 * order the synthesize recipe uses. Shared by the character map and the
 * rail rule editors so every rule editor offers the same ref list.
 */

import { store, type LoadedFont } from "../state";

/** The picks, as the precedence model addresses them. */
export interface PickRefs {
  /** Font refs in join order: `base` then `donor-0` (absent when unpicked). */
  refs: string[];
  base: LoadedFont | null;
  donor: LoadedFont | null;
}

/** The picks of the current state (null picks drop out entirely). */
export function pickRefs(): PickRefs {
  const { fonts, selected } = store.get();
  const base = fonts.find((f) => f.cssFamily === selected.en) ?? null;
  const donor = fonts.find((f) => f.cssFamily === selected.cjk) ?? null;
  const refs: string[] = [];
  if (base) refs.push("base");
  if (donor) refs.push("donor-0");
  return { refs, base, donor };
}

/** The LoadedFont behind a font ref, when picked. */
export function refFont(ref: string, picks: PickRefs): LoadedFont | null {
  if (ref === "base") return picks.base;
  if (ref === "donor-0") return picks.donor;
  return null;
}

/** Chinese label of a font ref for details and rule editors. */
export function refLabel(ref: string, picks: PickRefs): string {
  const font = refFont(ref, picks);
  if (ref === "base") return `英文字体 ${font?.family ?? "基底"}`;
  return `中文字体 ${font?.family ?? "供体"}`;
}
