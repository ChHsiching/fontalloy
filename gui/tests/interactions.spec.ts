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

test.describe("cell details (click-reachable information)", () => {
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

  test("clicking a covered cell shows its codepoint, character and coverage", async ({
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

    const details = page.locator(".charmap-details");
    const text = (await details.textContent()) ?? "";
    expect(text).toContain("U+0041");
    expect(text).toContain("A");
    expect(text).toContain("英文字体");

    // The selected cell is marked with the accent (cursor state) class.
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+0041']"),
    ).toHaveClass(/cur/);
  });

  test("an uncovered cell states so in plain text", async ({ page }) => {
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
    const text = (await page.locator(".charmap-details").textContent()) ?? "";
    expect(text).toContain(target!);
    expect(text).toContain("未被所选字体覆盖");
  });

  test("the details editor's checkboxes paint with the kit accent in both themes", async ({
    page,
  }) => {
    // A full pick pair opens the codepoint precedence editor; its font
    // checkboxes must carry the accent token (the native checkbox blue
    // is off-palette in the light theme), and the theme flip must move
    // them with --ac.
    const [font1, font2] = fixtureFontPaths();
    await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
    await page.locator("input[data-role='font-file']").setInputFiles(font1);
    await waitForFontsReady(page);
    await page.keyboard.press("Escape");
    await pointerClick(page, page.locator('[data-role="picker-cjk"] .kit-hd'));
    await page.locator("input[data-role='font-file']").setInputFiles(font2);
    await waitForFontsReady(page);
    await page.keyboard.press("Escape");

    await pointerClick(
      page,
      page.locator(".charmap-grid .kit-cell[data-cp='U+0041']"),
    );
    const box = page.locator("[data-role='cp-font-base']");
    await expect(box).toBeVisible();

    const accentOf = (target: string) =>
      page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error(`no ${sel}`);
        return getComputedStyle(el).accentColor;
      }, target);
    const probe = () =>
      page.evaluate(() => {
        const span = document.createElement("span");
        span.style.color = "var(--ac)";
        document.body.appendChild(span);
        const color = getComputedStyle(span).color;
        span.remove();
        return color;
      });

    expect(await accentOf("[data-role='cp-font-base']")).toBe(await probe());

    await pointerClick(page, page.locator(".topbar [data-role='theme-toggle']"));
    await page.waitForTimeout(150); // the two-frame .theming guard settles
    expect(await accentOf("[data-role='cp-font-base']")).toBe(await probe());
  });
});
