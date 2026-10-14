import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { parseFontMeta } from "../src/fonts/sfnt";
import { BROWSE_UNIVERSE, isCjkRegionCodepoint } from "../src/unicode/universe";
import {
  assertNoJsErrors,
  collectJsErrors,
  fixtureFontPaths,
  pointerClick,
  waitForFontsReady,
} from "./helpers";
import { SimCatalog, injectCatalogConfig } from "./catalog-fixtures";

/**
 * Round 18 (owner item 3): repeat-click unload. Clicking the row — or
 * the row's ACTIVE variant chip — that this picker role ALREADY picked
 * clears that slot's selection back to the fresh never-picked null.
 *
 * The workspace must degrade exactly like the initial state (lone-pick
 * preview grid, synthesize disabled under the initial pick-missing
 * rule), the OTHER slot stays untouched, and re-picking still works.
 * A DIFFERENT chip still switches cuts: only the chip that IS the
 * active cut of the picked row unloads.
 *
 * The synthesize enablement rule needs a CONNECTED service to be
 * pick-driven (service reasons outrank pick reasons in the disabled
 * explanation), so every test runs against a page.route-faked serve
 * over the real /health probe — no merge is ever submitted; the
 * disabled state never reaches the network.
 */

const [FONT_A, FONT_B] = fixtureFontPaths();

/** One host font's parsed name-table strings (the row/pair identity). */
const metaCache = new Map<string, ReturnType<typeof parseFontMeta>>();
async function parsedMeta(path: string): Promise<ReturnType<typeof parseFontMeta>> {
  const cached = metaCache.get(path);
  if (cached) return cached;
  const bytes = await readFile(path);
  const meta = parseFontMeta(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  metaCache.set(path, meta);
  return meta;
}

/**
 * The simulated catalog: one invented EN-slot family (a plain
 * release-only row, no chips) plus the WenKai GROUP row for the CJK
 * slot — two fetched member families over two distinct host faces, so
 * the default cut (标准) and the Screen cut resolve to visibly
 * different fonts.
 */
async function simCatalog(): Promise<SimCatalog> {
  return SimCatalog.create([
    { family: "Alloy Sans", file: "AlloySans-Regular.ttf", fontPath: FONT_A },
    {
      family: "LXGWWenKai",
      variant: "Regular",
      file: "LXGWWenKai-Regular.ttf",
      fontPath: FONT_B,
    },
    {
      family: "LXGWWenKaiScreen",
      variant: "Regular",
      file: "LXGWWenKaiScreen-Regular.ttf",
      fontPath: FONT_A,
    },
  ]);
}

const SERVE_ORIGIN = "https://serve.test";

/**
 * A connected merge service, faked at the network layer: /health
 * answers the fontalloy probe, /fonts and /catalog answer empty
 * indexes (their failures are tolerated by the client anyway). The
 * synthesize action's enablement is then EXACTLY the pick pair — the
 * same rule the fresh initial state sits under.
 */
async function installFakeService(page: Page): Promise<void> {
  await page.route(`${SERVE_ORIGIN}/**`, (route) => {
    const cors = { "access-control-allow-origin": "*" };
    const path = new URL(route.request().url()).pathname;
    if (path === "/health") {
      return route.fulfill({
        status: 200,
        headers: { ...cors, "content-type": "application/json" },
        body: JSON.stringify({
          service: "fontalloy",
          version: "test",
          address: "127.0.0.1",
          port: 1,
        }),
      });
    }
    if (path === "/fonts") {
      return route.fulfill({
        status: 200,
        headers: { ...cors, "content-type": "application/json" },
        body: JSON.stringify({ directories: [], families: [], skipped: [] }),
      });
    }
    if (path === "/catalog") {
      return route.fulfill({
        status: 200,
        headers: { ...cors, "content-type": "application/json" },
        body: JSON.stringify({ families: [] }),
      });
    }
    return route.fulfill({ status: 404, headers: cors, body: "not found" });
  });
  // After injectCatalogConfig (which ASSIGNS the config object): add
  // the serve URL onto it.
  await page.addInitScript((url: string) => {
    const config = window as unknown as {
      __FONTALLOY_CONFIG__?: Record<string, unknown>;
    };
    config.__FONTALLOY_CONFIG__ ??= {};
    config.__FONTALLOY_CONFIG__.serveUrl = url;
  }, SERVE_ORIGIN);
}

/** The identity strings the assertions compare against. */
interface Fixture {
  /** FONT_A's name-table display name (Alloy Sans's face; the Screen cut). */
  nameA: string;
  /** FONT_B's name-table display name (the WenKai default cut's face). */
  nameB: string;
  /** FONT_B's css family (the lone-donor preview face). */
  cssB: string;
}

/** Boot the workspace over the sim catalog + fake service. */
async function bootWorkspace(page: Page): Promise<Fixture> {
  const metaA = await parsedMeta(FONT_A);
  const metaB = await parsedMeta(FONT_B);
  await page.route("https://api.github.com/repos/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  const sim = await simCatalog();
  await sim.install(page);
  await injectCatalogConfig(page);
  await installFakeService(page);
  await page.goto("/");
  await expect(
    page.locator(".catalog-screen [data-stat='catalog-done']"),
  ).toHaveText("3");
  await expect(page.locator(".catalog-screen")).toBeHidden();
  await waitForFontsReady(page);
  return { nameA: metaA.names.display, nameB: metaB.names.display, cssB: metaB.family };
}

/**
 * The expected script-region counters (round 20) of the given host
 * faces' union coverage: the browsed universe's codepoints the faces
 * cover, split by where each SITS (inside the 中日韩文字 region → 中文,
 * else → 英文). Host fixtures may carry no CJK at all (Arial stands in
 * for WenKai on this host) — a Latin-only donor legitimately leaves
 * 中文 at 0 now, which the old winner-side `not 0` expectation could
 * never survive.
 */
async function expectedRegionCounts(
  ...fonts: string[]
): Promise<{ en: string; cjk: string }> {
  const covered = new Set<string>();
  for (const path of fonts) {
    const meta = await parsedMeta(path);
    for (const cp of meta.codepoints) covered.add(cp);
  }
  let en = 0;
  let cjk = 0;
  for (const [start, end] of BROWSE_UNIVERSE) {
    for (let cp = start; cp <= end; cp++) {
      if (!covered.has(cp)) continue;
      if (isCjkRegionCodepoint(cp)) cjk++;
      else en++;
    }
  }
  return { en: en.toLocaleString("en-US"), cjk: cjk.toLocaleString("en-US") };
}

/* ---------- small shared locators ---------- */

const pairTag = (page: Page, side: "base" | "donor") =>
  page.locator(`[data-role='font-pair'] [data-pair='${side}']`);
const cardName = (page: Page, role: "en" | "cjk") =>
  page.locator(`[data-role='picker-${role}'] .kit-hd b`);
const popupOf = (page: Page, role: "en" | "cjk") =>
  page.locator(`[data-picker-popup='${role}']`);
const synthesize = (page: Page) => page.locator(".topbar [data-role='synthesize']");
const stat = (page: Page, key: string) => page.locator(`[data-stat='${key}']`);

/** The WenKai group row (located by its chips — names change with the
 *  registered cut, the chip ids never do). */
const wenkaiRow = (page: Page) =>
  popupOf(page, "cjk")
    .locator(".kit-fp")
    .filter({
      has: page.locator(".kit-vchip[data-chip='LXGWWenKai::Regular']"),
    });

/** Open a picker popup by clicking its card header. */
async function openPicker(page: Page, role: "en" | "cjk"): Promise<void> {
  await pointerClick(page, page.locator(`[data-role='picker-${role}'] .kit-hd`));
  await expect(popupOf(page, role)).toBeVisible();
}

/** Pick the EN slot's Alloy Sans row (closes the popup like any pick).
 *  The row is the slot's only row, displaying its host face's own
 *  name-table name (round 9) — never the invented metadata id. */
async function pickAlloySans(page: Page): Promise<void> {
  await openPicker(page, "en");
  await pointerClick(page, popupOf(page, "en").locator(".kit-fp").first());
  await expect(popupOf(page, "en")).toBeHidden();
}

/** Pick the CJK slot's WenKai row (its active cut — the default 标准). */
async function pickWenkaiRow(page: Page): Promise<void> {
  await openPicker(page, "cjk");
  await pointerClick(page, wenkaiRow(page));
  await expect(popupOf(page, "cjk")).toBeHidden();
}

/** Click synthesize, read the disabled notice, close it. */
async function expectDisabledNotice(page: Page, text: string): Promise<void> {
  await expect(synthesize(page)).toHaveAttribute("aria-disabled", "true");
  await pointerClick(page, synthesize(page));
  const notice = page.locator(".synthesize-notice");
  await expect(notice).toContainText(text);
  await pointerClick(page, notice.locator(".notice-close"));
  await expect(notice).toBeHidden();
}

test.describe("repeat-click unload (round 18, owner item 3)", () => {
  const jsErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    jsErrors.length = 0;
    collectJsErrors(page, jsErrors);
  });

  test.afterEach(() => assertNoJsErrors(jsErrors));

  test("re-clicking the picked row unloads that slot; the other side and the initial-state rules hold", async ({
    page,
  }) => {
    const fx = await bootWorkspace(page);

    // The never-picked baseline under a connected service: the action
    // is disabled with exactly the pick-missing reason.
    await expect(cardName(page, "en")).toHaveText("尚未加载字体");
    await expect(cardName(page, "cjk")).toHaveText("尚未加载字体");
    const initialTotal = await stat(page, "total").textContent();
    expect(initialTotal).toBe("0");
    await expectDisabledNotice(
      page,
      "请先选择英文字体与中文字体，再进行合成。",
    );

    // Pick both slots.
    await pickAlloySans(page);
    await pickWenkaiRow(page);
    await waitForFontsReady(page);
    await expect(pairTag(page, "base")).toHaveText(fx.nameA);
    await expect(pairTag(page, "donor")).toHaveText(fx.nameB);
    // The counters classify by script region (round 20): the pair's
    // union coverage split by WHERE each codepoint sits, so a Latin-only
    // donor leaves 中文 exactly at the pair's CJK-region coverage.
    const regions = await expectedRegionCounts(FONT_A, FONT_B);
    await expect(stat(page, "en")).toHaveText(regions.en);
    await expect(stat(page, "cjk")).toHaveText(regions.cjk);
    await expect(synthesize(page)).toHaveAttribute("aria-disabled", "false");
    // A cell both fonts cover resolves to the base under the default
    // precedence (base keeps).
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+0041']"),
    ).toHaveAttribute("data-winner", "base");

    // UNLOAD the EN slot: open the picker, click the SAME row again.
    await openPicker(page, "en");
    const checkedRow = popupOf(page, "en")
      .locator(".kit-fp", { hasText: fx.nameA })
      .first();
    await expect(checkedRow.locator(".kit-chk")).toHaveCount(1); // it IS the pick
    await pointerClick(page, checkedRow);
    await expect(popupOf(page, "en")).toBeHidden();

    // The EN slot is empty — the never-picked surfaces are back.
    await expect(pairTag(page, "base")).toBeHidden();
    await expect(cardName(page, "en")).toHaveText("尚未加载字体");
    // The CJK slot is untouched.
    await expect(pairTag(page, "donor")).toHaveText(fx.nameB);
    await expect(cardName(page, "cjk")).toHaveText(fx.nameB);
    // The grid stays judged under the lone pick (round 20): the covered
    // cells resolve to the remaining pick — its own face leads the
    // stack — and the winner facts stay exposed exactly like the
    // popup's (a lone pick has resolved since round 19).
    const cell = page.locator(".charmap-grid .kit-cell[data-cp='U+0041']");
    await expect(cell).toHaveAttribute("data-winner", "donor-0");
    expect(await cell.evaluate((el) => getComputedStyle(el).fontFamily)).toContain(
      fx.cssB,
    );
    // The stats bar (round 20, script region): the lone donor's Latin
    // coverage counts into 英文 — where it sits — and 中文 holds the
    // donor's own CJK-region coverage (0 for a Latin-only stand-in).
    const lone = await expectedRegionCounts(FONT_B);
    await expect(stat(page, "en")).toHaveText(lone.en);
    await expect(stat(page, "cjk")).toHaveText(lone.cjk);
    // Synthesize is disabled under the SAME rule as the initial state.
    await expectDisabledNotice(
      page,
      "请先选择英文字体与中文字体，再进行合成。",
    );

    // Loading a family still works after clearing.
    await pickAlloySans(page);
    await expect(pairTag(page, "base")).toHaveText(fx.nameA);
    await expect(synthesize(page)).toHaveAttribute("aria-disabled", "false");
  });

  test("re-clicking the CJK row's ACTIVE chip clears the family pick — the fully initial state", async ({
    page,
  }) => {
    await bootWorkspace(page);

    await pickAlloySans(page);
    await pickWenkaiRow(page);
    // Unload the EN slot first (the row toggle, pinned above): the
    // chip toggle then lands the FULLY initial state.
    await openPicker(page, "en");
    await pointerClick(
      page,
      popupOf(page, "en").locator(".kit-fp").first(),
    );
    await expect(popupOf(page, "en")).toBeHidden();

    // The WenKai row is the CJK pick; its default cut 标准 is the
    // ACTIVE chip (plain — only an EXPLICIT pick carries the accent).
    await openPicker(page, "cjk");
    const row = wenkaiRow(page);
    await expect(row.locator(".kit-chk")).toHaveCount(1);
    const stdChip = row.locator(".kit-vchip[data-chip='LXGWWenKai::Regular']");
    await expect(stdChip).toBeVisible();
    await expect(stdChip).not.toHaveClass(/on/);
    await pointerClick(page, stdChip);
    // A chip never closes the popup; the row state is assertable live.
    await expect(popupOf(page, "cjk")).toBeVisible();
    await expect(row.locator(".kit-chk")).toHaveCount(0);
    await expect(stdChip).not.toHaveClass(/on/);
    await page.keyboard.press("Escape");
    await expect(popupOf(page, "cjk")).toBeHidden();

    // Fully initial state: both slots never-picked, both counters at
    // the boot zero, the action disabled under the initial reason.
    await expect(pairTag(page, "base")).toBeHidden();
    await expect(pairTag(page, "donor")).toBeHidden();
    await expect(cardName(page, "en")).toHaveText("尚未加载字体");
    await expect(cardName(page, "cjk")).toHaveText("尚未加载字体");
    await expect(stat(page, "en")).toHaveText("0");
    await expect(stat(page, "cjk")).toHaveText("0");
    await expectDisabledNotice(
      page,
      "请先选择英文字体与中文字体，再进行合成。",
    );

    // Re-picking still works from the fully cleared state.
    await pickWenkaiRow(page);
    await expect(pairTag(page, "donor")).toBeVisible();
  });

  test("a DIFFERENT chip still switches cuts; the same chip then unloads", async ({
    page,
  }) => {
    const fx = await bootWorkspace(page);

    await pickAlloySans(page);
    await pickWenkaiRow(page);
    await expect(pairTag(page, "donor")).toHaveText(fx.nameB);

    // Switching cuts is unchanged: a DIFFERENT chip resolves its own
    // member family, takes the accent, and keeps the popup open.
    await openPicker(page, "cjk");
    const screenChip = wenkaiRow(page).locator(
      ".kit-vchip[data-chip='LXGWWenKaiScreen::Regular']",
    );
    await pointerClick(page, screenChip);
    await expect(pairTag(page, "donor")).toHaveText(fx.nameA);
    await expect(popupOf(page, "cjk")).toBeVisible();
    await expect(screenChip).toHaveClass(/on/);

    // Clicking that SAME chip — now the active cut of the picked row —
    // clears the whole family pick (the chip IS the cut; no cut left
    // means no family).
    await pointerClick(page, screenChip);
    await expect(pairTag(page, "donor")).toBeHidden();
    await expect(screenChip).not.toHaveClass(/on/);
    // The base slot is untouched throughout.
    await expect(pairTag(page, "base")).toHaveText(fx.nameA);
    await page.keyboard.press("Escape");

    // A new family load still works after the clear.
    await pickWenkaiRow(page);
    await expect(pairTag(page, "donor")).toHaveText(fx.nameB);
    await expect(synthesize(page)).toHaveAttribute("aria-disabled", "false");
  });
});
