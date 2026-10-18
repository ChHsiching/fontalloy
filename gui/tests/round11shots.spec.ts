import { test, expect, type Locator } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  pointerClick,
  realCatalogFontPaths,
  waitForFontsReady,
} from "./helpers";
import { spawnServeOverFonts } from "./serve";

/**
 * ROUND-11 VERIFICATION SHOTS (owner item 8, S2): the char popup open
 * on a codepoint whose shown side lacks the glyph — the 用英文字体
 * button DISABLED with its 「英文字体不含此码位」 reason line — in BOTH
 * themes, mouse parked off the frame so no hover chrome paints. The
 * files land in fontalloy-notes/round11-shots/ for the orchestrator's
 * vision pass; THIS suite never reads them — it proves the reason is
 * real, painted DOM first (computed style + geometry, not by eye).
 */

const NOTES_SHOTS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "fontalloy-notes",
  "round11-shots",
);

/**
 * The paint pin (round 11, owner item 8): the reason renders — shown,
 * boxed, inside its button, >= 11px, an ink distinct from the popup
 * surface, and NOT under a whole-button opacity wash (the disabled dim
 * lives in the label color; 0.4–0.6 opacity would wash the line to
 * ~2.4:1 in both themes). Works under whatever theme is current.
 */
async function assertReasonPaints(reason: Locator): Promise<void> {
  const paint = await reason.evaluate((el) => {
    const cs = getComputedStyle(el);
    const btn = el.closest("button")!;
    const btnCs = getComputedStyle(btn);
    const pop = el.closest(".kit-pop")!;
    const r = el.getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    return {
      display: cs.display,
      visibility: cs.visibility,
      fontSizePx: Number.parseFloat(cs.fontSize),
      color: cs.color,
      surface: getComputedStyle(pop).backgroundColor,
      btnOpacity: Number.parseFloat(btnCs.opacity),
      w: r.width,
      h: r.height,
      insideButton:
        r.left >= b.left - 0.5 &&
        r.right <= b.right + 0.5 &&
        r.top >= b.top - 0.5 &&
        r.bottom <= b.bottom + 0.5,
      theme: document.documentElement.dataset.theme,
    };
  });
  expect(paint.display, "the reason is not display:none").not.toBe("none");
  expect(paint.visibility).toBe("visible");
  expect(paint.w, "the reason has width").toBeGreaterThan(0);
  expect(paint.h, "the reason has height").toBeGreaterThan(0);
  expect(paint.insideButton, "the reason sits inside its button").toBe(true);
  expect(paint.fontSizePx, "the reason is >= 11px").toBeGreaterThanOrEqual(11);
  expect(paint.color, "reason ink differs from the surface").not.toBe(
    paint.surface,
  );
  expect(paint.btnOpacity, "no whole-button opacity wash").toBeGreaterThanOrEqual(0.99);
}

test.describe("round-11 char-popup reason visibility shots", () => {
  test("the disabled side's reason paints in both themes; shots captured", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const { base, donor } = realCatalogFontPaths();
    // Ticket #36: the browser file-input loads ride a serve's upload
    // endpoint now — spawn one over the real pair's directory.
    const service = await spawnServeOverFonts(dirname(base));
    try {
      await page.addInitScript((serve: string) => {
        (window as { __FONTALLOY_CONFIG__?: unknown }).__FONTALLOY_CONFIG__ =
          { serveUrl: serve };
      }, await service.url);
      await page.goto("/");
    await waitForFontsReady(page);

    // The REAL catalog pair through the real flow: JetBrainsMono NF in
    // the EN slot (Latin + icons, no CJK), Maple Mono CN in the CJK
    // slot — so U+4E00 is donor-carried and 用英文字体 can never take
    // effect: the disabled-with-reason popup.
    await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
    await page
      .locator("input[data-role='font-file']")
      .setInputFiles(base);
    // The upload flow closes the picker on success (the async signal).
    await expect(page.locator('[data-picker-popup="en"]')).toBeHidden({
      timeout: 30_000,
    });
    await waitForFontsReady(page);
    await pointerClick(page, page.locator('[data-role="picker-cjk"] .kit-hd'));
    await page
      .locator("input[data-role='font-file']")
      .setInputFiles(donor);
    await expect(page.locator('[data-picker-popup="cjk"]')).toBeHidden({
      timeout: 60_000,
    });
    await waitForFontsReady(page);
    await expect(
      page.locator("[data-role='font-pair'] [data-pair='donor']"),
    ).not.toBeEmpty();

    // Open the popup on a CJK cell the base font cannot supply.
    await pointerClick(page, page.locator(".kit-cat-g[data-group='cjk']"));
    await pointerClick(
      page,
      page.locator(".kit-cat-s[data-block='cjk-unified']"),
    );
    await pointerClick(
      page,
      page.locator(".charmap-grid .kit-cell[data-cp='U+4E00']"),
    );
    const popup = page.locator("[data-char-popup]");
    await expect(popup).toBeVisible();
    const baseBtn = popup.locator("[data-role='char-base']");
    // The pair's first resolve is fontTools-cold inside the serve —
    // anchor generously (the side buttons render from its runs).
    await expect(baseBtn).toBeVisible({ timeout: 30_000 });
    await expect(baseBtn).toBeDisabled();
    const reason = popup.locator("[data-role='char-base-reason']");
    await expect(reason).toHaveText("英文字体不含此码位");

    // LIGHT: prove the paint, park the mouse off the app frame (a bare
    // move never closes the popup — only a pointerdown does), shoot.
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await assertReasonPaints(reason);
    mkdirSync(NOTES_SHOTS, { recursive: true });
    await page.mouse.move(5, 5);
    await page.waitForTimeout(350); // let the open animation settle
    await page.screenshot({
      path: resolve(NOTES_SHOTS, "popup-with-disabled-side-light.png"),
    });

    // DARK: cycle the toggle (auto → light → dark). The toggle press is
    // a pointerdown OUTSIDE the popup, so it closes it — reopen at the
    // same cell, re-prove the paint against the dark palette, park, shoot.
    await page.keyboard.press("Escape");
    await expect(popup).toBeHidden();
    const toggle = page.locator(".topbar [data-role='theme-toggle']");
    await pointerClick(page, toggle);
    await expect(toggle).toHaveAttribute("data-theme-mode", "light");
    await pointerClick(page, toggle);
    await expect(toggle).toHaveAttribute("data-theme-mode", "dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await pointerClick(
      page,
      page.locator(".charmap-grid .kit-cell[data-cp='U+4E00']"),
    );
    await expect(popup).toBeVisible();
    await expect(reason).toHaveText("英文字体不含此码位");
    await assertReasonPaints(reason);
    await page.mouse.move(5, 5);
    await page.waitForTimeout(350);
    await page.screenshot({
      path: resolve(NOTES_SHOTS, "popup-with-disabled-side-dark.png"),
    });

    // The popup still closes normally after the shots (no stray state).
    await page.keyboard.press("Escape");
    await expect(popup).toBeHidden();
    } finally {
      await service.dispose();
    }
  });
});
