import { test, expect, type Page } from "@playwright/test";
import { statSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  assertNoJsErrors,
  collectJsErrors,
  pointerClick,
  waitForFontsReady,
} from "./helpers";
import { generateNamedFace, scanMeta, spawnServeOverFonts } from "./serve";
import { buildServeCatalogSite } from "./catalog-serve-site";

/** Suite-scoped serve over two generated families (ticket #36: the
 * browser file-input loads ride the serve's upload endpoint now). */
let serveUrl = "";
let font1 = "";
let font2 = "";
let disposeServe: (() => Promise<void>) | null = null;

/** Two catalog families are enough for the screenshot states. */
const SHOT_FAMILY_SPECS = (fontA: string, fontB: string) => [
  {
    family: "Alloy Sans",
    faces: [{ file: "AlloySans-Regular.ttf", fontPath: fontA, deflate: true }],
  },
  {
    family: "Alloy Serif",
    faces: [{ file: "AlloySerif-Regular.ttf", fontPath: fontB }],
  },
];

/**
 * Screenshot scenario (seam 3): captures must include OPEN-OVERLAY states,
 * never just the resting UI. Screenshots land in test-results/screenshots/.
 */
test.describe("screenshots with open overlays", () => {
  const jsErrors: string[] = [];

  /** This describe's serve over two generated families. */
  let serveUrl = "";
  let font1 = "";
  let font2 = "";
  let disposeServe: (() => Promise<void>) | null = null;

  test.beforeAll(async () => {
    const root = await mkdtemp(resolve(tmpdir(), "fontalloy-shots-"));
    const [alpha, beta] = await Promise.all([
      generateNamedFace(root, "Alloy Shot A", "AlloyShotA"),
      generateNamedFace(root, "Alloy Shot B", "AlloyShotB"),
    ]);
    font1 = alpha;
    font2 = beta;
    const spawned = await spawnServeOverFonts(root);
    disposeServe = async () => {
      await spawned.dispose();
      await rm(root, { recursive: true, force: true });
    };
    serveUrl = await spawned.url;
  });

  test.afterAll(async () => {
    await disposeServe?.();
  });

  async function openWorkspace(page: Page): Promise<void> {
    await page.addInitScript((serve: string) => {
      (window as { __FONTALLOY_CONFIG__?: unknown }).__FONTALLOY_CONFIG__ = {
        serveUrl: serve,
      };
    }, serveUrl);
    await page.goto("/");
    await waitForFontsReady(page);
  }

  test.beforeEach(async ({ page }) => {
    jsErrors.length = 0;
    collectJsErrors(page, jsErrors);
    await openWorkspace(page);
  });

  test.afterEach(() => assertNoJsErrors(jsErrors));

  test("workspace with fonts loaded and a picker popup open", async ({
    page,
  }) => {

    // Load two local fonts and select them for the pair.
    await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
    const popup = page.locator('[data-picker-popup="en"]');
    await page
      .locator("input[data-role='font-file']")
      .setInputFiles([font1, font2]);
    await waitForFontsReady(page);
    await page.keyboard.press("Escape");

    // Pick a CJK block so the grid shows real glyphs, select a cell, then
    // reopen the EN picker so the overlay state is captured.
    await pointerClick(page, page.locator(".kit-cat-g[data-group='cjk']"));
    await pointerClick(
      page,
      page.locator(".kit-cat-s[data-block='cjk-unified']"),
    );
    await pointerClick(page, page.locator(".charmap-grid .kit-cell[data-cp='U+4E2D']"));
    // The click opened the char popup at the cell — close it before the
    // picker overlay shot (one overlay at a time, like a real user).
    await page.keyboard.press("Escape");

    await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
    await expect(popup).toBeVisible();
    await page.waitForTimeout(250); // let the discrete open transition settle

    const dir = join(process.cwd(), "test-results", "screenshots");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "workspace-picker-open.png");
    await page.screenshot({ path });

    const size = statSync(path).size;
    expect(size).toBeGreaterThan(10_000); // a real rendering, not a blank frame
  });
});

test.describe("screenshots of the catalog overlays", () => {
  const jsErrors: string[] = [];

  /** This describe's own fixture pair (generated per describe). */
  let font1 = "";
  let font2 = "";
  let scratchRoot = "";

  test.beforeAll(async () => {
    const root = await mkdtemp(resolve(tmpdir(), "fontalloy-shots2-"));
    scratchRoot = root;
    const [alpha, beta] = await Promise.all([
      generateNamedFace(root, "Alloy Shot A", "AlloyShotA"),
      generateNamedFace(root, "Alloy Shot B", "AlloyShotB"),
    ]);
    font1 = alpha;
    font2 = beta;
  });

  test.afterAll(async () => {
    if (scratchRoot !== "") {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });

  test.beforeEach(async ({ page }) => {
    jsErrors.length = 0;
    collectJsErrors(page, jsErrors);
    // These pages configure a catalog, so the live stars refresh fires
    // (round 5); keep it hermetic and quiet (see catalog.spec too).
    await page.route("https://api.github.com/repos/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{}",
      }),
    );
  });

  test.afterEach(() => assertNoJsErrors(jsErrors));

  test("first-run sync screen mid-sync, then the picker over catalog rows", async ({
    page,
  }) => {
    // Ticket #30's boot: the first-run screen is the SERVE's sync
    // progress. A per-family delay seam holds the run mid-sync for the
    // capture; the picker then lists the serve's family documents.
    const site = await buildServeCatalogSite(SHOT_FAMILY_SPECS(font1, font2), {
      manifest: true,
    });
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
      { env: { FONTALLOY_CATALOG_SYNC_DELAY: "4" } },
    );
    try {
      await page.addInitScript((serve: string) => {
        (window as { __FONTALLOY_CONFIG__?: unknown }).__FONTALLOY_CONFIG__ =
          { serveUrl: serve };
      }, await spawned.url);
      await page.goto("/");

      const screen = page.locator(".catalog-screen");
      await expect(screen).toBeVisible();
      await expect(
        screen.locator("[data-stat='catalog-done']"),
      ).not.toHaveText("2", { timeout: 10_000 });
      await page.waitForTimeout(250); // let the panel settle visually

      const dir = join(process.cwd(), "test-results", "screenshots");
      mkdirSync(dir, { recursive: true });
      const firstRunPath = join(dir, "catalog-first-run-progress.png");
      await page.screenshot({ path: firstRunPath });
      expect(statSync(firstRunPath).size).toBeGreaterThan(10_000);

      await expect(screen).toBeHidden({ timeout: 60_000 });
      await expect(
        screen.locator("[data-stat='catalog-done']"),
      ).toHaveText("2", { timeout: 30_000 });

      // Second overlay state: the picker listing catalog families, open
      // (the row reads the font's own scanned name — round 9; the
      // serve's scan is the name oracle since the parse mirror died).
      const font1Name = (await scanMeta(await spawned.url, font1)).display;
      await page.waitForFunction(
        () => document.documentElement.dataset.catalogSweep === "done",
        undefined,
        { timeout: 60_000 },
      );
      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      const row = page
        .locator('[data-picker-popup="en"]')
        .locator(".kit-fp", { hasText: font1Name });
      await expect(row).toBeVisible();
      await expect
        .poll(() => row.evaluate((el) => getComputedStyle(el).fontFamily))
        .not.toBe("");
      await page.waitForTimeout(250); // open transition settled
      const pickerPath = join(dir, "catalog-picker-open.png");
      await page.screenshot({ path: pickerPath });
      expect(statSync(pickerPath).size).toBeGreaterThan(10_000);
    } finally {
      await spawned.dispose();
      const { rm } = await import("node:fs/promises");
      await rm(site.root, { recursive: true, force: true });
    }
  });
});
