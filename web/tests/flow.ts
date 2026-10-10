import { expect, type Page } from "@playwright/test";
import { openListbox, pickOption, pointerClick } from "./helpers";

/**
 * Drive the builder to the fixture-equivalent state
 * (web/tests/fixtures/sample-recipe.yaml): base MapleMono NF-CN, donors
 * LXGW WenKai + a face-1 TTC reference, rules preset-ja / range /
 * codepoint, output "My Merged Font" (normalized on write).
 *
 * Everything through real pointer interactions with the pickers.
 */
export async function driveFixtureState(page: Page): Promise<void> {
  // Base: MapleMono NF-CN from the catalog, fixture path.
  const baseAnchor = page.locator('[data-role="base-catalog"]');
  const basePopup = await openListbox(page, baseAnchor, "base-catalog");
  await basePopup.locator(".wb-search-input").fill("MapleMono NF-CN");
  await pickOption(page, basePopup, "MapleMono::NF-CN");
  await page
    .locator('[data-role="base-path"]')
    .fill("fonts/MapleMono-NF-CN/MapleMonoNerdFont-CN-Regular.ttf");

  // Donor 0: LXGW WenKai Regular.
  await pointerClick(page, page.locator('[data-role="add-donor"]'));
  const d0Anchor = page.locator('[data-role="donor-catalog-0"]');
  const d0Popup = await openListbox(page, d0Anchor, "donor-catalog-0");
  await d0Popup.locator(".wb-search-input").fill("LXGWWenKai");
  await pickOption(page, d0Popup, "LXGWWenKai::Regular");
  await page
    .locator('[data-role="donor-path-0"]')
    .fill("fonts/LXGWWenKai/LXGWWenKai-Regular.ttf");

  // Donor 1: a TTC reference with face index 1.
  await pointerClick(page, page.locator('[data-role="add-donor"]'));
  await page
    .locator('[data-role="donor-path-1"]')
    .fill("fonts/SourceHanSans/SourceHanSansSC-Regular.ttc");
  await page.locator('[data-role="donor-face-1"]').fill("1");

  // Rule 1: preset ja -> [donor-0].
  await pointerClick(page, page.locator('[data-role="add-rule"]'));
  const presetAnchor = page.locator('[data-role="rule-preset-1"]');
  const presetPopup = await openListbox(page, presetAnchor, "rule-preset-1");
  await presetPopup.locator(".wb-search-input").fill("ja");
  await pickOption(page, presetPopup, "ja");
  await expect(presetAnchor).toContainText("ja");
  await pointerClick(page, page.locator('[data-role="rule-font-1-donor-0"]'));

  // Rule 2: range 0x2100-0x214F -> [base, donor-1].
  await pointerClick(page, page.locator('[data-role="add-rule"]'));
  await page.locator('[data-role="rule-kind-2"]').selectOption("range");
  await page.locator('[data-role="rule-range-start-2"]').fill("0x2100");
  await page.locator('[data-role="rule-range-end-2"]').fill("0x214F");
  await pointerClick(page, page.locator('[data-role="rule-font-2-base"]'));
  await pointerClick(page, page.locator('[data-role="rule-font-2-donor-1"]'));

  // Rule 3: codepoint 0x4E2D -> [donor-1].
  await pointerClick(page, page.locator('[data-role="add-rule"]'));
  await page.locator('[data-role="rule-kind-3"]').selectOption("codepoint");
  await page.locator('[data-role="rule-codepoint-3"]').fill("0x4E2D");
  await pointerClick(page, page.locator('[data-role="rule-font-3-donor-1"]'));

  // Output: family with spaces (normalized on write), format default.
  await page.locator('[data-role="output-family"]').fill("My Merged Font");
}
