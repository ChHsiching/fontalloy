import { test, expect } from "@playwright/test";
import {
  assertNoJsErrors,
  collectJsErrors,
  cssFamilyQuote,
  fixtureFontPaths,
  pointerClick,
  waitForFontsReady,
} from "./helpers";

test.describe("local font loading", () => {
  const jsErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    jsErrors.length = 0;
    collectJsErrors(page, jsErrors);
    await page.goto("/");
    await waitForFontsReady(page);
  });

  test.afterEach(() => assertNoJsErrors(jsErrors));

  test("a local font file loads via FontFace(arrayBuffer) into a self-rendered picker row", async ({
    page,
  }) => {
    const [font1] = fixtureFontPaths();

    await pointerClick(
      page,
      page.locator('[data-role="picker-en"] .picker-anchor'),
    );
    const popup = page.locator('[data-picker-popup="en"]');
    await expect(popup).toBeVisible();

    // The local-file footer is part of the popup, outside the scroll area.
    const footer = popup.locator(".popup-footer");
    await expect(footer).toBeVisible();
    await expect(footer).toContainText("加载本地字体文件");

    await popup.locator(".popup-footer input[type=file]").setInputFiles(font1);
    await waitForFontsReady(page);

    const row = popup.locator(".picker-row").first();
    await expect(row).toBeVisible();
    const family = ((await row.textContent()) ?? "").trim();
    expect(family.length).toBeGreaterThan(0);

    // Self-rendering: the row's family name is set in its own font.
    const fontFamily = await row.evaluate((el) => getComputedStyle(el).fontFamily);
    expect(fontFamily).toContain(family);

    // Independent oracle: the browser font subsystem registered the loaded
    // family under the displayed name and it covers U+0041.
    const covers = await page.evaluate(
      (fam) =>
        document.fonts.check(
          `16px "${fam.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
          "A",
        ),
      family,
    );
    expect(covers).toBe(true);

    // The stats bar counts the loaded font.
    await expect(page.locator("[data-stat='fonts']")).toHaveText("1");
  });

  test("selecting fonts updates the anchor, pair tags, grid font stack and coverage", async ({
    page,
  }) => {
    const [font1, font2] = fixtureFontPaths();

    // Load both files at once through the EN picker (the registry is shared).
    await pointerClick(
      page,
      page.locator('[data-role="picker-en"] .picker-anchor'),
    );
    const popup = page.locator('[data-picker-popup="en"]');
    await popup
      .locator(".popup-footer input[type=file]")
      .setInputFiles([font1, font2]);
    await waitForFontsReady(page);

    const rows = popup.locator(".picker-row");
    await expect(rows).toHaveCount(2);
    const family1 = ((await rows.nth(0).textContent()) ?? "").trim();
    const family2 = ((await rows.nth(1).textContent()) ?? "").trim();
    expect(family1).not.toBe(family2);

    await expect(page.locator("[data-stat='fonts']")).toHaveText("2");

    // EN keeps family1 (auto-selected); CJK picks family2 explicitly.
    await page.keyboard.press("Escape");
    await pointerClick(
      page,
      page.locator('[data-role="picker-cjk"] .picker-anchor'),
    );
    await pointerClick(
      page,
      page.locator('[data-picker-popup="cjk"] .picker-row', {
        hasText: family2,
      }),
    );

    await expect(
      page.locator('[data-role="picker-en"] .picker-current'),
    ).toHaveText(family1);
    await expect(
      page.locator('[data-role="picker-cjk"] .picker-current'),
    ).toHaveText(family2);

    // Font-pair tags carry the pair in plain text.
    await expect(page.locator('[data-role="pair-en"]')).toHaveText(`EN ${family1}`);
    await expect(page.locator('[data-role="pair-cjk"]')).toHaveText(`CJK ${family2}`);

    // The preview grid stack renders with both selected fonts.
    const stack = await page
      .locator(".charmap-grid")
      .evaluate((el) => el.style.getPropertyValue("--font-preview"));
    expect(stack).toContain(cssFamilyQuote(family1));
    expect(stack).toContain(cssFamilyQuote(family2));

    // Coverage of the selected pair is visible and non-zero.
    const coverage = await page
      .locator("[data-stat='coverage']")
      .textContent();
    expect(Number((coverage ?? "0").replace(/,/g, ""))).toBeGreaterThan(0);
  });

  test("an invalid font file reports an inline error instead of failing silently", async ({
    page,
  }) => {
    await pointerClick(
      page,
      page.locator('[data-role="picker-en"] .picker-anchor'),
    );
    const popup = page.locator('[data-picker-popup="en"]');
    await popup.locator(".popup-footer input[type=file]").setInputFiles({
      name: "broken.ttf",
      mimeType: "font/ttf",
      buffer: Buffer.from("this is definitely not a font file"),
    });
    const error = popup.locator(".picker-error");
    await expect(error).toBeVisible();
    expect((await error.textContent()) ?? "").toContain("broken.ttf");
    await expect(page.locator("[data-stat='fonts']")).toHaveText("0");
  });
});
