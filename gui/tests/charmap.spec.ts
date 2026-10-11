import { test, expect } from "@playwright/test";
import {
  assertNoJsErrors,
  collectJsErrors,
  pointerClick,
  waitForFontsReady,
} from "./helpers";

test.describe("character map", () => {
  const jsErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    jsErrors.length = 0;
    collectJsErrors(page, jsErrors);
    await page.goto("/");
    await waitForFontsReady(page);
  });

  test.afterEach(() => assertNoJsErrors(jsErrors));

  test("aggregate view: 1024 cells per page, pager and locate work", async ({
    page,
  }) => {
    // Independent oracle: U+0020..U+10FFFF minus the 2,048 surrogates is
    // 1,112,032 codepoints = 1086 pages of 1024, last page holding 992 cells.
    const pagerText = page.locator(".kit-toolrow [data-pager-label]");
    await expect(pagerText).toHaveText("第 1/1086 页");

    await expect(page.locator(".charmap-grid .kit-cell")).toHaveCount(1024);
    await expect(page.locator(".charmap-grid .kit-cell").first()).toHaveAttribute(
      "data-cp",
      "U+0020",
    );

    // Next page via real pointer click.
    await pointerClick(
      page,
      page.locator(".kit-toolrow .kit-pgc button[aria-label='下一页']"),
    );
    await expect(pagerText).toHaveText("第 2/1086 页");
    await expect(page.locator(".charmap-grid .kit-cell").first()).toHaveAttribute(
      "data-cp",
      "U+0420",
    );

    // The locator jumps to the last page by codepoint (Enter commits).
    const locate = page.locator(".kit-toolrow [data-role='locate']");
    await locate.fill("10FC20");
    await locate.press("Enter");
    await expect(pagerText).toHaveText("第 1086/1086 页");
    // 1,111,040 codepoints precede the last page: 55,264 BMP (through U+D7FF)
    // then 1,055,776 from U+E000 => first cell of the last page is U+10FC20,
    // and the page ends exactly at U+10FFFF (992 cells).
    await expect(page.locator(".charmap-grid .kit-cell").first()).toHaveAttribute(
      "data-cp",
      "U+10FC20",
    );
    await expect(page.locator(".charmap-grid .kit-cell").last()).toHaveAttribute(
      "data-cp",
      "U+10FFFF",
    );
    await expect(page.locator(".charmap-grid .kit-cell")).toHaveCount(992);

    // Locating the very last scalar value stays clamped on the last page.
    await locate.fill("U+10FFFF");
    await locate.press("Enter");
    await expect(pagerText).toHaveText("第 1086/1086 页");
  });

  test("the chip bar's two levels coexist with the aggregate view", async ({
    page,
  }) => {
    // Pick the CJK group, then the unified ideographs block chip.
    await pointerClick(page, page.locator(".kit-cat-g[data-group='cjk']"));
    await expect(page.locator(".kit-cat-s[data-block='g:cjk']")).toHaveClass(/on/);
    await pointerClick(
      page,
      page.locator(".kit-cat-s[data-block='cjk-unified']"),
    );

    // 0x4E00..0x9FFF = 20,992 codepoints = 21 pages.
    await expect(page.locator(".kit-toolrow [data-pager-label]")).toHaveText(
      "第 1/21 页",
    );
    await expect(page.locator(".charmap-grid .kit-cell").first()).toHaveAttribute(
      "data-cp",
      "U+4E00",
    );

    // The stats bar reports the WHOLE MERGE (prototype parity): its
    // counters never follow the browsing category — without picks the
    // universe is empty in every view.
    await expect(page.locator("[data-stat='total']")).toHaveText("0");

    // The 全部 chip is one click away and resets the page.
    await pointerClick(
      page,
      page.locator(".kit-toolrow .kit-pgc button[aria-label='下一页']"),
    );
    await pointerClick(page, page.locator(".kit-cat-g[data-group='all']"));
    await expect(page.locator(".kit-toolrow [data-pager-label]")).toHaveText(
      "第 1/1086 页",
    );
    await expect(page.locator(".charmap-grid .kit-cell").first()).toHaveAttribute(
      "data-cp",
      "U+0020",
    );
    // Back in the group, its aggregate chip (g:cjk) browses the union.
    await pointerClick(page, page.locator(".kit-cat-g[data-group='cjk']"));
    await expect(page.locator(".kit-toolrow [data-pager-label]")).toHaveText(
      "第 1/81 页",
    );
  });

  test("every cell renders its codepoint as text in the DOM", async ({
    page,
  }) => {
    await pointerClick(
      page,
      page.locator(".kit-cat-g[data-group='latin-europe']"),
    );
    await pointerClick(
      page,
      page.locator(".kit-cat-s[data-block='basic-latin']"),
    );
    // The cell for U+0041 contains the character itself as DOM text.
    const cellA = page.locator(".charmap-grid .kit-cell[data-cp='U+0041']");
    await expect(cellA).toHaveCount(1);
    expect((await cellA.textContent()) ?? "").toContain("A");
  });
});
