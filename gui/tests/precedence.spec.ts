import { test, expect, type Page, type Locator } from "@playwright/test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { generateFonts, startServeFixture, type ServeFixture } from "./serve";
import {
  assertNoJsErrors,
  collectJsErrors,
  pointerClick,
  waitForFontsReady,
} from "./helpers";

/**
 * Issue #18: precedence editing and the effective preview grid.
 *
 * The grid must render the EFFECTIVE merged result (each codepoint in its
 * winning font per the resolver semantics) and the user sets precedence by
 * clicking a cell or typing a codepoint, with rules at every granularity
 * including language presets with sub-block toggles.
 *
 * The fixtures are synthetic (e2e_fonts.py): a base covering the ASCII
 * letters, a donor covering a CJK run plus — with `--donor-ascii N` — the
 * first N ASCII letters so override cases exist (the two coverages are
 * otherwise disjoint and "override" could never be observed).
 */

/** The count of COMPLETE rules, read from the rail (incomplete rows show
 *  an ellipsis placeholder as their target label). */
async function completeRuleCount(page: Page): Promise<number> {
  return page.evaluate(
    () => document.querySelectorAll("[data-rule-id][data-complete='true']").length,
  );
}

test.describe("precedence editing", () => {
  test.describe.configure({ mode: "serial" });
  const jsErrors: string[] = [];

  test.beforeEach(() => {
    jsErrors.length = 0;
  });

  test.afterEach(() => assertNoJsErrors(jsErrors));

  /** Small fixture pair: base = A–Z, donor = A–F + U+4E00..U+4E3F. */
  async function makeLocalFixtures(): Promise<{ base: string; donor: string }> {
    const dir = await mkdtemp(resolve(tmpdir(), "fontalloy-prec-"));
    return generateFonts(dir, { donorGlyphs: 64, donorAscii: 6 });
  }

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

  /** Open the page (no service) with both fixture fonts picked. */
  async function openWithFonts(
    page: Page,
    fonts: { base: string; donor: string },
  ): Promise<void> {
    collectJsErrors(page, jsErrors);
    await page.goto("/");
    await waitForFontsReady(page);
    await loadIntoPicker(page, "en", fonts.base);
    await loadIntoPicker(page, "cjk", fonts.donor);
  }

  /** The grid's effective table on the current page, from cell attributes. */
  function collectGrid(page: Page): Promise<Record<string, [string, string, string]>> {
    return page.evaluate(() => {
      const out: Record<string, [string, string, string]> = {};
      for (const cell of document.querySelectorAll(".charmap-grid .kit-cell")) {
        const cp = cell.getAttribute("data-cp");
        if (!cp) continue;
        out[cp] = [
          cell.getAttribute("data-winner") ?? "",
          cell.getAttribute("data-via") ?? "",
          cell.getAttribute("data-kind") ?? "",
        ];
      }
      return out;
    });
  }

  /** The first family of a cell's computed font (what actually renders it). */
  function cellRenderFamily(page: Page, cp: string): Promise<string> {
    return page.evaluate((target) => {
      const cell = document.querySelector(
        `.charmap-grid .kit-cell[data-cp='${target}']`,
      );
      if (!cell) return "";
      return getComputedStyle(cell).fontFamily.split(",")[0]!.trim();
    }, cp);
  }

  async function gotoCjkPage(page: Page): Promise<void> {
    await pointerClick(page, page.locator(".kit-cat-g[data-group='cjk']"));
    await pointerClick(
      page,
      page.locator(".kit-cat-s[data-block='cjk-unified']"),
    );
    await expect(page.locator(".kit-toolrow [data-pager-label]")).toHaveText(
      "第 1/21 页",
    );
  }

  /* --------------------------------------------------------------- */
  /* The hard gate: consistency with the resolver through real serve. */
  /* --------------------------------------------------------------- */

  test("grid resolution matches the serve build's report provenance", async ({
    page,
  }) => {
    const service = await startServeFixture({
      donorGlyphs: 64,
      donorAscii: 6,
    });
    const saved: string[] = [];
    try {
      // The save stand-in (the synthesize flow saves through it).
      const saveDir = await mkdtemp(resolve(tmpdir(), "fontalloy-save-"));
      await page.exposeFunction("__fontalloyTestSave", async (name: string, b64: string) => {
        const target = resolve(saveDir, name);
        await writeFile(target, Buffer.from(b64, "base64"));
        saved.push(target);
        return target;
      });
      await page.addInitScript(() => {
        const config = window as unknown as {
          __FONTALLOY_CONFIG__: Record<string, unknown>;
        };
        config.__FONTALLOY_CONFIG__ = {
          saveArtifact: async (
            _name: string,
            bytes: Uint8Array,
          ): Promise<{ saved: boolean; path: string | null }> => {
            const b64 = btoa(
              Array.from(bytes, (b) => String.fromCharCode(b)).join(""),
            );
            const path = await window.__fontalloyTestSave(_name, b64);
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

      await loadIntoPicker(page, "en", service.baseFont);
      await loadIntoPicker(page, "cjk", service.donorFont);

      // Rule set exercising all four granularities, declared in order:
      //   rule-0 set zh_cn -> [donor-0]           (override intent)
      //   rule-1 range 4E00-4E0F -> [base]        (absence: base lacks CJK)
      //   rule-2 codepoint 0x41 -> [donor-0]      (override)
      //   rule-3 codepoint 0x4E08 -> [base, donor-0] (cp beats range)
      await addPresetRule(page, "zh_cn", ["donor-0"]);
      await addRangeRule(page, "0x4E00", "0x4E0F", ["base"]);
      await addCodepointRuleViaRail(page, "0x41", ["donor-0"]);
      await addCodepointRuleViaRail(page, "0x4E08", ["base", "donor-0"]);
      await expect.poll(() => completeRuleCount(page)).toBe(4);

      // Collect the client-side resolution over the whole coverage union
      // (base A–Z on page 1 of "all"; donor 4E00–4E3F on CJK page 1).
      const asciiPage = await collectGrid(page);
      await gotoCjkPage(page);
      const cjkPage = await collectGrid(page);
      const dom: Record<string, [string, string, string]> = {
        ...asciiPage,
        ...cjkPage,
      };

      // Synthesize: the same rule state through the real serve pipeline.
      const synthesize = page.locator(".topbar [data-role='synthesize']");
      await expect(synthesize).toHaveAttribute("aria-disabled", "false");
      await pointerClick(page, synthesize);
      await expect(
        page.locator(".build-row", { hasText: "已保存" }),
      ).toBeVisible({ timeout: 60_000 });

      // The report (fetched over the same serve contract) is the oracle.
      const builds = (await fetchJson(`${service.url}/builds`)) as {
        builds: Array<{ id: string; status: string }>;
      };
      const job = builds.builds[builds.builds.length - 1]!;
      expect(job.status).toBe("done");
      const report = (await fetchJson(
        `${service.url}/builds/${job.id}/report`,
      )) as {
        rules: Array<{
          id: string;
          granularity: string;
          target: string;
          fonts: string[];
        }>;
        provenance: Array<{
          codepoint: number;
          winner: string;
          in_output: boolean;
          via: string;
          kind: string;
        }>;
      };

      // The recipe the GUI submitted echoes the serialized rule list.
      expect(report.rules).toEqual([
        { id: "rule-0", granularity: "set", target: "zh_cn", fonts: ["donor-0"] },
        {
          id: "rule-1",
          granularity: "range",
          target: "0x4E00-0x4E0F",
          fonts: ["base"],
        },
        { id: "rule-2", granularity: "codepoint", target: "0x41", fonts: ["donor-0"] },
        {
          id: "rule-3",
          granularity: "codepoint",
          target: "0x4E08",
          fonts: ["base", "donor-0"],
        },
      ]);

      // Winners agree per codepoint — winner, via, and kind.
      expect(report.provenance.length).toBeGreaterThan(0);
      const seen = new Set<string>();
      for (const entry of report.provenance) {
        const cp = `U+${entry.codepoint.toString(16).toUpperCase().padStart(4, "0")}`;
        const domEntry = dom[cp];
        expect(domEntry, `codepoint ${cp} missing from the grid walk`).toBeDefined();
        seen.add(cp);
        expect(domEntry, `codepoint ${cp}`).toEqual([
          entry.winner,
          entry.via,
          entry.kind,
        ]);
        expect(entry.in_output, `codepoint ${cp} should be in the built font`).toBe(true);
      }
      // And the grid claims no covered codepoint the resolver does not.
      const domCovered = Object.entries(dom).filter(([, v]) => v[0] !== "");
      expect(domCovered.length).toBe(report.provenance.length);
      for (const [cp] of domCovered) expect(seen.has(cp), `${cp} not in provenance`).toBe(true);
    } finally {
      await service.dispose();
    }
  });

  /* --------------------------------------------------------------- */
  /* Absence never overrides.                                          */
  /* --------------------------------------------------------------- */

  test("a donor gap leaves the base rendering (absence never overrides)", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);

    // Rule "0x0041-0x005A -> [donor-0]": override intent over all ASCII.
    await addRangeRule(page, "0x0041", "0x005A", ["donor-0"]);

    // A–F: the donor holds them, so the rule overrides the base.
    await expect(page.locator(".charmap-grid .kit-cell[data-cp='U+0041']")).toHaveAttribute(
      "data-winner",
      "donor-0",
    );
    await expect(page.locator(".charmap-grid .kit-cell[data-cp='U+0041']")).toHaveAttribute(
      "data-kind",
      "override",
    );
    expect(await cellRenderFamily(page, "U+0041")).toBe("AlloyDonor");

    // Z: the donor LACKS it — absence never overrides, the base renders.
    await expect(page.locator(".charmap-grid .kit-cell[data-cp='U+005A']")).toHaveAttribute(
      "data-winner",
      "base",
    );
    await expect(page.locator(".charmap-grid .kit-cell[data-cp='U+005A']")).toHaveAttribute(
      "data-via",
      "default",
    );
    expect(await cellRenderFamily(page, "U+005A")).toBe("AlloyBase");

    // The details strip states the fallback in plain text.
    await pointerClick(page, page.locator(".charmap-grid .kit-cell[data-cp='U+005A']"));
    const details = page.locator(".charmap-details");
    await expect(details).toContainText("U+005A");
    await expect(details).toContainText("英文字体 AlloyBase");
    await expect(details).toContainText("默认");
  });

  /* --------------------------------------------------------------- */
  /* Cell click and codepoint entry set single-codepoint rules.        */
  /* --------------------------------------------------------------- */

  test("clicking a cell sets single-codepoint precedence (ordered font list)", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);

    // U+0041 defaults to the base (both fonts hold it, base first).
    await expect(page.locator(".charmap-grid .kit-cell[data-cp='U+0041']")).toHaveAttribute(
      "data-winner",
      "base",
    );
    await expect(page.locator(".charmap-grid .kit-cell[data-cp='U+0041']")).toHaveAttribute(
      "data-via",
      "default",
    );

    // Click the cell; the details strip opens the precedence editor.
    await pointerClick(page, page.locator(".charmap-grid .kit-cell[data-cp='U+0041']"));
    const editor = page.locator("[data-role='cp-rule-editor']");
    await expect(editor).toBeVisible();

    // Include donor-0 and move it above base: [donor-0, base].
    await editor.locator("[data-role='cp-font-donor-0']").check();
    await pointerClick(page, editor.locator("[data-role='cp-font-up-donor-0']"));
    await pointerClick(page, editor.locator("[data-role='cp-rule-apply']"));

    // The grid updates in place: override by rule, donor renders it.
    const cell = page.locator(".charmap-grid .kit-cell[data-cp='U+0041']");
    await expect(cell).toHaveAttribute("data-winner", "donor-0");
    await expect(cell).toHaveAttribute("data-via", "rule-0");
    await expect(cell).toHaveAttribute("data-kind", "override");
    expect(await cellRenderFamily(page, "U+0041")).toBe("AlloyDonor");
    await expect.poll(() => completeRuleCount(page)).toBe(1);

    // The editor reflects the existing rule; removing it restores default.
    await expect(editor.locator("[data-role='cp-font-donor-0']")).toBeChecked();
    await pointerClick(page, editor.locator("[data-role='cp-rule-remove']"));
    await expect(cell).toHaveAttribute("data-winner", "base");
    await expect(cell).toHaveAttribute("data-via", "default");
    expect(await cellRenderFamily(page, "U+0041")).toBe("AlloyBase");
    await expect.poll(() => completeRuleCount(page)).toBe(0);
  });

  test("typing a codepoint locates it and sets precedence; updates are live", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);

    // Type a codepoint and locate it from the aggregate view.
    const locate = page.locator(".kit-toolrow [data-role='locate']");
    await locate.fill("4E2D");
    await locate.press("Enter");

    // The grid jumped to the codepoint's page and selected the cell.
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+4E2D']"),
    ).toHaveClass(/cur/);
    const details = page.locator(".charmap-details");
    await expect(details).toContainText("U+4E2D");
    await expect(details).toContainText("中文字体 AlloyDonor");
    await expect(details).toContainText("默认");

    // Set its precedence to donor-only through the editor.
    const editor = page.locator("[data-role='cp-rule-editor']");
    await editor.locator("[data-role='cp-font-base']").uncheck();
    await pointerClick(page, editor.locator("[data-role='cp-rule-apply']"));

    const cell = page.locator(".charmap-grid .kit-cell[data-cp='U+4E2D']");
    await expect(cell).toHaveAttribute("data-winner", "donor-0");
    await expect(cell).toHaveAttribute("data-via", "rule-0");
    await expect(cell).toHaveAttribute("data-kind", "fill");

    // Live update, no reload: same pager state, sibling cell untouched.
    await expect(page.locator(".kit-toolrow [data-pager-label]")).toHaveText(
      "第 1/21 页",
    );
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+4E2E']"),
    ).toHaveAttribute("data-via", "default");

    // The rule is visible and editable in the rail's custom rule list.
    const row = page.locator("[data-role='custom-rule']").first();
    await expect(row).toContainText("0x4E2D");
  });

  /* --------------------------------------------------------------- */
  /* Language presets with sub-block toggles.                          */
  /* --------------------------------------------------------------- */

  test("language presets select with sub-block toggles (union semantics)", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);

    await addPresetRule(page, "zh_hk", ["base", "donor-0"]);

    // The preset row shows both sub-blocks on: the union is zh_hk.
    const row = page.locator("[data-role='preset-rule']").first();
    await expect(row).toContainText("zh_hk");
    await expect(row).toContainText("生效集合：zh_hk");
    await expect(row.locator("[data-role='subblock-zh_tw']")).toBeChecked();
    await expect(row.locator("[data-role='subblock-zh_hk_supplement']")).toBeChecked();

    // 一 (U+4E00) is in zh_tw (hence zh_hk) — the rule supplies it:
    // base lacks it, so the donor wins via the rule.
    await gotoCjkPage(page);
    await expect(page.locator(".charmap-grid .kit-cell[data-cp='U+4E00']")).toHaveAttribute(
      "data-via",
      "rule-0",
    );

    // Toggle zh_tw off: U+4E00 is NOT in the supplement alone, so the
    // rule no longer covers it — the default precedence takes over.
    await row.locator("[data-role='subblock-zh_tw']").uncheck();
    await expect(row).toContainText("生效集合：zh_hk_supplement");
    await expect(page.locator(".charmap-grid .kit-cell[data-cp='U+4E00']")).toHaveAttribute(
      "data-via",
      "default",
    );

    // Toggle back on: the union covers it again.
    await row.locator("[data-role='subblock-zh_tw']").check();
    await expect(page.locator(".charmap-grid .kit-cell[data-cp='U+4E00']")).toHaveAttribute(
      "data-via",
      "rule-0",
    );

    // An open-overlay screenshot of this feature: the preset picker
    // popup open over the workspace (seam-3 rule).
    await pointerClick(page, page.locator("[data-role='add-preset']"));
    const popup = page.locator('[data-picker-popup="preset-add"]');
    await expect(popup).toBeVisible();
    const { mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(process.cwd(), "test-results", "screenshots");
    mkdirSync(dir, { recursive: true });
    await page.screenshot({
      path: join(dir, "precedence-preset-picker.png"),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
  });

  /* --------------------------------------------------------------- */
  /* The rule list: viewable and editable in the left column.          */
  /* --------------------------------------------------------------- */

  test("custom ranges are editable in the left column; fonts reorder; rules remove", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);

    // New range rule over the overlap; default order [base, donor-0].
    await pointerClick(page, page.locator("[data-role='add-range-rule']"));
    const row = page.locator("[data-role='custom-rule']").first();
    const id = await row.getAttribute("data-rule-id");
    await row.locator(`[data-role='rule-start-${id}']`).fill("0x0041");
    await row.locator(`[data-role='rule-end-${id}']`).fill("0x0046");

    // base is first and holds A–F: base wins via the rule.
    await expect(page.locator(".charmap-grid .kit-cell[data-cp='U+0041']")).toHaveAttribute(
      "data-winner",
      "base",
    );
    await expect(page.locator(".charmap-grid .kit-cell[data-cp='U+0041']")).toHaveAttribute(
      "data-via",
      "rule-0",
    );

    // Reorder within the rule: donor-0 above base flips the winner.
    await pointerClick(page, row.locator(`[data-role='rule-font-up-${id}-donor-0']`));
    await expect(page.locator(".charmap-grid .kit-cell[data-cp='U+0041']")).toHaveAttribute(
      "data-winner",
      "donor-0",
    );
    expect(await cellRenderFamily(page, "U+0041")).toBe("AlloyDonor");

    // Removing the rule restores the default precedence, live.
    await expect.poll(() => completeRuleCount(page)).toBe(1);
    await pointerClick(page, row.locator("[data-role='remove-rule']"));
    await expect.poll(() => completeRuleCount(page)).toBe(0);
    await expect(page.locator(".charmap-grid .kit-cell[data-cp='U+0041']")).toHaveAttribute(
      "data-winner",
      "base",
    );
    await expect(page.locator(".charmap-grid .kit-cell[data-cp='U+0041']")).toHaveAttribute(
      "data-via",
      "default",
    );

    // A codepoint rule added from the rail list is editable there too.
    await pointerClick(page, page.locator("[data-role='add-cp-rule']"));
    const cpRow = page.locator("[data-role='custom-rule']").first();
    const cpId = await cpRow.getAttribute("data-rule-id");
    await cpRow.locator(`[data-role='rule-codepoint-${cpId}']`).fill("0x4E10");
    await cpRow.locator(`[data-role='rule-font-${cpId}-base']`).uncheck();
    await gotoCjkPage(page);
    await expect(page.locator(".charmap-grid .kit-cell[data-cp='U+4E10']")).toHaveAttribute(
      "data-via",
      "rule-0",
    );
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+4E10']"),
    ).toHaveAttribute("data-winner", "donor-0");
  });

  /* --------------------------------------------------------------- */
  /* Helpers driving the rail rule editors through the real UI.        */
  /* --------------------------------------------------------------- */

  /** Add a preset rule through the preset picker; set fonts order. */
  async function addPresetRule(
    page: Page,
    preset: string,
    fonts: string[],
  ): Promise<void> {
    await pointerClick(page, page.locator("[data-role='add-preset']"));
    const popup = page.locator('[data-picker-popup="preset-add"]');
    await expect(popup).toBeVisible();
    await pointerClick(
      page,
      popup.locator(".kit-fp", { hasText: new RegExp(`^${preset}`) }).first(),
    );
    await expect(popup).toBeHidden();

    const row = page.locator("[data-role='preset-rule']").last();
    await expect(row).toContainText(preset);
    await setRuleFonts(page, row, fonts);
  }

  /** Add a range rule and fill start/end; set fonts order. */
  async function addRangeRule(
    page: Page,
    start: string,
    end: string,
    fonts: string[],
  ): Promise<void> {
    await pointerClick(page, page.locator("[data-role='add-range-rule']"));
    const row = page.locator("[data-role='custom-rule']").last();
    const id = await row.getAttribute("data-rule-id");
    await row.locator(`[data-role='rule-start-${id}']`).fill(start);
    await row.locator(`[data-role='rule-end-${id}']`).fill(end);
    await setRuleFonts(page, row, fonts);
  }

  /** Add a codepoint rule through the rail add button; set fonts order. */
  async function addCodepointRuleViaRail(
    page: Page,
    cp: string,
    fonts: string[],
  ): Promise<void> {
    await pointerClick(page, page.locator("[data-role='add-cp-rule']"));
    const row = page.locator("[data-role='custom-rule']").last();
    const id = await row.getAttribute("data-rule-id");
    await row.locator(`[data-role='rule-codepoint-${id}']`).fill(cp);
    await setRuleFonts(page, row, fonts);
  }

  /**
   * Set a rule row's font list to exactly `fonts` (in order). New rules
   * default to [base, donor-0]; this unchecks the unwanted and moves the
   * wanted into position with the row's up/down controls.
   */
  async function setRuleFonts(
    page: Page,
    row: Locator,
    fonts: string[],
  ): Promise<void> {
    const id = await row.getAttribute("data-rule-id");
    // Ensure every wanted font is checked and every unwanted unchecked.
    for (const ref of ["base", "donor-0"]) {
      const box = row.locator(`[data-role='rule-font-${id}-${ref}']`);
      const wanted = fonts.includes(ref);
      if (wanted) {
        if (!(await box.isChecked())) await box.check();
      } else if (await box.isChecked()) {
        await box.uncheck();
      }
    }
    // Bubble each font (in order) to the front using its up button.
    for (let i = fonts.length - 1; i >= 0; i--) {
      const ref = fonts[i]!;
      for (;;) {
        const list = await ruleFontOrder(page, row);
        if (list[0] === ref) break;
        const current = list.indexOf(ref);
        if (current <= 0) break;
        await pointerClick(
          page,
          row.locator(`[data-role='rule-font-up-${id}-${ref}']`),
        );
      }
    }
    // Verify the final order.
    expect(await ruleFontOrder(page, row)).toEqual(fonts);
  }

  /** The checked fonts of a rule row, in display (precedence) order. */
  async function ruleFontOrder(
    page: Page,
    row: Locator,
  ): Promise<string[]> {
    return row.evaluate((el) => {
      const out: string[] = [];
      for (const line of el.querySelectorAll("[data-font-ref]")) {
        const box = line.querySelector("input[type=checkbox]");
        if (box instanceof HTMLInputElement && box.checked) {
          out.push(line.getAttribute("data-font-ref")!);
        }
      }
      return out;
    });
  }
});

/** JSON GET over the serve contract (the same seam the app speaks). */
async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  return response.json();
}
