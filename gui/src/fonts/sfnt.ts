/**
 * Minimal sfnt reader for the GUI preview path: the name table's own
 * strings (family + subfamily, zh and en exactly as the author wrote
 * them — round 9, owner item 2: display names are the font's own,
 * never hand-built) and codepoint coverage (cmap). This is metadata
 * for the FontFace rendering path only — the real merge pipeline lives
 * in core/ and never runs here.
 *
 * Rounds 18–19: coverage is the HONEST kind, following the OpenType
 * conventions alone. A codepoint mapped at glyph 0 is absent by
 * convention, and a mapped glyph whose OUTLINE is the font's own
 * .notdef outline is a suspected placeholder (方框 / boxed X / question
 * face the font draws at codepoints it does not really cover) — those
 * codepoints read as missing here exactly as they do in the core
 * pipeline, so the live grid and status bar agree with the report.
 * Concentration counts for nothing (round 19 — a shared glyph with a
 * real outline is plain coverage). The outline compare is cheap: a
 * contour-count + bounding-box + point-count pre-filter rejects the
 * face's glyphs from the raw glyf record header (or, on CFF faces, the
 * charstring byte length) before the survivors get the full point
 * compare.
 *
 * Supports TrueType/OpenType (and reads the first face of a TTC for
 * metadata); woff2 is left to the FontFace decoder and yields no coverage
 * list (the browser still renders it).
 */

/**
 * The name-table strings a font ships, verbatim. `display` is the
 * family plus the subfamily's distinguishing words — the author's own
 * naming ("LXGW WenKai Screen" stays "LXGW WenKai Screen"); the zh-CN
 * records ride along untranslated for any consumer that wants them.
 */
export interface FontNames {
  /** Preferred family: nameID 16, falling back to nameID 1 (en). */
  family: string;
  /** Preferred subfamily: nameID 17, falling back to nameID 2 (en). */
  subfamily?: string;
  /** The composed display name (family + distinguishing subfamily). */
  display: string;
  /** The zh-CN (0x804) family string when the author wrote one. */
  zhFamily?: string;
  /** The zh-CN subfamily string when the author wrote one. */
  zhSubfamily?: string;
}

export interface FontMeta {
  /** Display family name; nameID 16 preferred over nameID 1. */
  family: string;
  /** The name table's own strings (round 9, owner item 2). */
  names: FontNames;
  /**
   * Sorted covered codepoints (empty when the cmap cannot be read):
   * glyph-0 and suspected-placeholder mappings are excluded (rounds
   * 18–19), so every live count reads like the report's.
   */
  codepoints: number[];
  /**
   * Sorted codepoints the placeholder rules suspect (rounds 18–19):
   * the mappings dropped from `codepoints` because their glyph draws
   * the font's own .notdef outline. A coverage-honest count; no live
   * view needs the list.
   */
  placeholderCodepoints: number[];
  /**
   * The OS/2 usWeightClass (round 20; 400 when the face carries no
   * OS/2 table) — the FontFace weight descriptor a family's sibling
   * faces register under, so a same-family collection renders each
   * weight at its own face instead of colliding on `normal`.
   */
  weight: number;
  /** The face's italic flag (OS/2 fsSelection bit 0, head macStyle bit 1). */
  italic: boolean;
}

export interface ParseFontMetaOptions {
  /**
   * Enumerate the cmap coverage (default true). The enumeration is the
   * expensive half of the parse — a consumer that only needs the names
   * (the catalog's family face-set records, round 12) passes false and
   * gets `codepoints: []`.
   */
  coverage?: boolean;
}

/** The four-byte table tags this reader cares about, as uint32 keys. */
const TAG_NAME = 0x6e616d65;
const TAG_CMAP = 0x636d6170;
const TAG_GLYF = 0x676c7966;
const TAG_LOCA = 0x6c6f6361;
const TAG_HEAD = 0x68656164;
const TAG_MAXP = 0x6d617870;
const TAG_CFF = 0x43464620;
const TAG_OS2 = 0x4f532f32;

export function parseFontMeta(
  buffer: ArrayBuffer,
  options: ParseFontMetaOptions = {},
): FontMeta {
  const view = new DataView(buffer);
  if (view.byteLength < 12) throw new Error("file too small to be a font");

  let base = 0;
  const tag = view.getUint32(0);
  if (tag === 0x74746366) {
    // 'ttcf' — collection: use the first face for metadata.
    const faceCount = view.getUint32(8);
    if (faceCount < 1) throw new Error("font collection has no faces");
    base = view.getUint32(12);
  } else if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565) {
    // 1.0 / 'OTTO' / 'true'
    throw new Error("not a TrueType/OpenType font");
  }

  const numTables = view.getUint16(base + 4);
  const offsets = new Map<number, number>();
  for (let i = 0; i < numTables; i++) {
    const rec = base + 12 + i * 16;
    if (rec + 16 > view.byteLength) break;
    const tableTag = view.getUint32(rec);
    const off = view.getUint32(rec + 8);
    const len = view.getUint32(rec + 12);
    if (off + len <= view.byteLength && !offsets.has(tableTag)) {
      offsets.set(tableTag, off);
    }
  }

  const nameOffset = offsets.get(TAG_NAME) ?? -1;
  const cmapOffset = offsets.get(TAG_CMAP) ?? -1;
  const names =
    nameOffset >= 0 ? readFamilyName(view, nameOffset) : null;
  const coverage =
    cmapOffset >= 0 && (options.coverage ?? true)
      ? readCoverage(view, cmapOffset, offsets)
      : { codepoints: [], placeholders: [] };
  if (names === null || !names.family) {
    throw new Error("font has no readable family name");
  }
  const style = readFaceStyle(view, offsets);
  return {
    family: names.family,
    names,
    codepoints: coverage.codepoints,
    placeholderCodepoints: coverage.placeholders,
    weight: style.weight,
    italic: style.italic,
  };
}

/**
 * The face's weight/italic identity (round 20): OS/2 usWeightClass and
 * fsSelection bit 0, with head macStyle bit 1 as the italic fallback —
 * the descriptors that keep a family's sibling faces distinct under one
 * css family. A face without OS/2 reads weight 400 (the CSS default).
 */
function readFaceStyle(
  view: DataView,
  offsets: ReadonlyMap<number, number>,
): { weight: number; italic: boolean } {
  let weight = 400;
  let italic = false;
  const os2 = offsets.get(TAG_OS2);
  if (os2 !== undefined && os2 + 64 <= view.byteLength) {
    weight = view.getUint16(os2 + 4);
    italic = (view.getUint16(os2 + 62) & 0x0001) !== 0;
  }
  const head = offsets.get(TAG_HEAD);
  if (!italic && head !== undefined && head + 46 <= view.byteLength) {
    // head.macStyle sits at +44 (bit 1 = italic), past the bbox shorts.
    italic = (view.getUint16(head + 44) & 0x0002) !== 0;
  }
  return { weight: weight || 400, italic };
}

interface NameRecord {
  platform: number;
  encoding: number;
  language: number;
  nameId: number;
  length: number;
  strOffset: number;
}

/** Compose the display name: family + the subfamily's own words. */
export function composeDisplay(
  family: string,
  subfamily: string | undefined,
): string {
  // "Regular" (and 标准) is the everyday member — the author's full
  // name needs no suffix then. Anything else the author wrote stays.
  if (subfamily === undefined || /^(regular|标准)$/i.test(subfamily)) {
    return family;
  }
  return family.includes(subfamily) ? family : `${family} ${subfamily}`;
}

/**
 * Read the name table's own strings (round 9, owner item 2): the en
 * (Windows 0x409) family/subfamily through the same precedence chain
 * the FontFace key always used, plus the zh-CN (0x804) records when
 * the author wrote them — verbatim, never translated or recombined
 * beyond the family+subfamily join every OS performs.
 */
function readFamilyName(view: DataView, offset: number): FontNames {
  const count = view.getUint16(offset + 2);
  const stringOffset = view.getUint16(offset + 4);
  const utf16be = new TextDecoder("utf-16be");

  const records: NameRecord[] = [];
  for (let i = 0; i < count; i++) {
    const rec = offset + 6 + i * 12;
    records.push({
      platform: view.getUint16(rec),
      encoding: view.getUint16(rec + 2),
      language: view.getUint16(rec + 4),
      nameId: view.getUint16(rec + 6),
      length: view.getUint16(rec + 8),
      strOffset: view.getUint16(rec + 10),
    });
  }

  const decode = (r: NameRecord): string => {
    const start = offset + stringOffset + r.strOffset;
    const bytes = new Uint8Array(
      view.buffer,
      start,
      Math.min(r.length, view.byteLength - start),
    );
    const text =
      r.platform === 3 || r.platform === 0
        ? utf16be.decode(bytes)
        : new TextDecoder("windows-1252").decode(bytes);
    return text.replace(/\0+$/g, "").trim();
  };

  // Windows Unicode English first, then any Windows Unicode, then Mac Roman.
  const pick = (nameId: number, pred: (r: NameRecord) => boolean): string => {
    for (const r of records) {
      if (r.nameId === nameId && r.length > 0 && pred(r)) {
        const text = decode(r);
        if (text) return text;
      }
    }
    return "";
  };
  const isWinUnicode = (r: NameRecord): boolean =>
    r.platform === 3 && r.encoding === 1;
  const isWinZh = (r: NameRecord): boolean =>
    r.platform === 3 && r.encoding === 1 && r.language === 0x804;
  const isMacRoman = (r: NameRecord): boolean =>
    r.platform === 1 && r.encoding === 0;

  const chain = (nameId: number): string =>
    pick(nameId, (r) => isWinUnicode(r) && r.language === 0x409) ||
    pick(nameId, isWinUnicode) ||
    pick(nameId, isMacRoman);

  const family = chain(16) || chain(1);
  const subfamilyRaw = chain(17) || chain(2);
  const names: FontNames = {
    family,
    ...(subfamilyRaw ? { subfamily: subfamilyRaw } : {}),
    display: composeDisplay(family, subfamilyRaw || undefined),
  };
  const zhFamily = pick(16, isWinZh) || pick(1, isWinZh);
  const zhSubfamily = pick(17, isWinZh) || pick(2, isWinZh);
  if (zhFamily) names.zhFamily = zhFamily;
  if (zhSubfamily) names.zhSubfamily = zhSubfamily;
  return names;
}

/** One cmap read: the effective coverage plus its suspected placeholders. */
interface Coverage {
  codepoints: number[];
  placeholders: number[];
}

function readCoverage(
  view: DataView,
  offset: number,
  offsets: ReadonlyMap<number, number>,
): Coverage {
  const numSubtables = view.getUint16(offset + 2);
  let best: { score: number; offset: number } | null = null;
  for (let i = 0; i < numSubtables; i++) {
    const rec = offset + 4 + i * 8;
    const platform = view.getUint16(rec);
    const encoding = view.getUint16(rec + 2);
    const subOffset = view.getUint32(rec + 4);
    const format = view.getUint16(offset + subOffset);
    let score = -1;
    if (platform === 3 && encoding === 10 && format === 12) score = 5;
    else if (platform === 0 && format === 12) score = 4;
    else if (platform === 0 && format === 4) score = 3;
    else if (platform === 3 && encoding === 1 && format === 4) score = 3;
    else if (platform === 0 && format === 6) score = 2;
    else if (platform === 3 && encoding === 0 && format === 4) score = 1;
    if (score > (best?.score ?? -1)) best = { score, offset: offset + subOffset };
  }
  if (!best) return { codepoints: [], placeholders: [] };
  const sub = best.offset;
  const format = view.getUint16(sub);
  // codepoint → glyph id, glyph-0 mappings dropped on the way in
  // (absent by convention). A glyph whose OUTLINE is the font's own
  // .notdef outline marks its codepoints as placeholders (below).
  const mapped = new Map<number, number>();
  if (format === 4) {
    readFormat4(view, sub, mapped);
  } else if (format === 12) {
    const nGroups = view.getUint32(sub + 12);
    for (let g = 0; g < nGroups; g++) {
      const rec = sub + 16 + g * 12;
      const start = view.getUint32(rec);
      const end = view.getUint32(rec + 4);
      const startGlyph = view.getUint32(rec + 8);
      for (let cp = start; cp <= end && cp <= 0x10ffff; cp++) {
        const glyph = startGlyph + (cp - start);
        if (glyph !== 0) mapped.set(cp, glyph);
      }
    }
  }
  return splitPlaceholders(view, mapped, offsets);
}

/**
 * Round 19's two conventions, applied to the effective cmap: glyph-0
 * mappings are already absent; among the rest, every glyph whose
 * outline is the font's own .notdef outline (glyph 0) is a suspected
 * placeholder and every codepoint it maps reads as missing.
 */
function splitPlaceholders(
  view: DataView,
  mapped: Map<number, number>,
  offsets: ReadonlyMap<number, number>,
): Coverage {
  const isSuspect = makeNotdefOutlineSuspect(view, offsets);
  // One verdict per distinct glyph id — the compare must not repeat
  // for every codepoint a shared glyph serves.
  const verdicts = new Map<number, boolean>();
  const suspect = (glyph: number): boolean => {
    let verdict = verdicts.get(glyph);
    if (verdict === undefined) {
      verdict = isSuspect(glyph);
      verdicts.set(glyph, verdict);
    }
    return verdict;
  };
  const codepoints: number[] = [];
  const placeholders: number[] = [];
  for (const [cp, glyph] of mapped) {
    (suspect(glyph) ? placeholders : codepoints).push(cp);
  }
  codepoints.sort((a, b) => a - b);
  placeholders.sort((a, b) => a - b);
  return { codepoints, placeholders };
}

/**
 * The rule-2 predicate over glyph ids: true when the glyph draws the
 * same outline as the font's .notdef (glyph 0). null-prefilterable
 * backends only — a face with neither glyf nor CFF never suspects.
 */
function makeNotdefOutlineSuspect(
  view: DataView,
  offsets: ReadonlyMap<number, number>,
): (glyph: number) => boolean {
  const glyf = new GlyfOutlines(view, offsets);
  if (glyf.usable) return (glyph) => glyf.matchesNotdef(glyph);
  const cff = new CffCharstrings(view, offsets);
  if (cff.usable) return (glyph) => cff.matchesNotdef(glyph);
  return () => false;
}

/** One decomposed outline point (on-curve flag is geometry in TrueType). */
interface OutlinePoint {
  x: number;
  y: number;
  on: boolean;
}

/**
 * The glyf-backed outline comparator: a contour-count + bounding-box +
 * point-count pre-filter over the RAW glyph record header, then a full
 * point compare (composites decomposed) for the survivors only. An
 * empty .notdef carries no box evidence — nothing is ever suspected
 * (a blank glyph is not tofu; blank-.notdef fonts must not flag space).
 */
class GlyfOutlines {
  readonly usable: boolean;
  private readonly view: DataView;
  private readonly glyfOffset: number;
  private readonly locaOffset: number;
  private readonly locaLong: boolean;
  private readonly numGlyphs: number;
  private notdefKey: [number, number, number, number, number, number] | null =
    null;
  private notdefOutline: OutlinePoint[] | null = null;
  private notdefReady = false;

  constructor(view: DataView, offsets: ReadonlyMap<number, number>) {
    this.view = view;
    const glyf = offsets.get(TAG_GLYF);
    const loca = offsets.get(TAG_LOCA);
    const head = offsets.get(TAG_HEAD);
    const maxp = offsets.get(TAG_MAXP);
    this.usable =
      glyf !== undefined && loca !== undefined && head !== undefined && maxp !== undefined;
    this.glyfOffset = glyf ?? -1;
    this.locaOffset = loca ?? -1;
    this.locaLong = head !== undefined ? view.getInt16(head + 50) === 1 : false;
    this.numGlyphs = maxp !== undefined ? view.getUint16(maxp + 4) : 0;
  }

  /** The raw record bounds of one glyph ([start, end); empty when none). */
  private recordBounds(glyph: number): [number, number] {
    if (glyph < 0 || glyph >= this.numGlyphs) return [0, 0];
    const start = this.locaEntry(glyph);
    const end = this.locaEntry(glyph + 1);
    return end > start ? [this.glyfOffset + start, this.glyfOffset + end] : [0, 0];
  }

  private locaEntry(index: number): number {
    const at = this.locaOffset + index * (this.locaLong ? 4 : 2);
    if (at < 0 || at + (this.locaLong ? 4 : 2) > this.view.byteLength) return 0;
    return this.locaLong
      ? this.view.getUint32(at)
      : this.view.getUint16(at) * 2;
  }

  /**
   * The pre-filter key: contour count, bounding box, point count —
   * identical outlines necessarily share it. -1 marks the unknown
   * point count of composites (which must decompose); an empty record
   * (including out-of-range ids) reads as the empty key.
   */
  private shapeKey(glyph: number): [number, number, number, number, number, number] {
    const [start, end] = this.recordBounds(glyph);
    if (end <= start) return [0, 0, 0, 0, 0, 0];
    const contours = this.view.getInt16(start);
    const xMin = this.view.getInt16(start + 2);
    const yMin = this.view.getInt16(start + 4);
    const xMax = this.view.getInt16(start + 6);
    const yMax = this.view.getInt16(start + 8);
    if (contours <= 0) return [contours, xMin, yMin, xMax, yMax, 0];
    const lastEnd = this.view.getUint16(start + 10 + (contours - 1) * 2);
    return [contours, xMin, yMin, xMax, yMax, lastEnd + 1];
  }

  /** The notdef pre-filter key, or null when rule 2 is off for the face. */
  private notdefShapeKey(): [number, number, number, number, number, number] | null {
    if (!this.notdefReady) {
      this.notdefReady = true;
      const [start, end] = this.recordBounds(0);
      if (end > start) {
        const key = this.shapeKey(0);
        // An empty .notdef (0 contours) carries no box evidence; a
        // composite one has no usable header pre-filter (its suspects
        // go through the decomposed compare instead).
        this.notdefKey = key[0] !== 0 ? key : null;
      }
    }
    return this.notdefKey;
  }

  matchesNotdef(glyph: number): boolean {
    const notdefKey = this.notdefShapeKey();
    if (notdefKey === null) return false;
    if (notdefKey[0] > 0 && !this.keysEqual(this.shapeKey(glyph), notdefKey)) {
      return false;
    }
    if (this.notdefOutline === null) {
      this.notdefOutline = this.decompose(0);
      if (this.notdefOutline === null || this.notdefOutline.length === 0) {
        this.notdefKey = null;
        return false;
      }
    }
    const outline = this.decompose(glyph);
    return outline !== null && this.outlinesEqual(outline, this.notdefOutline);
  }

  private keysEqual(
    a: [number, number, number, number, number, number],
    b: [number, number, number, number, number, number],
  ): boolean {
    return a.every((value, i) => value === b[i]);
  }

  private outlinesEqual(a: OutlinePoint[], b: OutlinePoint[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i]!.x !== b[i]!.x || a[i]!.y !== b[i]!.y || a[i]!.on !== b[i]!.on) {
        return false;
      }
    }
    return true;
  }

  /**
   * One glyph's outline as a flat absolute point list (contours keep
   * their order; point counts carry the grouping). null = not
   * comparable (a composite using point-number matching — the modern
   * spec deprecates it — or a malformed record).
   */
  private decompose(glyph: number): OutlinePoint[] | null {
    return this.decomposeInto(glyph, 1, 0, 0, 1, 0, 0, 0);
  }

  private decomposeInto(
    glyph: number,
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    depth: number,
  ): OutlinePoint[] | null {
    if (depth > 8) return null;
    const [start, end] = this.recordBounds(glyph);
    if (end <= start) return [];
    const contours = this.view.getInt16(start);
    if (contours > 0) return this.readSimplePoints(start, contours, a, b, c, d, e, f);
    if (contours !== -1) return contours === 0 ? [] : null;
    // Composite: decompose every component under the combined transform.
    const points: OutlinePoint[] = [];
    let at = start + 10;
    for (;;) {
      if (at + 4 > end) return null;
      const flags = this.view.getUint16(at);
      const component = this.view.getUint16(at + 2);
      at += 4;
      let dx: number;
      let dy: number;
      if (flags & 0x0001) {
        dx = (flags & 0x0002 ? this.view.getInt16(at) : this.view.getUint16(at));
        dy = (flags & 0x0002 ? this.view.getInt16(at + 2) : this.view.getUint16(at + 2));
        at += 4;
      } else {
        dx = this.view.getInt8(at);
        dy = this.view.getInt8(at + 1);
        at += 2;
      }
      if (!(flags & 0x0002)) return null; // point-number matching: deprecated
      let ma = 1;
      let mb = 0;
      let mc = 0;
      let md = 1;
      if (flags & 0x0008) {
        ma = this.readF2Dot14(at);
        at += 2;
      } else if (flags & 0x0040) {
        ma = this.readF2Dot14(at);
        md = this.readF2Dot14(at + 2);
        at += 4;
      } else if (flags & 0x0080) {
        ma = this.readF2Dot14(at);
        mb = this.readF2Dot14(at + 2);
        mc = this.readF2Dot14(at + 4);
        md = this.readF2Dot14(at + 6);
        at += 8;
      }
      // The combined transform is parent ∘ child: the component's own
      // points transform first, the enclosing composite's transform
      // applies to the result.
      const inner = this.decomposeInto(
        component,
        a * ma + c * mb,
        b * ma + d * mb,
        a * mc + c * md,
        b * mc + d * md,
        a * dx + c * dy + e,
        b * dx + d * dy + f,
        depth + 1,
      );
      if (inner === null) return null;
      points.push(...inner);
      if (!(flags & 0x0020)) break;
    }
    return points;
  }

  private readF2Dot14(at: number): number {
    return this.view.getInt16(at) / 16384;
  }

  /** A simple glyph's points, transformed into place. */
  private readSimplePoints(
    start: number,
    contours: number,
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
  ): OutlinePoint[] {
    const view = this.view;
    const total = view.getUint16(start + 10 + (contours - 1) * 2) + 1;
    const instructionLength = view.getUint16(start + 10 + contours * 2);
    let at = start + 12 + contours * 2 + instructionLength;
    const flags: number[] = [];
    for (let i = 0; i < total; i++) {
      if (at >= view.byteLength) return [];
      const flag = view.getUint8(at++);
      flags.push(flag);
      if (flag & 0x0008) {
        const repeats = at < view.byteLength ? view.getUint8(at++) : 0;
        for (let r = 0; r < repeats && i < total; r++) {
          flags.push(flag);
          i++;
        }
      }
    }
    let x = 0;
    const xs: number[] = [];
    for (let i = 0; i < total; i++) {
      const flag = flags[i]!;
      // 0x02 X_SHORT_VECTOR, 0x10 X_SAME_OR_POSITIVE (else int16).
      if (flag & 0x0002) {
        x += flag & 0x0010 ? view.getUint8(at) : -view.getUint8(at);
        at += 1;
      } else if (!(flag & 0x0010)) {
        x += view.getInt16(at);
        at += 2;
      }
      xs.push(x);
    }
    let y = 0;
    const ys: number[] = [];
    for (let i = 0; i < total; i++) {
      const flag = flags[i]!;
      // 0x04 Y_SHORT_VECTOR, 0x20 Y_SAME_OR_POSITIVE (else int16).
      if (flag & 0x0004) {
        y += flag & 0x0020 ? view.getUint8(at) : -view.getUint8(at);
        at += 1;
      } else if (!(flag & 0x0020)) {
        y += view.getInt16(at);
        at += 2;
      }
      ys.push(y);
    }
    const points: OutlinePoint[] = [];
    for (let i = 0; i < total; i++) {
      const px = xs[i]!;
      const py = ys[i]!;
      points.push({
        x: Math.round((a * px + c * py + e) * 64) / 64,
        y: Math.round((b * px + d * py + f) * 64) / 64,
        on: (flags[i]! & 0x0001) !== 0,
      });
    }
    return points;
  }
}

/**
 * The CFF-backed comparator (round 19, pragmatic mirror of the core's
 * decomposed-ops compare): the charstring INDEX is ordered by glyph id
 * and .notdef is entry 0, so equal INDEX bytes mean the same program —
 * the same drawn outline. Byte inequality can still hide an equal
 * outline behind different subroutinization, which only ever MISSES a
 * suspect (never invents one); the full Type 2 interpretation stays a
 * core-only job.
 */
class CffCharstrings {
  readonly usable: boolean;
  private readonly view: DataView;
  private readonly entries: Array<[number, number]> = [];
  private notdefBytes: Uint8Array | null = null;
  private checkedNotdef = false;

  constructor(view: DataView, offsets: ReadonlyMap<number, number>) {
    this.view = view;
    const cff = offsets.get(TAG_CFF);
    let charstringsOffset = -1;
    if (cff !== undefined) {
      charstringsOffset = this.findCharstringsIndex(cff);
    }
    this.usable = charstringsOffset >= 0;
    if (this.usable) this.readIndexEntries(charstringsOffset);
  }

  /** Locate the CharStrings INDEX inside the CFF table. */
  private findCharstringsIndex(cff: number): number {
    const view = this.view;
    // Header (major, minor, hdrSize, offSize), then the Name INDEX,
    // then the Top DICT INDEX whose operators carry the offsets.
    const hdrSize = view.getUint8(cff + 2);
    let at = cff + hdrSize;
    at = this.skipIndex(at);
    if (at < 0) return -1;
    const topDictStart = at;
    at = this.skipIndex(at);
    if (at < 0) return -1;
    const topDictEnd = at;
    // Walk the top DICT operands for operator 17 (CharStrings).
    const operands: number[] = [];
    let i = topDictStart;
    while (i < topDictEnd) {
      const b0 = view.getUint8(i);
      if (b0 <= 21) {
        const op = b0 === 12 ? 1200 + view.getUint8(i + 1) : b0;
        if (b0 === 12) i++;
        if (op === 17 && operands.length > 0) {
          return cff + operands[operands.length - 1]!;
        }
        operands.length = 0;
        i++;
        continue;
      }
      if (b0 === 28) {
        operands.push(view.getInt16(i + 1));
        i += 3;
      } else if (b0 === 29) {
        operands.push(view.getInt32(i + 1));
        i += 5;
      } else if (b0 === 30) {
        // Real operands never feed offsets — skip to the terminator.
        i++;
        while (i < topDictEnd && (view.getUint8(i) & 0xf0) !== 0xf0) i++;
        i++;
      } else if (b0 >= 32 && b0 <= 246) {
        operands.push(b0 - 139);
        i++;
      } else if (b0 >= 247 && b0 <= 250) {
        operands.push((b0 - 247) * 256 + view.getUint8(i + 1) + 108);
        i += 2;
      } else if (b0 >= 251 && b0 <= 254) {
        operands.push(-(b0 - 251) * 256 - view.getUint8(i + 1) - 108);
        i += 2;
      } else {
        return -1;
      }
    }
    return -1;
  }

  /** Skip one INDEX, returning the position after it (-1 on error). */
  private skipIndex(at: number): number {
    if (at + 3 > this.view.byteLength) return -1;
    // CFF1 INDEX: count (uint16), offSize, 1-based offsets, data. The
    // last offset is 1-based from the byte BEFORE the data, so the INDEX
    // ends at dataBase + lastOffset - 1.
    const count = this.view.getUint16(at);
    if (count === 0) return at + 2;
    const offSize = this.view.getUint8(at + 2);
    const dataBase = at + 3 + (count + 1) * offSize;
    const last = this.readOffset(at + 3 + count * offSize, offSize);
    if (last < 1) return -1;
    return dataBase + last - 1;
  }

  /** Record every charstring's [start, end) bounds, by glyph id. */
  private readIndexEntries(indexAt: number): void {
    const view = this.view;
    const count = view.getUint16(indexAt);
    if (count === 0) return;
    const offSize = view.getUint8(indexAt + 2);
    const offsetsBase = indexAt + 3;
    const dataBase = offsetsBase + (count + 1) * offSize;
    for (let i = 0; i <= count; i++) {
      const value = this.readOffset(offsetsBase + i * offSize, offSize);
      if (value < 1) return;
      // The offsets are 1-based from the byte before the data.
      this.entries.push([dataBase + value - 1, 0]);
      if (i > 0) this.entries[i - 1]![1] = dataBase + value - 1;
    }
  }

  private readOffset(at: number, offSize: number): number {
    const view = this.view;
    if (at + offSize > view.byteLength) return -1;
    let value = 0;
    for (let i = 0; i < offSize; i++) {
      value = value * 256 + view.getUint8(at + i);
    }
    return value;
  }

  matchesNotdef(glyph: number): boolean {
    if (!this.checkedNotdef) {
      this.checkedNotdef = true;
      const entry = this.entries[0];
      if (entry !== undefined && entry[1] > entry[0]) {
        this.notdefBytes = new Uint8Array(
          this.view.buffer,
          this.view.byteOffset + entry[0],
          entry[1] - entry[0],
        );
      }
    }
    if (this.notdefBytes === null || this.notdefBytes.length === 0) return false;
    const entry = this.entries[glyph];
    if (entry === undefined || entry[1] - entry[0] !== this.notdefBytes.length) {
      return false;
    }
    const view = this.view;
    for (let i = entry[0]; i < entry[1]; i++) {
      if (view.getUint8(i) !== this.notdefBytes[i - entry[0]]) return false;
    }
    return true;
  }
}

function readFormat4(view: DataView, sub: number, out: Map<number, number>): void {
  const segCountX2 = view.getUint16(sub + 6);
  const segCount = segCountX2 / 2;
  const endBase = sub + 14;
  const startBase = endBase + segCountX2 + 2;
  const deltaBase = startBase + segCountX2;
  const rangeBase = deltaBase + segCountX2;

  for (let seg = 0; seg < segCount; seg++) {
    const end = view.getUint16(endBase + seg * 2);
    const start = view.getUint16(startBase + seg * 2);
    const delta = view.getInt16(deltaBase + seg * 2);
    const rangeOffset = view.getUint16(rangeBase + seg * 2);
    if (start === 0xffff) continue;

    if (rangeOffset === 0) {
      for (let cp = start; cp <= end; cp++) {
        const glyph = (cp + delta) & 0xffff;
        if (glyph !== 0) out.set(cp, glyph);
      }
    } else {
      for (let cp = start; cp <= end; cp++) {
        const glyphIndexAddress =
          rangeBase + seg * 2 + rangeOffset + (cp - start) * 2;
        if (glyphIndexAddress + 2 > view.byteLength) break;
        const glyph = view.getUint16(glyphIndexAddress);
        if (glyph !== 0) {
          const resolved = (glyph + delta) & 0xffff;
          if (resolved !== 0) out.set(cp, resolved);
        }
      }
    }
  }
}
