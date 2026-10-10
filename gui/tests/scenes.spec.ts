import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { generateFonts, startServeFixture, type ServeFixture } from "./serve";
import {
  assertNoJsErrors,
  collectJsErrors,
  pointerClick,
  waitForFontsReady,
} from "./helpers";

/**
 * Issue #19: scene previews and synthesis settings.
 *
 * The judgment loop beyond the grid: terminal / code / document scenes
 * rendering mixed CJK+Latin sample text with the EFFECTIVE merged result
 * (the same per-codepoint resolution the preview grid uses), plus the
 * three synthesis settings (weight merge mode, baseline alignment, CJK
 * width), each behind a ?-popover carrying a worked-example table that
 * states honestly what the pipeline does with the option.
 *
 * Mode and scene switches must preserve the merge state: rules, picks,
 * and the resolver output all survive without a reset.
 */
test.describe("scene previews and synthesis settings", () => {
  test.describe.configure({ mode: "serial" });
  const jsErrors: string[] = [];

  test.beforeEach(() => {
    jsErrors.length = 0;
  });

  test.afterEach(() => assertNoJsErrors(jsErrors));

  /** Small fixture pair: base = A–Z, donor = A–F + U+4E00..U+4E3F. */
  async function makeLocalFixtures(): Promise<{ base: string; donor: string }> {
    const dir = await mkdtemp(resolve(tmpdir(), "fontalloy-scene-"));
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
      page.locator(`[data-role="picker-${role}"] .picker-anchor`),
    );
    const popup = page.locator(`[data-picker-popup="${role}"]`);
    await expect(popup).toBeVisible();
    await popup
      .locator(".popup-footer input[type=file]")
      .setInputFiles(path);
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

  /** Switch the right content area to the scene mode. */
  async function gotoSceneMode(page: Page): Promise<void> {
    await pointerClick(
      page,
      page.locator('.mode-tab[data-mode="scene"]'),
    );
    await expect(
      page.locator('.content-stage[data-mode="scene"]'),
    ).toBeVisible();
  }

  /** Switch to one scene (terminal / code / document). */
  async function gotoScene(
    page: Page,
    scene: "terminal" | "code" | "document",
  ): Promise<void> {
    await pointerClick(
      page,
      page.locator(`.scene-tab[data-scene="${scene}"]`),
    );
    await expect(
      page.locator(`.scene-panel[data-scene="${scene}"]`),
    ).toBeVisible();
  }

  /** The computed font family that renders one scene character. */
  function sceneCharFamily(
    page: Page,
    scene: string,
    cp: string,
  ): Promise<string> {
    return page.evaluate(
      ([sceneId, target]) => {
        const span = document.querySelector(
          `.scene-panel[data-scene="${sceneId}"] .scene-char[data-cp="${target}"]`,
        );
        if (!span) return "";
        return getComputedStyle(span).fontFamily.split(",")[0]!.trim();
      },
      [scene, cp],
    );
  }

  /* --------------------------------------------------------------- */
  /* The three scenes render mixed sample text effectively.           */
  /* --------------------------------------------------------------- */

  test("three scenes render mixed CJK+Latin text with the effective result", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);
    await gotoSceneMode(page);

    // Terminal: a realistic prompt + ls output block. The fixture fonts
    // cover uppercase A–Z (base) and U+4E00..U+4E3F + A–F (donor); the
    // samples are written for real fonts, the assertions below stick to
    // codepoints the fixtures actually cover.
    const terminal = page.locator(".scene-panel[data-scene='terminal']");
    const terminalText = await terminal.textContent();
    expect(terminalText).toContain("fontalloy build");
    expect(terminalText).toContain("字体清单");
    // Effective rendering: Latin resolves to the base, CJK to the donor.
    expect(
      await page
        .locator(".scene-panel[data-scene='terminal'] .scene-char[data-cp='U+0052']")
        .first()
        .getAttribute("data-winner"),
    ).toBe("base");
    expect(await sceneCharFamily(page, "terminal", "U+0052")).toBe("AlloyBase");
    expect(
      await page
        .locator(".scene-panel[data-scene='terminal'] .scene-char[data-cp='U+4E00']")
        .first()
        .getAttribute("data-winner"),
    ).toBe("donor-0");
    expect(await sceneCharFamily(page, "terminal", "U+4E00")).toBe("AlloyDonor");

    // Code: a realistic TypeScript sample with Chinese comments.
    await gotoScene(page, "code");
    const codeText = await page
      .locator(".scene-panel[data-scene='code']")
      .textContent();
    expect(codeText).toContain("export function merge");
    expect(codeText).toContain("窄者胜");
    expect(
      await page
        .locator(".scene-panel[data-scene='code'] .scene-char[data-cp='U+4E09']")
        .first()
        .getAttribute("data-winner"),
    ).toBe("donor-0");

    // Document: mixed prose.
    await gotoScene(page, "document");
    const docText = await page
      .locator(".scene-panel[data-scene='document']")
      .textContent();
    expect(docText).toContain("FontAlloy");
    expect(docText).toContain("英文等宽字体");
    expect(
      await page
        .locator(".scene-panel[data-scene='document'] .scene-char[data-cp='U+0046']")
        .first()
        .getAttribute("data-winner"),
    ).toBe("base");
    expect(
      await page
        .locator(".scene-panel[data-scene='document'] .scene-char[data-cp='U+4E0B']")
        .first()
        .getAttribute("data-winner"),
    ).toBe("donor-0");

    // A codepoint no build font covers renders through the fallback stack
    // and is marked as uncovered (the scene never lies, like the grid).
    const uncovered = page.locator(
      ".scene-panel[data-scene='document'] .scene-char.is-uncovered",
    );
    await expect(uncovered.first()).toBeAttached();
  });

  test("scenes work without picks: samples render in the fallback stack with a note", async ({
    page,
  }) => {
    collectJsErrors(page, jsErrors);
    await page.goto("/");
    await waitForFontsReady(page);
    await gotoSceneMode(page);
    const terminalText = await page
      .locator(".scene-panel[data-scene='terminal']")
      .textContent();
    expect(terminalText).toContain("fontalloy build");
    await expect(
      page.locator(".scene-note"),
    ).toContainText("选择英文字体与中文字体");
  });

  /* --------------------------------------------------------------- */
  /* The scenes consume the SAME effective resolution as the grid.    */
  /* --------------------------------------------------------------- */

  test("a precedence rule flips the scene rendering live", async ({ page }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);
    await gotoSceneMode(page);
    await gotoScene(page, "document");

    // 'A' (U+0041) in "FontAlloy": both fonts hold it, base wins by default.
    const a = page.locator(
      ".scene-panel[data-scene='document'] .scene-char[data-cp='U+0041']",
    );
    await expect(a).toHaveAttribute("data-winner", "base");
    await expect(a).toHaveAttribute("data-via", "default");
    expect(await sceneCharFamily(page, "document", "U+0041")).toBe("AlloyBase");

    // A single-codepoint rule from the rail (the rail is shared with the
    // scene mode): 0x41 -> [donor-0] only.
    await pointerClick(page, page.locator("[data-role='add-cp-rule']"));
    const row = page.locator("[data-role='custom-rule']").last();
    const id = await row.getAttribute("data-rule-id");
    await row.locator(`[data-role='rule-codepoint-${id}']`).fill("0x0041");
    await row.locator(`[data-role='rule-font-${id}-base']`).uncheck();

    // The scene re-renders in place: donor now renders the 'A', via the rule.
    await expect(a).toHaveAttribute("data-winner", "donor-0");
    await expect(a).toHaveAttribute("data-via", "rule-0");
    await expect(a).toHaveAttribute("data-kind", "override");
    expect(await sceneCharFamily(page, "document", "U+0041")).toBe("AlloyDonor");
  });

  test("mode and scene switches preserve the merge state (no reset)", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);

    // Establish merge state: a rule + a grid selection.
    await pointerClick(page, page.locator("[data-role='add-cp-rule']"));
    const row = page.locator("[data-role='custom-rule']").last();
    const id = await row.getAttribute("data-rule-id");
    await row.locator(`[data-role='rule-codepoint-${id}']`).fill("0x0041");
    await row.locator(`[data-role='rule-font-${id}-base']`).uncheck();
    await expect(page.locator("[data-stat='rules']")).toHaveText("1");

    // Scene and back: rules, picks, and the grid's effective result survive.
    await gotoSceneMode(page);
    await expect(
      page.locator(
        ".scene-panel[data-scene='terminal'] .scene-char[data-cp='U+0041']",
      ),
    ).toHaveAttribute("data-via", "rule-0");
    await pointerClick(
      page,
      page.locator('.mode-tab[data-mode="charmap"]'),
    );
    await expect(
      page.locator(".charmap-grid .cell[data-cp='U+0041']"),
    ).toHaveAttribute("data-winner", "donor-0");
    await expect(page.locator("[data-stat='rules']")).toHaveText("1");
    await expect(
      page.locator("[data-role='picker-en'] .picker-current"),
    ).toContainText("AlloyBase");
    await expect(
      page.locator("[data-role='picker-cjk'] .picker-current"),
    ).toContainText("AlloyDonor");

    // Scene tab selection survives a round trip too.
    await gotoSceneMode(page);
    await gotoScene(page, "code");
    await pointerClick(
      page,
      page.locator('.mode-tab[data-mode="charmap"]'),
    );
    await gotoSceneMode(page);
    await expect(
      page.locator(".scene-panel[data-scene='code']"),
    ).toBeVisible();
    await expect(page.locator("[data-stat='rules']")).toHaveText("1");
  });

  /* --------------------------------------------------------------- */
  /* The synthesis settings and their worked-example popovers.        */
  /* --------------------------------------------------------------- */

  test("settings present with worked-example popovers; popup mechanics hold", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);

    // The three settings with their ratified option labels.
    const weight = page.locator("[data-role='select-weightMode']");
    const baseline = page.locator("[data-role='select-baseline']");
    const width = page.locator("[data-role='select-cjkWidth']");
    await expect(weight).toHaveValue("nearest");
    await expect(baseline).toHaveValue("auto");
    await expect(width).toHaveValue("halfwidth");
    expect(await weight.locator("option").allTextContents()).toEqual([
      "双方字重全部保留 · 推荐",
      "仅保留英文字体提供的字重",
      "仅保留中文字体提供的字重",
    ]);
    expect(await baseline.locator("option").allTextContents()).toEqual([
      "自动 · 推荐",
      "中文字和英文底边一样高",
      "中文字缩小一点更匀称",
    ]);
    expect(await width.locator("option").allTextContents()).toEqual([
      "两倍英文宽 · 推荐（引号破折号半角）",
      "两倍英文宽（引号破折号全角 · 中文习惯）",
    ]);

    // The weight popover: opened by a real click, clamped to the app
    // frame, and carrying the worked-example tables.
    await pointerClick(page, page.locator("[data-role='help-weightMode']"));
    const weightPop = page.locator("[data-help-popup='weightMode']");
    await expect(weightPop).toBeVisible();
    await expect(weightPop.locator("table").first()).toContainText(
      "双方字重全部保留",
    );
    // Honesty: the popover states the pipeline constraint (ADR-0006).
    await expect(weightPop).toContainText("成品字重只能来自英文字体");
    const box = await weightPop.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(
      page.viewportSize()!.height,
    );

    // Popup node survives re-renders: a store update while open keeps
    // the SAME node open (ADR-0004 — the node is created once). The
    // update is driven through a grid cell (the popover legitimately
    // overlays the rail rows below its anchor).
    await page.evaluate(() => {
      const pop = document.querySelector("[data-help-popup='weightMode']");
      if (pop) pop.setAttribute("data-marker", "seen");
    });
    await pointerClick(page, page.locator(".charmap-grid .cell").first());
    await expect(
      page.locator("[data-help-popup='weightMode'][data-marker='seen']"),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(weightPop).toBeHidden();

    // Baseline popover: the fixed em-box convention is stated.
    await pointerClick(page, page.locator("[data-role='help-baseline']"));
    const baselinePop = page.locator("[data-help-popup='baseline']");
    await expect(baselinePop).toBeVisible();
    await expect(baselinePop.locator("table")).toContainText("底边一样高");
    await expect(baselinePop).toContainText("共用同一条基线");
    await page.keyboard.press("Escape");

    // CJK width popover: the honest ratio story (2:1 fixed, quotes knob).
    await pointerClick(page, page.locator("[data-role='help-cjkWidth']"));
    const widthPop = page.locator("[data-help-popup='cjkWidth']");
    await expect(widthPop).toBeVisible();
    await expect(widthPop.locator("table")).toContainText("全角");
    await expect(widthPop).toContainText("1.8");

    // Screenshots with popovers open (seam-3 rule) over the workspace.
    const { mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(process.cwd(), "test-results", "screenshots");
    mkdirSync(dir, { recursive: true });
    await page.screenshot({
      path: join(dir, "scenes-cjk-width-popover.png"),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await pointerClick(page, page.locator("[data-role='help-weightMode']"));
    await expect(weightPop).toBeVisible();
    await page.screenshot({
      path: join(dir, "scenes-weight-popover.png"),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await pointerClick(page, page.locator("[data-role='help-baseline']"));
    await expect(baselinePop).toBeVisible();
    await page.screenshot({
      path: join(dir, "scenes-baseline-popover.png"),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
  });

  /* --------------------------------------------------------------- */
  /* The settings map onto the recipe the synthesize flow submits.    */
  /* --------------------------------------------------------------- */

  test("settings serialize into the submitted recipe (real serve)", async ({
    page,
  }) => {
    const service: ServeFixture = await startServeFixture({
      donorGlyphs: 64,
      donorAscii: 6,
    });
    const submissions: Array<Record<string, unknown>> = [];
    try {
      // The save stand-in (the synthesize flow saves through it).
      const saveDir = await mkdtemp(resolve(tmpdir(), "fontalloy-save-"));
      await page.exposeFunction("__fontalloyTestSave", async (name: string, b64: string) => {
        const target = resolve(saveDir, name);
        await writeFile(target, Buffer.from(b64, "base64"));
        return target;
      });
      await page.addInitScript(() => {
        const config = window as unknown as {
          __FONTALLOY_CONFIG__: Record<string, unknown>;
        };
        config.__FONTALLOY_CONFIG__ = {
          saveArtifact: async (
            _name: string,
            _bytes: Uint8Array,
          ): Promise<{ saved: boolean; path: string | null }> => {
            const b64 = btoa(
              Array.from(_bytes, (b) => String.fromCharCode(b)).join(""),
            );
            const path = await window.__fontalloyTestSave(_name, b64);
            return path === null
              ? { saved: false, path: null }
              : { saved: true, path };
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
      // Capture every recipe the page POSTs (the wire the app speaks).
      await page.route("**/builds", async (route) => {
        if (route.request().method() === "POST") {
          submissions.push(route.request().postDataJSON());
        }
        await route.continue();
      });

      collectJsErrors(page, jsErrors);
      await page.goto("/");
      await waitForFontsReady(page);
      await expect(page.locator('[data-role="service-state"]')).toHaveText(
        /已连接/,
      );
      await loadIntoPicker(page, "en", service.baseFont);
      await loadIntoPicker(page, "cjk", service.donorFont);

      // Default settings: nothing but base/donors/rules — the core
      // defaults block is simply not sent.
      await pointerClick(page, page.locator(".topbar .synthesize"));
      await expect(page.locator(".build-row").first()).toBeVisible({
        timeout: 30_000,
      });
      expect(submissions.length).toBe(1);
      expect(submissions[0]!).not.toHaveProperty("normalization");
      expect(submissions[0]!).not.toHaveProperty("weights");

      // Optical baseline + fullwidth quotes: the normalization block.
      await page
        .locator("[data-role='select-baseline']")
        .selectOption("optical");
      await page
        .locator("[data-role='select-cjkWidth']")
        .selectOption("fullwidth");
      await pointerClick(page, page.locator(".topbar .synthesize"));
      await expect(page.locator(".build-row").nth(1)).toBeVisible({
        timeout: 30_000,
      });
      expect(submissions.length).toBe(2);
      expect(submissions[1]!.normalization).toEqual({
        mode: "optical",
        quote_dash_width: "fullwidth",
      });

      // Weight mode "base only": an explicit slot per base-file face
      // (the fixtures are single 400 faces, shared by both files).
      await page
        .locator("[data-role='select-weightMode']")
        .selectOption("base");
      await pointerClick(page, page.locator(".topbar .synthesize"));
      await expect(page.locator(".build-row").nth(2)).toBeVisible({
        timeout: 30_000,
      });
      expect(submissions.length).toBe(3);
      expect(submissions[2]!.normalization).toEqual({
        mode: "optical",
        quote_dash_width: "fullwidth",
      });
      expect(submissions[2]!.weights).toEqual([{ weight: 400 }]);

      // Weight mode "donor only": the shared weights only — with these
      // fixtures the same single 400 slot.
      await page
        .locator("[data-role='select-weightMode']")
        .selectOption("donor");
      await pointerClick(page, page.locator(".topbar .synthesize"));
      await expect(page.locator(".build-row").nth(3)).toBeVisible({
        timeout: 30_000,
      });
      expect(submissions.length).toBe(4);
      expect(submissions[3]!.weights).toEqual([{ weight: 400 }]);

      // And the builds themselves settle done with the non-default
      // settings (the pipeline accepted the mapped recipe).
      await expect(
        page.locator(".build-row", { hasText: "已保存" }).nth(3),
      ).toBeVisible({ timeout: 60_000 });
    } finally {
      await service.dispose();
    }
  });
});
