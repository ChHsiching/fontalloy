import { test, expect } from "@playwright/test";
import {
  assertNoJsErrors,
  collectJsErrors,
  fixtureFontPaths,
  pointerClick,
  waitForFontsReady,
} from "./helpers";

test.describe("picker popup behavior", () => {
  const jsErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    jsErrors.length = 0;
    collectJsErrors(page, jsErrors);
    await page.goto("/");
    await waitForFontsReady(page);
  });

  test.afterEach(() => assertNoJsErrors(jsErrors));

  test("opens below the anchor and stays inside the app frame", async ({
    page,
  }) => {
    const anchor = page.locator('[data-role="picker-en"] .kit-hd');
    await pointerClick(page, anchor);
    const popup = page.locator('[data-picker-popup="en"]');
    await expect(popup).toBeVisible();
    await page.waitForTimeout(250); // the discrete open transition settles

    const anchorBox = await anchor.boundingBox();
    const popupBox = await popup.boundingBox();
    expect(anchorBox).not.toBeNull();
    expect(popupBox).not.toBeNull();

    // Below-first (the picker attaches seamlessly to the card).
    expect(popupBox!.y).toBeGreaterThanOrEqual(anchorBox!.y + anchorBox!.height - 2);
    // Clamped to the frame with a small margin.
    expect(popupBox!.y).toBeGreaterThanOrEqual(4);
    expect(popupBox!.x).toBeGreaterThanOrEqual(4);
    expect(popupBox!.x + popupBox!.width).toBeLessThanOrEqual(
      page.viewportSize()!.width - 4,
    );
    expect(popupBox!.y + popupBox!.height).toBeLessThanOrEqual(
      page.viewportSize()!.height - 4,
    );
  });

  for (const height of [700, 560, 420, 320]) {
    test(`clamps (flips above or caps at the frame) at ${height}px height`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 900, height });
      const anchor = page.locator('[data-role="picker-cjk"] .kit-hd');
      await pointerClick(page, anchor);
      const popup = page.locator('[data-picker-popup="cjk"]');
      await expect(popup).toBeVisible();

      const anchorBox = (await anchor.boundingBox())!;
      const popupBox = (await popup.boundingBox())!;
      expect(popupBox).not.toBeNull();

      // Always inside the frame.
      expect(popupBox.y).toBeGreaterThanOrEqual(4);
      expect(popupBox.y + popupBox.height).toBeLessThanOrEqual(height - 4);

      // When below does not fit, the kit caps the popup's height (and
      // lifts it so the bottom edge stays inside the frame) — the
      // picker never scrolls off-window.
      const fitsBelow =
        anchorBox.y + anchorBox.height + popupBox.height <= height - 4;
      if (!fitsBelow) {
        expect(popupBox.height).toBeLessThanOrEqual(height - 8);
        expect(popupBox.y + popupBox.height).toBeLessThanOrEqual(height - 4);
      }
    });
  }

  test("popup node survives row re-renders and stays open", async ({ page }) => {
    const [font1, font2] = fixtureFontPaths();
    await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
    const popup = page.locator('[data-picker-popup="en"]');
    await expect(popup).toBeVisible();

    // Mark the live node; a re-render that rebuilds the popup would drop it.
    await popup.evaluate((el) => (el.dataset.marker = "alive"));
    const rows = popup.locator(".kit-fp");
    await expect(rows).toHaveCount(0); // only the empty state so far

    await page
      .locator("input[data-role='font-file']")
      .setInputFiles([font1, font2]);
    await waitForFontsReady(page);
    await expect(rows).toHaveCount(2);

    // Same node, still open, still interactive.
    await expect(popup).toBeVisible();
    expect(await popup.getAttribute("data-marker")).toBe("alive");
    await pointerClick(page, rows.nth(0)); // hit-test guarded interaction
  });

  test("popup overlays entrance-animated sections and receives the pointer hits", async ({
    page,
  }) => {
    // Sections animate in on load; a permanent stacking context on any of
    // them would trap the popup z-index (ADR-0004). The hit-test-guarded
    // click below fails if the popup is not the top element at that point.
    await pointerClick(page, page.locator('[data-role="picker-cjk"] .kit-hd'));
    const popup = page.locator('[data-picker-popup="cjk"]');
    await expect(popup).toBeVisible();

    // A click lands on the footer button (outside the scroll area).
    await pointerClick(page, popup.locator(".kit-fpsys"));
    // The click opened the OS file dialog in a real app; here the hidden
    // input existing is enough. Close again via Escape.
    await page.keyboard.press("Escape");
    await expect(popup).toBeHidden();
  });

  test("closes on outside click and reopens through a discrete transition", async ({
    page,
  }) => {
    const anchor = page.locator('[data-role="picker-en"] .kit-hd');
    await pointerClick(page, anchor);
    const popup = page.locator('[data-picker-popup="en"]');
    await expect(popup).toBeVisible();

    // The open/close transition is discrete (allow-discrete + @starting-style).
    const behavior = await popup.evaluate(
      (el) => getComputedStyle(el).transitionBehavior,
    );
    expect(behavior).toContain("allow-discrete");

    // Close by clicking outside (the chip bar area); the node's removal
    // waits ~240ms so the exit transition plays, then reopens fine.
    await pointerClick(page, page.locator(".charmap-categories"));
    await expect(popup).toBeHidden();

    await pointerClick(page, anchor);
    await expect(popup).toBeVisible();
  });

  test("the local-file footer lives outside the scroll area", async ({ page }) => {
    await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
    const popup = page.locator('[data-picker-popup="en"]');
    const scroll = popup.locator(".kit-pks");
    const footer = popup.locator(".kit-fpsys");
    await expect(scroll).toBeVisible();
    await expect(footer).toBeVisible();

    // DOM: the footer is not inside the scroll container.
    expect(await footer.evaluate((el, scrollEl) => !scrollEl.contains(el), await scroll.elementHandle())).toBe(true);

    // Geometry: the footer starts where the scroll area ends.
    const scrollBox = (await scroll.boundingBox())!;
    const footerBox = (await footer.boundingBox())!;
    expect(footerBox.y).toBeGreaterThanOrEqual(scrollBox.y + scrollBox.height - 1);
  });
});
