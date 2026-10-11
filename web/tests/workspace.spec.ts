import { expect, test } from "@playwright/test";
import {
  allowProbeRefusal,
  assertNoJsErrors,
  collectJsErrors,
  optOutOfCatalog,
  pointerClick,
  UNUSED_SERVE,
  waitForFontsReady,
} from "./helpers";

/**
 * The unification contract (repair round 2): the static WebApp IS the
 * workspace — the same top bar, rail, stage, and status bar the GUI
 * mounts, on the built site. These specs pin the workspace frame on the
 * web target (the GUI suite pins the same frame's behavior in depth);
 * real-pointer interactions with hit-testing guards, DOM textContent
 * assertions only.
 */

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  const gate = collectJsErrors(page, errors);
  allowProbeRefusal(gate, UNUSED_SERVE);
  await optOutOfCatalog(page);
  await page.goto(`/?serve=${encodeURIComponent(UNUSED_SERVE)}`);
  await waitForFontsReady(page);
  assertNoJsErrors(errors);
});

test("the workspace frame: top bar, rail, stage, status bar", async ({
  page,
}) => {
  // The kit top bar: brand, empty pair tags (hidden sides), the GitHub
  // link, the theme toggle, the font-name field (brand default), and
  // the primary action.
  const topbar = page.locator(".topbar");
  await expect(topbar.locator(".kit-brand")).toContainText("FontAlloy");
  const github = topbar.locator("a[href*='github.com']");
  await expect(github).toContainText("ChHsiching/fontalloy");
  await expect(topbar.locator("[data-role='font-pair']")).toHaveCount(1);
  await expect(topbar.locator("[data-pair='base']")).toBeHidden();
  await expect(topbar.locator("[data-pair='donor']")).toBeHidden();
  await expect(topbar.locator("[data-role='font-name']")).toHaveValue(
    "ChHsich",
  );
  const synthesize = topbar.locator("[data-role='synthesize']");
  await expect(synthesize).toBeVisible();
  await expect(synthesize).toHaveAttribute("aria-disabled", "true");

  // The rail's five sections, in the prototype's order and wording.
  const titles = page.locator(".workspace-rail .section-title");
  await expect(titles).toHaveText([
    "英文字体",
    "中文字体",
    "文字范围",
    "自定义规则",
    "合成设置",
  ]);

  // The stage's mode bar and the status bar.
  await expect(
    page.locator(".kit-modebar .kit-mseg [data-value='charmap']"),
  ).toBeVisible();
  await expect(page.locator(".kit-modebar .kit-mseg [data-value='scene']")).toBeVisible();
  const stats = page.locator(".statsbar");
  await expect(stats).toBeVisible();
  expect((await stats.textContent()) ?? "").toContain("字符");
});

test("the theme toggle flips the app theme through the kit tokens", async ({
  page,
}) => {
  const before = await page.evaluate(() => document.documentElement.dataset.theme);
  await pointerClick(page, page.locator(".topbar [data-role='theme-toggle']"));
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => document.documentElement.dataset.theme);
  expect(after).not.toBe(before);
  const pageColor = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--page").trim(),
  );
  expect(pageColor.length).toBeGreaterThan(0);
});

test("the mode bar switches the stage between charmap and scenes", async ({
  page,
}) => {
  await pointerClick(
    page,
    page.locator(".kit-modebar .kit-mseg [data-value='scene']"),
  );
  await expect(page.locator(".scenes")).toBeVisible();
  await expect(page.locator(".charmap")).toHaveCount(0);

  await pointerClick(
    page,
    page.locator(".kit-modebar .kit-mseg [data-value='charmap']"),
  );
  await expect(page.locator(".charmap")).toBeVisible();
  await expect(page.locator(".scenes")).toHaveCount(0);
});

test("absent service with an intercepted default-address probe degrades identically", async ({
  page,
}) => {
  const errors: string[] = [];
  const gate = collectJsErrors(page, errors);
  // Deterministic failure without any port race: the default-address
  // probe is intercepted and aborted (seam-3 notes §7).
  await page.route("http://127.0.0.1:7777/**", (route) => route.abort());
  allowProbeRefusal(gate, "http://127.0.0.1:7777");

  await optOutOfCatalog(page);
  await page.goto("/");
  await waitForFontsReady(page);

  const synthesize = page.locator(".topbar [data-role='synthesize']");
  await expect(synthesize).toHaveAttribute("aria-disabled", "true");
  await pointerClick(page, synthesize);
  const panel = page.locator('[data-testid="cli-panel"]');
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-testid="service-notice"]')).toContainText(
    "未检测到本地服务",
  );

  assertNoJsErrors(errors);
});
