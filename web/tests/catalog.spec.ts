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
  collectJsErrors(page, errors);

  // No opt-out: the static bundle's own default bootstrap (the local
  // dev catalog) runs — this spec is about exactly that default.
  await page.goto("/");
  await waitForFontsReady(page);
  await waitForCatalogReady(page);

  const popup = await openFontPicker(page, "en");
  const rows = popup.locator(".kit-fp");
  // 76 of the manifest's 81 unique families have local binaries
  // (the five LXGW-mono/NerdFontsSymbolsOnly misses are skipped).
  await expect(rows).toHaveCount(76);
  // Real names, real license, the prototype's curated trait tags.
  const jb = rows.filter({ hasText: "JetBrainsMono" });
  await expect(jb).toHaveCount(1);
  await expect(jb).toContainText("OFL");
  await expect(jb).toContainText("连字");
  await expect(rows.filter({ hasText: "0xProto" })).toContainText(
    "源码可读性优先",
  );
  await page.keyboard.press("Escape");

  // The CJK picker carries the prototype's star counts as curated
  // display data (the manifest has no source of truth for stars).
  const cjk = await openFontPicker(page, "cjk");
  const maple = cjk.locator(".kit-fp", { hasText: "29.2k" });
  await expect(maple).toContainText("MapleMono");
  await expect(maple).toContainText("圆角等宽");
  const lxgw = cjk.locator(".kit-fp", { hasText: "26.2k" });
  await expect(lxgw).toContainText("LXGWWenKai");
  await expect(lxgw).toContainText("楷体");
  await page.keyboard.press("Escape");

  assertNoJsErrors(errors);
});

test("a catalog family verifies, becomes pickable, and self-renders", async ({
  page,
}) => {
  const errors: string[] = [];
  collectJsErrors(page, errors);

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
  await page.goto(`/?serve=${encodeURIComponent(UNUSED_SERVE)}`);
  await waitForCatalogReady(page);
  await pickCatalogFamily(page, "en", "JetBrainsMono");
  await pickCatalogFamily(page, "cjk", "MapleMono");

  // The pair tags carry both picks as plain text.
  await expect(page.locator(".topbar [data-pair='base']")).toHaveText(
    "JetBrainsMono",
  );
  await expect(page.locator(".topbar [data-pair='donor']")).toHaveText(
    "MapleMono",
  );

  // Open-at-the-selection: the EN picker reopens with the checked row
  // (JetBrainsMono, ~30 rows into the 76-family list) already scrolled
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
  expect(inView.scrollTop).toBeGreaterThan(0);
  await page.keyboard.press("Escape");

  // Rules land in the recipe through the workspace's affordances: a
  // fresh state already declares zh_cn under 文字范围 (the pressed chip);
  // the deep picker adds ja (a chip-less preset), the 按编码指定 popup
  // adds a custom range and a single codepoint (留空=单个).
  await pointerClick(page, page.locator('[data-role="add-preset"]'));
  const presetPopup = page.locator('[data-picker-popup="preset-add"]');
  await expect(presetPopup).toBeVisible();
  await pointerClick(
    page,
    presetPopup.locator(".preset-row", { hasText: "ja" }),
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
  // then the picker's ja preset, then the 按编码指定 rules (the range
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
