import { test, expect, type Page } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { generateFonts } from "./serve";
import {
  assertNoJsErrors,
  collectJsErrors,
  pointerClick,
  waitForFontsReady,
} from "./helpers";

/**
 * Design-fidelity round 1 — the missing-glyph scope: the 缺失 chip
 * (red-accented aggregate at the end of the category chips row whenever
 * the declared preset scope has uncovered codepoints), the missing view
 * it opens (dashed danger cells, the 无法指定来源 notice, all-缺失
 * stats), and the mode bar's 定位 field (jump + select from either
 * content mode).
 */

test.describe("missing glyph scope", () => {
  const jsErrors: string[] = [];

  test.beforeEach(() => {
    jsErrors.length = 0;
  });

  test.afterEach(() => assertNoJsErrors(jsErrors));

  /** Small fixture pair: base = A–Z, donor = a hanzi run. */
  async function makeLocalFixtures(): Promise<{ base: string; donor: string }> {
    const dir = await mkdtemp(resolve(tmpdir(), "fontalloy-missing-"));
    return generateFonts(dir, { donorGlyphs: 64 });
  }

  async function openWithFonts(
    page: Page,
    fonts: { base: string; donor: string },
  ): Promise<void> {
    collectJsErrors(page, jsErrors);
    await page.goto("/");
    await waitForFontsReady(page);
    for (const [role, path] of [
      ["en", fonts.base],
      ["cjk", fonts.donor],
    ] as const) {
      await pointerClick(
        page,
        page.locator(`[data-role="picker-${role}"] .kit-hd`),
      );
      const popup = page.locator(`[data-picker-popup="${role}"]`);
      await expect(popup).toBeVisible();
      await page.locator("input[data-role='font-file']").setInputFiles(path);
      await expect(popup.locator(".kit-fp").first()).toBeVisible();
      await page.keyboard.press("Escape");
    }
  }

  test("the 缺失 chip counts the uncovered preset scope and opens the missing view", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);

    // No declared scope yet: no chip.
    await expect(
      page.locator(".kit-catbar .kit-cat-g[data-group='missing']"),
    ).toHaveCount(0);

    // Declare the zh_cn scope (文字范围): the fixture pair covers only a
    // small hanzi run of it, so the missing count is large.
    await pointerClick(page, page.locator("[data-role='add-preset']"));
    const presetPop = page.locator("[data-picker-popup='preset-add']");
    await expect(presetPop).toBeVisible();
    await pointerClick(
      page,
      presetPop.locator(".preset-row", { hasText: "zh_cn" }),
    );
    await expect(
      page.locator("[data-role='preset-rule'][data-complete='true']"),
    ).toHaveCount(1);

    const chip = page.locator(".kit-catbar .kit-cat-g[data-group='missing']");
    await expect(chip).toBeVisible();
    await expect(chip).toHaveClass(/miss/);
    const count = Number(
      ((await chip.locator(".n").textContent()) ?? "0").replace(/,/g, ""),
    );
    expect(count).toBeGreaterThan(6000);
    // The chip closes the row.
    expect(
      await page.evaluate(() => {
        const row = document.querySelector(".kit-cat-l1");
        const last = row.lastElementChild;
        return last instanceof HTMLElement && last.dataset.group === "missing";
      }),
    ).toBe(true);

    // Opening it: the notice replaces the assignment segments, every
    // cell is dashed-missing, and the stats line reads all-缺失.
    await pointerClick(page, chip);
    await expect(page.locator(".kit-toolrow")).toContainText(
      "缺失字符无法指定来源",
    );
    const missCells = page.locator(".kit-grid .kit-cell.miss");
    expect(await missCells.count()).toBe(Math.min(1024, count));
    // The status bar's 缺失 counter reports the WHOLE scope (the grid
    // shows one page of it).
    const statMissing = await page.evaluate(() =>
      Number(
        (document.querySelector("[data-stat='missing']")?.textContent ?? "0")
          .replace(/,/g, "")
          .trim(),
      ),
    );
    expect(statMissing).toBe(count);
    const stats = (await page.locator(".statsbar").textContent()) ?? "";
    expect(stats).toContain("缺失");
    // The grid pages the missing list itself.
    await expect(page.locator("[data-pager-label]")).toContainText(
      `/${Math.ceil(count / 1024)} 页`,
    );

    // Removing the preset rule removes the declared scope — and the chip.
    await pointerClick(
      page,
      page.locator("[data-role='preset-rule'] [data-role='remove-rule']"),
    );
    await expect(
      page.locator(".kit-catbar .kit-cat-g[data-group='missing']"),
    ).toHaveCount(0);

  });

  test("the mode bar's 定位 field jumps to the cell from scene mode", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);

    await pointerClick(
      page,
      page.locator(".kit-modebar .kit-mseg [data-value='scene']"),
    );
    await expect(page.locator(".scenes")).toBeVisible();

    const goto = page.locator(".kit-modebar [data-role='goto']");
    await expect(goto).toBeVisible();
    await expect(goto).toHaveAttribute("placeholder", "定位 永 或 U+6C38");
    await goto.fill("永");
    await goto.press("Enter");

    // Locating switches to the character map and selects the cell.
    await expect(page.locator(".charmap")).toBeVisible();
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+6C38']"),
    ).toHaveClass(/cur/);
  });
});
