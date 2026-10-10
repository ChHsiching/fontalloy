import { expect, test, type Page, type Request } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  allowProbeRefusal,
  assertNoJsErrors,
  collectJsErrors,
  pointerClick,
  waitForFontsReady,
  type ErrorGate,
} from "./helpers";
import {
  OTHER_ORIGIN,
  PREVIEW_ORIGIN,
  serveFixtureDir,
  startServe,
} from "./serve";

/**
 * Issue #22 — the WebApp drives REAL merges through a real
 * `fontalloy serve` instance: detection on load, recipe submission (the
 * serve JSON contract), progress while the build runs, artifact + report
 * download, inline failure surfacing, and the CORS boundary (the flow
 * works only from the origin serve was configured to allow).
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
  await page.goto(`/?serve=${webAddress(baseUrl)}`);
  await waitForFontsReady(page);
}

/** Fill the builder with the absolute fixture base + donor paths. */
async function fillRecipe(
  page: Page,
  fontsDir: string,
  entries: { base: string; donors: string[] },
): Promise<void> {
  await page.locator('[data-role="base-path"]').fill(entries.base);
  for (const [index, donor] of entries.donors.entries()) {
    if (index === 0) await pointerClick(page, page.locator('[data-role="add-donor"]'));
    await page.locator(`[data-role="donor-path-${index}"]`).fill(donor);
  }
}

/** Absolute, forward-slash fixture paths (serve wants absolute paths). */
function fixturePath(fontsDir: string, name: string): string {
  return path.join(fontsDir, name).split(path.sep).join("/");
}

/** The exact POST /builds body the builder must submit for the draft. */
function expectedBody(base: string, donors: string[]): Record<string, unknown> {
  return {
    base,
    donors,
    rules: [],
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

test("detects the service, runs the merge live with progress, downloads font and report", async ({
  page,
}) => {
  const errors: string[] = [];
  collectJsErrors(page, errors);

  const fontsDir = await serveFixtureDir();
  const serve = await startServe({ allowOrigin: PREVIEW_ORIGIN, fontDir: fontsDir });
  try {
    await loadApp(page, serve.baseUrl);

    // Detection on load: the chip and the notice both reflect connected.
    await expect(page.locator('[data-testid="service-chip"]')).toHaveText(
      "本地服务：已连接",
    );
    const notice = page.locator('[data-testid="service-notice"]');
    await expect(notice).toContainText("已连接本地服务");
    await expect(notice).toContainText(serve.baseUrl);

    // The live merge action exists and is gated on a complete draft.
    const mergeButton = page.locator('[data-testid="live-merge"]');
    await expect(mergeButton).toBeVisible();
    await expect(mergeButton).toHaveAttribute("aria-disabled", "true");
    await expect(page.locator('[data-testid="live-merge-panel"]')).toBeVisible();

    // Base + the SLOW donor: the wide CJK block keeps the build in
    // flight for seconds, so polled progress is assertable, not racy.
    const base = fixturePath(fontsDir, "Alpha.ttf");
    const slow = fixturePath(fontsDir, "Slow.ttf");
    await fillRecipe(page, fontsDir, { base, donors: [slow] });
    await expect(page.locator('[data-testid="problems"]')).toBeEmpty();
    await expect(mergeButton).toHaveAttribute("aria-disabled", "false");

    const bodyPromise = captureBuildRequest(page);
    await pointerClick(page, mergeButton);

    // The submitted body IS the serve recipe contract, pinned verbatim.
    await expect(await bodyPromise).toEqual(expectedBody(base, [slow]));

    // Progress: the journal is append-only, so observing the in-flight
    // line after the fact is race-free history, not timing luck.
    const journal = page.locator('[data-testid="live-journal"]');
    const status = page.locator('[data-testid="live-status"]');
    await expect(status).toContainText(/完成|进行中|排队/);
    await expect(status).toContainText("完成", { timeout: 60_000 });
    await expect(journal).toContainText(/进行中/);
    await expect(journal).toContainText("已提交");

    // Done: the artifact facts render before any download.
    const result = page.locator('[data-testid="live-result"]');
    await expect(result).toContainText("ChHsich.ttf");
    await expect(result).toContainText("sha256");

    // The report renders from the machine JSON (what serve returned).
    await expect(page.locator('[data-testid="live-report"]')).toContainText("码位");

    // Download the output font — real bytes, TTF magic.
    const [fontDownload] = await Promise.all([
      page.waitForEvent("download"),
      pointerClick(page, page.locator('[data-testid="download-font"]')),
    ]);
    expect(await fontDownload.suggestedFilename()).toBe("ChHsich.ttf");
    const fontBytes = await readFile((await fontDownload.path())!);
    expect(fontBytes.length).toBeGreaterThan(0);
    expect(fontBytes.subarray(0, 4)).toEqual(Buffer.from([0x00, 0x01, 0x00, 0x00]));

    // Download the verification report — the machine JSON document.
    const [reportDownload] = await Promise.all([
      page.waitForEvent("download"),
      pointerClick(page, page.locator('[data-testid="download-report"]')),
    ]);
    expect(await reportDownload.suggestedFilename()).toBe("ChHsich.report.json");
    const report = JSON.parse(
      (await readFile((await reportDownload.path())!)).toString("utf8"),
    ) as { schema: string; provenance: unknown[] };
    expect(report.schema).toMatch(/^fontalloy\/verification-report@v/);
    expect(report.provenance.length).toBeGreaterThan(0);

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
    await expect(page.locator('[data-testid="service-chip"]')).toHaveText(
      "本地服务：已连接",
    );

    // A syntactically valid recipe pointing at a font that does not
    // exist: serve accepts the submission, the build itself fails.
    const missing = fixturePath(fontsDir, "does-not-exist.ttf");
    await page.locator('[data-role="base-path"]').fill(missing);
    await expect(page.locator('[data-testid="problems"]')).toBeEmpty();
    await pointerClick(page, page.locator('[data-testid="live-merge"]'));

    const failure = page.locator('[data-testid="live-error"]');
    await expect(failure).toBeVisible({ timeout: 60_000 });
    await expect(failure).toContainText("does-not-exist.ttf");
    // The status line states the failure, it does not hide it.
    await expect(page.locator('[data-testid="live-status"]')).toContainText("失败");

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
  const gate: ErrorGate = collectJsErrors(page, errors);

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

    // Browser evidence: the page's probe from the preview origin is
    // blocked by CORS (the service answers without allowing it), so the
    // WebApp degrades to the copy-CLI fallback. The browser's own
    // blocked-fetch console line is declared benign per suite policy.
    allowProbeRefusal(gate, serve.baseUrl);
    await loadApp(page, serve.baseUrl);

    await expect(page.locator('[data-testid="service-chip"]')).toHaveText(
      /本地服务：未连接/,
      { timeout: 10_000 },
    );
    const notice = page.locator('[data-testid="service-notice"]');
    await expect(notice).toContainText("未检测到本地服务");
    await expect(page.locator('[data-testid="copy-command"]')).toBeVisible();
    await expect(page.locator('[data-testid="live-merge-panel"]')).toBeHidden();

    assertNoJsErrors(errors);
  } finally {
    await serve.stop();
  }
});
