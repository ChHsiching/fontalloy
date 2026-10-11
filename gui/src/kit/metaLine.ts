/**
 * FontAlloy kit — MetaLine.
 *
 * The picker's signature "no-pills" metadata row: an accent-colored
 * GitHub star count, a license tag, and a trait tag — all plain 10px
 * text on one baseline, never pills. The star count renders in
 * tabular-nums with a filled star glyph in the accent color.
 */

import { icon } from "./icons";

/** Font metadata shown by a MetaLine. All fields optional. */
export interface FontMeta {
  /** GitHub stars, raw number (rendered as `29.2k`). */
  stars?: number;
  /** License SPDX id; the `-1.1` suffix is dropped (`OFL-1.1` → `OFL`). */
  license?: string;
  /** Trait tag, e.g. 连字 / 楷体 / 圆角等宽. */
  trait?: string;
}

/** Format a raw star count the way the prototype does: `29.2k`. */
export function formatStars(stars: number): string {
  return `${(stars / 1000).toFixed(1)}k`;
}

/**
 * Build a meta line node. The row is flex-none + nowrap everywhere so
 * long names can never collapse it (prototype picker-row lesson).
 */
export function metaLine(meta: FontMeta): HTMLElement {
  const row = document.createElement("span");
  row.className = "kit-meta";
  if (meta.stars !== undefined) {
    const gh = document.createElement("span");
    gh.className = "kit-gh";
    gh.innerHTML = icon("starFilled");
    const n = document.createElement("span");
    n.className = "kit-num";
    n.textContent = formatStars(meta.stars);
    gh.appendChild(n);
    row.appendChild(gh);
  }
  if (meta.license) {
    const lic = document.createElement("span");
    lic.className = "kit-lic";
    lic.textContent = meta.license.replace("-1.1", "");
    row.appendChild(lic);
  }
  if (meta.trait) {
    const tg = document.createElement("span");
    tg.className = "kit-tg";
    tg.textContent = meta.trait;
    row.appendChild(tg);
  }
  return row;
}
