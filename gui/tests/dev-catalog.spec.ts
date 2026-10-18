import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
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
 *
 * Round 20 (owner item 2): resolution is PER VARIANT ENTRY. Every
 * multi-entry family serves EVERY cut's faces — each entry's artifact
 * stem resolves its OWN extraction directory (`<stem>/` one level under
 * the font dir, the `fontalloy assets fetch` layout, robust for names
 * like 14_SourceHanSansHWSC) — and the upstream pass fetches PER ENTRY
 * (the by-FAMILY fetch of round 9 only ever pulled the DEFAULT entry,
 * so NotoSansSC's HW and Mono cuts were never even unpacked locally).
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
  return import(`${pathToFileURL(SCRIPT).href}?r20=${tag}`);
}

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

/** The sha256 of a fixture file (manifest pins in the tests below). */
function shaOf(path: string): string {
  return createHash("sha256")
    .update(readFileSync(path))
    .digest("hex");
}

test.describe("the dev catalog generator", () => {
  test("a multi-cut family serves BOTH cuts' faces — never the shadowed prototype alias", async () => {
    const fontDir = join(tmpdir(), `fontalloy-devcat-cut-${Date.now()}`);
    const cacheDir = join(tmpdir(), `fontalloy-devcat-cache-cut-${Date.now()}`);
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
    // An empty cache of its own: the repo's warm upstream cache (a
    // previous live run) would otherwise inflate the asserted unions.
    process.env.FONTALLOY_DEV_CATALOG_CACHE = cacheDir;
    process.env.FONTALLOY_DEV_CATALOG_FETCH = "0";

    try {
      const { devCatalogPlugin } = await freshPlugin("cutshadow");
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
      delete process.env.FONTALLOY_DEV_CATALOG_CACHE;
      delete process.env.FONTALLOY_DEV_CATALOG_FETCH;
      await rm(fontDir, { recursive: true, force: true });
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  test("a multi-face family serves EVERY face in its document and zip", async () => {
    const fontDir = join(tmpdir(), `fontalloy-devcat-${Date.now()}`);
    const cacheDir = join(tmpdir(), `fontalloy-devcat-cache-${Date.now()}`);
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
    process.env.FONTALLOY_DEV_CATALOG_CACHE = cacheDir;
    process.env.FONTALLOY_DEV_CATALOG_FETCH = "0";

    try {
      const { devCatalogPlugin } = await freshPlugin("multiface");
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
      delete process.env.FONTALLOY_DEV_CATALOG_CACHE;
      delete process.env.FONTALLOY_DEV_CATALOG_FETCH;
      await rm(fontDir, { recursive: true, force: true });
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  test("a multi-entry family serves EVERY entry's faces — per-entry stem resolution (round 20)", async () => {
    // The fetch layout extracts each pinned artifact into
    // `<archive stem>/` — including versioned and numbered archive
    // names (HackGen_NF_v2.10.0, 14_SourceHanSansHWSC) that round 17's
    // cut-stem PREFIX matching never saw. Every entry's faces ride the
    // ONE family release; the primary face follows the DEFAULT entry.
    const fontDir = join(tmpdir(), `fontalloy-devcat-entry-${Date.now()}`);
    const cacheDir = join(tmpdir(), `fontalloy-devcat-cache-entry-${Date.now()}`);
    const extracted: Array<[string, string[]]> = [
      ["14_SourceHanSansHWSC", ["SourceHanSansHWSC-Bold.otf", "SourceHanSansHWSC-Regular.otf"]],
      ["13_NotoSansMonoCJKsc", ["NotoSansMonoCJKsc-Bold.otf", "NotoSansMonoCJKsc-Regular.otf"]],
      ["HackGen_NF_v2.10.0", ["HackGen35ConsoleNF-Regular.ttf", "HackGenConsoleNF-Regular.ttf"]],
      ["HackGen_v2.10.0", ["HackGen-Regular.ttf", "HackGen35-Regular.ttf"]],
      ["BizinGothicNF_v0.0.4", ["BizinGothicNF-Regular.ttf", "BizinGothicDiscordNF-Regular.ttf"]],
      ["BizinGothic_v0.0.4", ["BizinGothic-Regular.ttf"]],
    ];
    for (const [dir, faces] of extracted) {
      await mkdir(join(fontDir, dir), { recursive: true });
      for (const face of faces) {
        await writeFile(join(fontDir, dir, face), Buffer.from(`dummy-${face}`));
      }
    }
    // The Variable entry is a bare font file (the VF itself), flat.
    await writeFile(join(fontDir, "NotoSansSC[wght].ttf"), Buffer.from("dummy-vf"));
    process.env.FONTALLOY_DEV_FONT_DIR = fontDir;
    process.env.FONTALLOY_DEV_CATALOG_CACHE = cacheDir;
    process.env.FONTALLOY_DEV_CATALOG_FETCH = "0";

    try {
      const { devCatalogPlugin } = await freshPlugin("entries");
      let middleware: ((req: unknown, res: unknown, next: () => void) => Promise<void>) | null = null;
      devCatalogPlugin().configureServer({
        middlewares: { use: (fn: typeof middleware) => (middleware = fn) },
      });
      const doc = fakeRequest("/dev-catalog/catalog-release.json");
      await middleware!(doc.req as never, doc.handlerRes as never, () => {});
      expect(doc.captured.status).toBe(200);
      const release = JSON.parse(doc.captured.body.toString("utf8")) as {
        families: Array<{ family: string; variant?: string; files: Array<{ file: string }> }>;
      };
      const filesOf = (family: string): string[] | undefined =>
        release.families.find((f) => f.family === family)?.files.map((f) => f.file).sort();

      // NotoSansSC: the union of ALL THREE entries — HW (Adobe) +
      // Mono (Google) + the Variable VF — under one release zip.
      expect(filesOf("NotoSansSC")).toEqual([
        "NotoSansMonoCJKsc-Bold.otf",
        "NotoSansMonoCJKsc-Regular.otf",
        "NotoSansSC[wght].ttf",
        "SourceHanSansHWSC-Bold.otf",
        "SourceHanSansHWSC-Regular.otf",
      ]);
      // The primary face follows the DEFAULT entry (Variable for
      // NotoSansSC, Standard for the yuru7 pairs) — visible as the
      // document's declared variant.
      expect(release.families.find((f) => f.family === "NotoSansSC")?.variant).toBe("Variable");
      expect(release.families.find((f) => f.family === "HackGen")?.variant).toBe("Standard");

      // Versioned archive stems resolve their own cuts too.
      expect(filesOf("HackGen")).toEqual([
        "HackGen-Regular.ttf",
        "HackGen35-Regular.ttf",
        "HackGen35ConsoleNF-Regular.ttf",
        "HackGenConsoleNF-Regular.ttf",
      ]);
      expect(filesOf("BizinGothic")).toEqual([
        "BizinGothic-Regular.ttf",
        "BizinGothicDiscordNF-Regular.ttf",
        "BizinGothicNF-Regular.ttf",
      ]);
    } finally {
      delete process.env.FONTALLOY_DEV_FONT_DIR;
      delete process.env.FONTALLOY_DEV_CATALOG_CACHE;
      delete process.env.FONTALLOY_DEV_CATALOG_FETCH;
      await rm(fontDir, { recursive: true, force: true });
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  test("a multi-entry family's release entry carries EVERY cut — per-cut entries, variant_cuts semantics", async () => {
    // The spec #25 final-batch finding: the release document emitted ONE
    // entry per family with ONE chosen variant, so a multi-cut family
    // (MapleMono NF + NF-CN) could not be REPRESENTED — a consumer of
    // the document alone (a manifest-less serve, the run-assets refresh)
    // saw a single cut where /catalog/families lists two. The family's
    // release entry now carries a nested per-cut list with the SAME
    // semantics as variant_cuts: entries collapse by their non-weight
    // axis vector, the canonical member prefers the Regular weight, the
    // default cut comes first, and each cut lists its OWN resolved
    // faces (a failed cut stays an honest empty entry).
    const root = join(tmpdir(), `fontalloy-devcat-cuts-${Date.now()}`);
    const fontDir = join(root, "fonts");
    const cacheDir = join(root, "cache");
    await mkdir(join(fontDir, "MapleMono-NF"), { recursive: true });
    await mkdir(join(fontDir, "MapleMono-NF-CN"), { recursive: true });
    for (const face of [
      "MapleMono-NF-Regular.ttf",
      "MapleMono-NF-Bold.ttf",
      "MapleMono-NF-CN-Regular.ttf",
      "MapleMono-NF-CN-Bold.ttf",
    ]) {
      const dir = face.includes("-CN-") ? "MapleMono-NF-CN" : "MapleMono-NF";
      await writeFile(join(fontDir, dir, face), Buffer.from(`dummy-${face}`));
    }
    // The collapse pin: two entries of ONE axis vector (a Light + Regular
    // weight pair) are ONE cut, the Regular the canonical member.
    for (const face of ["WeightPair-Regular.ttf", "WeightPair-Light.ttf"]) {
      await writeFile(join(fontDir, face), Buffer.from(`dummy-${face}`));
    }
    const manifest = {
      schema: "fontalloy/font-catalog@v1",
      families: [
        {
          family: "MapleMono", variant: "NF", file: "MapleMono-NF.zip",
          version: "v7.9", upstream_url: "http://127.0.0.1:9/nf.zip",
          sha256: "a".repeat(64), axes: { icons: "nf" },
        },
        {
          family: "MapleMono", variant: "NF-CN", file: "MapleMono-NF-CN.zip",
          version: "v7.9", upstream_url: "http://127.0.0.1:9/nfcn.zip",
          sha256: "b".repeat(64), axes: { icons: "nf", region: "SC" },
        },
        {
          family: "WeightPair", variant: "Regular", file: "WeightPair-Regular.ttf",
          version: "v1", upstream_url: "http://127.0.0.1:9/r.ttf",
          sha256: shaOf(join(fontDir, "WeightPair-Regular.ttf")),
        },
        {
          family: "WeightPair", variant: "Light", file: "WeightPair-Light.ttf",
          version: "v1", upstream_url: "http://127.0.0.1:9/l.ttf",
          sha256: shaOf(join(fontDir, "WeightPair-Light.ttf")),
        },
      ],
    };
    const manifestPath = join(root, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest));

    process.env.FONTALLOY_DEV_FONT_DIR = fontDir;
    process.env.FONTALLOY_DEV_CATALOG_CACHE = cacheDir;
    process.env.FONTALLOY_DEV_CATALOG_MANIFEST = manifestPath;
    process.env.FONTALLOY_DEV_CATALOG_FETCH = "0";
    try {
      const { devCatalogPlugin } = await freshPlugin("cutsdoc");
      let middleware: ((req: unknown, res: unknown, next: () => void) => Promise<void>) | null = null;
      devCatalogPlugin().configureServer({
        middlewares: { use: (fn: typeof middleware) => (middleware = fn) },
      });
      const doc = fakeRequest("/dev-catalog/catalog-release.json");
      await middleware!(doc.req as never, doc.handlerRes as never, () => {});
      expect(doc.captured.status).toBe(200);
      const release = JSON.parse(doc.captured.body.toString("utf8")) as {
        families: Array<{
          family: string;
          variant?: string;
          cuts?: Array<{
            variant: string;
            def: boolean;
            label: string;
            file: string;
            sha256: string;
            axes: Record<string, string>;
            files: Array<{ file: string; sha256: string }>;
          }>;
          files: Array<{ file: string }>;
        }>;
      };
      const maple = release.families.find((f) => f.family === "MapleMono");
      expect(maple).toBeDefined();
      expect(maple!.variant).toBe("NF");
      expect(maple!.cuts, "the release entry carries EVERY cut").toHaveLength(2);
      // Default first: the NF cut (region carries no implicit default, so
      // the first manifest entry of the collapsed set is the default).
      expect(maple!.cuts![0]).toMatchObject({
        variant: "NF",
        def: true,
        label: "MapleMono-NF",
        file: "MapleMono-NF.zip",
        sha256: "a".repeat(64),
        axes: { icons: "nf" },
      });
      expect(maple!.cuts![0]!.files.map((f) => f.file).sort()).toEqual([
        "MapleMono-NF-Bold.ttf",
        "MapleMono-NF-Regular.ttf",
      ]);
      expect(maple!.cuts![1]).toMatchObject({
        variant: "NF-CN",
        def: false,
        label: "MapleMono-NF-CN",
        axes: { icons: "nf", region: "SC" },
      });
      expect(maple!.cuts![1]!.files.map((f) => f.file).sort()).toEqual([
        "MapleMono-NF-CN-Bold.ttf",
        "MapleMono-NF-CN-Regular.ttf",
      ]);
      // The family-level shape is unchanged: ONE zip, the union of all
      // cuts' faces.
      expect(maple!.files.map((f) => f.file)).toHaveLength(4);
      // The collapse: a weight pair of one axis vector is ONE cut, the
      // Regular its canonical member.
      const pair = release.families.find((f) => f.family === "WeightPair");
      expect(pair!.cuts).toHaveLength(1);
      expect(pair!.cuts![0]).toMatchObject({
        variant: "Regular",
        def: true,
        file: "WeightPair-Regular.ttf",
      });
      expect(pair!.cuts![0]!.files.map((f) => f.file).sort()).toEqual([
        "WeightPair-Light.ttf",
        "WeightPair-Regular.ttf",
      ]);
    } finally {
      delete process.env.FONTALLOY_DEV_FONT_DIR;
      delete process.env.FONTALLOY_DEV_CATALOG_CACHE;
      delete process.env.FONTALLOY_DEV_CATALOG_MANIFEST;
      delete process.env.FONTALLOY_DEV_CATALOG_FETCH;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the upstream pass fetches PER ENTRY: a missing cut fills in, warm entries never refetch", async () => {
    // Hermetic upstream: a crafted manifest (env-overridden) whose
    // NotoSansSC entries point at this test's fake fetch. The local
    // layout carries ONLY the Variable face; the Adobe and Google
    // entries must be fetched and unpacked EACH into their own cache
    // faces dir — the round-9 by-FAMILY fetch pulled only the DEFAULT
    // entry, so these cuts were never served.
    const root = join(tmpdir(), `fontalloy-devcat-fetch-${Date.now()}`);
    const fontDir = join(root, "fonts");
    const cacheDir = join(root, "cache");
    await mkdir(fontDir, { recursive: true });
    await writeFile(join(fontDir, "NotoSansSC[wght].ttf"), Buffer.from("dummy-vf"));

    const hwZip = storedZip([
      { name: "SourceHanSansHWSC-Regular.otf", data: Buffer.from("dummy-hw-regular") },
      { name: "SourceHanSansHWSC-Bold.otf", data: Buffer.from("dummy-hw-bold") },
    ]);
    const monoZip = storedZip([
      { name: "NotoSansMonoCJKsc-Regular.otf", data: Buffer.from("dummy-mono-regular") },
      { name: "NotoSansMonoCJKsc-Bold.otf", data: Buffer.from("dummy-mono-bold") },
    ]);
    const sha = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");
    const manifest = {
      schema: "fontalloy/font-catalog@v1",
      families: [
        {
          family: "NotoSansSC", variant: "HW", file: "14_SourceHanSansHWSC.zip",
          version: "2.005R", upstream_url: "http://127.0.0.1:9/hw.zip", sha256: sha(hwZip),
        },
        {
          family: "NotoSansSC", variant: "Mono", file: "13_NotoSansMonoCJKsc.zip",
          version: "Sans2.004", upstream_url: "http://127.0.0.1:9/mono.zip", sha256: sha(monoZip),
        },
        {
          family: "NotoSansSC", variant: "Variable", file: "NotoSansSC[wght].ttf",
          version: "test", upstream_url: "http://127.0.0.1:9/vf.ttf", sha256: sha(Buffer.from("dummy-vf")),
        },
      ],
    };
    const manifestPath = join(root, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest));

    const fetched = new Map<string, number>();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      fetched.set(url, (fetched.get(url) ?? 0) + 1);
      if (url.endsWith("hw.zip")) return new Response(new Uint8Array(hwZip), { status: 200 });
      if (url.endsWith("mono.zip")) return new Response(new Uint8Array(monoZip), { status: 200 });
      return new Response("gone", { status: 404 });
    }) as typeof fetch;

    process.env.FONTALLOY_DEV_FONT_DIR = fontDir;
    process.env.FONTALLOY_DEV_CATALOG_CACHE = cacheDir;
    process.env.FONTALLOY_DEV_CATALOG_MANIFEST = manifestPath;
    try {
      const { devCatalogPlugin } = await freshPlugin("fetch1");
      let middleware: ((req: unknown, res: unknown, next: () => void) => Promise<void>) | null = null;
      devCatalogPlugin().configureServer({
        middlewares: { use: (fn: typeof middleware) => (middleware = fn) },
      });
      const doc = fakeRequest("/dev-catalog/catalog-release.json");
      await middleware!(doc.req as never, doc.handlerRes as never, () => {});
      expect(doc.captured.status).toBe(200);
      const release = JSON.parse(doc.captured.body.toString("utf8")) as {
        families: Array<{ family: string; variant?: string; files: Array<{ file: string }> }>;
      };
      const noto = release.families.find((f) => f.family === "NotoSansSC");
      expect(noto).toBeDefined();
      expect(noto!.files.map((f) => f.file).sort()).toEqual([
        "NotoSansMonoCJKsc-Bold.otf",
        "NotoSansMonoCJKsc-Regular.otf",
        "NotoSansSC[wght].ttf",
        "SourceHanSansHWSC-Bold.otf",
        "SourceHanSansHWSC-Regular.otf",
      ]);
      expect(noto!.variant).toBe("Variable");
      // Each entry unpacked into its OWN cache faces dir, keyed by the
      // artifact stem (the fetch-layout dir name).
      const { readdir } = await import("node:fs/promises");
      expect((await readdir(join(cacheDir, "faces", "14_SourceHanSansHWSC"))).sort()).toEqual([
        ".source-sha256",
        "SourceHanSansHWSC-Bold.otf",
        "SourceHanSansHWSC-Regular.otf",
      ]);
      expect((await readdir(join(cacheDir, "faces", "13_NotoSansMonoCJKsc"))).sort()).toEqual([
        ".source-sha256",
        "NotoSansMonoCJKsc-Bold.otf",
        "NotoSansMonoCJKsc-Regular.otf",
      ]);

      // A warm cache never refetches: a fresh generator instance (a
      // later boot) serves from the cache alone.
      fetched.clear();
      const again = fakeRequest("/dev-catalog/catalog-release.json");
      const { devCatalogPlugin: reboot } = await freshPlugin("fetch2");
      let middleware2: ((req: unknown, res: unknown, next: () => void) => Promise<void>) | null = null;
      reboot().configureServer({
        middlewares: { use: (fn: typeof middleware2) => (middleware2 = fn) },
      });
      await middleware2!(again.req as never, again.handlerRes as never, () => {});
      expect(again.captured.status).toBe(200);
      expect([...fetched.keys()].filter((u) => u.endsWith("hw.zip") || u.endsWith("mono.zip"))).toEqual([]);
      const release2 = JSON.parse(again.captured.body.toString("utf8")) as {
        families: Array<{ family: string; files: Array<{ file: string }> }>;
      };
      expect(release2.families.find((f) => f.family === "NotoSansSC")!.files).toHaveLength(5);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.FONTALLOY_DEV_FONT_DIR;
      delete process.env.FONTALLOY_DEV_CATALOG_CACHE;
      delete process.env.FONTALLOY_DEV_CATALOG_MANIFEST;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a failing per-entry fetch stays an honest miss — the family serves its other cuts", async () => {
    // The Mono entry's upstream is down (500): NotoSansSC still serves
    // the locally-present Variable face plus the fetched HW cut, the
    // Mono chip renders 未下载 downstream, and a family whose EVERY
    // entry fails simply stays out of the document — never a silent
    // collapse onto the wrong cut.
    const root = join(tmpdir(), `fontalloy-devcat-miss-${Date.now()}`);
    const fontDir = join(root, "fonts");
    const cacheDir = join(root, "cache");
    await mkdir(fontDir, { recursive: true });
    await writeFile(join(fontDir, "NotoSansSC[wght].ttf"), Buffer.from("dummy-vf"));
    await writeFile(join(fontDir, "Ghost-Regular.ttf"), Buffer.from("dummy-ghost"));

    const hwZip = storedZip([
      { name: "SourceHanSansHWSC-Regular.otf", data: Buffer.from("dummy-hw-regular") },
    ]);
    const sha = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");
    const manifest = {
      schema: "fontalloy/font-catalog@v1",
      families: [
        {
          family: "NotoSansSC", variant: "HW", file: "14_SourceHanSansHWSC.zip",
          version: "2.005R", upstream_url: "http://127.0.0.1:9/hw.zip", sha256: sha(hwZip),
        },
        {
          family: "NotoSansSC", variant: "Mono", file: "13_NotoSansMonoCJKsc.zip",
          version: "Sans2.004", upstream_url: "http://127.0.0.1:9/mono.zip", sha256: "0".repeat(64),
        },
        {
          family: "NotoSansSC", variant: "Variable", file: "NotoSansSC[wght].ttf",
          version: "test", upstream_url: "http://127.0.0.1:9/vf.ttf", sha256: sha(Buffer.from("dummy-vf")),
        },
        {
          family: "GhostFamily", variant: "NF", file: "GhostNF.zip",
          version: "test", upstream_url: "http://127.0.0.1:9/ghost.zip", sha256: "1".repeat(64),
        },
      ],
    };
    const manifestPath = join(root, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("hw.zip")) return new Response(new Uint8Array(hwZip), { status: 200 });
      return new Response("boom", { status: 500 });
    }) as typeof fetch;

    process.env.FONTALLOY_DEV_FONT_DIR = fontDir;
    process.env.FONTALLOY_DEV_CATALOG_CACHE = cacheDir;
    process.env.FONTALLOY_DEV_CATALOG_MANIFEST = manifestPath;
    try {
      const { devCatalogPlugin } = await freshPlugin("miss");
      let middleware: ((req: unknown, res: unknown, next: () => void) => Promise<void>) | null = null;
      devCatalogPlugin().configureServer({
        middlewares: { use: (fn: typeof middleware) => (middleware = fn) },
      });
      const doc = fakeRequest("/dev-catalog/catalog-release.json");
      await middleware!(doc.req as never, doc.handlerRes as never, () => {});
      expect(doc.captured.status).toBe(200);
      const release = JSON.parse(doc.captured.body.toString("utf8")) as {
        families: Array<{ family: string; files: Array<{ file: string }> }>;
      };
      const noto = release.families.find((f) => f.family === "NotoSansSC");
      // Variable (local) + HW (fetched); the failed Mono cut is simply
      // absent — the Mono chip will render 未下载.
      expect(noto!.files.map((f) => f.file).sort()).toEqual([
        "NotoSansSC[wght].ttf",
        "SourceHanSansHWSC-Regular.otf",
      ]);
      // GhostFamily has no face from any entry: an honest miss, not a
      // phantom row (its local file is unrelated to its pinned stem).
      expect(release.families.find((f) => f.family === "GhostFamily")).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.FONTALLOY_DEV_FONT_DIR;
      delete process.env.FONTALLOY_DEV_CATALOG_CACHE;
      delete process.env.FONTALLOY_DEV_CATALOG_MANIFEST;
      await rm(root, { recursive: true, force: true });
    }
  });
});

/* ---------- a minimal stored-zip builder (the artifact contract) ---------- */

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

/** A stored-format zip (the same shape the generator itself writes). */
function storedZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, entry.data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(entry.data.length, 20);
    cd.writeUInt32LE(entry.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + entry.data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

test("upstream fetch falls through the mirror origins until one answers (round 27)", async () => {
  const root = join(tmpdir(), `fontalloy-mirror-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const cacheDir = join(root, "cache");
  const zip = storedZip([
    { name: "FiraMonoNerdFont-Regular.ttf", data: Buffer.from("dummy-regular") },
    { name: "FiraMonoNerdFont-Bold.ttf", data: Buffer.from("dummy-bold") },
  ]);
  const sha = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");
  const manifest = {
    schema: "fontalloy/font-catalog@v1",
    families: [
      {
        family: "FiraMono",
        variant: "Nerd Font",
        file: "FiraMono.zip",
        version: "test",
        upstream_url: "https://github.com/test/fake/FiraMono.zip",
        sha256: sha(zip),
      },
    ],
  };
  const manifestPath = join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));

  // GitHub direct fails; the first mirror serves a WRONG hash; the
  // second mirror serves the right bytes. The artifact must land from
  // the second mirror — and the bad mirror's bytes must be rejected.
  const seen: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    seen.push(url);
    if (url === "https://github.com/test/fake/FiraMono.zip") {
      return new Response("gone", { status: 404 });
    }
    if (url === "https://mirror-a.test/https://github.com/test/fake/FiraMono.zip") {
      return new Response(new Uint8Array(Buffer.from("tampered")), { status: 200 });
    }
    if (url === "https://mirror-b.test/https://github.com/test/fake/FiraMono.zip") {
      return new Response(new Uint8Array(zip), { status: 200 });
    }
    return new Response("gone", { status: 404 });
  }) as typeof fetch;
  process.env.FONTALLOY_DEV_CATALOG_CACHE = cacheDir;
  process.env.FONTALLOY_DEV_CATALOG_MANIFEST = manifestPath;
  process.env.FONTALLOY_DEV_CATALOG_MIRRORS =
    "https://mirror-a.test/,https://mirror-b.test/";
  try {
    const { devCatalogPlugin } = await freshPlugin("mirror1");
    let middleware: ((req: unknown, res: unknown, next: () => void) => Promise<void>) | null = null;
    devCatalogPlugin().configureServer({
      middlewares: { use: (fn: typeof middleware) => (middleware = fn) },
    });
    const doc = fakeRequest("/dev-catalog/catalog-release.json");
    await middleware!(doc.req as never, doc.handlerRes as never, () => {});
    expect(doc.captured.status).toBe(200);
    const release = JSON.parse(doc.captured.body.toString("utf8")) as {
      families: Array<{ family: string; files: Array<{ file: string }> }>;
    };
    const family = release.families.find((f) => f.family === "FiraMono");
    expect(family).toBeDefined();
    // The FULL family served — both faces from the mirrored artifact.
    expect(family!.files.map((f) => f.file).sort()).toEqual([
      "FiraMonoNerdFont-Bold.ttf",
      "FiraMonoNerdFont-Regular.ttf",
    ]);
    // The origin chain ran in order: direct, mirror A, mirror B.
    expect(seen[0]).toBe("https://github.com/test/fake/FiraMono.zip");
    expect(seen[1]).toContain("mirror-a.test");
    expect(seen[2]).toContain("mirror-b.test");
    // The tampered mirror was NOT trusted: only after it failed did
    // the right mirror get fetched, and exactly once each.
    expect(seen.filter((u) => u.includes("mirror-a")).length).toBe(1);
    expect(seen.filter((u) => u.includes("mirror-b")).length).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.FONTALLOY_DEV_CATALOG_CACHE;
    delete process.env.FONTALLOY_DEV_CATALOG_MANIFEST;
    delete process.env.FONTALLOY_DEV_CATALOG_MIRRORS;
  }
});

test("a 7z artifact unpacks through the repo python and serves the family (round 27)", async () => {
  const root = join(tmpdir(), `fontalloy-sevenzip-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const cacheDir = join(root, "cache");
  // Build a REAL 7z artifact with two faces via the venv python.
  const artifact = join(root, "LxgwBrightCode.7z");
  const facesDir = join(root, "faces-src");
  await mkdir(facesDir, { recursive: true });
  await writeFile(join(facesDir, "LxgwBrightCodeNF-Regular.ttf"), Buffer.from("dummy-regular"));
  await writeFile(join(facesDir, "LxgwBrightCodeNF-Bold.ttf"), Buffer.from("dummy-bold"));
  const py = resolve(HERE, "../../.venv/Scripts/python.exe");
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(py, ["-c", "import py7zr, sys; py7zr.pack_7zarchive(sys.argv[1], sys.argv[2])", artifact.replace(/\.7z$/, ""), facesDir], {
      cwd: resolve(HERE, "../.."),
    });
    child.on("error", rejectRun);
    child.on("exit", (code) => (code === 0 ? resolveRun() : rejectRun(new Error(`py7zr exit ${code}`))));
  });
  const artifactBytes = await readFile(artifact);
  const sha = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");
  const manifest = {
    schema: "fontalloy/font-catalog@v1",
    families: [
      {
        family: "LxgwBrightCode",
        variant: "NF",
        file: "LxgwBrightCode.7z",
        version: "test",
        upstream_url: "https://github.com/test/fake/LxgwBrightCode.7z",
        sha256: sha(artifactBytes),
      },
    ],
  };
  const manifestPath = join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> =>
    new Response(new Uint8Array(artifactBytes), { status: 200 })) as typeof fetch;
  process.env.FONTALLOY_DEV_CATALOG_CACHE = cacheDir;
  process.env.FONTALLOY_DEV_CATALOG_MANIFEST = manifestPath;
  process.env.FONTALLOY_DEV_PYTHON = py;
  try {
    const { devCatalogPlugin } = await freshPlugin("sevenzip1");
    let middleware: ((req: unknown, res: unknown, next: () => void) => Promise<void>) | null = null;
    devCatalogPlugin().configureServer({
      middlewares: { use: (fn: typeof middleware) => (middleware = fn) },
    });
    const doc = fakeRequest("/dev-catalog/catalog-release.json");
    await middleware!(doc.req as never, doc.handlerRes as never, () => {});
    expect(doc.captured.status).toBe(200);
    const release = JSON.parse(doc.captured.body.toString("utf8")) as {
      families: Array<{ family: string; files: Array<{ file: string }> }>;
    };
    const family = release.families.find((f) => f.family === "LxgwBrightCode");
    expect(family).toBeDefined();
    expect(family!.files.map((f) => f.file).sort()).toEqual([
      "LxgwBrightCodeNF-Bold.ttf",
      "LxgwBrightCodeNF-Regular.ttf",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.FONTALLOY_DEV_CATALOG_CACHE;
    delete process.env.FONTALLOY_DEV_CATALOG_MANIFEST;
    delete process.env.FONTALLOY_DEV_PYTHON;
  }
});
