import { test, expect } from "@playwright/test";
import {
  assertNoJsErrors,
  collectJsErrors,
  pointerClick,
  waitForFontsReady,
} from "./helpers";

test.describe("workspace shell", () => {
  const jsErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    jsErrors.length = 0;
    collectJsErrors(page, jsErrors);
    await page.goto("/");
    await waitForFontsReady(page);
  });

  test.afterEach(() => assertNoJsErrors(jsErrors));

  test("boots with top bar, 260px left column, character-map content, stats bar", async ({
    page,
  }) => {
    // Top bar carries the brand.
    const brand = page.locator(".topbar .brand");
    await expect(brand).toBeVisible();
    expect((await brand.textContent()) ?? "").toContain("FontAlloy");

    // Left column is a fixed 260px rail (ADR-0004).
    const rail = page.locator(".workspace-rail");
    await expect(rail).toBeVisible();
    const railBox = await rail.boundingBox();
    expect(railBox?.width).toBe(260);

    // The four placeholder sections plus the two font pickers.
    for (const title of ["英文字体", "中文字体", "字符范围", "自定义规则", "合成设置"]) {
      await expect(
        page.locator(".workspace-rail .section", { hasText: title }).first(),
      ).toBeVisible();
    }

    // Right content area is in character-map mode.
    await expect(page.locator(".content-mode-tabs [data-mode='charmap']")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.locator(".charmap")).toBeVisible();

    // Persistent bottom stats bar.
    const stats = page.locator(".statsbar");
    await expect(stats).toBeVisible();
    expect((await stats.textContent()) ?? "").toContain("字体");
    expect(
      await stats.evaluate((el) => getComputedStyle(el).fontVariantNumeric),
    ).toContain("tabular-nums");
  });

  test("synthesize action is present but disabled with a click-reachable explanation", async ({
    page,
  }) => {
    const synthesize = page.locator(".topbar .synthesize");
    await expect(synthesize).toBeVisible();
    await expect(synthesize).toHaveAttribute("aria-disabled", "true");

    // No tooltip dependency: the explanation must appear as page text on click.
    await pointerClick(page, synthesize);
    const notice = page.locator(".synthesize-notice");
    await expect(notice).toBeVisible();
    const text = (await notice.textContent()) ?? "";
    expect(text.length).toBeGreaterThan(4);
  });

  test("font-pair tags reflect the (empty) selection state in plain text", async ({ page }) => {
    const tags = page.locator(".topbar .font-pair-tags");
    await expect(tags).toBeVisible();
    // Nothing selected yet: the pair tags say so in text, not by styling alone.
    expect((await tags.textContent()) ?? "").toContain("未选择");
  });
});
