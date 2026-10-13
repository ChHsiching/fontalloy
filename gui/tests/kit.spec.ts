import { test, expect } from "@playwright/test";
import {
  assertNoJsErrors,
  collectJsErrors,
  pointerClick,
  waitForFontsReady,
} from "./helpers";

/**
 * Kit-level specs (design-fidelity repair, Stage 1): the component
 * library exercised through its demo page (gui/kit-demo.html). Suite
 * conventions throughout: real pointer events with elementFromPoint
 * hit-test guards, DOM textContent / computed-style / geometry
 * assertions (never pixel reads), and the zero-JS-errors gate.
 */

test.describe("kit demo page", () => {
  const jsErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    jsErrors.length = 0;
    collectJsErrors(page, jsErrors);
    await page.goto("/kit-demo.html");
    await waitForFontsReady(page);
    // Let the staggered entrance animations settle.
    await page.waitForTimeout(600);
  });

  test.afterEach(() => assertNoJsErrors(jsErrors));

  /* ---------- top bar parts ---------- */

  test("top bar carries brand, GitHub link, font name, and synthesize action", async ({
    page,
  }) => {
    await expect(page.locator(".kit-topbar .kit-brand")).toHaveText(
      "FontAlloy",
    );
    const link = page.locator('[data-role="font-pair"] ~ a, .kit-topbar a');
    await expect(link).toHaveAttribute(
      "href",
      "https://github.com/ChHsiching/fontalloy",
    );
    await expect(page.locator(".kit-topbar a")).toContainText(
      "ChHsiching/fontalloy",
    );
    const nameInput = page.locator('[data-role="font-name"]');
    await expect(nameInput).toHaveValue("ChHsich");
    await expect(nameInput).toHaveAttribute(
      "title",
      "字体名只能用英文字母、数字和连字符",
    );
    await expect(page.locator('[data-role="synthesize"]')).toHaveText(
      "合成字体",
    );
    const pair = page.locator('[data-role="font-pair"] .kit-tag');
    // Round 9 (owner item 2): the demo rows carry the name-table strings
    // the real app reads ("JetBrainsMono Nerd Font", "Maple Mono NF").
    await expect(pair.nth(0)).toHaveText("JetBrainsMono Nerd Font");
  });

  test("theme toggle: 3-state cycle with the effective icon and persistence", async ({
    page,
  }) => {
    const frame = page.locator(".kit-app");
    const accentOf = () =>
      frame.evaluate((el) => getComputedStyle(el).getPropertyValue("--ac").trim());
    const toggle = page.locator('[data-role="theme-toggle"]');
    // The test browser's system preference is light, so a fresh page
    // boots 自动 (effective light: sun icon + 自动 badge) — round 5.
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(toggle).toHaveAttribute("data-theme-mode", "auto");
    await expect(toggle.locator(".kit-theme-auto")).toHaveText("自动");
    expect(await accentOf()).toBe("#0f766e");

    // Step 1: 浅色 — same effective theme, badge gone.
    await pointerClick(page, toggle);
    await expect(toggle).toHaveAttribute("data-theme-mode", "light");
    await expect(toggle.locator(".kit-theme-auto")).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    // Step 2: 深色 — moon icon, dark palette.
    await pointerClick(page, toggle);
    await expect(toggle).toHaveAttribute("data-theme-mode", "dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await accentOf()).toBe("#4ade9e");
    // The crescent carries no circle (the sun does) — icon vocabulary.
    expect(
      await toggle.evaluate((el) => el.querySelector("svg circle") !== null),
    ).toBe(false);

    // Step 3: back to 自动 — badge returns, the system (light) wins.
    await pointerClick(page, toggle);
    await expect(toggle).toHaveAttribute("data-theme-mode", "auto");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(toggle.locator(".kit-theme-auto")).toHaveText("自动");
    expect(
      await toggle.evaluate((el) => el.querySelector("svg circle") !== null),
    ).toBe(true);

    // The transition-killer class is transient (two frames), never stuck.
    await page.waitForTimeout(120);
    expect(
      await page.evaluate(() => document.documentElement.classList.contains("theming")),
    ).toBe(false);

    // The choice persists: a reload of the same context boots dark.
    await pointerClick(page, toggle); // 自动 → 浅色
    await pointerClick(page, toggle); // 浅色 → 深色
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.reload();
    await page.locator('[data-role="theme-toggle"]').waitFor();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(
      page.locator('[data-role="theme-toggle"]'),
    ).toHaveAttribute("data-theme-mode", "dark");
  });

  /* ---------- AppSelect ---------- */

  test("AppSelect opens with a discrete transition, glow, and closes on Escape/outside", async ({
    page,
  }) => {
    const select = page.locator('[data-role="select-weight"]');
    await pointerClick(page, select.locator(".kit-csel"));
    const popup = select.locator(".kit-csel-pk");
    await expect(popup).toBeVisible();

    // Open state: the glow (accent border + soft ring).
    expect(await select.evaluate((el) => el.classList.contains("open"))).toBe(
      true,
    );
    const glow = await select
      .locator(".kit-csel")
      .evaluate((el) => getComputedStyle(el).boxShadow);
    expect(glow).not.toBe("none");

    // The popup's display flips through allow-discrete.
    const behavior = await popup.evaluate(
      (el) => getComputedStyle(el).transitionBehavior,
    );
    expect(behavior).toContain("allow-discrete");

    // Ratified option labels, Chinese verbatim. The 推荐 mark is a
    // badge element now (icon-purge round) — its text rides after the
    // label, one normalized space between.
    await expect(popup.locator(".kit-cso")).toHaveCount(3);
    await expect(popup.locator(".kit-cso").first()).toHaveText(
      "双方字重全部保留 推荐",
    );
    await expect(popup.locator(".kit-cso .kit-badge")).toHaveText("推荐");

    // Escape closes.
    await page.keyboard.press("Escape");
    await expect(popup).toBeHidden();

    // Reopen, then an outside click closes.
    await pointerClick(page, select.locator(".kit-csel"));
    await expect(popup).toBeVisible();
    await pointerClick(page, page.locator(".kit-catbar"));
    await expect(popup).toBeHidden();
  });

  test("AppSelect keyboard: arrows open, move, and commit", async ({ page }) => {
    const select = page.locator('[data-role="select-baseline"] .kit-csel');
    await select.focus();
    await page.keyboard.press("ArrowDown");
    const popup = page.locator('[data-role="select-baseline"] .kit-csel-pk');
    await expect(popup).toBeVisible();
    await page.keyboard.press("ArrowDown");
    // The trigger carries label (+ badge) spans — assert on the whole
    // button text (whitespace-normalized), not a lone span.
    await expect(select).toHaveText("中文字和英文底边一样高");
    await page.keyboard.press("ArrowUp");
    await expect(select).toHaveText("自动 推荐");
  });

  test("opening one AppSelect closes the other", async ({ page }) => {
    const a = page.locator('[data-role="select-weight"]');
    const b = page.locator('[data-role="select-baseline"]');
    await pointerClick(page, a.locator(".kit-csel"));
    await expect(a.locator(".kit-csel-pk")).toBeVisible();

    // The open palette overlays the lower rows (prototype parity), so
    // the second select opens through the keyboard path — opening it
    // must close the first.
    await b.locator(".kit-csel").focus();
    await page.keyboard.press("ArrowDown");
    await expect(b.locator(".kit-csel-pk")).toBeVisible();
    await expect(a.locator(".kit-csel-pk")).toBeHidden();
  });

  /* ---------- HelpPopover ---------- */

  test("help popover: circular button, verbatim chrome, prototype content", async ({
    page,
  }) => {
    const button = page.locator('[data-role="help-weight"]');
    const radius = await button.evaluate(
      (el) => getComputedStyle(el).borderRadius,
    );
    expect(radius).toBe("50%");

    await pointerClick(page, button);
    const pop = page.locator('[data-help-popup="weight"]');
    await expect(pop).toBeVisible();
    await expect(pop.locator("h5")).toHaveText("什么是字重");

    // Two worked-example tables with the prototype's chrome class.
    const tables = pop.locator(".kit-wtab");
    await expect(tables).toHaveCount(2);
    const th = tables.first().locator("th");
    await expect(th.nth(0)).toHaveText("选项");
    await expect(th.nth(1)).toHaveText("成品字重");

    // Round 5, owner item 11: the prototype's VERBATIM rows — including
    // the 中等 output row the earlier ADR-0006 correction dropped.
    await expect(tables.first()).toContainText("细、常规、中等、粗体");
    await expect(tables.first()).toContainText("常规、中等");
    const rows = tables.nth(1).locator("tbody tr");
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(2).locator("td").first()).toHaveText("中等");
    await expect(rows.nth(3).locator("td").first()).toHaveText("粗体");
    // No engineering notes in user-facing popovers.
    await expect(pop).not.toContainText("ADR");

    // The popover clamps inside the app frame.
    const frameBox = await page.locator(".kit-app").boundingBox();
    const popBox = await pop.boundingBox();
    expect(frameBox).not.toBeNull();
    expect(popBox).not.toBeNull();
    expect(popBox!.y).toBeGreaterThanOrEqual(frameBox!.y - 1);
    expect(popBox!.y + popBox!.height).toBeLessThanOrEqual(
      frameBox!.y + frameBox!.height + 1,
    );

    // Containment at the clamped height: the card scrolls internally
    // (the prototype's #wtpop discipline) — its closing paragraphs never
    // paint past the rounded bottom edge onto the rail.
    expect(
      await pop.evaluate((el) => getComputedStyle(el).overflowY),
    ).toBe("auto");

    await page.keyboard.press("Escape");
    await expect(pop).toBeHidden();
  });

  // Round 6, owner item 1 — the ? hover is a PURE CENTERED scale: no
  // translate component, transform-origin pinned to center, so the
  // glyph can never appear to dip toward its label.
  test("help button hover: color change plus a pure centered scale only", async ({
    page,
  }) => {
    const button = page.locator('[data-role="help-weight"]');
    // The resting box (before the hover scale inflates it).
    const restBox = await button.boundingBox();
    await button.hover();
    const midTransform = await button.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { matrix: new DOMMatrixReadOnly(cs.transform), origin: cs.transformOrigin };
    });
    // After the 120 ms transition settles: scale(1.1), zero translate.
    await page.waitForTimeout(300);
    const settled = await button.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { matrix: new DOMMatrixReadOnly(cs.transform), origin: cs.transformOrigin };
    });
    const m = settled.matrix;
    expect(m.m11).toBeCloseTo(1.1, 2);
    expect(m.m22).toBeCloseTo(1.1, 2);
    expect(Math.abs(m.m41)).toBeLessThanOrEqual(0.01); // no X shift
    expect(Math.abs(m.m42)).toBeLessThanOrEqual(0.01); // no Y shift
    // transform-origin center: the computed form resolves to half the
    // resting box on both axes (percentages become pixels).
    const [ox, oy] = settled.origin.split(" ").map((v) => Number.parseFloat(v));
    expect(Math.abs(ox - restBox!.width / 2)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(oy - restBox!.height / 2)).toBeLessThanOrEqual(0.5);
    // The mid-transition sample was already pure too (no choreography).
    expect(Math.abs(midTransform.matrix.m41)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(midTransform.matrix.m42)).toBeLessThanOrEqual(0.01);
  });

  /* ---------- PickerPopup ---------- */

  test("picker opens as the anchor-fused list card (AppSelect form)", async ({
    page,
  }) => {
    const card = page.locator('[data-role="picker-en"]');
    await pointerClick(page, card.locator(".kit-hd"));
    await page.waitForTimeout(250); // the discrete open transition settles
    const popup = page.locator('[data-picker-popup="en"]');
    await expect(popup).toBeVisible();
    await expect(card).toHaveClass(/open/);

    // Round 4: the popup is a PERSISTENT CHILD of the card, absolutely
    // anchored at its bottom edge — no portal, no frame math.
    const anchorInfo = await popup.evaluate((el) => {
      const cardEl = el.closest(".kit-fsel")!;
      const cs = getComputedStyle(el);
      return {
        childOfCard: el.parentElement === cardEl,
        position: cs.position,
        display: cs.display,
      };
    });
    expect(anchorInfo.childOfCard).toBe(true);
    expect(anchorInfo.position).toBe("absolute");
    expect(anchorInfo.display).toBe("flex");
    // Fused: overlaps the card's bottom border by 1px, same width (+2).
    const cardBox = (await card.boundingBox())!;
    const popupBox = (await popup.boundingBox())!;
    expect(Math.abs(popupBox.y - (cardBox.y + cardBox.height - 1))).toBeLessThanOrEqual(1.5);
    expect(Math.abs(popupBox.width - (cardBox.width + 2))).toBeLessThanOrEqual(2);
    expect(Math.abs(popupBox.x - (cardBox.x - 1))).toBeLessThanOrEqual(1.5);

    // Chevron rotates 90deg when open.
    const chevron = await card
      .locator(".kit-hd > svg")
      .evaluate((el) => getComputedStyle(el).transform);
    expect(chevron).not.toBe("none");
  });

  for (const height of [700, 520]) {
    test(`picker stays anchored to its card at ${height}px height`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 900, height });
      const card = page.locator('[data-role="picker-cjk"]');
      await card.scrollIntoViewIfNeeded();
      await pointerClick(page, card.locator(".kit-hd"));
      await page.waitForTimeout(250); // the discrete open transition settles
      const popup = page.locator('[data-picker-popup="cjk"]');
      await expect(popup).toBeVisible();
      // Anchored below the card regardless of the frame: the rail's
      // scroll box clips what does not fit (the prototype's own
      // behavior — its .pk is an absolute child of .fsel too).
      const cardBox = (await card.boundingBox())!;
      const popupBox = (await popup.boundingBox())!;
      expect(Math.abs(popupBox.y - (cardBox.y + cardBox.height - 1))).toBeLessThanOrEqual(1.5);
    });
  }

  test("picker rows self-render with the no-pills meta line and a check on the selected row", async ({
    page,
  }) => {
    await pointerClick(page, page.locator('[data-role="picker-cjk"] .kit-hd'));
    const popup = page.locator('[data-picker-popup="cjk"]');
    const rows = popup.locator(".kit-fp");
    await expect(rows).toHaveCount(3);

    const maple = rows.filter({ hasText: "Maple Mono" });
    // Meta line: formatted stars, stripped license, trait — plain text.
    await expect(maple.locator(".kit-meta")).toHaveText("29.2kOFL圆角等宽");
    await expect(maple.locator(".kit-gh")).toContainText("29.2k");
    await expect(maple.locator(".kit-gh svg")).toBeVisible();
    // Selected row: accent tint + check mark + aria-pressed.
    await expect(maple).toHaveAttribute("aria-pressed", "true");
    await expect(maple.locator(".kit-chk")).toBeVisible();
    const unselected = rows.filter({ hasText: "Noto Sans SC" });
    await expect(unselected).toHaveAttribute("aria-pressed", "false");
  });

  test("picker search filters rows; the popup node survives the re-render", async ({
    page,
  }) => {
    await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
    const popup = page.locator('[data-picker-popup="en"]');
    await expect(popup).toBeVisible();
    await popup.evaluate((el) => (el.dataset.marker = "alive"));

    const search = popup.locator(".kit-q");
    await search.fill("jet");
    // Debounced render (120ms) rebuilds rows only.
    await page.waitForTimeout(320);
    const rows = popup.locator(".kit-fp");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("JetBrainsMono Nerd Font");

    // Same node, still open — the exit/open transitions stay wired.
    expect(await popup.getAttribute("data-marker")).toBe("alive");
    await expect(popup).toBeVisible();
    const behavior = await popup.evaluate(
      (el) => getComputedStyle(el).transitionBehavior,
    );
    expect(behavior).toContain("allow-discrete");
  });

  test("picking a row closes the popup and updates the card header", async ({
    page,
  }) => {
    const card = page.locator('[data-role="picker-en"]');
    await pointerClick(page, card.locator(".kit-hd"));
    const popup = page.locator('[data-picker-popup="en"]');
    await pointerClick(page, popup.locator(".kit-fp", { hasText: "Iosevka" }));
    await expect(popup).toBeHidden();
    await expect(card.locator(".kit-hd b")).toHaveText("Iosevka Nerd Font");
    // The top bar pair tag follows.
    await expect(page.locator('[data-role="font-pair"] .kit-tag').first()).toHaveText(
      "Iosevka Nerd Font",
    );
  });

  test("closed picker keeps its popup node mounted (AppSelect persistence)", async ({
    page,
  }) => {
    await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
    const popup = page.locator('[data-picker-popup="en"]');
    await expect(popup).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popup).toBeHidden();
    // Round 4: the popup is a persistent child of the card — closing is
    // display:none through the card class (so the exit transition's
    // node survives), exactly like AppSelect's list. No deferred
    // removal anymore.
    await expect(popup).toHaveCount(1);
    const closed = await popup.evaluate((el) => ({
      display: getComputedStyle(el).display,
      pointer: getComputedStyle(el).pointerEvents,
      cardOpen: el.closest(".kit-fsel")!.classList.contains("open"),
    }));
    expect(closed.display).toBe("none");
    expect(closed.pointer).toBe("none");
    expect(closed.cardOpen).toBe(false);
    // And it reopens through the same node.
    await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
    await expect(popup).toBeVisible();
  });

  test("the picker footer sits outside the scroll area", async ({ page }) => {
    await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
    const popup = page.locator('[data-picker-popup="en"]');
    const scroll = popup.locator(".kit-pks");
    const footer = popup.locator(".kit-fpsys");
    await expect(scroll).toBeVisible();
    await expect(footer).toBeVisible();
    expect(
      await footer.evaluate(
        (el, scrollEl) => !scrollEl.contains(el),
        await scroll.elementHandle(),
      ),
    ).toBe(true);
    const scrollBox = (await scroll.boundingBox())!;
    const footerBox = (await footer.boundingBox())!;
    expect(footerBox.y).toBeGreaterThanOrEqual(scrollBox.y + scrollBox.height - 1);
  });

  /* ---------- CategoryChips ---------- */

  test("category chips render two levels with counts and switch views", async ({
    page,
  }) => {
    const bar = page.locator(".kit-catbar");
    const groups = bar.locator(".kit-cat-g");
    expect(await groups.count()).toBeGreaterThanOrEqual(6);
    await expect(groups.first()).toContainText("全部");
    const cjk = groups.filter({ hasText: "中文" });
    await expect(cjk).toHaveClass(/on/);
    // 缺失 group in danger styling.
    await expect(groups.filter({ hasText: "缺失" })).toHaveClass(/miss/);

    // Second level under 中文: the 全部 aggregate + blocks with counts.
    const subs = bar.locator(".kit-cat-s");
    expect(await subs.count()).toBeGreaterThanOrEqual(4);
    await expect(subs.first()).toContainText("全部");
    await expect(subs.filter({ hasText: "汉字区" })).toContainText("6,765");

    // Switching group re-renders the block row.
    await pointerClick(page, groups.filter({ hasText: "字母" }));
    await expect(bar.locator(".kit-cat-s").filter({ hasText: "大写" })).toBeVisible();
    await expect(bar.locator(".kit-cat-s").filter({ hasText: "汉字区" })).toHaveCount(0);
  });

  /* ---------- ActionBar ---------- */

  test("action bar exposes group and block segments with verbatim labels", async ({
    page,
  }) => {
    const row = page.locator(".kit-toolrow");
    await expect(row).toContainText("所有中文字符");
    // Round 4: the segments carry SHORT labels; the full sentences ride
    // in title (asserted here so nothing is lost).
    await expect(row).toContainText("全用英文");
    await expect(row).toContainText("全用中文");
    const segs = row.locator(".kit-assign button");
    await expect(segs.filter({ hasText: /^全用英文$/ })).toHaveAttribute(
      "title",
      "全部用英文字体",
    );
    await expect(row).toContainText("汉字区");
    await expect(row).toContainText("用英文");
    await expect(row.locator('[data-role="toggle-multi"]')).toHaveText("多选");
    await expect(row.locator('[data-role="toggle-codepoints"]')).toHaveText("编码");
    await expect(row.locator('[data-role="undo"]')).toBeEnabled();
    await expect(row).toContainText("已调整");
    await expect(row.locator(".kit-legend .dot")).toBeVisible();
    await expect(row.locator('[data-role="range-specify"]')).toHaveText(
      "按编码指定",
    );

    // Pager for the 汉字区 (6,765 chars → 7 pages).
    await expect(row.locator(".kit-pgc")).toContainText("第 1/7 页");
    await expect(row.locator('.kit-pgc button[aria-label="上一页"]')).toBeDisabled();
    await pointerClick(page, row.locator('.kit-pgc button[aria-label="下一页"]'));
    await expect(row.locator(".kit-pgc")).toContainText("第 2/7 页");
  });

  test("multi-select batch mode swaps the bar for the batch controls", async ({
    page,
  }) => {
    const row = page.locator(".kit-toolrow");
    await pointerClick(page, row.locator('[data-role="toggle-multi"]'));
    const cell = page.locator(".kit-cell").first();
    await pointerClick(page, cell);
    await expect(row.locator('[data-role="batch-count"]')).toHaveText(
      "已选 1 个",
    );
    // Icon-purge round: the two hint clauses are joined by a divider
    // element — the parts assert separately.
    await expect(row).toContainText("按住拖动连选");
    await expect(row).toContainText("Shift+点击 范围选择");
    await expect(row.locator(".kit-sep")).toHaveCount(1);
    await expect(page.locator(".kit-cell.sel")).toHaveCount(1);
  });

  /* ---------- grid ---------- */

  test("grid renders a uniform 1024-cell page with state classes", async ({
    page,
  }) => {
    await expect(page.locator(".kit-cell")).toHaveCount(1024);
    // Adjusted cell carries the corner-dot class.
    await expect(page.locator(".kit-cell.ov").first()).toBeVisible();
    // 编码 mode shows tabular-nums codepoints on every cell.
    await pointerClick(
      page,
      page.locator('.kit-toolrow [data-role="toggle-codepoints"]'),
    );
    await expect(page.locator(".kit-cell.hascp")).toHaveCount(1024);
    const cp = page.locator(".kit-cell .cp").first();
    await expect(cp).toHaveText(/^([0-9A-F]{4,6})$/);
  });

  test("missing view shows dashed danger cells", async ({ page }) => {
    await pointerClick(
      page,
      page.locator(".kit-cat-g", { hasText: "缺失" }),
    );
    const cells = page.locator(".kit-cell");
    await expect(cells).toHaveCount(2);
    await expect(cells.first()).toHaveClass(/miss/);
    await expect(page.locator(".kit-toolrow")).toContainText(
      "缺失字符无法指定来源",
    );
  });

  /* ---------- StatusBar ---------- */

  test("status bar renders color-coded counters with tabular numerals", async ({
    page,
  }) => {
    const stat = page.locator(".kit-stat");
    const read = async (key: string): Promise<number> => {
      const text = await stat.locator(`[data-stat="${key}"]`).textContent();
      return Number(text!.replace(/,/g, ""));
    };
    const total = await read("total");
    const en = await read("en");
    const cjk = await read("cjk");
    const missing = await read("missing");
    expect(total).toBe(en + cjk + missing);
    // The full demo charset (hanzi pool + latin/digit/icon blocks).
    expect(total).toBeGreaterThan(7000);
    expect(missing).toBe(2);
    // Coverage percentage matches its inputs.
    const cov = await stat.locator('[data-stat="coverage"]').textContent();
    expect(cov).toBe(((100 * (total - missing)) / total).toFixed(2));
    await expect(stat).toContainText("覆盖");
    // The accent / danger dots exist next to their counters.
    expect(await stat.locator("i").count()).toBe(3);
  });

  /* ---------- SceneCard + scene themes ---------- */

  test("scene mode stacks three cards; terminal themes lock data-t", async ({
    page,
  }) => {
    await pointerClick(
      page,
      page.locator('[data-role="mode-seg"] button', { hasText: "实际场景" }),
    );
    const cards = page.locator(".kit-sc");
    await expect(cards).toHaveCount(3);
    await expect(cards.nth(0).locator(".kit-cap")).toHaveText("终端");
    await expect(cards.nth(1).locator(".kit-cap")).toHaveText("代码编辑器");
    await expect(cards.nth(2).locator(".kit-cap")).toHaveText("文档");

    // 14 terminal theme options (跟随主题 + 13 named).
    const termSelect = cards.nth(0).locator(".kit-cselw");
    await pointerClick(page, termSelect.locator(".kit-csel"));
    const options = termSelect.locator(".kit-cso");
    await expect(options).toHaveCount(14);
    await expect(options.first()).toHaveText("跟随主题");

    // Picking Dracula locks the palette on the terminal element.
    await pointerClick(page, options.filter({ hasText: "Dracula" }));
    const term = cards.nth(0).locator(".kit-term");
    await expect(term).toHaveAttribute("data-t", "dracula");
    expect(
      await term.evaluate((el) => getComputedStyle(el).backgroundColor),
    ).toBe("rgb(40, 42, 54)");

    // The document card has no theme select.
    await expect(cards.nth(2).locator(".kit-cselw")).toHaveCount(0);
  });

  test("editor card offers 10 themes and locks data-ct", async ({ page }) => {
    await pointerClick(
      page,
      page.locator('[data-role="mode-seg"] button', { hasText: "实际场景" }),
    );
    const codeCard = page.locator(".kit-sc").nth(1);
    await pointerClick(page, codeCard.locator(".kit-csel"));
    const options = codeCard.locator(".kit-cso");
    await expect(options).toHaveCount(10);
    await expect(options.first()).toHaveText("跟随主题");
    await pointerClick(page, options.filter({ hasText: "Monokai" }));
    const code = codeCard.locator(".kit-code");
    await expect(code).toHaveAttribute("data-ct", "monokai");
    expect(
      await code.locator(".k").first().evaluate((el) => getComputedStyle(el).color),
    ).toBe("rgb(249, 38, 114)");
  });

  test("fullscreen expand opens the zoom view and Escape closes it", async ({
    page,
  }) => {
    await pointerClick(
      page,
      page.locator('[data-role="mode-seg"] button', { hasText: "实际场景" }),
    );
    const expand = page.locator(".kit-sc").nth(0).locator(".kit-zb");
    await expect(expand).toHaveAttribute("aria-label", "全屏查看");
    await pointerClick(page, expand);
    const zf = page.locator(".kit-zf");
    await expect(zf).toBeVisible();
    await expect(zf.locator(".kit-zf-b .t")).toHaveText("终端");
    // Full variant adds the extra help section lines.
    await expect(zf.locator(".kit-term")).toContainText("fontalloy --help");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(260);
    await expect(zf).toHaveCount(0);
  });

  test("custom preview text re-renders the document scene without replaying entrance", async ({
    page,
  }) => {
    await pointerClick(
      page,
      page.locator('[data-role="mode-seg"] button', { hasText: "实际场景" }),
    );
    const input = page.locator('[data-role="preview-text"]');
    await input.fill("你好世界 fontalloy");
    const doc = page.locator(".kit-sc").nth(2).locator(".kit-doc");
    await expect(doc).toContainText("你好世界 fontalloy");
    // Entrance replay gated: the wrap carries no-in after the first render.
    expect(
      await page.locator(".kit-scene-wrap").evaluate((el) =>
        el.classList.contains("no-in"),
      ),
    ).toBe(true);
  });

  /* ---------- LangChips (the 文字范围 row) ---------- */

  test("language chips toggle with counts; the last one is guarded", async ({
    page,
  }) => {
    const row = page.locator('[data-role="lang-chips"]');
    const chips = row.locator('[data-role="lang-chip"]');
    await expect(chips).toHaveCount(4);
    await expect(chips.first()).toHaveText("简体中文6,765");
    await expect(chips.nth(1)).toHaveText("繁体中文13,063");
    // zh_cn pressed by default, the others not.
    await expect(chips.first()).toHaveAttribute("aria-pressed", "true");
    await expect(chips.nth(1)).toHaveAttribute("aria-pressed", "false");

    // Toggling an off chip declares it; toggling again removes it.
    await pointerClick(page, chips.nth(1));
    await expect(chips.nth(1)).toHaveAttribute("aria-pressed", "true");
    await pointerClick(page, chips.nth(1));
    await expect(chips.nth(1)).toHaveAttribute("aria-pressed", "false");

    // The last remaining language cannot be removed (至少保留一种).
    await pointerClick(page, chips.first());
    await expect(chips.first()).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".kit-sr")).toHaveText("至少保留一种");
  });

  /* ---------- rule summary rows ---------- */

  test("rule rows carry icons, sentences, and the dim U+ suffix", async ({
    page,
  }) => {
    const rules = page.locator(".kit-rules");
    const rows = rules.locator('[data-role="rule-row"]');
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toHaveAttribute("data-kind", "group");
    await expect(rows.first()).toContainText("所有中文字符用中文字体");
    await expect(rows.first().locator(".kit-rl-ic svg")).toBeVisible();
    // Round 8: the range row reads the VERBATIM sentence.
    const rangeRow = rows.filter({ hasText: "U+4E00 一 - U+9F99 龙 用中文字体" });
    await expect(rangeRow).toHaveCount(1);
    // The dashed single-character aggregate with its count (spaced).
    const solo = rules.locator('[data-role="rule-solo"]');
    await expect(solo).toHaveClass(/dashed/);
    await expect(solo).toHaveText("单个字符 2");
    await expect(solo).toHaveAttribute("aria-expanded", "false");

    // Round 8 (owner item 3): the aggregate EXPANDS into its
    // per-character rows, each removable on its own.
    await pointerClick(page, solo);
    await expect(solo).toHaveAttribute("aria-expanded", "true");
    const soloRows = rules.locator('[data-role="rule-row"][data-kind="codepoint"]');
    await expect(soloRows).toHaveCount(2);
    await expect(soloRows.first()).toContainText("U+4E2D 中 用中文字体");
    await expect(soloRows.nth(1)).toContainText("U+6C38 永 用英文字体");
    await pointerClick(page, soloRows.first().locator('[data-role="remove-rule"]'));
    await expect(soloRows).toHaveCount(1);
    await expect(solo).toHaveText("单个字符 1");
    await pointerClick(page, solo); // collapse again
    await expect(solo).toHaveAttribute("aria-expanded", "false");

    // Removing every row keeps the solo aggregate; 全部恢复默认 then
    // clears everything and the prototype's empty state reads verbatim.
    for (let i = 0; i < 3; i++) {
      await pointerClick(page, rows.first().locator('[data-role="remove-rule"]'));
    }
    await expect(rules.locator('[data-role="rule-row"]')).toHaveCount(0);
    await expect(solo).toBeVisible();
    await pointerClick(page, rules.locator('[data-role="undo-all"]'));
    await expect(solo).toHaveCount(0);
    await expect(rules.locator(".kit-rl-empty")).toHaveText("暂无自定义规则。");
  });

  /* ---------- CharPopup + RangePopup ---------- */

  test("a plain cell click opens the char popup at the cell with the facts", async ({
    page,
  }) => {
    const cell = page.locator(".kit-cell").first();
    await pointerClick(page, cell);
    const popup = page.locator("[data-char-popup]");
    await expect(popup).toBeVisible();
    await expect(popup.locator('[data-role="char-glyph"]')).toBeVisible();
    await expect(popup.locator('[data-role="char-code"]')).toHaveText(
      /^U\+[0-9A-F]{4,6}$/,
    );
    await expect(popup.locator('[data-role="char-from"]')).toContainText(
      "来自 Maple Mono",
    );
    // Anchored at the cell (below or flipped above, within its width).
    const cellBox = (await cell.boundingBox())!;
    const popBox = (await popup.boundingBox())!;
    expect(Math.abs(popBox.x - cellBox.x)).toBeLessThan(60);

    // The winner side's button is hidden; the other applies and closes.
    await expect(popup.locator('[data-role="char-donor"]')).toBeHidden();
    await expect(popup.locator('[data-role="char-base"]')).toBeVisible();
    await pointerClick(page, popup.locator('[data-role="char-base"]'));
    await expect(popup).toBeHidden();
    await expect(page.locator(".kit-sr")).toContainText("已指定为英文字体");
  });

  test("the range popup keeps the prototype contract; invalid input paints danger", async ({
    page,
  }) => {
    await pointerClick(
      page,
      page.locator(".kit-toolrow [data-role='range-specify']"),
    );
    const popup = page.locator("[data-range-popup]");
    await expect(popup).toBeVisible();
    await expect(popup.locator("h5")).toHaveText("按编码指定");
    await expect(popup).toContainText("输入编码或范围，窄范围优先于整类。");
    await expect(popup.locator("[data-role='range-start']")).toHaveAttribute(
      "placeholder",
      "U+0030 或 0",
    );
    await expect(popup.locator("[data-role='range-end']")).toHaveAttribute(
      "placeholder",
      "留空=单个",
    );
    await expect(popup.locator("[data-role='range-side']")).toContainText(
      "用英文字体",
    );

    // Invalid input: the danger border and the popup stays open. The
    // border resolves to the palette's danger value (light/dark).
    await popup.locator("[data-role='range-start']").fill("not-a-code");
    await pointerClick(page, popup.locator("[data-role='range-add']"));
    await expect(popup).toBeVisible();
    expect(
      await popup
        .locator("[data-role='range-start']")
        .evaluate((el) => getComputedStyle(el).borderColor),
    ).toMatch(/rgb\(197, 48, 48\)|rgb\(248, 113, 113\)/);

    // A valid single codepoint (end left empty) applies and closes.
    await popup.locator("[data-role='range-start']").fill("U+0041");
    await pointerClick(page, popup.locator("[data-role='range-add']"));
    await expect(popup).toBeHidden();
    await expect(page.locator(".kit-sr")).toContainText("已添加区间规则");
  });

  /* ---------- settings rows (mountSettingRow) ---------- */

  test("settings rows assemble label, ? help, and the AppSelect", async ({
    page,
  }) => {
    // Round 12 (owner item 7): the fourth topic — 输出格式 — joins
    // the three prototype-derived rows.
    const rows = page.locator(".kit-setrow");
    await expect(rows).toHaveCount(4);
    await expect(rows.first().locator(".kit-setname")).toHaveText(
      "字重合并方式",
    );
    await expect(rows.first().locator(".kit-sethead svg")).toBeVisible();
    await expect(
      rows.first().locator('[data-role="select-weight"]'),
    ).toBeVisible();
  });

  /* ---------- locate flow ---------- */

  test("locate field jumps to the character's block and page", async ({
    page,
  }) => {
    const goto = page.locator('[data-role="goto"]');
    await goto.fill("永");
    await goto.press("Enter");
    await expect(page.locator(".kit-toolrow")).toContainText("汉字区");
    await page.waitForTimeout(120);
    const outlined = await page.evaluate(() => {
      const cells = [...document.querySelectorAll<HTMLElement>(".kit-cell")];
      return cells.filter((c) => c.style.outline !== "").length;
    });
    expect(outlined).toBe(1);
  });
});
