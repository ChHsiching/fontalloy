import { test, expect, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  assertNoJsErrors,
  collectJsErrors,
  pointerClick,
  waitForFontsReady,
} from "./helpers";
import { spawnServeOverFonts } from "./serve";
import {
  buildServeCatalogSite,
  type ServeCatalogSite,
} from "./catalog-serve-site";

/**
 * The memory-regression spec (ticket #32, spec #25 — the owner's
 * MEMORY RED LINE): after URL FontFace registration, the renderer
 * NEVER pins font bytes for catalog fonts. This spec pins the
 * MECHANISM with an explicit renderer-memory budget:
 *
 * - boot → picker open → full row scroll → worst-case multi-face
 *   family pick (8 real ~1.4 MB faces, all descriptors force-loaded)
 *   → unload (eviction) → pick/unload × 3;
 * - the working set is sampled at the OS LEVEL (the browser
 *   process's WorkingSetSize via the Windows process table, scoped
 *   to THIS test's browser tree) — JS heap metrics miss the native
 *   font memory where the bytes actually land, so they are never the
 *   signal here;
 * - assertions: (a) an absolute budget constant over every sample,
 *   (b) unload returns the working set to within a stated tolerance
 *   of the pre-pick baseline, (c) no monotone growth across the
 *   three pick/unload cycles.
 *
 * ACCEPTANCE SCOPE: the fixtures are tiny generated faces inside the
 * temp dirs (the IO discipline: the serve reads ONLY worktree-local
 * scratch — never the real appData, the Windows Fonts dir, or any
 * multi-GB directory). The owner-machine REAL-catalog measurement
 * (the actual ~2,000-face catalog in the actual window) is the final
 * T13/acceptance gate; this spec pins the mechanism and the budget
 * shape, not the owner's absolute numbers.
 */

/**
 * The absolute renderer working-set budget (MB) — see the header.
 *
 * Measured baseline on this machine (two green runs, 2026-10-17,
 * headless Chromium over the vite dev server, 25-family site, the
 * 8 × ~1.05 MB worst-case family):
 *   run 1: boot=255.4  scroll=259.7  pick=273.0  unload=263.0
 *          peaks=[264.9, 264.9, 269.7]  troughs=[262.1, 261.8, 266.2]
 *   run 2: boot=247.0  scroll=254.6  pick=257.4  unload=256.3
 *          peaks=[260.0, 259.7, 264.2]  troughs=[253.2, 258.3, 258.8]
 * — the pick of 8.2 MB of faces costs ~10–17 MB of working set; the
 * full row scroll costs ~5–8 MB (25 preview subsets); eviction returns
 * the set to ≤ +12 MB of the boot baseline; the cycles stay flat. The
 * budget keeps headroom over the measured pick peak for machine noise;
 * a byte-pinning regression (the ticket's red line) adds the family's
 * full decoded mass to EVERY later sample and breaches it.
 */
const RENDERER_BUDGET_MB = 320;
/**
 * Post-unload return tolerance over the pre-pick baseline (MB). The
 * sharp eviction guard is the mechanism assertion (document.fonts
 * carries none of the family after unload); this is the coarse
 * regression net — observed healthy returns land ≤ +11 MB on a quiet
 * machine and +22–26 MB after heavy suite activity (Windows keeps
 * freed-but-committed pages resident; the level is machine state, the
 * LEAK signal is cross-cycle growth, guarded separately). 30 absorbs
 * the observed healthy band with margin; the absolute budget above
 * stays the hard ceiling.
 */
const RETURN_TOLERANCE_MB = 30;
/**
 * Cross-cycle growth tolerance for the 3 pick/unload cycles (MB) —
 * observed cycle peaks drift ≤ +5 MB; accumulation shows here.
 */
const CYCLE_GROWTH_TOLERANCE_MB = 12;
/** Settling pause before every sample (native font frees are async). */
const SETTLE_MS = 800;

/** The worst-case family: 8 weights × real ~1.4 MB faces ≈ 11 MB raw. */
const HEAVY_FAMILY = "AlloyHeavy";
const HEAVY_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800];
const ROW_FAMILY_COUNT = 24;

const STYLE_NAMES: Record<number, string> = {
  100: "Thin",
  200: "ExtraLight",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "SemiBold",
  700: "Bold",
  800: "ExtraBold",
};

/* ---------- the OS-level renderer working-set sampler ---------- */

interface Proc {
  ProcessId: number;
  ParentProcessId: number;
  Name: string;
  WorkingSetSize: number;
  CommandLine: string | null;
}

const execFileAsync = promisify(execFile);

/**
 * Every Playwright-browser process on the machine (the bundled
 * Chromium lives under ms-playwright; the owner's own browsers never
 * match the path filter). Windows samples via CIM (powershell); POSIX
 * (the Linux CI) via `ps` — the cmdline's argv[0] carries the
 * executable path, so the ms-playwright filter works the same way.
 */
async function chromiumProcesses(): Promise<Proc[]> {
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '*ms-playwright*' } | " +
          "Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,CommandLine | ConvertTo-Json -Compress",
      ],
      { maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 30_000 },
    );
    let parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) parsed = [parsed];
    return parsed as Proc[];
  }
  const { stdout } = await execFileAsync(
    "ps",
    ["-eo", "pid=,ppid=,rss=,args="],
    { maxBuffer: 64 * 1024 * 1024, timeout: 30_000 },
  );
  const procs: Proc[] = [];
  for (const line of stdout.split("\n")) {
    // Fixed-width decimals then whitespace then the full command line.
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(\S.*)$/.exec(line.trim());
    if (!match) continue;
    const [, pid, ppid, rssKb, args] = match;
    if (!args.includes("ms-playwright")) continue;
    procs.push({
      ProcessId: Number(pid),
      ParentProcessId: Number(ppid),
      Name: args.split(/\s+/)[0] ?? "",
      WorkingSetSize: Number(rssKb) * 1024,
      CommandLine: args,
    });
  }
  return procs;
}

/**
 * The renderer working set (MB) of THIS test's browser: the Chromium
 * main whose parent is this Node worker, its process tree, and the
 * LARGEST --type=renderer inside it (the page's renderer — sibling
 * agents' browsers on this machine are excluded by the tree scoping).
 */
async function rendererWorkingSetMb(): Promise<number> {
  const procs = await chromiumProcesses();
  const byParent = new Map<number, Proc[]>();
  for (const proc of procs) {
    const list = byParent.get(proc.ParentProcessId) ?? [];
    list.push(proc);
    byParent.set(proc.ParentProcessId, list);
  }
  const roots = procs.filter(
    (proc) =>
      proc.ParentProcessId === process.pid &&
      !/--type=/.test(proc.CommandLine ?? ""),
  );
  expect(roots.length, "no Playwright browser under this worker").toBeGreaterThan(0);
  const tree: Proc[] = [];
  const queue = [...roots];
  while (queue.length > 0) {
    const proc = queue.shift()!;
    tree.push(proc);
    queue.push(...(byParent.get(proc.ProcessId) ?? []));
  }
  const renderers = tree.filter((proc) =>
    /--type=renderer/.test(proc.CommandLine ?? ""),
  );
  expect(renderers.length, "no renderer process in the browser tree").toBeGreaterThan(0);
  return Math.max(...renderers.map((proc) => proc.WorkingSetSize)) / (1024 * 1024);
}

/* ---------- the generated fixture site (tiny, temp-dir only) ---------- */

/**
 * One python run builds every face: ROW_FAMILY_COUNT single-face
 * "Alloy Row NN" families (the picker's scroll mass) plus the
 * worst-case family — 8 real weights of ~1.4 MB each (≈2,000
 * multi-point CJK-range glyphs per face), all inside the fixture
 * budget (< 50 MB total site).
 */
async function generateMemoryFixtures(
  outdir: string,
): Promise<{ heavyFaces: string[] }> {
  const script = `
import sys
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

out = Path(sys.argv[1])

def polygon_glyph(points):
    pen = TTGlyphPen(None)
    pen.moveTo(points[0])
    for p in points[1:]:
        pen.lineTo(p)
    pen.closePath()
    return pen.glyph()

def build(path, family, style, weight, codepoints, points_per_glyph):
    glyphs = {".notdef": polygon_glyph([(0, 0), (500, 0), (500, 700), (0, 700)])}
    metrics = {".notdef": (600, 40)}
    step = 440 // points_per_glyph
    for cp in codepoints:
        name = "uni%04X" % cp
        pts = []
        for i in range(points_per_glyph):
            x = 40 + i * step
            y = 60 + (320 if i % 2 == 0 else 0) + (cp % 97)
            pts.append((x, y))
        pts.append((560, 350))
        glyphs[name] = polygon_glyph(pts)
        metrics[name] = (600, 40)
    b = FontBuilder(unitsPerEm=1000, isTTF=True)
    b.setupGlyphOrder(list(glyphs))
    b.setupCharacterMap({cp: "uni%04X" % cp for cp in codepoints})
    b.setupGlyf(glyphs)
    b.setupHorizontalMetrics(metrics)
    b.setupHorizontalHeader(ascent=800, descent=-200)
    b.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=900,
               usWinDescent=300, usWeightClass=weight)
    b.setupNameTable({"familyName": family, "styleName": style})
    b.setupPost()
    b.setupHead()
    b.save(path)

weights = [${HEAVY_WEIGHTS.join(", ")}]
styles = {${HEAVY_WEIGHTS.map((w) => `${w}: "${STYLE_NAMES[w]}"`).join(", ")}}
heavy_dir = out / "heavy"
heavy_dir.mkdir(parents=True, exist_ok=True)
for w in weights:
    codepoints = tuple(range(0x4E00, 0x4E00 + 2600))
    build(heavy_dir / ("AlloyHeavy-%s.ttf" % styles[w]), "Alloy Heavy",
          styles[w], w, codepoints, 120)
for n in range(1, ${ROW_FAMILY_COUNT + 1}):
    build(out / ("AlloyRow%02d-Regular.ttf" % n), "Alloy Row %02d" % n,
          "Regular", 400, tuple(range(0x41, 0x5B)), 4)
print("ok")
`;
  const scriptPath = resolve(outdir, "_gen_memory.py");
  await writeFile(scriptPath, script, "utf8");
  const python = process.env.FONTALLOY_PYTHON ?? "python";
  await new Promise<void>((resolvePromise, rejectPromise) => {
    execFile(python, [scriptPath, outdir], { cwd: outdir, windowsHide: true }, (err, _so, stderr) => {
      if (err) rejectPromise(new Error(`${python}: ${err}\n${stderr}`));
      else resolvePromise();
    });
  });
  return {
    heavyFaces: HEAVY_WEIGHTS.map(
      (weight) => resolve(outdir, "heavy", `AlloyHeavy-${STYLE_NAMES[weight]}.ttf`),
    ),
  };
}

/* ---------- page helpers ---------- */

async function openPicker(page: Page): Promise<void> {
  const popup = page.locator('[data-picker-popup="en"]');
  if (await popup.isVisible()) return; // already open (AppSelect toggle)
  await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
  await expect(popup).toBeVisible();
}

async function pickHeavyRow(page: Page): Promise<void> {
  await openPicker(page);
  console.log("[memory] picker open, clicking heavy row");
  const row = page
    .locator('[data-picker-popup="en"] .kit-fp')
    .filter({ hasText: "Alloy Heavy" })
    .first();
  await pointerClick(page, row.locator(".kit-nm"));
  await expect(page.locator('[data-picker-popup="en"]')).toBeHidden();
  console.log("[memory] row clicked, popup closed");
}

/** Every face of the family as `weight/style` (descriptor inventory). */
function facesOf(page: Page, family: string): Promise<string[]> {
  return page
    .evaluate((fam) => {
      const faces = [...document.fonts].filter((f) => f.family === fam);
      return faces.map((f) => ({
        weight: Number(f.weight === "normal" ? 400 : f.weight === "bold" ? 700 : f.weight),
        style: String(f.style),
        status: String(f.status),
      }));
    }, family)
    .then((faces) =>
      faces
        .sort((a, b) => a.weight - b.weight)
        .map((f) => `${f.weight}/${f.style}`),
    );
}

/** The load status per face, weight-sorted (aligned with {@link facesOf}). */
function statusesOf(page: Page, family: string): Promise<string[]> {
  return page
    .evaluate((fam) => {
      const faces = [...document.fonts].filter((f) => f.family === fam);
      return faces.map((f) => ({
        weight: Number(f.weight === "normal" ? 400 : f.weight === "bold" ? 700 : f.weight),
        status: String(f.status),
      }));
    }, family)
    .then((faces) => faces.sort((a, b) => a.weight - b.weight).map((f) => f.status));
}

/** Force the worst case: fetch EVERY face's bytes via its URL. */
async function forceLoadAll(page: Page, family: string): Promise<string[]> {
  const faces = await page
    .evaluate(async (fam) => {
      const faces = [...document.fonts].filter((f) => f.family === fam);
      await Promise.all(faces.map((f) => f.load()));
      return faces.map((f) => ({
        weight: Number(f.weight === "normal" ? 400 : f.weight === "bold" ? 700 : f.weight),
        style: String(f.style),
        status: String(f.status),
      }));
    }, family);
  return faces
    .sort((a, b) => a.weight - b.weight)
    .map((f) => `${f.weight}/${f.style}:${f.status}`);
}

/** Settle the font subsystem + the allocator before a sample. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(SETTLE_MS);
}

/* ---------- the spec ---------- */

test.describe("renderer memory (ticket #32: the MEMORY RED LINE)", () => {
  const jsErrors: string[] = [];
  const disposers: Array<() => Promise<void>> = [];

  test.beforeEach(async ({ page }) => {
    jsErrors.length = 0;
    collectJsErrors(page, jsErrors);
  });

  test.afterEach(async () => {
    for (const dispose of disposers.splice(0)) await dispose();
    assertNoJsErrors(jsErrors);
  });

  test.setTimeout(600_000);
  test("URL faces load, evict on unload, and the renderer working set stays within budget", async ({
    page,
  }) => {
    const root = await mkdtemp(resolve(tmpdir(), "fontalloy-memory-"));
    const { heavyFaces } = await generateMemoryFixtures(root);
    for (const face of heavyFaces) {
      const info = await stat(face);
      // Meaningful-but-small: every worst-case face is real font mass.
      expect(info.size).toBeGreaterThan(0.9 * 1024 * 1024);
      expect(info.size).toBeLessThan(2.2 * 1024 * 1024);
    }
    const site: ServeCatalogSite = await buildServeCatalogSite([
      {
        family: HEAVY_FAMILY,
        faces: heavyFaces.map((path) => ({
          file: path.split(/[\\/]/).pop()!,
          fontPath: path,
        })),
      },
      ...Array.from({ length: ROW_FAMILY_COUNT }, (_, i) => ({
        family: `AlloyRow${String(i + 1).padStart(2, "0")}`,
        faces: [
          {
            file: `AlloyRow${String(i + 1).padStart(2, "0")}-Regular.ttf`,
            fontPath: resolve(root, `AlloyRow${String(i + 1).padStart(2, "0")}-Regular.ttf`),
          },
        ],
      })),
    ]);
    const spawned = await spawnServeOverFonts(site.catalogDir, [
      "--catalog-release-origin",
      site.originUri,
      "--catalog-dir",
      site.catalogDir,
      "--manifest",
      site.manifestPath!,
    ]);
    disposers.push(async () => {
      await spawned.dispose();
      await rm(site.root, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    });
    const serveUrl = await spawned.url;
    await page.addInitScript((serve: string) => {
      (window as { __FONTALLOY_CONFIG__?: unknown }).__FONTALLOY_CONFIG__ = {
        serveUrl: serve,
      };
    }, serveUrl);
    await page.goto("/");
    const families = 1 + ROW_FAMILY_COUNT;
    await expect(
      page.locator(".catalog-screen [data-stat='catalog-done']"),
    ).toHaveText(String(families), { timeout: 60_000 });
    await expect(page.locator(".catalog-screen")).toBeHidden();
    await page.waitForFunction(
      () => document.documentElement.dataset.catalogSweep === "done",
      undefined,
      { timeout: 120_000 },
    );
    await waitForFontsReady(page);

    /* --- phase 1: boot --- */
    await settle(page);
    const bootMb = await rendererWorkingSetMb();
    console.log(`[memory] boot=${bootMb.toFixed(1)}`);

    /* --- phase 2: picker open + full row scroll --- */
    await openPicker(page);
    const list = page.locator('[data-picker-popup="en"] .kit-pks');
    await list.evaluate((el) => {
      const area = el as HTMLElement;
      area.scrollTop = area.scrollHeight;
    });
    await waitForFontsReady(page);
    await settle(page);
    const scrollMb = await rendererWorkingSetMb();
    console.log(`[memory] scroll=${scrollMb.toFixed(1)}`);
    // Leave the picker CLOSED between phases (each phase opens its own).
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-picker-popup="en"]')).toBeHidden();

    // Ticket #36: the pre-pick baseline is the greater of the two
    // pre-pick samples — see RETURN_TOLERANCE_MB above.
    const baselineMb = Math.max(bootMb, scrollMb);
    console.log(`[memory] baseline=${baselineMb.toFixed(1)}`);

    /* --- phase 3: worst-case multi-face pick --- */
    await pickHeavyRow(page);
    // MECHANISM: the pick registered every (weight, style) slot winner
    // as a URL FontFace with its descriptor — lazy: only the picker's
    // own immediate-render load of the default slot may be in flight,
    // the other seven are still untouched.
    const descriptors = await facesOf(page, HEAVY_FAMILY);
    expect(descriptors).toEqual(HEAVY_WEIGHTS.map((weight) => `${weight}/normal`));
    const lazyStatuses = await statusesOf(page, HEAVY_FAMILY);
    for (const [index, status] of lazyStatuses.entries()) {
      if (HEAVY_WEIGHTS[index] === 400) continue; // the rendered slot
      expect(status, `face ${HEAVY_WEIGHTS[index]} stays lazy`).toBe("unloaded");
    }
    // The worst case: every descriptor actually loads its bytes by URL.
    expect(await forceLoadAll(page, HEAVY_FAMILY)).toEqual(
      HEAVY_WEIGHTS.map((weight) => `${weight}/normal:loaded`),
    );
    await settle(page);
    const pickMb = await rendererWorkingSetMb();
    console.log(`[memory] pick=${pickMb.toFixed(1)}`);

    /* --- phase 4: unload evicts --- */
    await pickHeavyRow(page); // re-click the picked row = unload
    await expect(page.locator('[data-picker-popup="en"]')).toBeHidden();
    // MECHANISM: eviction — document.fonts carries none of the family.
    expect(await facesOf(page, HEAVY_FAMILY)).toEqual([]);
    await settle(page);
    const unloadMb = await rendererWorkingSetMb();
    console.log(`[memory] unload=${unloadMb.toFixed(1)}`);

    /* --- phase 5: pick/unload × 3 (repeat-click keeps working) --- */
    const peaks: number[] = [];
    const troughs: number[] = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      await pickHeavyRow(page);
      expect(await forceLoadAll(page, HEAVY_FAMILY)).toEqual(
        HEAVY_WEIGHTS.map((weight) => `${weight}/normal:loaded`),
      );
      await settle(page);
      peaks.push(await rendererWorkingSetMb());
      await pickHeavyRow(page);
      expect(await facesOf(page, HEAVY_FAMILY)).toEqual([]);
      await settle(page);
      troughs.push(await rendererWorkingSetMb());
    }

    // Observability: every sample lands in the report for the budget
    // bookkeeping (the comment above the constants records the
    // measured baseline of the first green run on this machine).
    console.log(
      `[memory] boot=${bootMb.toFixed(1)} scroll=${scrollMb.toFixed(1)} ` +
        `pick=${pickMb.toFixed(1)} unload=${unloadMb.toFixed(1)} ` +
        `peaks=[${peaks.map((m) => m.toFixed(1)).join(", ")}] ` +
        `troughs=[${troughs.map((m) => m.toFixed(1)).join(", ")}]`,
    );

    // (a) The absolute budget: every sampled working set stays inside.
    for (const sample of [bootMb, scrollMb, pickMb, unloadMb, ...peaks, ...troughs]) {
      expect(sample, `renderer working set ${sample.toFixed(1)} MB`).toBeLessThanOrEqual(
        RENDERER_BUDGET_MB,
      );
    }
    // (b) Unload returns to the pre-pick baseline within tolerance.
    // Mid-cycle TROUGH values are deliberately NOT checked against the
    // pre-pick baseline: a trough is the working-set valley while the
    // page still lives — Windows keeps freed-but-committed pages
    // resident, so troughs sit naturally ~20+ MB above a pre-pick
    // sample (two runs tripped the old shared tolerance by <1 MB on
    // healthy pages). Trough accumulation is guarded in (c), against
    // the trough series itself.
    expect(unloadMb).toBeLessThanOrEqual(baselineMb + RETURN_TOLERANCE_MB);
    // (c) No monotone growth across the cycles — peaks AND troughs
    // against their own series (leak accumulation shows here, not in
    // the absolute trough level).
    expect(peaks[2]!, "cycle-3 peak vs cycle-1 peak").toBeLessThanOrEqual(
      peaks[0]! + CYCLE_GROWTH_TOLERANCE_MB,
    );
    expect(troughs[2]!, "cycle-3 trough vs cycle-1 trough").toBeLessThanOrEqual(
      troughs[0]! + CYCLE_GROWTH_TOLERANCE_MB,
    );
  });
});
