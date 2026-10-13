import { test, expect, type Locator, type Page } from "@playwright/test";
import { writeFile, mkdtemp } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { startServeFixture, type ServeFixture } from "./serve";
import {
  assertNoJsErrors,
  collectJsErrors,
  pointerClick,
  waitForFontsReady,
} from "./helpers";

/**
 * Round 17, owner item 3 — the same-name save collision. When a build
 * finishes and the default-path save would land on a file that already
 * exists (the user forgot to rename; the default name is ChHsich), the
 * app may NEITHER silently overwrite NOR silently suffix: the USER
 * decides. A message card names the colliding target and offers both
 * paths — 「改个名字」 (focus + flash the font-name input; the save
 * completes under the committed new name) and 「覆盖保存」 (the explicit
 * write). Dismissing the card without choosing writes nothing; the
 * artifact stays in the service's scratch, retrievable from the row.
 *
 * The harness mirrors synthesize.spec.ts: a real `fontalloy serve`
 * fixture, real pickers, a real-disk save stand-in through the config
 * seam, plus a PROBE stand-in for the pre-flight existence check (the
 * same seam the Tauri shell backs with `artifact_exists`).
 */
test.describe("same-name save collision", () => {
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
    await expect(popup).toBeHidden();
  }

  /**
   * The collision-ready page: the service config plus a save stand-in
   * writing to real disk AND a probe stand-in reporting what already
   * sits there (the pre-flight the Tauri shell answers with
   * `artifact_exists` over the configured output directory).
   */
  async function openCollisionReady(
    page: Page,
    service: ServeFixture,
    saved: string[],
  ): Promise<string> {
    const saveDir = await mkdtemp(resolve(tmpdir(), "fontalloy-collide-"));
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
    await page.exposeFunction(
      "__fontalloyTestProbe",
      (name: string): { exists: boolean; path: string } => {
        const target = resolve(saveDir, name);
        return { exists: existsSync(target), path: target };
      },
    );
    await page.addInitScript(() => {
      const config = window as unknown as {
        __FONTALLOY_CONFIG__: Record<string, unknown>;
      };
      const toB64 = (bytes: Uint8Array): string =>
        btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
      config.__FONTALLOY_CONFIG__ = {
        probeArtifact: async (
          name: string,
        ): Promise<{ exists: boolean; path: string }> =>
          await window.__fontalloyTestProbe(name),
        saveArtifact: async (
          name: string,
          bytes: Uint8Array,
        ): Promise<{ saved: boolean; path: string | null }> => {
          const path = await window.__fontalloyTestSave(name, toB64(bytes));
          return path === null
            ? { saved: false, path: null }
            : { saved: true, path };
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

  /** The collision card (the message whose title names the verdict). */
  function collisionCard(page: Page): Locator {
    return page
      .locator(".kit-msgs [data-role='message']")
      .filter({ hasText: "已有同名文件" });
  }

  /** One build click; resolves once the row count reaches `count`. */
  async function runBuild(page: Page, count: number): Promise<Locator> {
    const synthesize = page.locator(".topbar [data-role='synthesize']");
    await expect(synthesize).toHaveAttribute("aria-disabled", "false");
    await pointerClick(page, synthesize);
    const panel = page.locator('[data-testid="build-panel"]');
    await expect(panel.locator("[data-build-row]")).toHaveCount(count);
    return panel;
  }

  test("a same-name artifact asks before writing; 改个名字 saves under the new name", async ({
    page,
  }) => {
    // Two real builds plus the card's still-stands window: the suite's
    // 30s default is tight on a serial service.
    test.setTimeout(120_000);
    const service = await startServeFixture();
    const saved: string[] = [];
    try {
      const saveDir = await openCollisionReady(page, service, saved);
      await loadIntoPicker(page, "en", service.baseFont);
      await loadIntoPicker(page, "cjk", service.donorFont);

      // Build 1: no collision, the default name writes straight out.
      let panel = await runBuild(page, 1);
      await expect(
        panel.locator("[data-build-stage]").first(),
      ).toHaveText("完成", { timeout: 30_000 });
      expect(saved.length).toBe(1);
      expect(saved[0]!.endsWith("ChHsich.ttf")).toBe(true);

      // Build 2, SAME default name: the pre-flight sees the file and
      // ASKS — no second write has happened, the card names the exact
      // colliding target, and the second row settles as built but
      // UNSAVED (the saved line honestly says 未保存, no path).
      panel = await runBuild(page, 2);
      const card = collisionCard(page);
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(
        panel.locator("[data-build-stage]").last(),
      ).toHaveText("完成");
      const secondRow = panel.locator("[data-build-row]").last();
      await expect(
        secondRow.locator("[data-build-saved-label]"),
      ).toHaveText("未保存");
      await expect(
        secondRow.locator("[data-build-saved-path]"),
      ).toBeHidden();
      expect(saved.length).toBe(1);
      await expect(
        card.locator("[data-role='message-reason']"),
      ).toHaveAttribute("title", /ChHsich\.ttf$/);
      // The card does not expire on its own — it waits for the choice.
      await page.waitForTimeout(1_200);
      await expect(card).toBeVisible();

      // 改个名字: the input takes the focus and flashes.
      await pointerClick(
        page,
        card.locator("[data-role='message-action']", { hasText: "改个名字" }),
      );
      const nameInput = page.locator(".topbar [data-role='font-name']");
      await expect(nameInput).toBeFocused();
      await expect(nameInput).toHaveClass(/kit-flash/);
      // Choosing closes the card; still nothing written.
      await expect(card).toHaveCount(0);
      expect(saved.length).toBe(1);

      // Commit a new name: the pending artifact saves under it.
      await nameInput.fill("RenamedFont");
      await nameInput.press("Enter");
      const savedPath = panel
        .locator("[data-build-row]")
        .last()
        .locator("[data-build-saved-path]");
      await expect(savedPath).toHaveAttribute("title", /RenamedFont\.ttf$/, {
        timeout: 30_000,
      });
      expect(saved.length).toBe(2);
      expect(saved[1]!.endsWith("RenamedFont.ttf")).toBe(true);
      // The first file is untouched: the save directory now holds
      // exactly the original ChHsich.ttf and the new RenamedFont.ttf.
      expect(existsSync(saved[0]!)).toBe(true);
      expect(existsSync(resolve(saveDir, "RenamedFont.ttf"))).toBe(true);
    } finally {
      await service.dispose();
    }
  });

  test("覆盖保存 writes the file and closes the card; dismissing writes nothing", async ({
    page,
  }) => {
    // Three real builds ride this scenario.
    test.setTimeout(120_000);
    const service = await startServeFixture();
    const saved: string[] = [];
    try {
      const saveDir = await openCollisionReady(page, service, saved);
      await loadIntoPicker(page, "en", service.baseFont);
      await loadIntoPicker(page, "cjk", service.donorFont);

      let panel = await runBuild(page, 1);
      await expect(
        panel.locator("[data-build-stage]").first(),
      ).toHaveText("完成", { timeout: 30_000 });
      const target = resolve(saveDir, "ChHsich.ttf");
      const before = statSync(target);

      // The same-name build asks first (proving the ask is not a
      // one-shot: this second scenario rebuilds the same collision).
      panel = await runBuild(page, 2);
      const card = collisionCard(page);
      await expect(card).toBeVisible({ timeout: 30_000 });
      expect(saved.length).toBe(1);

      // 覆盖保存: the explicit write. The file's content is replaced
      // (mtime moves; the bytes parse as the merged font again).
      await pointerClick(
        page,
        card.locator("[data-role='message-action']", { hasText: "覆盖保存" }),
      );
      const savedPath = panel
        .locator("[data-build-row]")
        .last()
        .locator("[data-build-saved-path]");
      await expect(savedPath).toHaveAttribute("title", /ChHsich\.ttf$/, {
        timeout: 30_000,
      });
      await expect(card).toHaveCount(0);
      expect(saved.length).toBe(2);
      const after = statSync(target);
      expect(after.mtimeMs).toBeGreaterThan(before.mtimeMs);
      const bytes = readFileSync(target);
      expect(bytes[0]).toBe(0x00);
      expect(bytes[1]).toBe(0x01);

      // Dismissal without a choice writes nothing: build 3 collides,
      // the × closes the card, and the artifact stays retrievable
      // from the row (未保存 label, no path, 另存为 reachable).
      panel = await runBuild(page, 3);
      const thirdCard = collisionCard(page);
      await expect(thirdCard).toBeVisible({ timeout: 30_000 });
      expect(saved.length).toBe(2);
      await pointerClick(
        page,
        thirdCard.locator("[data-role='message-dismiss']"),
      );
      await expect(thirdCard).toHaveCount(0);
      const thirdRow = panel.locator("[data-build-row]").last();
      await expect(
        thirdRow.locator("[data-build-saved-label]"),
      ).toHaveText("未保存");
      await expect(thirdRow.locator("[data-build-saved-path]")).toBeHidden();
      await expect(thirdRow.locator("[data-build-saveas]")).toBeVisible();
      expect(saved.length).toBe(2);
    } finally {
      await service.dispose();
    }
  });
});
