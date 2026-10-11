import { test, expect, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, basename } from "node:path";
import { readFileSync } from "node:fs";
import { parseFontMeta } from "../src/fonts/sfnt";
import { startServeFixture, type ServeFixture } from "./serve";
import {
  assertNoJsErrors,
  collectJsErrors,
  pointerClick,
  waitForFontsReady,
} from "./helpers";

/**
 * Issue #16: sidecar synthesis in the GUI. The suite drives the REAL
 * merge flow end to end — a real `fontalloy serve` subprocess (the same
 * contract the Tauri sidecar speaks), real fixture fonts through the
 * real pickers, the synthesize action, a native-save stand-in injected
 * through the config bootstrap, and the verification report rendered
 * from the machine JSON.
 *
 * Serial in-file: every test runs its own service; builds serialize on
 * the service's single worker, so CPU contention between parallel
 * tests would only add flake to the mid-build observations.
 */
test.describe("sidecar synthesize", () => {
  test.describe.configure({ mode: "serial" });
  const jsErrors: string[] = [];

  test.beforeEach(() => {
    jsErrors.length = 0;
  });

  test.afterEach(() => assertNoJsErrors(jsErrors));

  /** Load one font file into a picker through its file input. */
  async function loadIntoPicker(
    page: Page,
    role: "en" | "cjk",
    path: string,
  ): Promise<void> {
    await pointerClick(
      page,
      page.locator(`[data-role="picker-${role}"] .kit-hd`),
    );
    const popup = page.locator(`[data-picker-popup="${role}"]`);
    await expect(popup).toBeVisible();
    await page.locator("input[data-role='font-file']").setInputFiles(path);
    await expect(popup.locator(".kit-fp").first()).toBeVisible();
    await waitForFontsReady(page);
    await page.keyboard.press("Escape");
  }

  /** The page with the injected service config + a real save stand-in. */
  async function openWithService(
    page: Page,
    service: ServeFixture,
    saved: string[],
  ): Promise<string> {
    const saveDir = await mkdtemp(resolve(tmpdir(), "fontalloy-save-"));
    await page.exposeFunction(
      "__fontalloyTestSave",
      async (name: string, bytesB64: string): Promise<string | null> => {
        const bytes = Buffer.from(bytesB64, "base64");
        const target = resolve(saveDir, name);
        await writeFile(target, bytes);
        saved.push(target);
        return target;
      },
    );
    await page.addInitScript(() => {
      const config = window as unknown as {
        __FONTALLOY_CONFIG__: Record<string, unknown>;
      };
      config.__FONTALLOY_CONFIG__ = {
        saveArtifact: async (
          name: string,
          bytes: Uint8Array,
        ): Promise<{ saved: boolean; path: string | null }> => {
          const b64 = btoa(
            Array.from(bytes, (b) => String.fromCharCode(b)).join(""),
          );
          const path = await window.__fontalloyTestSave(name, b64);
          return path === null ? { saved: false, path: null } : { saved: true, path };
        },
      };
    });
    await page.addInitScript((url: string) => {
      const config = window as unknown as {
        __FONTALLOY_CONFIG__: Record<string, unknown>;
      };
      config.__FONTALLOY_CONFIG__ ??= {};
      config.__FONTALLOY_CONFIG__.serveUrl = url;
    }, service.url);
    collectJsErrors(page, jsErrors);
    await page.goto("/");
    await waitForFontsReady(page);
    return saveDir;
  }

  test("synthesizes a font over the real service, saves it, and renders the report", async ({
    page,
  }) => {
    const service = await startServeFixture();
    const saved: string[] = [];
    try {
      const saveDir = await openWithService(page, service, saved);

      await loadIntoPicker(page, "en", service.baseFont);
      await loadIntoPicker(page, "cjk", service.donorFont);

      // Connected service + full pick pair => the action is enabled.
      const synthesize = page.locator(".topbar [data-role='synthesize']");
      await expect(synthesize).toHaveAttribute("aria-disabled", "false");
      await pointerClick(page, synthesize);

      // The build panel appears with a visible stage, then completes.
      const panel = page.locator('[data-testid="build-panel"]');
      await expect(panel).toBeVisible();
      await expect(panel.locator("[data-build-stage]").first()).toHaveText(
        /(读取字体|规划槽位|解析规则|嫁接字形|重写表|保存|生成报告|完成|排队中)/,
      );
      await expect(panel.locator("[data-build-stage]").first()).toHaveText(
        "完成",
        { timeout: 30_000 },
      );

      // The artifact was saved and states where, as page text.
      await expect(panel).toContainText("已保存");
      expect(saved.length).toBe(1);

      // The saved artifact parses as a font: sfnt magic, the output
      // family, and the merged coverage read back from its cmap.
      const bytes = readFileSync(saved[0]);
      expect(bytes[0]).toBe(0x00);
      expect(bytes[1]).toBe(0x01);
      const meta = parseFontMeta(
        new Uint8Array(bytes).buffer as ArrayBuffer,
      );
      expect(meta.family).toBe("ChHsich");
      expect(meta.codepoints.length).toBe(30_026);

      // The verification report renders from the machine JSON.
      await expect(panel).toContainText("验证报告");
      await expect(panel).toContainText("码位总数");
      await expect(panel).toContainText("30,026");
      await expect(panel).toContainText("来自基底");
      await expect(panel).toContainText("26");
      await expect(panel).toContainText("来自供体");
      await expect(panel).toContainText("30,000");
      // v2 sections: coverage scope and before/after metrics render too.
      await expect(panel).toContainText("覆盖范围");
      await expect(panel).toContainText("度量对比");
      await expect(panel).toContainText("行高未触动");
      await expect(panel).toContainText("fontalloy/verification-report");

      // An open-overlay screenshot of the completed build: the panel with
      // the rendered report is this feature's overlay state (seam-3 rule).
      const { mkdirSync } = await import("node:fs");
      const { join } = await import("node:path");
      const dir = join(process.cwd(), "test-results", "screenshots");
      mkdirSync(dir, { recursive: true });
      await page.screenshot({
        path: join(dir, "synthesize-build-report.png"),
        animations: "disabled",
      });
      void saveDir;
    } finally {
      await service.dispose();
    }
  });

  test("shows progress while building and stays usable, queueing a second build", async ({
    page,
  }) => {
    const service = await startServeFixture();
    const saved: string[] = [];
    try {
      await openWithService(page, service, saved);
      await loadIntoPicker(page, "en", service.baseFont);
      await loadIntoPicker(page, "cjk", service.donorFont);

      const synthesize = page.locator(".topbar [data-role='synthesize']");
      await expect(synthesize).toHaveAttribute("aria-disabled", "false");
      await pointerClick(page, synthesize);

      // A ~2s build: catch it mid-flight (not yet 完成).
      const panel = page.locator('[data-testid="build-panel"]');
      await expect(panel).toBeVisible();
      await expect(panel.locator("[data-build-stage]").first()).not.toHaveText(
        "完成",
      );

      // The app stays usable while the build runs: browsing categories
      // and pages keeps working (the panel is inline, never a modal).
      await pointerClick(page, page.locator(".kit-cat-g[data-group='all']"));
      await expect(page.locator("[data-stat='total']")).toHaveText("1,112,032");
      const next = page.locator(".kit-toolrow .kit-pgc button[aria-label='下一页']");
      await pointerClick(page, next);
      await expect(page.locator("[data-pager-label]")).toHaveText("第 2/1086 页");

      // Queue a second build while the first one runs.
      await pointerClick(page, synthesize);
      await expect(panel.locator("[data-build-row]")).toHaveCount(2);
      for (const row of await panel.locator("[data-build-row]").all()) {
        await expect(row.locator("[data-build-stage]")).toHaveText("完成", {
          timeout: 30_000,
        });
      }
      expect(saved.length).toBe(2);
    } finally {
      await service.dispose();
    }
  });

  test("a font the service cannot see fails resolution inline, without a modal", async ({
    page,
  }) => {
    const service = await startServeFixture();
    const saved: string[] = [];
    try {
      await openWithService(page, service, saved);
      await loadIntoPicker(page, "en", service.baseFont);
      // A host font outside every --font-dir: the recipe cannot name it.
      const [hostFont] = (
        await import("./helpers")
      ).fixtureFontPaths().slice(0, 1);
      expect(basename(hostFont)).not.toBe("donor.ttf");
      await loadIntoPicker(page, "cjk", hostFont);

      const synthesize = page.locator(".topbar [data-role='synthesize']");
      await expect(synthesize).toHaveAttribute("aria-disabled", "false");
      await pointerClick(page, synthesize);

      const panel = page.locator('[data-testid="build-panel"]');
      await expect(panel).toBeVisible();
      await expect(panel).toContainText(/无法定位/);
      expect(saved.length).toBe(0);

      // No modal: the workspace underneath keeps responding.
      await pointerClick(page, page.locator(".kit-cat-g[data-group='all']"));
      await expect(page.locator("[data-stat='total']")).toHaveText("1,112,032");
    } finally {
      await service.dispose();
    }
  });

  test("a build that fails in the pipeline surfaces its error inline", async ({
    page,
  }) => {
    const service = await startServeFixture();
    const saved: string[] = [];
    try {
      await openWithService(page, service, saved);
      await loadIntoPicker(page, "en", service.baseFont);
      await loadIntoPicker(page, "cjk", service.donorFont);

      // The donor vanished between selection and submission: resolution
      // uses the index captured at connect time, so the build is really
      // submitted and the pipeline itself fails at the loading stage.
      const { rm } = await import("node:fs/promises");
      await rm(service.donorFont);

      const synthesize = page.locator(".topbar [data-role='synthesize']");
      await expect(synthesize).toHaveAttribute("aria-disabled", "false");
      await pointerClick(page, synthesize);

      const panel = page.locator('[data-testid="build-panel"]');
      await expect(panel).toBeVisible();
      await expect(panel).toContainText("失败");
      await expect(panel).toContainText(/donor\.ttf|字体/);
      expect(saved.length).toBe(0);
    } finally {
      await service.dispose();
    }
  });

  test("without a service the synthesize action stays disabled and explains so", async ({
    page,
  }) => {
    collectJsErrors(page, jsErrors);
    await page.goto("/");
    await waitForFontsReady(page);

    const synthesize = page.locator(".topbar [data-role='synthesize']");
    await expect(synthesize).toHaveAttribute("aria-disabled", "true");
    await pointerClick(page, synthesize);
    const notice = page.locator(".synthesize-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("本地");
  });
});
