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
import { browseUniverseSize } from "../src/unicode/universe";

/**
 * Round 20 (owner items 4+5): the status bar's 英文 / 中文 counters
 * classify by SCRIPT REGION, not by which pick supplies the glyph —
 * 英文 counts the covered codepoints of the browsed universe OUTSIDE
 * the CJK region, 中文 the covered ones inside it (the 中日韩文字
 * group's blocks), so a CJK font's Latin coverage lands in 英文 instead
 * of poisoning 中文. The stack semantics stand (either pick covers;
 * both missing = missing), 已调整 is untouched, and the invariant
 * 字符 = 英文 + 中文 + 缺失 holds under every pick state.
 *
 * The same round's item 1: the char popup's details strip gains the
 * character's CLASSIFICATION as one small teal qualifier tag — the
 * taxonomy's own group and block names, joined by U+00B7.
 */

const UNIVERSE = browseUniverseSize();

test.describe("script-region counters and classification", () => {
  const jsErrors: string[] = [];

  test.beforeEach(() => {
    jsErrors.length = 0;
  });

  test.afterEach(() => assertNoJsErrors(jsErrors));

  /** The fixture pair, with the donor ALSO covering 10 ASCII letters. */
  async function makeFixtures(): Promise<{ base: string; donor: string }> {
    const dir = await mkdtemp(resolve(tmpdir(), "fontalloy-region-"));
    return generateFonts(dir, { donorGlyphs: 64, donorAscii: 10 });
  }

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
      await expect(popup).toBeHidden();
    }
  }

  test("a lone CJK pick counts its Latin coverage into 英文, not 中文", async ({
    page,
  }) => {
    const fonts = await makeFixtures();
    await openWithOneFont(page, "cjk", fonts.donor);

    // The donor covers 64 hanzi (CJK region) AND 10 ASCII letters (EN
    // region). The round-19 winner-side split counted all 74 into 中文;
    // round 20 classifies by script region: 英文 > 0 alongside 中文 > 0.
    await expect(page.locator("[data-stat='en']")).toHaveText("10");
    await expect(page.locator("[data-stat='cjk']")).toHaveText("64");
    await expect(page.locator("[data-stat='adjusted']")).toHaveText("0");
    await expect(page.locator("[data-stat='missing']")).toHaveText(
      (UNIVERSE - 74).toLocaleString("en-US"),
    );
    await expect(page.locator("[data-stat='total']")).toHaveText(
      UNIVERSE.toLocaleString("en-US"),
    );
  });

  test("an EN+CJK pair counts by script region; overlap counts once", async ({
    page,
  }) => {
    const fonts = await makeFixtures();
    await openWithFonts(page, fonts);

    // The pair: the base's 26 letters and the donor's 10 overlapping
    // letters are all EN-region coverage (one count per codepoint), the
    // 64 hanzi are the CJK region — the winners are irrelevant to the
    // split, and the invariant still closes.
    await expect(page.locator("[data-stat='en']")).toHaveText("26");
    await expect(page.locator("[data-stat='cjk']")).toHaveText("64");
    await expect(page.locator("[data-stat='missing']")).toHaveText(
      (UNIVERSE - 90).toLocaleString("en-US"),
    );
    await expect(page.locator("[data-stat='total']")).toHaveText(
      UNIVERSE.toLocaleString("en-US"),
    );
  });

  test("the char popup carries the taxonomy classification as a text tag", async ({
    page,
  }) => {
    const fonts = await makeFixtures();
    await openWithFonts(page, fonts);

    const popup = page.locator("[data-char-popup]");
    const tag = popup.locator("[data-role='char-classification']");

    // A Han codepoint: the taxonomy's own group and block names, joined
    // by U+00B7 — text, never an svg decoration.
    await pointerClick(page, page.locator(".kit-cat-g[data-group='cjk']"));
    await pointerClick(
      page,
      page.locator(".kit-cat-s[data-block='cjk-unified']"),
    );
    await pointerClick(
      page,
      page.locator(".charmap-grid .kit-cell[data-cp='U+4E00']"),
    );
    await expect(popup).toBeVisible();
    await expect(tag).toHaveText("中日韩文字 · CJK 统一表意文字");
    expect(await tag.evaluate((el) => el.querySelector("svg"))).toBeNull();
    // The code line's own text stays exactly the codepoint.
    await expect(popup.locator("[data-role='char-code']")).toHaveText(
      "U+4E00",
    );

    // An icon codepoint — missing for both picks — still carries its
    // classification: the 图标 group and the Powerline sub-block.
    await pointerClick(page, page.locator(".kit-cat-g[data-group='icons']"));
    await pointerClick(
      page,
      page.locator(".charmap-grid .kit-cell[data-cp='U+E0A0']"),
    );
    await expect(popup).toBeVisible();
    await expect(tag).toHaveText("图标 · Powerline 符号");
    await expect(popup.locator("[data-role='char-code']")).toHaveText(
      "U+E0A0",
    );
  });
});
