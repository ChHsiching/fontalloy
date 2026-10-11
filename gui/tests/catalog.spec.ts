import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { parseFontMeta } from "../src/fonts/sfnt";
import {
  assertNoJsErrors,
  collectJsErrors,
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
 *
 * Settle signal: the progress screen's DOM (per-family statuses, counts)
 * survives being hidden, so tests wait on its text rather than trying to
 * catch the overlay mid-flight.
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

/** The first-run progress screen (its DOM persists while hidden). */
const screen = (page: Page) => page.locator(".catalog-screen");
const familyStatus = (page: Page, family: string) =>
  screen(page).locator(`.catalog-family[data-family='${family}'] .catalog-family-status`);
/** Settles once the bootstrap document parsed and families initialized. */
const catalogTotal = (page: Page) =>
  screen(page).locator("[data-stat='catalog-total']");
const catalogDone = (page: Page) =>
  screen(page).locator("[data-stat='catalog-done']");
/** The EN picker popup (scoped: both pickers keep popups on <body>). */
const enPopup = (page: Page) => page.locator('[data-picker-popup="en"]');
/** A catalog family's row (rows are keyed by their pick id: the css
 *  family once registered, `cat:<family>` while not). */
const catalogRow = (page: Page, family: string) =>
  enPopup(page).locator(".kit-fp", { hasText: family });

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

    await expect(screen(page)).toBeVisible();
    await expect(catalogDone(page)).toHaveText("1");
    await expect(catalogTotal(page)).toHaveText("3");
    await expect(familyStatus(page, "Alloy Sans")).toHaveText("已完成");
    await expect(familyStatus(page, "Alloy Serif")).toHaveText("下载中");
    await expect(familyStatus(page, "Alloy Mono")).toHaveText("等待下载");

    openGate();
    await expect(screen(page)).toBeHidden();
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

    await expect(screen(page)).toBeVisible();
    await pointerClick(page, screen(page).locator(".catalog-skip"));
    await expect(screen(page)).toBeHidden();

    // The workspace was alive under the overlay the whole time.
    await expect(page.locator(".workspace-rail")).toBeVisible();
    await expect(page.locator(".statsbar")).toBeVisible();

    // Downloads continue in the background; the families land as fonts.
    // Sans and Serif come from two distinct host faces; Mono reuses the
    // Sans face binary, so it registers onto the same css family (dedupe)
    // — the three rows self-render in exactly two distinct faces.
    openGate();
    await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
    await expect
      .poll(() =>
        enPopup(page)
          .evaluate((el) => {
            const faces = new Set<string>();
            for (const row of el.querySelectorAll(".kit-fp")) {
              const font = getComputedStyle(row.querySelector(".kit-nm")!).fontFamily;
              if (font && !font.startsWith("system-ui")) faces.add(font);
            }
            return faces.size;
          }),
      )
      .toBe(2);
  });

  test("a sha256 mismatch fails only that family; startup is never blocked", async ({
    page,
  }) => {
    const sim = await SimCatalog.create(FAMILY_SPECS);
    sim.fail["Alloy Mono"] = "corrupt";
    await sim.install(page);
    await injectCatalogConfig(page);
    await page.goto("/");

    await expect(catalogTotal(page)).toHaveText("3");
    await expect(familyStatus(page, "Alloy Mono")).toHaveText("下载失败");
    await expect(familyStatus(page, "Alloy Sans")).toHaveText("已完成");
    await expect(catalogDone(page)).toHaveText("2");
    await expect(screen(page)).toBeHidden();

    // The picker lists the verified families and marks the missing one.
    await pointerClick(
      page,
      page.locator('[data-role="picker-en"] .kit-hd'),
    );
    await expect(catalogRow(page, "Alloy Sans")).toBeVisible();
    await expect(catalogRow(page, "Alloy Serif")).toBeVisible();
    const missing = catalogRow(page, "Alloy Mono");
    await expect(missing).toBeVisible();
    await expect(missing.locator(".kit-fp-note")).toContainText("未下载");
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

    await expect(catalogTotal(page)).toHaveText("3");
    openGate();
    await expect(familyStatus(page, "Alloy Mono")).toHaveText("下载失败");
    await expect(screen(page)).toBeHidden();

    // Both origins were tried before giving up (ordered origin list).
    expect(sim.count("primary:Alloy Mono")).toBe(1);
    expect(sim.count("backup:Alloy Mono")).toBe(1);

    // The missing family is shown as such in the picker.
    await pointerClick(
      page,
      page.locator('[data-role="picker-en"] .kit-hd'),
    );
    await expect(
      catalogRow(page, "Alloy Mono").locator(".kit-fp-note"),
    ).toContainText("未下载");
  });

  test("verified families persist: a later launch fetches nothing and shows no screen", async ({
    page,
  }) => {
    const sim = await SimCatalog.create(FAMILY_SPECS);
    await sim.install(page);
    await injectCatalogConfig(page);
    await page.goto("/");
    await expect(catalogDone(page)).toHaveText("3");
    await expect(screen(page)).toBeHidden();

    await page.reload();
    await waitForFontsReady(page);
    await expect(catalogTotal(page)).toHaveText("3");
    await expect(catalogDone(page)).toHaveText("3");
    await expect(screen(page)).toBeHidden();

    // Only the bootstrap document was fetched again; no zip was re-downloaded.
    expect(sim.count("release")).toBe(2);
    expect(sim.count("primary:Alloy Sans")).toBe(1);
    expect(sim.count("primary:Alloy Serif")).toBe(1);
    expect(sim.count("primary:Alloy Mono")).toBe(1);

    // The stored catalog still feeds the picker.
    await pointerClick(
      page,
      page.locator('[data-role="picker-en"] .kit-hd'),
    );
    await expect(catalogRow(page, "Alloy Sans")).toBeVisible();
  });

  test("a failed family retries and heals on a later launch", async ({
    page,
  }) => {
    const sim = await SimCatalog.create(FAMILY_SPECS);
    sim.fail["Alloy Mono"] = "corrupt";
    await sim.install(page);
    await injectCatalogConfig(page);
    await page.goto("/");
    await expect(familyStatus(page, "Alloy Mono")).toHaveText("下载失败");
    expect(sim.count("primary:Alloy Mono")).toBe(1);

    sim.fail = {}; // the origin heals between launches
    await page.reload();
    await waitForFontsReady(page);
    await expect(familyStatus(page, "Alloy Mono")).toHaveText("已完成");
    await expect(catalogDone(page)).toHaveText("3");

    // Only the missing family was fetched again; verified ones were skipped.
    expect(sim.count("primary:Alloy Mono")).toBe(2);
    expect(sim.count("primary:Alloy Sans")).toBe(1);

    await pointerClick(
      page,
      page.locator('[data-role="picker-en"] .kit-hd'),
    );
    const healed = catalogRow(page, "Alloy Mono");
    await expect(healed).toBeVisible();
    await expect(healed.locator(".kit-fp-note")).toHaveCount(0);
    expect(await healed.getAttribute("aria-disabled")).toBeNull();
  });

  test("the ordered origin list is consumed: a down primary falls through to the backup", async ({
    page,
  }) => {
    expectNetworkFailures = true; // the down primary aborts by design
    const sim = await SimCatalog.create(FAMILY_SPECS);
    sim.downOrigin["Alloy Serif"] = "primary";
    await sim.install(page);
    await injectCatalogConfig(page);
    await page.goto("/");
    await expect(catalogDone(page)).toHaveText("3");
    await expect(screen(page)).toBeHidden();

    expect(sim.count("primary:Alloy Serif")).toBe(1);
    expect(sim.count("backup:Alloy Serif")).toBe(1);

    await pointerClick(
      page,
      page.locator('[data-role="picker-en"] .kit-hd'),
    );
    const row = catalogRow(page, "Alloy Serif");
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
    await expect(catalogDone(page)).toHaveText("3");

    await pointerClick(
      page,
      page.locator('[data-role="picker-en"] .kit-hd'),
    );
    const sansRow = catalogRow(page, "Alloy Sans");
    await expect(sansRow).toBeVisible();

    // The row TEXT is the metadata family; the row FONT is the parsed face.
    // The two differ by construction here, which pins "metadata-driven".
    // (Computed font-family drops the quotes — compare the bare name.)
    await expect(sansRow).toContainText("Alloy Sans");
    await expect
      .poll(() =>
        sansRow
          .locator(".kit-nm")
          .evaluate((el) => getComputedStyle(el).fontFamily),
      )
      .toContain(cssA);
    const rendered = await sansRow
      .locator(".kit-nm")
      .evaluate((el) => getComputedStyle(el).fontFamily);
    expect(rendered).not.toContain("Alloy Sans");
    // MetaLine tags come from the repo's catalog manifest; the fixture
    // families are invented, so their rows carry no meta (the kit demo
    // specs cover the MetaLine rendering itself).
    await expect(sansRow.locator(".kit-meta")).toHaveCount(0);

    // Search filters across the catalog rows.
    const search = enPopup(page).locator(".kit-q");
    await expect(search).toBeVisible();
    await search.fill("Serif");
    await expect(catalogRow(page, "Alloy Sans")).toBeHidden();
    await expect(catalogRow(page, "Alloy Serif")).toBeVisible();
    await search.fill("");
    await expect(catalogRow(page, "Alloy Sans")).toBeVisible();

    // The local-file footer stays outside the scroll area.
    await expect(enPopup(page).locator(".kit-fpsys")).toContainText(
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
    await expect(catalogDone(page)).toHaveText("3");

    await pointerClick(
      page,
      page.locator('[data-role="picker-en"] .kit-hd'),
    );
    await pointerClick(page, catalogRow(page, "Alloy Sans"));
    await waitForFontsReady(page);

    await expect(
      page.locator('[data-role="picker-en"] .kit-hd b'),
    ).toHaveText("Alloy Sans");
    await expect(
      page.locator("[data-role='font-pair'] [data-pair='base']"),
    ).toHaveText("Alloy Sans");

    // Independent oracle: the face is really registered under the parsed
    // family name and covers U+0041.
    const loaded = await page.evaluate(
      (fam) => document.fonts.check(`16px "${fam}"`, "A"),
      cssA,
    );
    expect(loaded).toBe(true);

    // The selection drives the plain preview cells and the coverage
    // counters like a local font (a lone pick still resolves).
    const cellFont = await page
      .locator(".charmap-grid .kit-cell[data-cp='U+0041']")
      .evaluate((el) => getComputedStyle(el).fontFamily);
    expect(cellFont).toContain(cssA);
    await expect(page.locator("[data-stat='en']")).not.toHaveText("0");
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
    await expect(screen(page)).toBeHidden();
    await expect(page.locator(".workspace-rail")).toBeVisible();

    await pointerClick(
      page,
      page.locator('[data-role="picker-en"] .kit-hd'),
    );
    await expect(
      enPopup(page).locator("[data-picker-note]"),
    ).toContainText("目录不可用");
    await expect(catalogRow(page, "Alloy Sans")).toHaveCount(0);

    // Local files load and preview exactly as before the catalog existed.
    await page.locator("input[data-role='font-file']").setInputFiles(FONT_A);
    await waitForFontsReady(page);
    await expect(enPopup(page).locator(".kit-fp")).toHaveCount(1);
    await pointerClick(page, enPopup(page).locator(".kit-fp").first());
    await expect(page.locator("[data-stat='en']")).not.toHaveText("0");
  });
});
