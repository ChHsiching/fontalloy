import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parseFontMeta } from "../src/fonts/sfnt";
import { BROWSE_UNIVERSE, isCjkRegionCodepoint } from "../src/unicode/universe";
import {
  assertNoJsErrors,
  collectJsErrors,
  pointerClick,
  waitForFontsReady,
} from "./helpers";
import { generateNamedFace, spawnServeOverFonts } from "./serve";
import {
  buildServeCatalogSite,
  type ServeCatalogSite,
} from "./catalog-serve-site";

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
 * explanation), so every test boots against a REAL spawned serve over
 * a tiny worktree-local catalog site (ticket #30's boot: the catalog
 * rows come from the serve's family documents) — no merge is ever
 * submitted; the disabled state never reaches the network. Ticket #35:
 * with both picks made the coloring is that serve's resolve answer; a
 * lone DONOR has no resolve request at all (picks.base is required),
 * so the unloaded state's page is the plain preview by the serve's
 * own rule, never a client-side mirror.
 */

/** One generated face's parsed name-table strings (the row/pair identity). */
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

/** Suite-scoped serve/site disposers (one boot per test, torn down after). */
const bootDisposers: Array<() => Promise<void>> = [];

/** The identity strings and face paths the assertions compare against. */
interface Fixture {
  /** Alloy Sans's face display name (the EN pick's identity). */
  nameA: string;
  /** The WenKai default cut's face display name (the CJK pick's identity). */
  nameB: string;
  /** The WenKai Screen cut's OWN face display name (the switch target). */
  nameS: string;
  /** The WenKai face's css family (the lone-donor preview face). */
  cssB: string;
  /** The generated face paths (the counters' expectations read them). */
  sans: string;
  wenkai: string;
}

/**
 * Boot the workspace over the serve-backed catalog (one per test):
 * THREE generated faces — one invented EN-slot family (a plain row over
 * its own face) plus the WenKai GROUP row's two member families, each
 * cut resolving to its OWN name-table identity. Distinct families must
 * not share a face (ticket #30 keys a row by its registered css
 * family — two families over one binary would collide into one row).
 * The manifest entries pin each member's Regular variant, the chip ids
 * the assertions key on.
 */
async function bootWorkspace(page: Page): Promise<Fixture> {
  await page.route("https://api.github.com/repos/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  const root = await mkdtemp(resolve(tmpdir(), "fontalloy-unload-"));
  const [sans, wenkai, screen] = await Promise.all([
    generateNamedFace(root, "Alloy Sans", "AlloySans"),
    generateNamedFace(root, "LXGW WenKai", "LXGWWenKai"),
    generateNamedFace(root, "LXGW WenKai Screen", "LXGWWenKaiScreen"),
  ]);
  const site = await buildServeCatalogSite(
    [
      {
        family: "AlloySans",
        faces: [{ file: "AlloySans-Regular.ttf", fontPath: sans }],
      },
      {
        family: "LXGWWenKai",
        faces: [{ file: "LXGWWenKai-Regular.ttf", fontPath: wenkai }],
        manifestEntries: [{ variant: "Regular", file: "LXGWWenKai.zip" }],
      },
      {
        family: "LXGWWenKaiScreen",
        faces: [{ file: "LXGWWenKaiScreen-Regular.ttf", fontPath: screen }],
        manifestEntries: [{ variant: "Regular", file: "LXGWWenKaiScreen.zip" }],
      },
    ],
    { manifest: true },
  );
  const spawned = await spawnServeOverFonts(site.catalogDir, [
    "--catalog-release-origin",
    site.originUri,
    "--catalog-dir",
    site.catalogDir,
    "--manifest",
    site.manifestPath!,
  ]);
  bootDisposers.push(async () => {
    await spawned.dispose();
    await rm(site.root, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  const serveUrl = await spawned.url;
  await page.addInitScript((serve: string) => {
    (window as { __FONTALLOY_CONFIG__?: unknown }).__FONTALLOY_CONFIG__ = {
      serveUrl: serve,
    };
  }, serveUrl);
  await page.goto("/");
  await expect(
    page.locator(".catalog-screen [data-stat='catalog-done']"),
  ).toHaveText("3", { timeout: 30_000 });
  await expect(page.locator(".catalog-screen")).toBeHidden();
  // The documents sweep must land too: the rows list from the serve's
  // family documents, which fill AFTER the sync counts settle — a
  // picker opened in between would sit rowless.
  await page.waitForFunction(
    () => document.documentElement.dataset.catalogSweep === "done",
    undefined,
    { timeout: 60_000 },
  );
  await waitForFontsReady(page);
  const metaSans = await parsedMeta(sans);
  const metaWenkai = await parsedMeta(wenkai);
  const metaScreen = await parsedMeta(screen);
  return {
    nameA: metaSans.names.display,
    nameB: metaWenkai.names.display,
    nameS: metaScreen.names.display,
    cssB: metaWenkai.family,
    sans,
    wenkai,
  };
}

/**
 * The expected script-region counters (round 20) of the given faces'
 * union coverage: the browsed universe's codepoints the faces cover,
 * split by where each SITS (inside the 中日韩文字 region → 中文, else →
 * 英文). The generated fixtures are Latin-only (A–Z) — a Latin-only
 * donor legitimately leaves 中文 at 0, which the old winner-side
 * `not 0` expectation could never survive.
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

/** Pick the CJK slot's WenKai row (its active cut — the default 标准).
 *  The click targets the row's NAME: the group row's chip cluster sits
 *  mid-row, and a raw center hit can land on the default-cut chip — a
 *  chip never closes the popup (only the row does). */
async function pickWenkaiRow(page: Page): Promise<void> {
  await openPicker(page, "cjk");
  await pointerClick(page, wenkaiRow(page).locator(".kit-nm"));
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

  test.afterEach(async () => {
    for (const dispose of bootDisposers.splice(0)) {
      await dispose();
    }
    assertNoJsErrors(jsErrors);
  });

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
    const regions = await expectedRegionCounts(fx.sans, fx.wenkai);
    await expect(stat(page, "en")).toHaveText(regions.en);
    await expect(stat(page, "cjk")).toHaveText(regions.cjk);
    await expect(synthesize(page)).toHaveAttribute("aria-disabled", "false");
    // Ticket #35: the grid's coloring is the SERVE's resolve answer —
    // with both picks referenced to it, the document lands and a cell
    // both fonts cover resolves to the base under the default
    // precedence (base keeps). The fixture pair is tiny, but the first
    // resolve is still an async land — anchor it, never assume it.
    const covered = page.locator(".charmap-grid .kit-cell[data-cp='U+0041']");
    await expect(covered).toHaveAttribute("data-winner", "base", {
      timeout: 30_000,
    });

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
    // cells render through the remaining pick — its own face leads the
    // stack. A lone DONOR has no resolve request at all (ticket #35:
    // picks.base is required), so the page is the PLAIN PREVIEW by the
    // serve's own rule — no winner facts exist; the cmap-driven
    // counters and the stack semantics are exactly what the unload
    // rules need.
    const cell = page.locator(".charmap-grid .kit-cell[data-cp='U+0041']");
    await expect(cell).not.toHaveAttribute("data-winner");
    expect(await cell.evaluate((el) => getComputedStyle(el).fontFamily)).toContain(
      fx.cssB,
    );
    // The stats bar (round 20, script region): the lone donor's Latin
    // coverage counts into 英文 — where it sits — and 中文 holds the
    // donor's own CJK-region coverage (0 for a Latin-only stand-in).
    const lone = await expectedRegionCounts(fx.wenkai);
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
    await expect(pairTag(page, "donor")).toHaveText(fx.nameS);
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
