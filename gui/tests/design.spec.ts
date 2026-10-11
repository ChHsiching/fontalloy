import { test, expect, type Page } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { generateFonts } from "./serve";
import {
  assertNoJsErrors,
  collectJsErrors,
  hitTestCenter,
  pointerClick,
  waitForFontsReady,
} from "./helpers";

/**
 * Design-fidelity repair: the ActionBar's rule-state wiring (the fourth
 * precedence granularity — per-block and per-group assignment as exact
 * range rules), the 按编码指定 range popup, the toolbar's batch variant,
 * the 编码 codepoint rows, and the single-character locator.
 */

/** The count of COMPLETE rules, read from the rail's rule rows. */
async function completeRuleCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      document.querySelectorAll("[data-rule-id][data-complete='true']").length,
  );
}

test.describe("action bar rule wiring", () => {
  test.describe.configure({ mode: "serial" });
  const jsErrors: string[] = [];

  test.beforeEach(() => {
    jsErrors.length = 0;
  });

  test.afterEach(() => assertNoJsErrors(jsErrors));

  /** Small fixture pair: base = A–Z, donor = A–F + U+4E00..U+4E3F. */
  async function makeLocalFixtures(): Promise<{ base: string; donor: string }> {
    const dir = await mkdtemp(resolve(tmpdir(), "fontalloy-design-"));
    return generateFonts(dir, { donorGlyphs: 64, donorAscii: 6 });
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

  test("the block segment assigns a whole block as one exact range rule", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);

    // Basic Latin (U+0020..U+007F): its segment shows on the block view.
    // (The block's label sits beside the segment; the group segment's
    // 全部用… buttons must not be confused with the block's 用… ones.)
    await pointerClick(page, page.locator(".kit-cat-g[data-group='latin-europe']"));
    await pointerClick(page, page.locator(".kit-cat-s[data-block='basic-latin']"));
    const row = page.locator(".kit-toolrow").filter({ hasText: "基本拉丁" });
    const blockButton = (label: string) =>
      row.locator(".kit-mseg button", { hasText: new RegExp(`^${label}$`) });
    // No explicit assignment yet — but the DEFAULT side shows pressed
    // (prototype parity: its chips read the block default too; here the
    // base font keeps every covered codepoint of the block).
    await expect(blockButton("用英文字体")).toHaveAttribute("aria-pressed", "true");
    await expect(blockButton("用中文字体")).toHaveAttribute("aria-pressed", "false");

    // Assign the whole block to the donor: one exact range rule.
    await pointerClick(page, blockButton("用中文字体"));
    await expect.poll(() => completeRuleCount(page)).toBe(1);
    await expect(page.locator("[data-role='custom-rule']").first()).toContainText(
      "0x20-0x7F",
    );
    // The donor holds A–F: those flip to the override winner.
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+0041']"),
    ).toHaveAttribute("data-winner", "donor-0");
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+0041']"),
    ).toHaveAttribute("data-kind", "override");
    // The pressed state follows the assignment.
    await expect(blockButton("用中文字体")).toHaveAttribute("aria-pressed", "true");

    // Pressing the carried side again reverts to default (rule removed).
    await pointerClick(page, blockButton("用中文字体"));
    await expect.poll(() => completeRuleCount(page)).toBe(0);
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+0041']"),
    ).toHaveAttribute("data-winner", "base");
    // ...and the pressed state falls back to the DEFAULT side.
    await expect(blockButton("用英文字体")).toHaveAttribute("aria-pressed", "true");
  });

  test("the toolbar stays one row at 1440px with the longest real block label", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 940 });
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);

    // The CJK group + its unified-ideographs block: the widest real
    // toolrow (group segment + long block label + block segment + pager
    // + legend + locator + 按编码指定).
    await pointerClick(page, page.locator(".kit-cat-g[data-group='cjk']"));
    await pointerClick(
      page,
      page.locator(".kit-cat-s[data-block='cjk-unified']"),
    );
    const metrics = await page.evaluate(() => {
      const row = document.querySelector(".kit-toolrow");
      if (!row) throw new Error("no toolrow");
      // Single row = the row's height is one cluster tall (the mseg tray
      // is 32px + 12px padding + border; a wrap would double it) and
      // nothing spills past the row's right edge.
      const locate = row.querySelector<HTMLElement>("[data-role='locate']");
      return {
        height: row.offsetHeight,
        overflow: row.scrollWidth - row.clientWidth,
        locateWidth: locate ? locate.getBoundingClientRect().width : null,
      };
    });
    // One row, nothing clipped: 按编码指定 never orphans onto line 2.
    expect(metrics.height).toBeLessThanOrEqual(46);
    expect(metrics.overflow).toBeLessThanOrEqual(1);
  });

  test("the group segment assigns every block of the group in one undo step", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);

    // The CJK group view (aggregate): the group segment acts on all blocks.
    await pointerClick(page, page.locator(".kit-cat-g[data-group='cjk']"));
    const groupRow = page
      .locator(".kit-toolrow")
      .filter({ hasText: "所有中日韩文字字符" });
    await expect(groupRow).toBeVisible();
    const groupButton = (label: string) =>
      groupRow.locator(".kit-mseg button", { hasText: new RegExp(`^${label}$`) });

    await pointerClick(page, groupButton("全部用英文字体"));
    // One exact range rule per block of the group, one mutateRules call.
    const blocks = await page.evaluate(
      () => document.querySelectorAll(".kit-cat-s[data-block]:not([data-block^='g:'])").length,
    );
    await expect.poll(() => completeRuleCount(page)).toBe(blocks);
    await expect(groupButton("全部用英文字体")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // One Ctrl+Z reverts the whole group assignment.
    await page.keyboard.press("Control+z");
    await expect.poll(() => completeRuleCount(page)).toBe(0);
  });

  test("the 按编码指定 popup creates a range rule for the chosen side", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);

    await pointerClick(
      page,
      page.locator(".kit-toolrow [data-role='range-specify']"),
    );
    const popup = page.locator("[data-range-popup]");
    await expect(popup).toBeVisible();
    await popup.locator("[data-role='range-start']").fill("0x0041");
    await popup.locator("[data-role='range-end']").fill("0x0046");
    await pointerClick(page, popup.locator("[data-role='range-donor']"));

    await expect.poll(() => completeRuleCount(page)).toBe(1);
    await expect(page.locator("[data-role='custom-rule']").first()).toContainText(
      "0x41-0x46",
    );
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+0041']"),
    ).toHaveAttribute("data-winner", "donor-0");

    // Invalid input states so inline, never silently.
    await pointerClick(
      page,
      page.locator(".kit-toolrow [data-role='range-specify']"),
    );
    await expect(popup).toBeVisible();
    await popup.locator("[data-role='range-start']").fill("nope");
    await pointerClick(page, popup.locator("[data-role='range-donor']"));
    await expect(popup.locator("[data-role='range-error']")).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("the toolbar's batch variant applies to the multi-selection", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);
    await pointerClick(page, page.locator(".kit-cat-g[data-group='cjk']"));
    await pointerClick(page, page.locator(".kit-cat-s[data-block='cjk-unified']"));

    // Drag-paint two cells; the toolbar switches to its batch variant.
    const first = await hitTestCenter(
      page,
      page.locator(".charmap-grid .kit-cell[data-cp='U+4E10']"),
    );
    await page.mouse.move(first.x, first.y);
    await page.mouse.down();
    const second = await hitTestCenter(
      page,
      page.locator(".charmap-grid .kit-cell[data-cp='U+4E11']"),
    );
    await page.mouse.move(second.x, second.y, { steps: 3 });
    await page.mouse.up();
    await expect(page.locator("[data-role='batch-count']")).toHaveText("已选 2 个");

    // One toolbar action applies the donor to the whole selection.
    await pointerClick(page, page.locator("[data-role='batch-donor']"));
    await expect.poll(() => completeRuleCount(page)).toBe(1);
    for (const cp of ["U+4E10", "U+4E11"]) {
      await expect(
        page.locator(`.charmap-grid .kit-cell[data-cp='${cp}']`),
      ).toHaveAttribute("data-winner", "donor-0");
    }
    // 取消 clears the selection without touching the rules (the apply
    // deliberately keeps the selection — undo-friendly batch editing).
    await pointerClick(page, page.locator("[data-role='batch-clear']"));
    await expect(page.locator("[data-role='batch-count']")).toBeHidden();
    await expect.poll(() => completeRuleCount(page)).toBe(1);
  });

  test("the details dock collapses while no cell is selected and opens on a click", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForFontsReady(page);

    // Boot (nothing selected): the dock holds ZERO height — the
    // prototype's unselected density (its frames have no strip between
    // the chip bar and the toolbar).
    const dock = page.locator(".charmap-details");
    await expect(dock).toHaveAttribute("data-open", "false");
    expect((await dock.boundingBox())?.height).toBe(0);

    // Selecting a cell expands it back to the fixed band (the codepoint
    // facts — and, with a pick pair, the precedence editor).
    await pointerClick(
      page,
      page.locator(".charmap-grid .kit-cell[data-cp='U+0041']"),
    );
    await expect(dock).toHaveAttribute("data-open", "true");
    await expect(dock).toContainText("U+0041");
    await expect
      .poll(async () => (await dock.boundingBox())?.height)
      .toBeGreaterThanOrEqual(150);

    // A fresh state (reload) collapses it again — the cursor is a store
    // field, and nothing but a click ever sets it.
    await page.reload();
    await waitForFontsReady(page);
    await expect(dock).toHaveAttribute("data-open", "false");
    await expect
      .poll(async () => (await dock.boundingBox())?.height)
      .toBe(0);
  });

  test("the 编码 toggle shows codepoint rows; the locator takes a character", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);

    // 编码 mode: every cell gains the codepoint row.
    const cell = page.locator(".charmap-grid .kit-cell[data-cp='U+0020']");
    await expect(cell.locator(".cp")).toHaveCount(0);
    await pointerClick(page, page.locator("[data-role='toggle-codepoints']"));
    await expect(cell.locator(".cp")).toHaveText("0020");
    await pointerClick(page, page.locator("[data-role='toggle-codepoints']"));
    await expect(page.locator(".kit-grid .kit-cell.hascp")).toHaveCount(0);

    // The locator also accepts a single character (永 = U+6C38).
    const locate = page.locator(".kit-toolrow [data-role='locate']");
    await locate.fill("永");
    await locate.press("Enter");
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+6C38']"),
    ).toHaveClass(/cur/);
  });
});
