import { expect, type Locator, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Seam-3 helpers (spec issue #1 "Testing Decisions" / ticket #15):
 * - real pointer/mouse events with elementFromPoint hit-testing guards
 *   (programmatic clicks bypass inertness and hit-testing and prove nothing);
 * - DOM textContent / geometry assertions, never pixel reads;
 * - zero-JS-errors gate on load and across the test;
 * - font readiness (document.fonts.ready) awaited before asserting rendered text.
 */

/**
 * Expected-benign console-error classes. Since the round-2 unification
 * every workspace page on the web target (this whole suite: the dev
 * server pages are plain browser pages) probes the local merge service
 * on load — `?serve=`, default http://127.0.0.1:7777 — and when
 * nothing answers, the BROWSER ITSELF logs the refused/blocked fetch.
 * The page handles the rejection by design (absence is a state); the
 * browser's own console line is declared benign here so the
 * zero-JS-errors gate keeps meaning "no page-emitted errors". Page
 * errors (uncaught exceptions) are never excusable.
 */
const BROWSER_NOISE: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern:
      /Failed to load resource.*net::ERR_(CONNECTION_REFUSED|FAILED|ABORTED|TIMED_OUT)/,
    reason: "an intentional loopback probe was refused at network level",
  },
  {
    pattern: /https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/,
    reason: "a network error on the intentional loopback probe target",
  },
  {
    pattern: /has been blocked by CORS policy/,
    reason: "a probe target answered without allowing this origin",
  },
];

/** Collect every JS error the page reports into `sink`; assert later. */
export function collectJsErrors(page: Page, sink: string[]): void {
  page.on("pageerror", (err) => sink.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = `console.error: ${msg.text()}`;
    if (BROWSER_NOISE.some((entry) => entry.pattern.test(text))) return;
    sink.push(text);
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
 * Compute the center of `locator` and return it only if the element (or a
 * descendant of it) is what elementFromPoint reports there — i.e. the point is
 * actually clickable and not covered by an overlay or clipped away.
 *
 * Re-render races retry: a store render between the visibility wait and the
 * geometry read can replace the node ("Element is not attached to the DOM");
 * the fresh node occupies the same spot, so re-resolving and retrying (up to
 * three times) clicks the real element rather than failing the gesture.
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
        ([px, py]) => {
          const hit = document.elementFromPoint(px, py);
          return hit === null;
        },
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

/**
 * Click via real mouse events, after an elementFromPoint guard that ALSO
 * verifies the hit resolves to `locator` (or inside it).
 */
export async function pointerClick(page: Page, locator: Locator): Promise<void> {
  const { x, y } = await hitTestCenter(page, locator);
  const handle = await locator.elementHandle();
  expect(handle, "target lost before click").not.toBeNull();
  const hitInfo = await page.evaluate(
    ({ px, py, el }) => {
      const hit = document.elementFromPoint(px, py);
      if (!hit || !el) return { ok: false, desc: "no hit" };
      const desc = `${hit.tagName}.${(hit as HTMLElement).className} in ${(hit as HTMLElement).closest("[data-help-popup]")?.getAttribute("data-help-popup") ?? (hit as HTMLElement).closest("[data-picker-popup]")?.getAttribute("data-picker-popup") ?? (hit as HTMLElement).closest(".kit-pop")?.className ?? "-"}`;
      return { ok: hit === el || el.contains(hit), desc };
    },
    { px: x, py: y, el: handle },
  );
  expect(
    hitInfo.ok,
    `hit test at (${x}, ${y}) did not resolve to the target (got: ${hitInfo.desc})`,
  ).toBe(true);
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
}

/**
 * Fixture font files for the local-load path. Font binaries never enter git;
 * tests pick the first two distinct real font files present on the host.
 * Override with FONTALLOY_TEST_FONT_1 / FONTALLOY_TEST_FONT_2.
 */
const FONT_CANDIDATES = [
  "C:\\Windows\\Fonts\\consola.ttf",
  "C:\\Windows\\Fonts\\arial.ttf",
  "C:\\Windows\\Fonts\\segoeui.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
];

export function fixtureFontPaths(): string[] {
  const fromEnv = [
    process.env.FONTALLOY_TEST_FONT_1,
    process.env.FONTALLOY_TEST_FONT_2,
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  const found: string[] = [];
  for (const p of [...fromEnv, ...FONT_CANDIDATES.map((c) => resolve(c))]) {
    if (existsSync(p) && !found.includes(p)) found.push(p);
    if (found.length === 2) break;
  }
  if (found.length < 2) {
    throw new Error(
      "need two distinct host font files for the local-load tests; " +
        "set FONTALLOY_TEST_FONT_1 / FONTALLOY_TEST_FONT_2",
    );
  }
  return found;
}

/** CSS-quoted font-family value, safe for names with spaces. */
export function cssFamilyQuote(family: string): string {
  return `"${family.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The REAL catalog font binaries for the minimal-path synthesis test
 * (round 5, owner item 7): JetBrainsMono NF + Maple Mono CN — the same
 * files the dev catalog serves, from the same font directory candidates
 * (FONTALLOY_DEV_FONT_DIR, the sibling prototype checkout, an in-tree
 * prototype branch). Font binaries never enter git; the test is
 * mandatory, so a missing directory fails loudly rather than skipping.
 */
export function realCatalogFontPaths(): { base: string; donor: string } {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "../..");
  const candidates = [
    process.env.FONTALLOY_DEV_FONT_DIR,
    resolve(root, "..", "fontalloy", "gui", "prototype", "fonts"),
    resolve(root, "gui", "prototype", "fonts"),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  for (const dir of candidates) {
    const base = resolve(dir, "JetBrainsMonoNerdFont-Regular.ttf");
    const donor = resolve(dir, "MapleMonoCN-Regular.ttf");
    if (existsSync(base) && existsSync(donor)) return { base, donor };
  }
  throw new Error(
    "the real catalog fonts were not found (tried " +
      candidates.map((p) => `"${p}"`).join(", ") +
      ") — set FONTALLOY_DEV_FONT_DIR to the dev-catalog font directory",
  );
}
