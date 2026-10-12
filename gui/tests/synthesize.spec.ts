import { test, expect, type Page } from "@playwright/test";
import { writeFile, copyFile, mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, basename } from "node:path";
import { readFileSync } from "node:fs";
import { parseFontMeta } from "../src/fonts/sfnt";
import {
  spawnServeOverFonts,
  startServeFixture,
  type ServeFixture,
} from "./serve";
import { SimCatalog, injectCatalogConfig, makeZip, sha256hex } from "./catalog-fixtures";
import {
  assertNoJsErrors,
  collectJsErrors,
  fixtureFontPaths,
  pointerClick,
  realCatalogFontPaths,
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
    // Round 4: a successful local load CLOSES the picker (prototype
    // parity — the closed card shows the new pick).
    await expect(popup).toBeHidden();
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
      // Round 6: stage names follow report-copy §1 (规划字重 / 移植字形 /
      // 改写名称表 …), and a running build with no stage yet says 正在合成.
      const panel = page.locator('[data-testid="build-panel"]');
      await expect(panel).toBeVisible();
      // Round 7 (logo adoption): the panel head carries the brand mark.
      await expect(
        panel.locator(".build-panel-title .kit-brand-mark"),
      ).toBeVisible();
      await expect(panel.locator("[data-build-stage]").first()).toHaveText(
        /(读取字体|规划字重|解析规则|移植字形|改写名称表|保存输出|生成报告|完成|排队中|正在合成)/,
      );
      await expect(panel.locator("[data-build-stage]").first()).toHaveText(
        "完成",
        { timeout: 30_000 },
      );

      // The artifact was saved and states where, as page text.
      await expect(panel).toContainText("已保存");
      expect(saved.length).toBe(1);

      // Round 6: at save EVERY stepper step is lit-solid (never
      // all-gray) — the model is upcoming faint / current active /
      // done lit-solid.
      const stepStates = await panel
        .locator(".build-step")
        .evaluateAll((steps) =>
          steps.map((step) => ({
            passed: step.classList.contains("is-passed"),
            current: step.classList.contains("is-current"),
            failed: step.classList.contains("is-failed"),
          })),
        );
      expect(stepStates.length).toBe(7);
      for (const state of stepStates) {
        expect(state.passed).toBe(true);
        expect(state.current).toBe(false);
        expect(state.failed).toBe(false);
      }
      // The ONE current-stage line is gone once settled (it shows only
      // while a stage is actually current).
      await expect(
        panel.locator("[data-build-stage-line]").first(),
      ).toBeHidden();

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

      // The verification report renders from the machine JSON, under
      // the report-copy §3.1 labels (round 6).
      await expect(panel).toContainText("验证报告");
      await expect(panel).toContainText("参与合并的码位");
      await expect(panel).toContainText("30,026");
      await expect(panel).toContainText("基底提供");
      await expect(panel).toContainText("26");
      await expect(panel).toContainText("供体补充");
      await expect(panel).toContainText("30,000");
      // v2 sections: coverage scope and before/after metrics render too.
      await expect(panel).toContainText("覆盖检查");
      await expect(panel).toContainText("字体尺寸对比");
      await expect(panel).toContainText("行高保持不变");
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
      // The stats bar reports the WHOLE MERGE (covered + the declared
      // scope's gaps), consistent across categories.
      await pointerClick(page, page.locator(".kit-cat-g[data-group='all']"));
      const mergeTotals = await page.evaluate(() => ({
        total: document.querySelector("[data-stat='total']")?.textContent ?? "",
        en: document.querySelector("[data-stat='en']")?.textContent ?? "",
        cjk: document.querySelector("[data-stat='cjk']")?.textContent ?? "",
        missing: document.querySelector("[data-stat='missing']")?.textContent ?? "",
      }));
      const num = (t: string) => Number(t.replace(/,/g, ""));
      expect(num(mergeTotals.total)).toBe(
        num(mergeTotals.en) + num(mergeTotals.cjk) + num(mergeTotals.missing),
      );
      expect(num(mergeTotals.total)).toBeGreaterThan(0);
      expect(num(mergeTotals.total)).toBeLessThan(1_112_032);
      const next = page.locator(".kit-toolrow .kit-pgc button[aria-label='下一页']");
      await pointerClick(page, next);
      // Round 5: the aggregate pages the VISIBLE codepoints in whole
      // rows — the count follows the live page size, never a constant.
      await expect(page.locator("[data-pager-label]")).toHaveText(
        /第 2\/\d+ 页/,
      );
      // The whole-merge counters did not move with the page.
      await expect(page.locator("[data-stat='total']")).toHaveText(
        mergeTotals.total,
      );

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

      // No modal: the workspace underneath keeps responding (the
      // whole-merge counters, whatever they are for THIS pick pair).
      await pointerClick(page, page.locator(".kit-cat-g[data-group='all']"));
      const totals = await page.evaluate(
        () => document.querySelector("[data-stat='total']")?.textContent ?? "",
      );
      expect(Number(totals.replace(/,/g, ""))).toBeGreaterThan(0);
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

  test("the minimal path: two REAL catalog fonts picked, no other settings, builds and saves", async ({
    page,
  }) => {    // Real-shape fonts take a real while to graft (~40s on this
    // machine); the suite's 30s default cannot cover the full merge.
    test.setTimeout(180_000);
    // Round 5, owner item 7 — the flagship flow, exactly as an owner
    // runs it: pick JetBrainsMono NF + a CJK family from the catalog
    // rows, touch nothing else, press 合成字体. Real-shape fonts (the
    // same binaries the dev catalog serves), the real recipe the GUI
    // builds (boot zh_cn preset included), the real service.
    const real = realCatalogFontPaths();
    const fontsDir = await mkdtemp(resolve(tmpdir(), "fontalloy-real-"));
    await copyFile(real.base, resolve(fontsDir, basename(real.base)));
    await copyFile(real.donor, resolve(fontsDir, basename(real.donor)));
    const service = await spawnServeOverFonts(fontsDir);

    const saved: string[] = [];
    const saveDir = await mkdtemp(resolve(tmpdir(), "fontalloy-save-"));
    try {
      // A catalog over the same binaries — the picks come from ROWS.
      const sim = await SimCatalog.create([
        { family: "JetBrainsMono", file: basename(real.base), fontPath: real.base },
        { family: "MapleMono", file: basename(real.donor), fontPath: real.donor },
      ]);
      await sim.install(page);
      await injectCatalogConfig(page);
      const serveUrl = await service.url;
      await page.addInitScript((serve: string) => {
        const config = window as unknown as {
          __FONTALLOY_CONFIG__: Record<string, unknown>;
        };
        config.__FONTALLOY_CONFIG__.serveUrl = serve;
      }, serveUrl);
      // The page has a catalog configured, so the star refresh fires;
      // keep it hermetic and quiet (a fulfilled count logs nothing).
      await page.route("https://api.github.com/repos/**", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ stargazers_count: 1234 }),
        }),
      );
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
        config.__FONTALLOY_CONFIG__.saveArtifact = async (
          name: string,
          bytes: Uint8Array,
        ): Promise<{ saved: boolean; path: string | null }> => {
          const b64 = btoa(
            Array.from(bytes, (b) => String.fromCharCode(b)).join(""),
          );
          const path = await window.__fontalloyTestSave(name, b64);
          return path === null ? { saved: false, path: null } : { saved: true, path };
        };
      });
      collectJsErrors(page, jsErrors);
      await page.goto("/");
      await waitForFontsReady(page);
      await expect(page.locator(".catalog-screen")).toBeHidden({
        timeout: 30_000,
      });

      // The slot split (round 5, item 2): the EN slot lists the NF
      // coding family, the CJK slot the CJK family.
      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      await pointerClick(
        page,
        page
          .locator('[data-picker-popup="en"] .kit-fp', { hasText: "JetBrains Mono" })
          .first(),
      );
      await pointerClick(page, page.locator('[data-role="picker-cjk"] .kit-hd'));
      await pointerClick(
        page,
        page
          .locator('[data-picker-popup="cjk"] .kit-fp', { hasText: "Maple Mono CN" })
          .first(),
      );
      await waitForFontsReady(page);

      const synthesize = page.locator(".topbar [data-role='synthesize']");
      await expect(synthesize).toHaveAttribute("aria-disabled", "false");
      await pointerClick(page, synthesize);

      const panel = page.locator('[data-testid="build-panel"]');
      await expect(
        panel.locator("[data-build-stage]").first(),
      ).toHaveText("完成", { timeout: 60_000 });
      await expect(panel).toContainText("已保存");
      expect(saved.length).toBe(1);

      // The saved artifact parses as the merged font.
      const bytes = readFileSync(saved[0]!);
      expect(bytes[0]).toBe(0x00);
      expect(bytes[1]).toBe(0x01);
      const meta = parseFontMeta(
        new Uint8Array(bytes).buffer as ArrayBuffer,
      );
      expect(meta.family).toBe("ChHsich");
      // JetBrains Mono NF (~4.4k+) and Maple Mono CN hanzi both present.
      expect(meta.codepoints.length).toBeGreaterThan(6_000);
      expect(meta.codepoints).toContain(0x4e2d); // 中
      expect(meta.codepoints).toContain(0xe0b0); // a Nerd Font powerline glyph
    } finally {
      await service.dispose();
    }
  });

  // Round 6, owner item 5 — the P0: catalog-picked fonts must submit
  // CATALOG-FAMILY references, not bare file names. The owner's serve
  // (:7777) runs with a manifest over the FETCHED catalog layout
  // (assets/fonts/<Family>/<faces>.ttf + the pinned zips); its /fonts
  // top-level scan does not list the extracted faces, so the old
  // basename matching died with 无法定位字体文件路径. This test builds
  // exactly that layout and proves the flow green end to end.
  test("catalog picks submit catalog-family references against a manifest serve", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const real = realCatalogFontPaths();

    // The owner's layout: assets/fonts.manifest.json + LICENSE +
    // per-variant zips and their extracted faces beside them.
    const root = await mkdtemp(resolve(tmpdir(), "fontalloy-catalogref-"));
    const assetsDir = resolve(root, "assets");
    const fontsDir = resolve(assetsDir, "fonts");
    await mkdir(resolve(fontsDir, "JetBrainsMono"), { recursive: true });
    await mkdir(resolve(fontsDir, "MapleMono-NF-CN"), { recursive: true });
    const baseFace = "JetBrainsMonoNerdFont-Regular.ttf";
    const donorFace = "MapleMono-NF-CN-Regular.ttf";
    await copyFile(real.base, resolve(fontsDir, "JetBrainsMono", baseFace));
    await copyFile(real.donor, resolve(fontsDir, "MapleMono-NF-CN", donorFace));
    const baseBytes = readFileSync(real.base);
    const donorBytes = readFileSync(real.donor);
    const baseZip = makeZip([{ name: baseFace, data: baseBytes }]);
    const donorZip = makeZip([{ name: donorFace, data: donorBytes }]);
    await writeFile(resolve(fontsDir, "JetBrainsMono.zip"), baseZip);
    await writeFile(resolve(fontsDir, "MapleMono-NF-CN.zip"), donorZip);
    await writeFile(
      resolve(assetsDir, "LICENSE.txt"),
      "Test-only license placeholder.\n",
    );
    const entry = (family: string, variant: string, file: string, sha: string) => ({
      family,
      variant,
      file,
      version: "v3.5.1",
      upstream_url: "file://localhost/catalog",
      sha256: sha,
      license_spdx: "OFL-1.1-no-RFN",
      rfn: false,
      rfn_names: [],
      copyright: null,
      license_file: "LICENSE.txt",
      checksum_source: "self-computed",
    });
    await writeFile(
      resolve(assetsDir, "fonts.manifest.json"),
      JSON.stringify(
        {
          schema: "fontalloy/font-catalog@v1",
          families: [
            entry("JetBrainsMono", "Nerd Font", "JetBrainsMono.zip", sha256hex(baseZip)),
            entry("MapleMono", "NF-CN", "MapleMono-NF-CN.zip", sha256hex(donorZip)),
          ],
        },
        null,
        1,
      ),
    );
    const service = await spawnServeOverFonts(fontsDir, [
      "--manifest",
      resolve(assetsDir, "fonts.manifest.json"),
    ]);

    const saved: string[] = [];
    const saveDir = await mkdtemp(resolve(tmpdir(), "fontalloy-save-"));
    try {
      // The catalog release names the manifest variants (round 6), so
      // the GUI can emit {family, variant} references.
      const sim = await SimCatalog.create([
        { family: "JetBrainsMono", variant: "Nerd Font", file: baseFace, fontPath: real.base },
        { family: "MapleMono", variant: "NF-CN", file: donorFace, fontPath: real.donor },
      ]);
      await sim.install(page);
      await injectCatalogConfig(page);
      const serveUrl = await service.url;
      await page.addInitScript((serve: string) => {
        const config = window as unknown as {
          __FONTALLOY_CONFIG__: Record<string, unknown>;
        };
        config.__FONTALLOY_CONFIG__.serveUrl = serve;
      }, serveUrl);
      await page.route("https://api.github.com/repos/**", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ stargazers_count: 1234 }),
        }),
      );
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
        config.__FONTALLOY_CONFIG__.saveArtifact = async (
          name: string,
          bytes: Uint8Array,
        ): Promise<{ saved: boolean; path: string | null }> => {
          const b64 = btoa(
            Array.from(bytes, (b) => String.fromCharCode(b)).join(""),
          );
          const path = await window.__fontalloyTestSave(name, b64);
          return path === null ? { saved: false, path: null } : { saved: true, path };
        };
      });
      collectJsErrors(page, jsErrors);
      await page.goto("/");
      await waitForFontsReady(page);
      await expect(page.locator(".catalog-screen")).toBeHidden({
        timeout: 30_000,
      });

      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      await pointerClick(
        page,
        page
          .locator('[data-picker-popup="en"] .kit-fp', { hasText: "JetBrains Mono" })
          .first(),
      );
      await pointerClick(page, page.locator('[data-role="picker-cjk"] .kit-hd'));
      await pointerClick(
        page,
        page
          .locator('[data-picker-popup="cjk"] .kit-fp', { hasText: "Maple Mono CN" })
          .first(),
      );
      await waitForFontsReady(page);

      // The submission body names the catalog families — the base
      // narrowed to the picked face, the donor the whole variant.
      const bodyPromise = page
        .waitForRequest(
          (request) =>
            request.method() === "POST" &&
            new URL(request.url()).pathname.endsWith("/builds"),
        )
        .then((request) => request.postDataJSON() as Record<string, unknown>);
      const synthesize = page.locator(".topbar [data-role='synthesize']");
      await expect(synthesize).toHaveAttribute("aria-disabled", "false");
      await pointerClick(page, synthesize);
      const body = await bodyPromise;
      expect(body.base).toEqual({
        family: "JetBrainsMono",
        variant: "Nerd Font",
        pattern: baseFace,
      });
      expect(body.donors).toEqual([
        { family: "MapleMono", variant: "NF-CN" },
      ]);

      const panel = page.locator('[data-testid="build-panel"]');
      await expect(panel).toBeVisible();
      await expect(
        panel.locator("[data-build-stage]").first(),
      ).toHaveText("完成", { timeout: 120_000 });
      await expect(panel).toContainText("已保存");
      expect(saved.length).toBe(1);

      // The saved artifact parses as the merged font (中 + a Nerd Font
      // powerline glyph — the manifest-resolved sources both grafted).
      const bytes = readFileSync(saved[0]!);
      expect(bytes[0]).toBe(0x00);
      expect(bytes[1]).toBe(0x01);
      const meta = parseFontMeta(
        new Uint8Array(bytes).buffer as ArrayBuffer,
      );
      expect(meta.family).toBe("ChHsich");
      expect(meta.codepoints).toContain(0x4e2d); // 中
      expect(meta.codepoints).toContain(0xe0b0); // a Nerd Font powerline glyph
    } finally {
      await service.dispose();
    }
  });
});
