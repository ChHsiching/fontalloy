// Round 24 (owner item 3) / ticket #34: system fonts — the serve's
// GROUPED document drives the pickers (Latin → EN, CJK → CJK, both →
// both, flags riding each family's actual coverage), a pick registers
// the family's faces as URL FontFaces through the serve's
// /system-fonts/file byte source (no ArrayBuffer ever enters the
// page), repeat-click unload EVICTS the registration, and a build
// names the system files by their absolute paths like any local file.
import { test, expect } from "@playwright/test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  collectJsErrors,
  pointerClick,
  waitForFontsReady,
} from "./helpers";
import { generateSystemFonts, spawnServeOverFonts } from "./serve";

test.setTimeout(180_000);

/** The document.fonts face inventory of one css family (`w/style`). */
function facesOf(page: import("@playwright/test").Page, family: string): Promise<string[]> {
  return page.evaluate((fam) => {
    const faces = [...document.fonts].filter((f) => f.family === fam);
    return faces
      .map((f) => `${f.weight}/${f.style}`)
      .sort((a, b) => Number(a.split("/")[0]) - Number(b.split("/")[0]));
  }, family);
}

test("system fonts list by coverage, pick as URL faces, evict on unload, and build", async ({
  page,
}) => {
  const jsErrors: string[] = [];
  collectJsErrors(page, jsErrors);
  await page.route("https://api.github.com/repos/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );

  const sysDir = await mkdtemp(resolve(tmpdir(), "fontalloy-sysfonts-"));
  await generateSystemFonts(sysDir);
  const service = await spawnServeOverFonts(sysDir, [
    "--system-font-dir",
    sysDir,
  ]);

  const saved: string[] = [];
  const saveDir = await mkdtemp(resolve(tmpdir(), "fontalloy-sysfont-save-"));
  try {
    // The serve's own document groups the scan (ticket #34): the
    // families list is the grouping truth the page consumes. The scan
    // is background — poll until it lands, like the frontend does.
    const base = await service.url;
    let doc: {
      ready: boolean;
      families: Array<{ family: string; latin: boolean; cjk: boolean }>;
    } | null = null;
    for (let attempt = 0; attempt < 100; attempt++) {
      const answer = (await (await fetch(`${base}/system-fonts`)).json()) as {
        ready: boolean;
        families: Array<{ family: string; latin: boolean; cjk: boolean }>;
      };
      if (answer.ready) {
        doc = answer;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(doc, "the system-font scan never answered ready").not.toBeNull();
    const groups = new Map(doc.families.map((f) => [f.family, f]));
    expect(groups.get("AlloyEN")?.latin).toBe(true);
    expect(groups.get("AlloyEN")?.cjk).toBe(false);
    expect(groups.get("AlloyCJK")?.cjk).toBe(true);
    expect(groups.get("AlloyBoth")?.latin).toBe(true);
    expect(groups.get("AlloyBoth")?.cjk).toBe(true);

    await page.exposeFunction(
      "__fontalloyTestSave",
      async (name: string, bytesB64: string): Promise<string | null> => {
        const { Buffer } = await import("node:buffer");
        const target = resolve(saveDir, name);
        await writeFile(target, Buffer.from(bytesB64, "base64"));
        saved.push(target);
        return target;
      },
    );
    await page.addInitScript(() => {
      // The enumeration is desktop-gated; the browser test fakes the
      // Tauri marker (presence is all isTauri() checks — every real
      // IPC the flow needs goes through injected seams or the serve).
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    });
    await page.addInitScript((serve: string) => {
      const config = window as unknown as {
        __FONTALLOY_CONFIG__: Record<string, unknown>;
      };
      config.__FONTALLOY_CONFIG__ ??= {};
      config.__FONTALLOY_CONFIG__.serveUrl = serve;
      config.__FONTALLOY_CONFIG__.probeArtifact = async () => ({
        exists: false,
        path: "ChHsich.ttf",
      });
      config.__FONTALLOY_CONFIG__.saveArtifact = async (
        name: string,
        bytes: Uint8Array,
      ): Promise<{ saved: boolean; path: string | null }> => {
        const b64 = btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
        const path = await (
          window as unknown as {
            __fontalloyTestSave: (n: string, b: string) => Promise<string>;
          }
        ).__fontalloyTestSave(name, b64);
        return { saved: true, path };
      };
    }, base);

    await page.goto("/");
    await waitForFontsReady(page);
    // No catalog configured — the service connect and the background
    // system enumeration are what we wait for: the rows appear once
    // /system-fonts lands.
    await expect(page.locator(".catalog-screen")).toBeHidden();

    // EN lists the Latin families (the both-coverage family included),
    // never the CJK-only one.
    await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
    const enPopup = page.locator('[data-picker-popup="en"]');
    await expect(
      enPopup.locator(".kit-fp", { hasText: "AlloyEN" }),
    ).toHaveCount(1, { timeout: 30_000 });
    await expect(enPopup.locator(".kit-fp", { hasText: "AlloyBoth" })).toHaveCount(1);
    await expect(enPopup.locator(".kit-fp", { hasText: "AlloyCJK" })).toHaveCount(0);
    await expect(
      enPopup.locator(".kit-fp", { hasText: "AlloyEN" }).locator(".kit-meta"),
    ).toContainText("系统字体");

    // CJK lists the Chinese families — the both-coverage family again
    // (微软雅黑's rule), never the Latin-only one.
    await page.keyboard.press("Escape");
    await pointerClick(page, page.locator('[data-role="picker-cjk"] .kit-hd'));
    const cjkPopup = page.locator('[data-picker-popup="cjk"]');
    await expect(
      cjkPopup.locator(".kit-fp", { hasText: "AlloyCJK" }),
    ).toHaveCount(1, { timeout: 30_000 });
    await expect(cjkPopup.locator(".kit-fp", { hasText: "AlloyBoth" })).toHaveCount(1);
    await expect(cjkPopup.locator(".kit-fp", { hasText: "AlloyEN" })).toHaveCount(0);

    // Pick the both-coverage family: the faces register as URL
    // FontFaces (lazy — bytes stream from /system-fonts/file only as
    // slots render), and the card reads the family.
    await pointerClick(
      page,
      cjkPopup.locator(".kit-fp", { hasText: "AlloyBoth" }),
    );
    await waitForFontsReady(page);
    await expect(
      page.locator("[data-role='picker-cjk'] .kit-hd .kit-hdc b"),
    ).toHaveText("AlloyBoth", { timeout: 30_000 });
    expect(await facesOf(page, "AlloyBoth")).toEqual(["400/normal"]);
    const renders = await page.evaluate(async () => {
      await document.fonts.load('16px "AlloyBoth"');
      return {
        latin: document.fonts.check('16px "AlloyBoth"', "A"),
        cjk: document.fonts.check('16px "AlloyBoth"', "\u4e2d"),
      };
    });
    expect(renders.latin).toBe(true);
    expect(renders.cjk).toBe(true);

    // Repeat-click unload EVICTS the system pick (ticket #34): the
    // family's faces come off document.fonts and the slot returns to
    // the never-picked state; the row itself stays (it is the serve's
    // enumeration, not a registry record).
    await pointerClick(page, page.locator('[data-role="picker-cjk"] .kit-hd'));
    await expect(cjkPopup).toBeVisible();
    await pointerClick(page, cjkPopup.locator(".kit-fp", { hasText: "AlloyBoth" }));
    await expect(cjkPopup).toBeHidden();
    await waitForFontsReady(page);
    expect(await facesOf(page, "AlloyBoth")).toEqual([]);
    await expect(
      page.locator("[data-role='picker-cjk'] .kit-hd b"),
    ).toHaveText("尚未加载字体");

    // Re-pick re-registers the URL faces from the document.
    await pointerClick(page, page.locator('[data-role="picker-cjk"] .kit-hd'));
    await expect(cjkPopup).toBeVisible();
    await pointerClick(page, cjkPopup.locator(".kit-fp", { hasText: "AlloyBoth" }));
    await expect(cjkPopup).toBeHidden();
    await waitForFontsReady(page);
    expect(await facesOf(page, "AlloyBoth")).toEqual(["400/normal"]);
    await expect(
      page.locator("[data-role='picker-cjk'] .kit-hd .kit-hdc b"),
    ).toHaveText("AlloyBoth");

    // The EN side picks from the system source too; the build names
    // the system files by their absolute paths.
    await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
    await pointerClick(
      page,
      page.locator('[data-picker-popup="en"] .kit-fp', { hasText: "AlloyEN" }),
    );
    await waitForFontsReady(page);
    await expect(
      page.locator("[data-role='font-pair'] [data-pair='base']"),
    ).toHaveText("AlloyEN", { timeout: 30_000 });

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
    expect(String((body.base as Record<string, unknown>).path)).toContain(
      "AlloyEN-Regular.ttf",
    );
    expect(
      String((body.donors as Record<string, unknown>[])[0]!.path),
    ).toContain("AlloyBoth-Regular.ttf");

    const panel = page.locator('[data-testid="build-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel.locator("[data-build-stage]").first()).toHaveText(
      "完成",
      { timeout: 120_000 },
    );
    await expect(panel).toContainText("已保存");
    expect(saved).toHaveLength(1);
  } finally {
    await service.dispose();
  }
  expect(jsErrors).toEqual([]);
});
