import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  allowProbeRefusal,
  assertNoJsErrors,
  collectJsErrors,
  openCliPanel,
  openFontPicker,
  pickCatalogFamily,
  pickSelectOption,
  pointerClick,
  waitForCatalogReady,
  waitForFontsReady,
  UNUSED_SERVE,
} from "./helpers";

/**
 * The REAL local catalog on the static target (repair round 2): the
 * built bundle bootstraps the dev catalog served by `vite preview`
 * (manifest families zipped from the local fonts directory) — the
 * picker must show the real density the validated prototype shows:
 * 70+ real family rows with license + curated meta (stars, trait tags),
 * rows self-rendering in their own fonts once downloaded.
 */

test.setTimeout(240_000);

test("the real catalog lists real families with real meta", async ({ page }) => {
  const errors: string[] = [];
  const gate = collectJsErrors(page, errors);
  allowProbeRefusal(gate, "http://127.0.0.1:7777");

  // The catalog bootstrap also fires the live GitHub stars refresh
  // (round 5); keep it hermetic and quiet (200 + no count).
  await page.route("https://api.github.com/repos/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "{}",
    }),
  );

  // No opt-out: the static bundle's own default bootstrap (the local
  // dev catalog) runs — this spec is about exactly that default.
  await page.goto("/");
  await waitForFontsReady(page);
  await waitForCatalogReady(page);

  const popup = await openFontPicker(page, "en");
  const rows = popup.locator(".kit-fp");
  // Round 5 (the slot split): the EN slot lists the Nerd Fonts CODING
  // families only; round 9 (owner item 1) the upstream pass serves EVERY
  // manifest family, so the counts are the full manifest's: 71 EN rows
  // (every coding family; NerdFontsSymbolsOnly never lists) and every
  // CJK family the slots table names.
  await expect(rows).toHaveCount(71);
  // And the CJK slot lists exactly those CJK families. (Escape first:
  // the open EN popup physically covers the CJK card below it.)
  await page.keyboard.press("Escape");
  const cjkPopup = await openFontPicker(page, "cjk");
  // Round 7: the six WenKai manifest families collapse onto ONE group
  // row; round 9: all 21 expansion families + the five prototype-only
  // extras serve — 30 CJK rows, each reading its own name-table name.
  await expect(cjkPopup.locator(".kit-fp")).toHaveCount(30);
  await expect(
    cjkPopup.locator(".kit-fp", { hasText: "LXGW Neo XiHei" }),
  ).toHaveCount(1);
  await expect(cjkPopup.locator(".kit-fp").first()).toContainText("Maple Mono");
  await expect(
    cjkPopup.locator(".kit-fp", { hasText: "Smiley Sans Oblique" }),
  ).toHaveCount(1);
  await page.keyboard.press("Escape");
  const popupEn = await openFontPicker(page, "en");
  const rowsEn = popupEn.locator(".kit-fp");
  // The curated FRONT pins first (the prototype's LB rows). Round 9
  // (owner item 2): the rows read the patched binaries' OWN name-table
  // names (JetBrainsMono Nerd Font …), with the curated trait tags.
  const front = ["JetBrainsMono Nerd Font", "FiraCode Nerd Font",
    "CaskaydiaCove Nerd Font", "Iosevka Nerd Font", "Hack Nerd Font",
    "SauceCodePro Nerd Font", "BlexMono Nerd Font", "VictorMono Nerd Font"];
  const texts = await rowsEn.allTextContents();
  expect(texts.slice(0, 8)).toEqual(front.map((name) => expect.stringContaining(name)));
  const jb = rowsEn.filter({ hasText: "JetBrainsMono Nerd Font" });
  await expect(jb).toHaveCount(1);
  await expect(jb).toContainText("OFL");
  await expect(jb).toContainText("连字");
  // The tail keeps manifest order and the curated trait tags.
  await expect(rowsEn.filter({ hasText: "0xProto" })).toContainText(
    "源码可读性优先",
  );
  // The EN slot never lists the CJK families (separate catalogs).
  await expect(rowsEn.filter({ hasText: "LXGW WenKai" })).toHaveCount(0);
  await expect(rowsEn.filter({ hasText: "Noto Sans SC" })).toHaveCount(0);
  // NerdFontsSymbolsOnly never lists (prototype parity).
  await expect(rowsEn.filter({ hasText: "SymbolsOnly" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // The CJK picker: the prototype's LD front (Maple Mono 圆角等宽 /
  // 霞鹜文楷 楷体 / 思源黑体 黑体) with its star counts, and the
  // five prototype-only CJK families the dev catalog serves. (Round 7:
  // WenKai's manifest families collapse onto ONE 霞鹜文楷 group row
  // with variant chips — no separate Screen row.)
  const cjk = await openFontPicker(page, "cjk");
  const cjkTexts = await cjk.locator(".kit-fp").allTextContents();
  expect(cjkTexts.slice(0, 3)).toEqual([
    expect.stringContaining("Maple Mono"),
    expect.stringContaining("LXGW WenKai"),
    expect.stringContaining("Noto Sans SC"),
  ]);
  // Exactly ONE WenKai GROUP row: the TC families are their own rows,
  // so match the row whose NAME is exactly the group base.
  expect(
    cjkTexts.filter((row) => row.startsWith("LXGW WenKai") && !row.startsWith("LXGW WenKai ")),
  ).toHaveLength(1);
  const maple = cjk.locator(".kit-fp", { hasText: "29.2k" });
  await expect(maple).toContainText("Maple Mono");
  await expect(maple).toContainText("圆角等宽");
  // The prototype-only extras read their own name-table names.
  for (const name of ["Smiley Sans Oblique", "Sarasa Mono SC", "Ark Pixel", "Fusion Pixel", "Zhuque Fangsong"]) {
    await expect(cjk.locator(".kit-fp").filter({ hasText: name })).toHaveCount(1);
  }
  await page.keyboard.press("Escape");

  assertNoJsErrors(errors);
});

test("a catalog family verifies, becomes pickable, and self-renders", async ({
  page,
}) => {
  const errors: string[] = [];
  const gate = collectJsErrors(page, errors);
  allowProbeRefusal(gate, "http://127.0.0.1:7777");

  // The catalog bootstrap fires the live stars refresh (round 5);
  // keep it hermetic and quiet.
  await page.route("https://api.github.com/repos/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "{}",
    }),
  );

  await page.goto("/");
  await waitForCatalogReady(page);

  // The first family in release order verifies quickly; picking it
  // loads the REAL font (its face registers through the storage path)
  // and the card renders the family name in its own typeface.
  await pickCatalogFamily(page, "en", "0xProto", 240_000, "0xProto Nerd Font");
  const name = page.locator('[data-role="picker-en"] .kit-hd b');
  // Round 9: the card reads the face's own name-table string.
  await expect(name).toHaveText("0xProto Nerd Font");
  await expect
    .poll(() => name.evaluate((el) => getComputedStyle(el).fontFamily))
    .not.toBe("");

  assertNoJsErrors(errors);
});

test("the real catalog drives the panel end to end (YAML, download, copy)", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  const gate = collectJsErrors(page, errors);
  allowProbeRefusal(gate, UNUSED_SERVE);

  // The REAL local catalog (the static bundle's default bootstrap):
  // both picks from real families — JetBrainsMono as the base, the
  // Maple build as the donor (the prototype's own pair).
  // The live stars refresh would land mid-test and rebuild the picker
  // cards under the cursor (round 5); keep it hermetic and quiet.
  await page.route("https://api.github.com/repos/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "{}",
    }),
  );
  await page.goto(`/?serve=${encodeURIComponent(UNUSED_SERVE)}`);
  await waitForCatalogReady(page);
  await pickCatalogFamily(page, "en", "JetBrainsMono Nerd Font");
  // Round 9 (owner item 2): rows and cards read the faces' OWN
  // name-table strings. Round 20 (owner item 2): the plain family pick
  // serves the DEFAULT cut's own faces — Maple's NF entry
  // (MapleMono-NF-Regular.ttf, 「Maple Mono NF」), no longer the
  // prototype-era shared CN face the old per-family resolution fell
  // back to.
  await pickCatalogFamily(page, "cjk", "Maple Mono", 240_000, "Maple Mono NF");

  // The pair tags carry both picks as plain text — the name-table
  // display names (the same ones the picker rows and rail cards
  // render; the raw manifest ids never reach the UI).
  await expect(page.locator(".topbar [data-pair='base']")).toHaveText(
    "JetBrainsMono Nerd Font",
  );
  await expect(page.locator(".topbar [data-pair='donor']")).toHaveText(
    "Maple Mono NF",
  );

  // Open-at-the-selection: the EN picker reopens with the checked row
  // (JetBrains Mono — the pinned front's first row) already scrolled
  // into the popup's viewport — the scroll area scrolls, not the page.
  const reopened = await openFontPicker(page, "en");
  const inView = await reopened.evaluate((popup) => {
    const area = popup.querySelector(".kit-pks");
    const row = popup.querySelector(".kit-fp[aria-pressed='true']");
    if (!(area instanceof HTMLElement) || !(row instanceof HTMLElement)) {
      return { ok: false, scrollTop: -1 };
    }
    const a = area.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    return {
      ok: r.top >= a.top - 1 && r.bottom <= a.bottom + 1,
      scrollTop: area.scrollTop,
    };
  });
  expect(inView.ok).toBe(true);
  // The pinned front puts the checked row AT the top (round 5 fixed
  // the front pinning to key on family names once rows register), so
  // the scroll sits at 0 — the discipline under test is that the
  // checked row is INSIDE the popup's scroll viewport, never that the
  // page under it scrolled.
  expect(inView.scrollTop).toBeGreaterThanOrEqual(0);
  await page.keyboard.press("Escape");

  // Rules land in the recipe through the workspace's affordances: a
  // fresh state already declares zh_cn under 文字范围 (the pressed chip);
  // the 日文 chip adds ja (round 5: the four chips are the rail's whole
  // preset surface), the 按编码指定 popup adds a custom range and a
  // single codepoint (留空=单个).
  await pointerClick(
    page,
    page.locator("[data-role='lang-chip'][data-preset='ja']"),
  );

  await pointerClick(page, page.locator("[data-role='range-specify']"));
  const rangePopup = page.locator("[data-range-popup]");
  await expect(rangePopup).toBeVisible();
  await rangePopup.locator("[data-role='range-start']").fill("0x2100");
  await rangePopup.locator("[data-role='range-end']").fill("0x214F");
  await pointerClick(page, rangePopup.locator("[data-role='range-add']"));

  await pointerClick(page, page.locator("[data-role='range-specify']"));
  await expect(rangePopup).toBeVisible();
  await rangePopup.locator("[data-role='range-start']").fill("0x4E2D");
  await rangePopup.locator("[data-role='range-end']").fill("");
  await pointerClick(page, rangePopup.locator("[data-role='range-add']"));

  // Settings land in the recipe's normalization block (the 1.5x width
  // factor is the prototype's compacter CJK width setting).
  await pickSelectOption(
    page,
    page.locator('[data-role="select-baseline"]'),
    "optical",
  );
  await pickSelectOption(
    page,
    page.locator('[data-role="select-cjkWidth"]'),
    "1.5",
  );

  const panel = await openCliPanel(page);
  await expect(panel.locator('[data-testid="problems"]')).toBeEmpty();
  await expect(
    panel.locator('[data-testid="copy-command"]'),
  ).toHaveAttribute("aria-disabled", "false");

  // The YAML is the workspace's own recipe: fetch-layout paths for the
  // two real picks, the three rail rules, the normalization switches.
  const yamlText = await panel
    .locator('[data-testid="recipe-yaml"]')
    .textContent();
  expect(yamlText).toContain(
    'base: "fonts/JetBrainsMono/JetBrainsMonoNerdFont-Regular.ttf"',
  );
  expect(yamlText).toContain("MapleMono-NF-Regular.ttf");
  const YAMLmod = await import("yaml");
  const recipe = YAMLmod.default.parse(yamlText);
  expect(recipe.donors).toEqual([
    "fonts/MapleMono-NF/MapleMono-NF-Regular.ttf",
  ]);
  // The boot-seeded zh_cn preset (the declared 文字范围 scope) first,
  // then the 日文 chip's ja preset, then the 按编码指定 rules (the range
  // and the single codepoint). Round 6: side assignments carry the
  // [side, other] preference lists — "用X字体" means X first, the other
  // font filling what X lacks.
  expect(recipe.rules).toEqual([
    { set: "zh_cn", fonts: ["base", "donor-0"] },
    { set: "ja", fonts: ["base", "donor-0"] },
    { range: "0x2100-0x214F", fonts: ["base", "donor-0"] },
    // 留空=单个: a one-codepoint range (the popup's single form).
    { range: "0x4E2D-0x4E2D", fonts: ["base", "donor-0"] },
  ]);
  expect(recipe.normalization).toEqual({
    mode: "optical",
    width_factor: 1.5,
  });
  expect(recipe.output).toEqual({ format: "ttf", family: "ChHsich" });

  // Download produces the recipe file, byte-identical to the preview.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    pointerClick(page, panel.locator('[data-testid="download-recipe"]')),
  ]);
  expect(await download.suggestedFilename()).toBe("ChHsich.yaml");
  const downloaded = await download.path();
  expect((await readFile(downloaded, "utf8")).replace(/\r\n/g, "\n")).toBe(
    yamlText,
  );

  // Copy: clipboard API when the browser grants it, otherwise the
  // click-reachable selection fallback — both states are page text.
  await pointerClick(page, panel.locator('[data-testid="copy-command"]'));
  await expect(panel.locator('[data-testid="copy-status"]')).toContainText(
    /已复制到剪贴板|请按 Ctrl\+C/,
  );
  await expect(panel.locator('[data-testid="cli-command"]')).toContainText(
    "fontalloy build ChHsich.yaml",
  );

  assertNoJsErrors(errors);
});
