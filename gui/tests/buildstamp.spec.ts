import { expect, test } from "@playwright/test";

/**
 * Round 22 (owner item 3): the dev build stamp — commit + build time
 * at the top bar's end, so a stale window is recognizable at a glance
 * (the round-15/16 stale-window lesson). Dev-only by construction; the
 * e2e suite runs the dev server, so the stamp must be present and
 * informative there.
 */
test("the dev top bar carries the build stamp", async ({ page }) => {
  await page.goto("/");
  const stamp = page.locator("[data-role='build-stamp']");
  await expect(stamp).toBeVisible();
  await expect(stamp).toHaveText(/^v0\.1\.0 · [0-9a-f]{7} · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  // Dim and never interactive: it carries no pointer cursor and its
  // computed user-select is none.
  await expect
    .poll(() => stamp.evaluate((el) => getComputedStyle(el).userSelect))
    .toBe("none");
});
