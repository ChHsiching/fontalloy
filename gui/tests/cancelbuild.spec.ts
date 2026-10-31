import { test, expect, type Locator, type Page } from "@playwright/test";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { overrideEnv } from "./env-restore";
import { startServeFixture, type ServeFixture } from "./serve";
import {
  assertNoJsErrors,
  collectJsErrors,
  pointerClick,
  waitForFontsReady,
} from "./helpers";

/**
 * Round 19, owner item 1 — builds REALLY cancel. The panel's × used to
 * merely delete the UI rows while the serve kept chewing the merge
 * server-side; now the confirm card's danger action stops the builds
 * on the service (`POST /builds/{id}/cancel`), the poll type map knows
 * `cancelled`, and the row lands as a neutral 已取消.
 *
 * The harness mirrors synthesize.spec.ts: a real `fontalloy serve`
 * fixture (a wide donor keeps the build grafting long enough to act
 * on), real pickers, a save stand-in through the config seam — plus
 * Node-side reads of the service's own /builds listing, the proof the
 * job really stopped (not just that the panel stopped tracking it).
 */
test.describe("build cancellation", () => {
  test.describe.configure({ mode: "serial" });
  const jsErrors: string[] = [];

  let restoreStageDelay: (() => void) | null = null;

  test.beforeEach(() => {
    jsErrors.length = 0;
    // Ticket #41: every build in this file must still be RUNNING when
    // its cancel lands. The donor-glyph-count fixture's wall time
    // varies with machine and priority (locally at BelowNormal a
    // 45k-glyph build can reach done before the confirm click), so the
    // serve's stage-delay seam (FONTALLOY_TEST_STAGE_DELAY_MS, honored
    // by build.py at every stage entry) makes builds observably slow
    // everywhere — 5s x 7 stages.
    restoreStageDelay = overrideEnv({
      FONTALLOY_TEST_STAGE_DELAY_MS: "5000",
    });
  });

  test.afterEach(() => {
    assertNoJsErrors(jsErrors);
    restoreStageDelay?.();
  });

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
    // Round 21: every local load posts its outcome card (家族 N ·
    // 字形 M) before the picker closes. Dismiss it here — this suite's
    // end-state assertions count the message stack empty, and a card
    // parked under the resting pointer pauses its countdown by design
    // (the hover-pause).
    for (const card of await page
      .locator(".kit-msgs [data-role='message']", {
        hasText: "已加载本地字体",
      })
      .all()) {
      await card.locator("[data-role='message-dismiss']").click();
    }
  }

  /** The page wired to the service with a real-disk save stand-in. */
  async function openWithService(
    page: Page,
    service: ServeFixture,
    saved: string[],
  ): Promise<void> {
    const saveDir = await mkdtemp(resolve(tmpdir(), "fontalloy-cancel-"));
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
  }

  /** Start a merge and wait until its row is observably in flight. */
  async function startBuild(page: Page): Promise<Locator> {
    const synthesize = page.locator(".topbar [data-role='synthesize']");
    await expect(synthesize).toHaveAttribute("aria-disabled", "false");
    await pointerClick(page, synthesize);
    const panel = page.locator('[data-testid="build-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel.locator("[data-build-row]")).toHaveCount(1);
    // Mid-flight, not yet 完成 (the wide donor keeps the graft long).
    await expect(panel.locator("[data-build-stage]").first()).not.toHaveText(
      "完成",
      { timeout: 10_000 },
    );
    return panel;
  }

  /** Every /cancel POST the page issued, in order. */
  function trackCancelPosts(page: Page): string[] {
    const posts: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname.endsWith("/cancel")
      ) {
        posts.push(request.url());
      }
    });
    return posts;
  }

  /** The service's own view of the builds (the honest job states). */
  async function serveBuilds(service: ServeFixture): Promise<
    Array<{ id: string; status: string; font: unknown }>
  > {
    const response = await fetch(`${service.url}/builds`);
    expect(response.ok).toBe(true);
    return ((await response.json()) as { builds: Array<Record<string, unknown>> })
      .builds as Array<{ id: string; status: string; font: unknown }>;
  }

  test("the panel × confirms while a build runs; 继续合成 leaves it running and settled rows still close instantly", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const service = await startServeFixture(45_000);
    const saved: string[] = [];
    const cancelPosts = trackCancelPosts(page);
    try {
      await openWithService(page, service, saved);
      await loadIntoPicker(page, "en", service.baseFont);
      await loadIntoPicker(page, "cjk", service.donorFont);
      const panel = await startBuild(page);

      // The × while a row is live ASKS — nothing cancelled, nothing
      // cleared, the question carries both answers.
      await pointerClick(page, panel.locator(".build-close"));
      const card = page
        .locator(".kit-msgs [data-role='message']")
        .filter({ hasText: "仍在合成" });
      await expect(card).toBeVisible();
      await expect(card).toContainText("确认取消并关闭？取消后本次不会保存产物。");
      await expect(
        card.locator("[data-role='message-action']", { hasText: "取消并关闭" }),
      ).toHaveCount(1);
      await expect(
        card.locator("[data-role='message-action']", { hasText: "继续合成" }),
      ).toHaveCount(1);
      await expect(panel).toBeVisible();
      await expect(panel.locator("[data-build-row]")).toHaveCount(1);
      expect(cancelPosts).toEqual([]);

      // 继续合成: dismiss only — no cancel POST ever fires, the build
      // runs to completion and saves.
      await pointerClick(
        page,
        card.locator("[data-role='message-action']", { hasText: "继续合成" }),
      );
      await expect(card).toHaveCount(0);
      expect(cancelPosts).toEqual([]);
      await expect(panel.locator("[data-build-stage]").first()).toHaveText(
        "完成",
        { timeout: 60_000 },
      );
      expect(saved.length).toBe(1);

      // Every row settled: the same × clears instantly, no question.
      await pointerClick(page, panel.locator(".build-close"));
      await expect(panel).toBeHidden();
      await expect(panel.locator("[data-build-row]")).toHaveCount(0);
      await expect(
        page.locator(".kit-msgs [data-role='message']"),
      ).toHaveCount(0);
      expect(cancelPosts).toEqual([]);
    } finally {
      await service.dispose();
    }
  });

  test("「取消并关闭」 really cancels on the service, clears the rows, frees the worker", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const service = await startServeFixture(45_000);
    const saved: string[] = [];
    const cancelPosts = trackCancelPosts(page);
    try {
      await openWithService(page, service, saved);
      await loadIntoPicker(page, "en", service.baseFont);
      await loadIntoPicker(page, "cjk", service.donorFont);
      const panel = await startBuild(page);

      await pointerClick(page, panel.locator(".build-close"));
      const card = page
        .locator(".kit-msgs [data-role='message']")
        .filter({ hasText: "仍在合成" });
      await expect(card).toBeVisible();
      await pointerClick(
        page,
        card.locator("[data-role='message-action']", { hasText: "取消并关闭" }),
      );

      // The panel clears and hides; the cancel POST really fired.
      await expect(panel).toBeHidden();
      await expect(panel.locator("[data-build-row]")).toHaveCount(0);
      expect(cancelPosts.length).toBe(1);

      // The honest proof, straight from the service's own registry:
      // the job landed `cancelled` with no artifact.
      await expect
        .poll(async () => (await serveBuilds(service))[0]?.status, {
          timeout: 30_000,
        })
        .toBe("cancelled");
      const [job] = await serveBuilds(service);
      expect(job?.font).toBeNull();
      expect(saved.length).toBe(0);

      // The worker is free: a fresh build runs to completion.
      const fresh = await startBuild(page);
      await expect(fresh.locator("[data-build-stage]").first()).toHaveText(
        "完成",
        { timeout: 60_000 },
      );
      expect(saved.length).toBe(1);
    } finally {
      await service.dispose();
    }
  });

  test("a running row's own close confirms for that row alone and lands 已取消", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const service = await startServeFixture(45_000);
    const saved: string[] = [];
    const cancelPosts = trackCancelPosts(page);
    try {
      await openWithService(page, service, saved);
      await loadIntoPicker(page, "en", service.baseFont);
      await loadIntoPicker(page, "cjk", service.donorFont);
      const panel = await startBuild(page);

      // The row's own 关闭这条记录 asks the row-local question.
      await pointerClick(page, panel.locator(".build-dismiss").first());
      const card = page
        .locator(".kit-msgs [data-role='message']")
        .filter({ hasText: "取消这条合成？" });
      await expect(card).toBeVisible();
      await expect(card).toContainText("取消后本次不会保存产物。");
      await expect(
        card.locator("[data-role='message-action']", { hasText: "取消并关闭" }),
      ).toHaveCount(1);
      await expect(
        card.locator("[data-role='message-action']", { hasText: "继续合成" }),
      ).toHaveCount(1);
      expect(cancelPosts).toEqual([]);

      // Cancelling: the row STAYS and lands as the neutral 已取消 —
      // the calm failure styling with no error red and no error box.
      await pointerClick(
        page,
        card.locator("[data-role='message-action']", { hasText: "取消并关闭" }),
      );
      await expect.poll(() => cancelPosts.length).toBe(1);
      const stage = panel.locator("[data-build-stage]").first();
      await expect(stage).toHaveText("已取消", { timeout: 30_000 });
      await expect(stage).toHaveClass(/is-cancelled/);
      await expect(stage).not.toHaveClass(/is-failed/);
      await expect(stage).not.toHaveClass(/is-done/);
      await expect(panel.locator("[data-build-error]").first()).toBeHidden();
      // Neutral stepper: no danger segments, no pulsing current one.
      await expect(panel.locator(".build-step.is-failed")).toHaveCount(0);
      await expect(panel.locator(".build-step.is-current")).toHaveCount(0);

      // The service agrees, and nothing was saved.
      await expect
        .poll(async () => (await serveBuilds(service))[0]?.status, {
          timeout: 30_000,
        })
        .toBe("cancelled");
      expect(saved.length).toBe(0);

      // The settled 已取消 row now closes instantly, like any other.
      await pointerClick(page, panel.locator(".build-dismiss").first());
      await expect(panel.locator("[data-build-row]")).toHaveCount(0);
      await expect(
        page.locator(".kit-msgs [data-role='message']"),
      ).toHaveCount(0);
    } finally {
      await service.dispose();
    }
  });
});
