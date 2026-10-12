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
  realCatalogFontPaths,
  waitForFontsReady,
} from "./helpers";

/**
 * Design-fidelity repair (prototype parity): the ActionBar's rule-state
 * wiring (per-block and per-group assignment as exact range rules), the
 * 按编码指定 range popup contract, the toolbar's batch variant (多选
 * mode), the char popup at the cell, the 编码 codepoint rows, the
 * missing-cell codepoint, and the single-character locator.
 */

/** The count of human summary rows in the 自定义规则 section. */
async function summaryRowCount(page: Page): Promise<number> {
  return page.locator("[data-role='rule-row']").count();
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
      // Round 4: a successful local load CLOSES the picker (prototype
      // parity — the closed card now shows the new pick).
      await expect(popup).toBeHidden();
    }
  }

  test("the block segment assigns a whole block as one exact range rule", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);

    // Basic Latin (U+0020..U+007F): its segment shows on the block view.
    // (The block's label sits beside the segment; the group segment's
    // 全用… buttons must not be confused with the block's 用… ones.)
    await pointerClick(page, page.locator(".kit-cat-g[data-group='latin-europe']"));
    await pointerClick(page, page.locator(".kit-cat-s[data-block='basic-latin']"));
    const row = page.locator(".kit-toolrow").filter({ hasText: "基本拉丁" });
    const blockButton = (label: string) =>
      row.locator(".kit-mseg button", { hasText: new RegExp(`^${label}$`) });
    // No explicit assignment yet — but the DEFAULT side shows pressed
    // (prototype parity: its chips read the block default too; here the
    // base font keeps every covered codepoint of the block).
    await expect(blockButton("用英文")).toHaveAttribute("aria-pressed", "true");
    await expect(blockButton("用中文")).toHaveAttribute("aria-pressed", "false");
    // The pressed block chip carries the SAME carried-side treatment as
    // the group chips: bold + the accent token.
    const blockCarried = await blockButton("用英文").evaluate((el) => ({
      color: getComputedStyle(el).color,
      weight: getComputedStyle(el).fontWeight,
    }));
    const blockAccent = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--ac)";
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    expect(blockCarried.color).toBe(blockAccent);
    expect(blockCarried.weight).toBe("600");

    // Assign the whole block to the donor: one exact range rule, one
    // human summary sentence.
    await pointerClick(page, blockButton("用中文"));
    await expect.poll(() => summaryRowCount(page)).toBe(1);
    const blockRow = page.locator(
      "[data-role='rule-row'][data-kind='block']",
    );
    await expect(blockRow).toHaveText(/基本拉丁用中文字体/);
    // The donor holds A–F: those flip to the override winner.
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+0041']"),
    ).toHaveAttribute("data-winner", "donor-0");
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+0041']"),
    ).toHaveAttribute("data-kind", "override");
    // The pressed state follows the assignment.
    await expect(blockButton("用中文")).toHaveAttribute("aria-pressed", "true");

    // Pressing the carried side again reverts to default (rule removed)
    // — exactly what the row's own delete × does too.
    await pointerClick(page, blockButton("用中文"));
    await expect.poll(() => summaryRowCount(page)).toBe(0);
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+0041']"),
    ).toHaveAttribute("data-winner", "base");
    // ...and the pressed state falls back to the DEFAULT side.
    await expect(blockButton("用英文")).toHaveAttribute("aria-pressed", "true");

    // The row's delete × removes the assignment the same way.
    await pointerClick(page, blockButton("用中文"));
    await expect.poll(() => summaryRowCount(page)).toBe(1);
    await pointerClick(page, page.locator("[data-role='remove-rule']").first());
    await expect.poll(() => summaryRowCount(page)).toBe(0);
  });

  test("the block segment renders (unpressed) before both fonts are picked", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForFontsReady(page);

    // Prototype parity (inv. 34/35): the assignment segments exist from
    // the first paint — the defaults drive them, and pre-pick nothing is
    // pressed (no coverages to vote). The block view shows the segment,
    // not the passive count note.
    await pointerClick(page, page.locator(".kit-cat-g[data-group='latin-europe']"));
    await pointerClick(page, page.locator(".kit-cat-s[data-block='basic-latin']"));
    const row = page.locator(".kit-toolrow").filter({ hasText: "基本拉丁" });
    await expect(
      row.locator(".kit-mseg button").filter({ hasText: /^用英文$/ }),
    ).toBeVisible();
    await expect(
      row.locator(".kit-mseg button").filter({ hasText: /^用英文$/ }),
    ).toHaveAttribute("aria-pressed", "false");
    await expect(
      row.locator(".kit-mseg button").filter({ hasText: /^用中文$/ }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  for (const width of [1440, 1280]) {
    test(`the toolbar stays one row at ${width}px with the longest real labels`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 940 });
      const fonts = await makeLocalFixtures();
      await openWithFonts(page, fonts);

      // Round 4: the assign segments carry the SHORT labels (全用英文 /
      // 用中文 …) with the full sentence in title/aria-label — the row
      // must hold one line even at the narrow target width. (Asserted
      // on a GROUP view, where the segments exist.)
      await pointerClick(page, page.locator(".kit-cat-g[data-group='latin-europe']"));
      await pointerClick(
        page,
        page.locator(".kit-cat-s[data-block='ipa']").first(),
      );
      const seg = page.locator(".kit-toolrow .kit-assign button");
      await expect(seg.filter({ hasText: /^全用英文$/ })).toHaveAttribute(
        "title",
        "全部用英文字体",
      );
      await expect(seg.filter({ hasText: /^用中文$/ })).toHaveAttribute(
        "title",
        "用中文字体",
      );

      // The two widest real toolrows: the longest GROUP label + its
      // longest block (拉丁与欧洲文字 · 国际音标扩展), and the CJK group +
      // unified-ideographs block (group segment + pager + legend +
      // locator + 按编码指定).
      for (const [group, block] of [
        ["latin-europe", "ipa"],
        ["cjk", "cjk-unified"],
      ] as const) {
        await pointerClick(page, page.locator(`.kit-cat-g[data-group='${group}']`));
        await pointerClick(
          page,
          page.locator(`.kit-cat-s[data-block='${block}']`).first(),
        );
        const metrics = await page.evaluate(() => {
          const row = document.querySelector(".kit-toolrow");
          if (!row) throw new Error("no toolrow");
          // Single row = the row's height is one cluster tall (the mseg
          // tray is 32px + 12px padding + border; a wrap would double it)
          // and nothing spills past the row's right edge.
          return {
            height: row.offsetHeight,
            overflow: row.scrollWidth - row.clientWidth,
            label: row.querySelector(".kit-lab").textContent,
          };
        });
        // One row, nothing clipped: 按编码指定 never orphans onto line 2.
        expect(metrics.height, `${metrics.label}@${width}`).toBeLessThanOrEqual(46);
        expect(metrics.overflow, `${metrics.label}@${width}`).toBeLessThanOrEqual(1);
      }
    });
  }

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

    // The DEFAULT side renders pressed (the donor alone covers the CJK
    // blocks) — with the carried-side treatment: bold + accent, the
    // block chips' own pressed look (the boot/workspace-frame parity).
    await expect(groupButton("全用中文")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(groupButton("全用英文")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    const accent = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--ac)";
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    const carried = await groupButton("全用中文").evaluate((el) => ({
      color: getComputedStyle(el).color,
      weight: getComputedStyle(el).fontWeight,
    }));
    expect(carried.color).toBe(accent);
    expect(carried.weight).toBe("600");

    await pointerClick(page, groupButton("全用英文"));
    // Every block of the group carries the same side — the summary
    // list MERGES them into one parent sentence (prototype parity).
    await expect.poll(() => summaryRowCount(page)).toBe(1);
    await expect(
      page.locator("[data-role='rule-row'][data-kind='group']"),
    ).toHaveText(/所有中日韩文字字符用英文字体/);
    await expect(groupButton("全用英文")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // One Ctrl+Z reverts the whole group assignment.
    await page.keyboard.press("Control+z");
    await expect.poll(() => summaryRowCount(page)).toBe(0);
  });

  // Round 6, owner item 4 — the P0: with the REAL catalog pair
  // (JetBrainsMono Nerd Font base, Maple Mono donor) the base covers
  // ~nothing of the CJK group, so a base-side assignment used to leave
  // the grid looking dead (absence never overrides kept every winner
  // at the default and the old adjusted discipline compared winners).
  // The assignment now carries the [side, other] preference list (the
  // rule supplies through the donor: via credits it). Round 8: the ov
  // dot keys on the EFFECTIVE winner (see precedence/resolve.ts
  // isAdjusted) — a declaration whose font lacks the codepoint never
  // moves the winner, so such cells carry no dot (the dot = 实际生效).
  test("the CJK group assignment visibly rules the grid with the real catalog pair", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const real = realCatalogFontPaths();
    await openWithFonts(page, real);

    await pointerClick(page, page.locator(".kit-cat-g[data-group='cjk']"));
    const groupRow = page
      .locator(".kit-toolrow")
      .filter({ hasText: "所有中日韩文字字符" });
    await expect(groupRow).toBeVisible();
    const groupButton = (label: string) =>
      groupRow.locator(".kit-mseg button", { hasText: new RegExp(`^${label}$`) });

    // Boot state: the donor alone covers the group — 全用中文 pressed,
    // the first visible cell (、U+3001) resolves via the default with
    // no adjusted dot.
    await expect(groupButton("全用中文")).toHaveAttribute("aria-pressed", "true");
    const cell = page.locator(".charmap-grid .kit-cell[data-cp='U+3001']");
    await expect(cell).toHaveAttribute("data-winner", "donor-0");
    await expect(cell).toHaveAttribute("data-via", "default");
    await expect(cell).not.toHaveClass(/ov/);

    // Assign 全用英文 — the rule must visibly take the group.
    await pointerClick(page, groupButton("全用英文"));
    await expect(page.locator("[data-role='rule-row'][data-kind='group']")).toHaveText(
      /所有中日韩文字字符用英文字体/,
    );
    await expect(groupButton("全用英文")).toHaveAttribute("aria-pressed", "true");
    // The grid updates: the covering rule's via — and the winner stays
    // the merge truth (the English font lacks the glyphs; the preference
    // list fills through the Chinese font, exactly what the merge does).
    // Round 8: the winner did NOT change, so no dot — the dot means
    // 实际生效. In fact NO codepoint flips (an English assignment's
    // [base, donor] preference IS the default chain), so the 已调整
    // counter stays at 0.
    await expect(cell).toHaveAttribute("data-via", /rule-\d+/);
    await expect(cell).toHaveAttribute("data-winner", "donor-0");
    await expect(cell).not.toHaveClass(/ov/);
    await expect(page.locator("[data-stat='adjusted']")).toHaveText("0");

    // Assigning the side the group already carries by default writes the
    // rule; only the codepoints BOTH fonts cover flip suppliers (the
    // fullwidth braces the EN base holds) — the donor-only 、 stays
    // undotted while the counter rises.
    await pointerClick(page, groupButton("全用中文"));
    await expect(cell).toHaveAttribute("data-via", /rule-\d+/);
    await expect(cell).not.toHaveClass(/ov/);
    const adjusted = await page.locator("[data-stat='adjusted']").textContent();
    expect(Number((adjusted ?? "0").replace(/,/g, ""))).toBeGreaterThan(0);

    // Two Ctrl+Z revert both assignments (英文 then 中文) to the boot
    // state: the preset default supplies again, no dot.
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+z");
    await expect(cell).toHaveAttribute("data-via", "default");
    await expect(cell).not.toHaveClass(/ov/);
  });

  // Round 6, owner item 3b — jump-to-page: clicking the 第 N/M 页 label
  // turns it into a numeric input; Enter commits clamped, Esc cancels.
  test("the pager label is a jump-to-page input (commit clamped, Esc cancels)", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);

    await pointerClick(page, page.locator(".kit-cat-g[data-group='cjk']"));
    const label = page.locator("[data-pager-label]");
    await expect(label).toContainText(/第 1\/\d+ 页/);
    const last = Number(
      (await label.textContent())!.match(/第 1\/(\d+) 页/)![1],
    );

    // Click the label: the input appears focused, the label hides.
    await pointerClick(page, label);
    const input = page.locator("[data-pager-input]");
    await expect(input).toBeVisible();
    await expect(label).toBeHidden();
    await expect(input).toBeFocused();

    // A way-out number commits clamped to the last page.
    await input.fill("99999");
    await input.press("Enter");
    await expect(label).toBeVisible();
    await expect(label).toHaveText(`第 ${last}/${last} 页`);

    // Zero/negative clamps to the first page; Esc cancels an edit.
    await pointerClick(page, label);
    await input.fill("0");
    await input.press("Enter");
    await expect(label).toHaveText(`第 1/${last} 页`);
    await pointerClick(page, label);
    await input.fill("2");
    await input.press("Escape");
    await expect(label).toBeVisible();
    await expect(label).toHaveText(`第 1/${last} 页`);
  });

  // Round 6, owner item 3a — the pager arrows are inline-SVG chevrons in
  // flex-centered buttons, optically centered with the label (the ‹ ›
  // TEXT glyphs hugged the baseline and read low).
  test("the pager arrows center optically with the label", async ({ page }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);

    await pointerClick(page, page.locator(".kit-cat-g[data-group='cjk']"));
    const metrics = await page.evaluate(() => {
      const pager = document.querySelector(".kit-pgc");
      const label = pager?.querySelector(".kit-num");
      const arrow = pager?.querySelector("button svg");
      if (!pager || !label || !arrow) return null;
      const pr = pager.getBoundingClientRect();
      const lr = label.getBoundingClientRect();
      const ar = arrow.getBoundingClientRect();
      return {
        pagerMid: pr.y + pr.height / 2,
        labelMid: lr.y + lr.height / 2,
        arrowMid: ar.y + ar.height / 2,
      };
    });
    expect(metrics).not.toBeNull();
    expect(Math.abs(metrics!.arrowMid - metrics!.labelMid)).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics!.labelMid - metrics!.pagerMid)).toBeLessThanOrEqual(1);
  });

  test("the 按编码指定 popup follows the prototype contract", async ({ page }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);

    await pointerClick(
      page,
      page.locator(".kit-toolrow [data-role='range-specify']"),
    );
    const popup = page.locator("[data-range-popup]");
    await expect(popup).toBeVisible();
    // The contract verbatim: title, hint, placeholders, side select,
    // single primary 添加.
    await expect(popup.locator("h5")).toHaveText("按编码指定");
    await expect(popup).toContainText("输入编码或范围，窄范围优先于整类。");
    await expect(popup.locator("[data-role='range-start']")).toHaveAttribute(
      "placeholder",
      "U+0030 或 0",
    );
    await expect(popup.locator("[data-role='range-end']")).toHaveAttribute(
      "placeholder",
      "留空=单个",
    );
    await expect(popup.locator("[data-role='range-side']")).toContainText(
      "用英文字体",
    );

    // A single codepoint (end left empty) applies the chosen side.
    await popup.locator("[data-role='range-start']").fill("0x0041");
    const side = popup.locator("[data-role='range-side']");
    await pointerClick(page, side.locator(".kit-csel"));
    // Visible-wait before the option click: under parallel load the
    // palette's allow-discrete open lags the click that opened it.
    await expect(side.locator(".kit-csel-pk")).toBeVisible();
    await pointerClick(page, side.locator(".kit-cso[data-value='donor']"));
    await pointerClick(page, popup.locator("[data-role='range-add']"));
    await expect.poll(() => summaryRowCount(page)).toBe(1);
    // Round 8: the verbatim single-codepoint sentence.
    await expect(
      page.locator("[data-role='rule-row'][data-kind='range']"),
    ).toContainText("U+0041 A 用中文字体");
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+0041']"),
    ).toHaveAttribute("data-winner", "donor-0");

    // A range for the other side, via Enter commit.
    await pointerClick(
      page,
      page.locator(".kit-toolrow [data-role='range-specify']"),
    );
    await expect(popup).toBeVisible();
    await popup.locator("[data-role='range-start']").fill("0x0043");
    await popup.locator("[data-role='range-end']").fill("0x0046");
    await popup.locator("[data-role='range-start']").press("Enter");
    await expect.poll(() => summaryRowCount(page)).toBe(2);

    // Invalid input paints the border danger-red and adds nothing.
    const rulesNow = await summaryRowCount(page);
    await pointerClick(
      page,
      page.locator(".kit-toolrow [data-role='range-specify']"),
    );
    await expect(popup).toBeVisible();
    await popup.locator("[data-role='range-start']").fill("nope");
    await pointerClick(page, popup.locator("[data-role='range-add']"));
    await expect(popup.locator("[data-role='range-start']")).toHaveCSS(
      "border-color",
      /rgb\(/,
    );
    const borderColor = await popup
      .locator("[data-role='range-start']")
      .evaluate((el) => getComputedStyle(el).borderColor);
    const dangerColor = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--dgr)";
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    expect(borderColor).toBe(dangerColor);
    await expect.poll(() => summaryRowCount(page)).toBe(rulesNow);
    await page.keyboard.press("Escape");
    await expect(popup).toBeHidden();
  });

  test("the toolbar's batch variant applies to the multi-selection", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);
    await pointerClick(page, page.locator(".kit-cat-g[data-group='cjk']"));
    await pointerClick(page, page.locator(".kit-cat-s[data-block='cjk-unified']"));

    // 多选 mode arms the drag; the toolbar switches to its batch variant.
    await pointerClick(page, page.locator("[data-role='toggle-multi']"));
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
    await expect.poll(() => summaryRowCount(page)).toBe(1);
    for (const cp of ["U+4E10", "U+4E11"]) {
      await expect(
        page.locator(`.charmap-grid .kit-cell[data-cp='${cp}']`),
      ).toHaveAttribute("data-winner", "donor-0");
    }
  });

  test("the char popup opens at the cell with the prototype contract", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);

    // A plain click (outside 多选) opens the popup AT the cell.
    const cell = page.locator(".charmap-grid .kit-cell[data-cp='U+0041']");
    await cell.waitFor({ state: "visible" });
    await pointerClick(page, cell);
    const popup = page.locator("[data-char-popup]");
    await expect(popup).toBeVisible();
    // The click re-rendered the grid; read the live cell's box for the
    // anchoring check (same position, fresh node).
    const cellBox = await cell.boundingBox();
    const popBox = await popup.boundingBox();
    expect(cellBox).not.toBeNull();
    expect(popBox).not.toBeNull();
    // AT the cell: anchored within a cell's width of the cell's box.
    expect(Math.abs((popBox!.x ?? 0) - cellBox!.x)).toBeLessThan(60);

    // The facts: glyph, code, 来源; the carried side's button hidden.
    await expect(popup.locator("[data-role='char-glyph']")).toHaveText("A");
    await expect(popup.locator("[data-role='char-code']")).toHaveText("U+0041");
    await expect(popup.locator("[data-role='char-from']")).toContainText(
      "来自 AlloyBase",
    );
    await expect(popup.locator("[data-role='char-base']")).toBeHidden();
    await expect(popup.locator("[data-role='char-donor']")).toBeVisible();
    await expect(popup.locator("[data-role='char-reset']")).toBeHidden();

    // The popup anchors to another cell without closing in between.
    // U+4E00 is donor-only: the donor carries it, and the base button
    // shows DISABLED with the reason attached (round 8, owner item 1 —
    // an override the base font cannot supply is never a working
    // action; the reason is visible the moment the popup opens).
    await pointerClick(page, page.locator(".kit-cat-g[data-group='cjk']"));
    await pointerClick(
      page,
      page.locator(".kit-cat-s[data-block='cjk-unified']"),
    );
    await pointerClick(
      page,
      page.locator(".charmap-grid .kit-cell[data-cp='U+4E00']"),
    );
    await expect(popup.locator("[data-role='char-code']")).toHaveText("U+4E00");
    await expect(popup.locator("[data-role='char-from']")).toContainText(
      "来自 AlloyDonor",
    );
    await expect(popup.locator("[data-role='char-donor']")).toBeHidden();
    const inertBase = popup.locator("[data-role='char-base']");
    await expect(inertBase).toBeVisible();
    await expect(inertBase).toBeDisabled();
    await expect(
      popup.locator("[data-role='char-base-reason']"),
    ).toHaveText("英文字体不含此码位");
    await expect(popup.locator("[data-role='char-reset']")).toBeHidden();

    // Back on the Latin view: 用中文字体 on the base-carried A — the
    // override displaces the base glyph, and 恢复默认 appears.
    await pointerClick(page, page.locator(".kit-cat-g[data-group='latin-europe']"));
    await pointerClick(page, page.locator(".kit-cat-s[data-block='basic-latin']"));
    await pointerClick(
      page,
      page.locator(".charmap-grid .kit-cell[data-cp='U+0041']"),
    );
    await expect(popup.locator("[data-role='char-code']")).toHaveText("U+0041");
    await expect(popup.locator("[data-role='char-from']")).toContainText(
      "来自 AlloyBase",
    );
    await pointerClick(page, popup.locator("[data-role='char-donor']"));
    await expect(popup).toBeHidden();
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+0041']"),
    ).toHaveAttribute("data-winner", "donor-0");
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+0041']"),
    ).toHaveAttribute("data-kind", "override");

    // The dashed single-character summary counts it.
    await expect(page.locator("[data-role='rule-solo']")).toHaveText(/单个字符 1/);

    // 恢复默认 reverts to the deeper layers.
    await pointerClick(
      page,
      page.locator(".charmap-grid .kit-cell[data-cp='U+0041']"),
    );
    await expect(popup.locator("[data-role='char-reset']")).toBeVisible();
    await pointerClick(page, popup.locator("[data-role='char-reset']"));
    await expect(popup).toBeHidden();
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+0041']"),
    ).toHaveAttribute("data-winner", "base");
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+0041']"),
    ).toHaveAttribute("data-via", "default");
    await expect(page.locator("[data-role='rule-solo']")).toHaveCount(0);

    // A missing glyph: the Nerd Font PUA sentence inside the popup.
    await pointerClick(page, page.locator(".kit-cat-g[data-group='all']"));
    await page
      .locator(".kit-toolrow [data-role='locate']")
      .fill("U+E0A0");
    await page.keyboard.press("Enter");
    await pointerClick(
      page,
      page.locator(".charmap-grid .kit-cell[data-cp='U+E0A0']"),
    );
    await expect(popup.locator("[data-role='char-from']")).toHaveText(
      "这是一个 Nerd Font 图标字符，位于专用区编码。只有英文字体包含这类图标，合成时保留英文字体的图标。",
    );
    await expect(popup.locator("[data-role='char-base']")).toBeHidden();
    await expect(popup.locator("[data-role='char-donor']")).toBeHidden();
    // A non-PUA missing glyph reads the plain sentence.
    await page
      .locator(".kit-toolrow [data-role='locate']")
      .fill("U+2603");
    await page.keyboard.press("Enter");
    await pointerClick(
      page,
      page.locator(".charmap-grid .kit-cell[data-cp='U+2603']"),
    );
    await expect(popup.locator("[data-role='char-from']")).toHaveText(
      "两个字体均不含该字形",
    );

    // 全部恢复默认 clears the remaining customizations in one step.
    await pointerClick(page, page.locator(".kit-cat-g[data-group='latin-europe']"));
    await pointerClick(page, page.locator(".kit-cat-s[data-block='basic-latin']"));
    await pointerClick(
      page,
      page.locator(".charmap-grid .kit-cell[data-cp='U+0043']"),
    );
    await pointerClick(page, popup.locator("[data-role='char-donor']"));
    await expect(page.locator("[data-role='rule-solo']")).toHaveCount(1);
    await pointerClick(page, page.locator("[data-role='undo-all']"));
    await expect(page.locator(".kit-rl-empty")).toHaveText("暂无自定义规则。");
  });

  test("the 编码 toggle shows codepoint rows; missing cells always show theirs", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);

    // 编码 mode: every cell gains the codepoint row (U+0041 is covered
    // by the base, so it starts WITHOUT the row; a missing cell like
    // U+0020 already shows it — see the assertion below).
    const cell = page.locator(".charmap-grid .kit-cell[data-cp='U+0041']");
    await expect(cell.locator(".cp")).toHaveCount(0);
    await pointerClick(page, page.locator("[data-role='toggle-codepoints']"));
    await expect(cell.locator(".cp")).toHaveText("0041");
    await pointerClick(page, page.locator("[data-role='toggle-codepoints']"));

    // OFF again: only the MISSING cells keep their codepoint row — the
    // dead condition in kit/grid.ts once hid it (P1-7).
    const missing = await page.locator(".kit-grid .kit-cell.miss").count();
    const withCp = await page.locator(".kit-grid .kit-cell.hascp").count();
    expect(missing).toBeGreaterThan(0);
    expect(withCp).toBe(missing);
    const missingCell = page.locator(".kit-grid .kit-cell.miss").first();
    await expect(missingCell.locator(".cp")).toBeVisible();

    // The locator also accepts a single character (永 = U+6C38).
    const locate = page.locator(".kit-toolrow [data-role='locate']");
    await locate.fill("永");
    await locate.press("Enter");
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+6C38']"),
    ).toHaveClass(/cur/);
  });
});
