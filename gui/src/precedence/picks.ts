/**
 * The current picks as build font refs (issue #18): the EN pick is the
 * base (`base`), the CJK pick the one donor (`donor-0`) — the same join
 * order the synthesize recipe uses. Shared by the character map and the
 * rail rule editors so every rule editor offers the same ref list.
 *
 * Round 12 (owner item 8): a catalog pick carries a FACE SET — every
 * registered face of the picked family+variant, the representative
 * first. Round 13 (owner item 7): a LOCAL pick carries one too — the
 * same-directory siblings the load path discovered and registered as
 * data-only records behind the representative. A pick whose store
 * holds one face (a one-file family) carries just the representative:
 * that file IS the user's pick.
 */

import { store, type LoadedFont } from "../state";

/** The picks, as the precedence model addresses them. */
export interface PickRefs {
  /** Font refs in join order: `base` then `donor-0` (absent when unpicked). */
  refs: string[];
  /**
   * The representative face of each pick — the Regular-preferred face a
   * catalog pick registered first, or the local file itself. The
   * preview/identity face; what every ref resolves to.
   */
  base: LoadedFont | null;
  donor: LoadedFont | null;
  /**
   * The pick's face set (round 12): every registered face of a catalog
   * family pick, the representative first. Single-face picks carry one
   * entry — the representative.
   */
  baseFaces: LoadedFont[];
  donorFaces: LoadedFont[];
}

/** One pick's face set: the catalog identity's faces, else the pick. */
function faceSet(fonts: readonly LoadedFont[], font: LoadedFont | null): LoadedFont[] {
  if (font === null) return [];
  if (font.catalog !== undefined) {
    const faces = fonts.filter(
      (f) =>
        f.catalog?.family === font.catalog!.family &&
        f.catalog?.variant === font.catalog!.variant,
    );
    if (faces.length > 0) return faces;
  }
  return localFaceSet(fonts, font);
}

/**
 * A local pick's face set (round 13, owner item 7): every local record
 * of the pick's name-table family — the representative first (it is
 * the pick; the siblings are data-only records the load path's
 * discovery sweep appended). The css family IS the parsed name-table
 * family, so same-family records are the same family however it was
 * picked; a one-file family resolves to the representative alone.
 */
export function localFaceSet(
  fonts: readonly LoadedFont[],
  font: LoadedFont,
): LoadedFont[] {
  if (font.origin !== "local") return [font];
  const siblings = fonts.filter(
    (f) => f.origin === "local" && f.cssFamily === font.cssFamily && f !== font,
  );
  return [font, ...siblings];
}

/** The picks of the current state (null picks drop out entirely). */
export function pickRefs(): PickRefs {
  const { fonts, selected } = store.get();
  const base = fonts.find((f) => f.cssFamily === selected.en) ?? null;
  const donor = fonts.find((f) => f.cssFamily === selected.cjk) ?? null;
  const refs: string[] = [];
  if (base) refs.push("base");
  if (donor) refs.push("donor-0");
  return {
    refs,
    base,
    donor,
    baseFaces: faceSet(fonts, base),
    donorFaces: faceSet(fonts, donor),
  };
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
