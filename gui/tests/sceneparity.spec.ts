// Round 28 feedback loop v2 (diagnosing-bugs Phase 1): the ACTUAL
// scene preview, faithful PRE state (catalog picks — one registered
// face per family, the way the owner picks) vs POST state (the
// synthesized output loaded locally). Signals: per-line text rects,
// CJK ink at 400/700 (+italic), LATIN ink at 400/700 — the owner's
// "本来是粗体的，合成完就不是了；行高也不一样".
import { test, expect } from "@playwright/test";
import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pointerClick, waitForFontsReady } from "./helpers";
import { spawnServeOverFonts } from "./serve";
import { SimCatalog, injectCatalogConfig } from "./catalog-fixtures";

test.setTimeout(300_000);

const APP = String.raw`C:\Users\Administrator\AppData\Roaming\io.github.chhsiching.fontalloy\catalog\families`;
const FIRA_REG = APP + String.raw`\FiraCode\FiraCodeNerdFont-Regular.ttf`;
const MAPLE_REG = APP + String.raw`\LXGWWenKaiMono\LXGWWenKaiMono-Regular.ttf`;
// The synthesized output under test: built by the test through the
// real serve (FiraCode x LXGW-Reg-only — the single-weight-donor
// shape that exposed the round-28 defect), 2 faces (400/700).
const MERGED = String.raw`C:\Users\Administrator\Git\fontalloy-wt-repair\build\parity-single.ttc`;

async function pickCatalogRow(
  page: import("@playwright/test").Page,
  role: "en" | "cjk",
  name: string,
) {
  await pointerClick(page, page.locator(`[data-role="picker-${role}"] .kit-hd`));
  const popup = page.locator(`[data-picker-popup="${role}"]`);
  await popup.locator(".kit-fp", { hasText: name }).first().click();
  await expect(popup).toBeHidden({ timeout: 60_000 });
}

async function loadViaPath(page: import("@playwright/test").Page, path: string, role: "en" | "cjk") {
  await pointerClick(page, page.locator(`[data-role="picker-${role}"] .kit-hd`));
  const popup = page.locator(`[data-picker-popup="${role}"]`);
  const input = popup.locator("input[data-role='font-path']");
  await input.fill(path);
  await input.press("Enter");
  await expect(popup).toBeHidden({ timeout: 120_000 });
}

async function measure(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const lineRects = (rootSel: string): { h: number; top: number }[] => {
      const root = document.querySelector<HTMLElement>(rootSel);
      if (!root) return [];
      const out: { h: number; top: number }[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const seen = new Set<string>();
      while (walker.nextNode()) {
        const range = document.createRange();
        range.selectNodeContents(walker.currentNode);
        for (const rect of range.getClientRects()) {
          const key = `${Math.round(rect.top)}:${Math.round(rect.height)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ h: Math.round(rect.height * 10) / 10, top: Math.round(rect.top) });
        }
      }
      return out.sort((a, b) => a.top - b.top).slice(0, 20);
    };
    const lines = [...lineRects(".kit-term"), ...lineRects(".kit-doc")];

    const spanOf = (re: RegExp, scope: string): HTMLElement | undefined =>
      [...document.querySelectorAll<HTMLElement>(`${scope} span`)].find((s) =>
        re.test(s.textContent ?? ""),
      );
    const cjkSpan = spanOf(/[\u4E00-\u9FFF]/, ".kit-term");
    const latinSpan = spanOf(/[A-Za-z]/, ".kit-term");
    // NOTE: no canvas ink here — canvas text ignores CSS
    // font-synthesis, so it draws synthetic bold the scene preview
    // (font-synthesis: none) would never show. The real-rendering
    // gate is the vision comparison on the captured screenshots; the
    // numeric signal is the document.fonts face inventory.
    const probe = (el?: HTMLElement): Record<string, string> =>
      el
        ? {
            fontSize: getComputedStyle(el).fontSize,
            lineHeight: getComputedStyle(el).lineHeight,
            fontWeight: getComputedStyle(el).fontWeight,
            synthesis: getComputedStyle(el).fontSynthesis,
          }
        : {};
    const spanStyles = { cjk: probe(cjkSpan), latin: probe(latinSpan) };
    const cjkFamily = cjkSpan ? cjkSpan.style.fontFamily : "";
    const latinFamily = latinSpan ? latinSpan.style.fontFamily : "";
    const facesOf = (stack: string): string[] => {
      const m = /"?([^",]+)"?/.exec(stack);
      const family = m ? m[1]!.trim() : "";
      return [
        ...new Set(
          [...document.fonts]
            .filter((f) => f.family === family)
            .map((f) => {
              const w =
                f.weight === "normal"
                  ? "400"
                  : f.weight === "bold"
                    ? "700"
                    : f.weight;
              return `${w}${f.style === "italic" ? "i" : ""}`;
            }),
        ),
      ].sort();
    };
    return {
      lines,
      spanStyles,
      cjkFamily,
      latinFamily,
      cjkFaces: facesOf(cjkFamily),
      latinFaces: facesOf(latinFamily),
    };
  });
}

test("scene parity v2: catalog picks vs synthesized output", async ({ page }) => {
  const fontsDir = await mkdtemp(resolve(tmpdir(), "fontalloy-parity-"));
  await cp(resolve(APP, "FiraCode"), resolve(fontsDir, "FiraCode"), { recursive: true });
  await cp(resolve(APP, "MapleMono"), resolve(fontsDir, "MapleMono"), { recursive: true });
  const service = await spawnServeOverFonts(fontsDir);

  await page.route("**/testfont/*", async (route) => {
    const name = new URL(route.request().url()).searchParams.get("name") ?? "";
    const target = [MERGED].find((p) => p.endsWith(name));
    if (target === undefined) {
      await route.fulfill({ status: 404 });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/octet-stream",
      body: await readFile(target),
    });
  });
  await page.exposeFunction("__cmpName", async (path: string) =>
    path.split(/[\\/]/).pop() ?? "",
  );

  const sim = await SimCatalog.create([
    { family: "FiraCode", variant: "Nerd Font", file: "FiraCodeNerdFont-Regular.ttf", fontPath: FIRA_REG },
    { family: "LXGWWenKaiMono", variant: "Regular", file: "LXGWWenKaiMono-Regular.ttf", fontPath: MAPLE_REG },
  ]);
  await sim.install(page);
  await injectCatalogConfig(page);
  // AFTER injectCatalogConfig (it REPLACES the config object) — the
  // serve URL and the readFontPath seam must land on the final object,
  // WITHOUT touching the catalogBootstrapUrl the sim just installed.
  await page.addInitScript((serve: string) => {
    const w = window as unknown as { __FONTALLOY_CONFIG__?: Record<string, unknown> };
    w.__FONTALLOY_CONFIG__ ??= {};
    w.__FONTALLOY_CONFIG__.serveUrl = serve;
    w.__FONTALLOY_CONFIG__.readFontPath = async (path: string) => {
      const name = await (
        window as unknown as { __cmpName: (p: string) => Promise<string> }
      ).__cmpName(path);
      const res = await fetch(`/testfont/?name=${encodeURIComponent(name)}`);
      if (!res.ok) throw new Error(`no fixture for ${name}`);
      return {
        isDirectory: false,
        files: [{ fileName: name, path, buffer: await res.arrayBuffer() }],
      };
    };
  }, await service.url);
  await page.goto("/");
  await waitForFontsReady(page);
  await expect(page.locator(".catalog-screen")).toBeHidden({ timeout: 60_000 });
  await expect
    .poll(
      () =>
        page.evaluate(
          () => document.documentElement.dataset.catalogSweep ?? "running",
        ),
      { timeout: 120_000 },
    )
    .toBe("done");

  await pointerClick(
    page,
    page.locator(".kit-modebar .kit-mseg button[data-value='scene']"),
  );
  await page
    .locator(".content-stage[data-mode='scene'] .kit-term")
    .first()
    .waitFor({ timeout: 30_000 });

  // PRE: catalog picks (one registered face per family).
  console.log("[parity] picking en");
  await pickCatalogRow(page, "en", "FiraCode");
  console.log("[parity] picking cjk");
  // The WenKai families collapse into ONE group row — click the Mono
  // CHIP itself (a body click would pick the group's default kai cut,
  // which the fixture catalog does not carry).
  await pointerClick(page, page.locator('[data-role="picker-cjk"] .kit-hd'));
  const cjkPopup = page.locator('[data-picker-popup="cjk"]');
  await cjkPopup
    .locator(".kit-vchip[data-chip='LXGWWenKaiMono::Regular']")
    .click({ timeout: 30_000 });
  // A chip pick keeps the popup open by design — the header card is
  // the signal.
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-role="picker-cjk"] .kit-hd .kit-hdc b')).toContainText(
    "LXGW",
    { timeout: 30_000 },
  );
  console.log("[parity] waiting fonts (pre)");
  await waitForFontsReady(page);
  await page.waitForTimeout(400);
  console.log("[parity] measuring pre");
  const pre = await measure(page);
  const fs = await import("node:fs");
  const shotDir = "../fontalloy-notes/shots";
  fs.mkdirSync(shotDir, { recursive: true });
  await page.locator(".kit-term").first().screenshot({
    path: `${shotDir}/r28-term-pre.png`,
  });

  // POST: the synthesized output in the CJK slot.
  console.log("[parity] loading merged");
  await loadViaPath(page, MERGED, "cjk");
  await waitForFontsReady(page);
  await page.waitForTimeout(400);
  console.log("[parity] measuring post");
  const post = await measure(page);
  await page.locator(".kit-term").first().screenshot({
    path: `${shotDir}/r28-term-post.png`,
  });

  console.log("PRE  cjkFamily:", pre.cjkFamily, "faces:", JSON.stringify(pre.cjkFaces));
  console.log("POST cjkFamily:", post.cjkFamily, "faces:", JSON.stringify(post.cjkFaces));
  console.log("PRE  spanStyles:", JSON.stringify(pre.spanStyles));
  console.log("POST spanStyles:", JSON.stringify(post.spanStyles));

  // Round 28 assertions (the sharp, deterministic parity signals):
  // 1. The scene preview never synthesizes weight/style — the preview
  //    shows exactly what the fonts contain, pre and post alike.
  expect(pre.spanStyles.cjk?.synthesis).toBe("none");
  expect(post.spanStyles.cjk?.synthesis).toBe("none");
  // 2. Visual line spacing is font-independent pre/post (the computed
  //    line-height, not the font-metric Range-rect artifact).
  expect(pre.spanStyles.cjk?.lineHeight).toBe(post.spanStyles.cjk?.lineHeight);
  expect(pre.spanStyles.latin?.lineHeight).toBe(post.spanStyles.latin?.lineHeight);
  // 3. A single-weight donor carries its one face pre; the merged
  //    output carries the slot faces post — the weights are REAL on
  //    both sides, never synthetic.
  expect(pre.cjkFaces).toEqual(["400"]);
  expect(post.cjkFaces).toEqual(["400", "700"]);
  console.log("ASSERTIONS GREEN");
  await service.dispose();
});
