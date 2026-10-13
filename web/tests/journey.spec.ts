import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  allowProbeRefusal,
  assertNoJsErrors,
  collectJsErrors,
  hitTestCenter,
  openFontPicker,
  pointerClick,
  waitForCatalogReady,
  waitForFontsReady,
  UNUSED_SERVE,
} from "./helpers";
import { PREVIEW_ORIGIN, startServe } from "./serve";

/**
 * J11 — the WEB target's core user journey, quantified like its GUI
 * twin (gui/tests/journey.spec.ts): the SAME workspace app, built as
 * the static WebApp, walked against a REAL `fontalloy serve` over the
 * owner's fetched catalog layout (FONTALLOY_RUN_ASSETS):
 *
 *   detection (?serve=) → catalog picks (JetBrains Mono row, Maple
 *   Mono NF-CN via the 等宽 chip) → a language preset → a live
 *   synthesize through the seven report-copy stages → the verification
 *   report → the artifact as a real browser download, parsed with
 *   fontTools — then the no-service degrade panel (an address nothing
 *   answers): the copy-CLI command and the recipe YAML download.
 *
 * Steps carry the `J11.<n>` scorecard keys; the machine-readable
 * report lands at `fontalloy-notes/journey-report-web.json` (written
 * after every step, so even a crash leaves the table).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const NOTES_DIR = path.resolve(REPO_ROOT, "..", "fontalloy-notes");
const REPORT_PATH = path.join(NOTES_DIR, "journey-report-web.json");

/**
 * The owner's real serve layout (see the GUI twin for the rationale):
 * the fetched catalog directory + its own manifest, so the catalog
 * picks resolve as catalog-family references.
 */
const RUN_ASSETS =
  process.env.FONTALLOY_RUN_ASSETS ??
  "C:/Users/Administrator/Git/fontalloy-run/assets";

/* ------------------------------------------------------------------ */
/* Step tracking + the JSON report                                      */
/* ------------------------------------------------------------------ */

type StepRecord = { name: string; ok: boolean; error?: string };

const steps: StepRecord[] = [];
const errors: string[] = [];

async function writeReport(): Promise<void> {
  const passed = steps.filter((s) => s.ok).length;
  const report = {
    generated: new Date().toISOString(),
    suite: "web/tests/journey.spec.ts (playwright.journey.config.ts)",
    environment:
      "built WebApp under vite preview, real local catalog, " +
      "J11 against the real serve layout " +
      `(${RUN_ASSETS.split(path.sep).join("/")})`,
    journey: [
      {
        name: "J11 Web 目标",
        steps: `${passed}/${steps.length}`,
        passed,
        total: steps.length,
        failedSteps: steps
          .filter((s) => !s.ok)
          .map((s) => ({ name: s.name, error: s.error })),
      },
    ],
    stepsPassed: passed,
    stepsTotal: steps.length,
  };
  await writeFile(
    REPORT_PATH,
    JSON.stringify(report, null, 2) + "\n",
  ).catch(() => undefined);
}

let aborted = false;

/** One tracked journey step (the scorecard's J11.<n> key). */
async function step(
  name: string,
  fn: () => Promise<void>,
): Promise<void> {
  const record: StepRecord = { name, ok: false };
  steps.push(record);
  if (aborted) {
    record.error = "skipped: an earlier step failed";
    console.log(`  skip  ${name}`);
    return;
  }
  const started = Date.now();
  try {
    await fn();
    record.ok = true;
    console.log(`  ok    ${name} (${Date.now() - started}ms)`);
  } catch (err) {
    record.error = err instanceof Error ? err.message : String(err);
    aborted = true;
    console.log(`  FAIL  ${name} (${Date.now() - started}ms): ${record.error}`);
  }
  await writeReport();
}

/* ------------------------------------------------------------------ */
/* The walk's shared vocabulary                                         */
/* ------------------------------------------------------------------ */

/** The repo's own venv python (fontTools ships with the core). */
function venvPython(): string {
  return path.join(REPO_ROOT, ".venv", "Scripts", "python.exe");
}

/** Parse a built font with fontTools: family, cmap size, CJK presence.
 *  A round-12 family artifact is a ttc collection — read its face 0. */
async function parseBuiltFont(
  fontPath: string,
): Promise<{ family: string | null; cmap: number; cjkCodepoints: number }> {
  const dir = await mkdtemp(path.join(tmpdir(), "fontalloy-j11-parse-"));
  const script = path.join(dir, "parse.py");
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
    const child = spawn(venvPython(), [script, fontPath], {
      cwd: REPO_ROOT,
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
      resolvePromise(
        JSON.parse(out.trim()) as {
          family: string | null;
          cmap: number;
          cjkCodepoints: number;
        },
      );
    });
  });
}

/**
 * Click at the target's center by RAW COORDINATES (no node-identity
 * pin — the pickCatalogFamily precedent in ./helpers): while the
 * catalog's lazy registration sweep runs, every store patch rebuilds
 * the popup's rows, and an elementHandle-pinned identity check keeps
 * missing the replaced node. The row set at a given spot is stable
 * (same content in the same order, same handler semantics); the
 * hit-test guard still proves a real interactive element sits under
 * the cursor. Bounded retries ride out a rebuild that detaches the
 * node between the visibility wait and the geometry read ("no
 * bounding box", "not attached").
 */
async function rawClick(
  page: Page,
  locator: Locator,
): Promise<void> {
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

/** The flagship pair through the real picker surfaces (rows + chips). */
async function pickFlagshipPair(page: Page): Promise<void> {
  // EN: the JetBrains Mono row (the Nerd Font cut).
  const en = await openFontPicker(page, "en");
  const jetRow = en.locator(".kit-fp").filter({
    has: page.locator(".kit-nm", { hasText: /^JetBrainsMono Nerd Font$/ }),
  });
  await jetRow.scrollIntoViewIfNeeded();
  await rawClick(page, jetRow);
  await waitForFontsReady(page);
  await expect(
    page.locator("[data-role='font-pair'] [data-pair='base']"),
  ).toHaveText(/JetBrains/, { timeout: 20_000 });
  await page.keyboard.press("Escape");

  // CJK: the Maple row narrowed to its NF-CN cut through the variant
  // chip (round 8: per-cut chips with official labels; the identity
  // reads the variant's REAL name).
  const cjk = await openFontPicker(page, "cjk");
  const mapleRow = cjk.locator(".kit-fp").filter({
    has: page.locator(".kit-nm", { hasText: /^Maple Mono CN$/ }),
  });
  await mapleRow.scrollIntoViewIfNeeded();
  await rawClick(
    page,
    mapleRow.locator(".kit-vchip[data-chip='MapleMono::NF-CN']"),
  );
  await waitForFontsReady(page);
  // Round 9: the served face's own name-table string.
  await expect(
    page.locator("[data-role='font-pair'] [data-pair='donor']"),
  ).toHaveText("Maple Mono CN", { timeout: 20_000 });
  await page.keyboard.press("Escape");
}

/* ------------------------------------------------------------------ */
/* The journey                                                          */
/* ------------------------------------------------------------------ */

// Round 12 (owner item 8): the flagship pair builds the family's whole
// weight matrix as a ttc collection — a multi-minute build, twice
// (the merge, then the download run).
test.setTimeout(2_400_000);

test("J11 Web 目标 — detection, picks, preset, live merge, report, download, degrade", async ({
  page,
}) => {
  const gate = collectJsErrors(page, errors);
  // The first navigation probes the serve address at load; a refused
  // probe is the handled absence (declared, never an app error).
  allowProbeRefusal(gate, UNUSED_SERVE);
  // Live GitHub stars: hermetic and quiet (the GUI twin's approach) —
  // the unauthenticated API is rate-limited per IP and a 403 storm
  // would be browser-logged console noise the gate must not see.
  await page.route("https://api.github.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ stargazers_count: 4242 }),
    }),
  );

  const serve = await startServe({
    allowOrigin: PREVIEW_ORIGIN,
    fontDir: path.join(RUN_ASSETS, "fonts"),
    manifest: path.join(RUN_ASSETS, "fonts.manifest.json"),
  });
  try {
    console.log("\n=== J11 Web 目标 ===");
    await step("J11.1 the page boots and DETECTS the serve at ?serve=", async () => {
      await page.goto(
        `/?serve=${encodeURIComponent(serve.baseUrl)}`,
      );
      await waitForFontsReady(page);
      // The workspace arms only with both picks; with none, disabled.
      await expect(
        page.locator(".topbar [data-role='synthesize']"),
      ).toHaveAttribute("aria-disabled", "true", { timeout: 30_000 });
      await expect(page.locator(".workspace-rail")).toBeVisible();
    });

    await step("J11.2 the catalog settles (the first-run download)", async () => {
      await waitForCatalogReady(page);
    });

    await step("J11.3 picks: JetBrains Mono row + Maple Mono NF-CN via the variant chip", async () => {
      await pickFlagshipPair(page);
      await expect(
        page.locator(".topbar [data-role='synthesize']"),
      ).toHaveAttribute("aria-disabled", "false");
    });

    await step("J11.4 the 文字范围 preset: 日文 toggles on, the kana resolve by rule", async () => {
      const locate = page.locator(".kit-toolrow [data-role='locate']");
      await locate.fill("U+3042");
      await locate.press("Enter");
      const cell = page.locator(
        ".charmap-grid .kit-cell[data-cp='U+3042']",
      );
      await expect(cell).toHaveClass(/cur/);
      const ja = page.locator("[data-role='lang-chip'][data-preset='ja']");
      await pointerClick(page, ja);
      await expect(ja).toHaveAttribute("aria-pressed", "true");
      await expect(cell).toHaveAttribute("data-via", /rule-\d+/);
    });

    await step("J11.5 synthesize runs the 7 report-copy stages to 完成", async () => {
      await pointerClick(page, page.locator(".topbar [data-role='synthesize']"));
      const panel = page.locator('[data-testid="build-panel"]');
      await expect(panel).toBeVisible();
      const stepLabels = await panel
        .locator(".build-step")
        .evaluateAll((dots) => dots.map((dot) => (dot as HTMLElement).title));
      expect(stepLabels).toEqual([
        "读取字体",
        "规划字重",
        "解析规则",
        "移植字形",
        "改写名称表",
        "保存输出",
        "生成报告",
      ]);
      await expect(panel.locator("[data-build-stage]").first()).toHaveText(
        "完成",
        { timeout: 900_000 },
      );
      // Round 12 (owner item 3, no web regression): the web save stays
      // the BROWSER download path — the completion line shows it and
      // the completed row carries the same 另存为 affordance (a second
      // browser download when clicked). Round 13 (owner item 4): the
      // saved line is TWO rows — 「已保存」 first, the path under it
      // (the whole path rides the title attribute).
      await expect(
        panel.locator("[data-build-saved-label]").first(),
      ).toHaveText("已保存");
      await expect(
        panel.locator("[data-build-saved-path]").first(),
      ).toHaveAttribute("title", "ChHsich.ttf");
      await expect(
        panel.locator("[data-build-saveas]").first(),
      ).toBeVisible();
    });

    await step("J11.6 the verification report renders under the real terms", async () => {
      const panel = page.locator('[data-testid="build-panel"]');
      // Round 10: the settled row stays calm — the report sits behind
      // the 查看报告 disclosure (saved line first); the raw JSON form
      // is gone from the UI.
      await expect(panel.locator(".build-row").first()).toContainText("已保存");
      await pointerClick(page, panel.locator(".report-details > summary"));
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
      // Round 13 (owner item 6): the metrics section is a real table —
      // the 合并前 / 合并后 data columns stated ONCE in a header row.
      const metricsTable = panel.locator(".report-mtable").first();
      await expect(metricsTable).toBeVisible();
      expect(
        (await metricsTable.locator("thead th").allTextContents()).filter(
          (h) => h === "合并前" || h === "合并后",
        ),
      ).toEqual(["合并前", "合并后"]);
      // Round 12 (owner item 4): the borrow rows read the ratified
      // 成品档位 ← 来源字体 direction — the output weight LEFT of the
      // arrow, the via qualifier after ·.
      await expect(panel).toContainText(
        /\d+ ← .+ · (自动取最近|指定字重|锁定)/,
      );
      // Round 12 (owner item 1): no dash-joins anywhere in the panel.
      await expect(panel).not.toContainText("—");
      await expect(panel).not.toContainText("fontalloy/verification-report");
      // Round 12 (owner item 8): the matrix is the family's own — the
      // JetBrainsMono NF cut's every face (100–800, upright + italic).
      const weightSection = panel
        .locator(".report-section")
        .filter({ hasText: "字重档位" });
      await expect(weightSection).toBeVisible();
      expect(
        await weightSection.locator(".report-fact-label").count(),
      ).toBe(16);
    });

    await step("J11.7 the artifact downloads and PARSES (family ChHsich, donor CJK inside)", async () => {
      // The web target's save flow is the browser's own download,
      // fired by the run itself when the build settles.
      const download = page.waitForEvent("download", { timeout: 900_000 });
      await pointerClick(page, page.locator(".topbar [data-role='synthesize']"));
      const downloaded = await download;
      // Round 12: the family matrix artifact is the ttc collection.
      expect(await downloaded.suggestedFilename()).toBe("ChHsich.ttc");
      const target = path.join(
        await mkdtemp(path.join(tmpdir(), "fontalloy-j11-save-")),
        "ChHsich.ttc",
      );
      await downloaded.saveAs(target);
      const parsed = await parseBuiltFont(target);
      expect(parsed.family).toBe("ChHsich");
      expect(parsed.cmap).toBeGreaterThan(0);
      expect(parsed.cjkCodepoints).toBeGreaterThan(0);
    });

    await step("J11.8 no service: the degrade panel offers copy-CLI + the YAML download", async () => {
      // Same page (the stored catalog + theme persist by origin): a
      // navigation to an address nothing answers is the honest state.
      await page.goto(`/?serve=${encodeURIComponent(UNUSED_SERVE)}`);
      await waitForFontsReady(page);
      await expect(page.locator(".workspace-rail")).toBeVisible();
      // Picks reset per launch — re-pick through the (stored) catalog.
      await pickFlagshipPair(page);
      const panel = page.locator('[data-testid="cli-panel"]');
      if (!(await panel.isVisible())) {
        await pointerClick(
          page,
          page.locator(".topbar [data-role='synthesize']"),
        );
      }
      await expect(panel).toBeVisible();
      const notice = panel.locator('[data-testid="service-notice"]');
      await expect(notice).toContainText("未检测到本地服务");
      await expect(
        panel.locator('[data-testid="cli-command"]'),
      ).toContainText("fontalloy build");
      await expect(
        panel.locator('[data-testid="copy-command"]'),
      ).toHaveAttribute("aria-disabled", "false");
      // The recipe YAML download: a real browser download of the file.
      await expect(
        panel.locator('[data-testid="recipe-yaml"]'),
      ).toContainText("base:");
      const yamlDownload = page.waitForEvent("download");
      await pointerClick(
        page,
        panel.locator('[data-testid="download-recipe"]'),
      );
      const yamlFile = await yamlDownload;
      const yamlPath = path.join(tmpdir(), "fontalloy-j11-recipe.yaml");
      await yamlFile.saveAs(yamlPath);
      const yaml = await readFile(yamlPath, "utf8");
      expect(yaml).toContain("base:");
      expect(yaml).toContain("donors:");
      expect(yaml).toContain("family: ChHsich");
    });

    await step("J11.9 zero JS errors across the journey", () =>
      assertNoJsErrors(errors),
    );

    // The final report write (even a passing run refreshes the table).
    await writeReport();
    const failures = steps.filter((s) => !s.ok);
    if (failures.length > 0 || aborted) {
      throw new Error(
        `J11 Web 目标 — ${steps.filter((s) => s.ok).length}/${steps.length} steps passed\n  ` +
          failures.map((s) => `step "${s.name}": ${s.error}`).join("\n  "),
      );
    }
  } finally {
    await serve.stop();
  }
});
