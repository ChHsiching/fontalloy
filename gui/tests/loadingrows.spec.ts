// Round 30 pin, serve-backed (ticket #30): the pickers' catalog
// loading window is VISIBLE — a disabled 内置目录准备中… row heads the
// list while the serve's catalog status is being fetched, never a
// silent empty list. Fully deterministic: the page's /catalog/status
// fetch is held by a route until the test releases it.
import { test, expect } from "@playwright/test";
import { rm } from "node:fs/promises";
import { collectJsErrors, fixtureFontPaths, pointerClick, waitForFontsReady } from "./helpers";
import { spawnServeOverFonts } from "./serve";
import { buildServeCatalogSite } from "./catalog-serve-site";

test.setTimeout(60_000);

test("the picker states its catalog loading window", async ({ page }) => {
  const jsErrors: string[] = [];
  collectJsErrors(page, jsErrors);
  // The stars refresh stays hermetic (the suite convention — a live
  // api.github.com answers 403 under rate limiting and its console
  // line would trip the gate).
  await page.route("https://api.github.com/repos/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );

  // A real serve with a real (tiny) catalog — but the PAGE's status
  // fetch is held at the route, so the boot sits in its loading window
  // for as long as the test wants.
  const [host] = fixtureFontPaths();
  const site = await buildServeCatalogSite(
    [{ family: "AlloySans", faces: [{ file: "AlloySans-Regular.ttf", fontPath: host }] }],
    { manifest: false },
  );
  const spawned = await spawnServeOverFonts(site.catalogDir, [
    "--catalog-release-origin",
    site.originUri,
    "--catalog-dir",
    site.catalogDir,
  ]);
  try {
    let releaseStatus: (() => void) | null = null;
    await page.route("**/catalog/status", async (route) => {
      await new Promise<void>((resolve) => {
        releaseStatus = resolve;
      });
      await route.fulfill({ status: 404, body: "held open, now failed" });
    });
    await page.addInitScript((serve) => {
      (window as { __FONTALLOY_CONFIG__?: unknown }).__FONTALLOY_CONFIG__ = {
        serveUrl: serve,
      };
    }, await spawned.url);

    await page.goto("/");
    await waitForFontsReady(page);
    await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
    const popup = page.locator('[data-picker-popup="en"]');
    await expect(popup).toBeVisible();

    // The loading window states itself — never a silent empty list.
    await expect(
      popup.locator(".kit-fp", { hasText: "内置目录准备中…" }),
    ).toBeVisible();

    // The catalog settles (the held fetch 404s): the loading row stands
    // down and the failure note takes over.
    releaseStatus!();
    await expect(
      popup.locator(".kit-fp", { hasText: "内置目录准备中…" }),
    ).toBeHidden({ timeout: 15_000 });
    await expect(popup.locator("[data-picker-note]")).toContainText("404");

    // The deliberate 404 logs one browser resource error — everything
    // else must be clean.
    expect(
      jsErrors.filter((line) => !line.includes("404")),
    ).toEqual([]);
  } finally {
    await spawned.dispose();
    await rm(site.root, { recursive: true, force: true });
  }
});
