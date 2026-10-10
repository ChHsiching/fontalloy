import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { assertNoJsErrors, cliCommand, collectJsErrors, waitForFontsReady, yamlPreview } from "./helpers";
import { driveFixtureState } from "./flow";

/**
 * The generated recipe YAML, asserted semantically: parse it in the
 * test and compare against the builder state — including the preset
 * rule — and against the checked-in sample that the core suite
 * (`tests/test_webapp_recipe.py`) proves parses through the strict
 * `fontalloy_core.load_recipe`. Same builder state, same merge, from
 * three directions: the page, the fixture, and the core loader.
 */

const FIXTURE = fileURLToPath(
  new URL("./fixtures/sample-recipe.yaml", import.meta.url),
);
const EXTENDED_FIXTURE = fileURLToPath(
  new URL("./fixtures/sample-recipe-extended.yaml", import.meta.url),
);

test("the builder's YAML matches the core-parseable fixture semantically", async ({
  page,
}) => {
  const errors: string[] = [];
  collectJsErrors(page, errors);
  await page.goto("/");
  await waitForFontsReady(page);

  await driveFixtureState(page);

  // A complete state: no problems, buttons enabled.
  await expect(page.locator('[data-testid="problems"]')).toBeEmpty();
  await expect(page.locator('[data-testid="copy-command"]')).toHaveAttribute(
    "aria-disabled",
    "false",
  );

  const generated = await yamlPreview(page).textContent();
  expect(generated).toBeTruthy();

  // --- semantic comparison against the builder state ---
  const recipe = YAML.parse(generated!) as Record<string, unknown>;

  expect(recipe.base).toBe(
    "fonts/MapleMono-NF-CN/MapleMonoNerdFont-CN-Regular.ttf",
  );
  expect(recipe.donors).toEqual([
    "fonts/LXGWWenKai/LXGWWenKai-Regular.ttf",
    "fonts/SourceHanSans/SourceHanSansSC-Regular.ttc#1",
  ]);

  const rules = recipe.rules as Array<Record<string, unknown>>;
  expect(rules).toHaveLength(3);

  // Preset rule: the fc-lang set reference, untouched and by name.
  expect(rules[0]).toEqual({ set: "ja", fonts: ["donor-0"] });
  // Custom range rule: hex interval string, ordered font list.
  expect(rules[1]).toEqual({
    range: "0x2100-0x214F",
    fonts: ["base", "donor-1"],
  });
  // Single-codepoint rule: a YAML 1.1 hex integer, not a string.
  expect(rules[2]).toEqual({ codepoint: 0x4e2d, fonts: ["donor-1"] });

  // Output: family normalized exactly like the core normalizes it
  // (spaces -> hyphens), format explicit.
  expect(recipe.output).toEqual({ format: "ttf", family: "My-Merged-Font" });

  // --- equality with the checked-in sample the core suite pins ---
  const fixtureText = await readFile(FIXTURE, "utf8");
  const fixtureRecipe = YAML.parse(fixtureText);
  expect(recipe).toEqual(fixtureRecipe);

  // The command reproduces the same merge from the same file name.
  await expect(cliCommand(page)).toHaveText(
    "fontalloy build My-Merged-Font.yaml",
  );

  // --- determinism: identical state re-emits identical YAML ---
  const again = await yamlPreview(page).textContent();
  expect(again).toBe(generated);

  assertNoJsErrors(errors);
});

test("font order inside a rule follows the builder's up/down edits", async ({
  page,
}) => {
  await page.goto("/");
  await waitForFontsReady(page);
  await driveFixtureState(page);

  // Rule 2 currently declares [base, donor-1]; move donor-1 above base.
  const rule = page.locator('[data-rule-id="2"]');
  await rule.locator('[data-role="rule-font-up-2-donor-1"]').click();

  const recipe = YAML.parse(
    (await yamlPreview(page).textContent())!,
  ) as Record<string, unknown>;
  const rules = recipe.rules as Array<Record<string, unknown>>;
  expect(rules[1].fonts).toEqual(["donor-1", "base"]);
});

test("the extended state matches the normalization/weights fixture the core suite pins", async ({
  page,
}) => {
  await page.goto("/");
  await waitForFontsReady(page);

  // Base + one donor.
  await page
    .locator('[data-role="base-path"]')
    .fill("fonts/MapleMono-NF-CN/MapleMonoNerdFont-CN-Regular.ttf");
  await page.locator('[data-role="add-donor"]').click();
  await page
    .locator('[data-role="donor-path-0"]')
    .fill("fonts/LXGWWenKai/LXGWWenKai-Regular.ttf");

  // Preset rule: zh_cn -> [donor-0].
  await page.locator('[data-role="add-rule"]').click();
  const presetAnchor = page.locator('[data-role="rule-preset-1"]');
  await presetAnchor.click();
  const popup = page.locator('[data-picker-popup="rule-preset-1"]');
  await expect(popup).toBeVisible();
  await popup.locator(".wb-search-input").fill("zh_cn");
  await popup.locator('[data-option-id="zh_cn"]').click();
  await page.locator('[data-role="rule-font-1-donor-0"]').click();

  // Normalization: optical 1.3 + fullwidth quotes/dashes.
  await page.locator('[data-role="normalization-mode"]').selectOption("optical");
  await page.locator('[data-role="normalization-ratio"]').fill("1.3");
  await page
    .locator('[data-role="normalization-quote-dash"]')
    .selectOption("fullwidth");

  // Weight matrix: 400 upright; 700 italic demanding donor-0 at 700.
  await page.locator('[data-role="add-weight-slot"]').click();
  await page.locator('[data-role="add-weight-slot"]').click();
  await page.locator('[data-role="weight-slot-weight-2"]').fill("400");
  await page.locator('[data-role="weight-slot-weight-3"]').fill("700");
  await page.locator('[data-role="weight-slot-style-3"]').selectOption("italic");
  await page.locator('[data-role="weight-override-3-donor-0"]').fill("700");

  // Output: family + ttc format.
  await page.locator('[data-role="output-family"]').fill("Extended-Font");
  await page.locator('[data-role="output-format"]').selectOption("ttc");

  await expect(page.locator('[data-testid="problems"]')).toBeEmpty();

  const generated = YAML.parse((await yamlPreview(page).textContent())!);
  const fixture = YAML.parse(await readFile(EXTENDED_FIXTURE, "utf8"));
  expect(generated).toEqual(fixture);
  await expect(cliCommand(page)).toHaveText("fontalloy build Extended-Font.yaml");
});
