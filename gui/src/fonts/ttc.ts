/**
 * TrueType/OpenType Collection (.ttc/.otc) extraction (round 19,
 * owner item 3): the local-load path registers bytes through
 * FontFace, and a FontFace is ONE face — a collection fed to it whole
 * registers at best its first face and silently drops the rest. This
 * module turns each face of a collection into standalone sfnt bytes
 * the FontFace path accepts as an ordinary font:
 *
 * - the face's own table directory (found at the face's offset in the
 *   collection), rewritten to point at a private copy of every table
 *   it references — tables may live in the collection's shared region
 *   (fontTools and the build pipeline dedup identical tables there),
 *   so bytes are copied by each table's offset/length from the WHOLE
 *   file buffer;
 * - table data 4-byte aligned, the header's search fields copied
 *   verbatim (the table count is unchanged, so they stay valid);
 * - head.checkSumAdjustment recomputed the spec way: zero the field,
 *   checksum the whole font, store 0xB1B0AFBA - checksum big-endian.
 *
 * TrueType ('true'/0x00010000, glyf) and OpenType ('OTTO', CFF) faces
 * alike — only the flavor tag differs; the reassembly is identical.
 *
 * Pure by design: ArrayBuffer in, faces out, no DOM or FontFace use,
 * so the e2e suite exercises it directly — an extracted face of a
 * fontTools-produced ttc must parse in fontTools again AND load via
 * FontFace in the page (the browser sanitizer's acceptance).
 */

/** 'ttcf' — the collection header tag. */
const TTCF_TAG = 0x74746366;

/** 'head' — the table whose checkSumAdjustment gets recomputed. */
const HEAD_TAG = 0x68656164;

/** The sfnt spec's checkSumAdjustment magic (0xB1B0AFBA). */
const CHECKSUM_MAGIC = 0xb1b0afba;

/** One face of a collection, reassembled as a standalone font. */
export interface ExtractedFace {
  /** Standalone sfnt bytes: the face's directory plus its tables. */
  buffer: ArrayBuffer;
  /** The flavor tag as text: "1.0" (TrueType), "true", or "OTTO" (CFF). */
  tag: string;
}

/** An {@link ExtractedFace} with its position in the collection. */
export interface CollectionFace extends ExtractedFace {
  /** 1-based face number (the `file.ttc#N` naming the loader uses). */
  index: number;
}

/** True when the buffer starts with the 'ttcf' collection header. */
export function isFontCollection(buffer: ArrayBuffer): boolean {
  return (
    buffer.byteLength >= 12 && new DataView(buffer).getUint32(0) === TTCF_TAG
  );
}

/**
 * The face offsets of a collection: the ttcf header's numFonts and
 * offset table. Throws on anything that is not a collection or whose
 * header is truncated.
 */
export function collectionFaceOffsets(buffer: ArrayBuffer): number[] {
  const view = new DataView(buffer);
  if (view.byteLength < 12 || view.getUint32(0) !== TTCF_TAG) {
    throw new Error("not a TrueType/OpenType collection");
  }
  const numFonts = view.getUint32(8);
  if (numFonts < 1) throw new Error("collection declares no faces");
  if (12 + numFonts * 4 > view.byteLength) {
    throw new Error("truncated collection header");
  }
  const offsets: number[] = [];
  for (let i = 0; i < numFonts; i++) {
    offsets.push(view.getUint32(12 + i * 4));
  }
  return offsets;
}

/** A 4-byte table/flavor tag as its four ASCII characters. */
function tagText(tag: number): string {
  return String.fromCharCode(
    (tag >>> 24) & 0xff,
    (tag >>> 16) & 0xff,
    (tag >>> 8) & 0xff,
    tag & 0xff,
  );
}

/**
 * Reassemble the face whose table directory starts at `faceOffset`
 * (an offset into the WHOLE collection buffer — the shared region's
 * tables are copied from wherever their offsets point). Throws with a
 * face-local reason (bad flavor tag, truncated directory, a table
 * outside the file, no head table); the caller names the face.
 */
export function extractFaceAtOffset(
  buffer: ArrayBuffer,
  faceOffset: number,
): ExtractedFace {
  const view = new DataView(buffer);
  if (faceOffset + 12 > view.byteLength) {
    throw new Error("face offset is outside the file");
  }
  const flavor = view.getUint32(faceOffset);
  if (
    flavor !== 0x00010000 &&
    flavor !== 0x74727565 && // 'true'
    flavor !== 0x4f54544f // 'OTTO'
  ) {
    throw new Error("not a TrueType/OpenType face");
  }
  const numTables = view.getUint16(faceOffset + 4);
  if (numTables < 1) throw new Error("face has no tables");
  if (faceOffset + 12 + numTables * 16 > view.byteLength) {
    throw new Error("truncated table directory");
  }

  interface TableRecord {
    tag: number;
    checksum: number;
    offset: number;
    length: number;
  }
  const tables: TableRecord[] = [];
  for (let i = 0; i < numTables; i++) {
    const rec = faceOffset + 12 + i * 16;
    const table: TableRecord = {
      tag: view.getUint32(rec),
      checksum: view.getUint32(rec + 4),
      offset: view.getUint32(rec + 8),
      length: view.getUint32(rec + 12),
    };
    if (table.offset + table.length > view.byteLength) {
      throw new Error(`table ${tagText(table.tag)} is outside the file`);
    }
    tables.push(table);
  }
  const head = tables.find((table) => table.tag === HEAD_TAG);
  if (head === undefined) throw new Error("face has no head table");

  // Layout: the 12-byte sfnt header (flavor + search fields, copied —
  // the table count is unchanged), the rewritten directory, then each
  // table's copy 4-byte aligned.
  let size = 12 + numTables * 16;
  for (const table of tables) size += (table.length + 3) & ~3;
  const out = new ArrayBuffer(size);
  const source = new Uint8Array(buffer);
  const target = new Uint8Array(out);
  const outView = new DataView(out);
  for (let i = 0; i < 12; i++) target[i] = source[faceOffset + i]!;
  let cursor = 12 + numTables * 16;
  let headOffset = -1;
  for (let i = 0; i < tables.length; i++) {
    const table = tables[i]!;
    const rec = 12 + i * 16;
    outView.setUint32(rec, table.tag);
    outView.setUint32(rec + 4, table.checksum);
    outView.setUint32(rec + 8, cursor);
    outView.setUint32(rec + 12, table.length);
    target.set(source.subarray(table.offset, table.offset + table.length), cursor);
    if (table === head) headOffset = cursor;
    cursor += (table.length + 3) & ~3;
  }

  // checkSumAdjustment (the sfnt spec's recipe, and what the browser's
  // font sanitizer verifies): zero the field, checksum the whole font,
  // store 0xB1B0AFBA - checksum big-endian. The output is 4-aligned by
  // construction, so the checksum's zero-padding tail never triggers.
  const adjustment = headOffset + 8;
  outView.setUint32(adjustment, 0);
  let sum = 0;
  for (let i = 0; i < size; i += 4) {
    sum = (sum + outView.getUint32(i)) >>> 0;
  }
  outView.setUint32(adjustment, (CHECKSUM_MAGIC - sum) >>> 0);

  return {
    buffer: out,
    tag: flavor === 0x00010000 ? "1.0" : tagText(flavor),
  };
}

/**
 * Extract every face of a collection, in face order. Strict: the
 * first malformed face aborts with an error naming it
 * (`collection face #N: ...`); the loader's per-face path (the picker
 * flow) calls {@link collectionFaceOffsets} + {@link extractFaceAtOffset}
 * itself so one bad face never kills the others.
 */
export function extractCollectionFaces(
  buffer: ArrayBuffer,
): CollectionFace[] {
  const offsets = collectionFaceOffsets(buffer);
  const faces: CollectionFace[] = [];
  for (let i = 0; i < offsets.length; i++) {
    try {
      faces.push({ index: i + 1, ...extractFaceAtOffset(buffer, offsets[i]!) });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`collection face #${i + 1}: ${reason}`);
    }
  }
  return faces;
}

/** One picked local font file, as the load path receives it. */
export interface LocalFontFile {
  buffer: ArrayBuffer;
  fileName: string;
  path?: string;
}

/** One candidate font of the local load: a file, or one face of one. */
export interface LocalFontEntry {
  fileName: string;
  /**
   * The face's standalone bytes; absent when `error` says why this
   * entry cannot load (a collection face that did not reassemble).
   */
  buffer?: ArrayBuffer;
  error?: string;
  path?: string;
}

/**
 * Expand picked local files into per-face entries (round 19, owner
 * item 3): a collection (.ttc/.otc) contributes EVERY face as its own
 * font — `ChHsich.ttc` becomes `ChHsich.ttc#1..#N`, each entry's
 * bytes a standalone sfnt whose own name table names the face. A face
 * that does not reassemble degrades to an error entry naming THAT
 * face (`file.ttc#N`), never killing its siblings; a non-collection
 * file passes through unchanged (the single-font path).
 */
export function expandLocalFontEntries(
  files: readonly LocalFontFile[],
): LocalFontEntry[] {
  const reason = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);
  const entries: LocalFontEntry[] = [];
  for (const file of files) {
    if (!isFontCollection(file.buffer)) {
      entries.push(file);
      continue;
    }
    let offsets: number[];
    try {
      offsets = collectionFaceOffsets(file.buffer);
    } catch (err) {
      entries.push({
        fileName: file.fileName,
        path: file.path,
        error: reason(err),
      });
      continue;
    }
    for (let i = 0; i < offsets.length; i++) {
      const fileName = `${file.fileName}#${i + 1}`;
      try {
        entries.push({
          fileName,
          path: file.path,
          buffer: extractFaceAtOffset(file.buffer, offsets[i]!).buffer,
        });
      } catch (err) {
        entries.push({ fileName, path: file.path, error: reason(err) });
      }
    }
  }
  return entries;
}
