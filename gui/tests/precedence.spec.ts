import { test, expect, type Page } from "@playwright/test";
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
 * Issue #18 (prototype parity): precedence and the effective preview
 * grid.
 *
 * The grid must render the EFFECTIVE merged result (each codepoint in
 * its winning font per the resolver semantics); the user sets
 * precedence through the workspace's own affordances — the 文字范围
 * language chips, the 按编码指定 popup, the char popup at the cell, and
 * the toolbar's block/group segments — with the rail's 自定义规则 list
 * as the read-only human summary of the same rule state.
 *
 * The fixtures are synthetic (e2e_fonts.py): a base covering the ASCII
 * letters, a donor covering a CJK run plus — with `--donor-ascii N` —
 * the first N ASCII letters so override cases exist (the two coverages
 * are otherwise disjoint and "override" could never be observed).
 */

/** The count of human summary rows in the 自定义规则 section. */
async function summaryRowCount(page: Page): Promise<number> {
  return page.locator("[data-role='rule-row']").count();
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

  /** Apply one side to a range through the 按编码指定 popup. */
  async function addRangeRule(
    page: Page,
    start: string,
    end: string,
    side: "base" | "donor",
  ): Promise<void> {
    await pointerClick(page, page.locator("[data-role='range-specify']"));
    const popup = page.locator("[data-range-popup]");
    await expect(popup).toBeVisible();
    await popup.locator("[data-role='range-start']").fill(start);
    await popup.locator("[data-role='range-end']").fill(end);
    if (side === "donor") {
      const sideSel = popup.locator("[data-role='range-side']");
      await pointerClick(page, sideSel.locator(".kit-csel"));
      // Visible-wait before the option click: under parallel load the
      // palette's allow-discrete open lags the click that opened it.
      await expect(sideSel.locator(".kit-csel-pk")).toBeVisible();
      await pointerClick(page, sideSel.locator(".kit-cso[data-value='donor']"));
    }
    await pointerClick(page, popup.locator("[data-role='range-add']"));
    await expect(popup).toBeHidden();
  }

  /** Apply one side to a single codepoint through the char popup. */
  async function setCodepointSide(
    page: Page,
    cp: string,
    side: "base" | "donor",
  ): Promise<void> {
    await pointerClick(
      page,
      page.locator(`.charmap-grid .kit-cell[data-cp='${cp}']`),
    );
    const popup = page.locator("[data-char-popup]");
    await expect(popup).toBeVisible();
    await pointerClick(
      page,
      popup.locator(`[data-role='char-${side === "base" ? "base" : "donor"}']`),
    );
    await expect(popup).toBeHidden();
  }

  /* --------------------------------------------------------------- */
  /* The 文字范围 language chips (the prototype's four fixed chips).   */
  /* --------------------------------------------------------------- */

  test("the 文字范围 chips: verbatim labels/counts, pressed states, guard", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);

    // Four fixed chips, always visible, verbatim labels + counts; a
    // fresh state declares 简体中文 (the prototype boots langs=zh_cn).
    const chips = page.locator("[data-role='lang-chip']");
    await expect(chips).toHaveCount(4);
    await expect(chips.nth(0)).toHaveText("简体中文6,765");
    await expect(chips.nth(1)).toHaveText("繁体中文13,063");
    await expect(chips.nth(2)).toHaveText("日文2,314");
    await expect(chips.nth(3)).toHaveText("韩文2,442");
    await expect(chips.nth(0)).toHaveAttribute("aria-pressed", "true");
    await expect(chips.nth(1)).toHaveAttribute("aria-pressed", "false");

    // The last language cannot be removed: the guard announces
    // 至少保留一种 and the rule stays.
    await pointerClick(page, chips.nth(0));
    await expect(page.locator("[data-role='live']")).toHaveText("至少保留一种");
    await expect(chips.nth(0)).toHaveAttribute("aria-pressed", "true");

    // Adding a language declares its preset rule; the chip presses.
    await pointerClick(page, chips.nth(1));
    await expect(chips.nth(1)).toHaveAttribute("aria-pressed", "true");
    // Now zh_cn CAN come off (another language holds the floor).
    await pointerClick(page, chips.nth(0));
    await expect(chips.nth(0)).toHaveAttribute("aria-pressed", "false");

    // Toggling back on re-declares it, one undo entry per toggle.
    await pointerClick(page, chips.nth(0));
    await expect(chips.nth(0)).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Control+z");
    await expect(chips.nth(0)).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.press("Control+z");
    await expect(chips.nth(0)).toHaveAttribute("aria-pressed", "true");

    // The declared scope feeds the 缺失 aggregate (the fixture pair
    // covers only a slice of zh_cn) and the whole-merge 缺失 counter.
    const missingChip = page.locator(".kit-catbar .kit-cat-g[data-group='missing']");
    await expect(missingChip).toBeVisible();
    expect(
      Number(((await missingChip.locator(".n").textContent()) ?? "0").replace(/,/g, "")),
    ).toBeGreaterThan(6000);

    // The 添加语言预设… picker remains the deep extension (zh_hk).
    await pointerClick(page, page.locator("[data-role='add-preset']"));
    const popup = page.locator('[data-picker-popup="preset-add"]');
    await expect(popup).toBeVisible();
    await pointerClick(
      page,
      popup.locator(".kit-fp", { hasText: /^zh_hk/ }).first(),
    );
    await expect(popup).toBeHidden();
    // zh_hk (declared last) supplies U+4E00: the donor fills it via the
    // rule (rule-N — after zh_cn, zh_tw, and any other preset rules).
    await gotoCjkPage(page);
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+4E00']"),
    ).toHaveAttribute("data-winner", "donor-0");
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+4E00']"),
    ).toHaveAttribute("data-kind", "fill");

    // An open-overlay screenshot of this feature: the preset picker
    // popup open over the workspace (seam-3 rule).
    await pointerClick(page, page.locator("[data-role='add-preset']"));
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

      // Rule set exercising every granularity through the real UI, in
      // declaration order (the boot-seeded zh_cn preset — [base,
      // donor-0], resolution-neutral — is complete rule 0 before these):
      //   rule-1 range 0x41-0x46 -> [base]     (both hold: rule supplies base)
      //   rule-2 codepoint 0x42 -> [donor-0]   (cp beats the range: override)
      //   rule-3 range 0x4E00-0x4E0F -> [base] (absence: base lacks CJK)
      await addRangeRule(page, "0x41", "0x46", "base");
      await setCodepointSide(page, "U+0042", "donor");
      await addRangeRule(page, "0x4E00", "0x4E0F", "base");
      await expect.poll(() => summaryRowCount(page)).toBe(2);
      await expect(page.locator("[data-role='rule-solo']")).toHaveCount(1);

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

      // The recipe the GUI submitted echoes the serialized rule list
      // (the boot-seeded zh_cn preset first, then the UI-declared rules).
      expect(report.rules).toEqual([
        { id: "rule-0", granularity: "set", target: "zh_cn", fonts: ["base", "donor-0"] },
        {
          id: "rule-1",
          granularity: "range",
          target: "0x41-0x46",
          fonts: ["base"],
        },
        { id: "rule-2", granularity: "codepoint", target: "0x42", fonts: ["donor-0"] },
        {
          id: "rule-3",
          granularity: "range",
          target: "0x4E00-0x4E0F",
          fonts: ["base"],
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
    await addRangeRule(page, "0x0041", "0x005A", "donor");

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

    // The popup states the source in plain text.
    await pointerClick(page, page.locator(".charmap-grid .kit-cell[data-cp='U+005A']"));
    const popup = page.locator("[data-char-popup]");
    await expect(popup.locator("[data-role='char-code']")).toHaveText("U+005A");
    await expect(popup.locator("[data-role='char-from']")).toContainText(
      "来自 AlloyBase",
    );
  });

  /* --------------------------------------------------------------- */
  /* Cell click sets single-codepoint precedence through the popup.    */
  /* --------------------------------------------------------------- */

  test("clicking a cell sets single-codepoint precedence through the popup", async ({
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

    // Click the cell; the popup offers the two one-click sides.
    await pointerClick(page, page.locator(".charmap-grid .kit-cell[data-cp='U+0041']"));
    const popup = page.locator("[data-char-popup]");
    await expect(popup).toBeVisible();
    await expect(popup.locator("[data-role='char-base']")).toBeHidden();
    await expect(popup.locator("[data-role='char-donor']")).toBeVisible();

    // 用中文字体: the override displaces the base glyph.
    await pointerClick(page, popup.locator("[data-role='char-donor']"));
    const cell = page.locator(".charmap-grid .kit-cell[data-cp='U+0041']");
    await expect(cell).toHaveAttribute("data-winner", "donor-0");
    await expect(cell).toHaveAttribute("data-via", "rule-1");
    await expect(cell).toHaveAttribute("data-kind", "override");
    expect(await cellRenderFamily(page, "U+0041")).toBe("AlloyDonor");

    // Pressing the popup's carried side again (from the popup of the
    // same cell) reverts to the deeper layers — and 恢复默认 appears
    // while the override exists and changes the outcome.
    await pointerClick(page, cell);
    await expect(popup.locator("[data-role='char-donor']")).toBeHidden();
    await expect(popup.locator("[data-role='char-base']")).toBeVisible();
    await expect(popup.locator("[data-role='char-reset']")).toBeVisible();
    await pointerClick(page, popup.locator("[data-role='char-reset']"));
    await expect(cell).toHaveAttribute("data-winner", "base");
    await expect(cell).toHaveAttribute("data-via", "default");
    expect(await cellRenderFamily(page, "U+0041")).toBe("AlloyBase");
  });

  test("typing a codepoint locates it; the popup applies; updates are live", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);

    // Type a codepoint and locate it from the aggregate view.
    const locate = page.locator(".kit-toolrow [data-role='locate']");
    await locate.fill("4E2D");
    await locate.press("Enter");

    // The grid jumped to the codepoint's page and set the cursor.
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+4E2D']"),
    ).toHaveClass(/cur/);
    await expect(page.locator(".kit-toolrow [data-pager-label]")).toHaveText(
      "第 1/21 页",
    );

    // The popup states the effective source: U+4E2D sits in the
    // boot-seeded zh_cn scope, so the preset rule (base keeps, donor
    // fills) supplies it.
    await pointerClick(
      page,
      page.locator(".charmap-grid .kit-cell[data-cp='U+4E2D']"),
    );
    const popup = page.locator("[data-char-popup]");
    await expect(popup.locator("[data-role='char-code']")).toHaveText("U+4E2D");
    await expect(popup.locator("[data-role='char-from']")).toContainText(
      "来自 AlloyDonor",
    );
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+4E2D']"),
    ).toHaveAttribute("data-via", "rule-0");

    // The char is donor-carried: the donor side's button hides, and
    // 用英文字体 declares an override the base CANNOT supply (absence
    // never overrides) — the default keeps rendering it, via "default".
    await expect(popup.locator("[data-role='char-donor']")).toBeHidden();
    await expect(popup.locator("[data-role='char-base']")).toBeVisible();
    await pointerClick(page, popup.locator("[data-role='char-base']"));
    const cell = page.locator(".charmap-grid .kit-cell[data-cp='U+4E2D']");
    await expect(cell).toHaveAttribute("data-winner", "donor-0");
    await expect(cell).toHaveAttribute("data-via", "default");

    // Live update, no reload: same pager state, sibling cell untouched
    // (丮 U+4E2E is a rare han OUTSIDE the seeded zh_cn scope — it keeps
    // the default precedence, no rule supplying it).
    await expect(page.locator(".kit-toolrow [data-pager-label]")).toHaveText(
      "第 1/21 页",
    );
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+4E2E']"),
    ).toHaveAttribute("data-via", "default");

    // The dashed summary counts the single-character override, and its
    // removal (the popup's 恢复默认) clears it.
    await expect(page.locator("[data-role='rule-solo']")).toHaveText(/单个字符1/);
    await pointerClick(page, cell);
    await expect(popup.locator("[data-role='char-reset']")).toBeVisible();
    await pointerClick(page, popup.locator("[data-role='char-reset']"));
    await expect(cell).toHaveAttribute("data-via", "rule-0");
    await expect(page.locator("[data-role='rule-solo']")).toHaveCount(0);
  });

  /* --------------------------------------------------------------- */
  /* The summary list: sentences, delete, merged groups, reset.        */
  /* --------------------------------------------------------------- */

  test("the 自定义规则 summaries read as sentences and remove cleanly", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);

    // Empty state (the 文字范围 chips own the preset scope).
    await expect(page.locator(".kit-rl-empty")).toHaveText("暂无自定义规则。");

    // A block assignment reads as its sentence.
    await pointerClick(page, page.locator(".kit-cat-g[data-group='latin-europe']"));
    await pointerClick(page, page.locator(".kit-cat-s[data-block='basic-latin']"));
    const row = page.locator(".kit-toolrow").filter({ hasText: "基本拉丁" });
    await pointerClick(
      page,
      row.locator(".kit-mseg button").filter({ hasText: /^用中文$/ }),
    );
    const blockRow = page.locator("[data-role='rule-row'][data-kind='block']");
    await expect(blockRow).toHaveText(/基本拉丁用中文字体/);

    // A custom range reads with the character sentence + dim U+ suffix.
    await addRangeRule(page, "0x4E10", "0x4E13", "donor");
    const rangeRow = page.locator("[data-role='rule-row'][data-kind='range']");
    await expect(rangeRow).toHaveText(/用中文字体/);
    await expect(rangeRow.locator(".kit-us")).toHaveText(
      "U+4E10 至 U+4E13",
    );

    // A single-codepoint rule collapses into the dashed summary row.
    await gotoCjkPage(page);
    await setCodepointSide(page, "U+4E20", "base");
    await expect(page.locator("[data-role='rule-solo']")).toHaveText(/单个字符1/);

    // The range row's delete × removes exactly that rule.
    await pointerClick(page, rangeRow.locator("[data-role='remove-rule']"));
    await expect(rangeRow).toHaveCount(0);
    await expect(blockRow).toHaveCount(1);

    // 全部恢复默认 clears every customization in one undoable step.
    await pointerClick(page, page.locator("[data-role='undo-all']"));
    await expect(page.locator(".kit-rl-empty")).toHaveText("暂无自定义规则。");
    await page.keyboard.press("Control+z");
    await expect(blockRow).toHaveCount(1);
    await expect(page.locator("[data-role='rule-solo']")).toHaveCount(1);
  });
});

/** JSON GET over the serve contract (the same seam the app speaks). */
async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  return response.json();
}
