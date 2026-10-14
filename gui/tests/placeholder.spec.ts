import { test, expect, type Page } from "@playwright/test";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { parseFontMeta } from "../src/fonts/sfnt";
import { browseUniverseSize } from "../src/unicode/universe";
import { generateFonts, startServeFixture, type ServeFixture } from "./serve";
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
 * for nothing. The same rules run at BOTH seams — the GUI's
 * parseFontMeta (live grid and status bar) and the core pipeline
 * (report and graft) — so this suite proves the two agree on fixtures
 * that fake coverage with a .notdef-outline glyph: the parse drops the
 * run, the report states it, the built font's cmap never contains it.
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

  test("parseFontMeta reads a faked block as missing, not coverage", async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "fontalloy-ph-"));
    const { base, donor } = await generateFonts(dir, {
      donorGlyphs: 64,
      placeholderDonor: PLACEHOLDER_COUNT,
    });

    // The faking donor: the run is suspected, the real coverage keeps
    // its own 64 codepoints (glyph-0-free cmap, disjoint sets).
    const donorMeta = parseFontMeta(
      new Uint8Array(readFileSync(donor)).buffer as ArrayBuffer,
    );
    expect(donorMeta.placeholderCodepoints).toEqual(PLACEHOLDER_RUN);
    expect(donorMeta.codepoints).toHaveLength(64);
    expect(
      donorMeta.codepoints.filter((cp) => cp >= 0xe000 && cp < 0xf900),
    ).toEqual([]);

    // The clean base: no suspects at all.
    const baseMeta = parseFontMeta(
      new Uint8Array(readFileSync(base)).buffer as ArrayBuffer,
    );
    expect(baseMeta.placeholderCodepoints).toEqual([]);
    expect(baseMeta.codepoints).toHaveLength(26);
  });

  test("a THREE-codepoint notdef-outline run reads as a placeholder (no thresholds)", async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "fontalloy-ph3-"));
    const { donor } = await generateFonts(dir, {
      donorGlyphs: 64,
      placeholderDonor: 3,
    });

    // Round 19: the outline rule has no count arm — three codepoints on
    // a glyph that draws .notdef's box (not glyph 0, not named .notdef)
    // still read as missing, never as coverage.
    const meta = parseFontMeta(
      new Uint8Array(readFileSync(donor)).buffer as ArrayBuffer,
    );
    expect(meta.placeholderCodepoints).toEqual([0xe000, 0xe001, 0xe002]);
    expect(meta.codepoints).toHaveLength(64);
  });

  test("a shared glyph below the mass-duplication threshold is plain coverage", async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "fontalloy-shared-"));
    const { donor } = await generateFonts(dir, {
      donorGlyphs: 64,
      sharedGlyphDonor: 8,
    });

    // Round 20 keeps round 19's negative BELOW the threshold: real
    // shared glyphs (space, the big-parenthesis pieces — the shipped
    // 213-face survey's worst case was 5 codepoints on one name) keep
    // counting as coverage however they share one glyph of their own
    // outline.
    const meta = parseFontMeta(
      new Uint8Array(readFileSync(donor)).buffer as ArrayBuffer,
    );
    expect(meta.placeholderCodepoints).toEqual([]);
    expect(meta.codepoints).toHaveLength(64 + 8);
    expect(
      meta.codepoints.filter((cp) => cp >= 0xe000 && cp < 0xf900),
    ).toEqual([0xe000, 0xe001, 0xe002, 0xe003, 0xe004, 0xe005, 0xe006, 0xe007]);
  });

  test("a mass-duplicated glyph counts as missing while its glyph still renders", async ({
    page,
  }) => {
    const dir = await mkdtemp(resolve(tmpdir(), "fontalloy-mass-"));
    const { donor } = await generateFonts(dir, {
      donorGlyphs: 64,
      sharedGlyphDonor: 80,
    });

    // Round 20, rule 3 (owner-ratified): one glyph absorbing >= 64
    // mapped codepoints is a suspected MASS-DUPLICATED placeholder
    // whatever its outline — the parse drops the run from coverage.
    const meta = parseFontMeta(
      new Uint8Array(readFileSync(donor)).buffer as ArrayBuffer,
    );
    expect(meta.placeholderCodepoints).toEqual(
      Array.from({ length: 80 }, (_, i) => 0xe000 + i),
    );
    expect(meta.codepoints).toHaveLength(64);

    // The grid keeps rendering the FONT'S OWN glyph under the missing
    // style (the box the font really draws there) — the missing-unmapped
    // treatment (no glyph at all) is for codepoints nothing maps.
    collectJsErrors(page, jsErrors);
    await page.goto("/");
    await waitForFontsReady(page);
    await pointerClick(page, page.locator('[data-role="picker-cjk"] .kit-hd'));
    await page.locator("input[data-role='font-file']").setInputFiles(donor);
    await expect(page.locator('[data-picker-popup="cjk"]')).toBeHidden();
    await pointerClick(
      page,
      page.locator(".kit-cat-g[data-group='icons']"),
    );
    const cell = page.locator(".charmap-grid .kit-cell[data-cp='U+E000']");
    await expect(cell).toHaveClass(/miss/);
    await expect(cell.locator(".cp")).toHaveText("E000");
    await expect(cell.locator(".ch")).toHaveText("\uE000");
    const family = await cell.evaluate((el) => getComputedStyle(el).fontFamily);
    expect(family).toContain("AlloyDonor");

    // The missing counters include the mass-duplicated run: the lone
    // pick covers its 64 hanzi and nothing else of the universe.
    const chip = page.locator(".kit-catbar .kit-cat-g[data-group='missing']");
    await expect(chip.locator(".n")).toHaveText(
      (browseUniverseSize() - 64).toLocaleString("en-US"),
    );
    await expect(page.locator("[data-stat='missing']")).toHaveText(
      (browseUniverseSize() - 64).toLocaleString("en-US"),
    );
  });

  test("a CFF face flags its .notdef-outline glyph the same way", async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "fontalloy-cff-"));
    const { donor } = await generateFonts(dir, {
      donorGlyphs: 8,
      placeholderDonor: 5,
      cffDonor: true,
    });

    // The CFF parse path (charstring INDEX compare): the .notdef-
    // outline glyph's codepoints read as missing on OTF faces too,
    // and the real coverage is untouched.
    const meta = parseFontMeta(
      new Uint8Array(readFileSync(donor)).buffer as ArrayBuffer,
    );
    expect(meta.placeholderCodepoints).toEqual([
      0xe000, 0xe001, 0xe002, 0xe003, 0xe004,
    ]);
    expect(meta.codepoints).toHaveLength(8);
  });

  test("the report states the faked block and the build drops it", async ({
    page,
  }) => {
    const service = await startServeFixture({
      donorGlyphs: 2000,
      placeholderDonor: PLACEHOLDER_COUNT,
    });
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
      const meta = parseFontMeta(
        new Uint8Array(readFileSync(saved[0])).buffer as ArrayBuffer,
      );
      expect(meta.placeholderCodepoints).toEqual([]);
      expect(
        meta.codepoints.filter((cp) => cp >= 0xe000 && cp < 0xf900),
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
