// Round-10 acceptance shots: build panel (mid-build + complete + help
// popover) and the structured toast — captured for the orchestrator's
// vision pass. Runs under the screenshots project only.
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServeFixture } from "./serve";
import { injectCatalogConfig } from "./catalog-fixtures";
import { pointerClick, waitForFontsReady } from "./helpers";

const OUT = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "..",
  "fontalloy-notes",
  "round10-shots",
);
mkdirSync(OUT, { recursive: true });

test.setTimeout(180_000);

test("capture build panel + structured toast", async ({ page }) => {
  const serve = await startServeFixture({ donorGlyphs: 30000 });
  try {
    // Same wiring as the synthesize spec: a real save stand-in + the
    // serveUrl bootstrap key (read at boot — inject before navigation).
    const saveDir = await page.context().browser();
    void saveDir;
    await page.exposeFunction("__fontalloyTestSave", async (name: string, b64: string) => {
      const { writeFile, mkdtemp } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { resolve } = await import("node:path");
      const dir = await mkdtemp(resolve(tmpdir(), "fontalloy-shots-"));
      const target = resolve(dir, name);
      await writeFile(target, Buffer.from(b64, "base64"));
      return target;
    });
    await page.addInitScript(() => {
      const w = window as unknown as { __FONTALLOY_CONFIG__?: Record<string, unknown> };
      w.__FONTALLOY_CONFIG__ = {
        ...(w.__FONTALLOY_CONFIG__ ?? {}),
        saveArtifact: async (
          _name: string,
          bytes: Uint8Array,
        ): Promise<{ saved: boolean; path: string | null }> => {
          const b64 = btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
          const path = await (
            window as unknown as {
              __fontalloyTestSave: (n: string, b: string) => Promise<string>;
            }
          ).__fontalloyTestSave(_name, b64);
          return { saved: true, path };
        },
      };
    });
    await page.addInitScript((url: string) => {
      const w = window as unknown as { __FONTALLOY_CONFIG__?: Record<string, unknown> };
      w.__FONTALLOY_CONFIG__ ??= {};
      w.__FONTALLOY_CONFIG__.serveUrl = url;
    }, serve.url);
    await page.goto("/");
    await waitForFontsReady(page);
    await page.waitForTimeout(900);

    // Load the fixture pair through the fused panel's file input (round-4
    // selector vocabulary; a successful local load CLOSES the picker).
    const fonts = { en: serve.baseFont, cjk: serve.donorFont };
    for (const [role, path] of [
      ["en", fonts.en],
      ["cjk", fonts.cjk],
    ] as const) {
      await pointerClick(page, page.locator(`[data-role="picker-${role}"] .kit-hd`));
      const popup = page.locator(`[data-picker-popup="${role}"]`);
      await popup.waitFor({ state: "visible" });
      await page.locator("input[data-role='font-file']").setInputFiles(path);
      await popup.waitFor({ state: "hidden", timeout: 15_000 });
      await waitForFontsReady(page);
    }

    // A CJK-group assignment produces the structured toast (the journey's
    // selector vocabulary: exact-label mseg buttons).
    const group = page.locator(".kit-cat-g[data-group='cjk']");
    if (await group.count()) await pointerClick(page, group.first());
    await page.locator(".kit-cell").first().waitFor();
    const enAssign = page
      .locator(".kit-mseg button", { hasText: /^全用英文$/ })
      .first();
    if (await enAssign.count()) {
      await pointerClick(page, enAssign);
      await page.waitForTimeout(700);
    }
    await page.screenshot({ path: join(OUT, "toast.png") });

    // Synthesize: mid-build panel.
    await pointerClick(page, page.locator("[data-role='synthesize']"));
    await page
      .locator('[data-testid="build-panel"]')
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(OUT, "panel-mid.png") });

    // Complete state (+ report disclosure + a help popover above the panel).
    await expect(
      page.locator('[data-testid="build-panel"]', { hasText: "已保存" }),
    ).toBeVisible({ timeout: 150_000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(OUT, "panel-done.png") });
    const disclosure = page.locator("text=查看报告").first();
    if (await disclosure.count()) {
      await pointerClick(page, disclosure);
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(OUT, "panel-report.png") });
      const help = page.locator('[data-testid="build-panel"] .kit-qh').first();
      if (await help.count()) {
        await pointerClick(page, help);
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(OUT, "panel-help.png") });
      }
    }
  } finally {
    await serve.dispose();
  }
});
