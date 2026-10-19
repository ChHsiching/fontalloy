import { test, expect, type Page } from "@playwright/test";
import { rm } from "node:fs/promises";
import {
  assertNoJsErrors,
  collectJsErrors,
  fixtureFontPaths,
  pointerClick,
  waitForFontsReady,
} from "./helpers";
import { scanMeta, spawnServeOverFonts } from "./serve";
import {
  buildServeCatalogSite,
  type SiteFamilySpec,
} from "./catalog-serve-site";

/**
 * Ticket #37, rail-card self-render family (the J4.8/J5.3/J6.2/J7.2
 * root): the rail card header of a PICKED catalog family must paint the
 * pick's registered css family — the bare manifest family the pick's
 * URL FontFaces live under, the family every effective cell actually
 * renders in — never the row's PREVIEW-subset family (fa-cat-*, the
 * name-glyph-only listing subsets of ticket #30). The journey suites
 * read their expected winner family off exactly this header inline
 * style (assertWinnerGlyphs, gui/tests/journey.spec.ts), so a header
 * painting fa-cat-* disagrees with every glyph the pick renders.
 *
 * Unpicked rows in the popup keep fa-cat-*: listing stays byte-free.
 */

const [FONT_A, FONT_B] = fixtureFontPaths();

/** Two fake families so a picked and an unpicked row coexist. */
const FAMILY_SPECS: SiteFamilySpec[] = [
  { family: "AlloySans", faces: [{ file: "AlloySans-Regular.ttf", fontPath: FONT_A }] },
  { family: "AlloySerif", faces: [{ file: "AlloySerif-Regular.ttf", fontPath: FONT_B }] },
];

/**
 * The header's inline font-family, first name normalized — read exactly
 * the way assertWinnerGlyphs reads it (the journeys' expected-family
 * oracle).
 */
const headerFamily = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const first = (list: string): string =>
      list.split(",")[0]!.replace(/["']/g, "").trim().toLowerCase();
    return first(
      document
        .querySelector<HTMLElement>(
          "[data-role='picker-en'] .kit-hd .kit-hdc b",
        )
        ?.style.fontFamily ?? "",
    );
  });

test.describe("the rail card header of a picked catalog family", () => {
  test.setTimeout(120_000);

  test("paints the pick's registered css family, while unpicked rows keep the preview subset", async ({
    page,
  }) => {
    const jsErrors: string[] = [];
    collectJsErrors(page, jsErrors);
    const site = await buildServeCatalogSite(FAMILY_SPECS);
    const spawned = await spawnServeOverFonts(site.catalogDir, [
      "--catalog-release-origin",
      site.originUri,
      "--catalog-dir",
      site.catalogDir,
    ]);
    try {
      const url = await spawned.url;
      const nameA = (await scanMeta(url, FONT_A)).display;
      const nameB = (await scanMeta(url, FONT_B)).display;
      await page.addInitScript((serve) => {
        (window as { __FONTALLOY_CONFIG__?: unknown }).__FONTALLOY_CONFIG__ =
          { serveUrl: serve };
      }, url);
      await page.goto("/");
      await page.waitForFunction(
        () => document.documentElement.dataset.catalogSweep === "done",
        undefined,
        { timeout: 60_000 },
      );

      // Pick AlloySerif in the EN slot.
      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      await pointerClick(
        page,
        page.locator('[data-picker-popup="en"] .kit-fp', { hasText: nameB }),
      );
      // The pick's registration + default-slot load landed: the bare
      // family actually renders.
      await expect
        .poll(() =>
          page.evaluate(() => document.fonts.check('16px "AlloySerif"', "A")),
        )
        .toBe(true);
      await waitForFontsReady(page);

      // The contract: the card header's inline font-family IS the pick's
      // cssFamily (the bare manifest family) — never the preview subset.
      expect(await headerFamily(page)).toBe("alloyserif");

      // Ticket #30 stands: the UNPICKED rows in the popup still
      // self-render through their own preview-subset families.
      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      const sansRow = page
        .locator('[data-picker-popup="en"] .kit-fp', { hasText: nameA })
        .first();
      await expect(sansRow).toBeVisible();
      await expect
        .poll(() =>
          sansRow
            .locator(".kit-nm")
            .evaluate((el) => getComputedStyle(el).fontFamily),
        )
        .toContain("fa-cat-AlloySans");
      assertNoJsErrors(jsErrors);
    } finally {
      await spawned.dispose();
      await rm(site.root, { recursive: true, force: true });
    }
  });
});
