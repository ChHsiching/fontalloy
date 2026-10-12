import { expect, test } from "@playwright/test";
import {
  allowProbeRefusal,
  assertNoJsErrors,
  collectJsErrors,
  loadLocalFont,
  openCliPanel,
  optOutOfCatalog,
  pointerClick,
  UNUSED_SERVE,
  waitForFontsReady,
} from "./helpers";

/**
 * The absorbed recipe builder (issue #22 → repair round 2): when no
 * service is detected, the synthesize flow offers the copy-CLI command
 * and the recipe YAML download in the workspace's own no-service panel.
 * The recipe is built from the SAME workspace state the live flow
 * submits (picks → base/donor, rail rules, settings, the top bar's
 * output name), so the YAML/command assertions here are the semantic
 * YAML coverage the old builder specs carried (adjusted: donors are the
 * workspace's pick pair, not an editable donor list).
 */

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  const gate = collectJsErrors(page, errors);
  allowProbeRefusal(gate, UNUSED_SERVE);
  await optOutOfCatalog(page);
  await page.goto(`/?serve=${encodeURIComponent(UNUSED_SERVE)}`);
  await waitForFontsReady(page);
});

test("no service: the synthesize flow offers the CLI panel as page text", async ({
  page,
}) => {
  const panel = await openCliPanel(page);
  // Round 7 (logo adoption): the panel head carries the brand mark, and
  // the web target ships the mark as an inline SVG favicon (a data URI,
  // so nothing can 404 into the console gate).
  await expect(panel.locator(".cli-head .kit-brand-mark")).toBeVisible();
  const iconHref = await page.evaluate(() => {
    const el = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    return el?.href ?? "";
  });
  expect(iconHref.startsWith("data:image/svg+xml,")).toBe(true);
  const notice = panel.locator('[data-testid="service-notice"]');
  await expect(notice).toContainText("fontalloy serve");
  await expect(notice).toContainText("127.0.0.1");
  await expect(notice).toContainText("复制 CLI 命令");
  // The statement says WHY: no service was detected at the address.
  await expect(notice).toContainText("未检测到本地服务");
  await expect(notice).toContainText(UNUSED_SERVE);

  await expect(panel.locator('[data-testid="cli-command"]')).toContainText(
    "fontalloy build",
  );
  // The live-merge surface (the build panel) stays out of the
  // no-service rendering.
  await expect(page.locator('[data-testid="build-panel"]')).toBeHidden();
});

test("absent service: the re-probe affordance is click-reachable", async ({
  page,
}) => {
  const errors: string[] = [];
  const gate = collectJsErrors(page, errors);
  allowProbeRefusal(gate, UNUSED_SERVE);

  const panel = await openCliPanel(page);
  const reprobe = panel.locator('[data-testid="reprobe"]');
  await expect(reprobe).toBeVisible();

  // Clicking re-probes (the refused fetch is redeclared benign); the
  // panel stays honest about still being without a service.
  await pointerClick(page, reprobe);
  await expect(panel.locator('[data-testid="service-notice"]')).toContainText(
    "未检测到本地服务",
  );

  assertNoJsErrors(errors);
});

test("an incomplete pair blocks copy/download with a visible problem list", async ({
  page,
}) => {
  const panel = await openCliPanel(page);
  const problems = panel.locator('[data-testid="problems"]');
  // No picks: no recipe at all — the YAML preview stays empty, the
  // problems state the unresolvable paths, and the status line names
  // the missing picks.
  await expect(problems).toContainText("基底字体：缺少字体文件路径");
  await expect(panel.locator('[data-testid="copy-command"]')).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(panel.locator('[data-testid="download-recipe"]')).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(panel.locator('[data-testid="recipe-yaml"]')).toHaveText("");
  await expect(panel.locator('[data-testid="copy-status"]')).toContainText(
    "请先在左侧选择英文字体与中文字体",
  );

  // A browser-loaded local font has no path the recipe could name:
  // with the EN pick made from a local file, the empty-path problem is
  // the precise statement for exactly that pick.
  const fontsDir = await import("./serve").then((m) => m.serveFixtureDir());
  const alpha = (await import("node:path")).join(fontsDir, "Alpha.ttf");
  await loadLocalFont(page, "en", alpha);
  await expect(problems).toContainText("基底字体：缺少字体文件路径");
  await expect(problems).toContainText("供体 1：缺少字体文件路径");
});
