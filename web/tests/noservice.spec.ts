import { expect, test } from "@playwright/test";
import {
  allowProbeRefusal,
  assertNoJsErrors,
  collectJsErrors,
  openCliPanel,
  openFontPicker,
  optOutOfCatalog,
  pointerClick,
  UNUSED_SERVE,
  waitForFontsReady,
} from "./helpers";

/**
 * The absorbed recipe builder (issue #22 → repair round 2; core
 * unification ticket #29): when no service is detected, the synthesize
 * flow offers the copy-CLI command and the recipe JSON download in the
 * workspace's own no-service panel. The recipe is built from the SAME
 * workspace state the live flow submits (picks → base/donor, rail
 * rules, settings, the top bar's output name) through the SAME
 * wire-JSON serializer the serve submission uses — the downloaded file
 * is byte-for-byte the POST /builds body shape, so the CLI command
 * (`fontalloy build <file>`, YAML being a JSON superset) runs exactly
 * what the service would have run.
 *
 * Ticket #29: there is NO client-side validation mirror anymore. The
 * serve's submit-time validation is the only gate; this panel emits
 * the draft as declared. The one blocked state is no recipe at all
 * (a pick missing) — workspace state, not recipe validation.
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
  // Ticket #29: the recipe surface is the wire JSON — the YAML writer
  // and the client-side validation mirror (the problems list) are gone.
  await expect(panel.locator('[data-testid="recipe-json"]')).toBeVisible();
  await expect(panel.locator('[data-testid="problems"]')).toHaveCount(0);
  await expect(panel).not.toContainText("YAML");
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

test("a missing pick blocks copy/download; a serve-less browser load states its reason", async ({
  page,
}) => {
  const panel = await openCliPanel(page);
  // No picks: no recipe at all — the JSON preview stays empty and the
  // status line names the missing picks. This is workspace state (a
  // pick missing), the only gate left after the validation mirror died
  // (ticket #29): the serve's submit-time validation owns everything
  // recipe-shaped.
  await expect(panel.locator('[data-testid="copy-command"]')).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(panel.locator('[data-testid="download-recipe"]')).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(panel.locator('[data-testid="recipe-json"]')).toHaveText("");
  await expect(panel.locator('[data-testid="copy-status"]')).toContainText(
    "请先在左侧选择英文字体与中文字体",
  );

  // Ticket #36's upload model ended the serve-less browser pick: the
  // file input's File objects have no path a recipe could name, so
  // they STREAM to the serve's upload endpoint — no serve, no load
  // (parsing font bytes in the page would be frontend business logic;
  // the core owns it). The attempt is HONEST about exactly that: the
  // picker stays open, the service-required reason rides its error
  // line, no row appears, and the panel's missing-pick gate above is
  // unchanged. The enabled-with-picks contract is the catalog flow's —
  // catalog.spec pins it with real fetch-layout picks.
  const popup = await openFontPicker(page, "en");
  const fontsDir = await import("./serve").then((m) => m.serveFixtureDir());
  const nodePath = await import("node:path");
  await page
    .locator("input[data-role='font-file']")
    .setInputFiles(nodePath.join(fontsDir, "Alpha.ttf"));
  const error = popup.locator("[data-picker-error]");
  await expect(error).toBeVisible();
  await expect(error).toContainText("本地字体加载需要本地服务");
  await expect(popup.locator(".kit-fp")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // The failed attempt changed no workspace state: still no recipe, so
  // the buttons stay disabled and the status line still names the
  // missing picks.
  await expect(panel.locator('[data-testid="copy-command"]')).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(panel.locator('[data-testid="recipe-json"]')).toHaveText("");
  await expect(panel.locator('[data-testid="copy-status"]')).toContainText(
    "请先在左侧选择英文字体与中文字体",
  );
});
