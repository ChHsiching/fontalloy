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
  {
    pattern: /Failed to load resource.*status of 400 \(Bad Request\)/,
    reason:
      "a serve submission the strict recipe gate rejected (ticket #29: " +
      "the row error IS the design, the page handles the 400)",
  },
];

/**
 * Whether one collected console line is one of the expected-benign
 * classes above. Exposed for suites that own their listener lifetime
 * (the journeys suite keeps one page across all journeys and filters
 * at assertion time instead of registering per-test listeners).
 */
export function isKnownBenignConsoleError(text: string): boolean {
  return BROWSER_NOISE.some((entry) => entry.pattern.test(text));
}

/** Collect every JS error the page reports into `sink`; assert later. */
export function collectJsErrors(page: Page, sink: string[]): void {
  page.on("pageerror", (err) => sink.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = `console.error: ${msg.text()}`;
    if (isKnownBenignConsoleError(text)) return;
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
   * The tag's right edge is flush (≤1px) with the fact ROW's — the
   * row spans the report's content width, so this is the PANEL's
   * right edge (round 20, owner item 6: the value container was the
   * wrong reference — a content-sized box made the pin true while the
   * tag sat short of the panel). Whether it shares the line or
   * wrapped to its own next line, the tag hugs the panel's edge.
   */
  rightFlush: boolean;
}

/**
 * Round 19 (owner items 4a+4b): read one tagged fact's tag geometry —
 * a SHORT value (输出格式's ttf, 行高保持不变's 是) must pin both
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
      rightFlush: Math.abs(g.right - el.getBoundingClientRect().right) <= 1,
    };
  });
}
