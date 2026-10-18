import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  assertNoJsErrors,
  collectJsErrors,
  fixtureFontPaths,
  pointerClick,
  waitForFontsReady,
} from "./helpers";
import { generateNamedFace, scanMeta, spawnServeOverFonts } from "./serve";
import {
  buildServeCatalogSite,
  type ServeCatalogSite,
  type SiteFamilySpec,
} from "./catalog-serve-site";

/**
 * The serve-backed catalog (ticket #30, spec #25): the page consumes
 * the serve's /catalog/status + /catalog/families — it never fetches
 * the release document, a zip, or any font byte itself. The serve is a
 * REAL `fontalloy serve` subprocess syncing a real file:// release
 * origin (see ./catalog-serve-site.ts); the page is pointed at it
 * through the injected serveUrl seam, never a test-only code path.
 *
 * Settle signal: the boot's own sweep attribute (`data-catalog-sweep`
 * on <html> reads "done" once the status state machine settled) and
 * the progress screen's DOM (its rows persist while hidden).
 */

const [FONT_A, FONT_B] = fixtureFontPaths();

/**
 * The name-table identity of a host font, read by the SERVE's own
 * fontTools scan (the specs' independent oracle since the frontend
 * parse mirror died — ticket #36).
 */
const parsedDisplayName = async (serve: string, path: string) =>
  (await scanMeta(serve, path)).display;

/** Three fake families over two host binaries. */
const FAMILY_SPECS: SiteFamilySpec[] = [
  { family: "AlloySans", faces: [{ file: "AlloySans-Regular.ttf", fontPath: FONT_A }] },
  { family: "AlloySerif", faces: [{ file: "AlloySerif-Regular.ttf", fontPath: FONT_B }] },
  { family: "AlloyMono", faces: [{ file: "AlloyMono-Regular.ttf", fontPath: FONT_A }] },
];

/** A serve-backed catalog: site + serve, disposed with the test. */
async function startCatalogServe(
  specs: SiteFamilySpec[],
  options: {
    manifest?: boolean;
    originUri?: string;
    env?: Record<string, string>;
  } = {},
): Promise<{
  site: ServeCatalogSite;
  url: string;
  dispose: () => Promise<void>;
}> {
  const site = await buildServeCatalogSite(specs, {
    manifest: options.manifest,
  });
  const spawned = await spawnServeOverFonts(
    site.catalogDir,
    [
      "--catalog-release-origin",
      options.originUri ?? site.originUri,
      "--catalog-dir",
      site.catalogDir,
      ...(site.manifestPath !== null
        ? ["--manifest", site.manifestPath]
        : []),
    ],
    { env: options.env },
  );
  return {
    site,
    url: await spawned.url,
    dispose: async () => {
      await spawned.dispose();
      await rm(site.root, { recursive: true, force: true });
    },
  };
}

/** Open the app wired to the serve (the injected serveUrl seam). */
async function openOnServe(page: Page, url: string): Promise<void> {
  await page.addInitScript((serve) => {
    (window as { __FONTALLOY_CONFIG__?: unknown }).__FONTALLOY_CONFIG__ = {
      serveUrl: serve,
    };
  }, url);
  await page.goto("/");
}

/** The first-run progress screen (its DOM persists while hidden). */
const screen = (page: Page) => page.locator(".catalog-screen");
const familyStatus = (page: Page, family: string) =>
  screen(page).locator(
    `.catalog-family[data-family='${family}'] .catalog-family-status`,
  );
const catalogTotal = (page: Page) =>
  screen(page).locator("[data-stat='catalog-total']");
const catalogDone = (page: Page) =>
  screen(page).locator("[data-stat='catalog-done']");
const enPopup = (page: Page) => page.locator('[data-picker-popup="en"]');
const cjkPopup = (page: Page) => page.locator('[data-picker-popup="cjk"]');
const catalogRow = (page: Page, name: string) =>
  enPopup(page).locator(".kit-fp", { hasText: name });
const pickerNote = (page: Page) => enPopup(page).locator("[data-picker-note]");
/** The boot's settle signal (the round-30 sweep attribute, formalized). */
const sweepDone = (page: Page) =>
  page.waitForFunction(
    () => document.documentElement.dataset.catalogSweep === "done",
    undefined,
    { timeout: 60_000 },
  );

/** The serve-side per-family delay: an observably slow first sync. */
const SLOW_SYNC = { env: { FONTALLOY_CATALOG_SYNC_DELAY: "4" } };

test.describe("the serve-backed catalog", () => {
  // The slow-sync tests span a deliberately slowed full sync pass.
  test.setTimeout(90_000);

  test("first sync runs behind the status-driven screen with per-family progress, then settles", async ({
    page,
  }) => {
    const { url, dispose } = await startCatalogServe(FAMILY_SPECS, SLOW_SYNC);
    try {
      await openOnServe(page, url);

      // The screen appears while the serve's sync runs, driven by its
      // per-family status document.
      await expect(screen(page)).toBeVisible({ timeout: 15_000 });
      await expect(catalogTotal(page)).toHaveText("3");
      // Deterministic while the first two families work their slow
      // pass: the third is still queued behind them.
      await expect(familyStatus(page, "AlloyMono")).toHaveText("等待下载", {
        timeout: 15_000,
      });
      await expect(familyStatus(page, "AlloySans")).toHaveText(/已完成|下载中|解压中|校验中/);

      // Skip dismisses the screen; downloads continue serve-side and
      // the workspace was alive underneath all along.
      await pointerClick(page, screen(page).locator(".catalog-skip"));
      await expect(screen(page)).toBeHidden();
      await expect(page.locator(".workspace-rail")).toBeVisible();

      // The state machine settles: ready, every family done, screen
      // closed by the status itself.
      await sweepDone(page);
      await expect(familyStatus(page, "AlloySans")).toHaveText("已完成");
      await expect(familyStatus(page, "AlloySerif")).toHaveText("已完成");
      await expect(familyStatus(page, "AlloyMono")).toHaveText("已完成");
      await expect(catalogDone(page)).toHaveText("3");
      await expect(screen(page)).toBeHidden();
      await expect(pickerNote(page)).toBeHidden();
    } finally {
      await dispose();
    }
  });

  test("rows list from family documents, self-render via preview subsets, and search works", async ({
    page,
  }) => {
    const jsErrors: string[] = [];
    collectJsErrors(page, jsErrors);
    const { url, dispose } = await startCatalogServe(FAMILY_SPECS);
    const nameA = await parsedDisplayName(url, FONT_A);
    const nameB = await parsedDisplayName(url, FONT_B);
    try {
      await openOnServe(page, url);
      await sweepDone(page);
      await waitForFontsReady(page);

      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      // AlloySans and AlloyMono share the FONT_A binary: the family
      // DOCUMENTS still give each row its own identity, and each row
      // self-renders through its OWN preview subset family — the name
      // text reads the scanned name-table name.
      const sansRow = catalogRow(page, nameA).first();
      await expect(sansRow).toBeVisible();
      await expect(catalogRow(page, nameB)).toBeVisible();
      expect(await sansRow.getAttribute("aria-disabled")).toBeNull();

      // Self-rendering: the row's name element uses the family's own
      // preview subset css family (fa-cat-<family>), never the UI font.
      await expect
        .poll(async () =>
          sansRow
            .locator(".kit-nm")
            .evaluate((el) => getComputedStyle(el).fontFamily),
        )
        .toContain("fa-cat-AlloySans");
      await expect
        .poll(async () =>
          catalogRow(page, nameB)
            .locator(".kit-nm")
            .evaluate((el) => getComputedStyle(el).fontFamily),
        )
        .toContain("fa-cat-AlloySerif");

      // Search filters across the rows (family ids ride the keywords).
      const search = enPopup(page).locator(".kit-q");
      await search.fill("Serif");
      await expect(catalogRow(page, nameA)).toHaveCount(0);
      await expect(catalogRow(page, nameB)).toBeVisible();
      await search.fill("");
      await expect(catalogRow(page, nameA).first()).toBeVisible();

      // The local-file footer stays outside the scroll area.
      await expect(enPopup(page).locator(".kit-fpsys")).toContainText(
        "加载本地字体文件",
      );
      assertNoJsErrors(jsErrors);
    } finally {
      await dispose();
    }
  });

  test("the page never fetches the release document, zips, or font bytes", async ({
    page,
  }) => {
    // The round-30 fetch tap, formalized: every request the page makes
    // is recorded; none may touch the release pipeline's byte classes.
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    const { url, dispose } = await startCatalogServe(FAMILY_SPECS);
    try {
      await openOnServe(page, url);
      await sweepDone(page);
      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      await expect(
        catalogRow(page, await parsedDisplayName(url, FONT_A)).first(),
      ).toBeVisible();
      await page.waitForTimeout(500); // let the preview subsets land

      const banned = requests.filter((requested) =>
        /catalog-release\.json|\.zip(?:$|\?)|\/catalog\/faces\//.test(requested),
      );
      expect(banned, `page-side byte fetches: ${banned.join(", ")}`).toEqual([]);
      const previews = requests.filter((requested) =>
        /\/catalog\/families\/[^/]+\/preview$/.test(requested),
      );
      expect(previews.length).toBeGreaterThan(0);
    } finally {
      await dispose();
    }
  });

  test("selecting a catalog font registers it by URL and drives the workspace", async ({
    page,
  }) => {
    const jsErrors: string[] = [];
    collectJsErrors(page, jsErrors);
    const { url, dispose } = await startCatalogServe(FAMILY_SPECS);
    const nameB = await parsedDisplayName(url, FONT_B);
    try {
      await openOnServe(page, url);
      await sweepDone(page);

      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      await pointerClick(page, catalogRow(page, nameB));
      await waitForFontsReady(page);

      // Ticket #32 (the MEMORY RED LINE): the pick registered the
      // cut's slot winners as URL FontFaces under the MANIFEST family
      // id with their descriptors — never a byte in the page — and
      // every identity surface still reads the scanned name-table
      // name from the family document.
      await expect(
        page.locator('[data-role="picker-en"] .kit-hd b'),
      ).toHaveText(nameB);
      await expect(
        page.locator("[data-role='font-pair'] [data-pair='base']"),
      ).toHaveText(nameB);
      const loaded = await page.evaluate(() => ({
        face: document.fonts.check(`16px "AlloySerif"`, "A"),
        weight: [...document.fonts]
          .filter((f) => f.family === "AlloySerif")
          .map((f) => `${f.weight}/${f.style}`),
      }));
      expect(loaded.face).toBe(true);
      expect(loaded.weight).toEqual(["400/normal"]);
      // Ticket #36: the pick's coverage intervals ride the family
      // document, so the script-region counters are REAL again (the
      // serve's resolve answers stay the coloring truth — #35).
      await expect(page.locator("[data-stat='en']")).not.toHaveText("0");
      assertNoJsErrors(jsErrors);
    } finally {
      await dispose();
    }
  });

  test("a failed family lands the serve's verbatim error in the footer; others stay pickable", async ({
    page,
  }) => {
    const { url, dispose } = await startCatalogServe(
      FAMILY_SPECS.map((spec) =>
        spec.family === "AlloyMono" ? { ...spec, corruptZipSha: true } : spec,
      ),
      SLOW_SYNC,
    );
    try {
      await openOnServe(page, url);
      await sweepDone(page);
      await expect(screen(page)).toBeHidden();

      // The serve's own error string, VERBATIM, in the picker footer.
      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      await expect(pickerNote(page)).toContainText("AlloyMono");
      await expect(pickerNote(page)).toContainText("1 of 3");

      // The failed family's row states itself and stays disabled; the
      // healthy families are pickable rows. The failed family was
      // never scanned, so its row keeps the document's own label
      // (the artifact stem) — not the host font's name.
      const mono = enPopup(page)
        .locator(".kit-fp[aria-disabled='true']")
        .filter({ hasText: "AlloyMono" });
      await expect(mono).toHaveCount(1);
      await expect(mono.locator(".kit-fp-note")).toContainText("同步失败");
      const sans = enPopup(page)
        .locator(".kit-fp:not([aria-disabled='true'])")
        .filter({ hasText: await parsedDisplayName(url, FONT_A) });
      await expect(sans).toHaveCount(1);
      await expect(sans.locator(".kit-fp-note")).toHaveCount(0);
    } finally {
      await dispose();
    }
  });

  test("an unreachable release origin: verbatim error, no blocking, local fonts unaffected", async ({
    page,
  }) => {
    const { url, dispose } = await startCatalogServe(FAMILY_SPECS, {
      originUri: "file:///nowhere-at-all",
    });
    try {
      await openOnServe(page, url);
      await sweepDone(page);
      await expect(screen(page)).toBeHidden();

      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      await expect(pickerNote(page)).toContainText("catalog release document");
      await expect(catalogRow(page, "AlloySans")).toHaveCount(0);

      // Local files work exactly as before the catalog existed.
      await page.locator("input[data-role='font-file']").setInputFiles(FONT_A);
      await waitForFontsReady(page);
      await expect(enPopup(page)).toBeHidden();
      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      await expect(enPopup(page).locator(".kit-fp")).toHaveCount(1);
    } finally {
      await dispose();
    }
  });

  test("variant chips resolve the cut's own representative from the serve document", async ({
    page,
  }) => {
    // A multi-cut family (Standard + NF, the icons axis) over two named
    // faces: each chip pick loads ITS OWN cut's representative — the NF
    // chip's face is the NF-named binary, not the plain one.
    const root = await mkdtemp(resolve(tmpdir(), "fontalloy-cuts-"));
    let disposeServe: (() => Promise<void>) | null = null;
    try {
      const plain = await generateNamedFace(root, "UDEV Plain", "UDEVGothic");
      const nf = await generateNamedFace(root, "UDEV NF Cut", "UDEVGothicNF");
      const site = await buildServeCatalogSite(
        [
          {
            family: "UDEVGothic",
            faces: [
              { file: "UDEVGothic-Regular.ttf", fontPath: plain },
              { file: "UDEVGothicNF-Regular.ttf", fontPath: nf },
            ],
            manifestEntries: [
              { variant: "Standard", file: "UDEVGothic.zip" },
              { variant: "NF", file: "UDEVGothic_NF.zip", axes: { icons: "nf" } },
            ],
          },
        ],
        { manifest: true },
      );
      const spawned = await spawnServeOverFonts(
        site.catalogDir,
        [
          "--catalog-release-origin",
          site.originUri,
          "--catalog-dir",
          site.catalogDir,
          "--manifest",
          site.manifestPath!,
        ],
      );
      disposeServe = async () => {
        await spawned.dispose();
        await rm(site.root, { recursive: true, force: true });
      };
      await openOnServe(page, await spawned.url);
      await sweepDone(page);

      await pointerClick(page, page.locator('[data-role="picker-cjk"] .kit-hd'));
      const row = cjkPopup(page)
        .locator(".kit-fp")
        .filter({
          has: page.locator(".kit-vchip[data-chip='UDEVGothic::NF']"),
        });
      await expect(row).toHaveCount(1);
      await expect(row.locator(".kit-vchip")).toHaveCount(2);
      // Clicking the NF chip loads the NF cut's own face.
      await pointerClick(page, row.locator(".kit-vchip[data-chip='UDEVGothic::NF']"));
      await waitForFontsReady(page);
      await expect(
        page.locator("[data-role='font-pair'] [data-pair='donor']"),
      ).toHaveText("UDEV NF Cut");
      // Reverting to the default cut loads the plain face.
      await pointerClick(page, row.locator(".kit-vchip[data-chip='UDEVGothic::Standard']"));
      await waitForFontsReady(page);
      await expect(
        page.locator("[data-role='font-pair'] [data-pair='donor']"),
      ).toHaveText("UDEV Plain");
    } finally {
      await disposeServe?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a manifest-less serve still lists release-only families", async ({
    page,
  }) => {
    const { url, dispose } = await startCatalogServe(FAMILY_SPECS, {
      manifest: false,
    });
    try {
      const nameA = await parsedDisplayName(url, FONT_A);
      const nameB = await parsedDisplayName(url, FONT_B);
      await openOnServe(page, url);
      await sweepDone(page);
      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      await expect(catalogRow(page, nameA).first()).toBeVisible();
      await expect(catalogRow(page, nameB)).toBeVisible();
      // Release-only families carry no manifest entries: plain rows,
      // no chips.
      await expect(catalogRow(page, nameA).first().locator(".kit-vchip")).toHaveCount(0);
    } finally {
      await dispose();
    }
  });
});
