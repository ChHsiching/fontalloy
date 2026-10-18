import { test, expect, type Page, type Route } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { collectJsErrors, assertNoJsErrors, pointerClick } from "./helpers";
import { generateFonts, spawnServeOverFonts } from "./serve";
import {
  buildServeCatalogSite,
  type ServeCatalogSite,
} from "./catalog-serve-site";

/**
 * The J11.3 wedge regression (ticket #37 / spec #25, the heavy batch's
 * finding 2): every pick path used to await its default-slot font load
 * WITHOUT an abort budget — `document.fonts.load` rides the browser's
 * font loader, not the serve client, so a face endpoint that accepts
 * the connection and never answers parked the pick handler AND
 * `document.fonts.ready` forever at zero CPU (the exact shape of the
 * v1 batch's 25-minute J11.3 wedge, immune even to Playwright's test
 * timeout because the evaluate never settles).
 *
 * The seam here is deliberately tiny: a real serve-backed catalog over
 * ONE generated face, with the page's face-byte requests intercepted
 * by a route handler that NEVER responds. The client must fail loudly
 * within its budget (the config seam `testFontLoadBudgetMs` keeps the
 * proof fast) — the picker states the error, the pick does not land,
 * and `document.fonts.ready` settles afterwards (the stuck face was
 * evicted from the set instead of parking it for the page's life).
 */

/** The never-responding endpoint seam: swallow the request forever. */
function neverRespond(route: Route): void {
  // Intentionally no route.fulfill/abort: the request stays pending,
  // exactly a server that accepted the connection and went quiet.
  void route;
}

/** A bounded fonts.ready — the wedge itself must never wedge the test. */
async function fontsReadyWithin(page: Page, ms: number): Promise<void> {
  await Promise.race([
    page.evaluate(() => document.fonts.ready),
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              "document.fonts.ready never settled — a stuck-loading " +
                "FontFace is still parked on the set",
            ),
          ),
        ms,
      ),
    ),
  ]);
}

test.describe("the default-slot font-load abort budget", () => {
  test.setTimeout(60_000);

  test("a never-responding face endpoint fails the catalog pick loudly", async ({
    page,
  }) => {
    const jsErrors: string[] = [];
    collectJsErrors(page, jsErrors);

    const fontsDir = await mkdtemp(resolve(tmpdir(), "fontalloy-budget-"));
    const { base } = await generateFonts(fontsDir, { donorGlyphs: 200 });
    const site: ServeCatalogSite = await buildServeCatalogSite([
      { family: "AlloySans", faces: [{ file: "AlloySans-Regular.ttf", fontPath: base }] },
    ]);
    const spawned = await spawnServeOverFonts(site.catalogDir, [
      "--catalog-release-origin",
      site.originUri,
      "--catalog-dir",
      site.catalogDir,
      ...(site.manifestPath !== null
        ? ["--manifest", site.manifestPath]
        : []),
    ]);
    try {
      await page.addInitScript((serve) => {
        (window as { __FONTALLOY_CONFIG__?: unknown }).__FONTALLOY_CONFIG__ = {
          serveUrl: serve,
          // Fast budget: the proof is the failure, not the wait.
          testFontLoadBudgetMs: 1500,
        };
      }, await spawned.url);

      // The pick's default-slot byte fetch must never settle.
      await page.route("**/catalog/faces/**", neverRespond);

      await page.goto("/");
      await page.waitForFunction(
        () => document.documentElement.dataset.catalogSweep === "done",
        undefined,
        { timeout: 30_000 },
      );

      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      const popup = page.locator('[data-picker-popup="en"]');
      await expect(popup).toBeVisible();
      const row = popup.locator(".kit-fp").first();
      await expect(row).toBeVisible();
      await pointerClick(page, row);
      // The kit popup closes itself on every row pick (the pick lands
      // asynchronously); its error line is the surface a user reads on
      // REOPENING the picker.
      await expect(popup).toBeHidden();

      // The pick never landed: the pair tag stays empty (the honest
      // unpicked state — the picker card keeps 尚未加载字体).
      await expect(
        page.locator("[data-role='font-pair'] [data-pair='base']"),
      ).toHaveText("", { timeout: 15_000 });

      // FAILS LOUDLY within the budget: reopening the picker states
      // the timeout on its error line (the pick handler settled with
      // an error instead of hanging forever).
      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      await expect(popup).toBeVisible();
      const errorLine = popup.locator("[data-picker-error]");
      await expect(errorLine).toBeVisible({ timeout: 15_000 });
      await expect(errorLine).toContainText("无法载入目录字体");
      await expect(errorLine).toContainText("超时");

      // The wedge condition itself: fonts.ready settles after the
      // failed pick (the evicted face no longer parks the set).
      await fontsReadyWithin(page, 10_000);

      assertNoJsErrors(jsErrors);
    } finally {
      await spawned.dispose();
      await rm(site.root, { recursive: true, force: true });
      await rm(fontsDir, { recursive: true, force: true });
    }
  });

  test("a never-responding face endpoint fails the local upload pick loudly", async ({
    page,
  }) => {
    const jsErrors: string[] = [];
    collectJsErrors(page, jsErrors);

    const fontsDir = await mkdtemp(resolve(tmpdir(), "fontalloy-budget-"));
    const { base } = await generateFonts(fontsDir, { donorGlyphs: 200 });
    const spawned = await spawnServeOverFonts(fontsDir);
    try {
      await page.addInitScript((serve) => {
        (window as { __FONTALLOY_CONFIG__?: unknown }).__FONTALLOY_CONFIG__ = {
          serveUrl: serve,
          testFontLoadBudgetMs: 1500,
        };
      }, await spawned.url);

      // The uploaded face's byte source must never settle.
      await page.route("**/local-fonts/face**", neverRespond);

      await page.goto("/");
      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      const popup = page.locator('[data-picker-popup="en"]');
      await expect(popup).toBeVisible();
      await page
        .locator("input[data-role='font-file']")
        .setInputFiles(resolve(fontsDir, "base.ttf"));

      // The upload itself succeeds (its JSON answers); the pick's
      // default-slot load is what never settles. The failure surfaces
      // on the picker's error line within the budget.
      const errorLine = popup.locator("[data-picker-error]");
      await expect(errorLine).toBeVisible({ timeout: 15_000 });
      await expect(errorLine).toContainText("无法加载");
      await expect(errorLine).toContainText("超时");

      await fontsReadyWithin(page, 10_000);

      assertNoJsErrors(jsErrors);
    } finally {
      await spawned.dispose();
      await rm(fontsDir, { recursive: true, force: true });
    }
  });
});
