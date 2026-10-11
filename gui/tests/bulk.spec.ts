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
 * Issue #20: multi-select, batch operations, undo, and the live stats bar.
 *
 * - Drag-paint (real pointer drag over cells) and shift-range (anchor +
 *   shift-click extends) build a multi-selection, visually distinct from
 *   hover (neutral) and from the details cursor (accent ring).
 * - One batch apply commits a precedence choice for the WHOLE selection:
 *   a contiguous selection becomes one range rule; anything else becomes
 *   per-codepoint rules (the plan is stated in plain text before apply).
 * - Two undo stacks with separate entry points: 撤销选择 (selection) and
 *   撤销规则 / Ctrl+Z (rules).
 * - The centerpiece: a bulk edit followed by undo returns the app to the
 *   prior state EXACTLY — rules state, grid winners, stats.
 */

/** The multi-selection cell class (kit vocabulary; the cursor is `cur`). */
const SEL = /(?:^|\s)sel(?:\s|$)/;

/** The count of COMPLETE rules, read from the rail's rule rows. */
async function completeRuleCount(page: Page): Promise<number> {
  return page.evaluate(
    () => document.querySelectorAll("[data-rule-id][data-complete='true']").length,
  );
}

/** The number of multi-selected cells on the current grid page. */
async function selectionCount(page: Page): Promise<number> {
  return page.locator(".charmap-grid .kit-cell.sel").count();
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
   * Real-pointer drag-paint across the named cells: hit-test-guarded mouse
   * down on the first, moves over the rest, up on the last. Each point is
   * computed lazily — the drag's own store patches re-render the details
   * strip (hint → editor), which shifts the grid, so precomputed boxes
   * would go stale mid-gesture. With `additive`, Ctrl is held so the run
   * joins the existing selection.
   */
  async function paintDrag(
    page: Page,
    cps: string[],
    additive = false,
  ): Promise<void> {
    if (additive) await page.keyboard.down("Control");
    try {
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
    } finally {
      if (additive) await page.keyboard.up("Control");
    }
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
    await expect.poll(() => completeRuleCount(page)).toBe(0);
    await expect(page.locator(".rule-list-empty")).toBeVisible();

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

    // The batch editor states the plan in plain text (no hover-only info).
    const editor = page.locator("[data-role='batch-editor']");
    await expect(editor).toBeVisible();
    await expect(editor).toContainText("已选 4 码位");
    await expect(editor.locator("[data-role='batch-plan']")).toHaveText(
      "将创建 1 条区间规则（0x4E10-0x4E13）",
    );

    // Donor-only precedence for the whole selection, in ONE action.
    await editor.locator("[data-role='batch-font-base']").uncheck();
    await pointerClick(page, editor.locator("[data-role='batch-apply']"));

    // One range rule in the rail; every selected cell resolves through it.
    const row = page.locator("[data-role='custom-rule']").first();
    await expect(row).toContainText("0x4E10-0x4E13");
    await expect.poll(() => completeRuleCount(page)).toBe(1);
    for (const cp of run) {
      const cell = page.locator(`.charmap-grid .kit-cell[data-cp='${cp}']`);
      await expect(cell).toHaveAttribute("data-winner", "donor-0");
      await expect(cell).toHaveAttribute("data-via", "rule-0");
      await expect(cell).toHaveAttribute("data-kind", "fill");
    }
    expect(await collectGrid(page)).not.toEqual(gridBefore);

    // A record of the feature: the painted selection + batch editor.
    const { mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(process.cwd(), "test-results", "screenshots");
    mkdirSync(dir, { recursive: true });
    await page.screenshot({
      path: join(dir, "bulk-batch-editor.png"),
      animations: "disabled",
    });

    // Ctrl+Z (rule undo): everything rule-related returns EXACTLY.
    await page.keyboard.press("Control+z");
    expect(await collectGrid(page)).toEqual(gridBefore);
    expect(await page.locator(".statsbar").textContent()).toBe(statsBefore);
    await expect.poll(() => completeRuleCount(page)).toBe(0);
    await expect(page.locator(".rule-list-empty")).toBeVisible();
    // Rule undo never touches the selection itself.
    await expect(page.locator("[data-role='batch-count']")).toHaveText("已选 4 个");
    for (const cp of run) {
      await expect(
        page.locator(`.charmap-grid .kit-cell[data-cp='${cp}']`),
      ).toHaveClass(SEL);
    }

    // Selection undo is the OTHER stack, with its own click entry point.
    await pointerClick(page, page.locator("[data-role='selection-undo']"));
    await expect.poll(() => selectionCount(page)).toBe(0);
    await expect(page.locator("[data-role='batch-editor']")).toBeHidden();
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

    // The plan names the one range rule the apply will create.
    const editor = page.locator("[data-role='batch-editor']");
    await expect(editor.locator("[data-role='batch-plan']")).toHaveText(
      "将创建 1 条区间规则（0x4E20-0x4E28）",
    );

    // Apply with the default list [base, donor-0]: the base holds no CJK,
    // so the donor fills every selected codepoint via the new rule.
    await pointerClick(page, editor.locator("[data-role='batch-apply']"));
    await expect.poll(() => completeRuleCount(page)).toBe(1);
    for (const cp of ["U+4E20", "U+4E24", "U+4E28"]) {
      const cell = page.locator(`.charmap-grid .kit-cell[data-cp='${cp}']`);
      await expect(cell).toHaveAttribute("data-winner", "donor-0");
      await expect(cell).toHaveAttribute("data-via", "rule-0");
      await expect(cell).toHaveAttribute("data-kind", "fill");
    }
    // Outside the selection nothing changed.
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+4E30']"),
    ).toHaveAttribute("data-via", "default");

    // Clearing the selection is one click and leaves the rules alone.
    await pointerClick(page, editor.locator("[data-role='selection-clear']"));
    await expect.poll(() => selectionCount(page)).toBe(0);
    await expect.poll(() => completeRuleCount(page)).toBe(1);
  });

  /* --------------------------------------------------------------- */
  /* Non-contiguous selections apply as per-codepoint rules.           */
  /* --------------------------------------------------------------- */

  test("a scattered selection applies as per-codepoint rules", async ({ page }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);
    await gotoCjkPage(page);

    const gridBefore = await collectGrid(page);

    // Two separate painted runs (the second joins with Ctrl held).
    await paintDrag(page, ["U+4E10", "U+4E11"]);
    await paintDrag(page, ["U+4E15", "U+4E16"], true);
    await expect(page.locator("[data-role='batch-count']")).toHaveText("已选 4 个");

    // The whole selection is non-contiguous: per-codepoint entries.
    const editor = page.locator("[data-role='batch-editor']");
    await expect(editor).toContainText("已选 4 码位");
    await expect(editor.locator("[data-role='batch-plan']")).toHaveText(
      "将创建 4 条码位规则",
    );

    // Donor-only, one action.
    await editor.locator("[data-role='batch-font-base']").uncheck();
    await pointerClick(page, editor.locator("[data-role='batch-apply']"));

    // Four codepoint rules, numbered in ascending declaration order.
    await expect.poll(() => completeRuleCount(page)).toBe(4);
    const expectedVia: Record<string, string> = {
      "U+4E10": "rule-0",
      "U+4E11": "rule-1",
      "U+4E15": "rule-2",
      "U+4E16": "rule-3",
    };
    for (const [cp, via] of Object.entries(expectedVia)) {
      const cell = page.locator(`.charmap-grid .kit-cell[data-cp='${cp}']`);
      await expect(cell).toHaveAttribute("data-winner", "donor-0");
      await expect(cell).toHaveAttribute("data-via", via);
      await expect(cell).toHaveAttribute("data-kind", "fill");
    }

    // And the same Ctrl+Z round-trip: the grid returns exactly.
    await page.keyboard.press("Control+z");
    expect(await collectGrid(page)).toEqual(gridBefore);
    await expect.poll(() => completeRuleCount(page)).toBe(0);
  });

  /* --------------------------------------------------------------- */
  /* Selection undo steps back one gesture at a time.                  */
  /* --------------------------------------------------------------- */

  test("selection undo steps back one gesture at a time", async ({ page }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);
    await gotoCjkPage(page);

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
    await pointerClick(page, page.locator("[data-role='selection-undo']"));
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
    await pointerClick(page, page.locator("[data-role='selection-undo']"));
    await expect.poll(() => selectionCount(page)).toBe(0);
    await expect(page.locator("[data-role='batch-editor']")).toBeHidden();
  });

  /* --------------------------------------------------------------- */
  /* The live stats bar.                                               */
  /* --------------------------------------------------------------- */

  test("the stats bar shows live per-category coverage and selection counts", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);

    // CJK unified ideographs: only the donor covers them (64 codepoints)
    // — the six counters scope to the active category.
    await gotoCjkPage(page);
    await expect(page.locator("[data-stat='total']")).toHaveText("20,992");
    await expect(page.locator("[data-stat='cjk']")).toHaveText("64");
    await expect(page.locator("[data-stat='missing']")).toHaveText("20,928");
    await expect(page.locator("[data-stat='coverage']")).toHaveText("0.30");

    // Basic Latin: the base covers A–Z (26); the donor's A–F is a subset.
    await pointerClick(
      page,
      page.locator(".kit-cat-g[data-group='latin-europe']"),
    );
    await pointerClick(
      page,
      page.locator(".kit-cat-s[data-block='basic-latin']"),
    );
    await expect(page.locator("[data-stat='total']")).toHaveText("96");
    await expect(page.locator("[data-stat='en']")).toHaveText("26");
    await expect(page.locator("[data-stat='missing']")).toHaveText("70");

    // The selection is live through paint and clear (已选 in the toolbar).
    await paintDrag(page, ["U+0041", "U+0042"]);
    await expect(page.locator("[data-role='batch-count']")).toHaveText("已选 2 个");
    await pointerClick(
      page,
      page.locator("[data-role='selection-clear']"),
    );
    await expect.poll(() => selectionCount(page)).toBe(0);

    // The rule count is live as rules land and revert.
    await pointerClick(page, page.locator("[data-role='add-range-rule']"));
    const row = page.locator("[data-role='custom-rule']").first();
    const id = await row.getAttribute("data-rule-id");
    await row.locator(`[data-role='rule-start-${id}']`).fill("0x0041");
    await row.locator(`[data-role='rule-end-${id}']`).fill("0x0046");
    await expect.poll(() => completeRuleCount(page)).toBe(1);
    await page.keyboard.press("Control+z");
    await expect.poll(() => completeRuleCount(page)).toBe(0);
  });

  /* --------------------------------------------------------------- */
  /* Rule undo's click entry point covers every kind of rule edit.     */
  /* --------------------------------------------------------------- */

  test("rule undo is click-reachable in the rail and reverts rule edits", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);

    // A rail range rule reverts step by step with the rail button.
    await pointerClick(page, page.locator("[data-role='add-range-rule']"));
    const row = page.locator("[data-role='custom-rule']").first();
    const id = await row.getAttribute("data-rule-id");
    await row.locator(`[data-role='rule-start-${id}']`).fill("0x0041");
    await row.locator(`[data-role='rule-end-${id}']`).fill("0x0046");
    await expect(page.locator(".charmap-grid .kit-cell[data-cp='U+0041']")).toHaveAttribute(
      "data-via",
      "rule-0",
    );

    // Undo walks back one mutation at a time: the end fill, then the
    // start fill, then the add itself.
    await pointerClick(page, page.locator("[data-role='rules-undo']"));
    await expect.poll(() => completeRuleCount(page)).toBe(0);
    await expect(page.locator("[data-role='custom-rule']")).toBeVisible();
    await pointerClick(page, page.locator("[data-role='rules-undo']"));
    await expect(page.locator("[data-role='custom-rule']")).toBeVisible();
    await pointerClick(page, page.locator("[data-role='rules-undo']"));
    await expect(page.locator(".rule-list-empty")).toBeVisible();
    await expect(page.locator(".charmap-grid .kit-cell[data-cp='U+0041']")).toHaveAttribute(
      "data-via",
      "default",
    );

    // The single-cell editor's applies undo through the same stack.
    await pointerClick(
      page,
      page.locator(".charmap-grid .kit-cell[data-cp='U+0041']"),
    );
    const editor = page.locator("[data-role='cp-rule-editor']");
    await editor.locator("[data-role='cp-font-base']").uncheck();
    await pointerClick(page, editor.locator("[data-role='cp-rule-apply']"));
    await expect(page.locator(".charmap-grid .kit-cell[data-cp='U+0041']")).toHaveAttribute(
      "data-winner",
      "donor-0",
    );
    await pointerClick(page, page.locator("[data-role='rules-undo']"));
    await expect(page.locator(".charmap-grid .kit-cell[data-cp='U+0041']")).toHaveAttribute(
      "data-winner",
      "base",
    );
    await expect(page.locator(".charmap-grid .kit-cell[data-cp='U+0041']")).toHaveAttribute(
      "data-via",
      "default",
    );
  });
});
