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

const test = base.extend<{ journeysPage: Page }>({
  journeysPage: [
    async ({}, use) => {
      const userDataDir = mkdtempSync(
        resolve(tmpdir(), "fontalloy-journey-profile-"),
      );
      const context = await chromium.launchPersistentContext(userDataDir, {
        baseURL: "http://localhost:5173",
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
      // bytes land in the CURRENT journey's temp dir).
      await page.exposeFunction(
        "__fontalloyJourneySave",
        async (name: string, bytesB64: string): Promise<string | null> => {
          if (currentSaveDir === null) return null;
          const target = resolve(currentSaveDir, name);
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
        config.saveArtifact = async (
          name: string,
          bytes: Uint8Array,
        ): Promise<{ saved: boolean; path: string | null }> => {
          const b64 = btoa(
            Array.from(bytes, (b) => String.fromCharCode(b)).join(""),
          );
          const path = await (
            window as unknown as {
              __fontalloyJourneySave(
                name: string,
                b64: string,
              ): Promise<string | null>;
            }
          ).__fontalloyJourneySave(name, b64);
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
 * Maple row narrowed to its NF-CN variant THROUGH THE 等宽 CHIP (round
 * 7's typed variant chips — the chip resolves to the manifest's
 * MapleMono/NF-CN entry, not the plain row default).
 */
async function pickFlagshipPair(page: Page): Promise<void> {
  await pickCatalogRow(page, "en", "JetBrains Mono", /JetBrains/);
  await openPicker(page, "cjk");
  const mapleRow = pickerRow(page, "cjk", "Maple Mono CN");
  const monoChip = mapleRow.locator(".kit-vchip[data-chip='cjk_width:mono']");
  await expect(monoChip).toBeVisible();
  await rawClick(page, monoChip);
  await waitForFontsReady(page);
  await expect(
    page.locator("[data-role='font-pair'] [data-pair='donor']"),
  ).toHaveText(/Maple Mono/, { timeout: 20_000 });
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

/** Parse a built font with fontTools: family, cmap size, CJK presence. */
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
      "font = TTFont(sys.argv[1])",
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
        const row = pickerRow(page, "en", "JetBrains Mono");
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
        await rawClick(page, pickerRow(page, "en", "JetBrains Mono"));
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
        for (const name of ["Maple Mono CN", "霞鹜文楷"]) {
          await expect(pickerRow(page, "cjk", name)).toBeVisible();
        }
      });

      await step("J2.5 variant chips visible on multi-variant families (Maple 宽度, HackGen NF)", async () => {
        const maple = pickerRow(page, "cjk", "Maple Mono CN");
        await expect(
          maple.locator(".kit-vchip[data-chip='cjk_width:mono']"),
        ).toBeVisible(); // 等宽
        await expect(
          maple.locator(".kit-vchip[data-chip='cjk_width:prop']"),
        ).toBeVisible(); // 比例 (the default cut)
        const hackgen = pickerRow(page, "cjk", "HackGen");
        if ((await hackgen.count()) > 0) {
          await expect(
            hackgen.locator(".kit-vchip[data-chip='icons:nf']"),
          ).toBeVisible(); // NF图标
        }
      });

      await step("J2.6 pick Maple Mono NF-CN via the 等宽 chip → the donor pair tag", async () => {
        const mapleRow = pickerRow(page, "cjk", "Maple Mono CN");
        await rawClick(
          page,
          mapleRow.locator(".kit-vchip[data-chip='cjk_width:mono']"),
        );
        await waitForFontsReady(page);
        await expect(
          page.locator("[data-role='font-pair'] [data-pair='donor']"),
        ).toHaveText(/Maple Mono/, { timeout: 20_000 });
        await page.keyboard.press("Escape");
        await expect(pickerPopup(page, "cjk")).toBeHidden();
      });

      await step("J2.7 the rail carries both identity cards, self-rendered", async () => {
        for (const role of ["en", "cjk"] as const) {
          const name = page.locator(
            `[data-role='picker-${role}'] .kit-hd .kit-hdc b`,
          );
          await expect(name).toBeVisible();
          await expect(name).not.toBeEmpty();
          const family = await name.evaluate((el) => el.style.fontFamily);
          expect(family.length).toBeGreaterThan(0); // rendered in its own face
        }
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

      await step("J4.8 zero JS errors across the journey", assertNoJsErrors);
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
          /单个字符1/,
        );
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
      });

      await step("J5.5 按编码指定 accepts a range, a single codepoint, rejects garbage", async () => {
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
        await expect(rangeRow).toContainText("A 至 E");
        await expect(rangeRow.locator(".kit-us")).toContainText(
          "U+0041 至 U+0045",
        );
        // A single codepoint (end left empty = single).
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

      await step("J5.6 zero JS errors across the journey", assertNoJsErrors);
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

      await step("J6.2 block chips assign: 用中文 on 基本拉丁 dots the declared side", async () => {
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
        await expect(cell).toHaveClass(/ov/); // declared ≠ default → the dot
        await expect(
          page.locator("[data-role='rule-row'][data-kind='block']").first(),
        ).toContainText("基本拉丁用中文字体");
      });

      await step("J6.3 group chips assign incl. the CJK group; declared-side dots appear", async () => {
        await pointerClick(page, page.locator(".kit-cat-g[data-group='cjk']"));
        const groupRow = page
          .locator(".kit-toolrow")
          .filter({ hasText: "所有中日韩文字字符" });
        await expect(groupRow).toBeVisible();
        const cell = page.locator(
          ".charmap-grid .kit-cell[data-cp='U+3001']",
        );
        // The DEFAULT side (全用中文) already matches the effective
        // outcome — the assignment is an idempotent no-op (charmap
        // drops exact block rules and writes nothing): the cell keeps
        // its no-rule "default" via and carries no dot.
        await pointerClick(
          page,
          groupRow.locator(".kit-mseg button", { hasText: /^全用中文$/ }),
        );
        await expect(cell).toHaveAttribute("data-via", "default");
        await expect(cell).not.toHaveClass(/ov/);
        // …the declared-OTHER side (全用英文) writes the rule with its
        // declared-side dot. The BASE lacks the glyph (JetBrains Mono
        // has no CJK punctuation), so absence-never-overrides fills the
        // slot from the donor — the WINNER stays donor-0, but the rule
        // now owns the codepoint (via) and the declared≠default dot
        // (ov) tells the truth.
        await pointerClick(
          page,
          groupRow.locator(".kit-mseg button", { hasText: /^全用英文$/ }),
        );
        await expect(cell).toHaveAttribute("data-via", /rule-\d+/);
        await expect(cell).toHaveClass(/ov/);
        expect(
          num(await page.locator("[data-stat='adjusted']").textContent()),
        ).toBeGreaterThan(0);
        await expect(
          page.locator("[data-role='rule-row'][data-kind='group']").first(),
        ).toContainText("所有中日韩文字字符用英文字体");
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

  test("J8 合成设置 — three settings, verbatim help, width chips in the recipe", async ({
    journeysPage: page,
  }) => {
    await journey("J8 合成设置", async (step) => {
      await step("J8.1 setup: picks made, no service (the CLI panel is the recipe surface)", async () => {
        await boot(page, "/?noservice=1"); // serveUrl null — honest absence
        await pickFlagshipPair(page);
      });

      await step("J8.2 all three settings open and change", async () => {
        // The selects carry the settings' STORE keys (weightMode /
        // baseline / cjkWidth — see ui/settings.ts).
        const cases = [
          {
            key: "weightMode",
            pick: "仅保留英文字体提供的字重",
          },
          { key: "baseline", pick: "中文字和英文底边一样高" },
          { key: "cjkWidth", pick: "1.8 倍英文宽" },
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
        // Back to the 2× default: the knob disappears from the YAML.
        await pointerClick(page, select.locator(".kit-csel"));
        await pointerClick(
          page,
          select.locator(".kit-cso", { hasText: "两倍英文宽" }),
        );
        await expect(yaml).not.toContainText("width_factor");
      });

      await step("J8.5 zero JS errors across the journey", assertNoJsErrors);
    });
  });

  test("J9 合成 — the real serve: stages, report, parseable artifact, queue", async ({
    journeysPage: page,
  }) => {
    test.setTimeout(900_000);
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
    currentSaveDir = await mkdtemp(resolve(tmpdir(), "fontalloy-j9-save-"));
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
          await expect(stage).toHaveText("完成", { timeout: 300_000 });
          await expect(panel).toContainText("已保存");
        });

        await step("J9.3 the report renders under the real-term nouns", async () => {
          const panel = page.locator('[data-testid="build-panel"]');
          for (const label of [
            "验证报告",
            "输出格式",
            "SHA-256 校验值",
            "来源字体",
            "合并统计",
            "参与合并的码位",
            "基底提供",
            "供体补充",
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
        });

      await step("J9.4 the report's nouns carry their ?-popovers (X 是什么)", async () => {
        const anchor = page.locator(
          '[data-testid="build-panel"] [data-role="help-upem"]',
        );
        await expect(anchor).toBeVisible();
        await pointerClick(page, anchor);
        const pop = page.locator("[data-help-popup='upem']");
        await expect(pop).toBeVisible();
        await expect(pop).toContainText("字体坐标系的刻度");
        await page.keyboard.press("Escape");
        await expect(pop).toBeHidden();
      });

        await step("J9.5 the saved artifact PARSES: family ChHsich, cmap > 0, donor CJK inside", async () => {
          const savedLine = page.locator("[data-build-saved]").first();
          await expect(savedLine).toContainText(/\.ttf$/);
          const savedPath = (await savedLine.textContent())!.replace(
            /^已保存：/,
            "",
          );
          const parsed = await parseBuiltFont(savedPath.trim());
          expect(parsed.family).toBe("ChHsich");
          expect(parsed.cmap).toBeGreaterThan(0);
          expect(
            parsed.cjkCodepoints,
            "the donor's CJK codepoints must live in the built font",
          ).toBeGreaterThan(0);
        });

        await step("J9.6 a second build queues while the first owns the worker", async () => {
          const synthesize = page.locator(".topbar [data-role='synthesize']");
          await pointerClick(page, synthesize);
          const firstStage = page
            .locator("[data-build-stage]")
            .first();
          // Fire the second build immediately: the serve runs builds
          // serially, so the second row must read 排队中 first.
          await pointerClick(page, synthesize);
          const secondStage = page.locator("[data-build-stage]").nth(1);
          await expect(secondStage).toHaveText(/排队中|正在合成|读取字体/, {
            timeout: 10_000,
          });
          // Both settle to 完成.
          await expect(firstStage).toHaveText("完成", { timeout: 300_000 });
          await expect(secondStage).toHaveText("完成", { timeout: 300_000 });
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
