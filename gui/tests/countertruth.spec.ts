import { test, expect, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoJsErrors,
  collectJsErrors,
  pointerClick,
  waitForFontsReady,
} from "./helpers";
import { spawnServeOverFonts } from "./serve";
import { buildServeCatalogSite } from "./catalog-serve-site";
import {
  BROWSE_UNIVERSE,
  CJK_UNIVERSE,
  browseUniverseSize,
} from "../src/unicode/universe";

/**
 * Round 21 (owner item 4): the status-bar counters PROVEN against an
 * independently computed ground truth — no eyeballing.
 *
 * The pair is REAL and goes through the app's real pick path (the
 * catalog fixture harness over real binaries: a real JetBrainsMono
 * Nerd Font face in the EN slot, a real Maple Mono CN face in the CJK
 * slot — the staged T12 verification donor wherever the dev catalog's
 * WenKai face is absent). The ground truth is computed in node, OUTSIDE the app's
 * counting code path: gui/scripts/counter_truth.py reads the very same
 * font files with fontTools and applies the same effective-coverage
 * spec the GUI's sfnt reader defines (best cmap subtable by the
 * platform/encoding/format precedence, glyph-0 mappings absent,
 * .notdef-outline and mass-duplication placeholders read as missing).
 *
 * The universe/region DEFINITIONS are shared (imported from
 * src/unicode/universe.ts — the definitions ARE the spec under test);
 * the COUNTING is not: this spec unions the fontTools coverages,
 * intersects with the universe, and splits by region with its own
 * interval walks, then requires every counter — 字符 / 英文 / 中文 /
 * 缺失 / 覆盖率 (and 已调整, pinned 0: no non-preset rule exists) — to
 * equal the ground truth EXACTLY, under all three pick states (lone
 * EN, lone CJK, the pair) so the union and both region arms are each
 * exercised alone and together.
 */

/* ---------- the real pair (same discovery as helpers.ts) ---------- */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");

/**
 * Locate the two real catalog binaries (font binaries never enter git).
 * The CJK slot accepts the staged donor of the T12 verification layout
 * (MapleMonoCN-Regular.ttf — internally 「Maple Mono NF CN」) wherever
 * the dev catalog's WenKai face is absent; the ground truth reads the
 * actual file either way, so the counters are pinned against whatever
 * pair is really served.
 */
function realFontPaths(): { en: string; cjk: string } {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "../..");
  const candidates = [
    process.env.FONTALLOY_DEV_FONT_DIR,
    resolve(repoRoot, "..", "fontalloy", "gui", "prototype", "fonts"),
    resolve(repoRoot, "gui", "prototype", "fonts"),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  for (const dir of candidates) {
    const en = resolve(dir, "JetBrainsMonoNerdFont-Regular.ttf");
    for (const cjkName of ["LXGWWenKai-Regular.ttf", "MapleMonoCN-Regular.ttf"]) {
      const cjk = resolve(dir, cjkName);
      if (existsSync(en) && existsSync(cjk)) return { en, cjk };
    }
  }
  throw new Error(
    "the real catalog fonts were not found (tried " +
      candidates.map((p) => `"${p}"`).join(", ") +
      ") — set FONTALLOY_DEV_FONT_DIR to the dev-catalog font directory",
  );
}

/* ---------- the independent ground truth ---------- */

interface FontTruth {
  family: string;
  display: string;
  /** Mapped codepoints of the chosen cmap subtable (glyph 0 dropped). */
  raw: number;
  /** Effective coverage after the placeholder rules. */
  effective: number;
  codepoints: number[];
}

/** fontTools truth per font file, computed once per worker. */
const truthCache = new Map<string, FontTruth>();

function fontTruth(path: string): FontTruth {
  const cached = truthCache.get(path);
  if (cached) return cached;
  const python = process.env.FONTALLOY_PYTHON ?? "python";
  const run = spawnSync(
    python,
    [resolve(REPO_ROOT, "gui/scripts/counter_truth.py"), path],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (run.status !== 0 || run.error) {
    throw new Error(
      `counter_truth.py failed for ${path}: ${run.error ?? ""}${
        run.stderr ?? ""
      }`,
    );
  }
  const truth = (JSON.parse(run.stdout) as Record<string, FontTruth>)[path]!;
  if (truth === undefined) throw new Error(`no truth emitted for ${path}`);
  truthCache.set(path, truth);
  return truth;
}

/** Membership in sorted disjoint intervals — this spec's own walk. */
function inIntervals(
  intervals: ReadonlyArray<readonly [number, number]>,
  cp: number,
): boolean {
  let lo = 0;
  let hi = intervals.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end] = intervals[mid]!;
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return true;
  }
  return false;
}

interface GroundTruth {
  total: number;
  en: number;
  cjk: number;
  missing: number;
  coverage: string;
}

/**
 * The counters' expected values for one pick state: the union of the
 * picks' fontTools coverages intersected with the browsed universe,
 * split by the CJK script region — 字符 = 英文 + 中文 + 缺失 by
 * construction, missing = universe − union.
 */
function groundTruth(picks: FontTruth[]): GroundTruth {
  const covered = new Set<number>();
  for (const pick of picks) {
    for (const cp of pick.codepoints) {
      if (inIntervals(BROWSE_UNIVERSE, cp)) covered.add(cp);
    }
  }
  let en = 0;
  let cjk = 0;
  for (const cp of covered) {
    if (inIntervals(CJK_UNIVERSE, cp)) cjk++;
    else en++;
  }
  const total = browseUniverseSize();
  const missing = total - en - cjk;
  expect(missing, "the union cannot exceed the universe").toBeGreaterThanOrEqual(0);
  return {
    total,
    en,
    cjk,
    missing,
    coverage: ((100 * (en + cjk)) / total).toFixed(2),
  };
}

/** Print one state's ground-truth row for the run log. */
function logTruth(state: string, picks: FontTruth[], truth: GroundTruth): void {
  const fmt = (n: number): string => n.toLocaleString("en-US");
  for (const pick of picks) {
    console.log(
      `[countertruth]   font ${pick.display}: raw cmap ${fmt(pick.raw)}, effective ${fmt(pick.effective)}`,
    );
  }
  console.log(
    `[countertruth] ${state.padEnd(8)} 字符 ${fmt(truth.total)} | 英文 ${fmt(
      truth.en,
    )} | 中文 ${fmt(truth.cjk)} | 缺失 ${fmt(truth.missing)} | 覆盖率 ${truth.coverage}%`,
  );
}

/* ---------- app-side helpers ---------- */

/** Every counter in the status bar, asserted against the ground truth. */
async function assertCounters(page: Page, truth: GroundTruth): Promise<void> {
  const fmt = (n: number): string => n.toLocaleString("en-US");
  // Ticket #35: the counters read the landed serve documents — the
  // real pair's first resolve is fontTools-cold, so anchor generously
  // (design.spec's contract), not at the 5s expect default.
  const landed = { timeout: 60_000 };
  await expect(page.locator("[data-stat='total']")).toHaveText(
    fmt(truth.total),
    landed,
  );
  // Ticket #36 restored the counters: the registry records carry the
  // serve's run-length coverage intervals, so 英文/中文/缺失/覆盖率 are
  // interval arithmetic over the scan data — proven against the same
  // fontTools ground truth as before (the pick path stays byte-free).
  await expect(page.locator("[data-stat='en']")).toHaveText(
    fmt(truth.en),
    landed,
  );
  await expect(page.locator("[data-stat='cjk']")).toHaveText(
    fmt(truth.cjk),
    landed,
  );
  await expect(page.locator("[data-stat='missing']")).toHaveText(
    fmt(truth.missing),
    landed,
  );
  await expect(page.locator("[data-stat='coverage']")).toHaveText(
    truth.coverage,
    landed,
  );
  // No non-preset rule exists in any state here, so nothing can be
  // adjusted (the boot zh_cn preset rule never counts).
  await expect(page.locator("[data-stat='adjusted']")).toHaveText(
    "0",
    landed,
  );
}

/** Open a picker and pick the one catalog row it lists for the pair. */
async function pickCatalogFont(
  page: Page,
  role: "en" | "cjk",
  displayName: string,
): Promise<void> {
  await pointerClick(page, page.locator(`[data-role="picker-${role}"] .kit-hd`));
  const popup = page.locator(`[data-picker-popup="${role}"]`);
  await expect(popup).toBeVisible();
  await pointerClick(
    page,
    popup.locator(".kit-fp", { hasText: displayName }).first(),
  );
  // The catalog pick keeps the popup open (a chip may follow); the
  // pick itself is what the counters read.
  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
}

test.describe("status-bar counters vs fontTools ground truth", () => {
  const jsErrors: string[] = [];

  /** Suite-scoped serve/site disposers (one boot per test, torn down after). */
  const bootDisposers: Array<() => Promise<void>> = [];

  test.beforeEach(async ({ page }) => {
    jsErrors.length = 0;
    collectJsErrors(page, jsErrors);
  });

  test.afterEach(async () => {
    for (const dispose of bootDisposers.splice(0)) {
      await dispose();
    }
    assertNoJsErrors(jsErrors);
  });

  /** The real pair behind a REAL serve-backed catalog, fully synced. */
  async function openWithRealCatalog(page: Page): Promise<{
    en: FontTruth;
    cjk: FontTruth;
  }> {
    const paths = realFontPaths();
    const [en, cjk] = [fontTruth(paths.en), fontTruth(paths.cjk)];
    // Ticket #30's boot: the catalog rows come from a spawned serve
    // whose catalog syncs a file:// release site built over the staged
    // pair — the page-side downloader this spec rode before is no
    // longer called from the boot path (see main.ts).
    const site = await buildServeCatalogSite([
      {
        family: "JetBrainsMono",
        faces: [
          { file: "JetBrainsMonoNerdFont-Regular.ttf", fontPath: paths.en },
        ],
        manifestEntries: [
          { variant: "Nerd Font", file: "JetBrainsMono.zip" },
        ],
      },
      {
        // The manifest id keys the CJK slot scoping (curated-meta's
        // slots.cjk); the artifact served under it is the staged CN
        // cut, whose own name table (「Maple Mono NF CN」) is what the
        // row and the picks display.
        family: "MapleMono",
        faces: [{ file: "MapleMonoCN-Regular.ttf", fontPath: paths.cjk }],
        manifestEntries: [{ variant: "Regular", file: "MapleMono.zip" }],
      },
    ]);
    const spawned = await spawnServeOverFonts(site.catalogDir, [
      "--catalog-release-origin",
      site.originUri,
      "--catalog-dir",
      site.catalogDir,
      "--manifest",
      site.manifestPath!,
    ]);
    bootDisposers.push(async () => {
      await spawned.dispose();
      await rm(site.root, { recursive: true, force: true });
    });
    const serveUrl = await spawned.url;
    await page.addInitScript((serve: string) => {
      (window as { __FONTALLOY_CONFIG__?: unknown }).__FONTALLOY_CONFIG__ = {
        serveUrl: serve,
      };
    }, serveUrl);
    await page.goto("/");
    await expect(
      page.locator(".catalog-screen [data-stat='catalog-done']"),
    ).toHaveText("2", { timeout: 30_000 });
    await expect(page.locator(".catalog-screen")).toBeHidden();
    // The documents sweep must land too: the rows list from the serve's
    // family documents, which fill AFTER the sync counts settle — a
    // picker opened in between would sit rowless (unload.spec's boot
    // contract). The real pair's fontTools-cold resolves budget the
    // whole sweep, not the small-fixture 60s.
    await page.waitForFunction(
      () => document.documentElement.dataset.catalogSweep === "done",
      undefined,
      { timeout: 120_000 },
    );
    await waitForFontsReady(page);
    return { en, cjk };
  }

  test("a lone EN pick: every counter equals the ground truth", async ({
    page,
  }) => {
    // The real pair's resolves are fontTools-cold inside the spawned
    // serve — budget the whole journey, not the 30s fixture default.
    test.setTimeout(180_000);
    const { en } = await openWithRealCatalog(page);
    const truth = groundTruth([en]);
    logTruth("lone EN", [en], truth);

    await pickCatalogFont(page, "en", en.display);
    await assertCounters(page, truth);
  });

  test("a lone CJK pick: every counter equals the ground truth", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const { cjk } = await openWithRealCatalog(page);
    const truth = groundTruth([cjk]);
    logTruth("lone CJK", [cjk], truth);

    await pickCatalogFont(page, "cjk", cjk.display);
    await assertCounters(page, truth);
  });

  test("the pair: the union and both region arms equal the ground truth", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const { en, cjk } = await openWithRealCatalog(page);
    const truth = groundTruth([en, cjk]);
    logTruth("pair", [en, cjk], truth);

    await pickCatalogFont(page, "en", en.display);
    await pickCatalogFont(page, "cjk", cjk.display);
    await assertCounters(page, truth);
  });
});
