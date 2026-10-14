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
 * Round 18, owner item 4 — the same-name gate at the CLICK. Round 17
 * asked after the build, which wastes it: renaming then discards the
 * artifact and forces a rebuild anyway. The check moved: the
 * synthesize action probes the target name BEFORE submitting anything.
 * A collision starts NO build; one message card (「已有同名文件」) names
 * the exact target path and offers 「改个名字」 (focus + flash the
 * font-name input; the committed new name starts the build itself —
 * re-probed first, another collision asks again) and 「直接合成」 (the
 * build proceeds and saves with overwrite; nothing is overwritten
 * until the save). Dismissing the card (×) builds nothing and leaves
 * nothing behind.
 *
 * The harness mirrors synthesize.spec.ts: a real `fontalloy serve`
 * fixture, real pickers, a real-disk save stand-in through the config
 * seam, plus a PROBE stand-in for the existence check (the same seam
 * the Tauri shell backs with `artifact_exists`).
 */
test.describe("same-name output gate", () => {
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
   * Every POST /builds submission, in order — the "no build until
   * decided" proof counts them.
   */
  function trackBuildPosts(page: Page): Array<Record<string, unknown>> {
    const posts: Array<Record<string, unknown>> = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname.endsWith("/builds")
      ) {
        posts.push(request.postDataJSON() as Record<string, unknown>);
      }
    });
    return posts;
  }

  /**
   * The gate-ready page: the service config plus a save stand-in
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

  /** The gate card (the message whose title names the verdict). */
  function collisionCard(page: Page): Locator {
    return page
      .locator(".kit-msgs [data-role='message']")
      .filter({ hasText: "已有同名文件" });
  }

  /** One synthesize click; the caller asserts what it did or did not start. */
  async function clickSynthesize(page: Page): Promise<Locator> {
    const synthesize = page.locator(".topbar [data-role='synthesize']");
    await expect(synthesize).toHaveAttribute("aria-disabled", "false");
    await pointerClick(page, synthesize);
    return page.locator('[data-testid="build-panel"]');
  }

  /** One build click that must start a build; resolves at `count` rows. */
  async function runBuild(page: Page, count: number): Promise<Locator> {
    const panel = await clickSynthesize(page);
    await expect(panel.locator("[data-build-row]")).toHaveCount(count);
    return panel;
  }

  test("a collision at the click starts no build; 改个名字 starts it under the committed new name", async ({
    page,
  }) => {
    // Two real builds ride this scenario.
    test.setTimeout(150_000);
    const service = await startServeFixture();
    const saved: string[] = [];
    const buildPosts = trackBuildPosts(page);
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

      // The SAME default name again: the gate fires AT THE CLICK. No
      // build starts — the service sees no second POST /builds, the
      // panel gains no row — while the card names the exact colliding
      // target and waits for the choice.
      panel = await clickSynthesize(page);
      // No build is coming: a moment past the click, the service has
      // seen no second POST /builds and the panel gained no row. (This
      // is the assertion the post-build ask fails — the old flow
      // submitted the build the moment the button went down.)
      await page.waitForTimeout(1_200);
      expect(buildPosts.length).toBe(1);
      await expect(panel.locator("[data-build-row]")).toHaveCount(1);
      expect(saved.length).toBe(1);
      const card = collisionCard(page);
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(
        card.locator("[data-role='message-reason']"),
      ).toHaveAttribute("title", /ChHsich\.ttf$/);
      // The card does not expire on its own — it waits for the choice.
      await page.waitForTimeout(1_200);
      await expect(card).toBeVisible();

      // 改个名字: the input takes the focus and flashes; the choice
      // closes the card; still no build anywhere.
      await pointerClick(
        page,
        card.locator("[data-role='message-action']", { hasText: "改个名字" }),
      );
      const nameInput = page.locator(".topbar [data-role='font-name']");
      await expect(nameInput).toBeFocused();
      await expect(nameInput).toHaveClass(/kit-flash/);
      await expect(card).toHaveCount(0);
      expect(buildPosts.length).toBe(1);

      // Commit a new name: the build starts ITSELF — exactly one more
      // POST /builds whose recipe carries the NEW family — and the
      // artifact saves under the new name.
      const postPromise = page.waitForRequest(
        (request) =>
          request.method() === "POST" &&
          new URL(request.url()).pathname.endsWith("/builds"),
        { timeout: 30_000 },
      );
      await nameInput.fill("RenamedFont");
      await nameInput.press("Enter");
      const body = (await postPromise).postDataJSON() as {
        output: { format: string; family: string };
      };
      expect(body.output).toEqual({ format: "ttf", family: "RenamedFont" });
      await expect(panel.locator("[data-build-row]")).toHaveCount(2);
      await expect(
        panel.locator("[data-build-stage]").last(),
      ).toHaveText("完成", { timeout: 30_000 });
      const savedPath = panel
        .locator("[data-build-row]")
        .last()
        .locator("[data-build-saved-path]");
      await expect(savedPath).toHaveAttribute("title", /RenamedFont\.ttf$/);
      expect(buildPosts.length).toBe(2);
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

  test("直接合成 proceeds with the build and its save overwrites the file", async ({
    page,
  }) => {
    // Two real builds ride this scenario.
    test.setTimeout(150_000);
    const service = await startServeFixture();
    const saved: string[] = [];
    const buildPosts = trackBuildPosts(page);
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

      // The same-name click asks FIRST (the ask is not a one-shot: this
      // scenario rebuilds the same collision): no submission until the
      // choice is made.
      panel = await clickSynthesize(page);
      await page.waitForTimeout(1_000);
      expect(buildPosts.length).toBe(1);
      expect(saved.length).toBe(1);
      const card = collisionCard(page);
      await expect(card).toBeVisible({ timeout: 30_000 });

      // 直接合成: the build proceeds (POST #2) and its save overwrites
      // the existing file — the file's content is replaced (mtime
      // moves; the bytes parse as the merged font again).
      await pointerClick(
        page,
        card.locator("[data-role='message-action']", { hasText: "直接合成" }),
      );
      await expect(panel.locator("[data-build-row]")).toHaveCount(2);
      const savedPath = panel
        .locator("[data-build-row]")
        .last()
        .locator("[data-build-saved-path]");
      await expect(savedPath).toHaveAttribute("title", /ChHsich\.ttf$/, {
        timeout: 30_000,
      });
      await expect(card).toHaveCount(0);
      expect(buildPosts.length).toBe(2);
      expect(saved.length).toBe(2);
      const after = statSync(target);
      expect(after.mtimeMs).toBeGreaterThan(before.mtimeMs);
      const bytes = readFileSync(target);
      expect(bytes[0]).toBe(0x00);
      expect(bytes[1]).toBe(0x01);
    } finally {
      await service.dispose();
    }
  });

  test("dismissing the card builds nothing and leaves no message behind", async ({
    page,
  }) => {
    // One real build rides this scenario.
    test.setTimeout(120_000);
    const service = await startServeFixture();
    const saved: string[] = [];
    const buildPosts = trackBuildPosts(page);
    try {
      await openCollisionReady(page, service, saved);
      await loadIntoPicker(page, "en", service.baseFont);
      await loadIntoPicker(page, "cjk", service.donorFont);

      const panel = await runBuild(page, 1);
      await expect(
        panel.locator("[data-build-stage]").first(),
      ).toHaveText("完成", { timeout: 30_000 });

      // The colliding click asks; the × answers NEITHER — no build
      // ever fires, no row joins the panel, and no message outlives
      // the card.
      await clickSynthesize(page);
      await page.waitForTimeout(1_200);
      expect(buildPosts.length).toBe(1);
      const card = collisionCard(page);
      await expect(card).toBeVisible({ timeout: 30_000 });
      await pointerClick(
        page,
        card.locator("[data-role='message-dismiss']"),
      );
      await expect(card).toHaveCount(0);
      await page.waitForTimeout(1_500);
      expect(buildPosts.length).toBe(1);
      await expect(panel.locator("[data-build-row]")).toHaveCount(1);
      expect(saved.length).toBe(1);
      await expect(
        page.locator(".kit-msgs [data-role='message']"),
      ).toHaveCount(0);
    } finally {
      await service.dispose();
    }
  });
});
