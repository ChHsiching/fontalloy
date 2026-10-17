import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, writeFile } from "node:fs/promises";
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
 * Issue #18 (prototype parity): precedence and the effective preview
 * grid. Ticket #35 (spec #25): the grid's coloring is the SERVE's
 * answer — `POST /precedence-resolve` once per picks/rules change, the
 * response's compressed runs paged locally — so the whole suite drives
 * a REAL fixture serve (the TS resolver mirror is deleted; what the
 * grid shows is what the build resolves).
 *
 * The user sets precedence through the workspace's own affordances —
 * the 文字范围 language chips, the 按编码指定 popup, the char popup at
 * the cell, and the toolbar's block/group segments — with the rail's
 * 自定义规则 list as the read-only human summary of the same rule
 * state.
 *
 * The fixtures are synthetic (e2e_fonts.py): a base covering the ASCII
 * letters, a donor covering a CJK run plus the first 6 ASCII letters
 * so override cases exist (the two coverages are otherwise disjoint
 * and "override" could never be observed).
 */

/** The count of human summary rows in the 自定义规则 section. */
async function summaryRowCount(page: Page): Promise<number> {
  return page.locator("[data-role='rule-row']").count();
}

test.describe("precedence editing", () => {
  test.describe.configure({ mode: "serial" });
  const jsErrors: string[] = [];

  /** The shared fixture serve (ticket #35: the grid resolves through it). */
  let service: ServeFixture | null = null;

  test.beforeAll(async () => {
    service = await startServeFixture({ donorGlyphs: 64, donorAscii: 6 });
  });

  test.afterAll(async () => {
    await service?.dispose();
    service = null;
  });

  test.beforeEach(() => {
    jsErrors.length = 0;
  });

  test.afterEach(() => assertNoJsErrors(jsErrors));

  /** The fixture pair: base = A–Z, donor = A–F + U+4E00..U+4E3F. */
  function makeLocalFixtures(): { base: string; donor: string } {
    const live = service!;
    return { base: live.baseFont, donor: live.donorFont };
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

  /** Open the page pointed at the fixture serve, with both fonts picked. */
  async function openWithFonts(
    page: Page,
    fonts: { base: string; donor: string },
  ): Promise<void> {
    collectJsErrors(page, jsErrors);
    await page.addInitScript((url: string) => {
      const config = window as unknown as {
        __FONTALLOY_CONFIG__: Record<string, unknown>;
      };
      config.__FONTALLOY_CONFIG__ ??= {};
      config.__FONTALLOY_CONFIG__.serveUrl = url;
    }, service!.url);
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

    // The 缺失 aggregate is coverage-driven (round 5): the fixture
    // pair covers only a slice of the browsed universe, and toggling
    // the language chips does not move the count.
    const missingChip = page.locator(".kit-catbar .kit-cat-g[data-group='missing']");
    await expect(missingChip).toBeVisible();
    const missingCount = Number(
      ((await missingChip.locator(".n").textContent()) ?? "0").replace(/,/g, ""),
    );
    expect(missingCount).toBeGreaterThan(6_000);
    await pointerClick(page, chips.nth(3));
    await expect(missingChip.locator(".n")).toHaveText(
      missingCount.toLocaleString("en-US"),
    );

    // The 341-language fc-lang extension left the UI with round 5 (the
    // four chips are all the rail surfaces); recipes and the core keep
    // the deep presets.
    await expect(page.locator("[data-role='add-preset']")).toHaveCount(0);
    await expect(page.locator("[data-picker-popup='preset-add']")).toHaveCount(0);
  });

  /* --------------------------------------------------------------- */
  /* The hard gate: consistency with the resolver through real serve. */
  /* --------------------------------------------------------------- */

  test("grid resolution matches the serve build's report provenance", async ({
    page,
  }) => {
    const saved: string[] = [];
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
    await openWithFonts(page, makeLocalFixtures());
    const svc = service!;

    // Rule set exercising every granularity through the real UI, in
    // declaration order (the boot-seeded zh_cn preset — [base,
    // donor-0], resolution-neutral — is complete rule 0 before these;
    // round 6: side assignments carry the PREFERENCE list [side,
    // other] — "用X字体" means X first, the other font filling what X
    // lacks, so the rule supplies everywhere it covers):
    //   rule-1 range 0x41-0x46 -> [base, donor-0]
    //   rule-2 codepoint 0x42 -> [donor-0, base] (cp beats the range)
    //   rule-3 range 0x4E00-0x4E0F -> [base, donor-0] (base lacks CJK:
    //        the rule still supplies, through the donor)
    await addRangeRule(page, "0x41", "0x46", "base");
    await setCodepointSide(page, "U+0042", "donor");
    await addRangeRule(page, "0x4E00", "0x4E0F", "base");
    await expect.poll(() => summaryRowCount(page)).toBe(2);
    await expect(page.locator("[data-role='rule-solo']")).toHaveCount(1);

    // The resolution is now the serve's answer: wait for the latest
    // document to land on a known cell (the codepoint rule flips
    // U+0042 to the donor) before walking the grid.
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+0042']"),
    ).toHaveAttribute("data-winner", "donor-0");

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
    const builds = (await fetchJson(`${svc.url}/builds`)) as {
      builds: Array<{ id: string; status: string }>;
    };
    const job = builds.builds[builds.builds.length - 1]!;
    expect(job.status).toBe("done");
    const report = (await fetchJson(
      `${svc.url}/builds/${job.id}/report`,
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
    // (the boot-seeded zh_cn preset first, then the UI-declared rules;
    // round 6: assignments carry the [side, other] preference lists).
    expect(report.rules).toEqual([
      { id: "rule-0", granularity: "set", target: "zh_cn", fonts: ["base", "donor-0"] },
      {
        id: "rule-1",
        granularity: "range",
        target: "0x41-0x46",
        fonts: ["base", "donor-0"],
      },
      { id: "rule-2", granularity: "codepoint", target: "0x42", fonts: ["donor-0", "base"] },
      {
        id: "rule-3",
        granularity: "range",
        target: "0x4E00-0x4E0F",
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
  });

  /* --------------------------------------------------------------- */
  /* Ticket #35: the coloring IS the API — memoized, locally paged.    */
  /* --------------------------------------------------------------- */

  test("the grid colors through the resolve API: one request per change, paging local", async ({
    page,
  }) => {
    // Count POST /precedence-resolve requests from the page itself.
    let resolves = 0;
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url().endsWith("/precedence-resolve")
      ) {
        resolves++;
      }
    });
    const fonts = makeLocalFixtures();
    collectJsErrors(page, jsErrors);
    await page.addInitScript((url: string) => {
      const config = window as unknown as {
        __FONTALLOY_CONFIG__: Record<string, unknown>;
      };
      config.__FONTALLOY_CONFIG__ ??= {};
      config.__FONTALLOY_CONFIG__.serveUrl = url;
    }, service!.url);
    await page.goto("/");
    await waitForFontsReady(page);
    expect(resolves).toBe(0); // no picks yet: nothing to resolve

    // Each pick change resolves exactly once. The base-only wait is
    // safe (nothing colored before it); the PAIR's wait must anchor on
    // a cell only the pair's document colors — the donor-only CJK run —
    // because A–Z read identically under both documents.
    await loadIntoPicker(page, "en", fonts.base);
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+0041']"),
    ).toHaveAttribute("data-winner", "base");
    expect(resolves).toBe(1);
    await loadIntoPicker(page, "cjk", fonts.donor);
    await gotoCjkPage(page);
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+4E00']"),
    ).toHaveAttribute("data-winner", "donor-0");
    expect(resolves).toBe(2);
    await pointerClick(page, page.locator(".kit-cat-g[data-group='all']"));

    // A rules change resolves exactly once more...
    await addRangeRule(page, "0x0041", "0x005A", "donor");
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+0041']"),
    ).toHaveAttribute("data-winner", "donor-0");
    expect(resolves).toBe(3);

    // ...and paging the grid, switching categories, and scrolling pages
    // of cells resolve NOTHING more — the runs answer locally.
    await pointerClick(page, page.locator("[data-pager-arrow='next']").first());
    await gotoCjkPage(page);
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+4E00']"),
    ).toHaveAttribute("data-winner", "donor-0");
    await pointerClick(page, page.locator("[data-pager-arrow='next']").first());
    expect(resolves).toBe(3);

    // An unrelated state change (a category switch back) stays at 3.
    await pointerClick(page, page.locator(".kit-cat-g[data-group='all']"));
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+0041']"),
    ).toHaveAttribute("data-winner", "donor-0");
    expect(resolves).toBe(3);
  });

  /* --------------------------------------------------------------- */
  /* Absence never overrides.                                          */
  /* --------------------------------------------------------------- */

  test("a donor gap leaves the base rendering (absence never overrides)", async ({
    page,
  }) => {
    const fonts = await makeLocalFixtures();
    await openWithFonts(page, fonts);

    // Rule "0x0041-0x005A -> [donor-0, base]" (round 6 preference list):
    // override intent over all ASCII.
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

    // Z: the donor LACKS it — absence never overrides, the base renders
    // (through the rule's own fill: the preference list names the base
    // second, so the rule still supplies and via credits it).
    await expect(page.locator(".charmap-grid .kit-cell[data-cp='U+005A']")).toHaveAttribute(
      "data-winner",
      "base",
    );
    await expect(page.locator(".charmap-grid .kit-cell[data-cp='U+005A']")).toHaveAttribute(
      "data-via",
      /rule-\d+/,
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
    // 用英文字体 could never take effect (the base font lacks the
    // codepoint; absence never overrides) — round 8 (owner item 1):
    // the button renders DISABLED with the plain-words reason visible
    // the moment the popup opens, and clicking it does nothing.
    await expect(popup.locator("[data-role='char-donor']")).toBeHidden();
    const baseBtn = popup.locator("[data-role='char-base']");
    await expect(baseBtn).toBeVisible();
    await expect(baseBtn).toBeDisabled();
    // Round 11 (owner item 8): the reason is VISIBLE copy, not DOM-only
    // text (toBeVisible proves a nonzero painted box, not just textContent).
    const baseReason = popup.locator("[data-role='char-base-reason']");
    await expect(baseReason).toBeVisible();
    await expect(baseReason).toHaveText("英文字体不含此码位");
    await pointerClick(page, baseBtn);
    const cell = page.locator(".charmap-grid .kit-cell[data-cp='U+4E2D']");
    await expect(cell).toHaveAttribute("data-winner", "donor-0");
    await expect(cell).toHaveAttribute("data-via", "rule-0");
    await expect(page.locator("[data-role='rule-solo']")).toHaveCount(0);

    // Live update, no reload: same pager state, sibling cell untouched
    // (丮 U+4E2E is a rare han OUTSIDE the seeded zh_cn scope — it keeps
    // the default precedence, no rule supplying it).
    await expect(page.locator(".kit-toolrow [data-pager-label]")).toHaveText(
      "第 1/21 页",
    );
    await expect(
      page.locator(".charmap-grid .kit-cell[data-cp='U+4E2E']"),
    ).toHaveAttribute("data-via", "default");

    // No override was written (the disabled button did nothing), so
    // the dashed single-character summary stays absent and the popup
    // offers no 恢复默认 (nothing to restore).
    await expect(page.locator("[data-role='rule-solo']")).toHaveCount(0);
    await pointerClick(page, cell);
    await expect(popup.locator("[data-role='char-reset']")).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(popup).toBeHidden();
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

    // A custom range reads the round-8 VERBATIM sentence (U+… glyph -
    // U+… glyph, then the side).
    await addRangeRule(page, "0x4E10", "0x4E13", "donor");
    const rangeRow = page.locator("[data-role='rule-row'][data-kind='range']");
    await expect(rangeRow).toContainText("U+4E10 丐 - U+4E13 专 用中文字体");

    // A single-codepoint rule collapses into the dashed summary row
    // (round 8: spaced count; the base holds only ASCII, so the
    // override happens on a both-covered cell in the latin view).
    await pointerClick(
      page,
      page.locator(".kit-cat-g[data-group='latin-europe']"),
    );
    await pointerClick(
      page,
      page.locator(".kit-cat-s[data-block='basic-latin']"),
    );
    await setCodepointSide(page, "U+0043", "base");
    await expect(page.locator("[data-role='rule-solo']")).toHaveText(/单个字符 1/);

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
