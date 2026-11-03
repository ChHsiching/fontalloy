import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createServer, type Server } from "node:http";
import {
  assertNoJsErrors,
  collectJsErrors,
  fixtureFontPaths,
  pointerClick,
  waitForFontsReady,
} from "./helpers";
import { generateNamedFace, generateWeightedFace, scanMeta, spawnServeOverFonts } from "./serve";
import {
  buildServeCatalogSite,
  type ServeCatalogSite,
  type SiteFamilySpec,
} from "./catalog-serve-site";

/**
 * The serve-backed catalog (ticket #30, spec #25): the page consumes
 * the serve's /catalog/status + /catalog/families — it never fetches
 * the release document, a zip, or any font byte itself. The serve is a
 * REAL `fontalloy serve` subprocess syncing a real file:// release
 * origin (see ./catalog-serve-site.ts); the page is pointed at it
 * through the injected serveUrl seam, never a test-only code path.
 *
 * Settle signal: the boot's own sweep attribute (`data-catalog-sweep`
 * on <html> reads "done" once the status state machine settled) and
 * the progress screen's DOM (its rows persist while hidden).
 */

const [FONT_A, FONT_B] = fixtureFontPaths();

/**
 * The name-table identity of a host font, read by the SERVE's own
 * fontTools scan (the specs' independent oracle since the frontend
 * parse mirror died — ticket #36).
 */
const parsedDisplayName = async (serve: string, path: string) =>
  (await scanMeta(serve, path)).display;

/** Three fake families over two host binaries. */
const FAMILY_SPECS: SiteFamilySpec[] = [
  { family: "AlloySans", faces: [{ file: "AlloySans-Regular.ttf", fontPath: FONT_A }] },
  { family: "AlloySerif", faces: [{ file: "AlloySerif-Regular.ttf", fontPath: FONT_B }] },
  { family: "AlloyMono", faces: [{ file: "AlloyMono-Regular.ttf", fontPath: FONT_A }] },
];

/** A serve-backed catalog: site + serve, disposed with the test. */
async function startCatalogServe(
  specs: SiteFamilySpec[],
  options: {
    manifest?: boolean;
    originUri?: string;
    env?: Record<string, string>;
  } = {},
): Promise<{
  site: ServeCatalogSite;
  url: string;
  dispose: () => Promise<void>;
}> {
  const site = await buildServeCatalogSite(specs, {
    manifest: options.manifest,
  });
  const spawned = await spawnServeOverFonts(
    site.catalogDir,
    [
      "--catalog-release-origin",
      options.originUri ?? site.originUri,
      "--catalog-dir",
      site.catalogDir,
      ...(site.manifestPath !== null
        ? ["--manifest", site.manifestPath]
        : []),
    ],
    { env: options.env },
  );
  return {
    site,
    url: await spawned.url,
    dispose: async () => {
      await spawned.dispose();
      await rm(site.root, { recursive: true, force: true });
    },
  };
}

/** Open the app wired to the serve (the injected serveUrl seam). */
async function openOnServe(page: Page, url: string): Promise<void> {
  await page.addInitScript((serve) => {
    (window as { __FONTALLOY_CONFIG__?: unknown }).__FONTALLOY_CONFIG__ = {
      serveUrl: serve,
    };
  }, url);
  await page.goto("/");
}

/** The first-run progress screen (its DOM persists while hidden). */
const screen = (page: Page) => page.locator(".catalog-screen");
const familyStatus = (page: Page, family: string) =>
  screen(page).locator(
    `.catalog-family[data-family='${family}'] .catalog-family-status`,
  );
const catalogTotal = (page: Page) =>
  screen(page).locator("[data-stat='catalog-total']");
const catalogDone = (page: Page) =>
  screen(page).locator("[data-stat='catalog-done']");
const enPopup = (page: Page) => page.locator('[data-picker-popup="en"]');
const cjkPopup = (page: Page) => page.locator('[data-picker-popup="cjk"]');
const catalogRow = (page: Page, name: string) =>
  enPopup(page).locator(".kit-fp", { hasText: name });
const pickerNote = (page: Page) => enPopup(page).locator("[data-picker-note]");
/** The boot's settle signal (the round-30 sweep attribute, formalized). */
const sweepDone = (page: Page) =>
  page.waitForFunction(
    () => document.documentElement.dataset.catalogSweep === "done",
    undefined,
    { timeout: 60_000 },
  );

/** The FontFace descriptors one css family carries, sorted. */
const faceInventory = (page: Page, cssFamily: string): Promise<string[]> =>
  page.evaluate((family) => {
    const normalize = (name: string): string =>
      name.length > 1 && name.startsWith('"') && name.endsWith('"')
        ? name.slice(1, -1)
        : name;
    return [...document.fonts]
      .filter((face) => normalize(face.family) === family)
      .map((face) => `${face.weight}/${face.style}`)
      .sort();
  }, cssFamily);

/** The serve-side per-family delay: an observably slow first sync. */
const SLOW_SYNC = { env: { FONTALLOY_CATALOG_SYNC_DELAY: "4" } };

/* ------------------------------------------------------------------ */
/* The gating counting origin (the cold-fixture determinism seam)      */
/* ------------------------------------------------------------------ */

/**
 * One release-once gate: a request that runs into it parks until the
 * test releases it — the phase determinism the sync-delay seam cannot
 * give (its sleep lands BETWEEN families; the document fetch and each
 * zip download are otherwise millisecond-fast).
 */
class Gate {
  private open = false;
  private waiters: Array<() => void> = [];
  /** Resolves once (and stays resolved — re-releases are no-ops). */
  readonly held: Promise<void> = new Promise((resolveHeld) => {
    const check = (): void => {
      if (this.open) resolveHeld();
      else this.waiters.push(check);
    };
    check();
  });
  release(): void {
    this.open = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }
}

/**
 * The journey-catalog-proof origin pattern, plus gates: serves a
 * built site's release document and family zips from an ephemeral
 * HTTP server (counting every byte-class request) and can HOLD the
 * document or any zip until the test releases it. `releaseAll` is the
 * always-safe drain for a finally block.
 */
class GatingOrigin {
  readonly requests = { document: 0, zips: 0 };
  private readonly server: Server;
  private readonly zips = new Map<string, Buffer>();
  private readonly zipGates = new Map<string, Gate>();
  private documentJson = "";
  // No gate until a test holds one: an ungated origin must serve the
  // document the moment it is asked (a fresh Gate is CLOSED — leaving
  // one here stalled the document fetch of every test that never
  // called holdDocument, and the screen sat on its seed rows).
  private documentGate: Gate | null = null;
  private boundPort = 0;

  private constructor(server: Server) {
    this.server = server;
  }

  static async over(originDir: string): Promise<GatingOrigin> {
    const instance = new GatingOrigin(
      createServer((req, res) => {
        void instance.handle(req, res);
      }),
    );
    await new Promise<void>((resolveReady) => {
      instance.server.listen(0, "127.0.0.1", () => resolveReady());
    });
    const address = instance.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("the gating origin did not bind");
    }
    instance.boundPort = address.port;
    const raw = JSON.parse(
      await readFile(resolve(originDir, "catalog-release.json"), "utf8"),
    ) as {
      origins: Array<{ id: string; base_url: string }>;
      families: Array<{ zip: string }>;
    };
    // Every origin onto THIS server, so the zips counted are the ones
    // the serve actually downloads.
    raw.origins = raw.origins.map((origin) => ({
      ...origin,
      base_url: instance.baseUrl,
    }));
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

  /** Hold the release document (phase one: "manifest unknown"). */
  holdDocument(): void {
    this.documentGate = new Gate();
  }

  releaseDocument(): void {
    this.documentGate?.release();
  }

  /** Hold every family zip (durable downloading/pending states). */
  holdAllZips(): void {
    for (const zip of this.zips.keys()) this.zipGates.set(zip, new Gate());
  }

  releaseZip(name: string): void {
    this.zipGates.get(name)?.release();
  }

  releaseAll(): void {
    this.documentGate?.release();
    for (const gate of this.zipGates.values()) gate.release();
  }

  private handle(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): void {
    const name = (req.url ?? "").replace(/^\/+/, "").split("?")[0]!;
    if (name === "catalog-release.json") {
      this.requests.document += 1;
      const gate = this.documentGate;
      const serve = (): void => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(this.documentJson);
      };
      if (gate === null) serve();
      else void gate.held.then(serve);
      return;
    }
    const zip = this.zips.get(name);
    if (zip !== undefined) {
      const gate = this.zipGates.get(name);
      const serve = (): void => {
        this.requests.zips += 1;
        res.writeHead(200, { "content-type": "application/zip" });
        res.end(zip);
      };
      if (gate === undefined) serve();
      else void gate.held.then(serve);
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

/** A gated cold fixture: site + gating origin, disposed with the test. */
async function buildGatedSite(
  specs: SiteFamilySpec[],
): Promise<{ site: ServeCatalogSite; origin: GatingOrigin }> {
  const site = await buildServeCatalogSite(specs);
  const origin = await GatingOrigin.over(resolve(site.root, "origin"));
  return { site, origin };
}

/** Spawn a serve over a (gated) site's own cold catalog dir. */
async function serveOverSite(
  site: ServeCatalogSite,
  origin: GatingOrigin,
  env?: Record<string, string>,
): Promise<{ url: string; dispose: () => Promise<void> }> {
  const spawned = await spawnServeOverFonts(
    site.catalogDir,
    [
      "--catalog-release-origin",
      origin.baseUrl,
      "--catalog-dir",
      site.catalogDir,
      ...(site.manifestPath !== null
        ? ["--manifest", site.manifestPath]
        : []),
    ],
    { env },
  );
  return { url: await spawned.url, dispose: () => spawned.dispose() };
}

/** The /catalog/status document, read the way a diagnostic would. */
async function statusOf(url: string): Promise<{
  state: string;
  configured: boolean;
  document?: string;
  warm?: boolean;
  families: Array<{ family: string; state: string; error: string | null }>;
}> {
  const response = await fetch(`${url}/catalog/status`);
  expect(response.status).toBe(200);
  return (await response.json()) as {
    state: string;
    configured: boolean;
    document?: string;
    warm?: boolean;
    families: Array<{ family: string; state: string; error: string | null }>;
  };
}

/** Poll a serve's status until the sync settles terminal. */
async function waitServeReady(url: string, timeout = 60_000): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const status = await statusOf(url);
    if (status.state === "ready") return;
    if (status.state === "unavailable") {
      throw new Error(`the catalog sync reported unavailable: ${status.families.map((f) => f.error).join("; ")}`);
    }
    if (Date.now() > deadline) throw new Error(`catalog sync still ${status.state}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * The seed count the screen lays while the manifest is unknown — read
 * from the repo's own data file, never a magic number. Counted by
 * UNIQUE family name: the manifest carries multi-variant entries under
 * one name (one row per family, like the release document it aligns
 * to), and the screen's row set is keyed by family name.
 */
async function seedFamilyCount(): Promise<number> {
  const raw = await readFile(
    resolve(process.cwd(), "src", "data", "catalog.json"),
    "utf8",
  );
  const families = (JSON.parse(raw).families as Array<{ family: string }>).map(
    (entry) => entry.family,
  );
  return new Set(families).size;
}

/** One sampled instant of the screen's observable progress surface. */
interface CatalogSample {
  done: number;
  total: number;
  /** The bar's fill fraction (0..1; 0 while indeterminate). */
  barFill: number;
  statuses: Record<string, string>;
}

const sampleCatalog = (page: Page): Promise<CatalogSample> =>
  page.evaluate(() => {
    const statuses: Record<string, string> = {};
    for (const row of document.querySelectorAll<HTMLElement>(
      ".catalog-family:not(.catalog-materializer)",
    )) {
      statuses[row.dataset.family ?? "?"] = row.dataset.status ?? "?";
    }
    const read = (stat: string): number =>
      Number(
        document
          .querySelector<HTMLElement>(`[data-stat='${stat}']`)
          ?.textContent?.replace(/\D/g, "") ?? "0",
      );
    const transform =
      document.querySelector<HTMLElement>(".catalog-bar i")?.style.transform ??
      "";
    return {
      done: read("catalog-done"),
      total: read("catalog-total"),
      barFill: Number(/scaleX\(([\d.]+)\)/.exec(transform)?.[1] ?? "0"),
      statuses,
    };
  });

/** The gated cold-fixture families (N=4: room for intermediate steps). */
const GATE_FAMILY_SPECS: SiteFamilySpec[] = [
  { family: "GateSans", faces: [{ file: "GateSans-Regular.ttf", fontPath: FONT_A }] },
  { family: "GateSerif", faces: [{ file: "GateSerif-Regular.ttf", fontPath: FONT_B }] },
  { family: "GateMono", faces: [{ file: "GateMono-Regular.ttf", fontPath: FONT_A }] },
  { family: "GateWide", faces: [{ file: "GateWide-Regular.ttf", fontPath: FONT_B }] },
];

test.describe("the serve-backed catalog", () => {
  // The slow-sync tests span a deliberately slowed full sync pass.
  test.setTimeout(90_000);

  test("first sync runs behind the status-driven screen with per-family progress, then settles", async ({
    page,
  }) => {
    const N = FAMILY_SPECS.length;
    const { site, origin } = await buildGatedSite(FAMILY_SPECS);
    // Every zip held from BEFORE the serve spawns: the sync thread
    // starts before the serve prints its startup line, so a hold
    // placed after the spawn races the first zip fetch (a millisecond
    // loopback zip wins more often than not). Held up front, the first
    // family parks IN downloading and the rest queue pending — the
    // states the walk passes through become durable, which the
    // per-family delay seam alone never gave (its sleep lands between
    // families; each small zip otherwise syncs inside one poll).
    origin.holdAllZips();
    const serve = await serveOverSite(site, origin, SLOW_SYNC.env);
    try {
      await openOnServe(page, serve.url);

      // The screen appears while the serve's sync runs, driven by its
      // per-family status document. The counter line and the bar exist
      // from the first visible sample (assertion C).
      await expect(screen(page)).toBeVisible({ timeout: 15_000 });
      await expect(screen(page).locator(".catalog-progress")).toContainText("已完成");
      await expect(screen(page).locator(".catalog-bar")).toBeAttached();

      // The held first family is downloading; the others queue behind
      // it — deterministic, not sampled luck.
      await expect(familyStatus(page, "AlloySans")).toHaveText("下载中", {
        timeout: 15_000,
      });
      await expect(familyStatus(page, "AlloyMono")).toHaveText("等待下载");

      // Assertion B: sample the whole run at a sub-poll cadence.
      const samples: CatalogSample[] = [];
      let samplerDone = false;
      const sampler = (async () => {
        while (!samplerDone) {
          samples.push(await sampleCatalog(page));
          await page.waitForTimeout(400);
        }
        samples.push(await sampleCatalog(page));
      })();

      // Skip dismisses the screen mid-run; downloads continue
      // serve-side and the workspace was alive underneath all along
      // (the rows persist while hidden — the sampler keeps reading
      // them).
      await pointerClick(page, screen(page).locator(".catalog-skip"));
      await expect(screen(page)).toBeHidden();
      await expect(page.locator(".workspace-rail")).toBeVisible();

      // Walk the families one by one: release a zip, watch the done
      // counter step, release the next — the monotone staircase.
      for (let index = 0; index < N; index += 1) {
        origin.releaseZip(`${FAMILY_SPECS[index]!.family}.zip`);
        await expect(catalogDone(page)).toHaveText(String(index + 1), {
          timeout: 30_000,
        });
      }
      await sweepDone(page);
      samplerDone = true;
      await sampler;

      // The state machine settles: ready, every family done, screen
      // closed by the status itself.
      for (const spec of FAMILY_SPECS) {
        await expect(familyStatus(page, spec.family)).toHaveText("已完成");
      }
      await expect(catalogTotal(page)).toHaveText(String(N));
      await expect(screen(page)).toBeHidden();
      await expect(pickerNote(page)).toBeHidden();

      // Assertion B on the samples: the done counter is monotone
      // non-decreasing and steps by at most one per sample (releases
      // are spaced far beyond the sampling cadence).
      expect(samples.length).toBeGreaterThan(2);
      for (let index = 1; index < samples.length; index += 1) {
        expect(samples[index]!.done).toBeGreaterThanOrEqual(
          samples[index - 1]!.done,
        );
        expect(samples[index]!.done - samples[index - 1]!.done).toBeLessThanOrEqual(1);
      }
      // At least two distinct intermediate samples (0 < done < N).
      const intermediates = new Set(
        samples
          .filter((sample) => sample.done > 0 && sample.done < N)
          .map((sample) => sample.done),
      );
      expect(intermediates.size).toBeGreaterThanOrEqual(2);
      // Some family was observed in an in-flight state text.
      expect(
        samples.some((sample) =>
          Object.values(sample.statuses).some(
            (state) =>
              state === "downloading" || state === "extracting" || state === "verifying",
          ),
        ),
        `no in-flight state observed in ${JSON.stringify(samples.map((s) => s.statuses))}`,
      ).toBe(true);
      // Assertion C: the terminal sample reads done === N and the
      // bar's fill fraction is monotone alongside the counter.
      expect(samples[samples.length - 1]!.done).toBe(N);
      for (let index = 1; index < samples.length; index += 1) {
        expect(samples[index]!.barFill).toBeGreaterThanOrEqual(
          samples[index - 1]!.barFill - 1e-9,
        );
      }
    } finally {
      origin.releaseAll();
      await serve.dispose();
      await origin.close();
      await rm(site.root, { recursive: true, force: true });
    }
  });

  test("the preset list: seed rows while the manifest is unknown, exact rows once loaded", async ({
    page,
  }) => {
    // Assertion A, two phases: with the release document HELD the page
    // must lay the seed list (114 未下载 rows — the repo's own data,
    // counted from the file), and the serve contract must say exactly
    // "manifest not known" (bootstrapping / fetching / [] / cold);
    // once the document flows (first zip still held) the status
    // families become the authoritative row set — the seed disappears.
    const N = GATE_FAMILY_SPECS.length;
    const seedCount = await seedFamilyCount();
    const { site, origin } = await buildGatedSite(GATE_FAMILY_SPECS);
    // Both gates up BEFORE the serve spawns (the sync thread starts
    // before the startup line; a hold placed after the spawn races the
    // document fetch, which a millisecond loopback round trip wins).
    origin.holdDocument();
    origin.holdAllZips();
    const serve = await serveOverSite(site, origin, SLOW_SYNC.env);
    try {
      await openOnServe(page, serve.url);

      // Phase one: the document is held — the manifest is unknown.
      await expect(screen(page)).toBeVisible({ timeout: 15_000 });
      await expect(screen(page)).toHaveAttribute("role", "dialog");
      await expect(screen(page)).toHaveAttribute(
        "aria-label",
        "首次运行：下载字体目录",
      );
      await expect(screen(page).locator(".catalog-family")).toHaveCount(
        seedCount,
      );
      await expect(
        screen(page).locator(".catalog-family[data-status='seed']"),
      ).toHaveCount(seedCount);
      await expect(
        screen(page).locator(".catalog-family[data-status='seed'] .catalog-family-status").first(),
      ).toHaveText("未下载");
      await expect(catalogTotal(page)).toHaveText(String(seedCount));
      await expect(catalogDone(page)).toHaveText("0");
      // The serve contract itself pins the []-means-unknown rule.
      const held = await statusOf(serve.url);
      expect(held.state).toBe("bootstrapping");
      expect(held.document).toBe("fetching");
      expect(held.families).toEqual([]);
      expect(held.warm).toBe(false);

      // Phase two: release the document (the first zip stays held).
      origin.releaseDocument();
      await expect(screen(page).locator(".catalog-family")).toHaveCount(N, {
        timeout: 15_000,
      });
      const listed = await screen(page)
        .locator(".catalog-family")
        .evaluateAll((rows) =>
          rows.map((row) => (row as HTMLElement).dataset.family ?? "?").sort(),
        );
      expect(listed).toEqual(
        GATE_FAMILY_SPECS.map((spec) => spec.family).sort(),
      );
      // The seed is gone: no row keeps the seed pseudo-state.
      await expect(
        screen(page).locator(".catalog-family[data-status='seed']"),
      ).toHaveCount(0);
      await expect(
        screen(page).locator(".catalog-family[data-status='pending']"),
      ).toHaveCount(N - 1);
      await expect(
        screen(page).locator(".catalog-family[data-status='downloading']"),
      ).toHaveCount(1);
      await expect(
        screen(page).locator(".catalog-family[data-status='pending'] .catalog-family-status").first(),
      ).toHaveText("等待下载");
      await expect(catalogTotal(page)).toHaveText(String(N));
      const flowed = await statusOf(serve.url);
      expect(flowed.document).toBe("loaded");
    } finally {
      origin.releaseAll();
      await serve.dispose();
      await origin.close();
      await rm(site.root, { recursive: true, force: true });
    }
  });

  test("a warm relaunch never shows the screen, settles fast, and re-downloads nothing", async ({
    page,
  }) => {
    // Assertion D(2): the SAME catalog dir, a second serve. The warm
    // classification (the serve's own stat walk passes for every
    // family) suppresses the first-run screen for the whole settle;
    // the sweep converges at its usual (stat-walk) pace; not one zip
    // is fetched again.
    const { site, origin } = await buildGatedSite(GATE_FAMILY_SPECS);
    const cold = await serveOverSite(site, origin);
    try {
      await waitServeReady(cold.url);
      expect(origin.requests.zips).toBe(GATE_FAMILY_SPECS.length);
      await cold.dispose();

      const warm = await serveOverSite(site, origin);
      try {
        // The warm answer must be on the serve BEFORE the page loads —
        // then every sample the page takes is suppressed.
        const deadline = Date.now() + 30_000;
        for (;;) {
          const status = await statusOf(warm.url);
          if (status.state === "ready" && status.warm === true) break;
          if (status.state === "unavailable") {
            throw new Error(`warm sync failed: ${JSON.stringify(status.families)}`);
          }
          if (Date.now() > deadline) {
            throw new Error(`warm sync never settled (state=${status.state} warm=${String(status.warm)})`);
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }

        // The sweep converges within a small bound (the stat-walk
        // pace of the CURRENT loop shape — 277-283 is unchanged).
        const startedAt = Date.now();
        await openOnServe(page, warm.url);
        // Sample through the settle: the screen must stay hidden at
        // every instant (the suppression is per-sample, not a race),
        // and the workspace is usable from the first sample.
        let settled = false;
        while (!settled) {
          await expect(screen(page)).toBeHidden();
          await expect(page.locator(".workspace-rail")).toBeVisible();
          settled = await page.evaluate(
            () => document.documentElement.dataset.catalogSweep === "done",
          );
          if (Date.now() - startedAt > 10_000) break;
          await page.waitForTimeout(300);
        }
        expect(settled, "the warm sweep did not settle within 10s").toBe(true);
        // The warm classification, read from the serve contract.
        const status = await statusOf(warm.url);
        expect(status.warm).toBe(true);
        // Zero re-download: the cold pass's zips are still the only
        // ones ever fetched (documents re-read are the cheap part).
        expect(origin.requests.zips).toBe(GATE_FAMILY_SPECS.length);
        expect(origin.requests.document).toBeGreaterThanOrEqual(2);
      } finally {
        await warm.dispose();
      }
    } finally {
      origin.releaseAll();
      await origin.close();
      await rm(site.root, { recursive: true, force: true });
    }
  });

  test("rows list from family documents, self-render via preview subsets, and search works", async ({
    page,
  }) => {
    const jsErrors: string[] = [];
    collectJsErrors(page, jsErrors);
    const { url, dispose } = await startCatalogServe(FAMILY_SPECS);
    const nameA = await parsedDisplayName(url, FONT_A);
    const nameB = await parsedDisplayName(url, FONT_B);
    try {
      await openOnServe(page, url);
      await sweepDone(page);
      await waitForFontsReady(page);

      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      // AlloySans and AlloyMono share the FONT_A binary: the family
      // DOCUMENTS still give each row its own identity, and each row
      // self-renders through its OWN preview subset family — the name
      // text reads the scanned name-table name.
      const sansRow = catalogRow(page, nameA).first();
      await expect(sansRow).toBeVisible();
      await expect(catalogRow(page, nameB)).toBeVisible();
      expect(await sansRow.getAttribute("aria-disabled")).toBeNull();

      // Self-rendering: the row's name element uses the family's own
      // preview subset css family (fa-cat-<family>), never the UI font.
      await expect
        .poll(async () =>
          sansRow
            .locator(".kit-nm")
            .evaluate((el) => getComputedStyle(el).fontFamily),
        )
        .toContain("fa-cat-AlloySans");
      await expect
        .poll(async () =>
          catalogRow(page, nameB)
            .locator(".kit-nm")
            .evaluate((el) => getComputedStyle(el).fontFamily),
        )
        .toContain("fa-cat-AlloySerif");

      // Search filters across the rows (family ids ride the keywords).
      const search = enPopup(page).locator(".kit-q");
      await search.fill("Serif");
      await expect(catalogRow(page, nameA)).toHaveCount(0);
      await expect(catalogRow(page, nameB)).toBeVisible();
      await search.fill("");
      await expect(catalogRow(page, nameA).first()).toBeVisible();

      // The local-file footer stays outside the scroll area.
      await expect(enPopup(page).locator(".kit-fpsys")).toContainText(
        "加载本地字体文件",
      );
      assertNoJsErrors(jsErrors);
    } finally {
      await dispose();
    }
  });

  test("the page never fetches the release document, zips, or font bytes", async ({
    page,
  }) => {
    // The round-30 fetch tap, formalized: every request the page makes
    // is recorded; none may touch the release pipeline's byte classes.
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    const { url, dispose } = await startCatalogServe(FAMILY_SPECS);
    try {
      await openOnServe(page, url);
      await sweepDone(page);
      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      await expect(
        catalogRow(page, await parsedDisplayName(url, FONT_A)).first(),
      ).toBeVisible();
      await page.waitForTimeout(500); // let the preview subsets land

      const banned = requests.filter((requested) =>
        /catalog-release\.json|\.zip(?:$|\?)|\/catalog\/faces\//.test(requested),
      );
      expect(banned, `page-side byte fetches: ${banned.join(", ")}`).toEqual([]);
      const previews = requests.filter((requested) =>
        /\/catalog\/families\/[^/]+\/preview$/.test(requested),
      );
      expect(previews.length).toBeGreaterThan(0);
    } finally {
      await dispose();
    }
  });

  test("selecting a catalog font registers it by URL and drives the workspace", async ({
    page,
  }) => {
    const jsErrors: string[] = [];
    collectJsErrors(page, jsErrors);
    const { url, dispose } = await startCatalogServe(FAMILY_SPECS);
    const nameB = await parsedDisplayName(url, FONT_B);
    try {
      await openOnServe(page, url);
      await sweepDone(page);

      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      await pointerClick(page, catalogRow(page, nameB));
      await waitForFontsReady(page);

      // Ticket #32 (the MEMORY RED LINE): the pick registered the
      // cut's slot winners as URL FontFaces under the MANIFEST family
      // id with their descriptors — never a byte in the page — and
      // every identity surface still reads the scanned name-table
      // name from the family document.
      await expect(
        page.locator('[data-role="picker-en"] .kit-hd b'),
      ).toHaveText(nameB);
      await expect(
        page.locator("[data-role='font-pair'] [data-pair='base']"),
      ).toHaveText(nameB);
      const loaded = await page.evaluate(() => ({
        face: document.fonts.check(`16px "AlloySerif"`, "A"),
        weight: [...document.fonts]
          .filter((f) => f.family === "AlloySerif")
          .map((f) => `${f.weight}/${f.style}`),
      }));
      expect(loaded.face).toBe(true);
      expect(loaded.weight).toEqual(["400/normal"]);
      // Ticket #36: the pick's coverage intervals ride the family
      // document, so the script-region counters are REAL again (the
      // serve's resolve answers stay the coloring truth — #35).
      await expect(page.locator("[data-stat='en']")).not.toHaveText("0");
      assertNoJsErrors(jsErrors);
    } finally {
      await dispose();
    }
  });

  test("a failed family lands the serve's verbatim error in the footer; others stay pickable", async ({
    page,
  }) => {
    const { url, dispose } = await startCatalogServe(
      FAMILY_SPECS.map((spec) =>
        spec.family === "AlloyMono" ? { ...spec, corruptZipSha: true } : spec,
      ),
      SLOW_SYNC,
    );
    try {
      await openOnServe(page, url);
      await sweepDone(page);
      await expect(screen(page)).toBeHidden();

      // The serve's own error string, VERBATIM, in the picker footer.
      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      await expect(pickerNote(page)).toContainText("AlloyMono");
      await expect(pickerNote(page)).toContainText("1 of 3");

      // The failed family's row states itself and stays disabled; the
      // healthy families are pickable rows. The failed family was
      // never scanned, so its row keeps the document's own label
      // (the artifact stem) — not the host font's name.
      const mono = enPopup(page)
        .locator(".kit-fp[aria-disabled='true']")
        .filter({ hasText: "AlloyMono" });
      await expect(mono).toHaveCount(1);
      await expect(mono.locator(".kit-fp-note")).toContainText("同步失败");
      const sans = enPopup(page)
        .locator(".kit-fp:not([aria-disabled='true'])")
        .filter({ hasText: await parsedDisplayName(url, FONT_A) });
      await expect(sans).toHaveCount(1);
      await expect(sans.locator(".kit-fp-note")).toHaveCount(0);
    } finally {
      await dispose();
    }
  });

  test("an unreachable release origin: verbatim error, no blocking, local fonts unaffected", async ({
    page,
  }) => {
    const { url, dispose } = await startCatalogServe(FAMILY_SPECS, {
      originUri: "file:///nowhere-at-all",
    });
    try {
      await openOnServe(page, url);
      await sweepDone(page);
      await expect(screen(page)).toBeHidden();

      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      await expect(pickerNote(page)).toContainText("catalog release document");
      await expect(catalogRow(page, "AlloySans")).toHaveCount(0);

      // Local files work exactly as before the catalog existed.
      await page.locator("input[data-role='font-file']").setInputFiles(FONT_A);
      await waitForFontsReady(page);
      await expect(enPopup(page)).toBeHidden();
      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      await expect(enPopup(page).locator(".kit-fp")).toHaveCount(1);
    } finally {
      await dispose();
    }
  });

  test("variant chips resolve the cut's own representative from the serve document", async ({
    page,
  }) => {
    // A multi-cut family (Standard + NF, the icons axis) over two named
    // faces: each chip pick loads ITS OWN cut's representative — the NF
    // chip's face is the NF-named binary, not the plain one.
    const root = await mkdtemp(resolve(tmpdir(), "fontalloy-cuts-"));
    let disposeServe: (() => Promise<void>) | null = null;
    try {
      const plain = await generateNamedFace(root, "UDEV Plain", "UDEVGothic");
      const nf = await generateNamedFace(root, "UDEV NF Cut", "UDEVGothicNF");
      const site = await buildServeCatalogSite(
        [
          {
            family: "UDEVGothic",
            faces: [
              { file: "UDEVGothic-Regular.ttf", fontPath: plain },
              { file: "UDEVGothicNF-Regular.ttf", fontPath: nf },
            ],
            manifestEntries: [
              { variant: "Standard", file: "UDEVGothic.zip" },
              { variant: "NF", file: "UDEVGothic_NF.zip", axes: { icons: "nf" } },
            ],
          },
        ],
        { manifest: true },
      );
      const spawned = await spawnServeOverFonts(
        site.catalogDir,
        [
          "--catalog-release-origin",
          site.originUri,
          "--catalog-dir",
          site.catalogDir,
          "--manifest",
          site.manifestPath!,
        ],
      );
      disposeServe = async () => {
        await spawned.dispose();
        await rm(site.root, { recursive: true, force: true });
      };
      await openOnServe(page, await spawned.url);
      await sweepDone(page);

      await pointerClick(page, page.locator('[data-role="picker-cjk"] .kit-hd'));
      const row = cjkPopup(page)
        .locator(".kit-fp")
        .filter({
          has: page.locator(".kit-vchip[data-chip='UDEVGothic::NF']"),
        });
      await expect(row).toHaveCount(1);
      await expect(row.locator(".kit-vchip")).toHaveCount(2);
      // Clicking the NF chip loads the NF cut's own face.
      await pointerClick(page, row.locator(".kit-vchip[data-chip='UDEVGothic::NF']"));
      await waitForFontsReady(page);
      await expect(
        page.locator("[data-role='font-pair'] [data-pair='donor']"),
      ).toHaveText("UDEV NF Cut");
      // Reverting to the default cut loads the plain face.
      await pointerClick(page, row.locator(".kit-vchip[data-chip='UDEVGothic::Standard']"));
      await waitForFontsReady(page);
      await expect(
        page.locator("[data-role='font-pair'] [data-pair='donor']"),
      ).toHaveText("UDEV Plain");
    } finally {
      await disposeServe?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("switching cuts evicts the prior cut's FontFaces under the family", async ({
    page,
  }) => {
    // Spec #25 review P2-4: every cut of a family registers under the
    // SAME css family. Switching cuts replaces the registry record but
    // left the prior cut's FontFaces on document.fonts — both cuts'
    // slots stayed live under one family, so the browser kept matching
    // the stale cut. After a switch the face inventory must be EXACTLY
    // the new cut's slot winners.
    const root = await mkdtemp(resolve(tmpdir(), "fontalloy-cutswitch-"));
    let disposeServe: (() => Promise<void>) | null = null;
    try {
      const plain = await generateWeightedFace(
        root,
        "Cut Switch Plain",
        "CutSwitch",
        400,
      );
      const nf = await generateWeightedFace(
        root,
        "Cut Switch NF",
        "CutSwitchNF",
        700,
        "Bold",
      );
      const site = await buildServeCatalogSite(
        [
          {
            family: "CutSwitch",
            faces: [
              { file: "CutSwitch-Regular.ttf", fontPath: plain },
              { file: "CutSwitchNF-Bold.ttf", fontPath: nf },
            ],
            manifestEntries: [
              { variant: "Standard", file: "CutSwitch.zip" },
              { variant: "NF", file: "CutSwitch_NF.zip", axes: { icons: "nf" } },
            ],
          },
        ],
        { manifest: true },
      );
      const spawned = await spawnServeOverFonts(
        site.catalogDir,
        [
          "--catalog-release-origin",
          site.originUri,
          "--catalog-dir",
          site.catalogDir,
          "--manifest",
          site.manifestPath!,
        ],
      );
      disposeServe = async () => {
        await spawned.dispose();
        await rm(site.root, { recursive: true, force: true });
      };
      await openOnServe(page, await spawned.url);
      await sweepDone(page);

      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      const row = enPopup(page)
        .locator(".kit-fp")
        .filter({
          has: page.locator(".kit-vchip[data-chip='CutSwitch::NF']"),
        });
      await expect(row).toHaveCount(1);

      // Cut A (Standard): one 400/normal face under the family.
      await pointerClick(
        page,
        row.locator(".kit-vchip[data-chip='CutSwitch::Standard']"),
      );
      await waitForFontsReady(page);
      expect(await faceInventory(page, "CutSwitch")).toEqual(["400/normal"]);

      // Cut B (NF): exactly B's inventory — the 700/normal Bold, with
      // A's 400/normal face evicted, not piled on top of.
      await pointerClick(
        page,
        row.locator(".kit-vchip[data-chip='CutSwitch::NF']"),
      );
      await waitForFontsReady(page);
      expect(await faceInventory(page, "CutSwitch")).toEqual(["700/normal"]);
    } finally {
      await disposeServe?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a sidecar that never comes up: the honest timeout state, screen closed, footer carries the reason", async ({
    page,
  }) => {
    // The e2e seam of the desktop cold start (synthesize.ts documents
    // the faked Tauri marker): a __TAURI_INTERNALS__ with NOTHING
    // injected (serveUrl undefined — the triple gate's own case) and a
    // serve_url command that answers null after a beat — the shell's
    // 120 s timeout in miniature. The connecting screen appears FIRST
    // (its OWN label, never the download copy), then the honest
    // failure: the screen closes, the catalog lands unavailable, and
    // the picker footer carries the shared copy verbatim. The journey
    // suites' injected-null pages (?noservice=1 → serveUrl null) are
    // the OTHER null source and stay exactly as before — this test
    // pins each side of the split once.
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      w.__TAURI_INTERNALS__ = {
        invoke: (cmd: string): unknown => {
          if (cmd === "serve_url") {
            // A beat, so the connecting screen is observably there
            // before the null lands.
            return new Promise((resolve) =>
              setTimeout(() => resolve(null), 600),
            );
          }
          return Promise.reject(new Error(`fake shell: ${cmd}`));
        },
      };
    });
    await page.goto("/");

    // The connecting variant: visible, its own label, the
    // indeterminate bar (nothing is countable yet).
    await expect(screen(page)).toBeVisible({ timeout: 10_000 });
    await expect(screen(page)).toHaveAttribute("aria-label", "正在启动字体服务");
    await expect(screen(page).locator(".catalog-sub")).toBeVisible();
    await expect(screen(page).locator(".catalog-bar")).toBeVisible();

    // The null lands: never stuck on 正在启动字体服务 — the screen
    // closes and the workspace stays alive underneath.
    await expect(screen(page)).toBeHidden({ timeout: 15_000 });
    await expect(page.locator(".workspace-rail")).toBeVisible();

    // The failure surface is the existing picker footer branch: the
    // shared copy, verbatim (no new dialog variant).
    await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
    await expect(pickerNote(page)).toContainText("字体服务未能启动");
    await expect(pickerNote(page)).toContainText("本地字体不受影响");
    await expect(screen(page)).toBeHidden();
  });

  test("a manifest-less serve still lists release-only families", async ({
    page,
  }) => {
    const { url, dispose } = await startCatalogServe(FAMILY_SPECS, {
      manifest: false,
    });
    try {
      const nameA = await parsedDisplayName(url, FONT_A);
      const nameB = await parsedDisplayName(url, FONT_B);
      await openOnServe(page, url);
      await sweepDone(page);
      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      await expect(catalogRow(page, nameA).first()).toBeVisible();
      await expect(catalogRow(page, nameB)).toBeVisible();
      // Release-only families carry no manifest entries: plain rows,
      // no chips.
      await expect(catalogRow(page, nameA).first().locator(".kit-vchip")).toHaveCount(0);
    } finally {
      await dispose();
    }
  });
});
