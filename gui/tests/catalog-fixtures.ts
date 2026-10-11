import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import type { Page, Route } from "@playwright/test";

/**
 * Simulated catalog origin for the first-run download tests (issue #17).
 *
 * The real catalog lives behind `catalog-release.json` on a GitHub Releases
 * tag (the origin-list metadata contract from #14 — see
 * core/fontalloy_core/catalog_release.py). Tests simulate the whole origin
 * with `page.route` interception: the bootstrap document and every family
 * zip are fulfilled from memory, so the flow is deterministic and needs no
 * network. (A local static server would work too; interception was chosen
 * because it gives per-request failure modes and counters for free.)
 *
 * The fixture zips mirror what CI packaging produces: fixed timestamps,
 * sorted entries, and deflate compression (the writer below also emits
 * stored entries so the reader handles both methods).
 */

/** Base URL of the simulated catalog origin (never leaves the test process). */
export const CATALOG_ORIGIN = "https://catalog.test";

export function sha256hex(data: Buffer | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

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

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Fixed 2026-01-01 00:00 local-header date, like the CI packaging. */
const DOS_TIME = 0x0000;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

export interface ZipEntryInput {
  name: string;
  data: Buffer;
  deflate?: boolean;
}

export function makeZip(entries: ZipEntryInput[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const method = entry.deflate ? 8 : 0;
    const payload = entry.deflate ? deflateRawSync(entry.data) : entry.data;
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    chunks.push(local, nameBuf, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // central directory signature
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8); // flags
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(entry.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra length
    cd.writeUInt16LE(0, 32); // comment length
    cd.writeUInt16LE(0, 34); // disk number
    cd.writeUInt16LE(0, 36); // internal attributes
    cd.writeUInt32LE(0, 38); // external attributes
    cd.writeUInt32LE(offset, 42); // local header offset
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // central directory disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16); // central directory offset
  eocd.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

/* ---------- simulated catalog-release ---------- */

export interface SimFamilySpec {
  /** Metadata family display name (what the pickers list). */
  family: string;
  /** Face file name inside the family zip. */
  file: string;
  /** Real host font binary backing the face (font binaries never enter git). */
  fontPath: string;
  /** Compress this family's zip with deflate (default: stored). */
  deflate?: boolean;
}

export interface SimFamily {
  family: string;
  zip: string;
  zipSha256: string;
  zipBytes: Buffer;
  files: { file: string; sha256: string }[];
}

export class SimCatalog {
  readonly families: SimFamily[];
  readonly releaseJson: string;
  readonly counters = new Map<string, number>();
  /** Per-family failure applied on EVERY origin: "abort" | "corrupt". */
  fail: Record<string, "abort" | "corrupt"> = {};
  /** Origin id that always refuses to serve a family (fallthrough tests). */
  downOrigin: Record<string, string> = {};
  /** Per-family gate awaited inside the route handler before serving. */
  gates: Record<string, () => Promise<void>> = {};

  private constructor(families: SimFamily[], releaseJson: string) {
    this.families = families;
    this.releaseJson = releaseJson;
  }

  static async create(specs: SimFamilySpec[]): Promise<SimCatalog> {
    const families: SimFamily[] = [];
    for (const spec of specs) {
      const data = await readFile(spec.fontPath);
      const zipBytes = makeZip([
        { name: spec.file, data, deflate: spec.deflate },
      ]);
      families.push({
        family: spec.family,
        zip: `${spec.family.replace(/\s+/g, "")}.zip`,
        zipSha256: sha256hex(zipBytes),
        zipBytes,
        files: [{ file: spec.file, sha256: sha256hex(data) }],
      });
    }
    // Mirrors the real schema (fontalloy/catalog-release@v1): ordered
    // origins, then per-family zip + face checksums.
    const release = {
      schema: "fontalloy/catalog-release@v1",
      tag: "font-catalog-test",
      origins: [
        { id: "primary", base_url: `${CATALOG_ORIGIN}/origins/primary` },
        { id: "backup", base_url: `${CATALOG_ORIGIN}/origins/backup` },
      ],
      families: families.map((f) => ({
        family: f.family,
        zip: f.zip,
        sha256: f.zipSha256,
        files: f.files.map((x) => ({ file: x.file, sha256: x.sha256 })),
      })),
    };
    return new SimCatalog(families, JSON.stringify(release, null, 1));
  }

  /** Times `key` was requested (e.g. "primary:Alloy Sans", "release"). */
  count(key: string): number {
    return this.counters.get(key) ?? 0;
  }

  private bump(key: string): void {
    this.counters.set(key, this.count(key) + 1);
  }

  /** Intercept every catalog.test URL before any request leaves the page. */
  async install(page: Page): Promise<void> {
    await page.route(`${CATALOG_ORIGIN}/**`, (route) => this.handle(route));
  }

  private async handle(route: Route): Promise<void> {
    const url = new URL(route.request().url());
    const cors: Record<string, string> = {
      "access-control-allow-origin": "*",
    };
    if (url.pathname === "/catalog-release.json") {
      this.bump("release");
      await route.fulfill({
        status: 200,
        headers: { ...cors, "content-type": "application/json" },
        body: this.releaseJson,
      });
      return;
    }
    const match = url.pathname.match(/^\/origins\/([^/]+)\/([^/]+)$/);
    if (!match) {
      await route.fulfill({ status: 404, headers: cors, body: "not found" });
      return;
    }
    const [, originId, zipName] = match;
    const family = this.families.find((f) => f.zip === zipName);
    if (!family) {
      await route.fulfill({
        status: 404,
        headers: cors,
        body: "unknown artifact",
      });
      return;
    }
    this.bump(`${originId}:${family.family}`);
    const gate = this.gates[family.family];
    if (gate) await gate();
    if (this.downOrigin[family.family] === originId) {
      await route.abort("connectionfailed");
      return;
    }
    const mode = this.fail[family.family];
    if (mode === "abort") {
      await route.abort("connectionfailed");
      return;
    }
    if (mode === "corrupt") {
      // HTTP 200 with bytes that do not match the pinned sha256 — the
      // download must be rejected at verification, not at transport.
      await route.fulfill({
        status: 200,
        headers: { ...cors, "content-type": "application/zip" },
        body: Buffer.from("these bytes are not the zip the sha256 pinned"),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { ...cors, "content-type": "application/zip" },
      body: family.zipBytes,
    });
  }
}

/** Point the app's catalog bootstrap at the simulated origin, before load. */
export async function injectCatalogConfig(
  page: Page,
  url = `${CATALOG_ORIGIN}/catalog-release.json`,
): Promise<void> {
  await page.addInitScript((bootstrap) => {
    (window as { __FONTALLOY_CONFIG__?: unknown }).__FONTALLOY_CONFIG__ = {
      catalogBootstrapUrl: bootstrap,
    };
  }, url);
}
