import { test, expect } from "@playwright/test";
import { rm } from "node:fs/promises";
import { collectJsErrors, fixtureFontPaths, pointerClick, waitForFontsReady } from "./helpers";
import { spawnServeOverFonts } from "./serve";
import { buildOwnerCatalogSite } from "./catalog-serve-site";

/**
 * The owner-scenario regression spec (ticket #30, formalizing the
 * round-30 diagnostic): the owner's real window baseline, pinned
 * against a serve-backed catalog built from the REAL repo manifest —
 *
 * - the EN picker lists 71 rows, the CJK picker 25 (the curated
 *   display data's own baseline over the manifest's families);
 * - every row self-renders through its serve preview subset (the
 *   renderer never holds font bytes);
 * - the page's catalog boot is OBSERVABLE: the sweep attribute
 *   (`data-catalog-sweep` = running/done on <html>), the fetch tap
 *   (no page-side release document, zip, or font-byte fetch — preview
 *   subset URLs only), and the zero-JS-errors capture;
 * - a pick drives the workspace through the existing registry path.
 */

test.setTimeout(300_000);

const [HOST_FONT] = fixtureFontPaths();

test("the owner's window: EN 71 rows / CJK 25, self-rendered, no page-side bytes", async ({
  page,
}) => {
  const jsErrors: string[] = [];
  collectJsErrors(page, jsErrors);
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));

  const site = await buildOwnerCatalogSite(HOST_FONT);
  const spawned = await spawnServeOverFonts(site.catalogDir, [
    "--catalog-release-origin",
    site.originUri,
    "--catalog-dir",
    site.catalogDir,
    "--manifest",
    site.manifestPath!,
  ]);
  try {
    await page.addInitScript((serve) => {
      (window as { __FONTALLOY_CONFIG__?: unknown }).__FONTALLOY_CONFIG__ = {
        serveUrl: serve,
      };
    }, await spawned.url);
    await page.goto("/");

    // Observability hook 1: the boot's sweep attribute settles.
    await page.waitForFunction(
      () => document.documentElement.dataset.catalogSweep === "done",
      undefined,
      { timeout: 240_000 },
    );
    await waitForFontsReady(page);

    // The baseline: the EN picker lists 71 rows, the CJK 25.
    await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
    const enPopup = page.locator('[data-picker-popup="en"]');
    await expect(enPopup.locator(".kit-fp")).toHaveCount(71, {
      timeout: 30_000,
    });
    await page.keyboard.press("Escape");
    await pointerClick(page, page.locator('[data-role="picker-cjk"] .kit-hd'));
    const cjkPopup = page.locator('[data-picker-popup="cjk"]');
    await expect(cjkPopup.locator(".kit-fp")).toHaveCount(25, {
      timeout: 30_000,
    });
    await page.keyboard.press("Escape");

    // Every row self-renders in its OWN preview-subset family: the EN
    // rows' name elements draw from 71 distinct font families.
    const distinct = await enPopup.evaluate((el) => {
      const families = new Set<string>();
      for (const row of el.querySelectorAll(".kit-fp")) {
        const name = row.querySelector(".kit-nm");
        if (!(name instanceof HTMLElement)) continue;
        const family = getComputedStyle(name).fontFamily;
        if (family && !family.includes("system-ui")) families.add(family);
      }
      return families.size;
    });
    expect(distinct).toBe(71);

    // Observability hook 2: the fetch tap — the page fetched NO release
    // document, no zip, no font bytes; the rows' preview subsets DID
    // flow from the serve.
    const banned = requests.filter((url) =>
      /catalog-release\.json|\.zip(?:$|\?)|\/catalog\/faces\//.test(url),
    );
    expect(banned, `page-side byte fetches: ${banned.join(", ")}`).toEqual([]);
    const previews = requests.filter((url) =>
      /\/catalog\/families\/[^/]+\/preview$/.test(url),
    );
    expect(previews.length).toBeGreaterThan(0);

    // A pick drives the workspace through the URL FontFace path
    // (ticket #32: the family's slot winners register by URL with
    // descriptors, no page-side bytes).
    await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
    await pointerClick(page, enPopup.locator(".kit-fp").first());
    await waitForFontsReady(page);
    await expect(
      page.locator("[data-role='font-pair'] [data-pair='base']"),
    ).not.toHaveText("");
    // Ticket #36: the pick's coverage intervals ride the family
    // document, so the script-region counters are real again (the
    // serve's resolve answers stay the coloring truth).
    await expect(page.locator("[data-stat='en']")).not.toHaveText("0");

    // Observability hook 3: the error capture — zero JS errors across
    // the whole scenario.
    expect(jsErrors).toEqual([]);
  } finally {
    await spawned.dispose();
    await rm(site.root, { recursive: true, force: true });
  }
});
