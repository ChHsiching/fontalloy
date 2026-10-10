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
