import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * The dev catalog generator (gui/scripts/dev-catalog.mjs) must honor the
 * PRODUCTION release schema — "one zip per family (all faces plus the
 * license file)", catalog-release.yml — not a one-face stand-in. The
 * round-15/16 owner report (the GUI's weight matrix built ONE 400 slot)
 * was this: the dev release document listed a single Regular face per
 * family, the app faithfully downloaded it, and the family-cut pattern
 * pooled the one face that existed. This spec pins the generator seam
 * directly: given a local fonts directory whose family carries several
 * faces, the document and the zip carry them ALL.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, "../scripts/dev-catalog.mjs");

/** Minimal fake node req/res pair capturing the plugin's response. */
function fakeRequest(url: string): {
  req: { url: string; headers: { host: string } };
  handlerRes: {
    writeHead: (status: number, headers: Record<string, string>) => void;
    end: (body?: string | Buffer) => void;
  };
  captured: { status: number; body: Buffer };
} {
  const req = { url, headers: { host: "127.0.0.1:5999" } };
  const captured = { status: 0, body: Buffer.alloc(0) };
  const handlerRes = {
    writeHead(status: number, headers: Record<string, string>) {
      captured.status = status;
      void headers;
    },
    end(body?: string | Buffer) {
      captured.body = Buffer.isBuffer(body) ? body : Buffer.from(body ?? "");
    },
  };
  return { req, handlerRes, captured };
}

test.describe("the dev catalog generator", () => {
  test("a multi-cut family serves BOTH cuts' faces — never the shadowed prototype alias", async () => {
    const fontDir = join(tmpdir(), `fontalloy-devcat-cut-${Date.now()}`);
    await mkdir(fontDir, { recursive: true });
    const cutFaces = [
      "MapleMono-NF-Bold.ttf",
      "MapleMono-NF-Regular.ttf",
      "MapleMono-NF-CN-Bold.ttf",
      "MapleMono-NF-CN-Regular.ttf",
    ];
    for (const face of cutFaces) {
      await writeFile(join(fontDir, face), Buffer.from(`dummy-${face}`));
    }
    process.env.FONTALLOY_DEV_FONT_DIR = fontDir;

    try {
      const { devCatalogPlugin } = await import(SCRIPT);
      let middleware: ((req: unknown, res: unknown, next: () => void) => Promise<void>) | null =
        null;
      devCatalogPlugin().configureServer({
        middlewares: { use: (fn: typeof middleware) => (middleware = fn) },
      });
      const doc = fakeRequest("/dev-catalog/catalog-release.json");
      await middleware!(doc.req as never, doc.handlerRes as never, () => {});
      const release = JSON.parse(doc.captured.body.toString("utf8")) as {
        families: Array<{ family: string; files: Array<{ file: string }> }>;
      };
      const maple = release.families.find((f) => f.family === "MapleMono");
      expect(maple).toBeDefined();
      // Both cuts ride the release; the prototype-era bare CN face
      // (MapleMonoCN-Regular.ttf, also present via the prototype layout
      // the generator scans) matches neither stem and stays out.
      expect(maple!.files.map((f) => f.file).sort()).toEqual([...cutFaces].sort());
    } finally {
      delete process.env.FONTALLOY_DEV_FONT_DIR;
      await rm(fontDir, { recursive: true, force: true });
    }
  });

  test("a multi-face family serves EVERY face in its document and zip", async () => {
    const fontDir = join(tmpdir(), `fontalloy-devcat-${Date.now()}`);
    await mkdir(fontDir, { recursive: true });
    const faces = [
      "JetBrainsMonoNerdFont-Regular.ttf",
      "JetBrainsMonoNerdFont-Bold.ttf",
      "JetBrainsMonoNerdFont-Italic.ttf",
    ];
    for (const face of faces) {
      await writeFile(join(fontDir, face), Buffer.from(`dummy-${face}`));
    }
    process.env.FONTALLOY_DEV_FONT_DIR = fontDir;

    try {
      const { devCatalogPlugin } = await import(SCRIPT);
      let middleware: ((req: unknown, res: unknown, next: () => void) => Promise<void>) | null =
        null;
      devCatalogPlugin().configureServer({
        middlewares: { use: (fn: typeof middleware) => (middleware = fn) },
      });
      expect(middleware).not.toBeNull();

      const doc = fakeRequest("/dev-catalog/catalog-release.json");
      await middleware!(doc.req as never, doc.handlerRes as never, () => {});
      expect(doc.captured.status).toBe(200);
      const release = JSON.parse(doc.captured.body.toString("utf8")) as {
        families: Array<{ family: string; files: Array<{ file: string }>; zip: string }>;
      };
      const jb = release.families.find((f) => f.family === "JetBrainsMono");
      expect(jb).toBeDefined();
      expect(
        jb!.files.map((f) => f.file).sort(),
        "the release document lists every local face of the family",
      ).toEqual([...faces].sort());

      const zip = fakeRequest(`/dev-catalog/origins/dev/${jb!.zip}`);
      await middleware!(zip.req as never, zip.handlerRes as never, () => {});
      expect(zip.captured.status).toBe(200);
      // EOCD entry count (a stored-format zip; no zip64 at these sizes).
      const bytes = zip.captured.body;
      let eocd = -1;
      for (let i = bytes.length - 22; i >= bytes.length - 22 - 65536 && i >= 0; i--) {
        if (bytes.readUInt32LE(i) === 0x06054b50) {
          eocd = i;
          break;
        }
      }
      expect(eocd).toBeGreaterThanOrEqual(0);
      expect(bytes.readUInt16LE(eocd + 10), "the zip carries every face").toBe(faces.length);
    } finally {
      delete process.env.FONTALLOY_DEV_FONT_DIR;
      await rm(fontDir, { recursive: true, force: true });
    }
  });
});
