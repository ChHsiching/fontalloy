import { test, expect } from "@playwright/test";
import { statSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  assertNoJsErrors,
  collectJsErrors,
  fixtureFontPaths,
  pointerClick,
  waitForFontsReady,
} from "./helpers";
import { SimCatalog, injectCatalogConfig } from "./catalog-fixtures";

/** Two catalog families are enough for the screenshot states. */
const SHOT_FAMILY_SPECS = (fontA: string, fontB: string) => [
  { family: "Alloy Sans", file: "AlloySans-Regular.ttf", fontPath: fontA, deflate: true },
  { family: "Alloy Serif", file: "AlloySerif-Regular.ttf", fontPath: fontB },
];

/**
 * Screenshot scenario (seam 3): captures must include OPEN-OVERLAY states,
 * never just the resting UI. Screenshots land in test-results/screenshots/.
 */
test.describe("screenshots with open overlays", () => {
  const jsErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    jsErrors.length = 0;
    collectJsErrors(page, jsErrors);
    await page.goto("/");
    await waitForFontsReady(page);
  });

  test.afterEach(() => assertNoJsErrors(jsErrors));

  test("workspace with fonts loaded and a picker popup open", async ({
    page,
  }) => {
    const [font1, font2] = fixtureFontPaths();

    // Load two local fonts and select them for the pair.
    await pointerClick(page, page.locator('[data-role="picker-en"] .picker-anchor'));
    const popup = page.locator('[data-picker-popup="en"]');
    await popup
      .locator(".popup-footer input[type=file]")
      .setInputFiles([font1, font2]);
    await waitForFontsReady(page);
    await page.keyboard.press("Escape");

    // Pick a CJK block so the grid shows real glyphs, select a cell, then
    // reopen the EN picker so the overlay state is captured.
    await pointerClick(
      page,
      page.locator(".charmap-categories .group-toggle", { hasText: "中日韩文字" }),
    );
    await pointerClick(
      page,
      page.locator(".charmap-categories .block-button", {
        hasText: "CJK 统一表意文字",
      }),
    );
    await pointerClick(page, page.locator(".charmap-grid .cell[data-cp='U+4E2D']"));

    await pointerClick(page, page.locator('[data-role="picker-en"] .picker-anchor'));
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

  test.beforeEach(async ({ page }) => {
    jsErrors.length = 0;
    collectJsErrors(page, jsErrors);
  });

  test.afterEach(() => assertNoJsErrors(jsErrors));

  test("first-run download screen mid-download, then the picker over catalog rows", async ({
    page,
  }) => {
    const [font1, font2] = fixtureFontPaths();
    const sim = await SimCatalog.create(SHOT_FAMILY_SPECS(font1, font2));
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    sim.gates["Alloy Serif"] = () => gate; // hold the run mid-download
    await sim.install(page);
    await injectCatalogConfig(page);
    await page.goto("/");

    const screen = page.locator(".catalog-screen");
    await expect(screen).toBeVisible();
    await expect(
      screen.locator(".catalog-family[data-family='Alloy Serif'] .catalog-family-status"),
    ).toHaveText("下载中");
    await page.waitForTimeout(250); // let the panel settle visually

    const dir = join(process.cwd(), "test-results", "screenshots");
    mkdirSync(dir, { recursive: true });
    const firstRunPath = join(dir, "catalog-first-run-progress.png");
    await page.screenshot({ path: firstRunPath });
    expect(statSync(firstRunPath).size).toBeGreaterThan(10_000);

    openGate();
    await expect(screen).toBeHidden();
    await expect(
      screen.locator("[data-stat='catalog-done']"),
    ).toHaveText("2");

    // Second overlay state: the picker listing catalog families, open.
    await pointerClick(page, page.locator('[data-role="picker-en"] .picker-anchor'));
    const row = page
      .locator('[data-picker-popup="en"]')
      .locator(".picker-row[data-family='Alloy Sans']");
    await expect(row).toBeVisible();
    await expect
      .poll(() => row.evaluate((el) => getComputedStyle(el).fontFamily))
      .not.toBe("");
    await page.waitForTimeout(250); // open transition settled
    const pickerPath = join(dir, "catalog-picker-open.png");
    await page.screenshot({ path: pickerPath });
    expect(statSync(pickerPath).size).toBeGreaterThan(10_000);
  });
});
