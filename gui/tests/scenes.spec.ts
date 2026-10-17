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
 * The judgment loop beyond the grid: the kit's three stacked scene cards
 * (终端 / 代码编辑器 / 文档) rendering the prototype's sample content with
 * the EFFECTIVE merged result (the same per-codepoint resolution the
 * preview grid uses), each with its own theme select (14 terminal / 10
 * editor palettes) and 全屏查看 expand, plus the three synthesis settings
 * (weight merge mode, baseline alignment, CJK width) behind ?-popovers
 * carrying worked-example tables that state honestly what the pipeline
 * does with the option.
 *
 * Mode switches must preserve the merge state: rules, picks, and the
 * resolver output all survive without a reset.
 */

/** Escape for exact-text regexes. */
const re = (text: string): RegExp => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

test.describe("scene previews and synthesis settings", () => {
  test.describe.configure({ mode: "serial" });
  const jsErrors: string[] = [];

  /** The shared fixture serve (ticket #35: scene coloring resolves
   *  through `POST /precedence-resolve` — the TS mirror is gone). */
  let service: ServeFixture | null = null;

  test.beforeAll(async () => {
    service = await startServeFixture({ donorGlyphs: 64, donorAscii: 6 });
  });

  test.afterAll(async () => {
    await service?.dispose();
    service = null;
  });

  test.beforeEach(() => {
    jsErrors.length = 0;
  });

  test.afterEach(() => assertNoJsErrors(jsErrors));

  /** The fixture pair: base = A–Z, donor = A–F + U+4E00..U+4E3F. */
  function makeLocalFixtures(): { base: string; donor: string } {
    const live = service!;
    return { base: live.baseFont, donor: live.donorFont };
  }

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
    // Round 4: a successful local load CLOSES the picker (prototype
    // parity — the closed card shows the new pick).
    await expect(popup).toBeHidden();
  }

  /** Open the page pointed at the fixture serve, with both fonts picked. */
  async function openWithFonts(
    page: Page,
    fonts: { base: string; donor: string },
  ): Promise<void> {
    collectJsErrors(page, jsErrors);
    await page.addInitScript((url: string) => {
      const config = window as unknown as {
        __FONTALLOY_CONFIG__: Record<string, unknown>;
      };
      config.__FONTALLOY_CONFIG__ ??= {};
      config.__FONTALLOY_CONFIG__.serveUrl = url;
    }, service!.url);
    await page.goto("/");
    await waitForFontsReady(page);
    await loadIntoPicker(page, "en", fonts.base);
    await loadIntoPicker(page, "cjk", fonts.donor);
  }

  /** Switch the right content area to the scene mode. */
  async function gotoSceneMode(page: Page): Promise<void> {
    await pointerClick(
      page,
      page.locator(".kit-modebar .kit-mseg button[data-value='scene']"),
    );
    await expect(
      page.locator(".content-stage[data-mode='scene']"),
    ).toBeVisible();
  }

  /** Declare one codepoint to the donor side through the 按编码指定
   *  popup (the charmap toolbar's affordance; 留空=单个). */
  async function addDonorCpRule(page: Page, cp: string): Promise<void> {
    await pointerClick(page, page.locator("[data-role='range-specify']"));
    const popup = page.locator("[data-range-popup]");
    await expect(popup).toBeVisible();
    await popup.locator("[data-role='range-start']").fill(cp);
    const side = popup.locator("[data-role='range-side']");
    await pointerClick(page, side.locator(".kit-csel"));
    // Wait for the dropdown to paint before clicking its option, and
    // for the commit to land before 添加 — under a full parallel run
    // the palette's allow-discrete open lags the click that opened it
    // (suite convention: a visible-wait between dependent steps).
    await expect(side.locator(".kit-csel-pk")).toBeVisible();
    await pointerClick(page, side.locator(".kit-cso[data-value='donor']"));
    await expect(side.locator(".kit-csel")).toContainText("用中文字体");
    await pointerClick(page, popup.locator("[data-role='range-add']"));
    await expect(popup).toBeHidden();
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
          `.kit-sc[data-scene="${sceneId}"] span[data-cp="${target}"]`,
        );
        if (!span) return "";
        return getComputedStyle(span).fontFamily.split(",")[0]!.trim();
      },
      [scene, cp],
    );
  }

  /* --------------------------------------------------------------- */
  /* The three scene cards render mixed sample text effectively.      */
  /* --------------------------------------------------------------- */

  test("three stacked scene cards render mixed CJK+Latin text effectively", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);
    await gotoSceneMode(page);

    // All three cards are visible at once (the prototype's composition).
    for (const scene of ["terminal", "code", "document"]) {
      await expect(page.locator(`.kit-sc[data-scene='${scene}']`)).toBeVisible();
    }

    // Terminal: the prototype's multi-command log. The fixture fonts
    // cover uppercase A–Z (base) and U+4E00..U+4E3F + A–F (donor); the
    // assertions stick to codepoints the fixtures actually cover.
    const terminal = page.locator(".kit-sc[data-scene='terminal']");
    const terminalText = await terminal.textContent();
    expect(terminalText).toContain("git log"); // NBSP alignment (kit rule)
    expect(terminalText).toContain("docker ps");
    // Effective rendering: Latin resolves to the base, CJK to the donor.
    expect(
      await page
        .locator(".kit-sc[data-scene='terminal'] span[data-cp='U+0052']")
        .first()
        .getAttribute("data-winner"),
    ).toBe("base");
    expect(await sceneCharFamily(page, "terminal", "U+0052")).toBe("AlloyBase");
    expect(
      await page
        .locator(".kit-sc[data-scene='terminal'] span[data-cp='U+4E2D']")
        .first()
        .getAttribute("data-winner"),
    ).toBe("donor-0");
    expect(await sceneCharFamily(page, "terminal", "U+4E2D")).toBe("AlloyDonor");

    // Code editor: the prototype's TypeScript sample with Chinese comments.
    const codeText = await page
      .locator(".kit-sc[data-scene='code']")
      .textContent();
    expect(codeText).toContain("import { FC");
    expect(codeText).toContain("中文字体补齐汉字与标点");
    expect(
      await page
        .locator(".kit-sc[data-scene='code'] span[data-cp='U+4E2D']")
        .first()
        .getAttribute("data-winner"),
    ).toBe("donor-0");

    // Document: mixed prose; its spans carry provenance like the grid.
    const docText = await page
      .locator(".kit-sc[data-scene='document']")
      .textContent();
    expect(docText).toContain("FontAlloy 使用指南");
    expect(docText).toContain("英文字母、数字和连字符");
    expect(
      await page
        .locator(".kit-sc[data-scene='document'] span[data-cp='U+0043']")
        .first()
        .getAttribute("data-winner"),
    ).toBe("base");

    // A codepoint no build font covers renders through the fallback stack
    // and carries no winner (the scene never lies, like the grid).
    const uncovered = page.locator(
      ".kit-sc[data-scene='document'] span[data-cp]:not([data-winner])",
    );
    await expect(uncovered.first()).toBeAttached();
  });

  test("the custom preview text renders through the effective resolution", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);
    await gotoSceneMode(page);

    // Type preview text whose codepoints the fixtures cover.
    const preview = page.locator("[data-role='preview-text']");
    await preview.fill("一 A 中");
    await expect(
      page.locator(".kit-sc[data-scene='document'] span[data-cp='U+4E00']").first(),
    ).toHaveAttribute("data-winner", "donor-0");
    await expect(
      page.locator(".kit-sc[data-scene='document'] span[data-cp='U+0041']").first(),
    ).toHaveAttribute("data-winner", "base");
  });

  test("scenes work without picks: samples render with a fallback stack", async ({
    page,
  }) => {
    collectJsErrors(page, jsErrors);
    await page.goto("/");
    await waitForFontsReady(page);
    await gotoSceneMode(page);
    const terminalText = await page
      .locator(".kit-sc[data-scene='terminal']")
      .textContent();
    expect(terminalText).toContain("git log"); // NBSP alignment (kit rule)
    // No picks: no span claims a winner.
    await expect(
      page.locator(".kit-sc[data-scene='terminal'] span[data-winner]"),
    ).toHaveCount(0);
  });

  /* --------------------------------------------------------------- */
  /* The scenes consume the SAME effective resolution as the grid.    */
  /* --------------------------------------------------------------- */

  test("a precedence rule flips the scene rendering live", async ({ page }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);
    await gotoSceneMode(page);

    // 'A' in the custom preview text: both fonts hold it, base wins.
    const preview = page.locator("[data-role='preview-text']");
    await preview.fill("A");
    const a = page.locator(
      ".kit-sc[data-scene='document'] span[data-cp='U+0041']",
    ).first();
    await expect(a).toHaveAttribute("data-winner", "base");
    await expect(a).toHaveAttribute("data-via", "default");
    expect(await sceneCharFamily(page, "document", "U+0041")).toBe("AlloyBase");

    // A rule through the 按编码指定 popup (the rule state is shared with
    // the scene mode): 0x41 -> donor only, via the charmap's affordance.
    await pointerClick(
      page,
      page.locator(".kit-modebar .kit-mseg button[data-value='charmap']"),
    );
    await addDonorCpRule(page, "0x41");
    await gotoSceneMode(page);

    // The scene re-renders in place: donor now renders the 'A', via the rule
    // (rule-1: the boot-seeded zh_cn preset is complete rule 0).
    await expect(a).toHaveAttribute("data-winner", "donor-0");
    await expect(a).toHaveAttribute("data-via", "rule-1");
    await expect(a).toHaveAttribute("data-kind", "override");
    expect(await sceneCharFamily(page, "document", "U+0041")).toBe("AlloyDonor");
  });

  test("mode switches preserve the merge state (no reset)", async ({ page }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);

    // Establish merge state: a rule through the 按编码指定 popup.
    await addDonorCpRule(page, "0x41");

    // Scene and back: rules, picks, and the grid's effective result survive.
    await gotoSceneMode(page);
    await expect(
      page.locator(".kit-sc[data-scene='terminal'] span[data-cp='U+0041']").first(),
    ).toHaveAttribute("data-via", "rule-1");
    await pointerClick(
      page,
      page.locator(".kit-modebar .kit-mseg button[data-value='charmap']"),
    );
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+0041']"),
    ).toHaveAttribute("data-winner", "donor-0");
    await expect(
      page.locator("[data-role='picker-en'] .kit-hd b"),
    ).toContainText("AlloyBase");
    await expect(
      page.locator("[data-role='picker-cjk'] .kit-hd b"),
    ).toContainText("AlloyDonor");

    // The scene cards are all still there after a round trip, and the
    // rule still flips the terminal's 'A' (IMAGE in the docker table).
    await gotoSceneMode(page);
    await expect(page.locator(".kit-sc[data-scene='code']")).toBeVisible();
    await expect(
      page.locator(".kit-sc[data-scene='terminal'] span[data-cp='U+0041']").first(),
    ).toHaveAttribute("data-via", "rule-1");
  });

  /* --------------------------------------------------------------- */
  /* Scene chrome: theme selects and the fullscreen expand.           */
  /* --------------------------------------------------------------- */

  test("per-card theme selects (14 terminal / 10 editor) and fullscreen expand", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);
    await gotoSceneMode(page);

    // The terminal card's theme select lists 跟随主题 + 13 named themes.
    const termSelect = page.locator(".kit-sc[data-scene='terminal'] .kit-cselw");
    await pointerClick(page, termSelect.locator(".kit-csel"));
    await expect(termSelect.locator(".kit-cso")).toHaveCount(14);
    await expect(termSelect.locator(".kit-cso").first()).toHaveText("跟随主题");
    // Picking a named theme locks the palette (data-t on the terminal body).
    await pointerClick(page, termSelect.locator(".kit-cso", { hasText: "Dracula" }));
    await expect(
      page.locator(".kit-sc[data-scene='terminal'] .kit-term"),
    ).toHaveAttribute("data-t", "dracula");
    await page.keyboard.press("Escape");

    // The editor card lists 10; the document card has no select at all.
    const codeSelect = page.locator(".kit-sc[data-scene='code'] .kit-cselw");
    await pointerClick(page, codeSelect.locator(".kit-csel"));
    await expect(codeSelect.locator(".kit-cso")).toHaveCount(10);
    await page.keyboard.press("Escape");
    await expect(
      page.locator(".kit-sc[data-scene='document'] .kit-cselw"),
    ).toHaveCount(0);

    // 全屏查看 opens the fullscreen scene with prev/next/close chrome.
    await pointerClick(page, page.locator(".kit-sc[data-scene='terminal'] .kit-zb"));
    const fullscreen = page.locator(".kit-zf");
    await expect(fullscreen).toBeVisible();
    await expect(fullscreen.locator("[data-role='fullscreen-close']")).toBeVisible();
    await expect(fullscreen.locator(".kit-term")).toBeVisible();

    // Round 5, owner item 9: the overlay never covers the top bar —
    // its top edge starts at the bar's bottom, keeping the window
    // chrome clickable — and the zoomed type is comfortable (16px).
    const bounds = await page.evaluate(() => {
      const bar = document.querySelector<HTMLElement>(".topbar")!;
      const zf = document.querySelector<HTMLElement>(".kit-zf")!;
      return {
        barBottom: bar.getBoundingClientRect().bottom,
        zfTop: zf.getBoundingClientRect().top,
        fontSize: getComputedStyle(zf.querySelector(".kit-term")!).fontSize,
      };
    });
    expect(bounds.zfTop).toBeGreaterThanOrEqual(bounds.barBottom - 0.5);
    expect(bounds.fontSize).toBe("16px");

    // Round 5, owner item 10: the theme select is available while
    // zoomed, and picking a palette locks it on the zoomed terminal.
    const zoomSelect = fullscreen.locator("[data-role='fullscreen-theme']");
    await expect(zoomSelect).toBeVisible();
    await pointerClick(page, zoomSelect.locator(".kit-csel"));
    await pointerClick(page, zoomSelect.locator(".kit-cso", { hasText: "Dracula" }));
    await expect(fullscreen.locator(".kit-term")).toHaveAttribute(
      "data-t",
      "dracula",
    );

    // Prev/next swap content IN PLACE: the SAME overlay node stays
    // mounted (no close-then-reopen choreography).
    await fullscreen.evaluate((el) => el.setAttribute("data-marker", "alive"));
    await pointerClick(page, fullscreen.locator("button", { hasText: "下一项" }));
    await expect(
      page.locator(".kit-zf[data-marker='alive'] .kit-code"),
    ).toBeVisible();
    await expect(page.locator(".kit-zf[data-marker='alive'] .kit-term")).toHaveCount(0);
    await pointerClick(page, fullscreen.locator("button", { hasText: "上一项" }));
    await expect(
      page.locator(".kit-zf[data-marker='alive'] .kit-term"),
    ).toBeVisible();

    await pointerClick(page, fullscreen.locator("[data-role='fullscreen-close']"));
    await expect(fullscreen).toHaveCount(0);
  });

  /* --------------------------------------------------------------- */
  /* The synthesis settings and their worked-example popovers.        */
  /* --------------------------------------------------------------- */

  /** Pick one option of a settings AppSelect by its exact label. */
  async function pickSetting(
    page: Page,
    key: string,
    label: string,
  ): Promise<void> {
    const select = page.locator(`[data-role='select-${key}']`);
    const option = select.locator(".kit-cso", { hasText: re(label) });
    // Bounded steps with one retry: a missed open click must surface as
    // a clear failure, never as an unbounded wait for absent options.
    for (let attempt = 0; attempt < 2; attempt++) {
      await pointerClick(page, select.locator(".kit-csel"));
      try {
        await select.locator(".kit-csel-pk").waitFor({ state: "visible", timeout: 2_000 });
        await option.waitFor({ state: "visible", timeout: 2_000 });
        break;
      } catch {
        if (attempt === 1) throw new Error(`select-${key} did not open`);
      }
    }
    await pointerClick(page, option);
    await expect(select.locator(".kit-csel")).toHaveText(label, { timeout: 5_000 });
  }

  test("settings present with worked-example popovers; popup mechanics hold", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);

    // The three settings with their ratified option labels. The 推荐
    // mark is a badge element (icon-purge round): its text rides after
    // the label, one normalized space between.
    const weight = page.locator("[data-role='select-weightMode']");
    const baseline = page.locator("[data-role='select-baseline']");
    const width = page.locator("[data-role='select-cjkWidth']");
    await expect(weight.locator(".kit-csel")).toHaveText(
      "双方字重全部保留 推荐",
    );
    await expect(baseline.locator(".kit-csel")).toHaveText("直接组合（不调整） 默认");
    await expect(width.locator(".kit-csel")).toHaveText("2 倍英文宽 推荐");
    await expect(
      weight.locator(".kit-csel .kit-badge"),
    ).toHaveText("推荐");
    await pointerClick(page, weight.locator(".kit-csel"));
    expect(await weight.locator(".kit-cso").allTextContents()).toEqual([
      "双方字重全部保留 推荐",
      "仅保留英文字体提供的字重",
      "仅保留中文字体提供的字重",
    ]);
    await page.keyboard.press("Escape");
    await pointerClick(page, baseline.locator(".kit-csel"));
    expect(await baseline.locator(".kit-cso").allTextContents()).toEqual([
      "直接组合（不调整） 默认",
      "自动对齐",
      "中文字和英文底边一样高",
      "中文字缩小一点更匀称",
    ]);
    await page.keyboard.press("Escape");
    await pointerClick(page, width.locator(".kit-csel"));
    expect(await width.locator(".kit-cso").allTextContents()).toEqual([
      "2 倍英文宽 推荐",
      "1.8 倍英文宽",
      "1.5 倍英文宽",
    ]);
    await page.keyboard.press("Escape");

    // The weight popover: opened by a real click, clamped to the app
    // frame, and carrying the prototype's VERBATIM worked-example tables
    // (round 5, owner item 11 — the 中等 output row is back, the
    // engineering note is gone).
    await pointerClick(page, page.locator("[data-role='help-weightMode']"));
    const weightPop = page.locator("[data-help-popup='weight']");
    await expect(weightPop).toBeVisible();
    await expect(weightPop.locator("table").first()).toContainText(
      "双方字重全部保留",
    );
    await expect(weightPop.locator("table").first()).toContainText(
      "细、常规、中等、粗体",
    );
    await expect(weightPop.locator("table").nth(1)).toContainText("中等");
    await expect(weightPop).not.toContainText("ADR");
    await expect(weightPop).not.toContainText("管线约束");
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
      const pop = document.querySelector("[data-help-popup='weight']");
      if (pop) pop.setAttribute("data-marker", "seen");
    });
    // Any store update works; the pager next button sits clear of the
    // popover (which legitimately overlays the grid's first cells).
    await pointerClick(
      page,
      page.locator(".kit-toolrow .kit-pgc button[aria-label='下一页']"),
    );
    await expect(
      page.locator("[data-help-popup='weight'][data-marker='seen']"),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(weightPop).toBeHidden();

    // Baseline popover: round 26 copy — 直接组合 leads (the default),
    // the harmonization schools follow.
    await pointerClick(page, page.locator("[data-role='help-baseline']"));
    const baselinePop = page.locator("[data-help-popup='baseline']");
    await expect(baselinePop).toBeVisible();
    await expect(baselinePop.locator("table")).toContainText(
      "直接组合 · 默认",
    );
    await expect(baselinePop.locator("table")).toContainText("底边一样高");
    await expect(baselinePop).toContainText(
      "选“直接组合”时，“中文字符宽度”设置不生效——宽度完全跟随中文字体本身。",
    );
    await page.keyboard.press("Escape");

    // CJK width popover: verbatim prototype copy (inv. 30) — the 1.8x
    // and 1.5x rows are the pipeline's width_factor knob.
    await pointerClick(page, page.locator("[data-role='help-cjkWidth']"));
    const widthPop = page.locator("[data-help-popup='cjk-width']");
    await expect(widthPop).toBeVisible();
    await expect(widthPop.locator("table")).toContainText(
      "标准等宽，一个中文正好对齐两个英文",
    );
    await expect(widthPop.locator("table")).toContainText(
      "1.8 倍英文宽",
    );
    await expect(widthPop.locator("table")).toContainText(
      "很窄，一行能放更多中文",
    );

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
    // Four real builds over one serve instance: the per-build waits alone
    // can reach 30s each, so the file's default test timeout cannot hold
    // under full-parallel load.
    test.setTimeout(120_000);
    const service: ServeFixture = await startServeFixture({
      donorGlyphs: 64,
      donorAscii: 6,
    });
    const submissions: Array<Record<string, unknown>> = [];
    const saved: string[] = [];
    try {
      // The save stand-in (the synthesize flow saves through it).
      const saveDir = await mkdtemp(resolve(tmpdir(), "fontalloy-save-"));
      await page.exposeFunction("__fontalloyTestSave", async (name: string, b64: string) => {
        const target = resolve(saveDir, name);
        await writeFile(target, Buffer.from(b64, "base64"));
        saved.push(target);
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
      await loadIntoPicker(page, "en", service.baseFont);
      await loadIntoPicker(page, "cjk", service.donorFont);
      const synthesize = page.locator(".topbar [data-role='synthesize']");
      await expect(synthesize).toHaveAttribute("aria-disabled", "false");

      // Default settings: nothing but base/donors/rules — the core
      // defaults block is simply not sent.
      await pointerClick(page, synthesize);
      await expect(page.locator(".build-row").first()).toBeVisible({
        timeout: 30_000,
      });
      expect(submissions.length).toBe(1);
      expect(submissions[0]!).not.toHaveProperty("normalization");
      expect(submissions[0]!).not.toHaveProperty("weights");

      // Optical baseline + the 1.8x width factor: the normalization
      // block (the prototype's compacter width setting as a real knob).
      await pickSetting(page, "baseline", "中文字缩小一点更匀称");
      await pickSetting(page, "cjkWidth", "1.8 倍英文宽");
      await pointerClick(page, synthesize);
      await expect(page.locator(".build-row").nth(1)).toBeVisible({
        timeout: 30_000,
      });
      expect(submissions.length).toBe(2);
      expect(submissions[1]!.normalization).toEqual({
        mode: "optical",
        width_factor: 1.8,
      });

      // Weight mode "base only": an explicit slot per base-file face
      // (the fixtures are single 400 faces, shared by both files).
      await pickSetting(page, "weightMode", "仅保留英文字体提供的字重");
      await pointerClick(page, synthesize);
      await expect(page.locator(".build-row").nth(2)).toBeVisible({
        timeout: 30_000,
      });
      expect(submissions.length).toBe(3);
      expect(submissions[2]!.normalization).toEqual({
        mode: "optical",
        width_factor: 1.8,
      });
      expect(submissions[2]!.weights).toEqual([{ weight: 400 }]);

      // Weight mode "donor only": the shared weights only — with these
      // fixtures the same single 400 slot.
      await pickSetting(page, "weightMode", "仅保留中文字体提供的字重");
      await pointerClick(page, synthesize);
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
