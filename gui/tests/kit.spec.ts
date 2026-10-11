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
    await expect(pair.nth(0)).toHaveText("JetBrains Mono");
    await expect(pair.nth(1)).toHaveText("Maple Mono CN");
  });

  test("theme toggle flips the app theme with the extracted palettes", async ({
    page,
  }) => {
    const frame = page.locator(".kit-app");
    const initial = await page.evaluate(() =>
      document.documentElement.dataset.theme === "dark" ? "dark" : "light",
    );
    const accentOf = () =>
      frame.evaluate((el) => getComputedStyle(el).getPropertyValue("--ac").trim());

    if (initial === "light") {
      expect(await accentOf()).toBe("#0f766e");
    } else {
      expect(await accentOf()).toBe("#4ade9e");
    }

    await pointerClick(page, page.locator('[data-role="theme-toggle"]'));
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      initial === "light" ? "dark" : "light",
    );
    expect(await accentOf()).toBe(initial === "light" ? "#4ade9e" : "#0f766e");

    // The transition-killer class is transient (two frames), never stuck.
    await page.waitForTimeout(120);
    expect(
      await page.evaluate(() => document.documentElement.classList.contains("theming")),
    ).toBe(false);
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

    // Ratified option labels, Chinese verbatim.
    await expect(popup.locator(".kit-cso")).toHaveCount(3);
    await expect(popup.locator(".kit-cso").first()).toHaveText(
      "双方字重全部保留 · 推荐",
    );

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
    await expect(select.locator("span")).toHaveText("中文字和英文底边一样高");
    await page.keyboard.press("ArrowUp");
    await expect(select.locator("span")).toHaveText("自动 · 推荐");
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

  test("help popover: circular button, verbatim chrome, ADR-corrected content", async ({
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

    // ADR-0006-corrected content marker: the donor-only row reads the
    // shared-slots semantics, and the mapping table has no 中等 output row.
    await expect(tables.first()).toContainText("仅保留两种字体共有的档位");
    const rows = tables.nth(1).locator("tbody tr");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(2).locator("td").first()).toHaveText("粗体");

    // The popover clamps inside the app frame.
    const frameBox = await page.locator(".kit-app").boundingBox();
    const popBox = await pop.boundingBox();
    expect(frameBox).not.toBeNull();
    expect(popBox).not.toBeNull();
    expect(popBox!.y).toBeGreaterThanOrEqual(frameBox!.y - 1);
    expect(popBox!.y + popBox!.height).toBeLessThanOrEqual(
      frameBox!.y + frameBox!.height + 1,
    );

    await page.keyboard.press("Escape");
    await expect(pop).toBeHidden();
  });

  /* ---------- PickerPopup ---------- */

  test("picker opens attached below the card and clamps inside the frame", async ({
    page,
  }) => {
    const card = page.locator('[data-role="picker-en"]');
    await pointerClick(page, card.locator(".kit-hd"));
    await page.waitForTimeout(250); // the discrete open transition settles
    const popup = page.locator('[data-picker-popup="en"]');
    await expect(popup).toBeVisible();
    await expect(card).toHaveClass(/open/);

    const cardBox = (await card.boundingBox())!;
    const popupBox = (await popup.boundingBox())!;
    const frameBox = (await page.locator(".kit-app").boundingBox())!;

    // Attached: overlaps the card's bottom border by 1px, same width (+2).
    expect(Math.abs(popupBox.y - (cardBox.y + cardBox.height - 1))).toBeLessThanOrEqual(1.5);
    expect(Math.abs(popupBox.width - (cardBox.width + 2))).toBeLessThanOrEqual(2);
    expect(Math.abs(popupBox.x - (cardBox.x - 1))).toBeLessThanOrEqual(1.5);
    // Clamped to the frame.
    expect(popupBox.y + popupBox.height).toBeLessThanOrEqual(
      frameBox.y + frameBox.height + 0.5,
    );

    // Chevron rotates 90deg when open.
    const chevron = await card
      .locator(".kit-hd > svg")
      .evaluate((el) => getComputedStyle(el).transform);
    expect(chevron).not.toBe("none");
  });

  for (const height of [700, 520]) {
    test(`picker stays inside the app frame at ${height}px height`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 900, height });
      const card = page.locator('[data-role="picker-cjk"]');
      await card.scrollIntoViewIfNeeded();
      await pointerClick(page, card.locator(".kit-hd"));
      const popup = page.locator('[data-picker-popup="cjk"]');
      await expect(popup).toBeVisible();
      const frameBox = (await page.locator(".kit-app").boundingBox())!;
      const popupBox = (await popup.boundingBox())!;
      expect(popupBox.y).toBeGreaterThanOrEqual(frameBox.y - 1);
      expect(popupBox.y + popupBox.height).toBeLessThanOrEqual(
        frameBox.y + frameBox.height + 0.5,
      );
    });
  }

  test("picker rows self-render with the no-pills meta line and a check on the selected row", async ({
    page,
  }) => {
    await pointerClick(page, page.locator('[data-role="picker-cjk"] .kit-hd'));
    const popup = page.locator('[data-picker-popup="cjk"]');
    const rows = popup.locator(".kit-fp");
    await expect(rows).toHaveCount(3);

    const maple = rows.filter({ hasText: "Maple Mono CN" });
    // Meta line: formatted stars, stripped license, trait — plain text.
    await expect(maple.locator(".kit-meta")).toHaveText("29.2kOFL圆角等宽");
    await expect(maple.locator(".kit-gh")).toContainText("29.2k");
    await expect(maple.locator(".kit-gh svg")).toBeVisible();
    // Selected row: accent tint + check mark + aria-pressed.
    await expect(maple).toHaveAttribute("aria-pressed", "true");
    await expect(maple.locator(".kit-chk")).toBeVisible();
    const unselected = rows.filter({ hasText: "思源黑体" });
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
    await expect(rows.first()).toContainText("JetBrains Mono");

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
    await expect(card.locator(".kit-hd b")).toHaveText("Iosevka");
    // The top bar pair tag follows.
    await expect(page.locator('[data-role="font-pair"] .kit-tag').first()).toHaveText(
      "Iosevka",
    );
  });

  test("closed picker removes its popup node after the exit transition", async ({
    page,
  }) => {
    await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
    const popup = page.locator('[data-picker-popup="en"]');
    await expect(popup).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popup).toBeHidden();
    // display:none but still in the DOM while the exit transition plays…
    expect(await popup.count()).toBe(1);
    // …then removed (~240ms deferred; polled, not a fixed sleep — the
    // timer can lag under a full parallel suite run).
    await expect(popup).toHaveCount(0, { timeout: 3000 });
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
    await expect(row).toContainText("全部用英文字体");
    await expect(row).toContainText("全部用中文字体");
    await expect(row).toContainText("汉字区");
    await expect(row).toContainText("用英文字体");
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
    await expect(row).toContainText("按住拖动连选 · Shift+点击 范围选择");
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
