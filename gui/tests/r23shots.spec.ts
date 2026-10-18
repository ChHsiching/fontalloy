// Round-23 acceptance shots: real-name variant chips, the top bar's
// font-pair alignment, and the typed-path field's fit inside the
// picker footer — captured for the vision gate. Test 1 boots a REAL
// serve-backed catalog (the ticket-30 architecture: the shared
// journey-catalog wiring — a spawned `fontalloy serve` syncing a
// file:// release site built from named fixture faces, the same
// helpers catalog.spec/countertruth.spec use), never the deleted
// page-side /dev-catalog bootstrap the shots rode before (spec #25's
// final batch: that pre-architecture boot never settles anymore).
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { pointerClick, waitForFontsReady } from "./helpers";
import { generateBigTtc, generateNamedFace, spawnServeOverFonts } from "./serve";
import { buildServeCatalogSite } from "./catalog-serve-site";

const OUT = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "fontalloy-notes",
  "shots",
);
mkdirSync(OUT, { recursive: true });

test.setTimeout(240_000);

test("capture r23 chips, top bar pair, path input", async ({ page }) => {
  await page.route("https://api.github.com/repos/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "{}",
    }),
  );
  // The fixture catalog: MapleMono with BOTH cuts as named faces (the
  // chips read the cut's own scanned name-table name), JetBrainsMono
  // for the EN pick, and the WenKai row that anchors the shot's
  // composition below Maple.
  const root = await mkdtemp(join(tmpdir(), "fontalloy-r23-site-"));
  const nfFace = await generateNamedFace(root, "Maple Mono NF", "MapleMono-NF");
  const nfcnFace = await generateNamedFace(
    root,
    "Maple Mono NF CN",
    "MapleMono-NF-CN",
  );
  const jetFace = await generateNamedFace(
    root,
    "JetBrainsMono Nerd Font",
    "JetBrainsMonoNerdFont",
  );
  const wenkaiFace = await generateNamedFace(
    root,
    "LXGW WenKai",
    "LXGWWenKai",
  );
  const site = await buildServeCatalogSite([
    {
      family: "MapleMono",
      faces: [
        { file: "MapleMono-NF-Regular.ttf", fontPath: nfFace },
        { file: "MapleMono-NF-CN-Regular.ttf", fontPath: nfcnFace },
      ],
      manifestEntries: [
        { variant: "NF", file: "MapleMono-NF.zip", axes: { icons: "nf" } },
        {
          variant: "NF-CN",
          file: "MapleMono-NF-CN.zip",
          axes: { icons: "nf", region: "SC" },
        },
      ],
    },
    {
      family: "JetBrainsMono",
      faces: [
        { file: "JetBrainsMonoNerdFont-Regular.ttf", fontPath: jetFace },
      ],
      manifestEntries: [
        { variant: "Nerd Font", file: "JetBrainsMono.zip" },
      ],
    },
    {
      family: "LXGWWenKai",
      faces: [{ file: "LXGWWenKai-Regular.ttf", fontPath: wenkaiFace }],
      manifestEntries: [{ variant: "Standard", file: "LXGWWenKai.zip" }],
    },
  ]);
  const spawned = await spawnServeOverFonts(site.catalogDir, [
    "--catalog-release-origin",
    site.originUri,
    "--catalog-dir",
    site.catalogDir,
    "--manifest",
    site.manifestPath!,
  ]);
  try {
    const serveUrl = await spawned.url;
    await page.addInitScript((serve) => {
      (window as { __FONTALLOY_CONFIG__?: unknown }).__FONTALLOY_CONFIG__ = {
        serveUrl: serve,
      };
    }, serveUrl);
    await page.goto("/");
    await waitForFontsReady(page);
    // Settled sync AND the registration sweep's done mark (round 23):
    // rows read their own names by then. Bounded — the fixture catalog
    // settles in seconds; a stuck sync must fail, not hang.
    const screen = page.locator(".catalog-screen");
    await expect(screen).toBeHidden({ timeout: 90_000 });
    await expect
      .poll(
        () =>
          page.evaluate(
            () => document.documentElement.dataset.catalogSweep ?? "running",
          ),
        { timeout: 90_000 },
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
    ).toHaveText("Maple Mono NF", { timeout: 30_000 });
    await expect(
      mapleRow.locator(".kit-vchip[data-chip='MapleMono::NF-CN']"),
    ).toHaveText("Maple Mono NF CN", { timeout: 30_000 });
    await expect(
      cjkPopup.locator(".kit-fp", { hasText: "LXGW WenKai" }),
    ).toBeVisible({ timeout: 30_000 });
    await mapleRow.scrollIntoViewIfNeeded({ timeout: 30_000 });
    await page.screenshot({
      path: join(OUT, "r23-chips.png"),
      fullPage: false,
    });

    // 2. Pick both sides: EN = JetBrainsMono Nerd Font, CJK = the Maple
    // NF default cut — the top bar then carries both tags and the plus.
    await pointerClick(page, mapleRow);
    await waitForFontsReady(page);
    await expect(cjkPopup).toBeHidden({ timeout: 30_000 });
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
    ).toHaveText(/JetBrains/, { timeout: 30_000 });
    await expect(
      page.locator("[data-role='font-pair'] [data-pair='donor']"),
    ).toHaveText("Maple Mono NF", { timeout: 30_000 });
    const pair = page.locator("[data-role='font-pair']");
    await pair.screenshot({ path: join(OUT, "r23-topbar-pair.png") });
  } finally {
    await spawned.dispose();
    await rm(site.root, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("capture r23 path input (Tauri-shell footer seam)", async ({ page }) => {
  // The typed-path field exists only where a path resolver exists —
  // the Tauri shell, or the injected test seam (round 20). The web
  // preview has neither, so this shot boots the spec server with the
  // seam injected and captures the footer exactly as the shell shows
  // it: the field yields inside the row, its right edge visible.
  // Ticket #36 (spec #25's final batch): the mid-load capture (round
  // 24) rides the FILE-INPUT upload flow, and that flow needs a
  // connected serve — without one the upload throws before any
  // loading state renders. A plain spawned `fontalloy serve` over the
  // fixture dir (no catalog — the shot never waits on one) carries it.
  const dir = await mkdtemp(join(tmpdir(), "fontalloy-r24-shot-"));
  const service = await spawnServeOverFonts(dir);
  try {
    const serveUrl = await service.url;
    await page.addInitScript((serve: string) => {
      const w = window as unknown as {
        __FONTALLOY_CONFIG__?: Record<string, unknown>;
      };
      w.__FONTALLOY_CONFIG__ = {
        serveUrl: serve,
        readFontPath: async () => ({
          isDirectory: false,
          files: [],
        }),
        // Stretch the load so the mid-load footer state is capturable.
        testFontLoadDelayMs: 120,
      };
    }, serveUrl);
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

    // Round 24 (owner item 1): the SAME row mid-load — the progress now
    // lives inside the button (spinner + count in place of its icon and
    // label) and the path field keeps its place, right edge visible.
    const bigTtc = await generateBigTtc(dir);
    await page
      .locator("input[data-role='font-file']")
      .setInputFiles(bigTtc, { timeout: 30_000 });
    const button = footer.locator(".kit-fpsys");
    await expect(button).toHaveClass(/loading/, { timeout: 30_000 });
    await expect(button).toHaveText(/正在(读取|加载)\s*\d+\/16/, {
      timeout: 30_000,
    });
    await expect(field).toBeVisible();
    await footer.screenshot({ path: join(OUT, "r24-footer-loading.png") });
    await expect(button).not.toHaveClass(/loading/, { timeout: 60_000 });
    await page.keyboard.press("Escape");
  } finally {
    await service.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
