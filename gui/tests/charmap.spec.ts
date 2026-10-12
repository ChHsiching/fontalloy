import { test, expect } from "@playwright/test";
import {
  assertNoJsErrors,
  collectJsErrors,
  pointerClick,
  waitForFontsReady,
} from "./helpers";
import {
  ALL_CATEGORY_ID,
  categorySize,
  nthCodepoint,
} from "../src/unicode/blocks";

/** Hex label of a codepoint, the grid's data-cp vocabulary. */
const label = (cp: number): string =>
  `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;

test.describe("character map", () => {
  const jsErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    jsErrors.length = 0;
    collectJsErrors(page, jsErrors);
    await page.goto("/");
    await waitForFontsReady(page);
  });

  test.afterEach(() => assertNoJsErrors(jsErrors));

  /** The live grid geometry: column count + the full-page cell count. */
  async function gridGeometry(page: import("@playwright/test").Page): Promise<{
    columns: number;
    pageSize: number;
  }> {
    return page.evaluate(() => {
      const grid = document.querySelector<HTMLElement>(".kit-grid")!;
      const tracks = getComputedStyle(grid).gridTemplateColumns
        .trim()
        .split(/\s+/).length;
      const cells = grid.querySelectorAll(".kit-cell").length;
      return { columns: tracks, pageSize: cells };
    });
  }

  test("aggregate view: full pages in whole rows, pager and locate work", async ({
    page,
  }) => {
    // Round 5: pages hold a whole number of ROWS (a multiple of the
    // live column count, capped at 1024), and the browsable universe is
    // the VISIBLE codepoints (0x21 first — U+0020 is a separator).
    const size = categorySize(ALL_CATEGORY_ID);
    const { columns, pageSize } = await gridGeometry(page);
    expect(columns).toBeGreaterThan(0);
    expect(pageSize).toBe(Math.min(Math.floor(1024 / columns) * columns, size));
    expect(pageSize % columns).toBe(0);

    const pages = Math.ceil(size / pageSize);
    const pagerText = page.locator(".kit-toolrow [data-pager-label]");
    await expect(pagerText).toHaveText(`第 1/${pages} 页`);
    await expect(page.locator(".charmap-grid .kit-cell")).toHaveCount(pageSize);
    await expect(page.locator(".charmap-grid .kit-cell").first()).toHaveAttribute(
      "data-cp",
      label(nthCodepoint(ALL_CATEGORY_ID, 0)),
    );

    // Next page via real pointer click: still exactly full.
    await pointerClick(
      page,
      page.locator(".kit-toolrow .kit-pgc button[aria-label='下一页']"),
    );
    await expect(pagerText).toHaveText(`第 2/${pages} 页`);
    await expect(page.locator(".charmap-grid .kit-cell")).toHaveCount(pageSize);
    await expect(page.locator(".charmap-grid .kit-cell").first()).toHaveAttribute(
      "data-cp",
      label(nthCodepoint(ALL_CATEGORY_ID, pageSize)),
    );

    // The locator jumps to the last page by codepoint (Enter commits).
    const last = nthCodepoint(ALL_CATEGORY_ID, size - 1);
    const locate = page.locator(".kit-toolrow [data-role='locate']");
    await locate.fill(last.toString(16));
    await locate.press("Enter");
    await expect(pagerText).toHaveText(`第 ${pages}/${pages} 页`);
    // The final page holds exactly the remainder — no empty slots.
    await expect(page.locator(".charmap-grid .kit-cell")).toHaveCount(
      size - (pages - 1) * pageSize,
    );
    await expect(page.locator(".charmap-grid .kit-cell").last()).toHaveAttribute(
      "data-cp",
      label(last),
    );

    // Locating the very last scalar value stays clamped on the last page.
    await locate.fill(`U+${last.toString(16).toUpperCase()}`);
    await locate.press("Enter");
    await expect(pagerText).toHaveText(`第 ${pages}/${pages} 页`);
  });

  test("invisible codepoints never render as blank cells", async ({ page }) => {
    // Round 5, owner item 1: the prototype's hand-curated blocks contain
    // no control/format/separator/unassigned codepoints — the browsable
    // ranges exclude them (U+0020, U+007F–U+00A0 & co are absent, and
    // the first aggregate cell is U+0021).
    await pointerClick(
      page,
      page.locator(".kit-cat-g[data-group='latin-europe']"),
    );
    await pointerClick(
      page,
      page.locator(".kit-cat-s[data-block='basic-latin']"),
    );
    // 0x21..0x7E: space and DEL are gone; every remaining cell has ink.
    await expect(page.locator(".charmap-grid .kit-cell")).toHaveCount(94);
    await expect(page.locator(".charmap-grid .kit-cell[data-cp='U+0020']")).toHaveCount(0);
    await expect(page.locator(".charmap-grid .kit-cell[data-cp='U+007F']")).toHaveCount(0);

    await pointerClick(page, page.locator(".kit-cat-s[data-block='latin-1']"));
    // 0xA1..0xFF: C1 controls and NBSP never show as blanks.
    await expect(page.locator(".charmap-grid .kit-cell")).toHaveCount(94);
    await expect(page.locator(".charmap-grid .kit-cell[data-cp='U+00A0']")).toHaveCount(0);
    await expect(page.locator(".charmap-grid .kit-cell[data-cp='U+0085']")).toHaveCount(0);
    await expect(page.locator(".charmap-grid .kit-cell").first()).toHaveAttribute(
      "data-cp",
      "U+00A1",
    );

    // A query for an invisible codepoint is a silent no-op: the grid
    // stays put (prototype parity for unknown characters).
    const before = await page.evaluate(
      () => document.querySelectorAll(".charmap-grid .kit-cell").length,
    );
    const locate = page.locator(".kit-toolrow [data-role='locate']");
    await locate.fill("U+0007");
    await locate.press("Enter");
    await expect(
      page.locator(".kit-toolrow [data-pager-label]"),
    ).toBeHidden(); // single-page block keeps the pager hidden
    expect(
      await page.evaluate(
        () => document.querySelectorAll(".charmap-grid .kit-cell").length,
      ),
    ).toBe(before);
  });

  test("the chip bar's two levels coexist with the aggregate view", async ({
    page,
  }) => {
    const { pageSize } = await gridGeometry(page);
    // Pick the CJK group, then the unified ideographs block chip.
    await pointerClick(page, page.locator(".kit-cat-g[data-group='cjk']"));
    await expect(page.locator(".kit-cat-s[data-block='g:cjk']")).toHaveClass(/on/);
    await pointerClick(
      page,
      page.locator(".kit-cat-s[data-block='cjk-unified']"),
    );

    await expect(page.locator(".kit-toolrow [data-pager-label]")).toHaveText(
      `第 1/${Math.ceil(categorySize("cjk-unified") / pageSize)} 页`,
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
      `第 1/${Math.ceil(categorySize(ALL_CATEGORY_ID) / pageSize)} 页`,
    );
    await expect(page.locator(".charmap-grid .kit-cell").first()).toHaveAttribute(
      "data-cp",
      label(nthCodepoint(ALL_CATEGORY_ID, 0)),
    );
    // Back in the group, its aggregate chip (g:cjk) browses the union.
    await pointerClick(page, page.locator(".kit-cat-g[data-group='cjk']"));
    await expect(page.locator(".kit-toolrow [data-pager-label]")).toHaveText(
      `第 1/${Math.ceil(categorySize("g:cjk") / pageSize)} 页`,
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

  test("the 图标 group carries the eight publisher sub-blocks (round 7)", async ({
    page,
  }) => {
    const SUBS = [
      "nf-powerline",
      "nf-seti-devicons",
      "nf-codicons",
      "nf-fontawesome",
      "nf-fontlogos",
      "nf-octicons",
      "nf-material",
      "nf-misc",
    ] as const;
    await pointerClick(page, page.locator(".kit-cat-g[data-group='icons']"));
    // The round-6 single "Nerd Font" chip is gone; every publisher
    // macro-block has its own chip.
    await expect(
      page.locator(".kit-cat-s[data-block='nf-icons']"),
    ).toHaveCount(0);
    for (const id of SUBS) {
      await expect(
        page.locator(`.kit-cat-s[data-block='${id}']`),
      ).toHaveCount(1);
    }

    // A sub-block enumerates its curated intervals, not its hull:
    // Powerline starts at U+E0A0 (the E000–E00A Pomicons stay in 杂项),
    // and its six disjoint intervals count 40 visible cells.
    await pointerClick(
      page,
      page.locator(".kit-cat-s[data-block='nf-powerline']"),
    );
    await expect(page.locator(".charmap-grid .kit-cell")).toHaveCount(
      categorySize("nf-powerline"),
    );
    expect(categorySize("nf-powerline")).toBe(40);
    await expect(page.locator(".charmap-grid .kit-cell").first()).toHaveAttribute(
      "data-cp",
      "U+E0A0",
    );

    // Font Awesome's hull overlaps three neighbors (E200–E2A9 wraps the
    // Powerline/杂项 gap); its enumeration starts at its own E200
    // allocation and never lists a neighbor's codepoint.
    await pointerClick(
      page,
      page.locator(".kit-cat-s[data-block='nf-fontawesome']"),
    );
    await expect(page.locator(".charmap-grid .kit-cell").first()).toHaveAttribute(
      "data-cp",
      "U+E200",
    );
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+E5FA']"),
    ).toHaveCount(0); // Seti's first codepoint is never Font Awesome's

    // Material browses the Supplementary PUA-A plane — surrogate-pair
    // codepoints the grid renders like the emoji plane.
    await pointerClick(
      page,
      page.locator(".kit-cat-s[data-block='nf-material']"),
    );
    await expect(page.locator(".charmap-grid .kit-cell").first()).toHaveAttribute(
      "data-cp",
      "U+F0001",
    );
    await expect(
      page.locator(".kit-toolrow [data-pager-label]"),
    ).toBeVisible(); // 6,896 cells — multiple pages
  });
});
