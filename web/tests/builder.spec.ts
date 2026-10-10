import { expect, test } from "@playwright/test";
import {
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
 */

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  collectJsErrors(page, errors);
  await page.goto("/");
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

  await expect(page.locator('[data-testid="service-chip"]')).toHaveText(
    /本地服务：未连接/,
  );
  await expect(page.locator('[data-testid="copy-command"]')).toBeVisible();
  await expect(cliCommand(page)).toContainText("fontalloy build");
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

test("weight and normalization extension points state their status in page text", async ({
  page,
}) => {
  const sections = page.locator(".wb-section .section-title");
  await expect(sections.filter({ hasText: "字重映射" })).toBeVisible();
  await expect(sections.filter({ hasText: "规范化开关" })).toBeVisible();
  const weight = page.locator(".wb-section", { hasText: "字重映射" });
  await expect(weight).toContainText("就近匹配");
  await expect(page.locator(".wb-section", { hasText: "规范化开关" })).toContainText(
    "2 × 拉丁宽",
  );
  // The placeholder controls are disabled — visible, not yet usable.
  const disabledSelect = weight.locator("select[disabled]");
  await expect(disabledSelect).toHaveCount(1);
});

test("zero JS errors across a full builder interaction", async ({ page }) => {
  const errors: string[] = [];
  collectJsErrors(page, errors);

  await driveFixtureState(page);
  await expect(page.locator('[data-testid="problems"]')).toBeEmpty();

  assertNoJsErrors(errors);
});
