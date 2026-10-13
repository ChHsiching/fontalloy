import { expect, test, type Page, type Request } from "@playwright/test";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import {
  allowProbeRefusal,
  assertNoJsErrors,
  collectJsErrors,
  loadLocalFont,
  openCliPanel,
  optOutOfCatalog,
  pointerClick,
  synthesizeButton,
  waitForFontsReady,
} from "./helpers";
import {
  OTHER_ORIGIN,
  PREVIEW_ORIGIN,
  serveFixtureDir,
  startServe,
} from "./serve";

/**
 * Issue #22 on the unified workspace (repair round 2): the WebApp — the
 * same app the GUI mounts — drives REAL merges through a real
 * `fontalloy serve` instance. Detection on load (`?serve=`), local
 * fixture fonts through the real pickers, the synthesize action, the
 * build panel's journal + report rendering, the browser-download
 * artifact, inline failure surfacing, and the CORS boundary (the flow
 * works only from the origin serve was configured to allow — otherwise
 * the no-service CLI panel is the offering).
 *
 * The service is spawned exactly the way a consumer sees it: subprocess,
 * OS-assigned ephemeral port, the ready URL read from stdout.
 */

test.setTimeout(120_000);

/** An address a browser can pass in the ?serve= query parameter. */
function webAddress(baseUrl: string): string {
  return encodeURIComponent(baseUrl);
}

async function loadApp(page: Page, baseUrl: string): Promise<void> {
  await optOutOfCatalog(page);
  await page.goto(`/?serve=${webAddress(baseUrl)}`);
  await waitForFontsReady(page);
}

/** Load the fixture base + donor into the workspace's pickers. */
async function loadPicks(
  page: Page,
  fontsDir: string,
  base: string,
  donor: string,
): Promise<void> {
  await loadLocalFont(page, "en", path.join(fontsDir, base));
  await loadLocalFont(page, "cjk", path.join(fontsDir, donor));
}

/** Absolute, forward-slash fixture paths (serve wants absolute paths). */
function fixturePath(fontsDir: string, name: string): string {
  return path.join(fontsDir, name).split(path.sep).join("/");
}

/** The exact POST /builds body the workspace must submit for the pair. */
function expectedBody(base: string, donors: string[]): Record<string, unknown> {
  return {
    base,
    donors,
    // The boot-seeded zh_cn preset rule (文字范围 ships it; see
    // gui/src/state.ts) rides along in every fresh-state recipe.
    rules: [{ set: "zh_cn", fonts: ["base", "donor-0"] }],
    output: { format: "ttf", family: "ChHsich" },
  };
}

function captureBuildRequest(page: Page): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    page.on("request", (request: Request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/builds")) {
        resolve(request.postDataJSON() as Record<string, unknown>);
      }
    });
  });
}

test("detects the service, merges live with journal and report, downloads the font", async ({
  page,
}) => {
  const errors: string[] = [];
  collectJsErrors(page, errors);

  const fontsDir = await serveFixtureDir();
  const serve = await startServe({ allowOrigin: PREVIEW_ORIGIN, fontDir: fontsDir });
  try {
    await loadApp(page, serve.baseUrl);

    // Detection on load: the workspace's synthesize action arms itself
    // once service + both picks are in place.
    const synthesize = synthesizeButton(page);
    await expect(synthesize).toHaveAttribute("aria-disabled", "true");

    // Base + the SLOW donor: the wide CJK block keeps the build in
    // flight for seconds, so polled progress is assertable, not racy.
    const base = fixturePath(fontsDir, "Alpha.ttf");
    const slow = fixturePath(fontsDir, "Slow.ttf");
    await loadPicks(page, fontsDir, "Alpha.ttf", "Slow.ttf");
    await expect(synthesize).toHaveAttribute("aria-disabled", "false");

    const bodyPromise = captureBuildRequest(page);
    // The artifact lands through the platform saver — on this target a
    // browser download fired by the run itself (no extra click).
    const downloadPromise = page.waitForEvent("download");
    await pointerClick(page, synthesize);

    // The submitted body IS the serve recipe contract, pinned verbatim
    // (paths exactly as the service's own /fonts index reported them —
    // native separators on Windows, normalized here for the pin).
    const body = (await bodyPromise) as {
      base: string;
      donors: string[];
    };
    expect({
      ...body,
      base: body.base.replaceAll("\\", "/"),
      donors: body.donors.map((d) => d.replaceAll("\\", "/")),
    }).toEqual(expectedBody(base, [slow]));

    // The build panel (the workspace's live-merge surface): the head
    // status term carries the live state (round 10: the vertical
    // journal list is gone — the stepper is the progress).
    const panel = page.locator('[data-testid="build-panel"]');
    await expect(panel).toBeVisible();
    const stage = panel.locator("[data-build-stage]").first();
    await expect(stage).toContainText(/完成|排队|正在合成|读取字体/);
    await expect(stage).toContainText("完成", { timeout: 60_000 });
    await expect(panel.locator("[data-build-journal]")).toHaveCount(0);

    // The report renders from the machine JSON the service returned —
    // behind the 查看报告 disclosure (round 10: a settled row stays
    // calm; the raw JSON form is gone from the UI).
    await expect(panel.locator(".build-row").first()).toContainText("已保存");
    await pointerClick(page, panel.locator(".report-details > summary"));
    await expect(panel).toContainText("验证报告");
    await expect(panel).toContainText("码位");
    // Round 16 (owner): the borrow source is one sentence above the
    // weight grid — the per-slot 「N ← …」 lines are gone; NO
    // dash-joins. Round 13 (owner item 6): the metrics render as a
    // real table — 合并前 / 合并后 stated once in the header row.
    await expect(panel).toContainText(
      /\d+ 档全部取自 .+（自动取最近|指定字重|锁定）/,
    );
    const metricsTable = panel.locator(".report-mtable").first();
    await expect(metricsTable).toBeVisible();
    expect(
      (await metricsTable.locator("thead th").allTextContents()).filter(
        (h) => h === "合并前" || h === "合并后",
      ),
    ).toEqual(["合并前", "合并后"]);
    await expect(panel).not.toContainText("—");
    await expect(panel).not.toContainText("fontalloy/verification-report");

    // The saved artifact is a real font download: real bytes, TTF magic.
    const fontDownload = await downloadPromise;
    expect(await fontDownload.suggestedFilename()).toBe("ChHsich.ttf");
    const fontBytes = await readFile((await fontDownload.path())!);
    expect(fontBytes.length).toBeGreaterThan(0);
    expect(fontBytes.subarray(0, 4)).toEqual(Buffer.from([0x00, 0x01, 0x00, 0x00]));
    // The row states where it landed, as page text.
    await expect(panel.locator(".build-row").first()).toContainText("已保存");

    // Round 12 (owner item 3, no web regression): the completed row
    // carries the 另存为 affordance, and on this target it is a SECOND
    // browser download of the same bytes — the web path never opens a
    // dialog and never needs one.
    const saveAsDownload = page.waitForEvent("download");
    await pointerClick(
      page,
      panel.locator("[data-build-saveas]").first(),
    );
    const saveAsFile = await saveAsDownload;
    expect(await saveAsFile.suggestedFilename()).toBe("ChHsich.ttf");
    const saveAsBytes = await readFile((await saveAsFile.path())!);
    expect(saveAsBytes.subarray(0, 4)).toEqual(
      Buffer.from([0x00, 0x01, 0x00, 0x00]),
    );

    assertNoJsErrors(errors);
  } finally {
    await serve.stop();
  }
});

test("a failing build surfaces its error inline", async ({ page }) => {
  const errors: string[] = [];
  collectJsErrors(page, errors);

  const fontsDir = await serveFixtureDir();
  const serve = await startServe({ allowOrigin: PREVIEW_ORIGIN, fontDir: fontsDir });
  try {
    await loadApp(page, serve.baseUrl);

    // Both picks load from real bytes; then the donor FILE vanishes
    // from the service's font directory. The connect-time /fonts index
    // still names it, so the submission goes through and the BUILD
    // itself fails — the row surfaces the service's own error inline.
    await loadPicks(page, fontsDir, "Alpha.ttf", "Slow.ttf");
    await unlink(path.join(fontsDir, "Slow.ttf"));

    const synthesize = synthesizeButton(page);
    await expect(synthesize).toHaveAttribute("aria-disabled", "false");
    await pointerClick(page, synthesize);

    const panel = page.locator('[data-testid="build-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel.locator("[data-build-stage]").first()).toContainText(
      "失败",
      { timeout: 60_000 },
    );
    await expect(panel.locator("[data-build-error]").first()).toContainText(
      "Slow.ttf",
    );

    assertNoJsErrors(errors);
  } finally {
    await serve.stop();
  }
});

test("the CORS contract: the flow works only from the configured origin", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  const gate = collectJsErrors(page, errors);

  const serve = await startServe({ allowOrigin: OTHER_ORIGIN });
  try {
    // Direct evidence at the HTTP layer: the preview origin's preflight
    // is rejected outright (no ACAO, 403), so no browser from the
    // preview origin may even submit the actual POST.
    const preflight = await request.fetch(`${serve.baseUrl}/builds`, {
      method: "OPTIONS",
      headers: {
        Origin: PREVIEW_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type",
      },
    });
    expect(preflight.status()).toBe(403);
    expect(preflight.headers()["access-control-allow-origin"]).toBeUndefined();

    // ...while the configured origin's preflight is answered.
    const allowed = await request.fetch(`${serve.baseUrl}/builds`, {
      method: "OPTIONS",
      headers: {
        Origin: OTHER_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type",
      },
    });
    expect(allowed.status()).toBe(204);
    expect(allowed.headers()["access-control-allow-origin"]).toBe(OTHER_ORIGIN);

    // Browser evidence: the workspace's probe from the preview origin
    // is blocked by CORS (the service answers without allowing it), so
    // the synthesize flow degrades to the no-service CLI panel. The
    // browser's own blocked-fetch console line is declared benign per
    // suite policy.
    allowProbeRefusal(gate, serve.baseUrl);
    await loadApp(page, serve.baseUrl);

    await expect(synthesizeButton(page)).toHaveAttribute("aria-disabled", "true");
    const panel = await openCliPanel(page);
    const notice = panel.locator('[data-testid="service-notice"]');
    await expect(notice).toContainText("未检测到本地服务");
    await expect(panel.locator('[data-testid="copy-command"]')).toBeVisible();
    await expect(page.locator('[data-testid="build-panel"]')).toBeHidden();

    assertNoJsErrors(errors);
  } finally {
    await serve.stop();
  }
});
