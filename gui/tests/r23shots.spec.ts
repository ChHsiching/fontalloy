// Round-23 acceptance shots: real-name variant chips, the top bar's
// font-pair alignment, and the typed-path field's fit inside the
// picker footer — captured for the vision gate. Boots the REAL dev
// catalog (plain "/" boot, like the journeys).
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pointerClick, waitForFontsReady } from "./helpers";

const OUT = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "fontalloy-notes",
  "shots",
);
mkdirSync(OUT, { recursive: true });

test.setTimeout(240_000);

// The default spec server is catalog-free (VITE_DEV_CATALOG=0); the
// shots need the REAL catalog, so they boot the freshly built web
// preview (same kit/UI, same current code) instead.
const APP = "http://localhost:4275/";

test("capture r23 chips, top bar pair, path input", async ({ page }) => {
  await page.route("https://api.github.com/repos/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "{}",
    }),
  );
  await page.goto(APP);
  await waitForFontsReady(page);
  // Settled downloads AND the registration sweep's done mark (round
  // 23): rows read their own names by then.
  const screen = page.locator(".catalog-screen");
  await expect(screen).toBeHidden({ timeout: 180_000 });
  await expect
    .poll(
      () =>
        page.evaluate(
          () => document.documentElement.dataset.catalogSweep ?? "running",
        ),
      { timeout: 180_000 },
    )
    .toBe("done");

  // 1. The CJK picker: MapleMono's two chips in their real names, the
  // WenKai group row below — plus the footer's typed-path field.
  await pointerClick(page, page.locator('[data-role="picker-cjk"] .kit-hd'));
  const cjkPopup = page.locator('[data-picker-popup="cjk"]');
  await expect(cjkPopup).toBeVisible();
  const mapleRow = cjkPopup.locator(".kit-fp", { hasText: "Maple Mono NF" });
  await expect(
    mapleRow.locator(".kit-vchip[data-chip='MapleMono::NF']"),
  ).toHaveText("Maple Mono NF");
  await expect(
    mapleRow.locator(".kit-vchip[data-chip='MapleMono::NF-CN']"),
  ).toHaveText("Maple Mono NF CN");
  await mapleRow.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(OUT, "r23-chips.png"),
    fullPage: false,
  });

  // 2. Pick both sides: EN = JetBrainsMono Nerd Font, CJK = the Maple
  // NF default cut — the top bar then carries both tags and the plus.
  await pointerClick(page, mapleRow);
  await waitForFontsReady(page);
  await expect(cjkPopup).toBeHidden();
  await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
  const enPopup = page.locator('[data-picker-popup="en"]');
  await expect(enPopup).toBeVisible();
  await pointerClick(
    page,
    enPopup.locator(".kit-fp", { hasText: "JetBrainsMono Nerd Font" }).first(),
  );
  await waitForFontsReady(page);
  await expect(
    page.locator("[data-role='font-pair'] [data-pair='base']"),
  ).toHaveText(/JetBrains/, { timeout: 20_000 });
  await expect(
    page.locator("[data-role='font-pair'] [data-pair='donor']"),
  ).toHaveText("Maple Mono NF", { timeout: 20_000 });
  const pair = page.locator("[data-role='font-pair']");
  await pair.screenshot({ path: join(OUT, "r23-topbar-pair.png") });
});

test("capture r23 path input (Tauri-shell footer seam)", async ({ page }) => {
  // The typed-path field exists only where a path resolver exists —
  // the Tauri shell, or the injected test seam (round 20). The web
  // preview has neither, so this shot boots the spec server with the
  // seam injected and captures the footer exactly as the shell shows
  // it: the field yields inside the row, its right edge visible.
  await page.addInitScript(() => {
    const w = window as unknown as {
      __FONTALLOY_CONFIG__?: Record<string, unknown>;
    };
    w.__FONTALLOY_CONFIG__ ??= {};
    w.__FONTALLOY_CONFIG__.readFontPath = async () => ({
      isDirectory: false,
      files: [],
    });
  });
  await page.goto("/");
  await waitForFontsReady(page);
  await pointerClick(page, page.locator('[data-role="picker-cjk"] .kit-hd'));
  const popup = page.locator('[data-picker-popup="cjk"]');
  await expect(popup).toBeVisible();
  const footer = popup.locator(".kit-fpfoot");
  const field = footer.locator(".kit-fppath");
  await expect(field).toBeVisible();
  await expect(field).toHaveAttribute("placeholder", "或输入路径");
  await footer.screenshot({ path: join(OUT, "r23-path-input.png") });
  await page.keyboard.press("Escape");
});
