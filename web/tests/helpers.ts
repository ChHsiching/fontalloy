import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Seam-3 helpers, WebApp target — the same contract as the GUI suite
 * (gui/tests/helpers.ts; kept self-contained per build target):
 * - real pointer/mouse events with elementFromPoint hit-testing guards;
 * - DOM textContent assertions, never pixels;
 * - zero-JS-errors gate on load;
 * - font readiness awaited before asserting rendered text.
 */

/** Collect every JS error the page reports into `sink`; assert later. */
export function collectJsErrors(page: Page, sink: string[]): void {
  page.on("pageerror", (err) => sink.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") sink.push(`console.error: ${msg.text()}`);
  });
}

/** The zero-JS-errors gate. */
export function assertNoJsErrors(sink: string[]): void {
  expect(sink, `page reported JS errors:\n${sink.join("\n")}`).toHaveLength(0);
}

/** Await the browser font subsystem before asserting rendered text. */
export async function waitForFontsReady(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
}

/**
 * Compute the center of `locator` and return it only if the element (or
 * a descendant of it) is what elementFromPoint reports there.
 */
export async function hitTestCenter(
  page: Page,
  locator: Locator,
): Promise<{ x: number; y: number }> {
  await locator.waitFor({ state: "visible" });
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error("hit test target has no bounding box");
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);
  const covered = await page.evaluate(
    ([px, py]) => document.elementFromPoint(px, py) === null,
    [x, y],
  );
  expect(
    covered,
    `elementFromPoint(${x}, ${y}) is covered or outside the viewport`,
  ).toBe(false);
  return { x, y };
}

/** Click via real mouse events, after an elementFromPoint guard. */
export async function pointerClick(page: Page, locator: Locator): Promise<void> {
  const { x, y } = await hitTestCenter(page, locator);
  const handle = await locator.elementHandle();
  expect(handle, "target lost before click").not.toBeNull();
  const ok = await page.evaluate(
    ({ px, py, el }) => {
      const hit = document.elementFromPoint(px, py);
      if (!hit || !el) return false;
      return hit === el || el.contains(hit);
    },
    { px: x, py: y, el: handle },
  );
  expect(ok, `hit test at (${x}, ${y}) did not resolve to the target`).toBe(true);
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
}

/**
 * Open a listbox (catalog or preset picker) through a real pointer
 * click on its anchor and wait for the discrete open transition.
 */
export async function openListbox(
  page: Page,
  anchor: Locator,
  label: string,
): Promise<Locator> {
  await pointerClick(page, anchor);
  const popup = page.locator(`.picker-popup[data-picker-popup="${label}"]`);
  await expect(popup).toBeVisible();
  await expect
    .poll(() =>
      popup.evaluate((el) => getComputedStyle(el).visibility),
    )
    .toBe("visible");
  return popup;
}

/** Pick one option from an open listbox by its option id. */
export async function pickOption(
  page: Page,
  popup: Locator,
  optionId: string,
): Promise<void> {
  const row = popup.locator(`[data-option-id="${optionId}"]`);
  await expect(row).toBeVisible();
  await pointerClick(page, row);
  await expect(popup).not.toBeVisible();
}

/** The rendered recipe YAML (the builder's own preview of the file). */
export function yamlPreview(page: Page): Locator {
  return page.locator('[data-testid="recipe-yaml"]');
}

/** The rendered `fontalloy build` command. */
export function cliCommand(page: Page): Locator {
  return page.locator('[data-testid="cli-command"]');
}
