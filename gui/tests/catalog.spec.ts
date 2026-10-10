import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { parseFontMeta } from "../src/fonts/sfnt";
import {
  assertNoJsErrors,
  collectJsErrors,
  cssFamilyQuote,
  fixtureFontPaths,
  pointerClick,
  waitForFontsReady,
} from "./helpers";
import { SimCatalog, injectCatalogConfig } from "./catalog-fixtures";

/**
 * First-run catalog download and self-rendering pickers (issue #17).
 *
 * The catalog origin is simulated with page.route interception over the
 * real catalog-release metadata schema (see ./catalog-fixtures.ts). The
 * app's storage abstraction persists into the browser profile, so a
 * `page.reload()` inside one test is a real "later launch".
 */

const [FONT_A, FONT_B] = fixtureFontPaths();

/** Three clearly fake catalog families over two real host font binaries. */
const FAMILY_SPECS = [
  { family: "Alloy Sans", file: "AlloySans-Regular.ttf", fontPath: FONT_A, deflate: true },
  { family: "Alloy Serif", file: "AlloySerif-Regular.ttf", fontPath: FONT_B },
  { family: "Alloy Mono", file: "AlloyMono-Regular.ttf", fontPath: FONT_A },
];

/** The css family the browser registers for a host font (parsed face name). */
async function parsedCssFamily(path: string): Promise<string> {
  const bytes = await readFile(path);
  return parseFontMeta(
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  ).family;
}

test.describe("first-run catalog download", () => {
  const jsErrors: string[] = [];
  /** Tests that deliberately abort requests set this; Chromium turns those
   * aborts into `net::ERR_*` resource console lines that are expected. */
  let expectNetworkFailures = false;

  test.beforeEach(async ({ page }) => {
    jsErrors.length = 0;
    expectNetworkFailures = false;
    collectJsErrors(page, jsErrors);
  });

  test.afterEach(() => {
    if (expectNetworkFailures) {
      const unexpected = jsErrors.filter(
        (line) => !/^console\.error: Failed to load resource: net::ERR_/.test(line),
      );
      expect(
        unexpected,
        `unexpected JS errors:\n${unexpected.join("\n")}`,
      ).toEqual([]);
    } else {
      assertNoJsErrors(jsErrors);
    }
  });

  test("first run downloads behind a progress screen with per-family status, then opens the workspace", async ({
    page,
  }) => {
    const sim = await SimCatalog.create(FAMILY_SPECS);
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    sim.gates["Alloy Serif"] = () => gate; // hold the 2nd family mid-download
    await sim.install(page);
    await injectCatalogConfig(page);
    await page.goto("/");

    const screen = page.locator(".catalog-screen");
    await expect(screen).toBeVisible();
    await expect(screen.locator("[data-stat='catalog-done']")).toHaveText("1");
    await expect(screen.locator("[data-stat='catalog-total']")).toHaveText("3");
    const status = (family: string) =>
      screen.locator(
        `.catalog-family[data-family='${family}'] .catalog-family-status`,
      );
    await expect(status("Alloy Sans")).toHaveText("已完成");
    await expect(status("Alloy Serif")).toHaveText("下载中");
    await expect(status("Alloy Mono")).toHaveText("等待下载");

    openGate();
    await expect(screen).toBeHidden();
    await expect(page.locator(".workspace-rail")).toBeVisible();
    await expect(page.locator(".charmap")).toBeVisible();
  });

  test("the progress screen can be skipped; the workspace works while downloads continue", async ({
    page,
  }) => {
    const sim = await SimCatalog.create(FAMILY_SPECS);
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    sim.gates["Alloy Serif"] = () => gate;
    await sim.install(page);
    await injectCatalogConfig(page);
    await page.goto("/");

    const screen = page.locator(".catalog-screen");
    await expect(screen).toBeVisible();
    await pointerClick(page, screen.locator(".catalog-skip"));
    await expect(screen).toBeHidden();

    // The workspace was alive under the overlay the whole time.
    await expect(page.locator(".workspace-rail")).toBeVisible();
    await expect(page.locator(".statsbar")).toBeVisible();

    // Downloads continue in the background; the families land as fonts.
    // Sans and Serif come from two distinct host faces; Mono reuses the
    // Sans face binary, so it registers onto the same css family (dedupe).
    openGate();
    await expect(page.locator("[data-stat='fonts']")).toHaveText("2");
  });

  test("a sha256 mismatch fails only that family; startup is never blocked", async ({
    page,
  }) => {
    const sim = await SimCatalog.create(FAMILY_SPECS);
    sim.fail["Alloy Mono"] = "corrupt";
    await sim.install(page);
    await injectCatalogConfig(page);
    await page.goto("/");

    const screen = page.locator(".catalog-screen");
    await expect(screen).toBeVisible();
    await expect(screen).toBeHidden(); // auto-closes once the run settles

    // The picker lists the verified families and marks the missing one.
    await pointerClick(
      page,
      page.locator('[data-role="picker-en"] .picker-anchor'),
    );
    const popup = page.locator('[data-picker-popup="en"]');
    await expect(
      popup.locator(".picker-row[data-family='Alloy Sans']"),
    ).toBeVisible();
    await expect(
      popup.locator(".picker-row[data-family='Alloy Serif']"),
    ).toBeVisible();
    const missing = popup.locator(".picker-row[data-family='Alloy Mono']");
    await expect(missing).toBeVisible();
    await expect(missing.locator(".picker-row-tag")).toContainText("未下载");
    expect(await missing.getAttribute("aria-disabled")).toBe("true");
  });

  test("network failure on every origin fails the family and never blocks startup", async ({
    page,
  }) => {
    expectNetworkFailures = true;
    const sim = await SimCatalog.create(FAMILY_SPECS);
    sim.fail["Alloy Mono"] = "abort";
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    sim.gates["Alloy Mono"] = () => gate; // observe the failed status on screen
    await sim.install(page);
    await injectCatalogConfig(page);
    await page.goto("/");

    const screen = page.locator(".catalog-screen");
    await expect(screen).toBeVisible();
    openGate();
    await expect(
      screen.locator(
        ".catalog-family[data-family='Alloy Mono'] .catalog-family-status",
      ),
    ).toHaveText("下载失败");
    await expect(screen).toBeHidden();

    // Both origins were tried before giving up (ordered origin list).
    expect(sim.count("primary:Alloy Mono")).toBe(1);
    expect(sim.count("backup:Alloy Mono")).toBe(1);

    // The missing family is shown as such in the picker.
    await pointerClick(
      page,
      page.locator('[data-role="picker-en"] .picker-anchor'),
    );
    await expect(
      page.locator(".picker-row[data-family='Alloy Mono'] .picker-row-tag"),
    ).toContainText("未下载");
  });

  test("verified families persist: a later launch fetches nothing and shows no screen", async ({
    page,
  }) => {
    const sim = await SimCatalog.create(FAMILY_SPECS);
    await sim.install(page);
    await injectCatalogConfig(page);
    await page.goto("/");
    await expect(page.locator(".catalog-screen")).toBeHidden();

    await page.reload();
    await waitForFontsReady(page);
    await expect(page.locator(".catalog-screen")).toBeHidden();

    // Only the bootstrap document was fetched again; no zip was re-downloaded.
    expect(sim.count("release")).toBe(2);
    expect(sim.count("primary:Alloy Sans")).toBe(1);
    expect(sim.count("primary:Alloy Serif")).toBe(1);
    expect(sim.count("primary:Alloy Mono")).toBe(1);

    // The stored catalog still feeds the picker.
    await pointerClick(
      page,
      page.locator('[data-role="picker-en"] .picker-anchor'),
    );
    await expect(
      page.locator(".picker-row[data-family='Alloy Sans']"),
    ).toBeVisible();
  });

  test("a failed family retries and heals on a later launch", async ({
    page,
  }) => {
    const sim = await SimCatalog.create(FAMILY_SPECS);
    sim.fail["Alloy Mono"] = "corrupt";
    await sim.install(page);
    await injectCatalogConfig(page);
    await page.goto("/");
    await expect(page.locator(".catalog-screen")).toBeHidden();
    expect(sim.count("primary:Alloy Mono")).toBe(1);

    sim.fail = {}; // the origin heals between launches
    await page.reload();
    await waitForFontsReady(page);

    // Only the missing family was fetched again; verified ones were skipped.
    expect(sim.count("primary:Alloy Mono")).toBe(2);
    expect(sim.count("primary:Alloy Sans")).toBe(1);

    await pointerClick(
      page,
      page.locator('[data-role="picker-en"] .picker-anchor'),
    );
    const healed = page.locator(".picker-row[data-family='Alloy Mono']");
    await expect(healed).toBeVisible();
    await expect(healed.locator(".picker-row-tag")).toHaveCount(0);
    expect(await healed.getAttribute("aria-disabled")).toBeNull();
  });

  test("the ordered origin list is consumed: a down primary falls through to the backup", async ({
    page,
  }) => {
    const sim = await SimCatalog.create(FAMILY_SPECS);
    sim.downOrigin["Alloy Serif"] = "primary";
    await sim.install(page);
    await injectCatalogConfig(page);
    await page.goto("/");
    await expect(page.locator(".catalog-screen")).toBeHidden();

    expect(sim.count("primary:Alloy Serif")).toBe(1);
    expect(sim.count("backup:Alloy Serif")).toBe(1);

    await pointerClick(
      page,
      page.locator('[data-role="picker-en"] .picker-anchor'),
    );
    const row = page.locator(".picker-row[data-family='Alloy Serif']");
    await expect(row).toBeVisible();
    expect(await row.getAttribute("aria-disabled")).toBeNull();
  });

  test("catalog picker rows are metadata-driven, self-rendered, and searchable", async ({
    page,
  }) => {
    const cssA = await parsedCssFamily(FONT_A);
    const sim = await SimCatalog.create(FAMILY_SPECS);
    await sim.install(page);
    await injectCatalogConfig(page);
    await page.goto("/");
    await expect(page.locator(".catalog-screen")).toBeHidden();

    await pointerClick(
      page,
      page.locator('[data-role="picker-en"] .picker-anchor'),
    );
    const popup = page.locator('[data-picker-popup="en"]');
    const sansRow = popup.locator(".picker-row[data-family='Alloy Sans']");
    await expect(sansRow).toBeVisible();

    // The row TEXT is the metadata family; the row FONT is the parsed face.
    // The two differ by construction here, which pins "metadata-driven".
    await expect(sansRow).toContainText("Alloy Sans");
    await expect
      .poll(() => sansRow.evaluate((el) => getComputedStyle(el).fontFamily))
      .toContain(cssFamilyQuote(cssA));
    const rendered = await sansRow.evaluate(
      (el) => getComputedStyle(el).fontFamily,
    );
    expect(rendered).not.toContain("Alloy Sans");

    // Search filters across the catalog rows.
    const search = popup.locator(".picker-search");
    await expect(search).toBeVisible();
    await search.fill("Serif");
    await expect(
      popup.locator(".picker-row[data-family='Alloy Sans']"),
    ).toBeHidden();
    await expect(
      popup.locator(".picker-row[data-family='Alloy Serif']"),
    ).toBeVisible();
    await search.fill("");
    await expect(
      popup.locator(".picker-row[data-family='Alloy Sans']"),
    ).toBeVisible();

    // The local-file footer stays outside the scroll area.
    await expect(popup.locator(".popup-footer")).toContainText(
      "加载本地字体文件",
    );
  });

  test("selecting a catalog font registers it via the FontFace path and drives the workspace", async ({
    page,
  }) => {
    const cssA = await parsedCssFamily(FONT_A);
    const sim = await SimCatalog.create(FAMILY_SPECS);
    await sim.install(page);
    await injectCatalogConfig(page);
    await page.goto("/");
    await expect(page.locator(".catalog-screen")).toBeHidden();

    await pointerClick(
      page,
      page.locator('[data-role="picker-en"] .picker-anchor'),
    );
    await pointerClick(
      page,
      page.locator(".picker-row[data-family='Alloy Sans']"),
    );
    await waitForFontsReady(page);

    await expect(
      page.locator('[data-role="picker-en"] .picker-current'),
    ).toHaveText("Alloy Sans");
    await expect(page.locator("[data-role='pair-en']")).toHaveText(
      "EN Alloy Sans",
    );

    // Independent oracle: the face is really registered under the parsed
    // family name and covers U+0041.
    const loaded = await page.evaluate(
      (fam) => document.fonts.check(`16px "${fam}"`, "A"),
      cssA,
    );
    expect(loaded).toBe(true);

    // The selection drives the preview stack and coverage like a local font.
    const stack = await page
      .locator(".charmap-grid")
      .evaluate((el) => el.style.getPropertyValue("--font-preview"));
    expect(stack).toContain(cssFamilyQuote(cssA));
    const coverage = await page
      .locator("[data-stat='coverage']")
      .textContent();
    expect(Number((coverage ?? "0").replace(/,/g, ""))).toBeGreaterThan(0);
  });

  test("offline: the catalog is unavailable and local fonts work fully", async ({
    page,
  }) => {
    expectNetworkFailures = true;
    await page.route("https://catalog.test/**", (route) =>
      route.abort("connectionfailed"),
    );
    await injectCatalogConfig(page);
    await page.goto("/");
    await waitForFontsReady(page);

    // No progress screen when there is nothing to download.
    await expect(page.locator(".catalog-screen")).toBeHidden();
    await expect(page.locator(".workspace-rail")).toBeVisible();

    await pointerClick(
      page,
      page.locator('[data-role="picker-en"] .picker-anchor'),
    );
    const popup = page.locator('[data-picker-popup="en"]');
    await expect(popup.locator(".picker-catalog-note")).toContainText(
      "目录不可用",
    );
    await expect(popup.locator(".picker-row[data-family]")).toHaveCount(0);

    // Local files load and preview exactly as before the catalog existed.
    await popup
      .locator(".popup-footer input[type=file]")
      .setInputFiles(FONT_A);
    await waitForFontsReady(page);
    await expect(page.locator("[data-stat='fonts']")).toHaveText("1");
    await pointerClick(page, popup.locator(".picker-row").first());
    const coverage = await page
      .locator("[data-stat='coverage']")
      .textContent();
    expect(Number((coverage ?? "0").replace(/,/g, ""))).toBeGreaterThan(0);
  });
});
