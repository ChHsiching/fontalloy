import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  assertNoJsErrors,
  collectJsErrors,
  pointerClick,
  waitForFontsReady,
} from "./helpers";

/**
 * Round 18 (owner item 1): the webview's DEFAULT context menu is
 * replaced everywhere by the kit context menu — exactly 复制 / 剪切 /
 * 粘贴, enablement contextual (selection / editable). The specs drive
 * the APP page (the bootstrap wires the menu globally in main.ts) with
 * the suite's conventions: real pointer events, DOM textContent /
 * geometry assertions (never pixel reads), zero-JS-errors gate.
 *
 * Whether the NATIVE menu shows is not observable from Playwright; the
 * preventDefault contract is asserted directly on a dispatched event
 * instead (our menu being present is the visible replacement).
 */

// Copy/cut land on the clipboard, paste reads it back — both need the
// Chromium clipboard permissions granted to the test context.
test.use({ permissions: ["clipboard-read", "clipboard-write"] });

/** Right-click the center of `locator` with the real mouse. */
async function rightClickCenter(page: Page, locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("right-click target has no bounding box");
  await page.mouse.click(
    Math.round(box.x + box.width / 2),
    Math.round(box.y + box.height / 2),
    { button: "right" },
  );
}

/**
 * Right-click `locator` at `offset` px from its left edge (center
 * height) — for FIELD selections the offset must land INSIDE the
 * selected range: a native right-click outside it collapses the caret
 * to the click point and the selection is gone before contextmenu
 * fires (the menu then correctly enables nothing); inside it, the
 * selection survives and becomes the menu's captured context.
 */
async function rightClickInset(
  page: Page,
  locator: Locator,
  offset: number,
): Promise<void> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("right-click target has no bounding box");
  await page.mouse.click(
    Math.round(box.x + offset),
    Math.round(box.y + box.height / 2),
    { button: "right" },
  );
}

test.describe("kit context menu", () => {
  const jsErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    jsErrors.length = 0;
    collectJsErrors(page, jsErrors);
    await page.goto("/");
    await waitForFontsReady(page);
  });

  test.afterEach(() => assertNoJsErrors(jsErrors));

  test("a text selection opens the menu with 复制 enabled; clicking it copies", async ({
    page,
  }) => {
    // Select the brand's own text node — a plain, always-present text
    // surface on the app page.
    const brand = page.locator(".kit-brand");
    const selected = await page.evaluate(() => {
      const brandEl = document.querySelector(".kit-brand")!;
      const node = [...brandEl.childNodes].find(
        (n): n is Text =>
          n.nodeType === Node.TEXT_NODE && n.textContent!.trim().length > 0,
      )!;
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, node.textContent!.length);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      return sel.toString();
    });
    expect(selected).toBe("FontAlloy");

    // A REAL contextmenu event, dispatched inside the selection.
    const box = (await brand.boundingBox())!;
    await page.mouse.click(
      Math.round(box.x + box.width - 8),
      Math.round(box.y + box.height / 2),
      { button: "right" },
    );

    const menu = page.locator("[data-context-menu]");
    await expect(menu).toBeVisible();
    const copy = menu.locator('[data-role="ctx-copy"]');
    await expect(copy).toBeEnabled();
    await expect(copy).toHaveAttribute("aria-label", "复制");
    // Nothing editable under the pointer: cut and paste stay off.
    await expect(menu.locator('[data-role="ctx-cut"]')).toBeDisabled();
    await expect(menu.locator('[data-role="ctx-paste"]')).toBeDisabled();

    // Clicking the item copies the captured selection and closes.
    await pointerClick(page, copy);
    await expect(menu).toBeHidden();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "FontAlloy",
    );
  });

  test("an input with a selected range enables 剪切 and cuts it", async ({
    page,
  }) => {
    const input = page.locator("input[data-role='font-name']");
    await expect(input).toHaveValue("ChHsich");
    await page.evaluate(() => {
      const field = document.querySelector<HTMLInputElement>(
        "input[data-role='font-name']",
      )!;
      field.focus();
      field.setSelectionRange(2, 7); // "Hsich"
    });

    // x+38 lands inside the "Hsich" highlight (the 180px field's text
    // spans roughly x+10..x+55) — the selection survives the click.
    await rightClickInset(page, input, 38);
    const menu = page.locator("[data-context-menu]");
    await expect(menu).toBeVisible();
    await expect(menu.locator('[data-role="ctx-copy"]')).toBeEnabled();
    await expect(menu.locator('[data-role="ctx-cut"]')).toBeEnabled();
    await expect(menu.locator('[data-role="ctx-paste"]')).toBeEnabled();

    await pointerClick(page, menu.locator('[data-role="ctx-cut"]'));
    await expect(menu).toBeHidden();
    await expect(input).toHaveValue("Ch");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "Hsich",
    );
  });

  test("粘贴 pastes at the captured caret and replaces the captured selection", async ({
    page,
  }) => {
    const input = page.locator("input[data-role='font-name']");
    await expect(input).toHaveValue("ChHsich");
    await page.evaluate(() => navigator.clipboard.writeText("X"));

    // A non-collapsed selection: paste REPLACES it (native semantics).
    // The click lands inside the "Hsich" highlight so the selection
    // survives into the menu's captured context.
    await page.evaluate(() => {
      const field = document.querySelector<HTMLInputElement>(
        "input[data-role='font-name']",
      )!;
      field.focus();
      field.setSelectionRange(2, 7); // "Hsich"
    });
    await rightClickInset(page, input, 38);
    const menu = page.locator("[data-context-menu]");
    await expect(menu.locator('[data-role="ctx-paste"]')).toBeEnabled();
    await pointerClick(page, menu.locator('[data-role="ctx-paste"]'));
    await expect(menu).toBeHidden();
    await expect(input).toHaveValue("ChX");

    // A collapsed caret: the right-click's own point (the field's left
    // edge → position 0) is the paste target — prepends.
    const box = (await input.boundingBox())!;
    await page.mouse.click(
      Math.round(box.x + 2),
      Math.round(box.y + box.height / 2),
      { button: "right" },
    );
    await expect(menu).toBeVisible();
    await expect(menu.locator('[data-role="ctx-paste"]')).toBeEnabled();
    await pointerClick(page, menu.locator('[data-role="ctx-paste"]'));
    await expect(input).toHaveValue("XChX");
  });

  test("a plain surface with no selection shows the menu with all three disabled", async ({
    page,
  }) => {
    await page.evaluate(() => window.getSelection()?.removeAllRanges());

    // The dispatch is synthetic ON PURPOSE: only a dispatched event's
    // defaultPrevented flag is observable — the global handler must
    // cancel the webview default on EVERY surface (owner ruling: not
    // merely hidden, replaced).
    const prevented = await page.evaluate(() => {
      const button = document.querySelector('[data-role="synthesize"]')!;
      const ev = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 300,
        clientY: 300,
      });
      button.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    expect(prevented).toBe(true);

    // The menu still shows (never an empty hidden surprise) — every
    // item disabled, real menu roles throughout.
    const menu = page.locator("[data-context-menu]");
    await expect(menu).toBeVisible();
    expect(await menu.getAttribute("role")).toBe("menu");
    for (const role of ["ctx-copy", "ctx-cut", "ctx-paste"]) {
      const item = menu.locator(`[data-role="${role}"]`);
      await expect(item).toBeDisabled();
      await expect(item).toHaveAttribute("role", "menuitem");
    }
  });

  test("Escape closes; an outside click closes too", async ({ page }) => {
    await rightClickCenter(page, page.locator('[data-role="synthesize"]'));
    const menu = page.locator("[data-context-menu]");
    await expect(menu).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();

    // Reopen — a left click outside closes (the kit overlay rule).
    await rightClickCenter(page, page.locator('[data-role="synthesize"]'));
    await expect(menu).toBeVisible();
    await page.mouse.click(60, 450);
    await expect(menu).toBeHidden();
  });

  test("the menu clamps inside the frame at the bottom-right corner", async ({
    page,
  }) => {
    // The pointer lands 5px from the viewport's bottom-right corner; an
    // unclamped menu would paint past the frame.
    await page.mouse.click(1435, 892, { button: "right" });
    const menu = page.locator("[data-context-menu]");
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1440 + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(900 + 1);
  });
});
