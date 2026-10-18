import { test, expect, type Page } from "@playwright/test";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { browseUniverseSize } from "../src/unicode/universe";
import {
  generateFonts,
  scanMeta,
  spawnServeOverFonts,
  startServeFixture,
  type ServeFixture,
} from "./serve";
import {
  assertNoJsErrors,
  collectJsErrors,
  pointerClick,
  waitForFontsReady,
} from "./helpers";

/**
 * Rounds 18–19 (owner item 2b): placeholder glyphs count as missing. A
 * font that draws a placeholder (方框 / 叉号 / question face) at codepoints
 * it does not really cover must not poison coverage counts nor graft
 * tofu into builds. Round 19 fixed the detector to the OpenType
 * conventions alone — glyph-0 mappings are absent, and a mapped glyph
 * whose OUTLINE is the font's own .notdef outline is a suspected
 * placeholder (the box drawn under another name); concentration counts
 * for nothing. Ticket #36: the detector's unit assertions live
 * CORE-side (tests/test_placeholder.py) with the parse mirror's
 * deletion; the page-side coverage here proves the SERVE-carried
 * verdicts render: the scan's interval data drives the grid's missing
 * style and the counters, and the report states what the build drops.
 */

/** The faked block: 300 private-use codepoints on ONE box glyph. */
const PLACEHOLDER_COUNT = 300;
const PLACEHOLDER_RUN = Array.from(
  { length: PLACEHOLDER_COUNT },
  (_, i) => 0xe000 + i,
);

test.describe("placeholder coverage", () => {
  const jsErrors: string[] = [];

  test.beforeEach(() => {
    jsErrors.length = 0;
  });

  test.afterEach(() => assertNoJsErrors(jsErrors));

  test("a mass-duplicated glyph counts as missing while its glyph still renders", async ({
    page,
  }) => {
    const dir = await mkdtemp(resolve(tmpdir(), "fontalloy-mass-"));
    const { base, donor } = await generateFonts(dir, {
      donorGlyphs: 64,
      sharedGlyphDonor: 80,
    });

    // Round 20, rule 3 (owner-ratified): one glyph absorbing >= 64
    // mapped codepoints is a suspected MASS-DUPLICATED placeholder
    // whatever its outline — the parse drops the run from coverage.
    // Ticket #35: the grid's per-cell missing verdict is the serve's
    // answer, so the page rides a serve over the fixture directory and
    // BOTH fonts are picked (a lone CJK pick has no request — the
    // resolve body's picks.base is mandatory).
    const service = await spawnServeOverFonts(dir);
    const serveUrl = await service.url;
    // The oracle is the serve's own scan (fontTools core-side): the
    // mass-duplicated run reads as placeholders, so it never rides the
    // honest coverage intervals.
    const donorScan = await scanMeta(serveUrl, donor);
    expect(
      donorScan.intervals.filter(
        ([start, end]) => start >= 0xe000 && end < 0xf900,
      ),
    ).toEqual([]);
    try {
      collectJsErrors(page, jsErrors);
      await page.addInitScript((url: string) => {
        const config = window as unknown as {
          __FONTALLOY_CONFIG__: Record<string, unknown>;
        };
        config.__FONTALLOY_CONFIG__ ??= {};
        config.__FONTALLOY_CONFIG__.serveUrl = url;
      }, await service.url);
      await page.goto("/");
      await waitForFontsReady(page);
      for (const [role, path] of [
        ["en", base],
        ["cjk", donor],
      ] as const) {
        await pointerClick(
          page,
          page.locator(`[data-role="picker-${role}"] .kit-hd`),
        );
        await page
          .locator("input[data-role='font-file']")
          .setInputFiles(path);
        await expect(page.locator(`[data-picker-popup="${role}"]`)).toBeHidden();
      }
      await pointerClick(page, page.locator(".kit-cat-g[data-group='icons']"));
      // The document must land before the per-cell verdicts: anchor on
      // a covered icon... none exist here, so anchor on the missing
      // style itself arriving at the mass-duplicated run's head.
      const cell = page.locator(".charmap-grid .kit-cell[data-cp='U+E000']");
      await expect(cell).toHaveClass(/miss/);
      await expect(cell.locator(".cp")).toHaveText("E000");
      await expect(cell.locator(".ch")).toHaveText("");
      const family = await cell.evaluate((el) => getComputedStyle(el).fontFamily);
      expect(family).toContain("AlloyDonor");

      // The missing counters include the mass-duplicated run: the pair
      // covers the base's 26 letters and the donor's 64 hanzi — nothing
      // else of the universe.
      const chip = page.locator(".kit-catbar .kit-cat-g[data-group='missing']");
      await expect(chip.locator(".n")).toHaveText(
        (browseUniverseSize() - 90).toLocaleString("en-US"),
      );
      await expect(page.locator("[data-stat='missing']")).toHaveText(
        (browseUniverseSize() - 90).toLocaleString("en-US"),
      );
      // Quiesce before the dispose (an in-flight boot probe killed
      // mid-air would log a transport error).
      await page.waitForLoadState("networkidle");
    } finally {
      await service.dispose();
    }
  });

  test("the report states the faked block and the build drops it", async ({
    page,
  }) => {
    const service = await startServeFixture({
      donorGlyphs: 2000,
      placeholderDonor: PLACEHOLDER_COUNT,
    });
    const serveBaseUrl = await service.url;
    const saved: string[] = [];
    try {
      await openWithService(page, service, saved);

      await loadIntoPicker(page, "en", service.baseFont);
      await loadIntoPicker(page, "cjk", service.donorFont);
      const synthesize = page.locator(".topbar [data-role='synthesize']");
      await expect(synthesize).toHaveAttribute("aria-disabled", "false");
      await pointerClick(page, synthesize);

      const panel = page.locator('[data-testid="build-panel"]');
      await expect(panel).toBeVisible();
      await expect(panel.locator("[data-build-stage]").first()).toHaveText(
        "完成",
        { timeout: 30_000 },
      );
      await expect(panel).toContainText("已保存");
      expect(saved.length).toBe(1);

      // The report: the DONOR carries one dim placeholder line under its
      // honest count (the clean base carries none).
      await pointerClick(page, panel.locator(".report-details > summary"));
      const notes = panel.locator('[data-role="report-placeholder-note"]');
      await expect(notes).toHaveCount(1);
      await expect(notes.first()).toHaveText(
        `疑似占位 ${PLACEHOLDER_COUNT} 个码位，未计入覆盖`,
      );
      // The donor's count is the honest kind: 2,000 real codepoints,
      // the 300 faked ones never inside it.
      await expect(panel).toContainText("2,000 个码位");

      // The 缺失 ?-popover explains the counting rule.
      await pointerClick(
        page,
        panel.locator(".kit-qh[aria-label='覆盖检查是什么']"),
      );
      const pop = page.locator(".kit-pop.open");
      await expect(pop).toBeVisible();
      await expect(pop).toContainText(
        "部分字体会在缺失的码位画出占位符（方框、叉号等）；这些码位按缺失计。",
      );
      await page.keyboard.press("Escape");
      await expect(pop).toBeHidden();

      // The built font's own cmap never learned the faked block — the
      // placeholder was never grafted, from either side.
      // The built font's own cmap never learned the faked block (the
      // serve's scan of the saved artifact is the oracle): the
      // placeholder was never grafted, from either side.
      const builtScan = await scanMeta(serveBaseUrl, saved[0]);
      expect(
        builtScan.intervals.filter(
          ([start, end]) => start >= 0xe000 && end < 0xf900,
        ),
      ).toEqual([]);
    } finally {
      await service.dispose();
    }
  });

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
    await expect(popup).toBeHidden();
  }

  /** The page with the injected service config + a real save stand-in. */
  async function openWithService(
    page: Page,
    service: ServeFixture,
    saved: string[],
  ): Promise<string> {
    const saveDir = await mkdtemp(resolve(tmpdir(), "fontalloy-save-"));
    await page.exposeFunction(
      "__fontalloyTestSave",
      async (name: string, bytesB64: string): Promise<string | null> => {
        const bytes = Buffer.from(bytesB64, "base64");
        const target = resolve(saveDir, name);
        await writeFile(target, bytes);
        saved.push(target);
        return target;
      },
    );
    await page.addInitScript(() => {
      const config = window as unknown as {
        __FONTALLOY_CONFIG__: Record<string, unknown>;
      };
      config.__FONTALLOY_CONFIG__ = {
        saveArtifact: async (
          name: string,
          bytes: Uint8Array,
        ): Promise<{ saved: boolean; path: string | null }> => {
          const b64 = btoa(
            Array.from(bytes, (b) => String.fromCharCode(b)).join(""),
          );
          const path = await window.__fontalloyTestSave(name, b64);
          return path === null ? { saved: false, path: null } : { saved: true, path };
        },
      };
    });
    await page.addInitScript((url: string) => {
      const config = window as unknown as {
        __FONTALLOY_CONFIG__: Record<string, unknown>;
      };
      config.__FONTALLOY_CONFIG__ ??= {};
      config.__FONTALLOY_CONFIG__.serveUrl = url;
    }, service.url);
    collectJsErrors(page, jsErrors);
    await page.goto("/");
    await waitForFontsReady(page);
    return saveDir;
  }
});
