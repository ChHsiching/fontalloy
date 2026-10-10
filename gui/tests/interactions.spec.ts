import { test, expect } from "@playwright/test";
import {
  assertNoJsErrors,
  collectJsErrors,
  fixtureFontPaths,
  pointerClick,
  waitForFontsReady,
} from "./helpers";

test.describe("cell details (click-reachable information)", () => {
  const jsErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    jsErrors.length = 0;
    collectJsErrors(page, jsErrors);
    await page.goto("/");
    await waitForFontsReady(page);

    // Load one font and let it auto-select for the EN picker.
    const [font1] = fixtureFontPaths();
    await pointerClick(page, page.locator('[data-role="picker-en"] .picker-anchor'));
    const popup = page.locator('[data-picker-popup="en"]');
    await popup
      .locator(".popup-footer input[type=file]")
      .setInputFiles(font1);
    await waitForFontsReady(page);
    await page.keyboard.press("Escape");
  });

  test.afterEach(() => assertNoJsErrors(jsErrors));

  test("clicking a covered cell shows its codepoint, character and coverage", async ({
    page,
  }) => {
    await pointerClick(
      page,
      page.locator(".charmap-categories .block-button", { hasText: "基本拉丁" }),
    );
    await pointerClick(page, page.locator(".charmap-grid .cell[data-cp='U+0041']"));

    const details = page.locator(".charmap-details");
    const text = (await details.textContent()) ?? "";
    expect(text).toContain("U+0041");
    expect(text).toContain("A");
    expect(text).toContain("英文字体");

    // The selected cell is marked with the accent (selected state) class.
    await expect(
      page.locator(".charmap-grid .cell[data-cp='U+0041']"),
    ).toHaveClass(/is-selected/);
  });

  test("an uncovered cell states so in plain text", async ({ page }) => {
    await pointerClick(
      page,
      page.locator(".charmap-categories .group-toggle", { hasText: "通用符号" }),
    );
    await pointerClick(
      page,
      page.locator(".charmap-categories .block-button", { hasText: "杂项符号" }),
    );
    // U+2603 SNOWMAN is not covered by the shipped host fonts.
    await pointerClick(page, page.locator(".charmap-grid .cell[data-cp='U+2603']"));
    const text = (await page.locator(".charmap-details").textContent()) ?? "";
    expect(text).toContain("U+2603");
    expect(text).toContain("未被所选字体覆盖");
  });
});
