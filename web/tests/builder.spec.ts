import { expect, test } from "@playwright/test";
import {
  allowProbeRefusal,
  assertNoJsErrors,
  cliCommand,
  collectJsErrors,
  openListbox,
  pickOption,
  pointerClick,
  waitForFontsReady,
  yamlPreview,
} from "./helpers";
import { driveFixtureState } from "./flow";

/**
 * The recipe-builder experience on the built static site: catalog
 * base/donor selection, the no-service fallback rendering, validation
 * gating, download, and the copy-CLI path. Real pointer events with
 * hit-testing guards; DOM textContent assertions only.
 *
 * Since issue #22 the page probes the local service on load; these
 * tests run against an address nothing answers on, so the degraded
 * rendering is the REAL refused-connection path (the browser's own
 * console line for the refused probe is declared benign per the
 * suite's error-gate policy).
 */

/** A loopback address nothing listens on (deterministic absence). */
const UNUSED_SERVE = "http://127.0.0.1:59999";

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  const gate = collectJsErrors(page, errors);
  allowProbeRefusal(gate, UNUSED_SERVE);
  await page.goto(`/?serve=${encodeURIComponent(UNUSED_SERVE)}`);
  await waitForFontsReady(page);
  assertNoJsErrors(errors);
});

test("no-service state: the copy-CLI fallback is the default rendering", async ({
  page,
}) => {
  const notice = page.locator('[data-testid="service-notice"]');
  await expect(notice).toBeVisible();
  const text = await notice.textContent();
  expect(text).toContain("fontalloy serve");
  expect(text).toContain("127.0.0.1");
  expect(text).toContain("复制 CLI 命令");
  // The statement says WHY: no service was detected at the address.
  expect(text).toContain("未检测到本地服务");
  expect(text).toContain(UNUSED_SERVE);

  await expect(page.locator('[data-testid="service-chip"]')).toHaveText(
    /本地服务：未连接/,
  );
  await expect(page.locator('[data-testid="copy-command"]')).toBeVisible();
  await expect(cliCommand(page)).toContainText("fontalloy build");
  // The live-merge surface stays out of the degraded rendering.
  await expect(page.locator('[data-testid="live-merge-panel"]')).toBeHidden();
});

test("absent service: the re-probe affordance is click-reachable", async ({
  page,
}) => {
  const errors: string[] = [];
  const gate = collectJsErrors(page, errors);
  allowProbeRefusal(gate, UNUSED_SERVE);

  const reprobe = page.locator('[data-testid="reprobe"]');
  await expect(reprobe).toBeVisible();
  await expect(page.locator('[data-testid="service-chip"]')).toHaveText(
    /本地服务：未连接/,
  );

  // Clicking re-probes (the refused fetch is redeclared benign); the
  // page stays honest about still being without a service.
  await pointerClick(page, reprobe);
  await expect(page.locator('[data-testid="service-chip"]')).toHaveText(
    /本地服务：未连接/,
  );
  await expect(page.locator('[data-testid="service-notice"]')).toContainText(
    "未检测到本地服务",
  );

  assertNoJsErrors(errors);
});

test("absent service with an intercepted probe degrades identically", async ({
  page,
}) => {
  const errors: string[] = [];
  const gate = collectJsErrors(page, errors);
  // Deterministic failure without any port race: the default-address
  // probe is intercepted and aborted (seam-3 notes §7).
  await page.route("http://127.0.0.1:7777/**", (route) => route.abort());
  allowProbeRefusal(gate, "http://127.0.0.1:7777");

  await page.goto("/");
  await waitForFontsReady(page);

  await expect(page.locator('[data-testid="service-chip"]')).toHaveText(
    /本地服务：未连接/,
  );
  const notice = page.locator('[data-testid="service-notice"]');
  await expect(notice).toContainText("未检测到本地服务");
  await expect(page.locator('[data-testid="copy-command"]')).toBeVisible();
  await expect(cliCommand(page)).toContainText("fontalloy build");

  assertNoJsErrors(errors);
});

test("base and donors select from the catalog through the real picker", async ({
  page,
}) => {
  const baseAnchor = page.locator('[data-role="base-catalog"]');
  await expect(baseAnchor).toContainText("从目录选择基底字体…");

  const popup = await openListbox(page, baseAnchor, "base-catalog");
  const search = popup.locator(".wb-search-input");
  await search.fill("MapleMono NF-CN");
  await pickOption(page, popup, "MapleMono::NF-CN");

  await expect(baseAnchor).toContainText("MapleMono · NF-CN");
  // The path seeds with the fetch-layout hint for the picked family.
  await expect(page.locator('[data-role="base-path"]')).toHaveValue(
    "fonts/MapleMono-NF-CN/",
  );

  // A donor picks through the same popup pattern.
  await pointerClick(page, page.locator('[data-role="add-donor"]'));
  const donorAnchor = page.locator('[data-role="donor-catalog-0"]');
  const donorPopup = await openListbox(page, donorAnchor, "donor-catalog-0");
  await donorPopup.locator(".wb-search-input").fill("LXGWWenKai");
  await pickOption(page, donorPopup, "LXGWWenKai::Regular");
  await expect(donorAnchor).toContainText("LXGWWenKai · Regular");
});

test("output naming mirrors the core validation with instant feedback", async ({
  page,
}) => {
  const family = page.locator('[data-role="output-family"]');
  const feedback = page.locator('[data-role="output-family-feedback"]');

  // The fixed brand default ships prefilled.
  await expect(family).toHaveValue("ChHsich");
  await expect(feedback).toContainText("ChHsich");
  await expect(feedback).not.toHaveClass(/is-error/);

  // Spaces convert to hyphens rather than being rejected.
  await family.fill("My Merged Font");
  await expect(feedback).toContainText("将写入为：My-Merged-Font");
  await expect(feedback).not.toHaveClass(/is-error/);

  // Non-ASCII is rejected with a visible, click-reachable message.
  await family.fill("霞鹜");
  await expect(feedback).toHaveClass(/is-error/);
  await expect(feedback).toContainText("ASCII");

  // Over-length is rejected against the 31-character limit.
  await family.fill("A".repeat(32));
  await expect(feedback).toHaveClass(/is-error/);
  await expect(feedback).toContainText("31");
});

test("an incomplete draft blocks download/copy with a visible problem list", async ({
  page,
}) => {
  const problems = page.locator('[data-testid="problems"]');
  await expect(problems.locator("li").first()).toContainText("基底字体");
  await expect(page.locator('[data-testid="copy-command"]')).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(page.locator('[data-testid="download-recipe"]')).toHaveAttribute(
    "aria-disabled",
    "true",
  );

  // Completing the state clears the gate.
  await page.locator('[data-role="base-path"]').fill("fonts/Base-Regular.ttf");
  await expect(problems).toBeEmpty();
  await expect(page.locator('[data-testid="copy-command"]')).toHaveAttribute(
    "aria-disabled",
    "false",
  );
});

test("download produces the recipe file; copy falls back to a reachable state", async ({
  page,
  browserName,
}) => {
  await page.locator('[data-role="base-path"]').fill("fonts/Base-Regular.ttf");

  const previewText = await yamlPreview(page).textContent();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    pointerClick(page, page.locator('[data-testid="download-recipe"]')),
  ]);
  expect(await download.suggestedFilename()).toBe("ChHsich.yaml");
  const downloaded = (await download.path())!;
  const { readFile } = await import("node:fs/promises");
  expect((await readFile(downloaded, "utf8")).replace(/\r\n/g, "\n")).toBe(
    previewText,
  );

  // Copy: clipboard API when the browser grants it, otherwise the
  // click-reachable selection fallback — both states are page text.
  await pointerClick(page, page.locator('[data-testid="copy-command"]'));
  const status = page.locator('[data-testid="copy-status"]');
  await expect(status).toBeVisible();
  void browserName;
  await expect(status).toContainText(/已复制到剪贴板|请按 Ctrl\+C/);
  // The command itself stays as readable DOM text either way.
  await expect(cliCommand(page)).toContainText("fontalloy build ChHsich.yaml");
});

test("normalization switches and weight slots cover the landed recipe schema", async ({
  page,
}) => {
  const YAMLmod = await import("yaml");
  const preview = yamlPreview(page);

  // At the core defaults neither block is written (omission IS default).
  expect(await preview.textContent()).not.toContain("normalization:");
  expect(await preview.textContent()).not.toContain("weights:");

  // Base + a donor, so the draft is valid and per-donor weight
  // overrides become reachable.
  await page
    .locator('[data-role="base-path"]')
    .fill("fonts/MapleMono-NF-CN/MapleMonoNerdFont-CN-Regular.ttf");
  await pointerClick(page, page.locator('[data-role="add-donor"]'));
  await page
    .locator('[data-role="donor-path-0"]')
    .fill("fonts/LXGWWenKai/LXGWWenKai-Regular.ttf");

  // Normalization: optical mode reveals the ratio; defaults-omission
  // becomes an explicit non-default block.
  await page.locator('[data-role="normalization-mode"]').selectOption("optical");
  await expect(page.locator('[data-role="normalization-ratio"]')).toBeVisible();
  await page.locator('[data-role="normalization-ratio"]').fill("1.3");
  await page.locator('[data-role="normalization-quote-dash"]').selectOption("fullwidth");

  let recipe = YAMLmod.default.parse(await preview.textContent());
  expect(recipe.normalization).toEqual({
    mode: "optical",
    optical_ratio: 1.3,
    quote_dash_width: "fullwidth",
  });

  // Weight matrix: slot 1 at the default 400 upright; slot 2 italic 700
  // with an explicit donor-0 demand.
  await pointerClick(page, page.locator('[data-role="add-weight-slot"]'));
  await pointerClick(page, page.locator('[data-role="add-weight-slot"]'));
  await page.locator('[data-role="weight-slot-weight-1"]').fill("400");
  await page.locator('[data-role="weight-slot-weight-2"]').fill("700");
  await page.locator('[data-role="weight-slot-style-2"]').selectOption("italic");
  await page.locator('[data-role="weight-override-2-donor-0"]').fill("700");

  recipe = YAMLmod.default.parse(await preview.textContent());
  expect(recipe.weights).toEqual([
    { weight: 400 },
    { weight: 700, style: "italic", donors: { "donor-0": 700 } },
  ]);

  // Back to grid mode: the mode/ratio collapse away, but the still
  // non-default fullwidth policy correctly remains written.
  await page.locator('[data-role="normalization-mode"]').selectOption("grid");
  recipe = YAMLmod.default.parse(await preview.textContent());
  expect(recipe.normalization).toEqual({ quote_dash_width: "fullwidth" });
  expect(recipe.weights).toBeDefined();

  await expect(page.locator('[data-testid="problems"]')).toBeEmpty();
});

test("zero JS errors across a full builder interaction", async ({ page }) => {
  const errors: string[] = [];
  const gate = collectJsErrors(page, errors);
  // The probe may still be in flight when this second sink attaches.
  allowProbeRefusal(gate, UNUSED_SERVE);

  await driveFixtureState(page);
  await expect(page.locator('[data-testid="problems"]')).toBeEmpty();

  assertNoJsErrors(errors);
});
