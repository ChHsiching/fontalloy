// App icon generator — no dependencies (node:zlib only).
//
// Round 7 (logo adoption): the set derives from the SAME A×永 mark the
// product carries everywhere (kit/topBar.ts BRAND_MARK_SVG — a
// monospace "A" drawn with 永-style brush strokes, teal 捺 stroke and
// dot) set on the dark rounded plate. Rasterized with a small
// signed-distance field so every size is crisp; regenerate with:
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

// ---------- signed-distance rasterizer ----------
// Every primitive yields a coverage in [0,1] per pixel, antialiased
// with a one-pixel ramp (cov = clamp(0.5 + r - d)). All geometry is
// computed in PIXEL units for the requested size.

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const cov = (d, halfWidth) => clamp01(0.5 + halfWidth - d);

/** Distance from (x,y) to the segment a→b. */
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** One cubic Bézier sampled into `steps` segments (points in order). */
function bezier(p0, p1, p2, p3, steps = 10) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    pts.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return pts;
}

/** Polyline stroke (round caps) coverage at a pixel. */
function polyCov(px, py, pts, halfWidth) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const d = segDist(px, py, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    if (d < best) best = d;
  }
  return cov(best, halfWidth);
}

/** Signed distance to a rounded square (negative inside), pixel units. */
function roundedSquareSDF(px, py, cx, cy, half, radius) {
  const dx = Math.abs(px - cx) - (half - radius);
  const dy = Math.abs(py - cy) - (half - radius);
  const d = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) - radius;
  // The classic inner-distance correction keeps the SDF metric true.
  const inner = Math.max(dx, dy) < 0 ? Math.max(dx, dy) : 0;
  return d + inner;
}

function mix(dst, src, alpha) {
  dst[0] = Math.round(dst[0] * (1 - alpha) + src[0] * alpha);
  dst[1] = Math.round(dst[1] * (1 - alpha) + src[1] * alpha);
  dst[2] = Math.round(dst[2] * (1 - alpha) + src[2] * alpha);
  dst[3] = Math.min(255, Math.round(dst[3] * (1 - alpha) + 255 * alpha));
}

// ---------- the mark (the A×永 strokes of kit/topBar.ts) ----------

// The 24-grid design of BRAND_MARK_SVG: two brush strokes from the
// apex, a crossbar, and the detached dot; the 捺 (right stroke) and the
// dot carry the teal accent. Sampled cubics approximate the SVG curves
// exactly enough at icon sizes.
function render(size) {
  const buf = Buffer.alloc(size * size * 4); // start fully transparent

  const bgTop = [26, 31, 37];
  const bgBottom = [18, 22, 28];
  const ink = [226, 233, 240]; // the currentColor strokes, bright on the plate
  const accent = [45, 212, 191]; // teal-400 — the 捺 stroke + dot
  const cell = [96, 108, 122]; // the glyph-cell border, subtle

  // The mark's 24 grid mapped onto the plate: it fills 76% of the
  // canvas (the SVG's own cell rect spans 2.75..21.25 ≈ 77%).
  const g = size * (0.76 / 24);
  const gx = (v) => size / 2 + (v - 12) * g;

  const leftLeg = bezier(
    [12.2, 5.8],
    [10.4, 9.6],
    [8.9, 14.0],
    [7.6, 18.6],
    12,
  ).map(([x, y]) => [gx(x), gx(y)]);
  const rightLeg = bezier(
    [12.2, 5.8],
    [13.9, 9.8],
    [15.6, 14.1],
    [17.2, 18.6],
    12,
  ).map(([x, y]) => [gx(x), gx(y)]);
  const crossbar = [
    [gx(8.8), gx(14.6)],
    [gx(15.8), gx(14.6)],
  ];
  const dotC = [gx(17.7), gx(8.1)];
  const dotR = 1.5 * g;

  const legHalf = 1.1 * g; // stroke-width 2.2 grid → half-width
  const barHalf = 1.0 * g; // stroke-width 2 grid
  const cellHalf = size * 0.385; // 18.5/24 grid → half of the cell rect
  const cellHalfW = 0.75 * g; // stroke-width 1.5 grid
  const cellR = 5 * g;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const px = x + 0.5;
      const py = y + 0.5;

      // Plate: rounded square with a vertical gradient.
      const plateSd = roundedSquareSDF(px, py, size / 2, size / 2, size * 0.46, size * 0.12);
      const plate = clamp01(0.5 - plateSd);
      if (plate > 0) {
        const t = py / size;
        buf[i] = Math.round(bgTop[0] * (1 - t) + bgBottom[0] * t);
        buf[i + 1] = Math.round(bgTop[1] * (1 - t) + bgBottom[1] * t);
        buf[i + 2] = Math.round(bgTop[2] * (1 - t) + bgBottom[2] * t);
        buf[i + 3] = Math.round(255 * plate);
      }

      // The glyph cell's rounded border (a ring).
      const cellSd = roundedSquareSDF(px, py, size / 2, size / 2, cellHalf, cellR);
      const cellRing = cov(Math.abs(cellSd), cellHalfW);
      if (cellRing > 0) mix(buf.subarray(i, i + 4), cell, cellRing);

      // The ink strokes (left leg + crossbar).
      const inkC = Math.max(
        polyCov(px, py, leftLeg, legHalf),
        polyCov(px, py, crossbar, barHalf),
      );
      if (inkC > 0) mix(buf.subarray(i, i + 4), ink, inkC);

      // The accent 捺 stroke.
      const accC = polyCov(px, py, rightLeg, legHalf);
      if (accC > 0) mix(buf.subarray(i, i + 4), accent, accC);

      // The detached 点 dot.
      const dotD = Math.hypot(px - dotC[0], py - dotC[1]);
      const dotCov = cov(dotD, dotR);
      if (dotCov > 0) mix(buf.subarray(i, i + 4), accent, dotCov);
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
