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

  test("opens anchor-fused to the card (the AppSelect list form)", async ({
    page,
  }) => {
    const card = page.locator(".kit-fsel[data-role='picker-en']");
    await pointerClick(page, card.locator(".kit-hd"));
    const popup = page.locator('[data-picker-popup="en"]');
    await expect(popup).toBeVisible();
    await page.waitForTimeout(250); // the discrete open transition settles

    // Round 4: a persistent CHILD of the card, absolutely anchored at
    // its bottom edge (top:100%, left/right:-1px, no top border) —
    // the card fuses with its list, no portal, no frame math.
    const info = await popup.evaluate((el) => {
      const cardEl = el.closest(".kit-fsel")!;
      const cs = getComputedStyle(el);
      return {
        childOfCard: el.parentElement === cardEl,
        position: cs.position,
        display: cs.display,
        borderTop: cs.borderTopWidth,
      };
    });
    expect(info.childOfCard).toBe(true);
    expect(info.position).toBe("absolute");
    expect(info.display).toBe("flex");
    expect(info.borderTop).toBe("0px");

    const cardBox = (await card.boundingBox())!;
    const popupBox = (await popup.boundingBox())!;
    expect(Math.abs(popupBox.y - (cardBox.y + cardBox.height - 1))).toBeLessThanOrEqual(1.5);
    expect(Math.abs(popupBox.x - (cardBox.x - 1))).toBeLessThanOrEqual(1.5);
    expect(Math.abs(popupBox.width - (cardBox.width + 2))).toBeLessThanOrEqual(2);
  });

  for (const height of [700, 560, 420, 320]) {
    test(`stays anchored to its card at ${height}px height`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 900, height });
      const card = page.locator(".kit-fsel[data-role='picker-cjk']");
      await card.scrollIntoViewIfNeeded();
      await pointerClick(page, card.locator(".kit-hd"));
      await page.waitForTimeout(250); // the discrete open transition settles
      const popup = page.locator('[data-picker-popup="cjk"]');
      await expect(popup).toBeVisible();

      // Anchored below the card regardless of the frame: the rail's
      // scroll box clips what does not fit — the prototype's own
      // behavior (its .pk is an absolute child of .fsel too).
      const cardBox = (await card.boundingBox())!;
      const popupBox = (await popup.boundingBox())!;
      expect(popupBox).not.toBeNull();
      expect(Math.abs(popupBox.y - (cardBox.y + cardBox.height - 1))).toBeLessThanOrEqual(1.5);
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
    // Round 4: the successful load closed the picker; reopen it — the
    // SAME node comes back (data-marker below), so the load's re-render
    // rebuilt rows only, never the skeleton.
    await expect(popup).toBeHidden();
    expect(await popup.getAttribute("data-marker")).toBe("alive");
    await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
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

    // Close by clicking outside (the chip bar area); the persistent
    // node plays the exit transition through display, then reopens fine.
    await pointerClick(page, page.locator(".charmap-categories"));
    await expect(popup).toBeHidden();
    await expect(popup).toHaveCount(1); // the node stays mounted

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
