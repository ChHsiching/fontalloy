import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { generateFonts, spawnServeOverFonts } from "./serve";
import { buildServeCatalogSite } from "./catalog-serve-site";
import { journeyCatalogFlags, journeyServeCatalogDir } from "./journey-catalog";

/**
 * The shared-catalog harness proof (ticket #37 / spec #25, the heavy
 * batch's finding 1), at TINY fixture scale: a fake catalog origin
 * that COUNTS its downloads, and N serves spawned the way the journey
 * suites spawn them (sequentially, each disposed as a test ends).
 *
 * The contract under proof: every journey serve rides ONE stable,
 * gitignored scratch dir (`journeyServeCatalogDir`), so the FIRST
 * serve pays the family sync and every later serve starts warm (the
 * sync's stat-only launch check) — ONE download across the run, not
 * one per test. The counter-example is pinned too: a fresh per-serve
 * dir (the pre-fix harness shape) re-downloads the whole catalog every
 * spawn — the v1 batch's ~8GB × N cost amplification in miniature.
 *
 * The proof uses its OWN scratch name so it never evicts a real
 * journey run's warm catalog.
 */

/** The proof's scratch name — never the real journeys' dir. */
const PROOF_NAME = "journey-catalog-proof";

/** The counting origin: the release document + zips, with a tally. */
class CountingOrigin {
  readonly requests = { document: 0, zips: 0 };
  private readonly server: Server;
  private readonly zips = new Map<string, Buffer>();
  private documentJson = "";
  private boundPort = 0;

  private constructor(server: Server) {
    this.server = server;
  }

  static async over(originDir: string): Promise<CountingOrigin> {
    const instance = new CountingOrigin(
      createServer((req, res) => instance.handle(req, res)),
    );
    await new Promise<void>((resolveReady) => {
      instance.server.listen(0, "127.0.0.1", () => resolveReady());
    });
    const address = instance.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("the counting origin did not bind");
    }
    instance.boundPort = address.port;
    // Rewrite the document's origin list onto THIS server, so the
    // family zip downloads (the expensive part) are the ones counted.
    const raw = JSON.parse(
      await readFile(resolve(originDir, "catalog-release.json"), "utf8"),
    ) as {
      origins: Array<{ id: string; base_url: string }>;
      families: Array<{ zip: string }>;
    };
    raw.origins = [
      { id: "primary", base_url: instance.baseUrl },
      ...raw.origins.slice(1).map((origin) => ({
        ...origin,
        base_url: instance.baseUrl,
      })),
    ];
    instance.documentJson = JSON.stringify(raw);
    for (const family of raw.families) {
      instance.zips.set(
        family.zip,
        await readFile(resolve(originDir, family.zip)),
      );
    }
    return instance;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.boundPort}`;
  }

  private handle(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): void {
    const name = (req.url ?? "").replace(/^\/+/, "").split("?")[0]!;
    if (name === "catalog-release.json") {
      this.requests.document += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(this.documentJson);
      return;
    }
    const zip = this.zips.get(name);
    if (zip !== undefined) {
      this.requests.zips += 1;
      res.writeHead(200, { "content-type": "application/zip" });
      res.end(zip);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  }

  async close(): Promise<void> {
    await new Promise<void>((resolveClosed) =>
      this.server.close(() => resolveClosed()),
    );
  }
}

/** Poll /catalog/status until the sync state machine settles ready. */
async function waitCatalogReady(url: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const status = (await (await fetch(`${url}/catalog/status`)).json()) as {
      state: string;
      configured: boolean;
      families: Array<{ family: string; state: string }>;
    };
    expect(status.configured).toBe(true);
    if (status.state === "ready") {
      expect(status.families.map((f) => f.state)).toEqual(["done"]);
      return;
    }
    if (status.state === "unavailable") {
      const document = (await (
        await fetch(`${url}/catalog/status`)
      ).json()) as { error: string | null };
      throw new Error(
        `the catalog sync reported unavailable: ${document.error ?? "?"}`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(`catalog sync still ${status.state} after 60s`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

test.describe.serial("the journey run's shared serve catalog", () => {
  test.setTimeout(120_000);

  let origin!: CountingOrigin;
  let siteRoot!: string;
  let fontsDir!: string;

  test.beforeAll(async () => {
    fontsDir = await mkdtemp(resolve(tmpdir(), "fontalloy-jcat-proof-"));
    const { base } = await generateFonts(fontsDir, { donorGlyphs: 200 });
    const site = await buildServeCatalogSite([
      {
        family: "AlloySans",
        faces: [{ file: "AlloySans-Regular.ttf", fontPath: base }],
      },
    ]);
    siteRoot = site.root;
    origin = await CountingOrigin.over(resolve(siteRoot, "origin"));
    // A hermetic cold start for the proof's OWN dir.
    await rm(await journeyServeCatalogDir(PROOF_NAME), {
      recursive: true,
      force: true,
    });
  });

  test.afterAll(async () => {
    await origin?.close();
    await rm(siteRoot, { recursive: true, force: true });
    await rm(fontsDir, { recursive: true, force: true });
  });

  test("the FIRST serve over the shared dir pays the sync exactly once", async () => {
    const service = await spawnServeOverFonts(resolve(siteRoot, "catalog"), [
      ...(await journeyCatalogFlags(origin.baseUrl, PROOF_NAME)),
    ]);
    try {
      await waitCatalogReady(await service.url);
    } finally {
      await service.dispose();
    }
    expect(origin.requests.zips).toBe(1);
  });

  test("every LATER serve reuses it — no re-download across tests", async () => {
    const service = await spawnServeOverFonts(resolve(siteRoot, "catalog"), [
      ...(await journeyCatalogFlags(origin.baseUrl, PROOF_NAME)),
    ]);
    try {
      await waitCatalogReady(await service.url);
    } finally {
      await service.dispose();
    }
    // The one download of the run; the document re-read is the cheap
    // part (a stat-only warm start still refreshes the release doc).
    expect(origin.requests.zips).toBe(1);
    expect(origin.requests.document).toBeGreaterThanOrEqual(2);
  });

  test("the hazard pinned: a fresh per-serve dir re-downloads everything", async () => {
    // The pre-fix harness shape (a per-test temp catalog dir): every
    // spawn cold-syncs the whole catalog again.
    const freshDir = await mkdtemp(resolve(tmpdir(), "fontalloy-per-serve-"));
    const service = await spawnServeOverFonts(resolve(siteRoot, "catalog"), [
      "--catalog-release-origin",
      origin.baseUrl,
      "--catalog-dir",
      freshDir,
    ]);
    try {
      await waitCatalogReady(await service.url);
    } finally {
      await service.dispose();
    }
    expect(origin.requests.zips).toBe(2);
    const faces = await readdir(freshDir, { recursive: true });
    expect(faces.length).toBeGreaterThan(0);
    await rm(freshDir, { recursive: true, force: true });
  });
});
