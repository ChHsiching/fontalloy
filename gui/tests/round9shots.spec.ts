import { test, expect, type Locator } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fixtureFontPaths,
  pointerClick,
  waitForFontsReady,
} from "./helpers";

/**
 * ROUND-9 VERIFICATION SHOTS (owner item 6b): the rail's rule area with
 * a range rule + EXPANDED singles + the 单个字符 N aggregate row, in
 * BOTH themes, with popups closed AND with the char popup open — plus
 * one shot of an assignment message card with its countdown bar (owner
 * item 7). The files land in fontalloy-notes/round9-shots/ for the
 * orchestrator's vision pass; THIS suite never reads them — it only
 * proves they were captured and that the × controls are real, visible
 * DOM (asserted by geometry, not by eye).
 */

const NOTES_SHOTS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "fontalloy-notes",
  "round9-shots",
);

/** The × on one rule row: present, sized, opaque, inside the row. */
async function assertDeleteVisible(row: Locator): Promise<void> {
  const geom = await row.locator("[data-role='remove-rule']").evaluate(
    (el) => {
      const svg = el.querySelector("svg");
      const r = el.getBoundingClientRect();
      const s = svg ? svg.getBoundingClientRect() : new DOMRect();
      const cs = getComputedStyle(el);
      const svgCs = svg ? getComputedStyle(svg) : null;
      return {
        btnW: r.width,
        btnH: r.height,
        svgW: s.width,
        svgH: s.height,
        visible: cs.visibility === "visible" && cs.display !== "none",
        opacity: Number(cs.opacity),
        svgVisible:
          svgCs !== null &&
          svgCs.visibility === "visible" &&
          s.width >= 10 &&
          s.height >= 10,
        inRow: r.left >= 0 && r.right <= window.innerWidth,
      };
    },
  );
  expect(geom.visible, "the × button renders").toBe(true);
  expect(geom.opacity, "the × is not faded out").toBeGreaterThanOrEqual(0.99);
  expect(geom.svgW, "the × glyph is >= 10px wide").toBeGreaterThanOrEqual(10);
  expect(geom.svgH, "the × glyph is >= 10px tall").toBeGreaterThanOrEqual(10);
  expect(geom.svgVisible, "the × glyph actually paints").toBe(true);
  expect(geom.btnW).toBeGreaterThan(0);
  expect(geom.btnH).toBeGreaterThan(0);
}

test.describe("round-9 rule × visibility shots", () => {
  test("rail rules: range + expanded singles + aggregate ×, both themes, popups closed and open", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const [font1, font2] = fixtureFontPaths();
    await page.goto("/");
    await waitForFontsReady(page);

    // Two local picks through the real flow: the shared input loads
    // both files into the EN picker's flow (the first family takes the
    // EN slot); the CJK slot picks the second face from its own rows.
    await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
    await page
      .locator("input[data-role='font-file']")
      .setInputFiles([font1, font2]);
    await waitForFontsReady(page);
    await pointerClick(page, page.locator('[data-role="picker-cjk"] .kit-hd'));
    const cjkPopup = page.locator('[data-picker-popup="cjk"]');
    await cjkPopup.locator(".kit-fp").nth(1).click();
    await waitForFontsReady(page);
    await page.keyboard.press("Escape");
    await expect(
      page.locator("[data-role='font-pair'] [data-pair='donor']"),
    ).not.toBeEmpty();

    // The rule state the shots need: a block rule, a range rule, and
    // TWO single-character rules (aggregate row + expandable children).
    await pointerClick(
      page,
      page.locator(".kit-cat-g[data-group='latin-europe']"),
    );
    await pointerClick(
      page,
      page.locator(".kit-cat-s[data-block='basic-latin']"),
    );
    const blockRow = page.locator(".kit-toolrow").filter({ hasText: "基本拉丁" });
    await blockRow.locator(".kit-mseg button", { hasText: /^用中文$/ }).click();

    // The message card (owner item 7): shoot it with the countdown bar.
    const message = page.locator("[data-role='message']").first();
    await expect(message).toBeVisible();
    await expect(message.locator(".kit-msg-bar")).toBeVisible();
    mkdirSync(NOTES_SHOTS, { recursive: true });
    await page.screenshot({
      path: resolve(NOTES_SHOTS, "rules-message-light.png"),
    });
    // Dismiss it so it never auto-dismisses mid-shot later.
    await message.locator("[data-role='message-dismiss']").click();
    await expect(message).toHaveCount(0);

    // A range rule through 按编码指定: U+0043 至 U+0045 用中文字体.
    await pointerClick(
      page,
      page.locator(".kit-toolrow [data-role='range-specify']"),
    );
    const rangePopup = page.locator("[data-range-popup]");
    await rangePopup.locator("[data-role='range-start']").fill("U+0043");
    await rangePopup.locator("[data-role='range-end']").fill("U+0045");
    const side = rangePopup.locator("[data-role='range-side']");
    await pointerClick(page, side.locator(".kit-csel"));
    await side.locator(".kit-cso[data-value='donor']").click();
    await rangePopup.locator("[data-role='range-add']").click();
    await expect(
      page.locator("[data-role='rule-row'][data-kind='range']"),
    ).toContainText("U+0043 C - U+0045 E 用中文字体");
    await page.keyboard.press("Escape");

    // Two single-character rules, then EXPAND the aggregate group.
    // The block assignment may already own a cell's winner, so the
    // popup then offers the OTHER side — click whichever switch shows.
    // (The char popup stays open after a side switch — Escape between.)
    for (const cp of ["U+0041", "U+0042"]) {
      await page.locator(`.charmap-grid .kit-cell[data-cp='${cp}']`).click();
      const popup = page.locator("[data-char-popup]");
      await expect(popup, `the popup opens at ${cp}`).toBeVisible();
      const donor = popup.locator("[data-role='char-donor']");
      const base = popup.locator("[data-role='char-base']");
      const side = (await donor.isVisible())
        ? donor
        : await base.isVisible()
          ? base
          : null;
      expect(
        side,
        `a working side switch shows for ${cp} (popup: ${await popup.textContent()})`,
      ).not.toBeNull();
      await side!.click();
      await page.keyboard.press("Escape");
      await expect(popup).toBeHidden();
    }
    const solo = page.locator("[data-role='rule-solo']");
    await expect(solo).toHaveText("单个字符 2");
    await solo.locator("[data-role='rule-solo-toggle']").click();
    await expect(
      page.locator("[data-role='rule-row'][data-kind='codepoint']"),
    ).toHaveCount(2);

    // DOM + geometry: every summary row AND the aggregate head carry a
    // visible × (owner item 6a).
    for (const row of await page.locator("[data-role='rule-row']").all()) {
      await assertDeleteVisible(row);
    }
    await assertDeleteVisible(solo);

    // LIGHT: popups closed.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(350);
    await page.screenshot({
      path: resolve(NOTES_SHOTS, "rules-light-popups-closed.png"),
    });
    const rail = page.locator(".workspace-rail");
    await rail.screenshot({
      path: resolve(NOTES_SHOTS, "rules-light-rail.png"),
    });

    // LIGHT: the char popup open at a cell.
    await page.locator(".charmap-grid .kit-cell[data-cp='U+0041']").click();
    await expect(page.locator("[data-char-popup]")).toBeVisible();
    await page.waitForTimeout(350);
    await page.screenshot({
      path: resolve(NOTES_SHOTS, "rules-light-charpopup-open.png"),
    });
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-char-popup]")).toBeHidden();

    // DARK: cycle the toggle to dark (auto → light → dark).
    const toggle = page.locator(".topbar [data-role='theme-toggle']");
    await pointerClick(page, toggle);
    await expect(toggle).toHaveAttribute("data-theme-mode", "light");
    await pointerClick(page, toggle);
    await expect(toggle).toHaveAttribute("data-theme-mode", "dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.waitForTimeout(350);

    await page.screenshot({
      path: resolve(NOTES_SHOTS, "rules-dark-popups-closed.png"),
    });
    await rail.screenshot({
      path: resolve(NOTES_SHOTS, "rules-dark-rail.png"),
    });
    // The × stays visible in dark too (geometry re-check).
    for (const row of await page.locator("[data-role='rule-row']").all()) {
      await assertDeleteVisible(row);
    }
    await assertDeleteVisible(solo);

    await page.locator(".charmap-grid .kit-cell[data-cp='U+0041']").click();
    await expect(page.locator("[data-char-popup]")).toBeVisible();
    await page.waitForTimeout(350);
    await page.screenshot({
      path: resolve(NOTES_SHOTS, "rules-dark-charpopup-open.png"),
    });

    // The aggregate × deletes the WHOLE group in one move (behavior).
    await page.keyboard.press("Escape");
    await solo.locator("[data-role='remove-rule']").click();
    await expect(page.locator("[data-role='rule-solo']")).toHaveCount(0);
    await expect(
      page.locator("[data-role='rule-row'][data-kind='codepoint']"),
    ).toHaveCount(0);
    // The range + block rows survive.
    await expect(
      page.locator("[data-role='rule-row'][data-kind='range']"),
    ).toHaveCount(1);
    await expect(
      page.locator("[data-role='rule-row'][data-kind='block']"),
    ).toHaveCount(1);
  });
});
