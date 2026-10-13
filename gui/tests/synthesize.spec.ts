import { test, expect, type Locator, type Page } from "@playwright/test";
import { writeFile, copyFile, mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, basename } from "node:path";
import { readFileSync } from "node:fs";
import { parseFontMeta } from "../src/fonts/sfnt";
import {
  spawnServeOverFonts,
  startServeFixture,
  generateFamily,
  generateFonts,
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

      // Round 13 (owner item 5): living progress — the elapsed timer
      // (mm:ss, ticking) renders right-aligned in the live column
      // while the build runs (the ~2s fixture build keeps the window
      // open).
      await expect(
        panel.locator("[data-build-elapsed]").first(),
      ).toHaveText(/用时 \d+:\d{2}/);

      // Round 10 (no flicker), round 11 (content sizing): sample the
      // panel's clientHeight and the rows region's scrollbar state
      // every frame for the REST of the build — the poll must never
      // move the height frame to frame. The panel is content-sized now,
      // so ONE real transition is sanctioned (the row settling:
      // running content → saved line + collapsed disclosure); what must
      // never happen is an oscillation (an A→B→A poll-driven bounce)
      // or a scrollbar toggle (the reserved gutter).
      await page.evaluate(() => {
        const record = { samples: [] as string[], done: false };
        (window as unknown as { __panelSamples: typeof record }).__panelSamples =
          record;
        const panelEl = document.querySelector('[data-testid="build-panel"]')!;
        const rows = panelEl.querySelector(".build-rows")!;
        const started = performance.now();
        const tick = (): void => {
          record.samples.push(
            `${panelEl.clientHeight}:${rows.scrollHeight > rows.clientHeight ? 1 : 0}`,
          );
          if (performance.now() - started < 4500) requestAnimationFrame(tick);
          else record.done = true;
        };
        tick();
      });
      await expect(panel.locator("[data-build-stage]").first()).toHaveText(
        "完成",
        { timeout: 30_000 },
      );

      // The artifact was saved and states where, as page text.
      await expect(panel).toContainText("已保存");
      expect(saved.length).toBe(1);

      // The flicker ledger: at most ONE height change (the settle), no
      // scrollbar frames.
      await page.waitForFunction(
        () =>
          (window as unknown as { __panelSamples: { done: boolean } })
            .__panelSamples.done,
      );
      const ledger = await page.evaluate(
        () =>
          (window as unknown as { __panelSamples: { samples: string[] } })
            .__panelSamples.samples,
      );
      expect(ledger.length).toBeGreaterThan(60);
      const heights = ledger.map((s) => Number(s.split(":")[0]));
      const changes = heights.filter((h, i) => i > 0 && h !== heights[i - 1]);
      expect(changes.length).toBeLessThanOrEqual(1);
      expect(ledger.some((s) => s.endsWith(":1"))).toBe(false);

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
      // Round 10: the vertical journal list is GONE — the stepper is
      // the progress.
      await expect(
        panel.locator("[data-build-journal]"),
      ).toHaveCount(0);

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

      // The verification report renders behind the 查看报告 disclosure
      // (round 10: a settled row stays calm — saved line first, the
      // report on demand), under the report-copy §3.1 labels.
      const disclosure = panel.locator(".report-details > summary");
      await expect(disclosure).toHaveText("查看报告");
      // Round 11 (panel sizing): while calm the panel is COMPACT —
      // content-sized, strictly under the ceiling — and it is NOT in
      // the expanded state.
      const ceiling = await page.evaluate(
        () => Math.min(window.innerHeight * 0.6, 520),
      );
      const compactHeight = await panel.evaluate((el) => el.clientHeight);
      expect(compactHeight).toBeLessThan(ceiling);
      await expect(panel).not.toHaveClass(/is-report-open/);
      await pointerClick(page, disclosure);
      // Opening the disclosure buys the full ceiling (the expanded
      // state exists only while a report is open); clientHeight sits at
      // the ceiling modulo the panel's own 2px of border.
      await expect(panel).toHaveClass(/is-report-open/);
      const openHeight = await panel.evaluate((el) => el.clientHeight);
      expect(openHeight).toBeGreaterThan(compactHeight);
      expect(openHeight).toBeGreaterThanOrEqual(ceiling - 2);
      expect(openHeight).toBeLessThanOrEqual(ceiling);
      await expect(panel).toContainText("验证报告");
      await expect(panel).toContainText("成品文件");
      await expect(panel).toContainText("参与合并的码位");
      await expect(panel).toContainText("30,026");
      await expect(panel).toContainText("英文字体提供");
      await expect(panel).toContainText("26");
      await expect(panel).toContainText("中文字体补充");
      await expect(panel).toContainText("30,000");
      // v2 sections: coverage scope and before/after metrics render too.
      await expect(panel).toContainText("覆盖检查");
      await expect(panel).toContainText("字体尺寸对比");
      await expect(panel).toContainText("行高保持不变");
      // Round 13 (owner item 6): the metrics render as a real TABLE —
      // the 合并前 / 合并后 data columns stated ONCE in a header row,
      // values column-aligned, 「无」 stays, zero · separators in the
      // section (the fact-pair rows 「UPM · 合并前」 are gone).
      const metricsTable = panel.locator(".report-mtable").first();
      await expect(metricsTable).toBeVisible();
      const columnHeaders = (
        await metricsTable.locator("thead th").allTextContents()
      ).filter((h) => h === "合并前" || h === "合并后");
      expect(columnHeaders).toEqual(["合并前", "合并后"]);
      await expect(metricsTable.locator("tbody tr").first()).toContainText(
        "UPM",
      );
      await expect(metricsTable).not.toContainText("·");
      await expect(metricsTable).not.toContainText("—");
      // Round 12 (owner item 4): the borrow rows read the ratified
      // 成品档位 ← 来源字体 direction — the output weight LEFT of the
      // arrow, the source font right of it, the via qualifier after ·.
      await expect(panel).toContainText(
        /\d+ ← .+ · (自动取最近|指定字重|锁定)/,
      );
      // Round 12 (owner item 1): NO dash-joins anywhere in the panel —
      // nothing relies on an em-dash to separate.
      await expect(panel).not.toContainText("—");
      // Round 11 (owner item 2): the single-donor source list reads the
      // fonts' real names only — no 基底/供体/role wording, no numbering.
      await expect(panel).not.toContainText("基底");
      await expect(panel).not.toContainText("供体");
      // Round 10: the raw JSON report is GONE from the UI — the
      // machine schema string only ever rendered inside the deleted
      // <pre>, and rendering it froze the app for tens of seconds.
      await expect(panel).not.toContainText(
        "fontalloy/verification-report",
      );

      // Round 10 (? affordances): exactly ONE ? per section heading
      // (the fact lines carry none), each circle optically centered
      // with its heading text, and every popover stacks ABOVE the
      // panel (the topmost element at the popover's center is the
      // popover, never the panel).
      const headings = panel.locator(".report-heading, .report-section-title");
      const headingCount = await headings.count();
      expect(headingCount).toBeGreaterThanOrEqual(7);
      for (const heading of await headings.all()) {
        expect(await heading.locator(".kit-qh").count()).toBe(1);
      }
      expect(await panel.locator(".report-fact .kit-qh").count()).toBe(0);
      const offsets = await panel.evaluate(() => {
        const center = (el: Element): number => {
          const r = el.getBoundingClientRect();
          return (r.top + r.bottom) / 2;
        };
        return [...document.querySelectorAll(
          '[data-testid="build-panel"] .report-heading, [data-testid="build-panel"] .report-section-title',
        )].map((h) => Math.abs(center(h.firstElementChild!) - center(h.lastElementChild!)));
      });
      expect(Math.max(...offsets)).toBeLessThanOrEqual(2);

      for (const anchor of await panel.locator(".kit-qh").all()) {
        await pointerClick(page, anchor);
        const pop = page.locator(".kit-pop.open");
        await expect(pop).toBeVisible();
        const hit = await page.evaluate(() => {
          const open = document.querySelector(".kit-pop.open")!;
          const r = open.getBoundingClientRect();
          const el = document.elementFromPoint(
            r.left + r.width / 2,
            r.top + r.height / 2,
          );
          return {
            hitsPopover: el !== null && el.closest(".kit-pop") !== null,
            hitsPanel: el !== null && el.closest(".build-panel") !== null,
          };
        });
        expect(hit.hitsPopover).toBe(true);
        expect(hit.hitsPanel).toBe(false);
        await page.keyboard.press("Escape");
        await expect(pop).toBeHidden();
      }

      // Round 11 (items 4–5): the section popovers carry FULL content —
      // the title explanation plus every sub-item of the section as a
      // compact table — and the notation legend lives in its own
      // section's popover (A → B with the metrics; X ← Y with the
      // weight slots).
      const openHelp = async (label: string): Promise<Locator> => {
        const anchor = panel.locator(`.kit-qh[aria-label='${label}']`);
        await pointerClick(page, anchor);
        const pop = page.locator(".kit-pop.open");
        await expect(pop).toBeVisible();
        return pop;
      };
      const metricsPop = await openHelp("字体尺寸对比是什么");
      await expect(metricsPop).toContainText(
        "描述字体高矮、深浅、行距的一组数值",
      );
      // Round 13 (owner item 6): the legend explains the table's two
      // data COLUMNS once — the 「A → B」 pair notation is gone with
      // the pair rows; 无 stays, explained.
      await expect(metricsPop).toContainText("合并之前，英文字体自己的数值");
      await expect(metricsPop).toContainText("合并之后，从成品文件读回的数值");
      await expect(metricsPop).toContainText("该项在合并前没有数值");
      await expect(metricsPop).not.toContainText("A → B");
      await expect(metricsPop).toContainText("UPM");
      await expect(metricsPop).toContainText("中英宽度比");
      await expect(metricsPop).toContainText("行高保持不变");
      await page.keyboard.press("Escape");
      await expect(metricsPop).toBeHidden();
      const slotPop = await openHelp("字重档位是什么");
      await expect(slotPop).toContainText("X ← Y");
      await expect(slotPop).toContainText("借用来源：Y 这款字体提供了这一档");
      await expect(slotPop).toContainText("自动取最近");
      await expect(slotPop).toContainText("锁定");
      await page.keyboard.press("Escape");
      await expect(slotPop).toBeHidden();
      const sourcesPop = await openHelp("来源字体是什么");
      await expect(sourcesPop).toContainText(
        "英文字体作合并容器，中文字体提供补充字形",
      );
      await expect(sourcesPop).toContainText("作为合并容器的字体");
      await page.keyboard.press("Escape");
      await expect(sourcesPop).toBeHidden();
      const reportPop = await openHelp("验证报告是什么");
      for (const part of ["成品文件", "来源字体", "合并统计", "规则优先级", "覆盖检查", "字体尺寸对比", "字重档位"]) {
        await expect(reportPop).toContainText(part);
      }
      await page.keyboard.press("Escape");
      await expect(reportPop).toBeHidden();

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

  test("round 12: the save handoff needs no dialog, keeps the stepper lit, and offers 另存为", async ({
    page,
  }) => {
    const service = await startServeFixture();
    const saved: string[] = [];
    const dialogCalls: string[] = [];
    try {
      const saveDir = await mkdtemp(resolve(tmpdir(), "fontalloy-save-"));
      // The DEFAULT-save stand-in, GATED: the handoff stays open exactly
      // as long as a user might keep a native dialog open, and the test
      // decides when it ends.
      let releaseGate: () => void = () => {};
      const gate = new Promise<void>((resolveGate) => {
        releaseGate = resolveGate;
      });
      await page.exposeFunction(
        "__fontalloyTestSave",
        async (name: string, bytesB64: string): Promise<string | null> => {
          await gate;
          const bytes = Buffer.from(bytesB64, "base64");
          const target = resolve(saveDir, name);
          await writeFile(target, bytes);
          saved.push(target);
          return target;
        },
      );
      // The DIALOG seam (另存为): a spy that writes an as- copy. The
      // automatic save must NEVER touch it (the no-dialog contract).
      await page.exposeFunction(
        "__fontalloyTestSaveAs",
        async (name: string, bytesB64: string): Promise<string | null> => {
          dialogCalls.push(name);
          const bytes = Buffer.from(bytesB64, "base64");
          const target = resolve(saveDir, `as-${name}`);
          await writeFile(target, bytes);
          return target;
        },
      );
      await page.addInitScript(() => {
        const config = window as unknown as {
          __FONTALLOY_CONFIG__: Record<string, unknown>;
        };
        const toB64 = (bytes: Uint8Array): string =>
          btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
        config.__FONTALLOY_CONFIG__ = {
          saveArtifact: async (
            name: string,
            bytes: Uint8Array,
          ): Promise<{ saved: boolean; path: string | null }> => {
            const path = await window.__fontalloyTestSave(name, toB64(bytes));
            return path === null ? { saved: false, path: null } : { saved: true, path };
          },
          saveArtifactAs: async (
            name: string,
            bytes: Uint8Array,
          ): Promise<{ saved: boolean; path: string | null }> => {
            const path = await window.__fontalloyTestSaveAs(name, toB64(bytes));
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

      await loadIntoPicker(page, "en", service.baseFont);
      await loadIntoPicker(page, "cjk", service.donorFont);
      const synthesize = page.locator(".topbar [data-role='synthesize']");
      await expect(synthesize).toHaveAttribute("aria-disabled", "false");
      await pointerClick(page, synthesize);

      // Mid-handoff (the gated stand-in stands in for the open dialog):
      // the row narrates 正在保存 and the stepper KEEPS its lit
      // segments — 读取字体…改写名称表 stay passed, 保存输出 pulses,
      // 生成报告 stays faint (owner round 12, item 2: never a blank
      // stepper while the save is pending).
      const panel = page.locator('[data-testid="build-panel"]');
      await expect(panel.locator("[data-build-stage]").first()).toHaveText(
        "正在保存",
        { timeout: 30_000 },
      );
      // Round 12/13: the handoff narrates itself as TWO lines (stage
      // name + dim note, never a dash-join) and carries NO live column
      // (the save handoff is not pipeline time).
      const stageLine = panel.locator("[data-build-stage-line]").first();
      await expect(
        stageLine.locator("[data-build-stage-name]"),
      ).toHaveText("正在保存");
      await expect(
        stageLine.locator("[data-build-stage-note]"),
      ).toHaveText("把成品字体写入磁盘。");
      await expect(stageLine.locator("[data-build-elapsed]")).toBeHidden();
      await expect(stageLine.locator("[data-build-stage-live]")).toBeHidden();
      const stepStates = await panel
        .locator(".build-step")
        .evaluateAll((steps) =>
          steps.map((step) => ({
            passed: step.classList.contains("is-passed"),
            current: step.classList.contains("is-current"),
            failed: step.classList.contains("is-failed"),
          })),
        );
      expect(stepStates).toEqual([
        ...Array.from({ length: 5 }, () => ({
          passed: true,
          current: false,
          failed: false,
        })),
        { passed: false, current: true, failed: false }, // 保存输出 pulses
        { passed: false, current: false, failed: false }, // 生成报告 waits
      ]);
      // The dialog seam was not touched by the automatic save.
      expect(dialogCalls).toEqual([]);

      // Release the handoff: the row settles. Round 13 (owner item 4):
      // the saved line is TWO rows — 「已保存」 on the first, the FULL
      // path on the second (middle-ellipsized when it overflows; the
      // whole path rides the title attribute).
      releaseGate();
      await expect(panel.locator("[data-build-stage]").first()).toHaveText(
        "完成",
        { timeout: 30_000 },
      );
      const savedBlock = panel.locator("[data-build-saved]").first();
      await expect(
        savedBlock.locator("[data-build-saved-label]"),
      ).toHaveText("已保存");
      const savedPath = panel.locator("[data-build-saved-path]").first();
      await expect(savedPath).toHaveAttribute(
        "title",
        /^[A-Za-z]:\\.+[\\/]ChHsich\.ttf$/,
      );
      await expect(savedPath).toHaveText(/ChHsich\.ttf$/);
      expect(saved.length).toBe(1);
      expect(dialogCalls).toEqual([]);
      const saveAs = panel.locator("[data-build-saveas]").first();
      await expect(saveAs).toBeVisible();
      await expect(saveAs).toHaveText("另存为");

      // The settled stepper lights every segment (never all-gray).
      const settledStates = await panel
        .locator(".build-step")
        .evaluateAll((steps) =>
          steps.map((step) => step.classList.contains("is-passed")),
        );
      expect(settledStates).toEqual(Array.from({ length: 7 }, () => true));

      // 另存为: the DIALOG seam engages and the saved line moves to the
      // chosen location (a real second file on disk).
      await pointerClick(page, saveAs);
      await expect(savedPath).toHaveAttribute(
        "title",
        /[\\/]as-ChHsich\.ttf$/,
        { timeout: 30_000 },
      );
      await expect(savedPath).toHaveText(/as-ChHsich\.ttf$/, {
        timeout: 30_000,
      });
      expect(dialogCalls).toEqual(["ChHsich.ttf"]);
      expect(readFileSync(resolve(saveDir, "as-ChHsich.ttf")).length).toBeGreaterThan(
        0,
      );
      // A successful 另存为 leaves no notice.
      await expect(panel.locator("[data-build-notice]").first()).toBeHidden();
    } finally {
      await service.dispose();
    }
  });

  test("round 12: a 另存为 dialog that cannot open falls back to the default path with a plain notice", async ({
    page,
  }) => {
    const service = await startServeFixture();
    const saved: string[] = [];
    try {
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
      // The headless-Linux stand-in: the dialog command itself REJECTS.
      await page.exposeFunction("__fontalloyTestSaveAs", async (): Promise<never> => {
        throw new Error("dialog backend unavailable");
      });
      await page.addInitScript(() => {
        const config = window as unknown as {
          __FONTALLOY_CONFIG__: Record<string, unknown>;
        };
        const toB64 = (bytes: Uint8Array): string =>
          btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
        config.__FONTALLOY_CONFIG__ = {
          saveArtifact: async (
            name: string,
            bytes: Uint8Array,
          ): Promise<{ saved: boolean; path: string | null }> => {
            const path = await window.__fontalloyTestSave(name, toB64(bytes));
            return path === null ? { saved: false, path: null } : { saved: true, path };
          },
          saveArtifactAs: async (
            name: string,
            bytes: Uint8Array,
          ): Promise<{ saved: boolean; path: string | null }> => {
            await window.__fontalloyTestSaveAs(name, toB64(bytes));
            return { saved: true, path: null };
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

      await loadIntoPicker(page, "en", service.baseFont);
      await loadIntoPicker(page, "cjk", service.donorFont);
      const synthesize = page.locator(".topbar [data-role='synthesize']");
      await expect(synthesize).toHaveAttribute("aria-disabled", "false");
      await pointerClick(page, synthesize);

      const panel = page.locator('[data-testid="build-panel"]');
      await expect(panel.locator("[data-build-stage]").first()).toHaveText(
        "完成",
        { timeout: 30_000 },
      );
      const savedPath = panel.locator("[data-build-saved-path]").first();
      await expect(savedPath).toHaveText(/ChHsich\.ttf$/);

      // The broken dialog falls back: the row stays settled, the
      // completion line still names the DEFAULT location, and the
      // plain notice explains the fallback (no modal, no toast-only).
      await pointerClick(page, panel.locator("[data-build-saveas]").first());
      await expect(panel.locator("[data-build-notice]").first()).toBeVisible({
        timeout: 30_000,
      });
      await expect(panel.locator("[data-build-notice]").first()).toHaveText(
        "保存对话框不可用，已保存到默认位置。",
      );
      await expect(savedPath).toHaveText(/ChHsich\.ttf$/);
      await expect(panel.locator("[data-build-stage]").first()).toHaveText(
        "完成",
      );
      // The fallback wrote the artifact through the default saver again.
      expect(saved.length).toBe(2);
    } finally {
      await service.dispose();
    }
  });

  // Round 13, owner item 7 — the local-family parity: a LOCAL-FILE
  // pick is the family, not one face. A file loaded from a multi-face
  // directory (the round-12 family fixture: Regular/Bold/Italic of one
  // name-table family) discovers its same-directory siblings through
  // the service's /fonts index (the browser stand-in for the Tauri
  // directory scan), registers them as data-only records behind the
  // representative, and submits a PATH+PATTERN base reference — the
  // schema form the catalog flow's cut pattern already uses — so the
  // service resolves every sibling face, the auto format tier picks
  // ttc, the report's 字重档位 lists every slot, and the artifact is
  // the family collection. The single-file donor keeps the plain path
  // string (single-slot semantics), and the identity surfaces keep
  // reading the representative's own name.
  test("round 13: a local file from a multi-face directory builds the family's whole matrix as ttc", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const fontsDir = await mkdtemp(resolve(tmpdir(), "fontalloy-localfam-"));
    const familyFaces = await generateFamily(fontsDir);
    const donorDir = await mkdtemp(resolve(tmpdir(), "fontalloy-localdon-"));
    const { donor } = await generateFonts(donorDir);
    const service = await spawnServeOverFonts(fontsDir, [
      "--font-dir",
      donorDir,
    ]);

    const saved: string[] = [];
    const saveDir = await mkdtemp(resolve(tmpdir(), "fontalloy-save-"));
    try {
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
      const serveUrl = await service.url;
      await page.addInitScript((url: string) => {
        const config = window as unknown as {
          __FONTALLOY_CONFIG__: Record<string, unknown>;
        };
        config.__FONTALLOY_CONFIG__ ??= {};
        config.__FONTALLOY_CONFIG__.serveUrl = url;
      }, serveUrl);
      collectJsErrors(page, jsErrors);
      await page.goto("/");
      await waitForFontsReady(page);

      await loadIntoPicker(page, "en", familyFaces[0]!); // AlloyFamily-Regular
      await loadIntoPicker(page, "cjk", donor);

      // UX parity (unchanged): the pair tag and the picker card read
      // the loaded family's own name — the representative, never a
      // sibling weight.
      await expect(
        page.locator("[data-role='font-pair'] [data-pair='base']"),
      ).toHaveText("Alloy Family");

      // The data-only discipline: exactly ONE FontFace of the family
      // is on document.fonts (the representative; siblings would
      // collide under the shared css family).
      await page.waitForTimeout(600);
      const faceCount = await page.evaluate(
        () =>
          [...document.fonts].filter(
            (face) => face.family.replace(/["']/g, "") === "Alloy Family",
          ).length,
      );
      expect(faceCount).toBe(1);

      // The picker lists ONE local row for the family — the sweep's
      // data-only siblings never surface as ghost rows.
      await pointerClick(
        page,
        page.locator('[data-role="picker-en"] .kit-hd'),
      );
      const popup = page.locator('[data-picker-popup="en"]');
      await expect(popup).toBeVisible();
      await expect(
        popup.locator(".kit-fp", { hasText: "Alloy Family" }),
      ).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(popup).toBeHidden();

      // The submission: the base reference KEEPS its path and gains
      // the same-dir cut pattern (extension-less: every sibling
      // container); the single-file donor stays the plain path string.
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
        path: expect.stringMatching(/AlloyFamily-Regular\.ttf$/),
        pattern: "AlloyFamily-*",
      });
      expect(body.donors).toEqual([
        expect.stringMatching(/donor\.ttf$/),
      ]);
      // The auto format tier resolves the multi-face family as ttc.
      expect(body.output).toEqual({ format: "ttc", family: "ChHsich" });

      const panel = page.locator('[data-testid="build-panel"]');
      await expect(panel.locator("[data-build-stage]").first()).toHaveText(
        "完成",
        { timeout: 60_000 },
      );
      await expect(panel).toContainText("已保存");
      expect(saved.length).toBe(1);

      // The report's 字重档位 lists the family's whole matrix: one
      // slot per sibling face, in the reference's deterministic file
      // order (Bold, Italic, Regular).
      const disclosure = panel.locator(".report-details > summary");
      await pointerClick(page, disclosure);
      const weightSection = panel
        .locator(".report-section")
        .filter({ hasText: "字重档位" });
      await expect(weightSection).toBeVisible();
      const slotLabels = await weightSection
        .locator(".report-fact-label")
        .evaluateAll((labels) =>
          labels.map((label) => (label as HTMLElement).textContent),
        );
      expect(slotLabels).toEqual([
        "700 · 直立",
        "400 · 斜体",
        "400 · 直立",
      ]);

      // The artifact is the family collection (ttcf magic); its first
      // face parses as the merged font (the donor's 中 grafted).
      const savedPath = saved[0]!;
      expect(savedPath.endsWith("ChHsich.ttc")).toBe(true);
      const bytes = readFileSync(savedPath);
      expect(bytes.subarray(0, 4).toString("latin1")).toBe("ttcf");
      const meta = parseFontMeta(
        new Uint8Array(bytes).buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
      );
      expect(meta.family).toBe("ChHsich");
      expect(meta.codepoints).toContain(0x4e2d); // 中
      expect(meta.codepoints).toContain(0x41); // A (the base family)
    } finally {
      await service.dispose();
    }
  });

  test("shows progress while building and stays usable, queueing a second build", async ({
    page,
  }) => {
    // Round 11: the close × adds a third full build to this test —
    // three real merges plus browsing exceed the 30s default.
    test.setTimeout(120_000);
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

      // Round 11 (owner item 6): the panel's own close × — the kit
      // close glyph in the title row — clears every row and hides the
      // panel any time; the next synthesize re-opens it fresh.
      const close = panel.locator(".build-close");
      await expect(close).toHaveAttribute("aria-label", "关闭面板");
      await expect(close.locator("svg")).toBeVisible();
      await pointerClick(page, close);
      await expect(panel).toBeHidden();
      await expect(panel.locator("[data-build-row]")).toHaveCount(0);
      await pointerClick(page, synthesize);
      await expect(panel).toBeVisible();
      await expect(panel.locator("[data-build-row]")).toHaveCount(1);
      await expect(panel.locator("[data-build-stage]").first()).toHaveText(
        "完成",
        { timeout: 30_000 },
      );
      expect(saved.length).toBe(3);
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
      // coding family, the CJK slot the CJK family. Round 9 (owner
      // item 2): rows read the faces' OWN name-table names.
      const baseName = parseFontMeta(
        readFileSync(real.base).buffer.slice(0) as ArrayBuffer,
      ).names.display;
      const donorName = parseFontMeta(
        readFileSync(real.donor).buffer.slice(0) as ArrayBuffer,
      ).names.display;
      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      await pointerClick(
        page,
        page
          .locator('[data-picker-popup="en"] .kit-fp', { hasText: baseName })
          .first(),
      );
      await pointerClick(page, page.locator('[data-role="picker-cjk"] .kit-hd'));
      await pointerClick(
        page,
        page
          .locator('[data-picker-popup="cjk"] .kit-fp', { hasText: donorName })
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
      // JetBrains Mono NF (~4.4k+) and the Maple donor hanzi both present.
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
  //
  // Round 12 (owner item 8): the base zip carries the cut's SECOND
  // weight (Bold, a synthesized 700 face), so the family pick submits
  // the FAMILY CUT pattern (`JetBrainsMonoNerdFont-*.ttf`), the build
  // emits the family's whole weight matrix as a ttc collection, and
  // the report's 字重档位 lists every slot. The donor stays
  // pattern-free — the whole variant pools into nearest matching.
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
    const boldFace = "JetBrainsMonoNerdFont-Bold.ttf";
    const donorFace = "MapleMono-NF-CN-Regular.ttf";
    const [, boldPath] = await generateFamily(
      await mkdtemp(resolve(tmpdir(), "fontalloy-bold-")),
    );
    await copyFile(real.base, resolve(fontsDir, "JetBrainsMono", baseFace));
    await copyFile(boldPath, resolve(fontsDir, "JetBrainsMono", boldFace));
    await copyFile(real.donor, resolve(fontsDir, "MapleMono-NF-CN", donorFace));
    const baseBytes = readFileSync(real.base);
    const boldBytes = readFileSync(boldPath);
    const donorBytes = readFileSync(real.donor);
    const baseZip = makeZip([
      { name: baseFace, data: baseBytes },
      { name: boldFace, data: boldBytes },
    ]);
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
      // the GUI can emit {family, variant} references. The base family
      // carries BOTH faces of its cut (round 12) — the GUI registers
      // the set, the recipe narrows by the cut pattern.
      const sim = await SimCatalog.create([
        {
          family: "JetBrainsMono",
          variant: "Nerd Font",
          faces: [
            { file: baseFace, fontPath: real.base },
            { file: boldFace, fontPath: boldPath },
          ],
        },
        {
          family: "MapleMono",
          variant: "NF-CN",
          file: donorFace,
          fontPath: real.donor,
        },
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

      // Round 9 (owner item 2): rows read the faces' own names.
      const baseName2 = parseFontMeta(
        readFileSync(real.base).buffer.slice(0) as ArrayBuffer,
      ).names.display;
      const donorName2 = parseFontMeta(
        readFileSync(real.donor).buffer.slice(0) as ArrayBuffer,
      ).names.display;
      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      await pointerClick(
        page,
        page
          .locator('[data-picker-popup="en"] .kit-fp', { hasText: baseName2 })
          .first(),
      );
      await pointerClick(page, page.locator('[data-role="picker-cjk"] .kit-hd'));
      await pointerClick(
        page,
        page
          .locator('[data-picker-popup="cjk"] .kit-fp', { hasText: donorName2 })
          .first(),
      );
      await waitForFontsReady(page);

      // The submission body names the catalog families (round 6). The
      // base carries the FAMILY CUT pattern (round 12: every face of
      // the picked variant's cut — the output's weight matrix); the
      // donor references the whole variant, pattern-free as before.
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
        pattern: "JetBrainsMonoNerdFont-*.ttf",
      });
      expect(body.donors).toEqual([
        { family: "MapleMono", variant: "NF-CN" },
      ]);
      // A family pick builds the whole matrix — a multi-face output is
      // a ttc collection.
      expect(body.output).toEqual({ format: "ttc", family: "ChHsich" });

      const panel = page.locator('[data-testid="build-panel"]');
      await expect(panel).toBeVisible();
      await expect(
        panel.locator("[data-build-stage]").first(),
      ).toHaveText("完成", { timeout: 120_000 });
      await expect(panel).toContainText("已保存");
      expect(saved.length).toBe(1);

      // The report lists the family's whole weight matrix (round 12):
      // one slot per base face, in the base file's own (alphabetical
      // extract) order — Bold's 700 upright, then the Regular cut's
      // 400 upright, each with its nearest-matched donor borrow.
      const disclosure = panel.locator(".report-details > summary");
      await pointerClick(page, disclosure);
      const weightSection = panel
        .locator(".report-section")
        .filter({ hasText: "字重档位" });
      await expect(weightSection).toBeVisible();
      const slotLabels = await weightSection
        .locator(".report-fact-label")
        .evaluateAll((labels) =>
          labels.map((label) => (label as HTMLElement).textContent),
        );
      expect(slotLabels).toEqual(["700 · 直立", "400 · 直立"]);
      // Round 12's ratified borrow direction: 成品档位 ← 来源字体 · via.
      // (Both streams fixed the same stale pre-round-12 regex; C's
      // exact-string form is the stronger pin.)
      await expect(weightSection).toContainText(
        "700 ← Maple Mono CN · 自动取最近",
      );

      // The saved artifact is the family collection (ttcf magic); its
      // first face parses as the merged font (中 + a Nerd Font
      // powerline glyph — the manifest-resolved sources both grafted).
      const savedPath = saved[0]!;
      expect(savedPath.endsWith("ChHsich.ttc")).toBe(true);
      const bytes = readFileSync(savedPath);
      expect(bytes.subarray(0, 4).toString("latin1")).toBe("ttcf");
      const meta = parseFontMeta(
        new Uint8Array(bytes).buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
      );
      expect(meta.family).toBe("ChHsich");
      expect(meta.codepoints).toContain(0x4e2d); // 中
      expect(meta.codepoints).toContain(0xe0b0); // a Nerd Font powerline glyph
    } finally {
      await service.dispose();
    }
  });
});
