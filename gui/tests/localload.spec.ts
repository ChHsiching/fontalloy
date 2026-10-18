import { test, expect, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoJsErrors,
  collectJsErrors,
  pointerClick,
  waitForFontsReady,
} from "./helpers";
import { generateBigTtc, spawnServeOverFonts } from "./serve";

/**
 * Ticket #34 — local loading is the path+URL model. The typed absolute
 * path (the config seam standing in for the shell's `read_font_path`,
 * which now resolves PATHS only — no bytes) is handed to the serve's
 * POST /local-fonts scan; the returned family documents drive the SAME
 * URL FontFace registration the catalog pick path uses, so a 16-face
 * collection opens with zero font bytes in the page (the browser pulls
 * a face only when something renders in its weight/style slot).
 *
 * The flagship test loads a REAL 16-face one-family collection
 * (fixture scale, always present) by path and pins the byte-free
 * oracle: after the pick, the family's OTHER fifteen faces sit
 * UNLOADED on document.fonts, and repeat-click unload evicts the
 * registration. A second test builds the REAL pipeline ChHsich.ttc
 * (JetBrainsMono NF × an LXGW subset donor) when the dev font pair is
 * present and loads it back the same way — the grafted CJK glyph
 * included.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

/** The font suffixes the typed-path directory sweep admits. */
const FONT_SUFFIXES = [".ttf", ".otf", ".ttc", ".woff", ".woff2"];

/** Run gui/scripts/e2e_fonts.py (the fixture generator) to completion. */
async function runE2eFonts(args: string[]): Promise<void> {
  const python = process.env.FONTALLOY_PYTHON ?? "python";
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(python, [resolve(repoRoot, "gui/scripts/e2e_fonts.py"), ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("error", (err) => rejectRun(new Error(String(err))));
    child.on("close", (code) =>
      code === 0
        ? resolveRun()
        : rejectRun(new Error(`e2e_fonts.py exited ${code}: ${out}`)),
    );
  });
}

/**
 * The real binaries the 16-face fixture builds from: the dev catalog's
 * JetBrainsMono NF cut (the base family) and LXGW WenKai (the donor) —
 * the same directory contract realCatalogFontPaths() pins. Absent on
 * fixture-only machines (the real-pipeline test then skips — the
 * byte-free pins live on the fixture-scale collection below).
 */
function realPairPaths(): { base: string; lxgw: string } | null {
  const candidates = [
    process.env.FONTALLOY_DEV_FONT_DIR,
    resolve(repoRoot, "..", "fontalloy", "gui", "prototype", "fonts"),
    resolve(repoRoot, "gui", "prototype", "fonts"),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  for (const dir of candidates) {
    const base = resolve(dir, "JetBrainsMonoNerdFont-Regular.ttf");
    const lxgw = resolve(dir, "LXGWWenKai-Regular.ttf");
    if (existsSync(base) && existsSync(lxgw)) return { base, lxgw };
  }
  return null;
}

/**
 * The typed-path seam (paths only — the successor shape of the shell's
 * `read_font_path`): a FILE is itself; a DIRECTORY is the font files it
 * holds. No bytes cross the seam; the serve scans the real files.
 */
async function installPathSeam(page: Page): Promise<void> {
  await page.exposeFunction(
    "__fontalloyTestReadFontPath",
    async (
      path: string,
    ): Promise<{ isDirectory: boolean; paths: string[] }> => {
      const info = await stat(path);
      if (info.isFile()) return { isDirectory: false, paths: [path] };
      if (info.isDirectory()) {
        const names = (await readdir(path)).filter((name) =>
          FONT_SUFFIXES.some((suffix) =>
            name.toLowerCase().endsWith(suffix),
          ),
        );
        names.sort();
        return {
          isDirectory: true,
          paths: names.map((name) => resolve(path, name)),
        };
      }
      throw new Error("no such file or directory");
    },
  );
  await page.addInitScript(() => {
    const config = window as unknown as {
      __FONTALLOY_CONFIG__: Record<string, unknown>;
    };
    config.__FONTALLOY_CONFIG__ ??= {};
    config.__FONTALLOY_CONFIG__.readFontPath = async (
      path: string,
    ): Promise<{ isDirectory: boolean; paths: string[] }> =>
      (
        window as unknown as {
          __fontalloyTestReadFontPath: (
            p: string,
          ) => Promise<{ isDirectory: boolean; paths: string[] }>;
        }
      ).__fontalloyTestReadFontPath(path);
  });
}

/** Point the page at a spawned serve (plus the optional pacing seam). */
async function installServe(
  page: Page,
  url: string,
  delayMs?: number,
): Promise<void> {
  await page.addInitScript(
    (serve: string, delay: number | undefined) => {
      const config = window as unknown as {
        __FONTALLOY_CONFIG__: Record<string, unknown>;
      };
      config.__FONTALLOY_CONFIG__ ??= {};
      config.__FONTALLOY_CONFIG__.serveUrl = serve;
      if (delay !== undefined) {
        config.__FONTALLOY_CONFIG__.testFontLoadDelayMs = delay;
      }
    },
    url,
    delayMs,
  );
}

/** Commit one absolute path through the picker's typed-path field. */
async function commitPath(page: Page, popupId: string, path: string): Promise<void> {
  const input = page.locator(`[data-picker-popup="${popupId}"] input[data-role='font-path']`);
  await input.fill(path);
  await input.press("Enter");
}

/**
 * The FontFace API reports a URL-source family re-serialized through
 * the CSS grammar (a spaced family carries literal quotes); the spec's
 * inventory counts normalize them away.
 */
const cssFamilyOf = (name: string): string =>
  name.length > 1 && name.startsWith('"') && name.endsWith('"')
    ? name.slice(1, -1)
    : name;

/** The number of document.fonts faces registered under one css family. */
function faceCountOf(page: Page, family: string): Promise<number> {
  return page.evaluate(
    (fam) =>
      [...document.fonts].filter(
        (face) =>
          (face.family.length > 1 && face.family.startsWith('"') && face.family.endsWith('"')
            ? face.family.slice(1, -1)
            : face.family) === fam,
      ).length,
    family,
  );
}

test.describe("round 20 / ticket 34: local loading by path+URL", () => {
  test.describe.configure({ mode: "serial" });
  const jsErrors: string[] = [];

  test.beforeEach(() => {
    jsErrors.length = 0;
  });

  test.afterEach(() => assertNoJsErrors(jsErrors));

  test("a 16-face collection loads by path as lazy URL faces, unloads, and re-loads", async ({
    page,
  }) => {
    // The fixture: a REAL 16-face one-family collection (the weight ×
    // style matrix, shared tables deduped like the build's own ttc
    // output) — the collection shape the owner loads back into the
    // GUI, at fixture scale. Loaded back by TYPED PATH against the
    // real serve: the scan expands the collection server-side and the
    // faces register as URL FontFaces (no IPC, no page bytes).
    test.setTimeout(120_000);
    const root = await mkdtemp(resolve(tmpdir(), "fontalloy-r34-real-"));
    const fontsDir = resolve(root, "fonts");
    await mkdir(fontsDir, { recursive: true });
    const artifactPath = await generateBigTtc(fontsDir);
    const service = await spawnServeOverFonts(fontsDir);
    const family = "Alloy Wide";
    try {
      // The browser local-load flow: the TYPED PATH against the real
      // serve.
      const faceRequests: string[] = [];
      page.on("request", (request) => {
        if (request.url().includes("/local-fonts/face")) {
          faceRequests.push(request.url());
        }
      });
      collectJsErrors(page, jsErrors);
      await installPathSeam(page);
      await installServe(page, await service.url);
      await page.goto("/");
      await waitForFontsReady(page);
      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      const popup = page.locator('[data-picker-popup="en"]');
      await expect(popup).toBeVisible();
      await commitPath(page, "en", artifactPath);

      // Success: closed picker, no error line (a collection is sixteen
      // faces, not one unloadable file).
      await expect(popup).toBeHidden({ timeout: 60_000 });
      await expect(popup.locator("[data-picker-error]")).toBeHidden();

      // The auto-selected anchor reads the family's own Regular face
      // (the 400-upright representative — the file's first face is
      // Bold; the collapsed round-19 behavior showed exactly that).
      await expect(
        page.locator('[data-role="picker-en"] .kit-hd b'),
      ).toHaveText(family);

      // The byte-free oracle: ONE family, SIXTEEN URL faces — and
      // right after the pick only the RENDERED slots have paid for
      // bytes (the card's regular line and its bold <b> name element
      // load two slots; the other fourteen sit unloaded; a face
      // streams from the serve only when something renders in its
      // slot).
      const lazy = await page.evaluate((fam) => {
        const norm = (name: string): string =>
          name.length > 1 && name.startsWith('"') && name.endsWith('"')
            ? name.slice(1, -1)
            : name;
        const faces = [...document.fonts].filter(
          (face) => norm(face.family) === fam,
        );
        return {
          count: faces.length,
          unloaded: faces.filter((face) => face.status === "unloaded").length,
        };
      }, family);
      expect(lazy.count).toBe(16);
      expect(lazy.unloaded).toBe(14);
      expect(faceRequests.length).toBeLessThanOrEqual(3);

      // Rendering the slots pulls real bytes by URL: the family's
      // Latin coverage and the 700 slot is its own face — the weight
      // matrix the collection carries, not the first face.
      const oracle = await page.evaluate(async (fam) => {
        await document.fonts.load(`16px "${fam}"`);
        await document.fonts.load(`700 16px "${fam}"`);
        return {
          latin: document.fonts.check(`16px "${fam}"`, "A"),
          bold: document.fonts.check(`700 16px "${fam}"`, "A"),
        };
      }, family);
      expect(oracle.latin).toBe(true);
      expect(oracle.bold).toBe(true); // the 700 slot is its own face
      expect(faceRequests.length).toBeGreaterThanOrEqual(1); // bytes by URL

      // ONE local row (the family); the data-only sibling faces never
      // surface as ghost rows.
      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      await expect(popup).toBeVisible();
      await expect(popup.locator(".kit-fp", { hasText: family })).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(popup).toBeHidden();

      // Repeat-click unload EVICTS the URL registration: the family's
      // faces come off document.fonts and the selection returns to the
      // never-picked state.
      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      await expect(popup).toBeVisible();
      await pointerClick(page, popup.locator(".kit-fp", { hasText: family }));
      await expect(popup).toBeHidden();
      await waitForFontsReady(page);
      const evicted = await faceCountOf(page, family);
      expect(evicted).toBe(0);
      await expect(
        page.locator('[data-role="picker-en"] .kit-hd b'),
      ).toHaveText("尚未加载字体");

      // The re-load by path re-registers from scratch and keeps the
      // selection.
      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      await expect(popup).toBeVisible();
      await commitPath(page, "en", artifactPath);
      await expect(popup).toBeHidden({ timeout: 60_000 });
      const reloaded = await faceCountOf(page, family);
      expect(reloaded).toBe(16);
      await expect(
        page.locator('[data-role="picker-en"] .kit-hd b'),
      ).toHaveText(family);
    } finally {
      await service.dispose();
    }
  });

  test("the REAL pipeline ttc loads the same way when the real fonts are present", async ({
    page,
  }) => {
    // The owner's exact artifact: 16 REAL JetBrainsMono faces + a REAL
    // LXGW subset donor, merged by the REAL pipeline into a 16-face
    // ChHsich.ttc, loaded back by path — the grafted CJK glyph renders
    // in the family. Requires the dev font pair (FONTALLOY_DEV_FONT_DIR
    // or the prototype fonts dir); skips on fixture-only machines
    // (fetching real fonts is out of the suite's IO bounds).
    test.setTimeout(300_000);
    const real = realPairPaths();
    test.skip(real === null, "the real font pair is not present");
    const pair = real!;
    const root = await mkdtemp(resolve(tmpdir(), "fontalloy-r34-pipeline-"));
    const fontsDir = resolve(root, "fonts");
    await mkdir(fontsDir, { recursive: true });
    await runE2eFonts([fontsDir, "--nf-family", pair.base]);
    await runE2eFonts([fontsDir, "--subset-donor", pair.lxgw]);
    const regular = resolve(fontsDir, "JetBrainsMonoNerdFont-Regular.ttf");
    const donor = resolve(fontsDir, "LXGWSubset-Regular.ttf");
    const service = await spawnServeOverFonts(fontsDir);
    try {
      // Submit the merge over the serve contract, then take the
      // artifact bytes — the pipeline's own ttc, never a fixture
      // imitation of one.
      const base = await service.url;
      const submit = await fetch(`${base}/builds`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          base: { path: regular, pattern: "JetBrainsMonoNerdFont-*" },
          donors: [donor],
          rules: [{ range: "0x4E00-0x4F9F", fonts: ["donor-0"] }],
          output: { format: "ttc", family: "ChHsich" },
        }),
      });
      expect(submit.status).toBe(202);
      const { id } = (await submit.json()) as { id: string };
      for (;;) {
        const doc = (await (await fetch(`${base}/builds/${id}`)).json()) as {
          status: string;
          error?: string | null;
        };
        if (doc.status === "done") break;
        if (doc.status === "failed") {
          throw new Error(doc.error ?? "the fixture build failed");
        }
        expect(["queued", "running"]).toContain(doc.status);
        await new Promise((r) => setTimeout(r, 500));
      }
      const artifact = await (await fetch(`${base}/builds/${id}/font`)).arrayBuffer();
      expect(new Uint8Array(artifact.slice(0, 4))).toEqual(
        new Uint8Array([0x74, 0x74, 0x63, 0x66]),
      ); // 'ttcf'
      const artifactPath = resolve(root, "ChHsich.ttc");
      await writeFile(artifactPath, Buffer.from(artifact));

      // The browser local-load flow: the TYPED PATH against the real
      // serve — the scan expands the collection server-side and the
      // faces register as URL FontFaces (no IPC, no page bytes).
      const faceRequests: string[] = [];
      page.on("request", (request) => {
        if (request.url().includes("/local-fonts/face")) {
          faceRequests.push(request.url());
        }
      });
      collectJsErrors(page, jsErrors);
      await installPathSeam(page);
      await installServe(page, base);
      await page.goto("/");
      await waitForFontsReady(page);
      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      const popup = page.locator('[data-picker-popup="en"]');
      await expect(popup).toBeVisible();
      await commitPath(page, "en", artifactPath);

      // Success: closed picker, no error line (a collection is sixteen
      // faces, not one unloadable file).
      await expect(popup).toBeHidden({ timeout: 60_000 });
      await expect(popup.locator("[data-picker-error]")).toBeHidden();

      // The auto-selected anchor reads the family's own Regular face
      // (the 400-upright representative — the file's first face is
      // Bold; the collapsed round-19 behavior showed exactly that).
      await expect(
        page.locator('[data-role="picker-en"] .kit-hd b'),
      ).toHaveText("ChHsich");

      // The byte-free oracle: ONE family, SIXTEEN URL faces — and
      // right after the pick only the RENDERED slots have paid for
      // bytes (the card's regular line and its bold <b> name element
      // load two slots; the other fourteen sit unloaded; a face
      // streams from the serve only when something renders in its
      // slot).
      const lazy = await page.evaluate(() => {
        const faces = [...document.fonts].filter(
          (face) => face.family === "ChHsich",
        );
        return {
          count: faces.length,
          unloaded: faces.filter((face) => face.status === "unloaded").length,
        };
      });
      expect(lazy.count).toBe(16);
      expect(lazy.unloaded).toBe(14);
      expect(faceRequests.length).toBeLessThanOrEqual(3);

      // Rendering the slots pulls real bytes by URL: the family's
      // Latin AND the grafted CJK glyph, and the 700 slot is its own
      // face — the weight matrix the pipeline wrote, not the first
      // face.
      const oracle = await page.evaluate(async () => {
        await document.fonts.load('16px "ChHsich"');
        await document.fonts.load('700 16px "ChHsich"');
        return {
          latin: document.fonts.check('16px "ChHsich"', "A"),
          cjk: document.fonts.check('16px "ChHsich"', "\u4e2d"),
          bold: document.fonts.check('700 16px "ChHsich"', "A"),
        };
      });
      expect(oracle.latin).toBe(true);
      expect(oracle.cjk).toBe(true); // the grafted donor glyph, in the family
      expect(oracle.bold).toBe(true); // the 700 slot is its own face
      expect(faceRequests.length).toBeGreaterThanOrEqual(1); // bytes by URL

      // ONE local row (the family); the data-only sibling faces never
      // surface as ghost rows.
      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      await expect(popup).toBeVisible();
      await expect(popup.locator(".kit-fp", { hasText: "ChHsich" })).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(popup).toBeHidden();

      // Repeat-click unload EVICTS the URL registration: the family's
      // faces come off document.fonts and the selection returns to the
      // never-picked state.
      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      await expect(popup).toBeVisible();
      await pointerClick(page, popup.locator(".kit-fp", { hasText: "ChHsich" }));
      await expect(popup).toBeHidden();
      await waitForFontsReady(page);
      const evicted = await page.evaluate(
        () =>
          [...document.fonts].filter((face) => face.family === "ChHsich")
            .length,
      );
      expect(evicted).toBe(0);
      await expect(
        page.locator('[data-role="picker-en"] .kit-hd b'),
      ).toHaveText("尚未加载字体");

      // The re-load by path re-registers from scratch and keeps the
      // selection.
      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      await expect(popup).toBeVisible();
      await commitPath(page, "en", artifactPath);
      await expect(popup).toBeHidden({ timeout: 60_000 });
      const reloaded = await page.evaluate(
        () =>
          [...document.fonts].filter((face) => face.family === "ChHsich")
            .length,
      );
      expect(reloaded).toBe(16);
      await expect(
        page.locator('[data-role="picker-en"] .kit-hd b'),
      ).toHaveText("ChHsich");
    } finally {
      await service.dispose();
    }
  });

  test("loading a path selects it in the hosting slot, replacing the current pick", async ({
    page,
  }) => {
    // Small deterministic pair (no host fonts): base.ttf (AlloyBase) and
    // donor.ttf (AlloyDonor), loaded one after the other through the
    // SAME picker — the second load must TAKE the slot (owner round 20:
    // 从本地加载了肯定就直接选中了), with no scroll-and-click on rows.
    // A same-directory OTHER family never rides along: the pick is the
    // named path, nothing else.
    const dir = await mkdtemp(resolve(tmpdir(), "fontalloy-r34-select-"));
    await runE2eFonts([dir, "--donor-glyphs", "50"]);
    const first = resolve(dir, "base.ttf");
    const second = resolve(dir, "donor.ttf");
    const service = await spawnServeOverFonts(dir);

    collectJsErrors(page, jsErrors);
    await installPathSeam(page);
    await installServe(page, await service.url);
    try {
      await page.goto("/");
      await waitForFontsReady(page);

      const anchor = page.locator('[data-role="picker-en"] .kit-hd b');
      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      const popup = page.locator('[data-picker-popup="en"]');
      await expect(popup).toBeVisible();
      await commitPath(page, "en", first);
      await expect(popup).toBeHidden();
      await expect(anchor).toHaveText("AlloyBase");

      // The pick registered exactly ITS family — the donor sitting in
      // the same directory did not ride along.
      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      await expect(popup).toBeVisible();
      await expect(popup.locator(".kit-fp", { hasText: "AlloyBase" })).toHaveCount(1);
      await expect(popup.locator(".kit-fp", { hasText: "AlloyDonor" })).toHaveCount(0);
      await page.keyboard.press("Escape");

      // The SECOND load through the same picker replaces the pick — the
      // closed card shows the newly loaded family, no row click needed.
      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      await commitPath(page, "en", second);
      await expect(popup).toBeHidden();
      await expect(anchor).toHaveText("AlloyDonor");
      await expect(
        page.locator("[data-role='font-pair'] [data-pair='base']"),
      ).toHaveText("AlloyDonor");

      // The OTHER slot keeps its own pick: loading through the CJK picker
      // selects only the CJK slot.
      await pointerClick(page, page.locator('[data-role="picker-cjk"] .kit-hd'));
      await expect(page.locator('[data-picker-popup="cjk"]')).toBeVisible();
      await commitPath(page, "cjk", first);
      await expect(page.locator('[data-picker-popup="cjk"]')).toBeHidden();
      await expect(anchor).toHaveText("AlloyDonor");
      await expect(page.locator('[data-role="picker-cjk"] .kit-hd b')).toHaveText(
        "AlloyBase",
      );
    } finally {
      await service.dispose();
    }
  });

  test("the typed-path fallback loads a file path and a directory path through the config seam", async ({
    page,
  }) => {
    // The Tauri-only fallback, driven through the same config bootstrap
    // the save flows test through: a typed ABSOLUTE path resolves (the
    // seam stands in for the shell's read_font_path — paths only), file
    // or directory, and funnels into the same scan+register+select flow.
    const dir = await mkdtemp(resolve(tmpdir(), "fontalloy-r34-path-"));
    await runE2eFonts([dir, "--donor-glyphs", "50"]);
    const familyDir = resolve(dir, "family");
    await mkdir(familyDir);
    await runE2eFonts([
      familyDir,
      "--family",
      "--family-name",
      "Alloy Path",
      "--family-stem",
      "AlloyPath",
    ]);
    const service = await spawnServeOverFonts(dir);

    collectJsErrors(page, jsErrors);
    await installPathSeam(page);
    await installServe(page, await service.url);
    try {
      await page.goto("/");
      await waitForFontsReady(page);
      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      const popup = page.locator('[data-picker-popup="en"]');
      await expect(popup).toBeVisible();
      const pathInput = popup.locator("input[data-role='font-path']");
      await expect(pathInput).toBeVisible();

      // A FILE path: loads and selects (the slot was empty).
      await pathInput.fill(resolve(dir, "base.ttf"));
      await pathInput.press("Enter");
      await expect(popup).toBeHidden();
      await expect(page.locator('[data-role="picker-en"] .kit-hd b')).toHaveText(
        "AlloyBase",
      );

      // A DIRECTORY path: every font file in it loads (the scan pools
      // the family's whole three-face matrix server-side), the first
      // family takes the slot, and ONE row lists the family.
      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      await expect(popup).toBeVisible();
      await pathInput.fill(familyDir);
      await pathInput.press("Enter");
      await expect(popup).toBeHidden();
      await expect(page.locator('[data-role="picker-en"] .kit-hd b')).toHaveText(
        "Alloy Path",
      );
      const familyFaces = await faceCountOf(page, "Alloy Path");
      expect(familyFaces).toBe(3);
      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      await expect(popup.locator(".kit-fp", { hasText: "Alloy Path" })).toHaveCount(1);
      await page.keyboard.press("Escape");

      // A path that does not exist: the picker STAYS OPEN and its error
      // line names the path (no dialog was ever needed).
      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      await expect(popup).toBeVisible();
      await pathInput.fill(resolve(dir, "nowhere.ttf"));
      await pathInput.press("Enter");
      const error = popup.locator("[data-picker-error]");
      await expect(error).toBeVisible();
      expect((await error.textContent()) ?? "").toContain("nowhere.ttf");
    } finally {
      await service.dispose();
    }
  });

  test("a 16-face collection loads asynchronously: inline count indicator, live workspace, one outcome card", async ({
    page,
  }) => {
    // Round 21, owner item 2 (ticket #34 shape): the registration
    // yields to the event loop between faces (the config seam slows
    // each step deterministically), the load action itself carries the
    // inline spinner + count («正在加载 3/16», anchored in the picker
    // footer — never a blocking overlay), the workspace answers input
    // DURING the load, and completion posts ONE stats card (家族 N ·
    // 字形 M).
    const dir = await mkdtemp(resolve(tmpdir(), "fontalloy-r34-async-"));
    const bigTtc = await generateBigTtc(dir);
    const service = await spawnServeOverFonts(dir);
    // The same config bootstrap every seam rides: a per-face delay that
    // makes the 16-face load observable mid-flight, deterministically.
    await page.addInitScript(() => {
      (window as unknown as { __FONTALLOY_CONFIG__: Record<string, unknown> })
        .__FONTALLOY_CONFIG__ = { testFontLoadDelayMs: 120 };
    });

    collectJsErrors(page, jsErrors);
    await installPathSeam(page);
    await installServe(page, await service.url);
    try {
      await page.goto("/");
      await waitForFontsReady(page);
      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      const popup = page.locator('[data-picker-popup="en"]');
      await expect(popup).toBeVisible();
      await commitPath(page, "en", bigTtc);

      // The indicator rides the footer's load action with a live count.
      const indicator = popup.locator("[data-picker-load]");
      await expect(indicator).toBeVisible();
      await expect(indicator).toHaveText(/正在加载\s*\d+\/16/);

      // The workspace answers input WHILE the load runs: a category chip
      // click lands and takes effect mid-load — the load never owns the
      // main thread between its yields.
      const chip = page.locator(".kit-catbar .kit-cat-g[data-group]").nth(1);
      await pointerClick(page, chip);
      await expect(chip).toHaveClass(/on/);
      await expect(indicator).toBeVisible(); // the load is still running

      // Completion: the indicator leaves, the pick took the family, and
      // ONE outcome card states the stats.
      await expect(indicator).toBeHidden({ timeout: 30_000 });
      await expect(popup).toBeHidden();
      await expect(page.locator('[data-role="picker-en"] .kit-hd b')).toHaveText(
        "Alloy Wide",
      );
      const card = page.locator("[data-role='message']").last();
      await expect(card).toBeVisible();
      await expect(card.locator("[data-role='message-stats']")).toContainText(
        "家族",
      );
      await expect(card.locator("[data-role='message-stats']")).toContainText(
        "字形",
      );
    } finally {
      await service.dispose();
    }
  });

  test("the path input's placeholder stays whole and the field never grows on focus", async ({
    page,
  }) => {
    // Round 21, owner item 3; round 22 fix: the footer's typed-path
    // fallback is a FIXED-width field — the short placeholder never
    // clips at rest, and focusing must NOT change its width (the
    // round-21 focus expansion pushed the field's right edge past the
    // visible row). The full value rides the title tooltip; Enter
    // still commits (the path test above pins that).
    await page.addInitScript(() => {
      (window as unknown as { __FONTALLOY_CONFIG__: Record<string, unknown> })
        .__FONTALLOY_CONFIG__ = {
        readFontPath: async () => ({ isDirectory: false, paths: [] }),
      };
    });

    collectJsErrors(page, jsErrors);
    await page.goto("/");
    await waitForFontsReady(page);
    await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
    const popup = page.locator('[data-picker-popup="en"]');
    const pathInput = popup.locator("input[data-role='font-path']");
    await expect(pathInput).toBeVisible();
    await expect(pathInput).toHaveAttribute("placeholder", "或输入路径");

    // The placeholder is fully visible at rest: nothing scrolls.
    const geometry = () =>
      pathInput.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        width: el.getBoundingClientRect().width,
      }));
    const rest = await geometry();
    expect(rest.scrollWidth).toBeLessThanOrEqual(rest.clientWidth + 1);

    // Focus keeps the field's geometry EXACTLY (round 22: the field
    // lives inside the popup's footer row — any growth overflows the
    // visible row to the right).
    await pathInput.focus();
    await expect
      .poll(async () => (await geometry()).width)
      .toBe(rest.width);

    // The full value rides the title tooltip, verbatim.
    const longPath = "C:\\Users\\owner\\Downloads\\NotoSansSC[wght].ttf";
    await pathInput.fill(longPath);
    await expect(pathInput).toHaveAttribute("title", longPath);
  });
});
