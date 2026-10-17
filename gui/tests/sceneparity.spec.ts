// Round 28 feedback loop v2 (diagnosing-bugs Phase 1): the ACTUAL
// scene preview, faithful PRE state (catalog picks — the URL FontFaces
// ticket #32 registers per (weight, style) slot) vs POST state (the
// synthesized output loaded locally). Signals: per-line text rects,
// CJK ink at 400/700 (+italic), LATIN ink at 400/700 — the owner's
// "本来是粗体的，合成完就不是了；行高也不一样".
//
// Ticket #30/#37 conversion: the catalog rows come from a REAL spawned
// serve over a tiny worktree-local catalog site (the old SimCatalog
// page-side bootstrap is gone). Ticket #32: the PRE picks are URL
// FontFaces — the multi-face base family registers its whole weight
// matrix by URL (the new pre-side signal: latinFaces ["400","700"]
// BEFORE any synthesis), while the POST output still loads through the
// local-file byte path (a local load is the one path that may hold
// bytes). Fixtures are generated (no real appData, no host fonts): the
// base family carries a real 400+700 matrix, the donor a single 400
// face over the scene's own character ranges.
import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pointerClick, waitForFontsReady } from "./helpers";
import { spawnServeOverFonts } from "./serve";
import {
  buildServeCatalogSite,
  type ServeCatalogSite,
} from "./catalog-serve-site";

test.setTimeout(300_000);

/** The scene text's character ranges the fixtures must really cover. */
const LATIN_RANGE: [number, number] = [0x20, 0x7e];
const CJK_RANGES: [number, number][] = [
  [0x2e80, 0x9fff],
  [0xf900, 0xfaff],
  [0xff00, 0xffef],
];

/**
 * Generate the parity fixtures (one python run, temp dir only):
 * - SceneParityMono: the EN-side family with a REAL weight matrix
 *   (Regular 400 + Bold 700, shared name-table family);
 * - LXGWWenKai: the CJK-side single-weight donor family (the curated
 *   group row's Regular cut), covering the scene's CJK text.
 */
async function generateParityFixtures(
  outdir: string,
): Promise<{ monoRegular: string; monoBold: string; kai: string }> {
  const script = `
import sys
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

out = Path(sys.argv[1])

def box(x0, y0, x1, y1):
    pen = TTGlyphPen(None)
    pen.moveTo((x0, y0)); pen.lineTo((x1, y0)); pen.lineTo((x1, y1)); pen.lineTo((x0, y1)); pen.closePath()
    return pen.glyph()

def build(path, family, style, weight, ranges):
    glyphs = {".notdef": box(0, 0, 500, 700)}
    metrics = {".notdef": (600, 40)}
    cmap = {}
    for start, end in ranges:
        for cp in range(start, end + 1):
            name = "uni%04X" % cp
            glyphs[name] = box(40, 0, 560, 700)
            metrics[name] = (600, 40)
            cmap[cp] = name
    b = FontBuilder(unitsPerEm=1000, isTTF=True)
    b.setupGlyphOrder(list(glyphs))
    b.setupCharacterMap(cmap)
    b.setupGlyf(glyphs)
    b.setupHorizontalMetrics(metrics)
    b.setupHorizontalHeader(ascent=800, descent=-200)
    b.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=900,
               usWinDescent=300, usWeightClass=weight)
    b.setupNameTable({"familyName": family, "styleName": style})
    b.setupPost()
    b.setupHead()
    b.save(path)

latin = [(${LATIN_RANGE[0]}, ${LATIN_RANGE[1]})]
cjk = [${CJK_RANGES.map(([a, b]) => `(${a}, ${b})`).join(", ")}]
build(out / "SceneParityMono-Regular.ttf", "Scene Parity Mono", "Regular", 400, latin)
build(out / "SceneParityMono-Bold.ttf", "Scene Parity Mono", "Bold", 700, latin)
build(out / "LXGWWenKai-Regular.ttf", "Scene Parity Kai", "Regular", 400, latin + cjk)
print("ok")
`;
  await mkdir(outdir, { recursive: true });
  const scriptPath = resolve(outdir, "_gen_parity.py");
  await writeFile(scriptPath, script, "utf8");
  const python = process.env.FONTALLOY_PYTHON ?? "python";
  await new Promise<void>((resolvePromise, rejectPromise) => {
    execFile(python, [scriptPath, outdir], { cwd: outdir, windowsHide: true }, (err, _so, stderr) => {
      if (err) rejectPromise(new Error(`${python}: ${err}\n${stderr}`));
      else resolvePromise();
    });
  });
  return {
    monoRegular: resolve(outdir, "SceneParityMono-Regular.ttf"),
    monoBold: resolve(outdir, "SceneParityMono-Bold.ttf"),
    kai: resolve(outdir, "LXGWWenKai-Regular.ttf"),
  };
}

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
    // gate is the vision comparison on captured screenshots; the
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
  const root = await mkdtemp(resolve(tmpdir(), "fontalloy-parity-"));
  const gen = await generateParityFixtures(resolve(root, "gen"));
  const site: ServeCatalogSite = await buildServeCatalogSite([
    {
      family: "SceneParityMono",
      faces: [
        { file: "SceneParityMono-Regular.ttf", fontPath: gen.monoRegular },
        { file: "SceneParityMono-Bold.ttf", fontPath: gen.monoBold },
      ],
    },
    {
      family: "LXGWWenKai",
      faces: [{ file: "LXGWWenKai-Regular.ttf", fontPath: gen.kai }],
      manifestEntries: [{ variant: "Regular", file: "LXGWWenKai.zip" }],
    },
  ]);
  const service = await spawnServeOverFonts(site.catalogDir, [
    "--catalog-release-origin",
    site.originUri,
    "--catalog-dir",
    site.catalogDir,
    "--manifest",
    site.manifestPath!,
  ]);
  try {
    const serviceUrl = await service.url;

    // The build: the base family's whole weight matrix (the family-cut
    // pattern), the single-weight donor — the shape that exposed the
    // round-28 defect.
    const submitted = await fetch(`${serviceUrl}/builds`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        base: {
          path: gen.monoRegular,
          pattern: "SceneParityMono-*.ttf",
        },
        donors: [{ path: gen.kai }],
        output: { family: "sceneparityv2", format: "ttc" },
      }),
    });
    expect(submitted.status).toBe(202);
    const { href } = (await submitted.json()) as { href: string };
    let build: Record<string, unknown> = {};
    for (let i = 0; i < 240; i++) {
      await page.waitForTimeout(1000);
      const doc = (await (await fetch(`${serviceUrl}${href}`)).json()) as Record<
        string,
        unknown
      >;
      build = doc;
      if (String(doc.status) !== "running" && String(doc.status) !== "queued") break;
    }
    expect(build.status, JSON.stringify(build)).toBe("done");
    const report = (await (await fetch(`${serviceUrl}${href}/report`)).json()) as {
      output: { faces: { weight: number; subfamily: string }[] };
    };
    const reportWeights = report.output.faces
      .map((face) => face.weight)
      .sort((a, b) => a - b);
    expect(reportWeights).toEqual([400, 700]);
    const artifact = resolve(root, "parity-single.ttc");
    const fontResponse = await fetch(`${serviceUrl}${href}/font`);
    await writeFile(artifact, Buffer.from(await fontResponse.arrayBuffer()));

    // The merged artifact reaches the page through the readFontPath
    // seam (the local-load path's browser fetch — the one byte path
    // left).
    await page.route("**/testfont/*", async (route) => {
      const name = new URL(route.request().url()).searchParams.get("name") ?? "";
      const target = [artifact].find((p) => p.endsWith(name));
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
    }, serviceUrl);
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

    // PRE: catalog picks — the multi-face base by URL (its whole
    // weight matrix registers), the single-weight donor via its chip.
    console.log("[parity] picking en");
    await pickCatalogRow(page, "en", "Scene Parity Mono");
    console.log("[parity] picking cjk");
    // The WenKai families collapse into ONE group row — click the
    // member chip itself (the fixture catalog carries only this cut).
    await pointerClick(page, page.locator('[data-role="picker-cjk"] .kit-hd'));
    const cjkPopup = page.locator('[data-picker-popup="cjk"]');
    await cjkPopup
      .locator(".kit-vchip[data-chip='LXGWWenKai::Regular']")
      .click({ timeout: 30_000 });
    // A chip pick keeps the popup open by design — the header card is
    // the signal.
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-role="picker-cjk"] .kit-hd .kit-hdc b')).toContainText(
      "Scene Parity Kai",
      { timeout: 30_000 },
    );
    console.log("[parity] waiting fonts (pre)");
    await waitForFontsReady(page);
    // The resolve document must LAND before measuring: the scene
    // spans resolve through it (a URL pick carries no client-side
    // cmap, so the serve's own answer is what renders the preview).
    // The base-only resolve lands first (latin spans); measuring may
    // start only once the BOTH-PICKS resolve lands — a CJK span
    // carrying the donor (its css key = the manifest family id,
    // ticket #32) is that signal. Spans without doc entries fall to
    // the system tail by design.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const spans = [
              ...document.querySelectorAll<HTMLElement>(".kit-term span"),
            ];
            const latin = spans.some((el) =>
              /SceneParityMono/.test(el.style.fontFamily),
            );
            const cjk = spans.some((el) =>
              /LXGWWenKai/.test(el.style.fontFamily),
            );
            return latin && cjk;
          }),
        { timeout: 30_000 },
      )
      .toBe(true);
    await page.waitForTimeout(400);
    console.log("[parity] measuring pre");
    const pre = await measure(page);

    // POST: the synthesized output in the CJK slot.
    console.log("[parity] loading merged");
    await loadViaPath(page, artifact, "cjk");
    await waitForFontsReady(page);
    await page.waitForTimeout(400);
    console.log("[parity] measuring post");
    const post = await measure(page);

    console.log("PRE  cjkFamily:", pre.cjkFamily, "faces:", JSON.stringify(pre.cjkFaces));
    console.log("POST cjkFamily:", post.cjkFamily, "faces:", JSON.stringify(post.cjkFaces));
    console.log("PRE  latinFamily:", pre.latinFamily, "faces:", JSON.stringify(pre.latinFaces));
    console.log("POST spanStyles:", JSON.stringify(post.spanStyles));

    // Round 28 assertions (the sharp, deterministic parity signals):
    // 1. The scene preview never synthesizes weight/style — the
    //    preview shows exactly what the fonts contain, pre and post
    //    alike.
    expect(pre.spanStyles.cjk?.synthesis).toBe("none");
    expect(post.spanStyles.cjk?.synthesis).toBe("none");
    // 2. Visual line spacing is font-independent pre/post (the
    //    computed line-height, not the font-metric Range-rect
    //    artifact).
    expect(pre.spanStyles.cjk?.lineHeight).toBe(post.spanStyles.cjk?.lineHeight);
    expect(pre.spanStyles.latin?.lineHeight).toBe(post.spanStyles.latin?.lineHeight);
    // 3. A single-weight donor carries its one face pre; the merged
    //    output carries the slot faces post — the weights are REAL on
    //    both sides, never synthetic. Ticket #32: the PRE side is now
    //    the URL registration — the multi-face base family already
    //    carries its whole matrix before any synthesis.
    expect(pre.cjkFaces).toEqual(["400"]);
    expect(pre.latinFaces).toEqual(["400", "700"]);
    expect(post.cjkFaces).toEqual(["400", "700"]);
    console.log("ASSERTIONS GREEN");
  } finally {
    await service.dispose();
    await rm(site.root, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
