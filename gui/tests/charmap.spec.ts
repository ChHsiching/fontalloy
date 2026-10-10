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

  test("aggregate view: 1024 cells per page, pager and goto work", async ({
    page,
  }) => {
    // Independent oracle: U+0020..U+10FFFF minus the 2,048 surrogates is
    // 1,112,032 codepoints = 1086 pages of 1024, last page holding 992 cells.
    const pagerText = page.locator(".charmap-pager .page-indicator");
    await expect(pagerText).toHaveText("第 1 / 1086 页");

    await expect(page.locator(".charmap-grid .cell")).toHaveCount(1024);
    await expect(page.locator(".charmap-grid .cell").first()).toHaveAttribute(
      "data-cp",
      "U+0020",
    );

    // Next page via real pointer click.
    await pointerClick(page, page.locator(".charmap-pager .page-next"));
    await expect(pagerText).toHaveText("第 2 / 1086 页");
    await expect(page.locator(".charmap-grid .cell").first()).toHaveAttribute(
      "data-cp",
      "U+0420",
    );

    // Goto the last page by number + jump button.
    const gotoInput = page.locator(".charmap-pager .page-goto-input");
    await gotoInput.fill("1086");
    await pointerClick(page, page.locator(".charmap-pager .page-goto"));
    await expect(pagerText).toHaveText("第 1086 / 1086 页");
    // 1,111,040 codepoints precede the last page: 55,264 BMP (through U+D7FF)
    // then 1,055,776 from U+E000 => first cell of the last page is U+10FC20,
    // and the page ends exactly at U+10FFFF (992 cells).
    await expect(page.locator(".charmap-grid .cell").first()).toHaveAttribute(
      "data-cp",
      "U+10FC20",
    );
    await expect(page.locator(".charmap-grid .cell").last()).toHaveAttribute(
      "data-cp",
      "U+10FFFF",
    );
    await expect(page.locator(".charmap-grid .cell")).toHaveCount(992);

    // Out-of-range goto clamps to the last page.
    await gotoInput.fill("99999");
    await pointerClick(page, page.locator(".charmap-pager .page-goto"));
    await expect(pagerText).toHaveText("第 1086 / 1086 页");
  });

  test("hierarchical categories coexist with the aggregate view", async ({
    page,
  }) => {
    // Expand the CJK group and pick the unified ideographs block.
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

    // 0x4E00..0x9FFF = 20,992 codepoints = 21 pages.
    await expect(page.locator(".charmap-pager .page-indicator")).toHaveText(
      "第 1 / 21 页",
    );
    await expect(page.locator(".charmap-grid .cell").first()).toHaveAttribute(
      "data-cp",
      "U+4E00",
    );

    // The stats bar follows the category in plain text.
    await expect(page.locator("[data-stat='category']")).toHaveText(
      "分类：CJK 统一表意文字",
    );

    // The aggregate entry is still one click away and resets the page.
    await pointerClick(
      page,
      page.locator(".charmap-pager .page-next"),
    );
    await pointerClick(
      page,
      page.locator(".charmap-categories .block-button", { hasText: "全部" }),
    );
    await expect(page.locator(".charmap-pager .page-indicator")).toHaveText(
      "第 1 / 1086 页",
    );
    await expect(page.locator(".charmap-grid .cell").first()).toHaveAttribute(
      "data-cp",
      "U+0020",
    );
  });

  test("every cell renders its codepoint as text in the DOM", async ({
    page,
  }) => {
    await pointerClick(
      page,
      page.locator(".charmap-categories .block-button", { hasText: "基本拉丁" }),
    );
    // The cell for U+0041 contains the character itself as DOM text.
    const cellA = page.locator(".charmap-grid .cell[data-cp='U+0041']");
    await expect(cellA).toHaveCount(1);
    expect((await cellA.textContent()) ?? "").toContain("A");
  });
});
