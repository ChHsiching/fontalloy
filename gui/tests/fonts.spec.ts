import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  assertNoJsErrors,
  collectJsErrors,
  pointerClick,
  waitForFontsReady,
} from "./helpers";
import { generateNamedFace, spawnServeOverFonts } from "./serve";

/**
 * Local font loading through the browser file-input fallback
 * (ticket #36: the fallback is upload-driven). The hidden HTML input
 * has no absolute paths to hand the serve's scan, so the page hands
 * the serve the File objects themselves — the fetch body IS the File
 * (the browser streams it; no ArrayBuffer is ever constructed) — and
 * the serve's upload endpoint answers the same family documents the
 * path flow gets, faces serving by URL from the serve's scratch copy.
 *
 * The suite rides a REAL spawned serve over worktree-local generated
 * fonts (the IO discipline: fixture serves only, never the host's
 * font directories). Assertions stay name-agnostic: the row's name is
 * read from the DOM because the scan's name-table truth is the serve's.
 */

test.describe("local font loading (the upload fallback)", () => {
  const jsErrors: string[] = [];

  /** Suite-scoped serve over two generated single-face families. */
  let serveUrl = "";
  let font1 = "";
  let font2 = "";
  let disposeServe: (() => Promise<void>) | null = null;

  test.beforeAll(async () => {
    const root = await mkdtemp(resolve(tmpdir(), "fontalloy-fonts-"));
    const [alpha, beta] = await Promise.all([
      generateNamedFace(root, "Alloy Upload A", "AlloyUploadA"),
      generateNamedFace(root, "Alloy Upload B", "AlloyUploadB"),
    ]);
    font1 = alpha;
    font2 = beta;
    const spawned = await spawnServeOverFonts(root);
    disposeServe = async () => {
      await spawned.dispose();
      await rm(root, { recursive: true, force: true });
    };
    serveUrl = await spawned.url;
  });

  test.afterAll(async () => {
    await disposeServe?.();
  });

  async function openWorkspace(page: Page): Promise<void> {
    jsErrors.length = 0;
    collectJsErrors(page, jsErrors);
    await page.addInitScript((serve: string) => {
      (window as { __FONTALLOY_CONFIG__?: unknown }).__FONTALLOY_CONFIG__ = {
        serveUrl: serve,
      };
    }, serveUrl);
    await page.goto("/");
    await waitForFontsReady(page);
  }

  test("an uploaded font file loads into a self-rendered picker row", async ({
    page,
  }) => {
    await openWorkspace(page);

    await pointerClick(
      page,
      page.locator('[data-role="picker-en"] .kit-hd'),
    );
    const popup = page.locator('[data-picker-popup="en"]');
    await expect(popup).toBeVisible();

    // The local-file footer is part of the popup, outside the scroll area.
    const footer = popup.locator(".kit-fpsys");
    await expect(footer).toBeVisible();
    await expect(footer).toContainText("加载本地字体文件");

    await page.locator("input[data-role='font-file']").setInputFiles(font1);
    await waitForFontsReady(page);

    // Round 4: the successful load CLOSED the picker (prototype
    // parity); reopen it to inspect the row it now holds.
    await expect(popup).toBeHidden();
    await pointerClick(
      page,
      page.locator('[data-role="picker-en"] .kit-hd'),
    );
    const row = popup.locator(".kit-fp").first();
    await expect(row).toBeVisible();
    // The row's NAME text (the meta line carries the 本地字体文件 trait
    // on local rows — the whole-row text is no longer just the family).
    const family = ((await row.locator(".kit-nm").textContent()) ?? "").trim();
    expect(family.length).toBeGreaterThan(0);

    // Self-rendering: the name text is set in its own font.
    const fontFamily = await row
      .locator(".kit-nm")
      .evaluate((el) => getComputedStyle(el).fontFamily);
    expect(fontFamily).toContain(family);

    // Independent oracle: the browser font subsystem registered the loaded
    // family under the displayed name and it covers U+0041.
    const covers = await page.evaluate(
      (fam) =>
        document.fonts.check(
          `16px "${fam.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
          "A",
        ),
      family,
    );
    expect(covers).toBe(true);

    // The anchor card shows the auto-selected family in its own face.
    await expect(
      page.locator('[data-role="picker-en"] .kit-hd b'),
    ).toHaveText(family);
  });

  test("selecting fonts updates the anchor, pair tags, grid preview and coverage", async ({
    page,
  }) => {
    await openWorkspace(page);

    // Load both files at once through the EN picker (the registry is shared).
    await pointerClick(
      page,
      page.locator('[data-role="picker-en"] .kit-hd'),
    );
    const popup = page.locator('[data-picker-popup="en"]');
    await page
      .locator("input[data-role='font-file']")
      .setInputFiles([font1, font2]);
    await waitForFontsReady(page);

    // Round 4: both loads closed the picker; reopen to read the rows.
    await expect(popup).toBeHidden();
    await pointerClick(
      page,
      page.locator('[data-role="picker-en"] .kit-hd'),
    );
    const rows = popup.locator(".kit-fp");
    await expect(rows).toHaveCount(2);
    // Family names from the rows' name spans (local rows carry the
    // 本地字体文件 trait in their meta line).
    const family1 =
      ((await rows.nth(0).locator(".kit-nm").textContent()) ?? "").trim();
    const family2 =
      ((await rows.nth(1).locator(".kit-nm").textContent()) ?? "").trim();
    expect(family1).not.toBe(family2);

    // EN keeps family1 (auto-selected); CJK picks family2 explicitly.
    await page.keyboard.press("Escape");
    await expect(popup).toBeHidden();
    await pointerClick(
      page,
      page.locator('[data-role="picker-cjk"] .kit-hd'),
    );
    await pointerClick(
      page,
      page.locator('[data-picker-popup="cjk"] .kit-fp', {
        hasText: family2,
      }),
    );

    await expect(
      page.locator('[data-role="picker-en"] .kit-hd b'),
    ).toHaveText(family1);
    await expect(
      page.locator('[data-role="picker-cjk"] .kit-hd b'),
    ).toHaveText(family2);

    // Font-pair tags carry the pair in plain text.
    await expect(
      page.locator("[data-role='font-pair'] [data-pair='base']"),
    ).toHaveText(family1);
    await expect(
      page.locator("[data-role='font-pair'] [data-pair='donor']"),
    ).toHaveText(family2);

    // The preview grid renders U+0041 in the base's own face (the
    // winner) — the serve's resolve document lands async, so poll for
    // the cell's stack rather than reading it once.
    await expect
      .poll(() =>
        page
          .locator(".charmap-grid .kit-cell[data-cp='U+0041']")
          .evaluate((el) => getComputedStyle(el).fontFamily),
      )
      .toContain(family1);

    // Coverage of the selected pair is visible and non-zero (英文
    // winners — the counters read the scan's interval data, ticket #36).
    await expect(page.locator("[data-stat='en']")).not.toHaveText("0");
  });

  test("an invalid font file reports an inline error instead of failing silently", async ({
    page,
  }) => {
    await openWorkspace(page);
    await pointerClick(
      page,
      page.locator('[data-role="picker-en"] .kit-hd'),
    );
    const popup = page.locator('[data-picker-popup="en"]');
    await page.locator("input[data-role='font-file']").setInputFiles({
      name: "broken.ttf",
      mimeType: "font/ttf",
      buffer: Buffer.from("this is definitely not a font file"),
    });
    const error = popup.locator("[data-picker-error]");
    await expect(error).toBeVisible();
    expect((await error.textContent()) ?? "").toContain("broken.ttf");
    await expect(popup.locator(".kit-fp")).toHaveCount(0);
  });

  test.afterEach(() => assertNoJsErrors(jsErrors));
});
