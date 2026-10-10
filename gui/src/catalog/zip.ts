/**
 * Minimal ZIP reader for the catalog downloader (issue #17).
 *
 * Per-family release artifacts are zips (CI packaging, #14). Rather than
 * pull a dependency into an otherwise dependency-free frontend, this reader
 * covers exactly what those zips contain: stored (method 0) and deflate
 * (method 8) entries, decompressed with the platform's
 * DecompressionStream("deflate-raw") — Chromium 103+/WebView2, Safari
 * 16.4+/WKWebView, WebKitGTK 2.40+. Encrypted, zip64, or other-method
 * entries are hard errors: a catalog artifact we half-understand must not
 * reach the font subsystem.
 *
 * The central directory (not streamed local headers) drives the reads, so
 * entries whose local header extra-field length differs from the central
 * record still extract correctly.
 */

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

export async function unzip(buffer: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // Locate the end-of-central-directory record: scan backwards over the
  // 22-byte record plus up to 64 KiB of trailing comment.
  const scanStart = Math.max(0, view.byteLength - 22 - 0xffff);
  let eocd = -1;
  for (let i = view.byteLength - 22; i >= scanStart; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip: end of central directory not found");

  const entryCount = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (cdOffset > view.byteLength) {
    throw new Error("zip: central directory offset beyond archive");
  }

  const out = new Map<string, Uint8Array>();
  let cursor = cdOffset;
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > view.byteLength || view.getUint32(cursor, true) !== CDH_SIG) {
      throw new Error(`zip: central directory entry ${index} corrupt`);
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = new TextDecoder().decode(nameBytes);
    cursor += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue; // directory entry

    if ((flags & 0x0001) !== 0) {
      throw new Error(`zip entry ${name}: encrypted entries are unsupported`);
    }
    if (method !== 0 && method !== 8) {
      throw new Error(`zip entry ${name}: unsupported compression method ${method}`);
    }

    // Local header: recompute the data offset from ITS name/extra lengths.
    if (localOffset + 30 > view.byteLength || view.getUint32(localOffset, true) !== LFH_SIG) {
      throw new Error(`zip entry ${name}: local header corrupt`);
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    if (compressed.length < compressedSize) {
      throw new Error(`zip entry ${name}: truncated data`);
    }

    out.set(name, method === 0 ? compressed.slice() : await inflateRaw(compressed));
  }
  return out;
}

async function inflateRaw(compressed: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([compressed as BlobPart]).stream().pipeThrough(
    new DecompressionStream("deflate-raw"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
