/**
 * Minimal sfnt reader for the GUI preview path: family name (name table)
 * and codepoint coverage (cmap). This is metadata for the FontFace rendering
 * path only — the real merge pipeline lives in core/ and never runs here.
 *
 * Supports TrueType/OpenType (and reads the first face of a TTC for
 * metadata); woff2 is left to the FontFace decoder and yields no coverage
 * list (the browser still renders it).
 */

export interface FontMeta {
  /** Display family name; nameID 16 preferred over nameID 1. */
  family: string;
  /** Sorted covered codepoints (empty when the cmap cannot be read). */
  codepoints: number[];
}

export function parseFontMeta(buffer: ArrayBuffer): FontMeta {
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
  let nameOffset = -1;
  let cmapOffset = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = base + 12 + i * 16;
    if (rec + 16 > view.byteLength) break;
    const tableTag = view.getUint32(rec);
    const off = view.getUint32(rec + 8);
    const len = view.getUint32(rec + 12);
    if (tableTag === 0x6e616d65 && off + len <= view.byteLength) {
      nameOffset = off;
    } else if (tableTag === 0x636d6170 && off + len <= view.byteLength) {
      cmapOffset = off;
    }
  }

  const family = nameOffset >= 0 ? readFamilyName(view, nameOffset) : "";
  const codepoints = cmapOffset >= 0 ? readCoverage(view, cmapOffset) : [];
  if (!family) throw new Error("font has no readable family name");
  return { family, codepoints };
}

function readFamilyName(view: DataView, offset: number): string {
  const count = view.getUint16(offset + 2);
  const stringOffset = view.getUint16(offset + 4);
  const utf16be = new TextDecoder("utf-16be");

  interface Record {
    platform: number;
    encoding: number;
    language: number;
    nameId: number;
    length: number;
    strOffset: number;
  }
  const records: Record[] = [];
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

  const decode = (r: Record): string => {
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
  const pick = (nameId: number, pred: (r: Record) => boolean): string => {
    for (const r of records) {
      if (r.nameId === nameId && r.length > 0 && pred(r)) {
        const text = decode(r);
        if (text) return text;
      }
    }
    return "";
  };
  const isWinUnicode = (r: Record): boolean =>
    r.platform === 3 && r.encoding === 1;
  const isMacRoman = (r: Record): boolean =>
    r.platform === 1 && r.encoding === 0;

  return (
    pick(16, (r) => isWinUnicode(r) && r.language === 0x409) ||
    pick(1, (r) => isWinUnicode(r) && r.language === 0x409) ||
    pick(16, isWinUnicode) ||
    pick(1, isWinUnicode) ||
    pick(16, isMacRoman) ||
    pick(1, isMacRoman)
  );
}

function readCoverage(view: DataView, offset: number): number[] {
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
  if (!best) return [];
  const sub = best.offset;
  const format = view.getUint16(sub);
  const out: number[] = [];
  if (format === 4) {
    readFormat4(view, sub, out);
  } else if (format === 12) {
    const nGroups = view.getUint32(sub + 12);
    for (let g = 0; g < nGroups; g++) {
      const rec = sub + 16 + g * 12;
      const start = view.getUint32(rec);
      const end = view.getUint32(rec + 4);
      for (let cp = start; cp <= end && cp <= 0x10ffff; cp++) out.push(cp);
    }
  }
  return out.sort((a, b) => a - b);
}

function readFormat4(view: DataView, sub: number, out: number[]): void {
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
        if (glyph !== 0) out.push(cp);
      }
    } else {
      for (let cp = start; cp <= end; cp++) {
        const glyphIndexAddress =
          rangeBase + seg * 2 + rangeOffset + (cp - start) * 2;
        if (glyphIndexAddress + 2 > view.byteLength) break;
        const glyph = view.getUint16(glyphIndexAddress);
        if (glyph !== 0) {
          const resolved = (glyph + delta) & 0xffff;
          if (resolved !== 0) out.push(cp);
        }
      }
    }
  }
}
