// Placeholder app icon generator — no dependencies (node:zlib only).
// Two overlapping rounded squares: an English-font square and a CJK-font
// square alloying into one mark. The final icon awaits user direction
// (spec issue #1, "Further Notes"); regenerate with:
//   node gui/scripts/make-icons.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");

// ---------- PNG encoding ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- the mark ----------

/** Rounded-square coverage in [0,1] for a square of radius r at (cx, cy). */
function roundedSquare(x, y, cx, cy, half, radius, scale = 1) {
  const dx = Math.abs(x - cx) - (half - radius);
  const dy = Math.abs(y - cy) - (half - radius);
  const d = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) - radius;
  return Math.min(1, Math.max(0, -d * scale));
}

function mix(dst, src, alpha) {
  dst[0] = Math.round(dst[0] * (1 - alpha) + src[0] * alpha);
  dst[1] = Math.round(dst[1] * (1 - alpha) + src[1] * alpha);
  dst[2] = Math.round(dst[2] * (1 - alpha) + src[2] * alpha);
  dst[3] = Math.min(255, Math.round(dst[3] * (1 - alpha) + 255 * alpha));
}

function render(size) {
  const buf = Buffer.alloc(size * size * 4); // start fully transparent
  const u = 1 / 128; // design grid: the icon is authored on a 128px grid

  const bgTop = [26, 31, 37];
  const bgBottom = [18, 22, 28];
  const en = [126, 168, 214]; // English font square (cool)
  const cjk = [232, 163, 61]; // CJK font square (accent amber)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const nx = (x + 0.5) / size;
      const ny = (y + 0.5) / size;

      // Plate: rounded square with a vertical gradient.
      const plate = roundedSquare(nx, ny, 0.5, 0.5, 0.46, 0.12, 1e9);
      if (plate > 0) {
        const g = ny;
        buf[i] = Math.round(bgTop[0] * (1 - g) + bgBottom[0] * g);
        buf[i + 1] = Math.round(bgTop[1] * (1 - g) + bgBottom[1] * g);
        buf[i + 2] = Math.round(bgTop[2] * (1 - g) + bgBottom[2] * g);
        buf[i + 3] = Math.round(255 * plate);
      }

      // English square (upper-left), outline feel via two fills.
      const enA = roundedSquare(nx, ny, 0.40, 0.40, 0.20, 5 * u, 1e9);
      const enB = roundedSquare(nx, ny, 0.40, 0.40, 0.13, 4 * u, 1e9);
      if (enA > 0) mix(buf.subarray(i, i + 4), en, enA * 0.92);
      if (enB > 0) mix(buf.subarray(i, i + 4), bgBottom, enB * 0.85);

      // CJK square (lower-right), solid accent.
      const cjkA = roundedSquare(nx, ny, 0.62, 0.62, 0.20, 5 * u, 1e9);
      if (cjkA > 0) mix(buf.subarray(i, i + 4), cjk, cjkA * 0.96);
    }
  }
  return buf;
}

// ---------- ICO (PNG-embedded) and ICNS ----------

function buildIco(pngs) {
  // pngs: [{size, data}]
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  const entries = [];
  let offset = 6 + 16 * count;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

function buildIcns(entries) {
  // entries: [{type, data}]
  const chunks = entries.map(({ type, data }) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, "ascii");
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const total = chunks.reduce((n, c) => n + c.length, 8);
  const head = Buffer.alloc(8);
  head.write("icns", 0, "ascii");
  head.writeUInt32BE(total, 4);
  return Buffer.concat([head, ...chunks]);
}

// ---------- write everything ----------

mkdirSync(outDir, { recursive: true });
const png32 = encodePng(32, 32, render(32));
const png48 = encodePng(48, 48, render(48));
const png128 = encodePng(128, 128, render(128));
const png256 = encodePng(256, 256, render(256));

writeFileSync(join(outDir, "32x32.png"), png32);
writeFileSync(join(outDir, "128x128.png"), png128);
writeFileSync(join(outDir, "128x128@2x.png"), png256);
writeFileSync(
  join(outDir, "icon.ico"),
  buildIco([
    { size: 32, data: png32 },
    { size: 48, data: png48 },
    { size: 256, data: png256 },
  ]),
);
writeFileSync(
  join(outDir, "icon.icns"),
  buildIcns([
    { type: "ic07", data: png128 }, // 128x128
    { type: "ic08", data: png256 }, // 256x256
  ]),
);
console.log(`icons written to ${outDir}`);
