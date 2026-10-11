import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { parseFontMeta } from "../src/fonts/sfnt";
import {
  assertNoJsErrors,
  collectJsErrors,
  fixtureFontPaths,
  pointerClick,
  waitForFontsReady,
} from "./helpers";

test.describe("cell details (the char popup at the cell)", () => {
  const jsErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    jsErrors.length = 0;
    collectJsErrors(page, jsErrors);
    await page.goto("/");
    await waitForFontsReady(page);

    // Load one font and let it auto-select for the EN picker.
    const [font1] = fixtureFontPaths();
    await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
    await page.locator("input[data-role='font-file']").setInputFiles(font1);
    await waitForFontsReady(page);
    await page.keyboard.press("Escape");
  });

  test.afterEach(() => assertNoJsErrors(jsErrors));

  test("clicking a covered cell opens the popup with its glyph and codepoint", async ({
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
    await pointerClick(page, page.locator(".charmap-grid .kit-cell[data-cp='U+0041']"));

    // The popup AT the cell states the facts in plain text: the big
    // glyph, the U+XXXX code. With no full pick pair the 来源 line and
    // the side buttons stay away (nothing to assign yet).
    const popup = page.locator("[data-char-popup]");
    await expect(popup).toBeVisible();
    await expect(popup.locator("[data-role='char-glyph']")).toHaveText("A");
    await expect(popup.locator("[data-role='char-code']")).toHaveText("U+0041");
    await expect(popup.locator("[data-role='char-base']")).toBeHidden();
    await expect(popup.locator("[data-role='char-donor']")).toBeHidden();

    // The selected cell is marked with the accent (cursor state) class.
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+0041']"),
    ).toHaveClass(/cur/);

    // Escape closes it (the cascade's first rung).
    await page.keyboard.press("Escape");
    await expect(popup).toBeHidden();
  });

  test("an uncovered cell states so in plain text (full pick pair)", async ({ page }) => {
    // A full pair makes the effective preview honest: an uncovered cell
    // reads 两个字体均不含该字形 in the popup.
    const [, font2] = fixtureFontPaths();
    await pointerClick(page, page.locator('[data-role="picker-cjk"] .kit-hd'));
    await page.locator("input[data-role='font-file']").setInputFiles(font2);
    await waitForFontsReady(page);
    await page.keyboard.press("Escape");

    await pointerClick(page, page.locator(".kit-cat-g[data-group='symbols']"));
    await pointerClick(
      page,
      page.locator(".kit-cat-s[data-block='misc-symbols']"),
    );
    // The uncovered example must be derived from the fixture's real cmap —
    // host fonts differ per platform (DejaVu Sans covers U+2603; the Windows
    // fixtures do not), so a hardcoded codepoint would not be portable.
    const [font1] = fixtureFontPaths();
    const bytes = await readFile(font1);
    const meta = parseFontMeta(
      bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    );
    const covered = new Set(meta.codepoints);
    const cells = page.locator(".charmap-grid .kit-cell");
    const cellCount = await cells.count();
    let target: string | null = null;
    for (let i = 0; i < cellCount; i++) {
      const cp = await cells.nth(i).getAttribute("data-cp");
      if (cp && !covered.has(parseInt(cp.slice(2), 16))) {
        target = cp;
        break;
      }
    }
    expect(
      target,
      "the fixture font covers every codepoint on the visible page",
    ).not.toBeNull();
    await pointerClick(
      page,
      page.locator(`.charmap-grid .kit-cell[data-cp='${target}']`),
    );
    const popup = page.locator("[data-char-popup]");
    await expect(popup).toBeVisible();
    await expect(popup.locator("[data-role='char-code']")).toHaveText(target!);
    await expect(popup.locator("[data-role='char-from']")).toHaveText(
      "两个字体均不含该字形",
    );
    // The side buttons stay away for a glyph nobody holds.
    await expect(popup.locator("[data-role='char-base']")).toBeHidden();
    await expect(popup.locator("[data-role='char-donor']")).toBeHidden();
  });

  test("the popup's code accent follows the theme tokens", async ({ page }) => {
    const [, font2] = fixtureFontPaths();
    await pointerClick(page, page.locator('[data-role="picker-cjk"] .kit-hd'));
    await page.locator("input[data-role='font-file']").setInputFiles(font2);
    await waitForFontsReady(page);
    await page.keyboard.press("Escape");

    await pointerClick(
      page,
      page.locator(".charmap-grid .kit-cell[data-cp='U+0041']"),
    );
    const code = page.locator("[data-char-popup] [data-role='char-code']");
    await expect(code).toBeVisible();

    const accentOf = () =>
      code.evaluate((el) => getComputedStyle(el).color);
    const probe = () =>
      page.evaluate(() => {
        const span = document.createElement("span");
        span.style.color = "var(--ac)";
        document.body.appendChild(span);
        const color = getComputedStyle(span).color;
        span.remove();
        return color;
      });

    expect(await accentOf()).toBe(await probe());

    await pointerClick(page, page.locator(".topbar [data-role='theme-toggle']"));
    await page.waitForTimeout(150); // the two-frame .theming guard settles
    expect(await accentOf()).toBe(await probe());
  });
});
