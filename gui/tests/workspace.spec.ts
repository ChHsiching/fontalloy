import { test, expect } from "@playwright/test";
import {
  assertNoJsErrors,
  collectJsErrors,
  pointerClick,
  waitForFontsReady,
} from "./helpers";

test.describe("workspace shell", () => {
  const jsErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    jsErrors.length = 0;
    collectJsErrors(page, jsErrors);
    await page.goto("/");
    await waitForFontsReady(page);
  });

  test.afterEach(() => assertNoJsErrors(jsErrors));

  test("boots with top bar, 260px left column, character-map content, stats bar", async ({
    page,
  }) => {
    // Top bar carries the brand (the kit's assembled TopBar).
    const brand = page.locator(".topbar .kit-brand");
    await expect(brand).toBeVisible();
    expect((await brand.textContent()) ?? "").toContain("FontAlloy");

    // The prototype's top bar chrome: repo link, theme toggle, font name.
    const repo = page.locator(".topbar a.kit-btn");
    await expect(repo).toHaveAttribute(
      "href",
      "https://github.com/ChHsiching/fontalloy",
    );
    expect((await repo.textContent()) ?? "").toContain("ChHsiching/fontalloy");
    await expect(page.locator(".topbar [data-role='theme-toggle']")).toBeVisible();
    const fontName = page.locator(".topbar [data-role='font-name']");
    await expect(fontName).toHaveValue("ChHsich");

    // Left column is a fixed 260px rail (ADR-0004).
    const rail = page.locator(".workspace-rail");
    await expect(rail).toBeVisible();
    const railBox = await rail.boundingBox();
    expect(railBox?.width).toBe(260);

    // The five rail sections (the prototype's titles).
    for (const title of ["英文字体", "中文字体", "文字范围", "自定义规则", "合成设置"]) {
      await expect(
        page.locator(".workspace-rail .section", { hasText: title }).first(),
      ).toBeVisible();
    }

    // Right content area is in character-map mode (the mode segment).
    await expect(
      page.locator(".kit-modebar .kit-mseg button[data-value='charmap']"),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".charmap")).toBeVisible();

    // Persistent bottom stats bar: the six color-coded counters, tabular.
    const stats = page.locator(".statsbar");
    await expect(stats).toBeVisible();
    expect((await stats.textContent()) ?? "").toContain("字符");
    expect((await stats.textContent()) ?? "").toContain("覆盖");
    expect(
      await stats.evaluate((el) =>
        getComputedStyle(el.querySelector("b.kit-num")!).fontVariantNumeric,
      ),
    ).toContain("tabular-nums");
  });

  test("the theme toggle cycles the app theme through the kit tokens", async ({
    page,
  }) => {
    // Round 5: the toggle is a 3-state cycle (自动 → 浅色 → 深色 → 自动).
    // From a fresh context (自动, system light) reaching a FLIP takes
    // one step to 浅色 (no change) then one to 深色; the cycle closes.
    const before = await page.evaluate(() => document.documentElement.dataset.theme);
    const theme = () =>
      page.evaluate(() => document.documentElement.dataset.theme);
    const toggle = page.locator(".topbar [data-role='theme-toggle']");
    let steps = 0;
    while ((await theme()) === before && steps < 3) {
      await pointerClick(page, toggle);
      await page.waitForTimeout(100); // the two-frame .theming guard settles
      steps++;
    }
    expect(await theme()).not.toBe(before);
    // The token the whole app paints with follows the theme attribute.
    const pageColor = await page.evaluate(
      () => getComputedStyle(document.documentElement).getPropertyValue("--page").trim(),
    );
    expect(pageColor.length).toBeGreaterThan(0);
    while ((await theme()) !== before && steps < 6) {
      await pointerClick(page, toggle);
      await page.waitForTimeout(100);
      steps++;
    }
    expect(await theme()).toBe(before);
  });

  test("synthesize action is present but disabled with a click-reachable explanation", async ({
    page,
  }) => {
    const synthesize = page.locator(".topbar [data-role='synthesize']");
    await expect(synthesize).toBeVisible();
    await expect(synthesize).toHaveAttribute("aria-disabled", "true");

    // No tooltip dependency: the explanation must appear as page text on click.
    await pointerClick(page, synthesize);
    const notice = page.locator(".synthesize-notice");
    await expect(notice).toBeVisible();
    const text = (await notice.textContent()) ?? "";
    expect(text.length).toBeGreaterThan(4);
  });

  test("the brand carries the hand-drawn SVG mark; the web target mounts no window chrome", async ({
    page,
  }) => {
    // Round 4: the solid placeholder block became a drawn mark (an A
    // built from 永-style strokes, teal accent). Round 7 enlarges it to
    // 22px — balanced with the bar, not tiny — and adopts it product-
    // wide (panel headers, favicon, the Tauri icon set).
    const mark = page.locator(".topbar .kit-brand .kit-brand-mark");
    await expect(mark).toBeVisible();
    const box = await mark.boundingBox();
    expect(box!.width).toBeCloseTo(22, 0);
    expect(await mark.locator("path").count()).toBeGreaterThanOrEqual(3);

    // The custom window controls and the drag region are GUI-only
    // (ui/wincontrols gates on isTauri): none of it in the web target.
    await expect(page.locator(".win-controls")).toHaveCount(0);
    await expect(
      page.locator(".topbar [data-tauri-drag-region]"),
    ).toHaveCount(0);
  });

  test("font-pair tags reflect the (empty) selection state in plain text", async ({
    page,
  }) => {
    const tags = page.locator(".topbar [data-role='font-pair']");
    // The pair element itself stays mounted; the empty sides show no
    // pill at all — the prototype's tags always carry real picks, so
    // the honest empty state is no em-dash placeholder pill.
    await expect(tags).toHaveCount(1);
    await expect(tags.locator("[data-pair='base']")).toBeHidden();
    await expect(tags.locator("[data-pair='donor']")).toBeHidden();
    expect((await tags.textContent()) ?? "").not.toContain("—");
  });

  /* ---------- round 13, owner item 1: the rail's hidden scrollbar ---------- */

  test("the rail never shows a scrollbar; scroll fades mark the hidden overflow", async ({
    page,
  }) => {
    const rail = page.locator(".workspace-rail");

    // The bar is hidden in BOTH engines (the standard property computes
    // to none in Chromium; the ::-webkit-scrollbar rule is asserted
    // against the served stylesheets — getComputedStyle cannot read
    // vendor pseudo-elements).
    expect(
      await rail.evaluate((el) => getComputedStyle(el).scrollbarWidth),
    ).toBe("none");
    const webkitRulePresent = await page.evaluate(() =>
      [...document.styleSheets].some((sheet) =>
        [...sheet.cssRules].some((rule) =>
          rule.cssText.includes(".workspace-rail::-webkit-scrollbar") &&
          rule.cssText.includes("display: none"),
        ),
      ),
    );
    expect(webkitRulePresent).toBe(true);

    // The scroll affordance is the fade mask — alpha-only, so it reads
    // the same in both themes (no color stops to theme-switch).
    expect(
      await rail.evaluate((el) => getComputedStyle(el).maskImage),
    ).toContain("linear-gradient");

    // The two 0/1 fade flags (set by ui/rail.ts's tiny scroll
    // listener) drive which edges fade. Read through expect.poll: the
    // flag flips ride a ResizeObserver frame under load.
    const flag = (name: "top" | "bottom") =>
      rail.evaluate((el, key) => el.style.getPropertyValue(`--rail-fade-${key}`), name);
    const maxScroll = () =>
      rail.evaluate((el) => el.scrollHeight - el.clientHeight);

    // No overflow at all (a viewport taller than the rail's content):
    // neither edge fades.
    await page.setViewportSize({ width: 1440, height: 1600 });
    await expect.poll(() => maxScroll()).toBeLessThanOrEqual(0);
    await expect.poll(() => flag("top")).toBe("0");
    await expect.poll(() => flag("bottom")).toBe("0");

    // Overflow at rest at the TOP: only the bottom edge fades.
    await page.setViewportSize({ width: 1440, height: 420 });
    await expect.poll(() => maxScroll()).toBeGreaterThan(0);
    await expect.poll(() => flag("top")).toBe("0");
    await expect.poll(() => flag("bottom")).toBe("1");

    // The scroll itself lives on: a real wheel event over the rail
    // moves it, and once scrolled the top fade joins in.
    await page.mouse.move(130, 220);
    await page.mouse.wheel(0, 80);
    await expect
      .poll(() => rail.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
    await expect.poll(() => flag("top")).toBe("1");
    await expect.poll(() => flag("bottom")).toBe("1");

    // At rest at the BOTTOM: only the top edge fades.
    await rail.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect.poll(() => flag("top")).toBe("1");
    await expect.poll(() => flag("bottom")).toBe("0");
  });

  /* ---------- round 13, owner item 3: the 输出目录 row ---------- */

  test("the Tauri 输出目录 row: single line, middle truncation, copy path", async ({
    page,
  }) => {
    // The web target (this suite's default page) never renders the
    // row: its save is the browser's own download flow.
    await expect(page.locator(".settings-outdir")).toHaveCount(0);

    // Fake the Tauri shell for a second load: the internals global the
    // platform adapter sniffs, a minimal invoke answering exactly the
    // three commands the row and boot touch, and a persisted output-
    // directory override (so the row's first render needs no IPC).
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      const config = (w.__FONTALLOY_CONFIG__ ?? {}) as Record<string, unknown>;
      config.catalogBootstrapUrl = null; // never reach for GitHub here
      config.serveUrl = null; // no probe: service honestly absent
      w.__FONTALLOY_CONFIG__ = config;
      w.__TAURI_INTERNALS__ = {
        invoke: (cmd: string): unknown => {
          if (cmd === "serve_url") return null;
          if (cmd === "default_output_dir") {
            return Promise.resolve(
              "C:\\Users\\Administrator\\Downloads\\fontalloy",
            );
          }
          if (cmd === "pick_output_dir") {
            // A POSIX-style picked directory: the DISPLAY must keep the
            // path's own separators — nothing hardcodes \ or /.
            return Promise.resolve(
              "/home/owner/works/2026/fonts/outputs/merged",
            );
          }
          return Promise.reject(new Error(`fake shell: ${cmd}`));
        },
      };
      localStorage.setItem(
        "fontalloy.outputDir",
        "C:\\Users\\Administrator\\Documents\\FontAlloy\\合成\\很长很长的目录\\输出位置",
      );
    });
    await page.goto("/");
    await waitForFontsReady(page);

    const row = page.locator(".settings-outdir");
    await expect(row).toBeVisible();
    const value = page.locator("[data-role='output-dir-path']");
    const fullOverride =
      "C:\\Users\\Administrator\\Documents\\FontAlloy\\合成\\很长很长的目录\\输出位置";

    // Single line, middle-ellipsized in the RENDER: the root pair and
    // the tail pair survive with the ORIGINAL backslashes, one
    // ellipsis in the middle; the full path rides the title.
    await expect(value).toHaveText(
      "C:\\Users\\…\\很长很长的目录\\输出位置",
    );
    await expect(value).toHaveAttribute("title", fullOverride);
    const singleLine = await page
      .locator(".settings-outdir-value")
      .evaluate((el) => {
        const boxes = [...el.children].map((c) => c.getBoundingClientRect());
        const centers = boxes.map((b) => (b.top + b.bottom) / 2);
        return (
          el.getBoundingClientRect().height < 30 &&
          Math.max(...centers) - Math.min(...centers) < 2
        );
      });
    expect(singleLine).toBe(true);

    // 更改 picks the POSIX directory: the display keeps ITS slashes,
    // and 恢复默认 appears (an override now exists).
    await pointerClick(page, page.locator("[data-role='output-dir-change']"));
    await expect(value).toHaveText("/home/…/outputs/merged");
    await expect(value).toHaveAttribute(
      "title",
      "/home/owner/works/2026/fonts/outputs/merged",
    );
    await expect(page.locator("[data-role='output-dir-reset']")).toBeVisible();

    // The copy-path icon button puts the FULL path on the clipboard
    // and shows a brief copied state — the only feedback (no toast).
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await pointerClick(page, page.locator("[data-role='output-dir-copy']"));
    await expect
      .poll(() =>
        page.evaluate(() => navigator.clipboard.readText()),
      )
      .toBe("/home/owner/works/2026/fonts/outputs/merged");
    const copy = page.locator("[data-role='output-dir-copy']");
    await expect(copy).toHaveAttribute("aria-label", "已复制路径");
    await expect(copy).toHaveClass(/copied/);
    await page.waitForTimeout(1800);
    await expect(copy).toHaveAttribute("aria-label", "复制路径");
    await expect(copy).not.toHaveClass(/copied/);

    // 恢复默认 clears the override: the shell default renders — a
    // five-segment path, so it middle-truncates too — and the reset
    // button hides again.
    await pointerClick(page, page.locator("[data-role='output-dir-reset']"));
    await expect(value).toHaveText("C:\\Users\\…\\Downloads\\fontalloy");
    await expect(value).toHaveAttribute(
      "title",
      "C:\\Users\\Administrator\\Downloads\\fontalloy",
    );
    await expect(page.locator("[data-role='output-dir-reset']")).toBeHidden();
  });
});
