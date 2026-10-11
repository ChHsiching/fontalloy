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
 * Issue #20 (prototype parity): 多选 mode, batch operations, undo, and
 * the whole-merge stats bar.
 *
 * - Drag-paint and shift-range arm ONLY inside 多选 (the explicit mode
 *   toggle); a plain click opens the char popup instead.
 * - One batch apply commits one side for the WHOLE selection: a
 *   contiguous selection becomes one range rule; anything else becomes
 *   per-codepoint rules. The gesture ends prototype-style (selection
 *   cleared, 批量调整完成 announced).
 * - Two undo stacks with separate entry points: the batch row's 撤销
 *   (selection) and the toolbar's 撤销 / Ctrl+Z (rules).
 * - The centerpiece: a bulk edit followed by undo returns the app to
 *   the prior state EXACTLY — rules state, grid winners, stats.
 */

/** The multi-selection cell class (kit vocabulary; the cursor is `cur`). */
const SEL = /(?:^|\s)sel(?:\s|$)/;

/** The count of human summary rows in the 自定义规则 section. */
async function summaryRowCount(page: Page): Promise<number> {
  return page.locator("[data-role='rule-row']").count();
}

/** The number of multi-selected cells on the current grid page. */
async function selectionCount(page: Page): Promise<number> {
  return page.locator(".charmap-grid .kit-cell.sel").count();
}

/** Enter 多选 mode (the explicit toggle in the toolbar). */
async function enterMultiMode(page: Page): Promise<void> {
  await pointerClick(page, page.locator("[data-role='toggle-multi']"));
  await expect(page.locator("[data-role='toggle-multi']")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
}

test.describe("multi-select, batch operations, undo", () => {
  test.describe.configure({ mode: "serial" });
  const jsErrors: string[] = [];

  test.beforeEach(() => {
    jsErrors.length = 0;
  });

  test.afterEach(() => assertNoJsErrors(jsErrors));

  /** Small fixture pair: base = A–Z, donor = A–F + U+4E00..U+4E3F. */
  async function makeLocalFixtures(): Promise<{ base: string; donor: string }> {
    const dir = await mkdtemp(resolve(tmpdir(), "fontalloy-bulk-"));
    return generateFonts(dir, { donorGlyphs: 64, donorAscii: 6 });
  }

  /** Load one font file into a picker through its file input. */
  async function loadIntoPicker(
    page: Page,
    role: "en" | "cjk",
    path: string,
  ): Promise<void> {
    await pointerClick(
      page,
      page.locator(`[data-role="picker-${role}"] .kit-hd`),
    );
    const popup = page.locator(`[data-picker-popup="${role}"]`);
    await expect(popup).toBeVisible();
    await page.locator("input[data-role='font-file']").setInputFiles(path);
    await expect(popup.locator(".kit-fp").first()).toBeVisible();
    await waitForFontsReady(page);
    await page.keyboard.press("Escape");
  }

  /** Open the page (no service) with both fixture fonts picked. */
  async function openWithFonts(
    page: Page,
    fonts: { base: string; donor: string },
  ): Promise<void> {
    collectJsErrors(page, jsErrors);
    await page.goto("/");
    await waitForFontsReady(page);
    await loadIntoPicker(page, "en", fonts.base);
    await loadIntoPicker(page, "cjk", fonts.donor);
  }

  async function gotoCjkPage(page: Page): Promise<void> {
    await pointerClick(page, page.locator(".kit-cat-g[data-group='cjk']"));
    await pointerClick(
      page,
      page.locator(".kit-cat-s[data-block='cjk-unified']"),
    );
    await expect(page.locator(".kit-toolrow [data-pager-label]")).toHaveText(
      "第 1/21 页",
    );
  }

  /**
   * Real-pointer drag-paint across the named cells (多选 mode armed
   * first): hit-test-guarded mouse down on the first, moves over the
   * rest, up on the last. A run starting on an unselected cell ADDS to
   * the selection (toggle-paint), so consecutive calls accumulate.
   */
  async function paintDrag(page: Page, cps: string[]): Promise<void> {
    const first = await hitTestCenter(
      page,
      page.locator(`.charmap-grid .kit-cell[data-cp='${cps[0]}']`),
    );
    await page.mouse.move(first.x, first.y);
    await page.mouse.down();
    for (let i = 1; i < cps.length; i++) {
      const point = await hitTestCenter(
        page,
        page.locator(`.charmap-grid .kit-cell[data-cp='${cps[i]}']`),
      );
      await page.mouse.move(point.x, point.y, { steps: 3 });
    }
    await page.mouse.up();
  }

  /** The grid's effective table on the current page, from cell attributes. */
  function collectGrid(
    page: Page,
  ): Promise<Record<string, [string, string, string]>> {
    return page.evaluate(() => {
      const out: Record<string, [string, string, string]> = {};
      for (const cell of document.querySelectorAll(".charmap-grid .kit-cell")) {
        const cp = cell.getAttribute("data-cp");
        if (!cp) continue;
        out[cp] = [
          cell.getAttribute("data-winner") ?? "",
          cell.getAttribute("data-via") ?? "",
          cell.getAttribute("data-kind") ?? "",
        ];
      }
      return out;
    });
  }

  /* --------------------------------------------------------------- */
  /* The centerpiece: bulk edit + undo returns to the prior state.     */
  /* --------------------------------------------------------------- */

  test("a bulk edit followed by undo returns the app to the prior state exactly", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);
    await gotoCjkPage(page);

    // A plain click opens the char popup at the cell — no selection.
    await pointerClick(
      page,
      page.locator(".charmap-grid .kit-cell[data-cp='U+4E10']"),
    );
    const popup = page.locator("[data-char-popup]");
    await expect(popup).toBeVisible();
    await expect(popup.locator("[data-role='char-code']")).toHaveText("U+4E10");
    await expect(popup.locator("[data-role='char-from']")).toContainText(
      "来自",
    );
    await expect.poll(() => selectionCount(page)).toBe(0);

    // 多选 mode arms painting; the boot preset is the 文字范围 state,
    // so the 自定义规则 summary list starts empty.
    await enterMultiMode(page);
    await expect(page.locator(".rule-list-empty")).toHaveText("暂无自定义规则。");

    // Drag-paint a contiguous run of four cells.
    const run = ["U+4E10", "U+4E11", "U+4E12", "U+4E13"];
    await paintDrag(page, run);

    // Every painted cell carries the multi-selection state (an accent
    // family state distinct from hover and from the details cursor)…
    for (const cp of run) {
      await expect(
        page.locator(`.charmap-grid .kit-cell[data-cp='${cp}']`),
      ).toHaveClass(SEL);
    }
    // …and nothing else does; the live selection is counted in plain text.
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+4E0F']"),
    ).not.toHaveClass(SEL);
    await expect(page.locator("[data-role='batch-count']")).toHaveText("已选 4 个");

    // The prior state of the round trip, captured WITH the selection in
    // place — rule undo must preserve it: winners, stats bar text.
    const gridBefore = await collectGrid(page);
    const statsBefore = (await page.locator(".statsbar").textContent()) ?? "";

    // One action applies the donor side to the whole selection.
    await pointerClick(page, page.locator("[data-role='batch-donor']"));

    // The live region announces the batch completion (prototype parity).
    await expect(page.locator("[data-role='live']")).toHaveText("批量调整完成");

    // One range summary row; every selected cell resolves through the
    // new rule (rule-1 — the boot-seeded zh_cn preset is complete
    // rule 0).
    await expect.poll(() => summaryRowCount(page)).toBe(1);
    const row = page.locator("[data-role='rule-row'][data-kind='range']");
    await expect(row).toContainText("用中文字体");
    await expect(row.locator(".rule-line-suffix")).toHaveText(
      "U+4E10 至 U+4E13",
    );
    for (const cp of run) {
      const cell = page.locator(`.charmap-grid .kit-cell[data-cp='${cp}']`);
      await expect(cell).toHaveAttribute("data-winner", "donor-0");
      await expect(cell).toHaveAttribute("data-via", "rule-1");
      await expect(cell).toHaveAttribute("data-kind", "fill");
    }
    expect(await collectGrid(page)).not.toEqual(gridBefore);

    // The gesture ended prototype-style: the selection cleared.
    await expect.poll(() => selectionCount(page)).toBe(0);
    await expect(page.locator("[data-role='batch-count']")).toBeHidden();

    // A record of the feature: the summary rows + the reset button.
    const { mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(process.cwd(), "test-results", "screenshots");
    mkdirSync(dir, { recursive: true });
    await page.screenshot({
      path: join(dir, "bulk-batch-apply.png"),
      animations: "disabled",
    });

    // Ctrl+Z (rule undo): everything rule-related returns EXACTLY.
    await page.keyboard.press("Control+z");
    expect(await collectGrid(page)).toEqual(gridBefore);
    expect(await page.locator(".statsbar").textContent()).toBe(statsBefore);
    await expect.poll(() => summaryRowCount(page)).toBe(0);
    await expect(page.locator(".rule-list-empty")).toHaveText("暂无自定义规则。");
  });

  /* --------------------------------------------------------------- */
  /* Shift-range selection.                                           */
  /* --------------------------------------------------------------- */

  test("shift-click extends the selection from the anchor; one range rule applies", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);
    await gotoCjkPage(page);
    await enterMultiMode(page);

    // Click the anchor, then shift-click to extend to U+4E25.
    await pointerClick(
      page,
      page.locator(".charmap-grid .kit-cell[data-cp='U+4E20']"),
    );
    await expect.poll(() => selectionCount(page)).toBe(1);
    await page.keyboard.down("Shift");
    await pointerClick(
      page,
      page.locator(".charmap-grid .kit-cell[data-cp='U+4E25']"),
    );
    await page.keyboard.up("Shift");
    await expect(page.locator("[data-role='batch-count']")).toHaveText("已选 6 个");

    // Extend further from the SAME anchor: the range grows past U+4E25.
    await page.keyboard.down("Shift");
    await pointerClick(
      page,
      page.locator(".charmap-grid .kit-cell[data-cp='U+4E28']"),
    );
    await page.keyboard.up("Shift");
    await expect(page.locator("[data-role='batch-count']")).toHaveText("已选 9 个");
    for (const cp of ["U+4E20", "U+4E24", "U+4E28"]) {
      await expect(
        page.locator(`.charmap-grid .kit-cell[data-cp='${cp}']`),
      ).toHaveClass(SEL);
    }

    // Apply the donor side: one range rule covers the selection.
    await pointerClick(page, page.locator("[data-role='batch-donor']"));
    await expect.poll(() => summaryRowCount(page)).toBe(1);
    for (const cp of ["U+4E20", "U+4E24", "U+4E28"]) {
      const cell = page.locator(`.charmap-grid .kit-cell[data-cp='${cp}']`);
      await expect(cell).toHaveAttribute("data-winner", "donor-0");
      await expect(cell).toHaveAttribute("data-via", "rule-1");
      await expect(cell).toHaveAttribute("data-kind", "fill");
    }
    // Outside the selection nothing changed (the seeded zh_cn preset —
    // complete rule 0 — supplies its scope's codepoints, donor-filled).
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+4E30']"),
    ).toHaveAttribute("data-via", "rule-0");
  });

  /* --------------------------------------------------------------- */
  /* Non-contiguous selections apply as per-codepoint rules.           */
  /* --------------------------------------------------------------- */

  test("a scattered selection applies as per-codepoint rules", async ({ page }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);
    await gotoCjkPage(page);
    await enterMultiMode(page);

    const gridBefore = await collectGrid(page);

    // Two separate painted runs; the second starts on an unselected
    // cell, so toggle-paint ADDS it to the selection.
    await paintDrag(page, ["U+4E10", "U+4E11"]);
    await paintDrag(page, ["U+4E15", "U+4E16"]);
    await expect(page.locator("[data-role='batch-count']")).toHaveText("已选 4 个");

    // The whole selection is non-contiguous: per-codepoint rules.
    await pointerClick(page, page.locator("[data-role='batch-donor']"));

    // Four codepoint rules, numbered in ascending declaration order
    // (after the boot-seeded zh_cn preset, complete rule 0).
    const expectedVia: Record<string, string> = {
      "U+4E10": "rule-1",
      "U+4E11": "rule-2",
      "U+4E15": "rule-3",
      "U+4E16": "rule-4",
    };
    for (const [cp, via] of Object.entries(expectedVia)) {
      const cell = page.locator(`.charmap-grid .kit-cell[data-cp='${cp}']`);
      await expect(cell).toHaveAttribute("data-winner", "donor-0");
      await expect(cell).toHaveAttribute("data-via", via);
      await expect(cell).toHaveAttribute("data-kind", "fill");
    }
    // The dashed summary counts the four single-character overrides.
    await expect(page.locator("[data-role='rule-solo']")).toHaveText(/单个字符4/);

    // And the same Ctrl+Z round-trip: the grid returns exactly.
    await page.keyboard.press("Control+z");
    expect(await collectGrid(page)).toEqual(gridBefore);
    await expect(page.locator("[data-role='rule-solo']")).toHaveCount(0);
  });

  /* --------------------------------------------------------------- */
  /* Selection undo steps back one gesture at a time.                  */
  /* --------------------------------------------------------------- */

  test("selection undo steps back one gesture at a time", async ({ page }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);
    await gotoCjkPage(page);
    await enterMultiMode(page);

    // Gesture 1: a painted run of three.
    await paintDrag(page, ["U+4E10", "U+4E11", "U+4E12"]);
    await expect(page.locator("[data-role='batch-count']")).toHaveText("已选 3 个");

    // Gesture 2: a shift-click extension from the paint anchor.
    await page.keyboard.down("Shift");
    await pointerClick(
      page,
      page.locator(".charmap-grid .kit-cell[data-cp='U+4E20']"),
    );
    await page.keyboard.up("Shift");
    await expect(page.locator("[data-role='batch-count']")).toHaveText("已选 17 个");

    // One undo reverts the extension, not the paint.
    await pointerClick(page, page.locator("[data-role='undo-pick']"));
    await expect(page.locator("[data-role='batch-count']")).toHaveText("已选 3 个");
    for (const cp of ["U+4E10", "U+4E12"]) {
      await expect(
        page.locator(`.charmap-grid .kit-cell[data-cp='${cp}']`),
      ).toHaveClass(SEL);
    }
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+4E20']"),
    ).not.toHaveClass(SEL);

    // A second undo reverts the paint itself.
    await pointerClick(page, page.locator("[data-role='undo-pick']"));
    await expect.poll(() => selectionCount(page)).toBe(0);
    await expect(page.locator("[data-role='batch-count']")).toBeHidden();
  });

  /* --------------------------------------------------------------- */
  /* The whole-merge stats bar.                                        */
  /* --------------------------------------------------------------- */

  test("the stats bar reports whole-merge totals that never follow the category", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);

    // The whole-merge universe: the picks' union coverage (base A–Z =
    // 26 winners; donor A–F ⊂ base + U+4E00..U+4E3F = 64 winners) plus
    // the declared zh_cn scope's gaps (6,765 − the 44 the donor covers
    // of it) — identical from every browsing category.
    await gotoCjkPage(page);
    await expect(page.locator("[data-stat='total']")).toHaveText("6,811");
    await expect(page.locator("[data-stat='en']")).toHaveText("26");
    await expect(page.locator("[data-stat='cjk']")).toHaveText("64");
    await expect(page.locator("[data-stat='adjusted']")).toHaveText("0");
    await expect(page.locator("[data-stat='missing']")).toHaveText("6,721");
    await expect(page.locator("[data-stat='coverage']")).toHaveText("1.32");

    // Basic Latin: the SAME totals (the prototype's counters never
    // change with the browsing category).
    await pointerClick(
      page,
      page.locator(".kit-cat-g[data-group='latin-europe']"),
    );
    await pointerClick(
      page,
      page.locator(".kit-cat-s[data-block='basic-latin']"),
    );
    await expect(page.locator("[data-stat='total']")).toHaveText("6,811");
    await expect(page.locator("[data-stat='missing']")).toHaveText("6,721");

    // The toolbar's 撤销 is the rule undo's click entry point: the
    // 按编码指定 popup adds one rule, the undo reverts it.
    await expect(page.locator("[data-role='undo']")).toBeDisabled();
    await pointerClick(page, page.locator("[data-role='range-specify']"));
    const rangePop = page.locator("[data-range-popup]");
    await expect(rangePop).toBeVisible();
    await rangePop.locator("[data-role='range-start']").fill("0x41");
    await rangePop.locator("[data-role='range-end']").fill("");
    await pointerClick(page, rangePop.locator("[data-role='range-add']"));
    await expect.poll(() => summaryRowCount(page)).toBe(1);
    await expect(page.locator("[data-role='undo']")).toBeEnabled();
    await pointerClick(page, page.locator("[data-role='undo']"));
    await expect.poll(() => summaryRowCount(page)).toBe(0);
    await expect(page.locator("[data-role='undo']")).toBeDisabled();
  });

  /* --------------------------------------------------------------- */
  /* Leaving 多选 mode clears the selection and its undo stack.        */
  /* --------------------------------------------------------------- */

  test("leaving 多选 mode clears the selection; the popup returns", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);
    await gotoCjkPage(page);
    await enterMultiMode(page);

    await paintDrag(page, ["U+4E10", "U+4E11"]);
    await expect(page.locator("[data-role='batch-count']")).toHaveText("已选 2 个");

    // While the selection exists the toolbar shows the batch variant
    // (no 多选 button) — 取消 clears the picks first, then the toggle
    // (still pressed) exits the mode, clearing the undo history too.
    await pointerClick(page, page.locator("[data-role='batch-clear']"));
    await expect.poll(() => selectionCount(page)).toBe(0);
    await expect(page.locator("[data-role='toggle-multi']")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await pointerClick(page, page.locator("[data-role='toggle-multi']"));
    await expect(page.locator("[data-role='toggle-multi']")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect.poll(() => selectionCount(page)).toBe(0);
    await expect(page.locator("[data-role='batch-count']")).toBeHidden();

    // Outside the mode a plain click opens the char popup again, and
    // drag gestures no longer paint.
    await pointerClick(
      page,
      page.locator(".charmap-grid .kit-cell[data-cp='U+4E10']"),
    );
    await expect(page.locator("[data-char-popup]")).toBeVisible();
    await paintDrag(page, ["U+4E12", "U+4E13"]);
    await expect.poll(() => selectionCount(page)).toBe(0);
  });
});
