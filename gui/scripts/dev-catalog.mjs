/**
 * Dev fixture catalog — a working catalog source for `npm run dev`
 * (design-fidelity finding: the picker must list catalog families with
 * license/variant meta; production keeps the real GitHub/appDataDir flow).
 *
 * Served by the vite dev server only (never built):
 *
 *   GET /dev-catalog/catalog-release.json   the bootstrap document
 *   GET /dev-catalog/origins/dev/<Zip>      one family zip per request
 *
 * The families are HOST font files (font binaries never enter git), zipped
 * in memory with fixed timestamps like the CI packaging, pinned by sha256.
 * The origin base_url points back at whatever host served the document
 * (127.0.0.1 or localhost — a loopback http origin, allowed by the
 * catalog-release loader as the documented dev carve-out). Host fonts that
 * are absent are skipped gracefully; with none at all the document 503s
 * and the app falls back to "catalog unavailable", still fully usable.
 *
 * Display metadata for these families lives in src/data/dev-catalog.json
 * (the provenance overlay the picker merges into its MetaLine source).
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { deflateRawSync } from "node:zlib";

/* ---------- the fixture families (host font files) ---------- */

const FIXTURE_SPECS = [
  {
    family: "Consolas",
    file: "Consolas-Regular.ttf",
    paths: ["C:/Windows/Fonts/consola.ttf"],
  },
  {
    family: "Courier New",
    file: "CourierNew-Regular.ttf",
    paths: ["C:/Windows/Fonts/cour.ttf"],
  },
  {
    family: "SimHei",
    file: "SimHei-Regular.ttf",
    paths: ["C:/Windows/Fonts/simhei.ttf"],
  },
  {
    family: "KaiTi",
    file: "KaiTi-Regular.ttf",
    paths: ["C:/Windows/Fonts/simkai.ttf"],
  },
  {
    family: "FangSong",
    file: "FangSong-Regular.ttf",
    paths: ["C:/Windows/Fonts/simfang.ttf"],
  },
];

/* ---------- minimal ZIP writer (stored + deflate entries) ---------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Fixed 2026-01-01 local-header date, like the CI packaging. */
const DOS_TIME = 0x0000;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const method = entry.deflate ? 8 : 0;
    const payload = entry.deflate ? deflateRawSync(entry.data) : entry.data;
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(entry.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

const sha256hex = (data) => createHash("sha256").update(data).digest("hex");

/* ---------- the fixture, built once on first request ---------- */

/**
 * @typedef {{family: string, zip: string, zipSha256: string, zipBytes: Buffer,
 *            file: string, fileSha256: string}} FixtureFamily
 */

/** @type {Promise<FixtureFamily[]> | null} */
let fixturePromise = null;

function fixtureFamilies() {
  fixturePromise ??= (async () => {
    const families = [];
    for (const spec of FIXTURE_SPECS) {
      let data = null;
      for (const path of spec.paths) {
        try {
          data = await readFile(path);
          break;
        } catch {
          // host font absent — try the next candidate
        }
      }
      if (data === null) continue;
      const zipBytes = makeZip([{ name: spec.file, data, deflate: true }]);
      families.push({
        family: spec.family,
        zip: `${spec.family.replace(/\s+/g, "")}.zip`,
        zipSha256: sha256hex(zipBytes),
        zipBytes,
        file: spec.file,
        fileSha256: sha256hex(data),
      });
    }
    return families;
  })();
  return fixturePromise;
}

function releaseDocument(families, baseUrl) {
  return JSON.stringify(
    {
      schema: "fontalloy/catalog-release@v1",
      tag: "font-catalog-dev-fixture",
      origins: [{ id: "dev", base_url: baseUrl }],
      families: families.map((f) => ({
        family: f.family,
        zip: f.zip,
        sha256: f.zipSha256,
        files: [{ file: f.file, sha256: f.fileSha256 }],
      })),
    },
    null,
    1,
  );
}

/**
 * The vite plugin. `apply: "serve"` keeps it out of every build; the
 * middleware answers before the static roots.
 */
export function devCatalogPlugin() {
  return {
    name: "fontalloy-dev-catalog",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "";
        if (!url.startsWith("/dev-catalog/")) {
          next();
          return;
        }
        const families = await fixtureFamilies();
        const cors = {
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
        };
        if (url.split("?")[0] === "/dev-catalog/catalog-release.json") {
          if (families.length === 0) {
            res.writeHead(503, cors);
            res.end("no host font files available for the dev fixture");
            return;
          }
          // Same-origin by construction: base_url points at the host the
          // browser actually reached us on.
          const host = req.headers.host ?? "127.0.0.1:5173";
          const body = releaseDocument(
            families,
            `http://${host}/dev-catalog/origins/dev`,
          );
          res.writeHead(200, { ...cors, "content-type": "application/json" });
          res.end(body);
          return;
        }
        const match = url.match(/^\/dev-catalog\/origins\/[^/]+\/([^/?]+)$/);
        const family = match
          ? families.find((f) => f.zip === decodeURIComponent(match[1]))
          : undefined;
        if (family) {
          res.writeHead(200, { ...cors, "content-type": "application/zip" });
          res.end(family.zipBytes);
          return;
        }
        res.writeHead(404, cors);
        res.end("not found");
      });
    },
  };
}
