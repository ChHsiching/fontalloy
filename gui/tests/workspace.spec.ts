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
    // Top bar carries the brand (the kit's assembled TopBar).
    const brand = page.locator(".topbar .kit-brand");
    await expect(brand).toBeVisible();
    expect((await brand.textContent()) ?? "").toContain("FontAlloy");

    // The prototype's top bar chrome: repo link, theme toggle, font name.
    const repo = page.locator(".topbar a.kit-btn");
    await expect(repo).toHaveAttribute(
      "href",
      "https://github.com/ChHsiching/fontalloy",
    );
    expect((await repo.textContent()) ?? "").toContain("ChHsiching/fontalloy");
    await expect(page.locator(".topbar [data-role='theme-toggle']")).toBeVisible();
    const fontName = page.locator(".topbar [data-role='font-name']");
    await expect(fontName).toHaveValue("ChHsich");

    // Left column is a fixed 260px rail (ADR-0004).
    const rail = page.locator(".workspace-rail");
    await expect(rail).toBeVisible();
    const railBox = await rail.boundingBox();
    expect(railBox?.width).toBe(260);

    // The five rail sections (the prototype's titles).
    for (const title of ["英文字体", "中文字体", "文字范围", "自定义规则", "合成设置"]) {
      await expect(
        page.locator(".workspace-rail .section", { hasText: title }).first(),
      ).toBeVisible();
    }

    // Right content area is in character-map mode (the mode segment).
    await expect(
      page.locator(".kit-modebar .kit-mseg button[data-value='charmap']"),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".charmap")).toBeVisible();

    // Persistent bottom stats bar: the six color-coded counters, tabular.
    const stats = page.locator(".statsbar");
    await expect(stats).toBeVisible();
    expect((await stats.textContent()) ?? "").toContain("字符");
    expect((await stats.textContent()) ?? "").toContain("覆盖");
    expect(
      await stats.evaluate((el) =>
        getComputedStyle(el.querySelector("b.kit-num")!).fontVariantNumeric,
      ),
    ).toContain("tabular-nums");
  });

  test("the theme toggle flips the app theme through the kit tokens", async ({
    page,
  }) => {
    const before = await page.evaluate(() => document.documentElement.dataset.theme);
    await pointerClick(page, page.locator(".topbar [data-role='theme-toggle']"));
    await page.waitForTimeout(100); // the two-frame .theming guard settles
    const after = await page.evaluate(() => document.documentElement.dataset.theme);
    expect(after).not.toBe(before);
    // The token the whole app paints with follows the theme attribute.
    const pageColor = await page.evaluate(
      () => getComputedStyle(document.documentElement).getPropertyValue("--page").trim(),
    );
    expect(pageColor.length).toBeGreaterThan(0);
    await pointerClick(page, page.locator(".topbar [data-role='theme-toggle']"));
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(
      before,
    );
  });

  test("synthesize action is present but disabled with a click-reachable explanation", async ({
    page,
  }) => {
    const synthesize = page.locator(".topbar [data-role='synthesize']");
    await expect(synthesize).toBeVisible();
    await expect(synthesize).toHaveAttribute("aria-disabled", "true");

    // No tooltip dependency: the explanation must appear as page text on click.
    await pointerClick(page, synthesize);
    const notice = page.locator(".synthesize-notice");
    await expect(notice).toBeVisible();
    const text = (await notice.textContent()) ?? "";
    expect(text.length).toBeGreaterThan(4);
  });

  test("font-pair tags reflect the (empty) selection state in plain text", async ({
    page,
  }) => {
    const tags = page.locator(".topbar [data-role='font-pair']");
    await expect(tags).toBeVisible();
    // Nothing selected yet: both tags state so in text (the kit's em dash).
    await expect(tags.locator("[data-pair='base']")).toHaveText("—");
    await expect(tags.locator("[data-pair='donor']")).toHaveText("—");
  });
});
