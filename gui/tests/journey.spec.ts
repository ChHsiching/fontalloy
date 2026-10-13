import { test as base, expect, chromium, type Locator, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hitTestCenter,
  isKnownBenignConsoleError,
  pointerClick,
  waitForFontsReady,
} from "./helpers";
import { spawnServeOverFonts } from "./serve";

/**
 * USER-JOURNEY e2e — one real user walks the whole app, quantified.
 *
 * Ten journeys (J1–J10, the owner's stage list), each a Playwright test
 * whose steps are tracked INDIVIDUALLY: every step's title carries the
 * scorecard key (`J<stage>.<step>`), pass/fail is recorded per step, a
 * summary line prints per journey, and a machine-readable report lands
 * at `fontalloy-notes/journey-report-gui.json` — refreshed after every
 * journey, so even a crashed run leaves the table for the scorecard.
 *
 * Environment (playwright.journey.config.ts): the REAL dev catalog ON
 * (the vite server serves the repo manifest's families from the local
 * prototype fonts directory) and ONE persistent browser profile for
 * the whole run — a user's machine: J1's first boot pays the one-time
 * catalog download, later launches start from stored catalog + theme
 * state. Picks, rules, and settings still reset per launch (only the
 * catalog and the theme preference persist by design), so every
 * journey sets up its own picks through the UI and stays independent.
 *
 * J9 合成 runs against the owner's real serve layout
 * (FONTALLOY_RUN_ASSETS — the fontalloy-run checkout's fetched
 * catalog): the repo's own `fontalloy serve` over that directory, so
 * the catalog picks resolve through the manifest's catalog-family
 * references, and the saved artifact is parsed with fontTools (the
 * same library the core pipeline builds with).
 *
 * Conventions (the suite's mandatory ones, from ./helpers): real
 * pointer events with elementFromPoint hit-test guards, DOM
 * textContent assertions, fonts.ready waits, and the zero-JS-errors
 * gate per journey.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
/** The shared notes repository, three levels above gui/tests. */
const NOTES_DIR = resolve(here, "..", "..", "..", "fontalloy-notes");
const REPORT_PATH = resolve(NOTES_DIR, "journey-report-gui.json");

/**
 * The owner's real serve layout: a checkout whose `assets/fonts` the
 * `fontalloy assets fetch` layout filled (zips + extracted faces) and
 * whose `assets/fonts.manifest.json` pins them. Override with
 * FONTALLOY_RUN_ASSETS when the run checkout lives elsewhere.
 */
const RUN_ASSETS = resolve(
  process.env.FONTALLOY_RUN_ASSETS ??
    "C:/Users/Administrator/Git/fontalloy-run/assets",
);
const RUN_FONTS = resolve(RUN_ASSETS, "fonts");
const RUN_MANIFEST = resolve(RUN_ASSETS, "fonts.manifest.json");

/* ------------------------------------------------------------------ */
/* The journey report — step tracking + the JSON artifact              */
/* ------------------------------------------------------------------ */

type StepRecord = { name: string; ok: boolean; error?: string };
type JourneyRecord = {
  name: string;
  passed: number;
  total: number;
  steps: StepRecord[];
};

const journeyResults: JourneyRecord[] = [];

async function writeReport(): Promise<void> {
  const report = {
    generated: new Date().toISOString(),
    suite: "gui/tests/journey.spec.ts (playwright.journey.config.ts)",
    environment:
      "real dev catalog (VITE_DEV_CATALOG=1), one persistent browser " +
      "profile across the run, J9 against the real serve layout " +
      `(${RUN_ASSETS.replace(/\\/g, "/")})`,
    journey: journeyResults.map((j) => ({
      name: j.name,
      steps: `${j.passed}/${j.total}`,
      passed: j.passed,
      total: j.total,
      failedSteps: j.steps
        .filter((s) => !s.ok)
        .map((s) => ({ name: s.name, error: s.error })),
    })),
    stepsPassed: journeyResults.reduce((n, j) => n + j.passed, 0),
    stepsTotal: journeyResults.reduce((n, j) => n + j.total, 0),
  };
  await mkdir(NOTES_DIR, { recursive: true });
  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2) + "\n");
}

/* ------------------------------------------------------------------ */
/* The persistent-profile fixture + the per-journey gates              */
/* ------------------------------------------------------------------ */

/** JS errors of the shared page, cleared at each journey's start. */
const jsErrors: string[] = [];
/** Where the current journey's saved artifacts land (the save stand-in). */
let currentSaveDir: string | null = null;
/** Round 12: how many times the 另存为 DIALOG seam fired this run. */
let dialogSaveCalls = 0;
// Parallel-stream runs: an explicit FONTALLOY_E2E_ORIGIN wins, else the
// PLAYWRIGHT_DEV_PORT the configs picked (default: the shared 5173).
const JOURNEY_ORIGIN =
  process.env.FONTALLOY_E2E_ORIGIN ??
  `http://localhost:${process.env.PLAYWRIGHT_DEV_PORT ?? "5173"}`;

const test = base.extend<{ journeysPage: Page }>({
  journeysPage: [
    async ({}, use) => {
      const userDataDir = mkdtempSync(
        resolve(tmpdir(), "fontalloy-journey-profile-"),
      );
      const context = await chromium.launchPersistentContext(userDataDir, {
        baseURL: JOURNEY_ORIGIN,
        viewport: { width: 1440, height: 900 },
        colorScheme: "light",
      });
      const page = context.pages()[0] ?? (await context.newPage());

      // The zero-JS-errors gate, registered ONCE for the shared page
      // (the journeys filter at assertion time instead of stacking
      // per-test listeners).
      page.on("pageerror", (err) =>
        jsErrors.push(`pageerror: ${err.message}`),
      );
      page.on("console", (msg) => {
        if (msg.type() !== "error") return;
        const text = `console.error: ${msg.text()}`;
        if (!isKnownBenignConsoleError(text)) jsErrors.push(text);
      });

      // Live GitHub stars: hermetic and quiet — a fixed count for every
      // repo the manifest pins (the real API is rate-limited per IP).
      await context.route("https://api.github.com/**", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ stargazers_count: 4242 }),
        }),
      );

      // The native-save stand-in (one binding for the whole run; the
      // bytes land in the CURRENT journey's temp dir). Round 12 splits
      // the seam in two, mirroring the app: `saveArtifact` is the
      // DEFAULT-PATH save (what synthesis uses — no dialog), and
      // `saveArtifactAs` is the 另存为 dialog (an as- copy; counting
      // its calls proves the automatic save never depends on it).
      await page.exposeFunction(
        "__fontalloyJourneySave",
        async (name: string, bytesB64: string): Promise<string | null> => {
          if (currentSaveDir === null) return null;
          const target = resolve(currentSaveDir, name);
          await writeFile(target, Buffer.from(bytesB64, "base64"));
          return target;
        },
      );
      await page.exposeFunction(
        "__fontalloyJourneySaveAs",
        async (name: string, bytesB64: string): Promise<string | null> => {
          if (currentSaveDir === null) return null;
          dialogSaveCalls += 1;
          const target = resolve(currentSaveDir, `as-${name}`);
          await writeFile(target, Buffer.from(bytesB64, "base64"));
          return target;
        },
      );
      await page.addInitScript(() => {
        const config = (
          window as unknown as {
            __FONTALLOY_CONFIG__: Record<string, unknown>;
          }
        ).__FONTALLOY_CONFIG__ ??= {};
        const toB64 = (bytes: Uint8Array): string =>
          btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
        config.saveArtifact = async (
          name: string,
          bytes: Uint8Array,
        ): Promise<{ saved: boolean; path: string | null }> => {
          // Chunked base64: a round-12 family build saves a ttc
          // collection of hundreds of MB — the one-shot
          // Array.from().join() would build gigabytes of intermediate
          // strings and crash the page. The chunk size must be a
          // multiple of 3 (btoa then emits no '=' padding — a padded
          // group mid-string would truncate the decode at the first
          // '=') and modest enough to stay under the spread
          // argument-count limit.
          let b64 = "";
          const chunk = 30_720;
          for (let i = 0; i < bytes.length; i += chunk) {
            b64 += btoa(
              String.fromCharCode(...bytes.subarray(i, i + chunk)),
            );
          }
          const path = await (
            window as unknown as {
              __fontalloyJourneySave(
                name: string,
                b64: string,
              ): Promise<string | null>;
            }
          ).__fontalloyJourneySave(name, toB64(bytes));
          return path === null
            ? { saved: false, path: null }
            : { saved: true, path };
        };
        config.saveArtifactAs = async (
          name: string,
          bytes: Uint8Array,
        ): Promise<{ saved: boolean; path: string | null }> => {
          const path = await (
            window as unknown as {
              __fontalloyJourneySaveAs(
                name: string,
                b64: string,
              ): Promise<string | null>;
            }
          ).__fontalloyJourneySaveAs(name, toB64(bytes));
          return path === null
            ? { saved: false, path: null }
            : { saved: true, path };
        };
        // `?noservice=1` disables the merge service (serveUrl null), so
        // a stray listener on the default probe port can never make a
        // no-service journey depend on machine state.
        if (new URLSearchParams(location.search).has("noservice")) {
          config.serveUrl = null;
        }
      });

      await use(page);
      await context.close();
    },
    { scope: "worker" },
  ],
});

/**
 * Run one journey: tracked steps (the scorecard's J<n>.<m> keys), an
 * incremental report write after the journey, and a thrown summary
 * when anything failed (so Playwright marks the test red while the
 * report still lands for the scorecard).
 */
async function journey(
  name: string,
  body: (
    step: (stepName: string, fn: () => Promise<void>) => Promise<void>,
  ) => Promise<void>,
): Promise<void> {
  const steps: StepRecord[] = [];
  let aborted = false;
  let bodyError: string | null = null;
  console.log(`\n=== ${name} ===`);
  const step = async (
    stepName: string,
    fn: () => Promise<void>,
  ): Promise<void> => {
    const record: StepRecord = { name: stepName, ok: false };
    steps.push(record);
    if (aborted) {
      record.error = "skipped: an earlier step failed";
      console.log(`  skip  ${stepName}`);
      return;
    }
    const started = Date.now();
    try {
      await fn();
      record.ok = true;
      console.log(`  ok    ${stepName} (${Date.now() - started}ms)`);
    } catch (err) {
      record.error = err instanceof Error ? err.message : String(err);
      aborted = true;
      console.log(
        `  FAIL  ${stepName} (${Date.now() - started}ms): ${record.error}`,
      );
    }
  };
  try {
    await body(step);
  } catch (err) {
    bodyError = err instanceof Error ? err.message : String(err);
  }
  const passed = steps.filter((s) => s.ok).length;
  journeyResults.push({ name, passed, total: steps.length, steps });
  await writeReport();
  const failures = steps.filter((s) => !s.ok);
  const problems = [
    ...failures.map((s) => `step "${s.name}": ${s.error ?? "failed"}`),
    ...(bodyError === null ? [] : [`journey body: ${bodyError}`]),
  ];
  if (problems.length > 0) {
    throw new Error(
      `${name} — ${passed}/${steps.length} steps passed\n  ${problems.join("\n  ")}`,
    );
  }
}

/** The per-journey zero-JS-errors gate. */
async function assertNoJsErrors(): Promise<void> {
  expect(
    jsErrors,
    `the page reported JS errors during this journey:\n${jsErrors.join("\n")}`,
  ).toEqual([]);
}

/* ------------------------------------------------------------------ */
/* Shared UI walks (each journey sets up its own state through the UI) */
/* ------------------------------------------------------------------ */

const pickerCard = (page: Page, role: "en" | "cjk") =>
  page.locator(`[data-role="picker-${role}"] .kit-hd`);
const pickerPopup = (page: Page, role: "en" | "cjk") =>
  page.locator(`[data-picker-popup="${role}"]`);
/** A picker row by its EXACT display name (rows self-render .kit-nm). */
const pickerRow = (page: Page, role: "en" | "cjk", name: string) =>
  pickerPopup(page, role).locator(".kit-fp").filter({
    has: page.locator(".kit-nm", { hasText: new RegExp(`^${name}$`) }),
  });

async function openPicker(page: Page, role: "en" | "cjk"): Promise<void> {
  await pointerClick(page, pickerCard(page, role));
  await expect(pickerPopup(page, role)).toBeVisible();
}

/**
 * Click at the target's center by RAW COORDINATES (no node-identity
 * pin). While the catalog's lazy registration sweep runs, every store
 * patch rebuilds the popup's rows, and an elementHandle-pinned
 * identity check keeps missing the replaced node ("did not resolve to
 * the target (got: SPAN.kit-nm …)"). The row set at a given spot is
 * stable — same content in the same order, same handler semantics
 * (the web suite's own documented precedent) — and the hit-test guard
 * still proves a real interactive element sits under the cursor.
 * Re-resolve and retry when the sweep's rebuild detaches the node
 * between the visibility wait and the geometry read ("no bounding
 * box", "not attached"): the fresh node occupies the same spot.
 */
async function rawClick(page: Page, locator: Locator): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const { x, y } = await hitTestCenter(page, locator);
      await page.mouse.move(x, y);
      await page.mouse.click(x, y);
      return;
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      if (
        !message.includes("no bounding box") &&
        !message.includes("not attached")
      ) {
        throw err;
      }
      await page.waitForTimeout(120);
    }
  }
  throw lastError;
}

/** Pick a catalog row by display name; the pair tag confirms the pick.
 *  Catalog-row picks keep the popup open (only local loads close it),
 *  so the walk closes it with Escape — the prototype's own gesture. */
async function pickCatalogRow(
  page: Page,
  role: "en" | "cjk",
  name: string,
  pairTagText: string | RegExp,
): Promise<void> {
  await openPicker(page, role);
  await rawClick(page, pickerRow(page, role, name));
  await waitForFontsReady(page);
  await expect(
    page.locator(
      `[data-role='font-pair'] [data-pair='${role === "en" ? "base" : "donor"}']`,
    ),
  ).toHaveText(pairTagText, { timeout: 20_000 });
  await page.keyboard.press("Escape");
  await expect(pickerPopup(page, role)).toBeHidden();
}

/**
 * The flagship pair, picked the way the owner's journey demands: the
 * EN slot's JetBrains Mono row (the Nerd Font cut), the CJK slot's
 * Maple row narrowed to its NF-CN variant THROUGH THE VARIANT CHIP
 * (round 8's per-cut chips — the chip resolves to the manifest's
 * MapleMono/NF-CN entry, and every identity surface then reads the
 * variant's REAL name, 「Maple Mono NF-CN」).
 */
async function pickFlagshipPair(page: Page): Promise<void> {
  // Round 9 (owner item 2): rows read the faces' OWN name-table names.
  await pickCatalogRow(page, "en", "JetBrainsMono Nerd Font", /JetBrainsMono/);
  await openPicker(page, "cjk");
  const mapleRow = pickerRow(page, "cjk", "Maple Mono CN");
  const nfCnChip = mapleRow.locator(".kit-vchip[data-chip='MapleMono::NF-CN']");
  await expect(nfCnChip).toBeVisible();
  await rawClick(page, nfCnChip);
  await waitForFontsReady(page);
  // The identity is the served face's own name-table string (round 9).
  await expect(
    page.locator("[data-role='font-pair'] [data-pair='donor']"),
  ).toHaveText("Maple Mono CN", { timeout: 20_000 });
  await page.keyboard.press("Escape");
  await expect(pickerPopup(page, "cjk")).toBeHidden();
}

/** The grid's effective table on the current page, from cell attributes. */
function collectGrid(
  page: Page,
): Promise<Record<string, [string, string, string]>> {
  return page.evaluate(() => {
    const out: Record<string, [string, string, string]> = {};
    for (const cell of document.querySelectorAll(".charmap-grid .kit-cell")) {
      const cp = cell.getAttribute("data-cp");
      if (!cp) continue;
      out[cp] = [
        cell.getAttribute("data-winner") ?? "",
        cell.getAttribute("data-via") ?? "",
        cell.getAttribute("data-kind") ?? "",
      ];
    }
    return out;
  });
}

/**
 * Item 1a's rendering sanity (round 7): every EFFECTIVE cell on the
 * current page renders in its WINNER's own face — the computed
 * font-family's first name equals the winning pick's family (read off
 * the rail card headers, which self-render each pick in its own face).
 * The DATA layer (data-winner) saying one thing while the GLYPH layer
 * paints another would be a real bug; this closes that blind spot.
 */
async function assertWinnerGlyphs(page: Page): Promise<void> {
  const mismatches = await page.evaluate(() => {
    const first = (list: string): string =>
      list.split(",")[0]!.replace(/["']/g, "").trim().toLowerCase();
    const cardFamily = (role: string): string =>
      first(
        document
          .querySelector<HTMLElement>(
            `[data-role='picker-${role}'] .kit-hd .kit-hdc b`,
          )
          ?.style.fontFamily ?? "",
      );
    const expected: Record<string, string> = {
      base: cardFamily("en"),
      "donor-0": cardFamily("cjk"),
    };
    const bad: string[] = [];
    for (const cell of document.querySelectorAll<HTMLElement>(
      ".charmap-grid .kit-cell[data-winner]",
    )) {
      const want = expected[cell.dataset.winner ?? ""];
      if (!want) continue;
      const got = first(getComputedStyle(cell).fontFamily);
      if (got !== want) {
        bad.push(
          `${cell.dataset.cp}: winner=${cell.dataset.winner} painted=${got} expected=${want}`,
        );
      }
    }
    return bad;
  });
  expect(
    mismatches,
    `cells whose painted face differs from their winner font:\n${mismatches
      .slice(0, 8)
      .join("\n")}`,
  ).toEqual([]);
}

/** Real-pointer drag-paint across the named cells (多选 armed first). */
async function paintDrag(page: Page, cps: string[]): Promise<void> {
  const first = await hitTestCenter(
    page,
    page.locator(`.charmap-grid .kit-cell[data-cp='${cps[0]}']`),
  );
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (let i = 1; i < cps.length; i++) {
    const point = await hitTestCenter(
      page,
      page.locator(`.charmap-grid .kit-cell[data-cp='${cps[i]}']`),
    );
    await page.mouse.move(point.x, point.y, { steps: 3 });
  }
  await page.mouse.up();
}

/** Boot a launch and wait until the workspace is usable. */
async function boot(page: Page, url = "/"): Promise<void> {
  jsErrors.length = 0;
  await page.goto(url);
  await waitForFontsReady(page);
  // Wait for the catalog run to SETTLE, observed through the progress
  // screen's own DOM (it renders its family rows even while hidden):
  // rows exist AND none is pending/downloading. The first launch pays
  // the one-time catalog download behind the visible screen; a stored
  // launch reaches all-verified rows during the bootstrap sweep and the
  // screen never shows. Waiting for "settled" — not for "hidden now" —
  // is the honest contract: the screen node mounts hidden and flips
  // visible only AFTER the bootstrap fetch + verification sweep, and a
  // mid-download navigation aborts the run, so every boot re-checks.
  const rows = page.locator(".catalog-family");
  const inFlight = page.locator(
    ".catalog-family[data-status='pending'], " +
      ".catalog-family[data-status='downloading']",
  );
  await expect
    .poll(
      async () =>
        (await rows.count()) > 0 && (await inFlight.count()) === 0,
      { timeout: 300_000 },
    )
    .toBe(true);
  await expect(page.locator(".catalog-screen")).toBeHidden();
  await page.waitForTimeout(400);
  await expect(page.locator(".catalog-screen")).toBeHidden();
  await expect(page.locator(".workspace-rail")).toBeVisible();
}

const num = (text: string | null | undefined): number =>
  Number((text ?? "0").replace(/,/g, ""));

/** The live column count of the grid's current page. */
function gridColumnCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const cells = [...document.querySelectorAll(".charmap-grid .kit-cell")];
    if (cells.length === 0) return 0;
    const top = cells[0]!.getBoundingClientRect().top;
    return cells.filter(
      (c) => Math.abs(c.getBoundingClientRect().top - top) < 1,
    ).length;
  });
}

/**
 * Assert the grid's CURRENT page is full rows (no trailing gap): a
 * non-final page's cell count is a multiple of the live column count.
 */
async function assertRowsFull(page: Page, isLastPage: boolean): Promise<void> {
  const count = await page.locator(".charmap-grid .kit-cell").count();
  expect(count).toBeGreaterThan(0);
  if (isLastPage) return; // the final page may end mid-row (the honest remainder)
  const cols = await gridColumnCount(page);
  expect(cols).toBeGreaterThan(0);
  expect(count % cols, `${count} cells over ${cols} columns leaves a gap`).toBe(
    0,
  );
}

/* ------------------------------------------------------------------ */
/* J9's real-serve plumbing                                            */
/* ------------------------------------------------------------------ */

/** The repo's own venv python (fontTools ships with the core). */
function venvPython(): string {
  return resolve(repoRoot, ".venv/Scripts/python.exe");
}

/** Parse a built font with fontTools: family, cmap size, CJK presence.
 *  A round-12 family artifact is a ttc collection — read its face 0. */
async function parseBuiltFont(path: string): Promise<{
  family: string | null;
  cmap: number;
  cjkCodepoints: number;
}> {
  const script = resolve(
    await mkdtemp(resolve(tmpdir(), "fontalloy-journey-parse-")),
    "parse.py",
  );
  await writeFile(
    script,
    [
      "import json, sys",
      "from fontTools.ttLib import TTFont",
      "with open(sys.argv[1], 'rb') as stream:",
      "    collection = stream.read(4) == b'ttcf'",
      "font = TTFont(sys.argv[1], fontNumber=0 if collection else None)",
      "cmap = font.getBestCmap() or {}",
      "print(json.dumps({",
      "    'family': font['name'].getDebugName(1),",
      "    'cmap': len(cmap),",
      "    'cjkCodepoints': sum(1 for c in cmap if 0x4E00 <= c <= 0x9FFF),",
      "}))",
    ].join("\n"),
  );
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(venvPython(), [script, path], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
    child.on("error", rejectPromise);
    child.on("close", (code: number | null) => {
      if (code !== 0) {
        rejectPromise(new Error(`fontTools parse exited ${code}: ${err}`));
        return;
      }
      resolvePromise(JSON.parse(out.trim()) as {
        family: string | null;
        cmap: number;
        cjkCodepoints: number;
      });
    });
  });
}

/* ------------------------------------------------------------------ */
/* The ten journeys                                                    */
/* ------------------------------------------------------------------ */

test.describe("user journey", () => {
  test.afterAll(async () => {
    await writeReport();
  });

  test("J1 初次启动 — fresh state, complete chrome, honest empties", async ({
    journeysPage: page,
  }) => {
    test.setTimeout(900_000);
    await journey("J1 初次启动", async (step) => {
      await step("J1.1 first boot: the catalog screen settles, workspace up", async () => {
        await boot(page);
        await expect(page.locator(".catalog-screen")).toBeHidden();
        await expect(page.locator(".workspace-rail")).toBeVisible();
        await expect(page.locator(".workspace-content")).toBeVisible();
      });

      await step("J1.2 top bar chrome complete: brand+mark, pair slot, GitHub, theme, font-name, 合成字体", async () => {
        const bar = page.locator(".topbar");
        await expect(bar.locator(".kit-brand")).toContainText("FontAlloy");
        await expect(bar.locator(".kit-brand-mark")).toBeVisible();
        await expect(
          bar.locator("a[aria-label='GitHub 仓库 ChHsiching/fontalloy']"),
        ).toBeVisible();
        await expect(
          bar.locator("[data-role='theme-toggle']"),
        ).toBeVisible();
        const fontName = bar.locator("[data-role='font-name']");
        await expect(fontName).toHaveValue("ChHsich");
        const synthesize = bar.locator("[data-role='synthesize']");
        await expect(synthesize).toHaveText("合成字体");
        // Fresh state, no service: the action is disabled — honestly.
        await expect(synthesize).toHaveAttribute("aria-disabled", "true");
      });

      await step("J1.3 rail sections complete with the design's empty states", async () => {
        for (const title of [
          "英文字体",
          "中文字体",
          "文字范围",
          "自定义规则",
          "合成设置",
        ]) {
          await expect(
            page
              .locator(".workspace-rail .section", { hasText: title })
              .first(),
          ).toBeVisible();
        }
        await expect(
          page.locator(".workspace-rail .section-desc"),
        ).toHaveText("勾选的文字由中文字体提供，并入成品");
        // Empty pickers: the honest 尚未加载字体 header, no invented tags.
        await expect(
          page.locator("[data-role='picker-en'] .kit-hdc"),
        ).toContainText("尚未加载字体");
        await expect(
          page.locator("[data-role='picker-cjk'] .kit-hdc"),
        ).toContainText("尚未加载字体");
        await expect(page.locator(".kit-rl-empty")).toHaveText("暂无自定义规则。");
        for (const label of ["字重合并方式", "中英文的基线对齐", "中文字符宽度"]) {
          await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
        }
      });

      await step("J1.4 charmap + status bar present in the plain preview", async () => {
        await expect(
          page.locator(".charmap-grid .kit-cell").first(),
        ).toBeVisible();
        await expect(
          page.locator(".kit-toolrow [data-pager-label]"),
        ).toHaveText(/第 1\/\d+ 页/);
        await expect(page.locator(".statsbar")).toBeVisible();
        // No picks yet: the counters exist and the coverage is honest.
        for (const stat of ["total", "en", "cjk", "adjusted", "missing"]) {
          await expect(
            page.locator(`[data-stat='${stat}']`),
          ).toBeVisible();
        }
        // Round 8 (owner item 4): the CJK↔digit/latin spacing rule —
        // the coverage reads 「覆盖 NN.NN%」 (a half-width space, two
        // decimals), and every counter keeps the kit-level gap between
        // its number and its unit (the builder-level spacing rule).
        await expect(page.locator(".kit-cov")).toHaveText(
          /^覆盖 \d+\.\d{2}%$/,
        );
        const counterGap = await page
          .locator(".kit-stat .kit-c")
          .first()
          .evaluate((el) => getComputedStyle(el).columnGap);
        expect(Number(counterGap.replace("px", ""))).toBeGreaterThanOrEqual(4);
      });

      await step("J1.5 theme defaults to 自动 (following the system)", async () => {
        const toggle = page.locator(".topbar [data-role='theme-toggle']");
        await expect(toggle).toHaveAttribute("data-theme-mode", "auto");
        await expect(toggle.locator(".kit-theme-auto")).toBeVisible();
        expect(
          await page.evaluate(() => document.documentElement.dataset.theme),
        ).toBe("light"); // the emulated scheme is light
      });

      await step("J1.6 zero JS errors across the journey", assertNoJsErrors);
    });
  });

  test("J2 挑字体 — pickers, chips, the flagship pair, rail identity", async ({
    journeysPage: page,
  }) => {
    await journey("J2 挑字体", async (step) => {
      await step("J2.1 the EN picker opens in the AppSelect form with search + footer", async () => {
        await boot(page);
        await openPicker(page, "en");
        const popup = pickerPopup(page, "en");
        await expect(popup.locator(".kit-q")).toBeVisible();
        await expect(popup.locator(".kit-fp").first()).toBeVisible();
        await expect(popup.locator(".kit-fpsys")).toContainText(
          "加载本地字体文件",
        );
      });

      await step("J2.2 rows self-render in their own typeface with meta lines", async () => {
        const row = pickerRow(page, "en", "JetBrainsMono Nerd Font");
        await expect(row).toBeVisible();
        // Self-rendering: the name's inline font-family is its own face.
        // The lazy registration sweep lands AFTER the catalog screen
        // hides (manager.registerVerified runs post-settle), so the
        // inline style arrives asynchronously — poll for it.
        await expect
          .poll(
            async () =>
              row.locator(".kit-nm").evaluate((el) => el.style.fontFamily),
            { timeout: 30_000 },
          )
          .not.toBe("");
        // Meta line: license + trait (curated 连字) + stars (routed 4242).
        await expect(row.locator(".kit-meta")).toBeVisible();
        await expect(row).toContainText("连字");
        await expect(row).toContainText("OFL");
      });

      await step("J2.3 pick JetBrains Mono (the Nerd Font cut) → the base pair tag", async () => {
        await rawClick(page, pickerRow(page, "en", "JetBrainsMono Nerd Font"));
        await waitForFontsReady(page);
        await expect(
          page.locator("[data-role='font-pair'] [data-pair='base']"),
        ).toHaveText(/JetBrains/, { timeout: 20_000 });
        await page.keyboard.press("Escape");
        await expect(pickerPopup(page, "en")).toBeHidden();
      });

      await step("J2.4 the CJK picker lists the expanded CJK set", async () => {
        await openPicker(page, "cjk");
        const rows = pickerPopup(page, "cjk").locator(".kit-fp");
        const count = await rows.count();
        expect(count).toBeGreaterThanOrEqual(10);
        for (const name of ["Maple Mono CN", "LXGW WenKai"]) {
          await expect(pickerRow(page, "cjk", name)).toBeVisible();
        }
      });

      await step("J2.5 variant chips are official proper nouns (NF / NF-CN, plain default, picker-level help)", async () => {
        const maple = pickerRow(page, "cjk", "Maple Mono CN");
        // Round 8 final form: one chip per CUT; round 9: the labels are
        // the data's own words — 标准 (the family default) and NF-CN. The
        // default cut renders PLAIN: no 默认 marker, no dashed ring,
        // never a pressed look; the weight axis never chips.
        const nf = maple.locator(".kit-vchip[data-chip='MapleMono::NF']");
        const nfCn = maple.locator(".kit-vchip[data-chip='MapleMono::NF-CN']");
        await expect(nf).toBeVisible();
        // Round 9 (owner item 2): the DEFAULT cut reads 标准; the other
        // cut's label is the data's own word (the NF-CN variant).
        await expect(nf).toHaveText(/^标准$/);
        await expect(nf).not.toContainText("默认");
        await expect(nf).not.toHaveClass(/def|on/);
        await expect(nfCn).toBeVisible();
        await expect(nfCn).toHaveText(/^NF-CN$/);
        await expect(nfCn).not.toHaveClass(/on/);
        await expect(maple.locator(".kit-vchip")).toHaveCount(2);
        // The WenKai group row: its cuts carry the official compound
        // labels (Mono / 屏幕版 / GB …), never a weight chip.
        const wenkai = pickerRow(page, "cjk", "LXGW WenKai");
        await expect(
          wenkai.locator(".kit-vchip[data-chip='LXGWWenKaiMono::Regular']"),
        ).toHaveText(/^Mono/);
        // Round 9: the author's own word (Screen), never 屏幕版.
        await expect(
          wenkai.locator(".kit-vchip[data-chip='LXGWWenKaiScreen::Regular']"),
        ).toHaveText(/^Screen/);
        for (const chip of await wenkai.locator(".kit-vchip").all()) {
          const text = await chip.textContent();
          expect(text, `no weight chips: ${text}`).not.toMatch(
            /^(Light|Medium|Regular)$/,
          );
        }
        // ONE ? for the whole picker (never per row): the variant help.
        const help = pickerPopup(page, "cjk").locator(
          "[data-role='help-picker-variants-cjk']",
        );
        await expect(help).toBeVisible();
        await pointerClick(page, help);
        const pop = page.locator(
          "[data-help-popup='picker-variants-cjk']",
        );
        await expect(pop).toBeVisible();
        await expect(pop.locator("h5")).toHaveText("变体是什么");
        await expect(pop).toContainText("同一款字体常有多个发行版本");
        // The token vocabulary the chips carry, as official terms —
        // and no weight row (the axis is deleted).
        for (const term of ["NF / NL", "Mono / HW", "Screen", "标准"]) {
          await expect(pop).toContainText(term);
        }
        await expect(pop).not.toContainText("字重");
        await page.keyboard.press("Escape");
        await expect(pop).toBeHidden();
      });

      await step("J2.6 pick Maple Mono NF-CN via the chip → the variant's real name everywhere", async () => {
        // J2.5's Escape closed only the help popover — the picker
        // itself stays open (one layer per press). Fail fast if that
        // layering ever breaks instead of waiting on a hidden chip.
        await expect(pickerPopup(page, "cjk")).toBeVisible();
        const nfCn = page
          .locator(".kit-fp", { hasText: "Maple Mono" })
          .locator(".kit-vchip[data-chip='MapleMono::NF-CN']");
        await rawClick(page, nfCn);
        await waitForFontsReady(page);
        // The identity follows the font file itself (round 9, owner
        // item 2): the pair tag carries the served face's OWN
        // name-table string.
        await expect(
          page.locator("[data-role='font-pair'] [data-pair='donor']"),
        ).toHaveText("Maple Mono CN", { timeout: 20_000 });
        // The chip is the EXPLICIT selection (accent); the default NF
        // cut stays plain.
        await expect(
          page.locator(".kit-vchip[data-chip='MapleMono::NF-CN']"),
        ).toHaveClass(/on/);
        await expect(
          page.locator(".kit-vchip[data-chip='MapleMono::NF']"),
        ).not.toHaveClass(/on/);
        await page.keyboard.press("Escape");
        await expect(pickerPopup(page, "cjk")).toBeHidden();
      });

      await step("J2.7 the rail carries both identity cards, self-rendered, real names", async () => {
        for (const role of ["en", "cjk"] as const) {
          const name = page.locator(
            `[data-role='picker-${role}'] .kit-hd .kit-hdc b`,
          );
          await expect(name).toBeVisible();
          await expect(name).not.toBeEmpty();
          const family = await name.evaluate((el) => el.style.fontFamily);
          expect(family.length).toBeGreaterThan(0); // rendered in its own face
        }
        // The CJK card reads the picked face's own name-table string
        // (round 9, item 2) — the same identity the pair tag and the
        // report carry.
        await expect(
          page.locator("[data-role='picker-cjk'] .kit-hd .kit-hdc b"),
        ).toHaveText("Maple Mono CN");
      });

      await step("J2.8 zero JS errors across the journey", assertNoJsErrors);
    });
  });

  test("J3 文字范围 — language chips, preset effect, the last-language guard", async ({
    journeysPage: page,
  }) => {
    await journey("J3 文字范围", async (step) => {
      await step("J3.1 setup: the flagship pair picked through the UI", async () => {
        await boot(page);
        await pickFlagshipPair(page);
      });

      await step("J3.2 the four language chips, verbatim labels + real counts", async () => {
        const expected = [
          ["zh_cn", "简体中文", "6,765"],
          ["zh_tw", "繁体中文", "13,063"],
          ["ja", "日文", "2,314"],
          ["ko", "韩文", "2,442"],
        ] as const;
        for (const [preset, label, count] of expected) {
          const chip = page.locator(
            `[data-role='lang-chip'][data-preset='${preset}']`,
          );
          await expect(chip).toHaveText(`${label}${count}`);
        }
        // The boot-seeded default: 简体中文 is the declared preset.
        await expect(
          page.locator("[data-role='lang-chip'][data-preset='zh_cn']"),
        ).toHaveAttribute("aria-pressed", "true");
      });

      await step("J3.3 toggling 日文 on: chip presses, kana resolve through the preset rule", async () => {
        const jaCell = page.locator(
          ".charmap-grid .kit-cell[data-cp='U+3042']",
        ); // あ — page 1 of the 全部 view is ASCII, so jump via 定位
        const locate = page.locator(".kit-toolrow [data-role='locate']");
        await locate.fill("U+3042");
        await locate.press("Enter");
        await expect(jaCell).toHaveClass(/cur/);
        // Before the preset: no RULE resolves the kana — the donor may
        // still cover it (via "default", the no-rule chain), but `via`
        // never names a rule yet.
        expect((await jaCell.getAttribute("data-via")) ?? "").not.toMatch(
          /^rule-\d+$/,
        );
        const ja = page.locator("[data-role='lang-chip'][data-preset='ja']");
        await pointerClick(page, ja);
        await expect(ja).toHaveAttribute("aria-pressed", "true");
        await expect(jaCell).toHaveAttribute("data-via", /rule-\d+/);
      });

      await step("J3.4 preset changes reach the rules summary surface (pressed chips)", async () => {
        // The preset universe lives in the 文字范围 chips (round-5
        // ruling): its summary IS the pressed set.
        const pressed = await page.locator(
          "[data-role='lang-chip'][aria-pressed='true']",
        );
        await expect(pressed).toHaveCount(2); // zh_cn + ja
      });

      await step("J3.5 至少保留一种: the last declared language cannot be removed", async () => {
        // Remove ja first (zh_cn remains), then zh_cn is the last — blocked.
        await pointerClick(
          page,
          page.locator("[data-role='lang-chip'][data-preset='ja']"),
        );
        await expect(
          page.locator("[data-role='lang-chip'][data-preset='ja']"),
        ).toHaveAttribute("aria-pressed", "false");
        await pointerClick(
          page,
          page.locator("[data-role='lang-chip'][data-preset='zh_cn']"),
        );
        await expect(page.locator("[data-role='live']")).toHaveText(
          "至少保留一种",
        );
        await expect(
          page.locator("[data-role='lang-chip'][data-preset='zh_cn']"),
        ).toHaveAttribute("aria-pressed", "true");
      });

      await step("J3.6 zero JS errors across the journey", assertNoJsErrors);
    });
  });

  test("J4 字符表遨游 — categories, 图标, full rows, pager, jump, 缺失", async ({
    journeysPage: page,
  }) => {
    await journey("J4 字符表遨游", async (step) => {
      await step("J4.1 setup: the flagship pair picked through the UI", async () => {
        await boot(page);
        await pickFlagshipPair(page);
      });

      await step("J4.2 category groups navigate (全部 → 中日韩文字 → 拉丁文字)", async () => {
        await expect(
          page.locator(".kit-cat-g[data-group='cjk']"),
        ).toContainText("中日韩文字");
        await pointerClick(page, page.locator(".kit-cat-g[data-group='cjk']"));
        await expect(
          page.locator(".kit-cat-s[data-block='cjk-unified']"),
        ).toBeVisible();
        await assertRowsFull(page, false);
        await pointerClick(
          page,
          page.locator(".kit-cat-g[data-group='latin-europe']"),
        );
        await expect(
          page.locator(".kit-cat-s[data-block='basic-latin']"),
        ).toBeVisible();
      });

      await step("J4.3 the 图标 category renders Nerd Font macro-blocks, pages full", async () => {
        await pointerClick(page, page.locator(".kit-cat-g[data-group='icons']"));
        const powerline = page.locator(
          ".kit-cat-s[data-block='nf-powerline']",
        );
        await expect(powerline).toBeVisible();
        await pointerClick(page, powerline);
        const first = page.locator(".charmap-grid .kit-cell").first();
        const cp = parseInt(
          ((await first.getAttribute("data-cp")) ?? "").slice(2),
          16,
        );
        expect(cp).toBeGreaterThanOrEqual(0xe0a0);
        expect(cp).toBeLessThanOrEqual(0xe0d7);
        // The base's OWN Nerd Font cut carries the powerline glyphs, and
        // the default chain tries the base first — the winner is "base"
        // (the base pick's ref; donors read "donor-0", picks.ts).
        expect(await first.getAttribute("data-winner")).toBe("base");
        await assertRowsFull(page, true);
      });

      await step("J4.4 pager next/prev walk pages; every visited page is row-full", async () => {
        await pointerClick(page, page.locator(".kit-cat-g[data-group='all']"));
        const label = page.locator(".kit-toolrow [data-pager-label]");
        await expect(label).toHaveText(/第 1\/\d+ 页/);
        await assertRowsFull(page, false);
        const next = page.locator(
          ".kit-toolrow .kit-pgc button[aria-label='下一页']",
        );
        await pointerClick(page, next);
        await expect(label).toHaveText(/第 2\/\d+ 页/);
        await assertRowsFull(page, false);
        const prev = page.locator(
          ".kit-toolrow .kit-pgc button[aria-label='上一页']",
        );
        await pointerClick(page, prev);
        await expect(label).toHaveText(/第 1\/\d+ 页/);
      });

      await step("J4.5 jump-to-page: valid jumps, out-of-range clamps, Esc cancels", async () => {
        const label = page.locator(".kit-toolrow [data-pager-label]");
        const last = Number(
          (await label.textContent())!.match(/第 1\/(\d+) 页/)![1],
        );
        expect(last).toBeGreaterThan(1);
        // Valid: page 2.
        await pointerClick(page, label);
        const input = page.locator(".kit-toolrow [data-pager-input]");
        await expect(input).toBeVisible();
        await expect(input).toBeFocused();
        await input.fill("2");
        await input.press("Enter");
        await expect(label).toHaveText(`第 2/${last} 页`);
        // Out-of-range high: clamps to the last page.
        await pointerClick(page, label);
        await input.fill("99999");
        await input.press("Enter");
        await expect(label).toHaveText(`第 ${last}/${last} 页`);
        await assertRowsFull(page, true); // the honest remainder
        // Out-of-range low: clamps to page 1.
        await pointerClick(page, label);
        await input.fill("0");
        await input.press("Enter");
        await expect(label).toHaveText(`第 1/${last} 页`);
        // Esc cancels the edit without jumping.
        await pointerClick(page, label);
        await input.fill(`${Math.min(3, last)}`);
        await input.press("Escape");
        await expect(label).toHaveText(`第 1/${last} 页`);
      });

      await step("J4.6 缺失 auto-visible with both picks; its view tells the truth", async () => {
        const chip = page.locator(".kit-cat-g[data-group='missing']");
        await expect(chip).toBeVisible();
        expect(num(await chip.locator(".n").textContent())).toBeGreaterThan(0);
        await pointerClick(page, chip);
        await expect(page.locator(".kit-toolrow")).toContainText(
          "缺失字符无法指定来源",
        );
      });

      await step("J4.7 a missing cell shows its codepoint (the only honest content)", async () => {
        const cell = page
          .locator(".charmap-grid .kit-cell.miss")
          .first();
        await expect(cell).toBeVisible();
        const cp = await cell.getAttribute("data-cp");
        expect(cp).toMatch(/^U\+[0-9A-F]{4,}$/);
        // The visible cp row shows the bare hex of that codepoint.
        await expect(cell.locator(".cp")).toHaveText(
          cp!.replace(/^U\+/, ""),
        );
      });

      await step("J4.8 glyph identity: every effective cell paints its winner's face; a CJK-adjacent assignment flips it", async () => {
        // The CJK group's first page (CJK 符号和标点): the base holds
        // none of it, so every effective cell must paint the DONOR.
        await pointerClick(page, page.locator(".kit-cat-g[data-group='cjk']"));
        await expect(
          page.locator(".kit-cat-s[data-block='cjk-unified']"),
        ).toBeVisible();
        await assertWinnerGlyphs(page);
        // The few CJK-adjacent codepoints the EN base ACTUALLY holds
        // (JetBrains Mono NF carries the fullwidth braces U+FF5B/U+FF5D
        // in 半形与全形字符): there the default winner is the BASE and
        // an assignment to 中文 MUST visibly flip the painted glyph.
        await pointerClick(
          page,
          page.locator(".kit-cat-s[data-block='halfwidth-fullwidth']"),
        );
        const brace = page.locator(
          ".charmap-grid .kit-cell[data-cp='U+FF5B']",
        );
        await expect(brace).toBeVisible();
        await expect(brace).toHaveAttribute("data-winner", "base");
        await assertWinnerGlyphs(page);
        const blockRow = page
          .locator(".kit-toolrow")
          .filter({ hasText: "半形与全形字符" });
        await pointerClick(
          page,
          blockRow.locator(".kit-mseg button", { hasText: /^用中文$/ }),
        );
        await expect(brace).toHaveAttribute("data-winner", "donor-0");
        await expect(brace).toHaveAttribute("data-via", /rule-\d+/);
        // The GLYPH flips with the data: the brace now paints in the
        // donor's own face (item 1a — assignment visibly moves glyphs).
        await assertWinnerGlyphs(page);
        // Undo returns the block to the no-rule default.
        await pointerClick(page, page.locator("[data-role='undo']"));
        await expect(brace).toHaveAttribute("data-winner", "base");
        await assertWinnerGlyphs(page);
      });

      await step("J4.9 zero JS errors across the journey", assertNoJsErrors);
    });
  });

  test("J5 单字符交互 — popup facts, side switch, reset, 按编码指定", async ({
    journeysPage: page,
  }) => {
    await journey("J5 单字符交互", async (step) => {
      await step("J5.1 setup: the flagship pair picked through the UI", async () => {
        await boot(page);
        await pickFlagshipPair(page);
        await pointerClick(
          page,
          page.locator(".kit-cat-g[data-group='latin-europe']"),
        );
        await pointerClick(
          page,
          page.locator(".kit-cat-s[data-block='basic-latin']"),
        );
      });

      await step("J5.2 cell click → popup with the FULL fact sheet", async () => {
        await pointerClick(
          page,
          page.locator(".charmap-grid .kit-cell[data-cp='U+0041']"),
        );
        const popup = page.locator("[data-char-popup]");
        await expect(popup).toBeVisible();
        await expect(popup.locator("[data-role='char-glyph']")).toHaveText("A");
        await expect(popup.locator("[data-role='char-code']")).toHaveText(
          "U+0041",
        );
        await expect(popup.locator("[data-role='char-from']")).toHaveText(
          /来自 /,
        );
        // The side switches: only the MEANINGFUL one shows — the button
        // naming the CURRENT winner is a no-op and stays hidden (A's
        // winner is the base, so 用英文字体 hides while 用中文字体 shows).
        await expect(popup.locator("[data-role='char-donor']")).toBeVisible();
        await expect(popup.locator("[data-role='char-base']")).toBeHidden();
        // No custom rule on A yet: 恢复默认 stays hidden.
        await expect(popup.locator("[data-role='char-reset']")).toBeHidden();
      });

      await step("J5.3 用中文字体 mutates the grid: winner flips, ov dot, via rule", async () => {
        await pointerClick(
          page,
          page.locator("[data-char-popup] [data-role='char-donor']"),
        );
        const cell = page.locator(
          ".charmap-grid .kit-cell[data-cp='U+0041']",
        );
        await expect(cell).toHaveAttribute("data-winner", "donor-0");
        await expect(cell).toHaveAttribute("data-via", /rule-\d+/);
        await expect(cell).toHaveClass(/ov/);
        await expect(page.locator("[data-role='rule-solo']")).toHaveText(
          "单个字符 1",
        );
        // Round 8 (owner item 3): the dashed aggregate EXPANDS into
        // its per-character rows — the verbatim single sentence.
        await pointerClick(page, page.locator("[data-role='rule-solo']"));
        const child = page.locator(
          "[data-role='rule-row'][data-kind='codepoint']",
        );
        await expect(child).toHaveCount(1);
        await expect(child).toContainText("U+0041 A 用中文字体");
        await expect(
          page.locator("[data-role='rule-solo']"),
        ).toHaveAttribute("aria-expanded", "true");
        // Round 9 (owner item 6): the aggregate row carries its OWN × —
        // visibly (DOM + geometry: a real sized, opaque close glyph).
        const soloDel = page.locator(
          "[data-role='rule-solo'] [data-role='remove-rule']",
        );
        const delGeom = await soloDel.evaluate((el) => {
          const svg = el.querySelector("svg");
          const s = svg ? svg.getBoundingClientRect() : new DOMRect();
          const cs = getComputedStyle(el);
          return {
            svgW: s.width,
            svgH: s.height,
            visible: cs.visibility === "visible",
            opacity: Number(cs.opacity),
          };
        });
        expect(delGeom.visible).toBe(true);
        expect(delGeom.opacity).toBeGreaterThanOrEqual(0.99);
        expect(delGeom.svgW).toBeGreaterThanOrEqual(10);
        expect(delGeom.svgH).toBeGreaterThanOrEqual(10);
        // It deletes the WHOLE group as one undo step.
        await pointerClick(page, soloDel);
        await expect(child).toHaveCount(0);
        await expect(page.locator("[data-role='rule-solo']")).toHaveCount(0);
        // Re-apply the single rule: the 恢复默认 walk (J5.4) needs it.
        await pointerClick(page, cell);
        await pointerClick(
          page,
          page.locator("[data-char-popup] [data-role='char-donor']"),
        );
        await expect(page.locator("[data-role='rule-solo']")).toHaveText(
          "单个字符 1",
        );
        // The glyph identity holds through the flip (item 3): every
        // effective cell — A now donor-supplied — paints its winner.
        await assertWinnerGlyphs(page);
      });

      await step("J5.4 恢复默认 returns the cell to the no-rule default", async () => {
        await pointerClick(
          page,
          page.locator(".charmap-grid .kit-cell[data-cp='U+0041']"),
        );
        const popup = page.locator("[data-char-popup]");
        // The winner is the donor now, so the BASE switch shows.
        await expect(popup.locator("[data-role='char-base']")).toBeVisible();
        await expect(popup.locator("[data-role='char-reset']")).toBeVisible();
        await pointerClick(page, popup.locator("[data-role='char-reset']"));
        const cell = page.locator(
          ".charmap-grid .kit-cell[data-cp='U+0041']",
        );
        await expect(cell).toHaveAttribute("data-winner", "base");
        await expect(cell).not.toHaveClass(/ov/);
        await expect(page.locator("[data-role='rule-solo']")).toHaveCount(0);
        await assertWinnerGlyphs(page);
      });

      await step("J5.5 a side whose font lacks the codepoint is DISABLED with its reason", async () => {
        // Round 8 (owner item 1): 用X字体 on a font that lacks the
        // codepoint can never take effect (absence never overrides) —
        // the button renders DISABLED with the plain-words reason
        // visible the moment the popup opens, and a click does nothing.
        await pointerClick(page, page.locator(".kit-cat-g[data-group='cjk']"));
        await pointerClick(
          page,
          page.locator(".kit-cat-s[data-block='cjk-punct']"),
        );
        const cell = page.locator(
          ".charmap-grid .kit-cell[data-cp='U+3001']",
        );
        await pointerClick(page, cell);
        const popup = page.locator("[data-char-popup]");
        await expect(popup).toBeVisible();
        const base = popup.locator("[data-role='char-base']");
        await expect(base).toBeVisible();
        await expect(base).toBeDisabled();
        // Round 11 (owner item 8): the reason is painted copy —
        // toBeVisible pins a nonzero box, not just DOM text.
        const reason = popup.locator("[data-role='char-base-reason']");
        await expect(reason).toBeVisible();
        await expect(reason).toHaveText("英文字体不含此码位");
        await expect(base).toContainText("用英文字体");
        // The click cannot write anything: no rule, no dot, no summary.
        await pointerClick(page, base);
        await expect(cell).not.toHaveClass(/ov/);
        await expect(page.locator("[data-role='rule-solo']")).toHaveCount(0);
        await expect(
          page.locator("[data-role='rule-row'][data-kind='group']"),
        ).toHaveCount(0);
        await page.keyboard.press("Escape");
        await expect(popup).toBeHidden();
      });

      await step("J5.6 按编码指定 accepts a range, a single codepoint, rejects garbage", async () => {
        // Back to the latin view for the range walk.
        await pointerClick(
          page,
          page.locator(".kit-cat-g[data-group='latin-europe']"),
        );
        await pointerClick(
          page,
          page.locator(".kit-cat-s[data-block='basic-latin']"),
        );
        // A range: U+0041 至 U+0045 用中文字体.
        await pointerClick(
          page,
          page.locator(".kit-toolrow [data-role='range-specify']"),
        );
        const popup = page.locator("[data-range-popup]");
        await expect(popup).toBeVisible();
        await expect(popup.locator("h5")).toHaveText("按编码指定");
        await popup.locator("[data-role='range-start']").fill("U+0041");
        await popup.locator("[data-role='range-end']").fill("U+0045");
        const side = popup.locator("[data-role='range-side']");
        await pointerClick(page, side.locator(".kit-csel"));
        await pointerClick(page, side.locator(".kit-cso[data-value='donor']"));
        await pointerClick(page, popup.locator("[data-role='range-add']"));
        const rangeRow = page.locator(
          "[data-role='rule-row'][data-kind='range']",
        );
        // Round 8 (owner item 3): the VERBATIM sentence —
        // 「U+0041 A - U+0045 E 用中文字体」.
        await expect(rangeRow).toContainText("U+0041 A - U+0045 E 用中文字体");
        // A single codepoint (end left empty = single): 「U+2600 ☀ 用…」.
        await pointerClick(
          page,
          page.locator(".kit-toolrow [data-role='range-specify']"),
        );
        await popup.locator("[data-role='range-start']").fill("0x2600");
        await popup.locator("[data-role='range-end']").fill("");
        await pointerClick(page, popup.locator("[data-role='range-add']"));
        await expect(
          page.locator("[data-role='rule-row'][data-kind='range']"),
        ).toHaveCount(2);
        await expect(
          page.locator("[data-role='rule-row'][data-kind='range']").nth(1),
        ).toContainText("U+2600 ☀ 用");
        // Invalid input: rejected with the danger border, nothing added.
        await pointerClick(
          page,
          page.locator(".kit-toolrow [data-role='range-specify']"),
        );
        await popup.locator("[data-role='range-start']").fill("not-a-codepoint");
        await pointerClick(page, popup.locator("[data-role='range-add']"));
        await expect(popup).toBeVisible(); // stays open on failure
        const border = await popup
          .locator("[data-role='range-start']")
          .evaluate((el) => el.style.borderColor);
        expect(border.length).toBeGreaterThan(0);
        await expect(
          page.locator("[data-role='rule-row'][data-kind='range']"),
        ).toHaveCount(2);
        await page.keyboard.press("Escape");
        await expect(popup).toBeHidden();
      });

      await step("J5.7 zero JS errors across the journey", assertNoJsErrors);
    });
  });

  test("J6 批量与撤销 — chips, 多选 paint, shift-range, two undos, reset", async ({
    journeysPage: page,
  }) => {
    await journey("J6 批量与撤销", async (step) => {
      await step("J6.1 setup: the flagship pair picked through the UI", async () => {
        await boot(page);
        await pickFlagshipPair(page);
        await pointerClick(
          page,
          page.locator(".kit-cat-g[data-group='latin-europe']"),
        );
        await pointerClick(
          page,
          page.locator(".kit-cat-s[data-block='basic-latin']"),
        );
      });

      await step("J6.2 block chips assign: 用中文 on 基本拉丁 flips suppliers + the outcome message", async () => {
        const blockRow = page
          .locator(".kit-toolrow")
          .filter({ hasText: "基本拉丁" });
        await expect(blockRow).toBeVisible();
        // The block's buttons read 用中文/用英文; the GROUP segment in the
        // same row reads 全用中文/全用英文 — disambiguate by exact label
        // (the design suite's own pattern).
        await pointerClick(
          page,
          blockRow.locator(".kit-mseg button", { hasText: /^用中文$/ }),
        );
        const cell = page.locator(
          ".charmap-grid .kit-cell[data-cp='U+0041']",
        );
        await expect(cell).toHaveAttribute("data-winner", "donor-0");
        await expect(cell).toHaveAttribute("data-via", /rule-\d+/);
        await expect(cell).toHaveClass(/ov/); // supplier changed → the dot
        // Item 3: the whole basic-latin page (now donor-declared) still
        // paints each cell in its winner's own face.
        await assertWinnerGlyphs(page);
        await expect(
          page.locator("[data-role='rule-row'][data-kind='block']").first(),
        ).toContainText("基本拉丁用中文字体");
        // The structured outcome card (the redesign of round 9, owner
        // item 3): the action as the title, the counts as TWO compact
        // stat pairs — the success count ALWAYS stated, even when 0 —
        // the undo hint as a kbd chip. No prose, no glyph separators.
        const message = page.locator("[data-role='message']").first();
        await expect(message).toBeVisible();
        await expect(
          message.locator("[data-role='message-title']"),
        ).toHaveText("基本拉丁用中文字体");
        const nums = message.locator(".kit-msg-num");
        const labels = message.locator(".kit-msg-label");
        await expect(nums).toHaveCount(2);
        await expect(nums.nth(0)).toHaveText(/^[\d,]+$/);
        await expect(labels.nth(0)).toHaveText("生效");
        await expect(nums.nth(1)).toHaveText(/^[\d,]+$/);
        await expect(labels.nth(1)).toHaveText("未变");
        // The stats row carries EXACTLY the two pairs (a tooltip or a
        // stray text node must never duplicate the figures).
        await expect(
          message.locator("[data-role='message-stats']"),
        ).toHaveText(/^[\d,]+生效[\d,]+未变$/);
        // The donor covers basic latin — no ineffective count, so the
        // reason sub-line is absent (never rendered for zero).
        await expect(
          message.locator("[data-role='message-reason']"),
        ).toHaveCount(0);
        // The undo hint: a kbd-styled chip + the verb, one affordance.
        const undo = message.locator("[data-role='message-undo']");
        await expect(undo).toBeVisible();
        await expect(undo.locator(".kit-msg-kbd")).toHaveText("Ctrl+Z");
        await expect(undo).toContainText("撤销");
        // Structure, not soup: the status icon is an SVG, every line is
        // nowrap, the figures are tabular, and no separator glyphs
        // (·, →, ▶) appear anywhere in the card's copy.
        await expect(message.locator(".kit-msg-icon svg")).toHaveCount(1);
        await expect(
          await message.locator("[data-role='message-title']").evaluate(
            (el) => getComputedStyle(el).whiteSpace,
          ),
        ).toBe("nowrap");
        expect(
          await nums.nth(0).evaluate(
            (el) => getComputedStyle(el).fontVariantNumeric,
          ),
        ).toBe("tabular-nums");
        expect(await message.textContent()).not.toMatch(/[·→▶]/);
        // Round 9 (owner item 7): the card auto-dismisses on a ~6s
        // countdown announced by the bottom-edge progress bar — the
        // bar shrinks, hover FREEZES it, leaving resumes.
        const bar = message.locator(".kit-msg-bar");
        await expect(bar).toBeVisible();
        await expect
          .poll(() => bar.evaluate((el) => el.style.transform))
          .toMatch(/^scaleX\(0\.\d+\)$/);
        await message.hover();
        await page.waitForTimeout(150); // pointerenter landed; the bar froze
        const frozen = await bar.evaluate((el) => el.style.transform);
        await page.waitForTimeout(900);
        expect(await bar.evaluate((el) => el.style.transform)).toBe(frozen);
        await page.mouse.move(700, 80);
        await page.waitForTimeout(250);
        expect(await bar.evaluate((el) => el.style.transform)).not.toBe(frozen);
        // The × still closes instantly.
        await pointerClick(page, message.locator("[data-role='message-dismiss']"));
        await expect(message).toHaveCount(0);
      });

      await step("J6.3 group chips assign incl. the CJK group; dots mean 实际生效", async () => {
        await pointerClick(page, page.locator(".kit-cat-g[data-group='cjk']"));
        const groupRow = page
          .locator(".kit-toolrow")
          .filter({ hasText: "所有中日韩文字字符" });
        await expect(groupRow).toBeVisible();
        const cell = page.locator(
          ".charmap-grid .kit-cell[data-cp='U+3001']",
        );
        // The DEFAULT side (全用中文) already matches the effective
        // outcome — the assignment is an idempotent no-op: the cell keeps
        // its no-rule "default" via and carries no dot.
        await pointerClick(
          page,
          groupRow.locator(".kit-mseg button", { hasText: /^全用中文$/ }),
        );
        await expect(cell).toHaveAttribute("data-via", "default");
        await expect(cell).not.toHaveClass(/ov/);
        const adjustedBefore = await page
          .locator("[data-stat='adjusted']")
          .textContent();
        // …the declared-OTHER side (全用英文) writes the rule. The BASE
        // lacks the glyph (JetBrains Mono has no CJK punctuation), so
        // absence-never-overrides fills the slot from the donor — the
        // WINNER stays donor-0 and the rule now owns the codepoint
        // (via), but round 8's dot means 实际生效: nothing actually
        // changed supplier, so NO dot — and the 已调整 counter stays 0
        // (an English assignment's [base, donor] preference IS the
        // default chain; nothing flips).
        await pointerClick(
          page,
          groupRow.locator(".kit-mseg button", { hasText: /^全用英文$/ }),
        );
        await expect(cell).toHaveAttribute("data-via", /rule-\d+/);
        await expect(cell).not.toHaveClass(/ov/);
        // The English assignment adds NOTHING to the 已调整 counter
        // (its [base, donor] preference IS the default chain, so no
        // supplier changes): the count J6.2's latin assignment left
        // stays exactly as it was.
        await expect(page.locator("[data-stat='adjusted']")).toHaveText(
          adjustedBefore,
        );
        await expect(
          page.locator("[data-role='rule-row'][data-kind='group']").first(),
        ).toContainText("所有中日韩文字字符用英文字体");
        // The structured outcome card (the redesign of round 9, owner
        // item 3): the terse group form — the action title, the two
        // stat pairs, and the ineffective reason as a dim sub-line
        // (nonzero here: the base holds none of the CJK group). The
        // status icon reads warn for exactly that partial outcome.
        // The stack columns bottom-up: the newest card is the LAST child.
        const message = page.locator("[data-role='message']").last();
        await expect(message).toBeVisible();
        await expect(
          message.locator("[data-role='message-title']"),
        ).toHaveText("中日韩文字用英文字体");
        await expect(message.locator(".kit-msg-num")).toHaveCount(2);
        await expect(message.locator(".kit-msg-num").nth(0)).toHaveText(
          /^[\d,]+$/,
        );
        await expect(message.locator(".kit-msg-label").nth(0)).toHaveText(
          "生效",
        );
        await expect(message.locator(".kit-msg-label").nth(1)).toHaveText(
          "未变",
        );
        // The stats row carries EXACTLY the two pairs (textContent
        // joins the spans with no whitespace between the figures and
        // their labels).
        await expect(
          message.locator("[data-role='message-stats']"),
        ).toHaveText(/^[\d,]+生效[\d,]+未变$/);
        await expect(
          message.locator("[data-role='message-reason']"),
        ).toHaveText("英文字体不含此码位");
        await expect(message.locator(".kit-msg-icon")).toHaveAttribute(
          "data-icon",
          "warn",
        );
        await expect(message.locator(".kit-msg-kbd")).toHaveText("Ctrl+Z");
        await pointerClick(page, message.locator("[data-role='message-dismiss']"));
        // Item 1a's absence check: the declaration says 英文, every
        // glyph on the page still paints its ACTUAL supplier (the donor
        // — the base holds none of the CJK punctuation).
        await assertWinnerGlyphs(page);
        // Item 1b's affordance: the cell popup states the reason in
        // plain glossary words instead of a silent 来自.
        await pointerClick(page, cell);
        const popup = page.locator("[data-char-popup]");
        // Round 11 (owner item 8): the note line PAINTS (toBeVisible,
        // not just textContent — the show path once fell through to the
        // sheet's display:none default).
        await expect(popup.locator("[data-role='char-note']")).toBeVisible();
        await expect(popup.locator("[data-role='char-note']")).toHaveText(
          "英文字体不含此码位，仍由中文字体补字",
        );
        await expect(popup.locator("[data-role='char-from']")).toContainText(
          "来自",
        );
        // Round 8 (owner item 1): the side the rule already declared is
        // not a working action either — the base button is disabled
        // with its reason (the winner is the donor, and the base lacks
        // the codepoint).
        await expect(popup.locator("[data-role='char-base']")).toBeDisabled();
        await expect(
          popup.locator("[data-role='char-base-reason']"),
        ).toBeVisible();
        await page.keyboard.press("Escape");
        // The 已调整 legend's ? explains the dot (实际生效, not 已声明).
        const legendHelp = page.locator(
          ".kit-toolrow [data-role='help-adjusted-legend']",
        );
        await expect(legendHelp).toBeVisible();
        await pointerClick(page, legendHelp);
        const legendPop = page.locator(
          "[data-help-popup='adjusted-legend']",
        );
        await expect(legendPop).toBeVisible();
        await expect(legendPop).toContainText("绿点＝规则实际生效");
        await expect(legendPop).toContainText("声明但未改变供给的规则不加点");
        await page.keyboard.press("Escape");
        await expect(legendPop).toBeHidden();
      });

      await step("J6.4 多选 mode: drag-paint selects, the live count reads", async () => {
        await pointerClick(
          page,
          page.locator(".kit-cat-g[data-group='latin-europe']"),
        );
        await pointerClick(
          page,
          page.locator(".kit-cat-s[data-block='basic-latin']"),
        );
        await pointerClick(page, page.locator("[data-role='toggle-multi']"));
        await expect(page.locator("[data-role='toggle-multi']")).toHaveAttribute(
          "aria-pressed",
          "true",
        );
        await paintDrag(page, ["U+0041", "U+0042", "U+0043"]);
        await expect(page.locator("[data-role='batch-count']")).toHaveText(
          "已选 3 个",
        );
      });

      await step("J6.5 Shift+点击 extends the selection as a range from the paint anchor", async () => {
        // The paint's first cell is the anchor; shift-clicking G
        // extends A..G in one gesture (7 cells total). Raw mouse clicks
        // carry no modifier option — hold the key on the keyboard.
        const to = await hitTestCenter(
          page,
          page.locator(".charmap-grid .kit-cell[data-cp='U+0047']"),
        );
        await page.keyboard.down("Shift");
        await page.mouse.click(to.x, to.y);
        await page.keyboard.up("Shift");
        await expect(page.locator("[data-role='batch-count']")).toHaveText(
          "已选 7 个",
        );
      });

      await step("J6.6 batch 用中文 applies one range rule and announces it", async () => {
        await pointerClick(page, page.locator("[data-role='batch-donor']"));
        await expect(page.locator("[data-role='live']")).toHaveText(
          "批量调整完成",
        );
        const cell = page.locator(
          ".charmap-grid .kit-cell[data-cp='U+0041']",
        );
        await expect(cell).toHaveAttribute("data-winner", "donor-0");
        await expect(cell).toHaveClass(/ov/);
        await expect(
          page.locator("[data-role='rule-row'][data-kind='range']"),
        ).toContainText("用中文字体");
      });

      await step("J6.7 the two undo stacks behave independently", async () => {
        // The RULE stack (Ctrl+Z): the batch rule from J6.6 reverts.
        const rows = await page.locator("[data-role='rule-row']").count();
        await page.keyboard.press("Control+z");
        await expect(page.locator("[data-role='rule-row']")).toHaveCount(
          rows - 1,
        );
        // The SELECTION stack (the batch bar's own 撤销): a new gesture
        // pushes the previous selection; undo restores it — while the
        // rule state stays exactly as the Ctrl+Z left it.
        const rulesNow = await page.locator("[data-role='rule-row']").count();
        await paintDrag(page, ["U+004A", "U+004B"]);
        await expect(page.locator("[data-role='batch-count']")).toHaveText(
          "已选 2 个",
        );
        // A plain click toggles J out (its own gesture on the stack).
        const jCell = await hitTestCenter(
          page,
          page.locator(".charmap-grid .kit-cell[data-cp='U+004A']"),
        );
        await page.mouse.click(jCell.x, jCell.y);
        await expect(page.locator("[data-role='batch-count']")).toHaveText(
          "已选 1 个",
        );
        await pointerClick(page, page.locator("[data-role='undo-pick']"));
        await expect(page.locator("[data-role='batch-count']")).toHaveText(
          "已选 2 个",
        );
        expect(await page.locator("[data-role='rule-row']").count()).toBe(
          rulesNow,
        ); // the selection undo never touched the rule stack
        // 取消 leaves the mode; the 多选 toggle exits it.
        await pointerClick(page, page.locator("[data-role='batch-clear']"));
        await pointerClick(page, page.locator("[data-role='toggle-multi']"));
        await expect(page.locator("[data-role='toggle-multi']")).toHaveAttribute(
          "aria-pressed",
          "false",
        );
      });

      await step("J6.8 全部恢复默认 resets every customization in one move", async () => {
        await expect(page.locator("[data-role='undo-all']")).toBeVisible();
        await pointerClick(page, page.locator("[data-role='undo-all']"));
        await expect(page.locator(".kit-rl-empty")).toHaveText(
          "暂无自定义规则。",
        );
        // The grid returns to the no-custom-rule table.
        await pointerClick(
          page,
          page.locator(".kit-cat-g[data-group='latin-europe']"),
        );
        await pointerClick(
          page,
          page.locator(".kit-cat-s[data-block='basic-latin']"),
        );
        await expect(
          page.locator(".charmap-grid .kit-cell[data-cp='U+0041']"),
        ).toHaveAttribute("data-winner", "base");
        expect(
          num(await page.locator("[data-stat='adjusted']").textContent()),
        ).toBe(0);
        // The preset scope survives (it is the universe, not a custom).
        await expect(
          page.locator("[data-role='lang-chip'][data-preset='zh_cn']"),
        ).toHaveAttribute("aria-pressed", "true");
      });

      await step("J6.9 zero JS errors across the journey", assertNoJsErrors);
    });
  });

  test("J7 场景 — three cards, per-card themes, fullscreen, custom text", async ({
    journeysPage: page,
  }) => {
    await journey("J7 场景", async (step) => {
      await step("J7.1 setup: picks made, the scene mode entered", async () => {
        await boot(page);
        await pickFlagshipPair(page);
        await pointerClick(
          page,
          page.locator(".kit-modebar .kit-mseg [data-value='scene']"),
        );
      });

      await step("J7.2 three cards render the EFFECTIVE result (provenance attrs)", async () => {
        for (const scene of ["terminal", "code", "document"]) {
          const card = page.locator(`.kit-sc[data-scene='${scene}']`);
          await expect(card).toBeVisible();
          // The effective result: spans resolve through the live resolver.
          const marked = await card.evaluate(
            (el) =>
              el.querySelectorAll("[data-winner]").length,
          );
          expect(marked).toBeGreaterThan(0);
        }
        await expect(
          page.locator(".kit-sc[data-scene='terminal'] .kit-term"),
        ).toContainText("❯ git log --oneline -7");
        await expect(page.locator(".kit-sc[data-scene='code']")).toContainText(
          "FontWorkspace",
        );
        await expect(
          page.locator(".kit-sc[data-scene='document']"),
        ).toContainText("FontAlloy 使用指南");
        // Round 8 (owner item 5): the document scene's inline code
        // renders on the EFFECTIVE English font — the command spans
        // resolve per character (no browser monospace fallback).
        const stripQuotes = (name: string): string =>
          name.replace(/["']/g, "").trim().toLowerCase();
        const codeFont = stripQuotes(
          await page
            .locator(".kit-sc[data-scene='document'] pre code span")
            .first()
            .evaluate(
              (el) => getComputedStyle(el).fontFamily.split(",")[0]!.trim(),
            ),
        );
        const enCard = stripQuotes(
          await page
            .locator("[data-role='picker-en'] .kit-hd .kit-hdc b")
            .evaluate((el) => el.style.fontFamily.split(",")[0] ?? ""),
        );
        expect(codeFont).toBe(enCard);
        expect(codeFont).not.toContain("consolas");
        // Round 9 (owner item 4): the WHOLE document sample renders on
        // the effective fonts — headings, list items, and table cells
        // carry per-character spans like the terminal/code cards (every
        // text node in the sample sits in a resolved span; the doc's
        // own table lines/weights stay CSS).
        const docFonts = await page.evaluate(() => {
          const strip = (n: string): string =>
            n.replace(/["']/g, "").trim().toLowerCase();
          const card = document.querySelector<HTMLElement>(
            ".kit-sc[data-scene='document'] .kit-doc",
          );
          if (!card) return { bare: -1, resolved: -1, latins: new Set<string>(), cjk: new Set<string>() };
          let bare = 0;
          let resolved = 0;
          const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
          const latins = new Set<string>();
          const cjk = new Set<string>();
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const text = n.textContent;
            const parent = (n.parentElement ?? { tagName: "" }).tagName;
            if (parent === "SCRIPT" || parent === "STYLE") continue;
            if (text.trim() === "" && !text.includes(" ")) continue;
            // A whitespace-only text node between spans is layout
            // filler; everything else must live inside a styled span.
            if (parent !== "SPAN") bare += 1;
          }
          for (const span of card.querySelectorAll<HTMLElement>("span")) {
            const ch = span.textContent ?? "";
            if (ch.length !== 1) continue;
            resolved += 1;
            const fam = span.style.fontFamily;
            if (/[A-Za-z0-9]/.test(ch)) latins.add(strip(fam.split(",")[0] ?? ""));
            if (/[一-鿿]/.test(ch)) cjk.add(strip(fam.split(",")[0] ?? ""));
          }
          return { bare, resolved, latins: [...latins], cjk: [...cjk] };
        });
        expect(docFonts.bare, "no UI-font text nodes remain in the sample").toBe(0);
        expect(docFonts.resolved).toBeGreaterThan(80);
        expect(docFonts.latins.length).toBe(1);
        expect(docFonts.cjk.length).toBe(1);
        expect(docFonts.latins[0]).toBe(enCard);
        expect(docFonts.cjk[0]).not.toBe(enCard);
      });

      await step("J7.3 per-card theme dropdowns: 14 terminal / 10 editor palettes", async () => {
        const term = page.locator(".kit-sc[data-scene='terminal'] .kit-cselw");
        await pointerClick(page, term.locator(".kit-csel"));
        await expect(term.locator(".kit-cso")).toHaveCount(14);
        await expect(term.locator(".kit-cso").first()).toHaveText("跟随主题");
        await pointerClick(
          page,
          term.locator(".kit-cso", { hasText: "Dracula" }),
        );
        await expect(
          page.locator(".kit-sc[data-scene='terminal'] .kit-term"),
        ).toHaveAttribute("data-t", "dracula");
        const code = page.locator(".kit-sc[data-scene='code'] .kit-cselw");
        await pointerClick(page, code.locator(".kit-csel"));
        await expect(code.locator(".kit-cso")).toHaveCount(10);
        await page.keyboard.press("Escape");
      });

      await step("J7.4 fullscreen opens BELOW the top bar, chrome stays reachable", async () => {
        await pointerClick(
          page,
          page.locator(".kit-sc[data-scene='terminal'] .kit-zb"),
        );
        const fullscreen = page.locator(".kit-zf");
        await expect(fullscreen).toBeVisible();
        const bounds = await page.evaluate(() => {
          const bar = document.querySelector<HTMLElement>(".topbar")!;
          const zf = document.querySelector<HTMLElement>(".kit-zf")!;
          return {
            barBottom: bar.getBoundingClientRect().bottom,
            zfTop: zf.getBoundingClientRect().top,
          };
        });
        expect(bounds.zfTop).toBeGreaterThanOrEqual(bounds.barBottom - 0.5);
        const topHit = await page.evaluate(() => {
          const el = document.querySelector<HTMLElement>(
            ".topbar [data-role='theme-toggle']",
          )!;
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(
            r.x + r.width / 2,
            r.y + r.height / 2,
          );
          return el.contains(hit);
        });
        expect(topHit).toBe(true);
      });

      await step("J7.5 the fullscreen bar switches themes inside; prev/next swap IN PLACE", async () => {
        const zoomSelect = page.locator(".kit-zf [data-role='fullscreen-theme']");
        await expect(zoomSelect).toBeVisible();
        await pointerClick(page, zoomSelect.locator(".kit-csel"));
        await pointerClick(
          page,
          zoomSelect.locator(".kit-cso", { hasText: "Nord" }),
        );
        await expect(page.locator(".kit-zf .kit-term")).toHaveAttribute(
          "data-t",
          "nord",
        );
        // Prev/next swap content in the SAME node (no remount).
        const fullscreen = page.locator(".kit-zf");
        await fullscreen.evaluate((el) => el.setAttribute("data-marker", "alive"));
        await pointerClick(
          page,
          fullscreen.locator("button", { hasText: "下一项" }),
        );
        await expect(
          page.locator(".kit-zf[data-marker='alive'] .kit-code"),
        ).toBeVisible();
        await pointerClick(
          page,
          fullscreen.locator("button", { hasText: "上一项" }),
        );
        await expect(
          page.locator(".kit-zf[data-marker='alive'] .kit-term"),
        ).toBeVisible();
        await pointerClick(
          page,
          fullscreen.locator("[data-role='fullscreen-close']"),
        );
        await expect(page.locator(".kit-zf")).toHaveCount(0);
      });

      await step("J7.6 自定义预览文字 feeds the document card", async () => {
        const preview = page.locator(".kit-modebar [data-role='preview-text']");
        await preview.fill("旅程预览 FontAlloy 123");
        await expect(
          page.locator(".kit-sc[data-scene='document']"),
        ).toContainText("旅程预览 FontAlloy 123");
      });

      await step("J7.7 zero JS errors across the journey", assertNoJsErrors);
    });
  });

  test("J8 合成设置 — four settings, verbatim help, width chips and format in the recipe", async ({
    journeysPage: page,
  }) => {
    await journey("J8 合成设置", async (step) => {
      await step("J8.1 setup: picks made, no service (the CLI panel is the recipe surface)", async () => {
        await boot(page, "/?noservice=1"); // serveUrl null — honest absence
        await pickFlagshipPair(page);
      });

      await step("J8.2 all four settings open and change", async () => {
        // The selects carry the settings' STORE keys (weightMode /
        // baseline / cjkWidth / outputFormat — see ui/settings.ts).
        // Round 12 (owner item 7): the output format is the fourth
        // setting; its options are the formats' proper nouns.
        const cases = [
          {
            key: "weightMode",
            pick: "仅保留英文字体提供的字重",
          },
          { key: "baseline", pick: "中文字和英文底边一样高" },
          { key: "cjkWidth", pick: "1.8 倍英文宽" },
          { key: "outputFormat", pick: "WOFF2" },
        ] as const;
        for (const { key, pick } of cases) {
          const select = page.locator(`[data-role='select-${key}']`);
          await pointerClick(page, select.locator(".kit-csel"));
          await pointerClick(
            page,
            select.locator(`.kit-cso`, { hasText: pick }),
          );
          await expect(select.locator(".kit-csel")).toContainText(pick);
        }
      });

      await step("J8.3 help popovers open with the verbatim prototype content", async () => {
        // The ?-anchors carry the settings' STORE keys; the popups the
        // kit topic ids. Each topic's TITLE is its own verbatim copy
        // (settingsTopics.ts) — the baseline topic's title names the
        // setting (中英文的基线对齐) while its anchor asks the question
        // (什么是基线对齐).
        const expects: Array<[string, string, string, RegExp]> = [
          ["什么是字重", "weight", "什么是字重", /字重，就是字的笔画粗细。/],
          [
            "什么是基线对齐",
            "baseline",
            "中英文的基线对齐",
            /中文字和英文字的底边不一定在同一个高度/,
          ],
          [
            "中文字符宽度是什么",
            "cjk-width",
            "中文字符宽度是什么",
            /等宽环境里，每个字符占的位置按英文字符的宽度计算/,
          ],
          [
            "输出格式是什么",
            "output-format",
            "输出格式是什么",
            /成品的文件格式，决定体积和用途/,
          ],
        ];
        for (const [buttonLabel, popId, title, body] of expects) {
          const anchor = page.locator(
            `.settings-rows .kit-qh[aria-label='${buttonLabel}']`,
          );
          await expect(anchor).toBeVisible();
          await pointerClick(page, anchor);
          const pop = page.locator(`[data-help-popup='${popId}']`);
          await expect(pop).toBeVisible();
          await expect(pop.locator("h5")).toContainText(title);
          await expect(pop).toContainText(body);
          await page.keyboard.press("Escape");
          await expect(pop).toBeHidden();
        }
      });

      await step("J8.3b the format topic: 自动 badge + the auto popover row (round 13)", async () => {
        // Round 13 (owner item 2): the auto option carries the SAME
        // badge the sibling settings use (「默认」 where they say
        // 「推荐」) — no parenthetical anywhere — and the popover's
        // FIRST worked row explains the auto tier ahead of the three
        // format rows. The trigger currently reads WOFF2 (J8.2 left
        // it there — J8.4 resumes from that state), so the badge is
        // asserted on the option row; the closed trigger's badge has
        // its own check in the kit demo suite (fresh value = auto).
        const formatSelect = page.locator("[data-role='select-outputFormat']");
        await pointerClick(page, formatSelect.locator(".kit-csel"));
        const autoOption = formatSelect
          .locator(".kit-cso")
          .filter({ hasText: /^自动/ });
        await expect(autoOption).toHaveText(/自动 默认/);
        await expect(autoOption.locator(".kit-badge")).toHaveText("默认");
        await expect(autoOption).not.toContainText("（");
        await expect(formatSelect.locator(".kit-cso")).toHaveCount(4);
        await page.keyboard.press("Escape");
        const anchor = page.locator(
          ".settings-rows .kit-qh[aria-label='输出格式是什么']",
        );
        await pointerClick(page, anchor);
        const pop = page.locator("[data-help-popup='output-format']");
        await expect(pop).toBeVisible();
        const rows = pop.locator(".kit-wtab tbody tr");
        await expect(rows).toHaveCount(4);
        await expect(rows.first()).toContainText("自动 · 默认");
        await expect(rows.first()).toContainText(
          "单一字面基底输出 TTF；家族全字重打包为 TTC",
        );
        await expect(rows.nth(1)).toContainText("通用桌面");
        await expect(pop).not.toContainText("（默认）");
        await page.keyboard.press("Escape");
        await expect(pop).toBeHidden();
      });

      await step("J8.4 width chips select 1.8× then 1.5×; the recipe reflects it", async () => {
        // No service: the synthesize flow offers the CLI panel, whose
        // YAML is the recipe the CLI would run — the width knob shows.
        const synthesize = page.locator(".topbar [data-role='synthesize']");
        await expect(synthesize).toHaveAttribute("aria-disabled", "true");
        await pointerClick(page, synthesize);
        const panel = page.locator(".cli-panel");
        await expect(panel).toBeVisible();
        await expect(
          panel.locator("[data-testid='copy-command']"),
        ).toHaveAttribute("aria-disabled", "false");
        const yaml = panel.locator("[data-testid='recipe-yaml']");
        await expect(yaml).toContainText("width_factor: 1.8");
        // Switch to 1.5× — the recipe follows.
        const select = page.locator("[data-role='select-cjkWidth']");
        await pointerClick(page, select.locator(".kit-csel"));
        await pointerClick(
          page,
          select.locator(".kit-cso", { hasText: "1.5 倍英文宽" }),
        );
        await expect(yaml).toContainText("width_factor: 1.5");
        // Back to the 2× default: the knob disappears from the YAML
        // (round 11: the label reads 2 倍英文宽, matching its siblings).
        await pointerClick(page, select.locator(".kit-csel"));
        await pointerClick(
          page,
          select.locator(".kit-cso", { hasText: "2 倍英文宽" }),
        );
        await expect(yaml).not.toContainText("width_factor");
        // Round 12 (owner item 7): the output-format setting rides the
        // recipe's output.format — J8.2 left it at WOFF2, so the YAML
        // names woff2; back on TTF the YAML reads ttf again. Round 13
        // (owner item 2): the TTF option label is the bare proper noun
        // — the 默认 badge moved onto 自动 — so the row is matched by
        // its exact text (the auto row's description also names TTF).
        await expect(yaml).toContainText("format: woff2");
        const formatSelect = page.locator("[data-role='select-outputFormat']");
        await pointerClick(page, formatSelect.locator(".kit-csel"));
        await pointerClick(
          page,
          formatSelect.locator(".kit-cso").filter({ hasText: /^TTF$/ }),
        );
        await expect(yaml).toContainText("format: ttf");
      });

      await step("J8.5 zero JS errors across the journey", assertNoJsErrors);
    });
  });

  test("J9 合成 — the real serve: stages, report, parseable artifact, queue", async ({
    journeysPage: page,
  }) => {
    // Round 12 (owner item 8) + round-13 economy: the flagship pair
    // builds a multi-slot weight matrix packaged as ttc. The journey
    // narrows the submitted pattern to a 2-face slice (route below)
    // for speed; the full-matrix behavior is pinned by synthesize.spec
    // on fixtures. The journey budget is the moderate one.
    test.setTimeout(600_000);
    // The owner's real serve layout: the repo's own serve binary over
    // the fetched catalog directory (zips + extracted faces + its own
    // manifest), so the catalog picks resolve as catalog-family
    // references — the production build path. (spawnServeOverFonts's
    // `url` field is the startup-line PROMISE — unlike the fixture
    // helper, it does not await it internally — so await it here or
    // encodeURIComponent would stringify the promise object.)
    const service = await spawnServeOverFonts(RUN_FONTS, [
      "--manifest",
      RUN_MANIFEST,
    ]);
    const serviceUrl = await service.url;
    // Verification economy (owner, round 13): the app really submits the
    // FULL family cut (16 faces ≈ 8 min of grafting); the full-matrix
    // behavior is separately pinned by synthesize.spec's multi-slot test
    // on fixtures. This journey narrows ONLY the submitted pattern to a
    // two-face slice (Medium + MediumItalic) so the production path
    // (catalog-family ref + pattern → ttc multi-slot) stays covered at
    // journey speed.
    await page.route(
      /\/builds$/,
      async (route) => {
        const req = route.request();
        if (req.method() !== "POST") return route.continue();
        const body = req.postDataJSON();
        if (body?.base?.pattern?.includes("*")) {
          body.base.pattern = "JetBrainsMonoNerdFont-M*.ttf";
        }
        return route.continue({ postData: JSON.stringify(body) });
      },
    );
    currentSaveDir = await mkdtemp(resolve(tmpdir(), "fontalloy-j9-save-"));
    dialogSaveCalls = 0;
    try {
      await journey("J9 合成", async (step) => {
        await step("J9.1 the serve is detected; the action arms once both picks exist", async () => {
          await boot(page, `/?serve=${encodeURIComponent(serviceUrl)}`);
          await pickFlagshipPair(page);
          const synthesize = page.locator(".topbar [data-role='synthesize']");
          await expect(synthesize).toHaveAttribute("aria-disabled", "false");
        });

        await step("J9.2 the build runs the 7 report-copy stages to 完成 + 已保存", async () => {
          const synthesize = page.locator(".topbar [data-role='synthesize']");
          await pointerClick(page, synthesize);
          const panel = page.locator('[data-testid="build-panel"]');
          await expect(panel).toBeVisible();
          const stageNames = [
            "读取字体",
            "规划字重",
            "解析规则",
            "移植字形",
            "改写名称表",
            "保存输出",
            "生成报告",
          ];
          const stepLabels = await panel
            .locator(".build-step")
            .evaluateAll((dots) =>
              dots.map((dot) => (dot as HTMLElement).title),
            );
          expect(stepLabels).toEqual(stageNames);
          const stage = panel.locator("[data-build-stage]").first();
          await expect(stage).toHaveText(
            /(正在合成|读取字体|规划字重|解析规则|移植字形|改写名称表|保存输出|生成报告|完成)/,
          );
          // Round 12 (owner item 1): the stage line is TWO lines — the
          // stage name line with the dim note line UNDER it, never one
          // dash-joined 「name — note」 line. Catch it while a stage is
          // actually current (the reserved two-line block keeps the
          // rows underneath still).
          const stageLine = panel.locator("[data-build-stage-line]").first();
          await expect(stageLine).toBeVisible();
          await expect(
            stageLine.locator("[data-build-stage-name]"),
          ).not.toBeEmpty();
          await expect(
            stageLine.locator("[data-build-stage-note]"),
          ).not.toBeEmpty();
          // Round 13 (owner item 5): living progress — the elapsed
          // timer (mm:ss, ticking) renders in the live column opposite
          // the two-line stage copy while the build runs.
          await expect(
            stageLine.locator("[data-build-elapsed]"),
          ).toHaveText(/用时 \d+:\d{2}/);
          // Round 10 (no flicker), round 11 (content sizing): sample
          // the panel's clientHeight and the rows region's scrollbar
          // state every frame while the real build walks its stages —
          // the poll must never move the height frame to frame. The
          // panel is content-sized now, so ONE real transition is
          // sanctioned (the row settling); an oscillation (A→B→A) or a
          // scrollbar toggle is the flicker class that must stay dead.
          await page.evaluate(() => {
            const record = { samples: [] as string[], done: false };
            (window as unknown as { __panelSamples: typeof record })
              .__panelSamples = record;
            const panelEl = document.querySelector('[data-testid="build-panel"]')!;
            const rows = panelEl.querySelector(".build-rows")!;
            const started = performance.now();
            const tick = (): void => {
              record.samples.push(
                `${panelEl.clientHeight}:${rows.scrollHeight > rows.clientHeight ? 1 : 0}`,
              );
              if (performance.now() - started < 10_000) requestAnimationFrame(tick);
              else record.done = true;
            };
            tick();
          });
          await expect(stage).toHaveText("完成", { timeout: 900_000 });
          await expect(panel).toContainText("已保存");
          // Round 12 (owner item 3): the automatic save is DIALOG-FREE
          // — the default-path seam landed the font and the 另存为
          // dialog seam was never touched.
          expect(dialogSaveCalls).toBe(0);
          // Round 13 (owner item 4): the saved line is TWO rows — the
          // 「已保存」 label on its own first row, the FULL path on the
          // row under it (middle-ellipsized when it overflows; the
          // whole path rides the title attribute). The completed row
          // offers the 另存为 affordance.
          const savedBlock = panel.locator("[data-build-saved]").first();
          await expect(
            savedBlock.locator("[data-build-saved-label]"),
          ).toHaveText("已保存");
          const savedLine = page.locator("[data-build-saved-path]").first();
          // Round 12's family-matrix artifact is the ttc collection
          // (J9.5 below parses it); a round-13 merge left these two
          // lines pinning the stale single-slot .ttf name — corrected
          // in round 14 with the pick-pattern fix that keeps the
          // journey's pair a family build.
          await expect(savedLine).toHaveAttribute(
            "title",
            /.+[\\/]ChHsich\.ttc$/,
          );
          await expect(savedLine).toHaveText(/ChHsich\.ttc$/);
          await expect(
            panel.locator("[data-build-saveas]").first(),
          ).toBeVisible();
          await page.waitForFunction(
            () =>
              (window as unknown as { __panelSamples: { done: boolean } })
                .__panelSamples.done,
          );
          const ledger = await page.evaluate(
            () =>
              (window as unknown as { __panelSamples: { samples: string[] } })
                .__panelSamples.samples,
          );
          expect(ledger.length).toBeGreaterThan(120);
          const heights = ledger.map((s) => Number(s.split(":")[0]));
          const changes = heights.filter((h, i) => i > 0 && h !== heights[i - 1]);
          expect(changes.length).toBeLessThanOrEqual(1);
          expect(ledger.some((s) => s.endsWith(":1"))).toBe(false);
          // Round 10: the vertical journal list is gone — the stepper
          // is the progress.
          await expect(panel.locator("[data-build-journal]")).toHaveCount(0);
        });

        await step("J9.3 the report renders under the real-term nouns", async () => {
          const panel = page.locator('[data-testid="build-panel"]');
          // Round 10: the settled row stays calm — the report sits
          // behind the 查看报告 disclosure (saved line first).
          const disclosure = panel.locator(".report-details > summary");
          await expect(disclosure).toHaveText("查看报告");
          await pointerClick(page, disclosure);
          for (const label of [
            "验证报告",
            "成品文件",
            "输出格式",
            "SHA-256 校验值",
            "来源字体",
            "合并统计",
            "参与合并的码位",
            "英文字体提供",
            "中文字体补充",
            "成品收录",
            "规则优先级",
            "覆盖检查",
            "要求覆盖",
            "实际覆盖",
            "缺失",
            "字体尺寸对比",
            "UPM",
            "英文宽度",
            "中文宽度",
            "中英宽度比",
            "行高保持不变",
            "字重档位",
          ]) {
            await expect(panel).toContainText(label);
          }
          // Round 13 (owner item 6): the metrics section is a real
          // TABLE — the 合并前 / 合并后 data columns stated ONCE in a
          // header row, values column-aligned, and zero · separators
          // anywhere in it.
          const metricsTable = panel.locator(".report-mtable").first();
          await expect(metricsTable).toBeVisible();
          const columnHeaders = (
            await metricsTable.locator("thead th").allTextContents()
          ).filter((h) => h === "合并前" || h === "合并后");
          expect(columnHeaders).toEqual(["合并前", "合并后"]);
          await expect(metricsTable).not.toContainText("·");
          // Round 12 (owner item 4): the borrow row reads the ratified
          // 成品档位 ← 来源字体 order — the output weight LEFT of the
          // arrow, the source font right of it, the via qualifier
          // after · (never the inverted family-first form, never a
          // dash join).
          await expect(panel).toContainText(
            /\d+ ← .+ · (自动取最近|指定字重|锁定)/,
          );
          await expect(panel).not.toContainText(/← \d+（/);
          // Round 12 (owner item 1): NO dash-joins anywhere in the
          // panel — nothing relies on an em-dash to separate.
          await expect(panel).not.toContainText("—");
          // Round 11 (terminology ruling): user-facing copy never says
          // 基底 or 供体 — those stay in the machine layer only.
          await expect(panel).not.toContainText("基底");
          await expect(panel).not.toContainText("供体");
          // Round 9 (owner item 2): the 来源字体 names read the font
          // file's OWN name-table string (「Maple Mono CN」), never the
          // raw file name or a curated/hardcoded display name. Round
          // 11 (owner item 2): with the single donor the rows carry
          // the real names as their labels — no role word, no number.
          await expect(panel).toContainText("Maple Mono CN");
          // Round 10: the raw JSON form is gone from the UI.
          await expect(panel).not.toContainText("fontalloy/verification-report");
          // Round 12 (owner item 8) + round-13 economy: the pattern
          // slice above yields the Medium pair (500 · 直立 + 500 · 斜
          // 体) — the multi-slot matrix semantics (every listed face
          // becomes an output slot, nearest-weight borrows, ttc
          // packaging) stay asserted; the FULL 16-slot enumeration is
          // pinned by synthesize.spec's fixture multi-slot test.
          const weightSection = panel
            .locator(".report-section")
            .filter({ hasText: "字重档位" });
          await expect(weightSection).toBeVisible();
          const slotLabels = await weightSection
            .locator(".report-fact-label")
            .evaluateAll((labels) =>
              labels.map((label) => (label as HTMLElement).textContent),
            );
          expect(slotLabels).toHaveLength(2);
          expect(new Set(slotLabels)).toEqual(
            new Set(["500 · 直立", "500 · 斜体"]),
          );
          await expect(weightSection).toContainText(
            /\d+ ← Maple Mono NF CN · 自动取最近/,
          );
          // The output is the family collection, not a single face.
          await expect(panel).toContainText("ttc（多字体合集）");
        });

      await step("J9.4 one ? per section heading, centered, popover above the panel", async () => {
          const panel = page.locator('[data-testid="build-panel"]');
          // Exactly ONE ? per section heading (the report heading
          // included); the fact lines carry none.
          const headings = panel.locator(".report-heading, .report-section-title");
          expect(await headings.count()).toBeGreaterThanOrEqual(7);
          for (const heading of await headings.all()) {
            expect(await heading.locator(".kit-qh").count()).toBe(1);
          }
          expect(await panel.locator(".report-fact .kit-qh").count()).toBe(0);
          // The circles sit optically centered with their heading text.
          const offsets = await panel.evaluate(() => {
            const center = (el: Element): number => {
              const r = el.getBoundingClientRect();
              return (r.top + r.bottom) / 2;
            };
            return [...document.querySelectorAll(
              '[data-testid="build-panel"] .report-heading, [data-testid="build-panel"] .report-section-title',
            )].map((h) => Math.abs(center(h.firstElementChild!) - center(h.lastElementChild!)));
          });
          expect(Math.max(...offsets)).toBeLessThanOrEqual(2);
          // EVERY ? opens a popover that stacks above the panel — the
          // topmost element at its center is the popover itself, never
          // the panel (the owner's covered-popover defect).
          for (const anchor of await panel.locator(".kit-qh").all()) {
            await pointerClick(page, anchor);
            const pop = page.locator(".kit-pop.open");
            await expect(pop).toBeVisible();
            const hit = await page.evaluate(() => {
              const open = document.querySelector(".kit-pop.open")!;
              const r = open.getBoundingClientRect();
              const el = document.elementFromPoint(
                r.left + r.width / 2,
                r.top + r.height / 2,
              );
              return {
                hitsPopover: el !== null && el.closest(".kit-pop") !== null,
                hitsPanel: el !== null && el.closest(".build-panel") !== null,
              };
            });
            expect(hit.hitsPopover).toBe(true);
            expect(hit.hitsPanel).toBe(false);
            await page.keyboard.press("Escape");
            await expect(pop).toBeHidden();
          }
        });

        await step("J9.5 the saved artifact PARSES: family ChHsich, cmap > 0, donor CJK inside", async () => {
          // V2's dedicated path locator; V3's family-matrix .ttc
          // expectation (catalog family picks package the collection).
          // Round 13 (owner item 4): the full path lives in the title
          // attribute (the visible line middle-ellipsizes deep paths).
          const savedLine = page.locator("[data-build-saved-path]").first();
          await expect(savedLine).toContainText(/\.ttc$/);
          const savedPath = (await savedLine.getAttribute("title"))!;
          const parsed = await parseBuiltFont(savedPath.trim());
          expect(parsed.family).toBe("ChHsich");
          expect(parsed.cmap).toBeGreaterThan(0);
          expect(
            parsed.cjkCodepoints,
            "the donor's CJK codepoints must live in the built font",
          ).toBeGreaterThan(0);
          // Round 12 (owner item 3): 另存为 on the completed row routes
          // through the DIALOG seam — the completion line moves to the
          // chosen location and the as- copy parses too.
          await pointerClick(
            page,
            page.locator("[data-build-saveas]").first(),
          );
          await expect(savedLine).toHaveText(/as-ChHsich\.ttf$/, {
            timeout: 30_000,
          });
          expect(dialogSaveCalls).toBe(1);
        });

        await step("J9.6 a second build queues while the first owns the worker", async () => {
          // Row 0 is J9.2's settled matrix build; the two clicks below
          // append rows 1 (starts on the free worker) and 2 (queues).
          const synthesize = page.locator(".topbar [data-role='synthesize']");
          await pointerClick(page, synthesize);
          const running = page.locator("[data-build-stage]").nth(1);
          await expect(running).toHaveText(
            /(排队中|正在合成|读取字体)/,
            { timeout: 10_000 },
          );
          await pointerClick(page, synthesize);
          const queued = page.locator("[data-build-stage]").nth(2);
          // The serve runs builds serially: row 1 owns the worker
          // (a running stage, never the queue), row 2 reads 排队中.
          await expect(running).toHaveText(
            /正在合成|读取字体|规划字重|解析规则|移植字形|改写名称表|保存输出|生成报告/,
            { timeout: 30_000 },
          );
          await expect(queued).toHaveText(/排队中/, { timeout: 30_000 });
          // The handoff: row 1's family matrix completes, and the queued
          // build then LEAVES the queue and starts. Waiting for the
          // queued matrix to fully settle would double the journey's
          // multi-minute build cost for no additional queue semantics.
          await expect(running).toHaveText("完成", { timeout: 900_000 });
          await expect(queued).toHaveText(
            /正在合成|读取字体|规划字重|解析规则|移植字形|改写名称表|保存输出|生成报告|完成/,
            { timeout: 900_000 },
          );
        });

        await step("J9.7 zero JS errors across the journey", assertNoJsErrors);
      });
    } finally {
      await service.dispose();
      currentSaveDir = null;
    }
  });

  test("J10 主题 — the 自动→浅→深 cycle, icon honesty, persistence", async ({
    journeysPage: page,
  }) => {
    await journey("J10 主题", async (step) => {
      const toggle = () => page.locator(".topbar [data-role='theme-toggle']");
      const mode = async () =>
        (await toggle().getAttribute("data-theme-mode")) ?? "";
      const effective = () =>
        page.evaluate(() => document.documentElement.dataset.theme ?? "");

      await step("J10.1 boot: the persisted preference drives the mode", async () => {
        await boot(page);
        expect(["auto", "light", "dark"]).toContain(await mode());
      });

      await step("J10.2 the cycle walks 自动→浅色→深色→back; the icon tracks the EFFECTIVE theme", async () => {
        const cycle = ["auto", "light", "dark"] as const;
        const start = await mode();
        const startIdx = cycle.indexOf(start as (typeof cycle)[number]);
        const lightShot = { html: "", theme: "" };
        const darkShot = { html: "", theme: "" };
        for (let n = 1; n <= 3; n++) {
          await pointerClick(page, toggle());
          await page.waitForTimeout(150); // the two-frame .theming guard
          const expectedMode = cycle[(startIdx + n) % 3];
          expect(await mode()).toBe(expectedMode);
          if (expectedMode === "light") {
            lightShot.html = await toggle().evaluate((el) => el.innerHTML);
            lightShot.theme = await effective();
            expect(await effective()).toBe("light");
            expect(await toggle().locator(".kit-theme-auto").count()).toBe(0);
          }
          if (expectedMode === "dark") {
            darkShot.html = await toggle().evaluate((el) => el.innerHTML);
            darkShot.theme = await effective();
            expect(await effective()).toBe("dark");
            expect(await toggle().locator(".kit-theme-auto").count()).toBe(0);
          }
          if (expectedMode === "auto") {
            expect(await toggle().locator(".kit-theme-auto").count()).toBe(1);
          }
        }
        expect(await mode()).toBe(start); // a full cycle returns home
        // The icon is the EFFECTIVE theme's (sun in light, moon in dark).
        expect(lightShot.html).not.toBe(darkShot.html);
        expect(lightShot.theme).toBe("light");
        expect(darkShot.theme).toBe("dark");
      });

      await step("J10.3 the preference and its effective theme persist across reload", async () => {
        const start = await mode();
        await page.reload();
        await waitForFontsReady(page);
        await expect(page.locator(".workspace-rail")).toBeVisible();
        expect(await mode()).toBe(start);
        if (start === "dark") {
          expect(await effective()).toBe("dark");
        }
        if (start === "light") {
          expect(await effective()).toBe("light");
        }
      });

      await step("J10.4 zero JS errors across the journey", assertNoJsErrors);
    });
  });
});
