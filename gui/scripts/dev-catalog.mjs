/**
 * The REAL dev catalog — the same families production serves, from the
 * repo's own single source of truth, so `npm run dev` (gui) and the
 * built WebApp under `vite preview` (web) show the picker/rail/grid the
 * validated prototype shows: 76+ real family rows with real meta and
 * real glyph rendering (repair round 2; supersedes the 5-host-font
 * fixture of round 1).
 *
 * Served by the vite dev AND preview servers (never built):
 *
 *   GET /dev-catalog/catalog-release.json   the bootstrap document
 *   GET /dev-catalog/origins/dev/<Zip>      one family zip per request
 *
 * Metadata comes from `assets/fonts.manifest.json` (ADR-0005: every
 * family with its real name, license, variant). Font BYTES come from a
 * local fonts directory holding the same families — by default the gui
 * prototype checkout next to this worktree (`<sibling>/fontalloy/gui/
 * prototype/fonts`; the binaries are gitignored everywhere and are only
 * ever READ here), or `<repo>/gui/prototype/fonts` when that branch is
 * checked out in-tree. Override with FONTALLOY_DEV_FONT_DIR. The
 * per-family file mapping below is explicit (Nerd Fonts renames several
 * families in their patched binaries); families without a local file
 * are skipped and reported on the server console — the honest miss
 * list, never a silent gap.
 *
 * Each family zip is STORED (no deflate — font binaries barely
 * compress and loopback transfer is free) with fixed timestamps like
 * the CI packaging, pinned by sha256. The origin base_url points back
 * at whatever host served the document (a loopback http origin, the
 * documented dev carve-out in catalog/release.ts). When no fonts
 * directory is found the document 503s and the app falls back to
 * "catalog unavailable", still fully usable.
 */

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

/** Where the repo's font catalog manifest lives (metadata truth). */
const MANIFEST_PATH = resolve(REPO_ROOT, "assets", "fonts.manifest.json");

/**
 * Local font-byte candidates, in priority order: the env override, the
 * prototype checkout that lives in the sibling main worktree, then an
 * in-tree prototype branch checkout. The directory is only ever read.
 */
function fontDirCandidates() {
  const list = [];
  if (process.env.FONTALLOY_DEV_FONT_DIR) list.push(process.env.FONTALLOY_DEV_FONT_DIR);
  list.push(
    resolve(REPO_ROOT, "..", "fontalloy", "gui", "prototype", "fonts"),
    resolve(REPO_ROOT, "gui", "prototype", "fonts"),
  );
  return list;
}

/**
 * Manifest family -> the prototype's font binary. Most Nerd Font
 * families map mechanically (`<Family>NerdFont-Regular.ttf`); the
 * renamed ones and every CJK family are pinned explicitly so a wrong
 * guess can never ship silently.
 */
const FILE_ALIASES = {
  AnonymousPro: "AnonymiceProNerdFont-Regular.ttf",
  AnnotationMono: "AnnotationMNerdFont-Regular.ttf",
  AtkinsonHyperlegibleMono: "AtkynsonMonoNerdFont-Regular.otf",
  AurulentSansMono: "AurulentSansMNerdFont-Regular.otf",
  BigBlueTerminal: "BigBlueTerm437NerdFont-Regular.ttf",
  BitstreamVeraSansMono: "BitstromWeraNerdFont-Regular.ttf",
  CascadiaCode: "CaskaydiaCoveNerdFont-Regular.ttf",
  CascadiaMono: "CaskaydiaMonoNerdFont-Regular.ttf",
  D2Coding: "D2KodingLigatureNerdFont-Regular.ttf",
  DejaVuSansMono: "DejaVuSansMNerdFont-Regular.ttf",
  DroidSansMono: "DroidSansMNerdFont-Regular.otf",
  FantasqueSansMono: "FantasqueSansMNerdFont-Regular.ttf",
  Gohu: "GohuFont11NerdFont-Regular.ttf",
  Hasklig: "HasklugNerdFont-Regular.otf",
  Hermit: "HurmitNerdFont-Regular.otf",
  IBMPlexMono: "BlexMonoNerdFont-Regular.ttf",
  IntelOneMono: "IntoneMonoNerdFont-Regular.ttf",
  LiberationMono: "LiterationMonoNerdFont-Regular.ttf",
  MPlus: "M+1NerdFont-Regular.ttf",
  Meslo: "MesloLGLDZNerdFont-Regular.ttf",
  Monaspace: "MonaspiceArNerdFont-Regular.otf",
  Noto: "NotoMonoNerdFont-Regular.ttf",
  ProFont: "ProFontIIxNerdFont-Regular.ttf",
  Recursive: "RecMonoCasualNerdFont-Regular.ttf",
  ShareTechMono: "ShureTechMonoNerdFont-Regular.ttf",
  SourceCodePro: "SauceCodeProNerdFont-Regular.ttf",
  Terminus: "TerminessNerdFont-Regular.ttf",
  "iA-Writer": "iMWritingDuoNerdFont-Regular.ttf",
  // CJK families (the prototype ships one face per family; the Maple
  // and Source-Han entries are the same typefaces our manifest lists
  // under its MapleMono NF-CN / NotoSerifSC ids).
  MapleMono: "MapleMonoCN-Regular.ttf",
  LXGWWenKai: "LXGWWenKai-Regular.ttf",
  LXGWWenKaiScreen: "LXGWWenKaiScreen-Regular.ttf",
  NotoSansSC: "NotoSansSC-VF.ttf",
  NotoSerifSC: "SourceHanSerifSC-Regular.otf",
};

/**
 * Families the committed manifest does NOT pin (upstream pinning is a
 * documented follow-up) but the validated prototype ships and the dev
 * catalog serves locally from the same fonts directory: the five CJK
 * families the parity matrix flagged as honest misses (得意黑 / 更纱黑体 /
 * 方舟像素 / 缝合像素 / 朱雀仿宋). Skipped with a console note when the
 * local binary is absent — never a silent gap, and never served by a
 * production catalog.
 */
const EXTRA_DEV_FAMILIES = [
  { family: "SmileySans", file: "SmileySans-Oblique.otf" },
  { family: "SarasaGothic", file: "SarasaMonoSC-Regular.ttf" },
  { family: "ZhuqueFangsong", file: "ZhuqueFangsong-Regular.ttf" },
  { family: "ArkPixel", file: "ark-pixel-12px-monospaced-zh_hans.ttf" },
  { family: "FusionPixel", file: "fusion-pixel-12px-monospaced-zh_hans.otf" },
];

/* ---------- minimal ZIP writer (stored entries) ---------- */

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
    const payload = entry.data;
    const crc = crc32(payload);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
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
    cd.writeUInt16LE(0, 10);
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

/* ---------- the catalog, built once on first request ---------- */

function resolveFamilyFile(family, available) {
  const alias = FILE_ALIASES[family];
  if (alias && available.has(alias)) return alias;
  const compact = family.replace(/-/g, "");
  for (const candidate of [
    `${compact}NerdFont-Regular.ttf`,
    `${compact}NerdFont-Regular.otf`,
  ]) {
    if (available.has(candidate)) return candidate;
  }
  return null;
}

/**
 * @typedef {{family: string, zip: string, zipSha256: string, zipBytes: Buffer,
 *            file: string, fileSha256: string}} CatalogFamily
 */

/** @type {Promise<{families: CatalogFamily[], misses: string[]}> | null} */
let catalogPromise = null;

function buildCatalog() {
  catalogPromise ??= (async () => {
    const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));

    let dir = null;
    for (const candidate of fontDirCandidates()) {
      if (existsSync(candidate)) {
        dir = candidate;
        break;
      }
    }
    if (dir === null) {
      console.warn(
        `[dev-catalog] no local fonts directory found (tried ${fontDirCandidates()
          .map((p) => `"${p}"`)
          .join(", ")}); set FONTALLOY_DEV_FONT_DIR — serving 503`,
      );
      return { families: [], misses: [] };
    }

    const available = new Set(
      (await readdir(dir)).filter((name) => /\.(ttf|otf|ttc|woff2?)$/i.test(name)),
    );

    /** @type {CatalogFamily[]} */
    const families = [];
    /** @type {string[]} */
    const misses = [];
    const seen = new Set();
    for (const entry of manifest.families) {
      // One release family per manifest family id (the release schema is
      // unique by family; the LXGW weight variants collapse onto the
      // face the prototype actually ships).
      if (seen.has(entry.family)) continue;
      seen.add(entry.family);
      const file = resolveFamilyFile(entry.family, available);
      if (file === null) {
        misses.push(entry.family);
        continue;
      }
      const data = await readFile(resolve(dir, file));
      const zipBytes = makeZip([{ name: file, data }]);
      families.push({
        family: entry.family,
        zip: `${entry.family.replace(/\s+/g, "")}.zip`,
        zipSha256: sha256hex(zipBytes),
        zipBytes,
        file,
        fileSha256: sha256hex(data),
      });
    }
    // The prototype-only CJK families (dev-only; see EXTRA_DEV_FAMILIES).
    for (const entry of EXTRA_DEV_FAMILIES) {
      if (!available.has(entry.file)) {
        misses.push(`${entry.family} (dev-only extra)`);
        continue;
      }
      const data = await readFile(resolve(dir, entry.file));
      const zipBytes = makeZip([{ name: entry.file, data }]);
      families.push({
        family: entry.family,
        zip: `${entry.family}.zip`,
        zipSha256: sha256hex(zipBytes),
        zipBytes,
        file: entry.file,
        fileSha256: sha256hex(data),
      });
    }
    console.info(
      `[dev-catalog] serving ${families.length} families (${seen.size} manifest + dev extras) from "${dir}"` +
        (misses.length > 0 ? `; no local binary for: ${misses.join(", ")}` : ""),
    );
    return { families, misses };
  })();
  return catalogPromise;
}

function releaseDocument(families, baseUrl) {
  return JSON.stringify(
    {
      schema: "fontalloy/catalog-release@v1",
      tag: "font-catalog-dev-local",
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

/** The shared request handler (dev serve and preview alike). */
async function handle(req, res, next) {
  const url = req.url ?? "";
  if (!url.startsWith("/dev-catalog/")) {
    next();
    return;
  }
  const { families } = await buildCatalog();
  const cors = {
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  };
  if (url.split("?")[0] === "/dev-catalog/catalog-release.json") {
    if (families.length === 0) {
      res.writeHead(503, cors);
      res.end("no local font binaries available for the dev catalog");
      return;
    }
    // Same-origin by construction: base_url points at the host the
    // browser actually reached us on.
    const host = req.headers.host ?? "127.0.0.1:5173";
    const body = releaseDocument(families, `http://${host}/dev-catalog/origins/dev`);
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
}

/**
 * The vite plugin: `configureServer` covers `vite dev`, and
 * `configurePreviewServer` covers `vite preview` (the built WebApp's
 * e2e suite and any local preview of the static target boot the same
 * real catalog). It never participates in a build.
 */
export function devCatalogPlugin() {
  return {
    name: "fontalloy-dev-catalog",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => handle(req, res, next));
    },
    configurePreviewServer(server) {
      server.middlewares.use(async (req, res, next) => handle(req, res, next));
    },
  };
}
