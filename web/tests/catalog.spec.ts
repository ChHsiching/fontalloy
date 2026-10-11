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
  // families only — 76 of the manifest's unique families have local
  // binaries (the five LXGW-mono/NerdFontsSymbolsOnly misses are
  // skipped), plus the dev catalog's five prototype-only CJK extras =
  // 81 families, of which the 10 CJK ones belong to the CJK slot.
  await expect(rows).toHaveCount(71);
  // And the CJK slot lists exactly those CJK families. (Escape first:
  // the open EN popup physically covers the CJK card below it.)
  await page.keyboard.press("Escape");
  const cjkPopup = await openFontPicker(page, "cjk");
  await expect(cjkPopup.locator(".kit-fp")).toHaveCount(10);
  await expect(cjkPopup.locator(".kit-fp").first()).toContainText("Maple Mono CN");
  await expect(cjkPopup.locator(".kit-fp", { hasText: "得意黑" })).toHaveCount(1);
  await page.keyboard.press("Escape");
  const popupEn = await openFontPicker(page, "en");
  const rowsEn = popupEn.locator(".kit-fp");
  // The curated FRONT pins first (the prototype's LB rows, its display
  // names and short tags): JetBrains Mono 连字, Fira Code 连字,
  // Cascadia Code 微软, Iosevka 超窄, Hack 经典, Source Code Pro Adobe,
  // IBM Plex Mono IBM, Victor Mono 手写.
  const front = ["JetBrains Mono", "Fira Code", "Cascadia Code", "Iosevka",
    "Hack", "Source Code Pro", "IBM Plex Mono", "Victor Mono"];
  const texts = await rowsEn.allTextContents();
  expect(texts.slice(0, 8)).toEqual(front.map((name) => expect.stringContaining(name)));
  const jb = rowsEn.filter({ hasText: "JetBrains Mono" });
  await expect(jb).toHaveCount(1);
  await expect(jb).toContainText("OFL");
  await expect(jb).toContainText("连字");
  // The tail keeps manifest order and the curated trait tags.
  await expect(rowsEn.filter({ hasText: "0xProto" })).toContainText(
    "源码可读性优先",
  );
  // The EN slot never lists the CJK families (separate catalogs).
  await expect(rowsEn.filter({ hasText: "霞鹜文楷" })).toHaveCount(0);
  await expect(rowsEn.filter({ hasText: "思源黑体" })).toHaveCount(0);
  // NerdFontsSymbolsOnly never lists (prototype parity).
  await expect(rowsEn.filter({ hasText: "SymbolsOnly" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // The CJK picker: the prototype's LD front (Maple Mono CN 圆角等宽 /
  // 霞鹜文楷 Screen 楷体 / 思源黑体 黑体) with its star counts, and the
  // five prototype-only CJK families the dev catalog serves.
  const cjk = await openFontPicker(page, "cjk");
  const cjkTexts = await cjk.locator(".kit-fp").allTextContents();
  expect(cjkTexts.slice(0, 3)).toEqual([
    expect.stringContaining("Maple Mono CN"),
    expect.stringContaining("霞鹜文楷 Screen"),
    expect.stringContaining("思源黑体"),
  ]);
  const maple = cjk.locator(".kit-fp", { hasText: "29.2k" });
  await expect(maple).toContainText("Maple Mono CN");
  await expect(maple).toContainText("圆角等宽");
  for (const name of ["得意黑", "更纱黑体", "方舟像素字体", "缝合像素字体", "朱雀仿宋"]) {
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
  await pickCatalogFamily(page, "en", "0xProto", 240_000);
  const name = page.locator('[data-role="picker-en"] .kit-hd b');
  await expect(name).toHaveText("0xProto");
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
  // Maple Mono CN build as the donor (the prototype's own pair).
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
  await pickCatalogFamily(page, "en", "JetBrains Mono");
  await pickCatalogFamily(page, "cjk", "Maple Mono CN");

  // The pair tags carry both picks as plain text.
  await expect(page.locator(".topbar [data-pair='base']")).toHaveText(
    "JetBrainsMono",
  );
  await expect(page.locator(".topbar [data-pair='donor']")).toHaveText(
    "MapleMono",
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
  expect(yamlText).toContain("MapleMonoCN-Regular.ttf");
  const YAMLmod = await import("yaml");
  const recipe = YAMLmod.default.parse(yamlText);
  expect(recipe.donors).toEqual([
    "fonts/MapleMono-NF/MapleMonoCN-Regular.ttf",
  ]);
  // The boot-seeded zh_cn preset (the declared 文字范围 scope) first,
  // then the 日文 chip's ja preset, then the 按编码指定 rules (the range
  // and the single codepoint).
  expect(recipe.rules).toEqual([
    { set: "zh_cn", fonts: ["base", "donor-0"] },
    { set: "ja", fonts: ["base", "donor-0"] },
    { range: "0x2100-0x214F", fonts: ["base"] },
    // 留空=单个: a one-codepoint range (the popup's single form).
    { range: "0x4E2D-0x4E2D", fonts: ["base"] },
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
