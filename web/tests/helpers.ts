import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Seam-3 helpers, WebApp target — the same contract as the GUI suite
 * (gui/tests/helpers.ts; kept self-contained per build target):
 * - real pointer/mouse events with elementFromPoint hit-testing guards;
 * - DOM textContent assertions, never pixels;
 * - zero-JS-errors gate on load;
 * - font readiness awaited before asserting rendered text.
 *
 * Since the round-2 unification the WebApp IS the workspace: the specs
 * drive the same top bar / rail / charmap / build panel the GUI suite
 * drives. The helpers below add the workspace-driving vocabulary on
 * top of the kit's popup/select helpers.
 */

/**
 * The zero-JS-errors gate with a benign-error policy: expected
 * network-refusal console lines (the workspace probes a possibly-absent
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
      allowed.push({ pattern, reason });
    },
  };
}

/** The zero-JS-errors gate. */
export function assertNoJsErrors(sink: string[]): void {
  expect(sink, `page reported JS errors:\n${sink.join("\n")}`).toHaveLength(0);
}

/** A loopback address nothing listens on (deterministic absence). */
export const UNUSED_SERVE = "http://127.0.0.1:59999";

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
 * Opt the page OUT of the real dev catalog the static bundle boots by
 * default (VITE_WEB_CATALOG=1): specs that are not about the catalog
 * run catalog-free for determinism and speed — the injected config
 * nulls the bootstrap URL (the platform seam, gui/src/platform/config).
 */
export async function optOutOfCatalog(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const config = window as unknown as {
      __FONTALLOY_CONFIG__: Record<string, unknown>;
    };
    config.__FONTALLOY_CONFIG__ = { catalogBootstrapUrl: null };
  });
}

/**
 * Wait for the first-run catalog run to SETTLE: the progress screen
 * appears while families are pending and hides itself when the run
 * finishes. Waiting for the hide (instead of skipping) leaves the store
 * quiet — the picker headers/rows stop rebuilding mid-cursor, so the
 * real-pointer helpers stop racing the download churn. On
 * already-verified storage the screen never shows; the bounded wait
 * covers that too.
 */
export async function waitForCatalogReady(
  page: Page,
  timeout = 240_000,
): Promise<void> {
  const screen = page.locator(".catalog-screen");
  await screen.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
  await expect(screen).toBeHidden({ timeout });
}

/**
 * Compute the center of `locator` and return it only if the element (or
 * a descendant of it) is what elementFromPoint reports there.
 *
 * Re-render races retry: a store render between the visibility wait and
 * the geometry read can replace the node (the workspace rebuilds picker
 * headers and rows on every store patch — during catalog downloads
 * that is constant); the fresh node occupies the same spot, so
 * re-resolving and retrying (up to three times) clicks the real
 * element rather than failing the gesture.
 */
export async function hitTestCenter(
  page: Page,
  locator: Locator,
): Promise<{ x: number; y: number }> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
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
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("not attached")) throw err;
      await page.waitForTimeout(50);
    }
  }
  throw lastError;
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
 * Open one of the rail's font pickers (the kit PickerPopup card) and
 * return the popup locator.
 */
export async function openFontPicker(
  page: Page,
  role: "en" | "cjk",
): Promise<Locator> {
  await pointerClick(page, page.locator(`[data-role="picker-${role}"] .kit-hd`));
  const popup = page.locator(`[data-picker-popup="${role}"]`);
  await expect(popup).toBeVisible();
  await expect
    .poll(() => popup.evaluate((el) => getComputedStyle(el).opacity))
    .toBe("1");
  return popup;
}

/**
 * Pick one CATALOG family through its picker: wait until the family's
 * row exists AND is enabled (its download verified), then click it and
 * wait for the card header to carry the family.
 *
 * The row click goes through raw mouse coordinates on purpose: while
 * the catalog's lazy registration sweep runs, every store patch
 * rebuilds the popup's rows — an elementHandle-pinned pointerClick can
 * keep missing the replaced node. The row set at a given point is
 * stable (same spot, same handler semantics); the elementFromPoint
 * guard still verifies a real row is under the cursor.
 */
export async function pickCatalogFamily(
  page: Page,
  role: "en" | "cjk",
  family: string,
  timeout = 240_000,
  /** What the rail CARD must read after the pick, when the variant's
   *  real name differs from the row's family name (round 8, item 7). */
  cardName?: string,
): Promise<void> {
  const popup = await openFontPicker(page, role);
  await page.waitForFunction(
    ({ role, family }) => {
      const rows = [
        ...document.querySelectorAll(`[data-picker-popup="${role}"] .kit-fp`),
      ];
      const row = rows.find((r) => r.textContent?.startsWith(family));
      return row && !row.classList.contains("off") ? true : null;
    },
    { role, family },
    { timeout },
  );
  const row = popup.locator(`.kit-fp[data-font-id]:has-text("${family}")`);
  // Bounded retry over the residual row churn (a rebuild between the
  // scroll and the geometry read detaches the node — measure null, so
  // re-resolve and re-measure until one attempt lands a stable box).
  let box: { x: number; y: number; width: number; height: number } | null =
    null;
  for (let attempt = 0; box === null; attempt++) {
    try {
      await row.scrollIntoViewIfNeeded();
      box = await row.boundingBox();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("not attached") || attempt >= 10) throw err;
    }
    if (box === null && attempt >= 10) {
      throw new Error(`no bounding box for the ${family} row`);
    }
    if (box === null) await page.waitForTimeout(100);
  }
  if (!box) throw new Error(`no bounding box for the ${family} row`);
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);
  const hitIsRow = await page.evaluate(([px, py]) => {
    const hit = document.elementFromPoint(px, py);
    return hit !== null && hit.closest(".kit-fp") !== null;
  }, [x, y]);
  expect(hitIsRow, `hit test at (${x}, ${y}) did not resolve to a row`).toBe(
    true,
  );
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
  await page.waitForFunction(
    ({ role, card }) =>
      (document.querySelector(`[data-role="picker-${role}"] .kit-hd b`)
        ?.textContent ?? "") === card,
    { role, card: cardName ?? family },
    { timeout: 10_000 },
  );
  await page.keyboard.press("Escape");
}

/**
 * Load one local font file into a picker through the workspace's shared
 * hidden file input (the browser local-load path — the footer action's
 * own input, set directly like the GUI suite does).
 */
export async function loadLocalFont(
  page: Page,
  role: "en" | "cjk",
  path: string,
): Promise<void> {
  const popup = await openFontPicker(page, role);
  await page.locator("input[data-role='font-file']").setInputFiles(path);
  await expect(popup.locator(".kit-fp").first()).toBeVisible();
  await waitForFontsReady(page);
  await page.keyboard.press("Escape");
}

/** The top bar's primary synthesize action. */
export function synthesizeButton(page: Page): Locator {
  return page.locator(".topbar [data-role='synthesize']");
}

/**
 * Open the no-service CLI panel through the synthesize flow: clicking
 * 合成字体 without a connected service offers the copy-CLI command and
 * the recipe YAML download (the absorbed #22 builder).
 */
export async function openCliPanel(page: Page): Promise<Locator> {
  await pointerClick(page, synthesizeButton(page));
  const panel = page.locator('[data-testid="cli-panel"]');
  await expect(panel).toBeVisible();
  return panel;
}

/**
 * Set one AppSelect by value: a real pointer click on the trigger, then
 * on the option row (the kit dropdown; no native select exists).
 */
export async function pickSelectOption(
  page: Page,
  host: Locator,
  value: string,
): Promise<void> {
  await pointerClick(page, host.locator(".kit-csel"));
  const row = host.locator(`.kit-cso[data-value="${value}"]`);
  await expect(row).toBeVisible();
  await pointerClick(page, row);
  await expect(host.locator(".kit-csel-pk")).toBeHidden();
}

/** The geometry facts of one qualifier TAG, read off its fact row. */
export interface TagGeometry {
  /** The tag row's computed display (flex — it lays its tags in a row). */
  rowDisplay: string;
  /**
   * The tag's box shares the value text's line: it overlaps the text
   * span's vertical range by more than half its own height (round 19,
   * owner items 4a+4b — the tag rides INLINE after the value; a tag
   * parked exactly under the text's bottom edge overlaps nothing and
   * reads as its own line).
   */
  sameLine: boolean;
  /**
   * The tag's right edge is flush (≤1px) with the value container's —
   * whether it shares the line or wrapped to its own next line, the
   * tag hugs the right edge.
   */
  rightFlush: boolean;
}

/**
 * Round 19 (owner items 4a+4b): read one tagged fact's tag geometry —
 * a SHORT value (输出格式's ttc, 行高保持不变's 是) must pin both
 * sameLine and rightFlush true; a long wrapping sentence (the weight
 * grid's source line) pins only rightFlush, the vertical position
 * being wherever the wrap left it.
 */
export async function tagGeometry(fact: Locator): Promise<TagGeometry | null> {
  return fact.evaluate((el) => {
    const value = el.querySelector(".report-fact-value");
    const row = el.querySelector(".report-tag-row");
    const text = el.querySelector(".report-fact-value-text");
    const tag = row?.querySelector('[data-role="report-tag"]');
    if (value === null || row === null || !tag) return null;
    const t = text?.getBoundingClientRect();
    const g = tag.getBoundingClientRect();
    const overlap =
      t === undefined
        ? 0
        : Math.min(g.bottom, t.bottom) - Math.max(g.top, t.top);
    return {
      rowDisplay: getComputedStyle(row).display,
      sameLine: overlap > (g.bottom - g.top) / 2,
      rightFlush:
        Math.abs(g.right - value.getBoundingClientRect().right) <= 1,
    };
  });
}
