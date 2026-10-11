import { test, expect } from "@playwright/test";
import {
  assertNoJsErrors,
  collectJsErrors,
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
      page.locator('[data-role="picker-en"] .kit-hd'),
    );
    const popup = page.locator('[data-picker-popup="en"]');
    await expect(popup).toBeVisible();

    // The local-file footer is part of the popup, outside the scroll area.
    const footer = popup.locator(".kit-fpsys");
    await expect(footer).toBeVisible();
    await expect(footer).toContainText("加载本地字体文件");

    await page.locator("input[data-role='font-file']").setInputFiles(font1);
    await waitForFontsReady(page);

    const row = popup.locator(".kit-fp").first();
    await expect(row).toBeVisible();
    const family = ((await row.textContent()) ?? "").trim();
    expect(family.length).toBeGreaterThan(0);

    // Self-rendering: the name text is set in its own font.
    const fontFamily = await row
      .locator(".kit-nm")
      .evaluate((el) => getComputedStyle(el).fontFamily);
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

    // The anchor card shows the auto-selected family in its own face.
    await expect(
      page.locator('[data-role="picker-en"] .kit-hd b'),
    ).toHaveText(family);
  });

  test("selecting fonts updates the anchor, pair tags, grid preview and coverage", async ({
    page,
  }) => {
    const [font1, font2] = fixtureFontPaths();

    // Load both files at once through the EN picker (the registry is shared).
    await pointerClick(
      page,
      page.locator('[data-role="picker-en"] .kit-hd'),
    );
    const popup = page.locator('[data-picker-popup="en"]');
    await page
      .locator("input[data-role='font-file']")
      .setInputFiles([font1, font2]);
    await waitForFontsReady(page);

    const rows = popup.locator(".kit-fp");
    await expect(rows).toHaveCount(2);
    const family1 = ((await rows.nth(0).textContent()) ?? "").trim();
    const family2 = ((await rows.nth(1).textContent()) ?? "").trim();
    expect(family1).not.toBe(family2);

    // EN keeps family1 (auto-selected); CJK picks family2 explicitly.
    await page.keyboard.press("Escape");
    await pointerClick(
      page,
      page.locator('[data-role="picker-cjk"] .kit-hd'),
    );
    await pointerClick(
      page,
      page.locator('[data-picker-popup="cjk"] .kit-fp', {
        hasText: family2,
      }),
    );

    await expect(
      page.locator('[data-role="picker-en"] .kit-hd b'),
    ).toHaveText(family1);
    await expect(
      page.locator('[data-role="picker-cjk"] .kit-hd b'),
    ).toHaveText(family2);

    // Font-pair tags carry the pair in plain text.
    await expect(page.locator("[data-role='font-pair'] [data-pair='base']")).toHaveText(
      family1,
    );
    await expect(page.locator("[data-role='font-pair'] [data-pair='donor']")).toHaveText(
      family2,
    );

    // The preview grid renders U+0041 in the base's own face (the winner).
    const cellFont = await page
      .locator(".charmap-grid .kit-cell[data-cp='U+0041']")
      .evaluate((el) => getComputedStyle(el).fontFamily);
    expect(cellFont).toContain(family1);

    // Coverage of the selected pair is visible and non-zero (英文 winners).
    await expect(page.locator("[data-stat='en']")).not.toHaveText("0");
  });

  test("an invalid font file reports an inline error instead of failing silently", async ({
    page,
  }) => {
    await pointerClick(
      page,
      page.locator('[data-role="picker-en"] .kit-hd'),
    );
    const popup = page.locator('[data-picker-popup="en"]');
    await page.locator("input[data-role='font-file']").setInputFiles({
      name: "broken.ttf",
      mimeType: "font/ttf",
      buffer: Buffer.from("this is definitely not a font file"),
    });
    const error = popup.locator("[data-picker-error]");
    await expect(error).toBeVisible();
    expect((await error.textContent()) ?? "").toContain("broken.ttf");
    await expect(popup.locator(".kit-fp")).toHaveCount(0);
  });
});
