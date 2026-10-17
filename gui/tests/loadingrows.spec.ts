// Round 30 pin: the pickers' catalog loading window is VISIBLE — a
// disabled 内置目录准备中… row heads the list while the release
// document is being fetched and the stored families verified, never a
// silent empty list. Fully deterministic: the release-document fetch
// is held by a route until the test releases it.
// (No faked Tauri marker here — it would route createStorage onto the
// desktop IPC path and fail the catalog instantly; the system-font
// scan row rides the same rendering rule and is exercised live.)
import { test, expect } from "@playwright/test";
import { collectJsErrors, pointerClick, waitForFontsReady } from "./helpers";

test.setTimeout(60_000);

test("the picker states its catalog loading window", async ({ page }) => {
  const jsErrors: string[] = [];
  collectJsErrors(page, jsErrors);

  let releaseCatalog: (() => void) | null = null;
  await page.route("**/catalog-release.json", async (route) => {
    await new Promise<void>((resolve) => {
      releaseCatalog = resolve;
    });
    await route.fulfill({ status: 404 });
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __FONTALLOY_CONFIG__?: Record<string, unknown> };
    w.__FONTALLOY_CONFIG__ ??= {};
    // Same-origin path: a cross-origin fake host would need CORS
    // headers the route cannot add, and the fetch would fail before
    // the loading window ever shows.
    w.__FONTALLOY_CONFIG__.catalogBootstrapUrl =
      "/slow-catalog/catalog-release.json";
  });

  await page.goto("/");
  await waitForFontsReady(page);
  await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
  const popup = page.locator('[data-picker-popup="en"]');
  await expect(popup).toBeVisible();

  // The bootstrapping window states itself — never a silent empty list.
  await expect(
    popup.locator(".kit-fp", { hasText: "内置目录准备中…" }),
  ).toBeVisible();

  // The catalog settles (the held fetch 404s): the loading row stands
  // down and the offline note takes over.
  releaseCatalog!();
  await expect(
    popup.locator(".kit-fp", { hasText: "内置目录准备中…" }),
  ).toBeHidden({ timeout: 15_000 });
  await expect(popup).toContainText("目录不可用");

  // The deliberate 404 logs one browser resource error — everything
  // else must be clean.
  expect(
    jsErrors.filter((line) => !line.includes("404")),
  ).toEqual([]);
});
