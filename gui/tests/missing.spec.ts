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
import { browseUniverseSize, ICON_UNIVERSE } from "../src/unicode/universe";

/**
 * Round 5 — the missing-glyph scope made AUTOMATIC (owner item 4): the
 * 缺失 chip appears the moment picks exist and the browsed universe
 * holds codepoints the picks do not cover — computed from the cmaps
 * alone, no preset involved, nothing accreting per codepoint. Round 19
 * (owner ruling) extended the same discipline to a SINGLE pick: the
 * covered side is the UNION of whatever is picked (one or two fonts),
 * so the chip and the counters judge the browsed universe the moment
 * ANY pick exists.
 *
 * The view it opens (dashed danger cells, the 无法指定来源 notice) pages
 * its own list, the status bar's 缺失 counter agrees, and 覆盖 is the
 * honest covered-by-either ÷ browsed-scope share (owner item 6). The
 * mode bar's 定位 field (jump + select from either content mode) rides
 * along.
 */

const UNIVERSE = browseUniverseSize();

test.describe("missing glyph scope", () => {
  const jsErrors: string[] = [];

  test.beforeEach(() => {
    jsErrors.length = 0;
  });

  test.afterEach(() => assertNoJsErrors(jsErrors));

  /** Small fixture pair: base = A–Z, donor = a hanzi run (disjoint). */
  async function makeLocalFixtures(donorGlyphs = 64): Promise<{
    base: string;
    donor: string;
  }> {
    const dir = await mkdtemp(resolve(tmpdir(), "fontalloy-missing-"));
    return generateFonts(dir, { donorGlyphs });
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
      // parity — the closed card shows the new pick).
      await expect(popup).toBeHidden();
    }
  }

  /** Load exactly ONE font into one picker (the round-19 lone pick). */
  async function openWithOneFont(
    page: Page,
    role: "en" | "cjk",
    path: string,
  ): Promise<void> {
    collectJsErrors(page, jsErrors);
    await page.goto("/");
    await waitForFontsReady(page);
    await pointerClick(
      page,
      page.locator(`[data-role="picker-${role}"] .kit-hd`),
    );
    const popup = page.locator(`[data-picker-popup="${role}"]`);
    await expect(popup).toBeVisible();
    await page.locator("input[data-role='font-file']").setInputFiles(path);
    await expect(popup).toBeHidden();
  }

  test("the 缺失 chip is automatic: coverage-driven, preset-independent", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures(64);
    collectJsErrors(page, jsErrors);
    await page.goto("/");
    await waitForFontsReady(page);

    const chip = page.locator(".kit-catbar .kit-cat-g[data-group='missing']");

    // Before any pick there is nothing to judge: no chip.
    await expect(chip).toHaveCount(0);

    // ONE pick already judges (round 19): 26 letters covered,
    // everything else of the browsed universe missing.
    await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
    await page.locator("input[data-role='font-file']").setInputFiles(fonts.base);
    await expect(page.locator('[data-picker-popup="en"]')).toBeHidden();
    await expect(chip).toBeVisible();
    await expect(chip).toHaveClass(/miss/);
    await expect(chip.locator(".n")).toHaveText(
      (UNIVERSE - 26).toLocaleString("en-US"),
    );

    // Both picks exist: 26 letters + 64 hanzi covered, everything else
    // of the browsed universe missing — from the cmaps alone, no preset.
    await pointerClick(page, page.locator('[data-role="picker-cjk"] .kit-hd'));
    await page.locator("input[data-role='font-file']").setInputFiles(fonts.donor);
    await expect(page.locator('[data-picker-popup="cjk"]')).toBeHidden();
    const missing = UNIVERSE - 26 - 64;
    await expect(chip).toBeVisible();
    await expect(chip).toHaveClass(/miss/);
    await expect(chip.locator(".n")).toHaveText(missing.toLocaleString("en-US"));

    // No preset involved: the 文字范围 chips do not move the count at
    // all (the earlier preset-scoped semantics are gone).
    await pointerClick(
      page,
      page.locator("[data-role='lang-chip'][data-preset='zh_tw']"),
    );
    await expect(chip.locator(".n")).toHaveText(missing.toLocaleString("en-US"));
    const zhCn = page.locator("[data-role='lang-chip'][data-preset='zh_cn']");
    await pointerClick(page, zhCn);
    await expect(zhCn).toHaveAttribute("aria-pressed", "false");
    await expect(chip.locator(".n")).toHaveText(missing.toLocaleString("en-US"));

    // The last-language guard still holds (the rail's own rule).
    await pointerClick(
      page,
      page.locator("[data-role='lang-chip'][data-preset='zh_tw']"),
    );
    await expect(page.locator("[data-role='live']")).toHaveText("至少保留一种");

    // The chip closes the row.
    expect(
      await page.evaluate(() => {
        const row = document.querySelector(".kit-cat-l1");
        const last = row.lastElementChild;
        return last instanceof HTMLElement && last.dataset.group === "missing";
      }),
    ).toBe(true);
  });

  test("the missing view: dashed cells, its own pager, honest coverage", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures(64);
    await openWithFonts(page, fonts);
    const missing = UNIVERSE - 26 - 64;

    // The status bar agrees with the chip and covers honestly: 覆盖 is
    // the covered share of the browsed universe — never 100% while
    // missing cells exist (owner item 6). Round 6: the number counts
    // the whole visible universe (normal semantics), so it carries NO
    // ?-popover — the explanation was noise.
    await expect(page.locator("[data-stat='missing']")).toHaveText(
      missing.toLocaleString("en-US"),
    );
    await expect(page.locator("[data-stat='total']")).toHaveText(
      UNIVERSE.toLocaleString("en-US"),
    );
    const coverage = Number(
      (await page.locator("[data-stat='coverage']").textContent()) ?? "0",
    );
    expect(coverage).toBeGreaterThan(0);
    expect(coverage).toBeLessThan(100);
    await expect(page.locator("[data-role='help-coverage']")).toHaveCount(0);

    // Opening the chip: the notice replaces the assignment segments,
    // every cell is dashed-missing, and the grid pages its own list.
    await pointerClick(
      page,
      page.locator(".kit-cat-g[data-group='missing']"),
    );
    await expect(page.locator(".kit-toolrow")).toContainText(
      "缺失字符无法指定来源",
    );
    const pageSize = await page.evaluate(
      () => document.querySelectorAll(".kit-grid .kit-cell").length,
    );
    expect(pageSize).toBeGreaterThan(0);
    expect(pageSize).toBeLessThanOrEqual(1024);
    await expect(page.locator(".kit-grid .kit-cell.miss")).toHaveCount(pageSize);
    await expect(page.locator("[data-pager-label]")).toContainText(
      `/${Math.ceil(missing / pageSize)} 页`,
    );
  });

  test("a lone EN pick judges the universe: missing = universe − its cmap", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures(64);
    await openWithOneFont(page, "en", fonts.base);
    const missing = UNIVERSE - 26;

    // The chip exists with ONE pick and carries the whole gap.
    const chip = page.locator(".kit-catbar .kit-cat-g[data-group='missing']");
    await expect(chip).toBeVisible();
    await expect(chip.locator(".n")).toHaveText(missing.toLocaleString("en-US"));

    // The invariant survives the lone pick: 字符 = 英文 + 中文 + 缺失,
    // with the EN pick's covered codepoints on the 英文 side (adjusted
    // stays 0 — one font means no rule can move a supplier).
    await expect(page.locator("[data-stat='en']")).toHaveText("26");
    await expect(page.locator("[data-stat='cjk']")).toHaveText("0");
    await expect(page.locator("[data-stat='adjusted']")).toHaveText("0");
    await expect(page.locator("[data-stat='missing']")).toHaveText(
      missing.toLocaleString("en-US"),
    );
    await expect(page.locator("[data-stat='total']")).toHaveText(
      UNIVERSE.toLocaleString("en-US"),
    );
    const coverage = Number(
      (await page.locator("[data-stat='coverage']").textContent()) ?? "0",
    );
    expect(coverage).toBeGreaterThan(0);
    expect(coverage).toBeLessThan(1);

    // The missing view pages the gap and starts at the universe's first
    // codepoint (U+0021) — the fixture misses whole blocks (every CJK
    // ideograph included), and the view shows exactly that.
    await pointerClick(page, chip);
    await expect(page.locator(".kit-toolrow")).toContainText(
      "缺失字符无法指定来源",
    );
    await expect(page.locator(".kit-grid .kit-cell.miss").first()).toHaveAttribute(
      "data-cp",
      "U+0021",
    );
    const pageSize = await page.evaluate(
      () => document.querySelectorAll(".kit-grid .kit-cell").length,
    );
    expect(pageSize).toBeGreaterThan(0);
    await expect(page.locator("[data-pager-label]")).toContainText(
      `/${Math.ceil(missing / pageSize)} 页`,
    );
  });

  test("a lone CJK pick judges its side the same way", async ({ page }) => {
    const fonts = await makeLocalFixtures(64);
    await openWithOneFont(page, "cjk", fonts.donor);
    const missing = UNIVERSE - 64;

    const chip = page.locator(".kit-catbar .kit-cat-g[data-group='missing']");
    await expect(chip).toBeVisible();
    await expect(chip.locator(".n")).toHaveText(missing.toLocaleString("en-US"));

    // The invariant, mirrored: the CJK pick's covered codepoints land
    // on the 中文 side, everything else of the universe is missing.
    await expect(page.locator("[data-stat='en']")).toHaveText("0");
    await expect(page.locator("[data-stat='cjk']")).toHaveText("64");
    await expect(page.locator("[data-stat='adjusted']")).toHaveText("0");
    await expect(page.locator("[data-stat='missing']")).toHaveText(
      missing.toLocaleString("en-US"),
    );
    await expect(page.locator("[data-stat='total']")).toHaveText(
      UNIVERSE.toLocaleString("en-US"),
    );
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

  test("unmapped icon cells count as missing: no fallback tofu in the 图标 ranges", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures(64);
    await openWithOneFont(page, "en", fonts.base);

    // Round 20 (owner item 1): the 图标 ranges have no fixed meanings —
    // the grid's fallback rendering of an UNMAPPED icon codepoint is
    // tofu that misleads. With a single icon-less pick, every icon cell
    // carries the MISSING style (red dashed frame) instead: the NF icon
    // area's gaps read as gaps.
    await pointerClick(
      page,
      page.locator(".kit-cat-g[data-group='icons']"),
    );
    const cells = page.locator(".charmap-grid .kit-cell");
    const count = await cells.count();
    expect(count).toBeGreaterThan(0);
    await expect(
      page.locator(".charmap-grid .kit-cell.miss"),
    ).toHaveCount(count);
    // Every missing icon cell shows its codepoint row...
    await expect(
      page.locator(".charmap-grid .kit-cell.hascp"),
    ).toHaveCount(count);
    // ...and renders NO glyph at all — the codepoint is the only
    // content, never a fallback font's tofu box.
    const glyphs = await page
      .locator(".charmap-grid .kit-cell .ch")
      .allTextContents();
    expect(glyphs.every((text) => text === "")).toBe(true);

    // The missing count covers the icon universe: the chip carries the
    // whole gap of the browsed universe (icons included) against the
    // lone pick, and the icon planes are a strict part of that universe.
    const iconSize = ICON_UNIVERSE.reduce(
      (sum, [start, end]) => sum + (end - start + 1),
      0,
    );
    expect(iconSize).toBeGreaterThan(0);
    const chip = page.locator(".kit-catbar .kit-cat-g[data-group='missing']");
    await expect(chip.locator(".n")).toHaveText(
      (UNIVERSE - 26).toLocaleString("en-US"),
    );
  });
});
