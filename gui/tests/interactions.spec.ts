import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  assertNoJsErrors,
  collectJsErrors,
  pointerClick,
  waitForFontsReady,
} from "./helpers";
import {
  generateNamedFace,
  scanMeta,
  spawnServeOverFonts,
} from "./serve";

test.describe("cell details (the char popup at the cell)", () => {
  const jsErrors: string[] = [];

  /** Suite-scoped serve over two generated families (ticket #36: the
   * browser file-input loads ride the serve's upload endpoint now). */
  let serveUrl = "";
  let font1 = "";
  let font2 = "";
  let disposeServe: (() => Promise<void>) | null = null;

  test.beforeAll(async () => {
    const root = await mkdtemp(resolve(tmpdir(), "fontalloy-inter-"));
    const [alpha, beta] = await Promise.all([
      generateNamedFace(root, "Alloy Inter A", "AlloyInterA"),
      generateNamedFace(root, "Alloy Inter B", "AlloyInterB"),
    ]);
    font1 = alpha;
    font2 = beta;
    const spawned = await spawnServeOverFonts(root);
    disposeServe = async () => {
      await spawned.dispose();
      await rm(root, { recursive: true, force: true });
    };
    serveUrl = await spawned.url;
  });

  test.afterAll(async () => {
    await disposeServe?.();
  });

  async function openWorkspace(page: Page): Promise<void> {
    await page.addInitScript((serve: string) => {
      (window as { __FONTALLOY_CONFIG__?: unknown }).__FONTALLOY_CONFIG__ = {
        serveUrl: serve,
      };
    }, serveUrl);
    await page.goto("/");
    await waitForFontsReady(page);
  }

  test.beforeEach(async ({ page }) => {
    jsErrors.length = 0;
    collectJsErrors(page, jsErrors);
    await openWorkspace(page);

    // Load one font and let it auto-select for the EN picker.
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
    await pointerClick(page, page.locator('[data-role="picker-cjk"] .kit-hd'));
    await page.locator("input[data-role='font-file']").setInputFiles(font2);
    await waitForFontsReady(page);
    await page.keyboard.press("Escape");

    await pointerClick(page, page.locator(".kit-cat-g[data-group='symbols']"));
    await pointerClick(
      page,
      page.locator(".kit-cat-s[data-block='misc-symbols']"),
    );
    // The uncovered example must be derived from the fixture's real
    // coverage — the SERVE's scan is the oracle (the fixture covers
    // A-Z, so any codepoint outside it on the visible page qualifies).
    const meta = await scanMeta(serveUrl, font1);
    const covered = new Set<number>();
    for (const [start, end] of meta.intervals) {
      for (let cp = start; cp <= end; cp++) covered.add(cp);
    }
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

    // The 3-state toggle (round 5): from a fresh context the cycle runs
    // 自动 → 浅色 → 深色; only a step that actually flips the effective
    // theme exercises the re-tint under the .theming guard, so step
    // through until the resolved theme differs.
    const before = await page.evaluate(
      () => document.documentElement.dataset.theme,
    );
    for (let step = 0; step < 3; step++) {
      await pointerClick(page, page.locator(".topbar [data-role='theme-toggle']"));
      const now = await page.evaluate(() => document.documentElement.dataset.theme);
      if (now !== before) break;
    }
    await page.waitForTimeout(150); // the two-frame .theming guard settles
    expect(await accentOf()).toBe(await probe());
  });
});
