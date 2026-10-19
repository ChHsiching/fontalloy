import { mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";

/**
 * The dev-catalog middleware must STREAM from disk — never retain font
 * bytes (the round-31 absolute rule: no process of ours may saturate
 * this machine). The final heavy verification sampled the vite node
 * (the /dev-catalog middleware) at ~13.9 GB working set while serving
 * the ~9.8 GB warm cache: buildCatalog() read EVERY family's faces into
 * memory (faces[].data) AND built every family's release zip as a
 * retained Buffer (zipBytes) — roughly 2x the cache, held for the
 * server's life.
 *
 * This spec pins the memory contract at the generator seam (the same
 * import-the-plugin seam dev-catalog.spec.ts uses): with a 128 MiB
 * crafted catalog, building the release document and serving every
 * family zip must leave the process RSS flat. The retained-bytes bug is
 * ~2x fixture size; the bound is 64 MiB (half a single copy — slack for
 * chunk noise, an order below the red signature).
 *
 * Also pins the stream/hash invariant the zip-sha pinning depends on:
 * the sha256 the document declares for a family zip equals the sha256
 * of the bytes actually served.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, "../scripts/dev-catalog.mjs");

/** Import the generator fresh (its catalog promise memoizes per module). */
async function freshPlugin(tag: string): Promise<{
  devCatalogPlugin: () => {
    configureServer: (server: {
      middlewares: { use: (fn: unknown) => void };
    }) => void;
  };
}> {
  return import(`${pathToFileURL(SCRIPT).href}?mem=${tag}`);
}

type Middleware = (req: unknown, res: unknown, next: () => void) => Promise<void>;

/**
 * A fake res that captures BOTH serving shapes: buffered (res.end(body),
 * the pre-fix code) and streamed (res.write(chunk) then res.end(), the
 * disk-streaming code).
 */
function fakeRequest(url: string): {
  req: { url: string; headers: { host: string } };
  handlerRes: {
    writeHead: (status: number, headers: Record<string, string>) => void;
    write: (chunk: string | Buffer) => boolean;
    end: (body?: string | Buffer) => void;
  };
  captured: { status: number; chunks: Buffer[]; body: Buffer };
} {
  const req = { url, headers: { host: "127.0.0.1:5999" } };
  const captured = { status: 0, chunks: [] as Buffer[], body: Buffer.alloc(0) };
  const handlerRes = {
    writeHead(status: number, headers: Record<string, string>) {
      captured.status = status;
      void headers;
    },
    write(chunk: string | Buffer) {
      captured.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    },
    end(body?: string | Buffer) {
      if (body !== undefined) {
        captured.chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(body));
      }
      captured.body = Buffer.concat(captured.chunks);
    },
  };
  return { req, handlerRes, captured };
}

test.describe("the dev catalog middleware's memory", () => {
  test("document build + every zip serve leaves RSS flat (stream from disk, retain metadata only)", async () => {
    // 4 families x 4 faces x 8 MiB = 128 MiB of font-shaped fixtures.
    const FAMILIES = ["MemProbeA", "MemProbeB", "MemProbeC", "MemProbeD"];
    const STYLES = ["Regular", "Bold", "Italic", "BoldItalic"];
    const FACE_BYTES = 8 * 1024 * 1024;

    const root = join(tmpdir(), `fontalloy-devcat-mem-${Date.now()}`);
    const fontDir = join(root, "fonts");
    const cacheDir = join(root, "cache");
    await mkdir(fontDir, { recursive: true });
    const sha = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");
    const manifestFamilies: Array<Record<string, string>> = [];
    for (const family of FAMILIES) {
      for (const style of STYLES) {
        // A cheap pseudo-random payload: font bytes are never parsed
        // here, but non-uniform bytes keep the fixture honest against
        // any future compression/dedup path.
        const block = randomBytes(64 * 1024);
        const face = Buffer.alloc(FACE_BYTES);
        for (let off = 0; off < FACE_BYTES; off += block.length) {
          block.copy(face, off);
        }
        await writeFile(join(fontDir, `${family}-${style}.ttf`), face);
        if (style === "Regular") {
          manifestFamilies.push({
            family,
            variant: "Regular",
            // An archive-stem entry (never fetched — faces are local and
            // the network pass is off) so dash-stem resolution pulls ALL
            // four sibling faces into the family union.
            file: `${family}.zip`,
            version: "test",
            upstream_url: `http://127.0.0.1:9/${family}.zip`,
            sha256: "0".repeat(64),
          });
        }
      }
    }
    const manifestPath = join(root, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({ schema: "fontalloy/font-catalog@v1", families: manifestFamilies }),
    );

    process.env.FONTALLOY_DEV_FONT_DIR = fontDir;
    process.env.FONTALLOY_DEV_CATALOG_CACHE = cacheDir;
    process.env.FONTALLOY_DEV_CATALOG_MANIFEST = manifestPath;
    process.env.FONTALLOY_DEV_CATALOG_FETCH = "0";
    try {
      // Baseline AFTER the fixture work: its garbage must not count
      // against the middleware.
      const baseline = process.memoryUsage();
      const gc = globalThis.gc as (() => void) | undefined;

      const { devCatalogPlugin } = await freshPlugin("mem");
      let middleware: Middleware | null = null;
      devCatalogPlugin().configureServer({
        middlewares: { use: (fn: typeof middleware) => (middleware = fn) },
      });

      const doc = fakeRequest("/dev-catalog/catalog-release.json");
      await middleware!(doc.req as never, doc.handlerRes as never, () => {});
      expect(doc.captured.status).toBe(200);
      const release = JSON.parse(doc.captured.body.toString("utf8")) as {
        families: Array<{
          family: string;
          zip: string;
          sha256: string;
          files: Array<{ file: string; sha256: string }>;
        }>;
      };
      expect(release.families.map((f) => f.family).sort()).toEqual([...FAMILIES].sort());
      for (const family of release.families) {
        expect(family.files, `${family.family} lists all four faces`).toHaveLength(4);
      }

      // Serve EVERY family zip — the first-run full-catalog download's
      // exact request shape. The document's pinned sha256 must equal the
      // served bytes' sha256 (the stream/hash invariant the client's
      // verification depends on). Each response is released right after
      // its assertions — the harness must not retain what the
      // middleware streams.
      let servedBytes = 0;
      for (const family of release.families) {
        const zip = fakeRequest(`/dev-catalog/origins/dev/${family.zip}`);
        await middleware!(zip.req as never, zip.handlerRes as never, () => {});
        expect(zip.captured.status, `${family.zip} serves`).toBe(200);
        expect(zip.captured.body.length, `${family.zip} carries all faces`).toBeGreaterThanOrEqual(
          4 * FACE_BYTES,
        );
        expect(sha(zip.captured.body), `${family.zip} matches its pinned sha256`).toBe(
          family.sha256,
        );
        servedBytes += zip.captured.body.length;
        zip.captured.chunks = [];
        zip.captured.body = Buffer.alloc(0);
      }
      expect(servedBytes, "the whole catalog served").toBeGreaterThanOrEqual(4 * 4 * FACE_BYTES);

      const after = (() => {
        // Measure RETENTION, not allocator churn: the streamed pass and
        // the download allocate hundreds of MiB of short-lived buffers
        // whose freed pages can stay committed. Run this spec with
        // NODE_OPTIONS=--expose-gc (the acceptance runner does); when
        // gc is exposed, collect twice before reading.
        gc?.();
        gc?.();
        return process.memoryUsage();
      })();
      const deltaMiB = Math.round((after.rss - baseline.rss) / (1024 * 1024));
      const fixtureMiB = Math.round((4 * 4 * FACE_BYTES) / (1024 * 1024));
      // The bound splits the two signatures with margin both ways: the
      // retained-bytes bug holds ~2x the fixture in live Buffers
      // (measured 376 MiB RSS over this 128 MiB fixture — red), while
      // the streaming code's freed-but-committed churn noise measured
      // at most 191 MiB without a gc pause (green headroom).
      const RSS_BOUND_MIB = 256;
      expect(
        deltaMiB,
        `RSS delta ${deltaMiB} MiB over a ${fixtureMiB} MiB fixture must stay under ${RSS_BOUND_MIB} MiB` +
          ` (rss ${baseline.rss} -> ${after.rss}; external ${baseline.external} -> ${after.external})`,
      ).toBeLessThan(RSS_BOUND_MIB);
      if (gc) {
        // With collection forced, live Buffer memory is the razor: the
        // bug retains ~2x the fixture (faces + zips); the streaming
        // build retains metadata only (measured 13 MiB).
        const extDeltaMiB = Math.round((after.external - baseline.external) / (1024 * 1024));
        expect(
          extDeltaMiB,
          `external (Buffer) delta ${extDeltaMiB} MiB must stay under 64 MiB after gc`,
        ).toBeLessThan(64);
      }
    } finally {
      delete process.env.FONTALLOY_DEV_FONT_DIR;
      delete process.env.FONTALLOY_DEV_CATALOG_CACHE;
      delete process.env.FONTALLOY_DEV_CATALOG_MANIFEST;
      delete process.env.FONTALLOY_DEV_CATALOG_FETCH;
      await rm(root, { recursive: true, force: true });
    }
  });
});
