import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Seam-3 helpers, WebApp target — the same contract as the GUI suite
 * (gui/tests/helpers.ts; kept self-contained per build target):
 * - real pointer/mouse events with elementFromPoint hit-testing guards;
 * - DOM textContent assertions, never pixels;
 * - zero-JS-errors gate on load;
 * - font readiness awaited before asserting rendered text.
 */

/**
 * The zero-JS-errors gate with a benign-error policy: expected
 * network-refusal console lines (the WebApp probes a possibly-absent
 * local service BY DESIGN, and the browser logs the refused/blocked
 * fetch itself) are declared per test instead of leaking into the gate.
 * A declaration only ever matches `console.error` lines — page errors
 * (uncaught exceptions) are never excusable.
 */
export interface ErrorGate {
  /**
   * Declare an expected console-error line. The pattern is tested
   * against both the message text and the `text [source-url]` composite,
   * so a declaration can key on the refused resource's address.
   */
  allow(pattern: RegExp, reason: string): void;
}

/** Collect every JS error the page reports into `sink`; assert later. */
export function collectJsErrors(page: Page, sink: string[]): ErrorGate {
  const allowed: Array<{ pattern: RegExp; reason: string }> = [];
  page.on("pageerror", (err) => sink.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = `console.error: ${msg.text()}`;
    const source = msg.location()?.url ?? "";
    const composite = `${text} [${source}]`;
    if (allowed.some((entry) => entry.pattern.test(text) || entry.pattern.test(composite))) {
      return; // declared benign (kept out of the sink, still justified above)
    }
    sink.push(text);
  });
  return {
    allow(pattern, reason) {
      allowed.push({ pattern, reason: reason });
    },
  };
}

/** The zero-JS-errors gate. */
export function assertNoJsErrors(sink: string[]): void {
  expect(sink, `page reported JS errors:\n${sink.join("\n")}`).toHaveLength(0);
}

/**
 * The suite-wide benign declaration: the page's load-time probe of the
 * local serve address, refused at network level. The browser logs the
 * failed fetch itself ("Failed to load resource: net::ERR_…"); the page
 * handles the rejection, so only the browser's own line needs excusing.
 */
export function allowProbeRefusal(gate: ErrorGate, address: string): void {
  const host = new RegExp(address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  gate.allow(
    /Failed to load resource.*net::ERR_(CONNECTION_REFUSED|FAILED|ABORTED|TIMED_OUT)/,
    `the absent-service probe at ${address} was refused at network level`,
  );
  gate.allow(
    host,
    `a network error on the intentional probe target ${address}`,
  );
  gate.allow(
    /has been blocked by CORS policy/,
    "the probe target answered without allowing this origin",
  );
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
