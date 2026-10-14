import { test, expect } from "@playwright/test";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoJsErrors,
  collectJsErrors,
  pointerClick,
  waitForFontsReady,
} from "./helpers";
import { spawnServeOverFonts } from "./serve";

/**
 * Round 20, owner item 3 — local loading works for real. The round-19
 * extraction was proven only against a fixture whose three faces carry
 * three DISTINCT family names; the owner's real pipeline output (a
 * 16-face ChHsich.ttc — one family, sixteen weights) collapsed onto
 * ONE face, because the registry keyed registrations by the name-table
 * family. The flagship test builds the REAL 16-face collection through
 * the REAL `fontalloy serve` pipeline (the synthesize.spec pattern:
 * JetBrainsMono-family faces × an LXGW donor, format ttc) and drives
 * the browser local-file flow with those exact bytes.
 *
 * The same file pins round 20's other two behaviors: loading a local
 * file SELECTS it immediately in the hosting slot (replacing the
 * current pick), and the two file-manager-free entry points — the
 * typed absolute path (Tauri; driven here through the config seam) and
 * drag-and-drop onto the window — funnel into the same register+select
 * flow.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

/** The font suffixes the directory sweep loads. */
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
 * the same directory contract realCatalogFontPaths() pins.
 */
function realPairPaths(): { base: string; lxgw: string } {
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
  throw new Error(
    "the real fonts were not found (JetBrainsMonoNerdFont-Regular.ttf + "
      + "LXGWWenKai-Regular.ttf) — set FONTALLOY_DEV_FONT_DIR",
  );
}

test.describe("round 20: local loading", () => {
  test.describe.configure({ mode: "serial" });
  const jsErrors: string[] = [];

  test.beforeEach(() => {
    jsErrors.length = 0;
  });

  test.afterEach(() => assertNoJsErrors(jsErrors));

  test("the REAL 16-face pipeline ttc registers every face and selects its representative", async ({
    page,
  }) => {
    // The fixture: 16 REAL JetBrainsMono faces (weight × style, one
    // family) + a REAL LXGW subset donor, merged by the REAL pipeline
    // into a 16-face ChHsich.ttc — the exact artifact shape the owner
    // loads back into the GUI. ~40s build on this class of machine.
    test.setTimeout(300_000);
    const real = realPairPaths();
    const root = await mkdtemp(resolve(tmpdir(), "fontalloy-r20-real-"));
    const fontsDir = resolve(root, "fonts");
    await mkdir(fontsDir, { recursive: true });
    await runE2eFonts([fontsDir, "--nf-family", real.base]);
    await runE2eFonts([fontsDir, "--subset-donor", real.lxgw]);
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

      // The browser local-file flow with the REAL pipeline bytes.
      collectJsErrors(page, jsErrors);
      await page.goto("/");
      await waitForFontsReady(page);
      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      const popup = page.locator('[data-picker-popup="en"]');
      await expect(popup).toBeVisible();
      await page.locator("input[data-role='font-file']").setInputFiles(artifactPath);

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

      // The oracle: ONE family, SIXTEEN faces — the weight matrix the
      // pipeline wrote, not the first face.
      const oracle = await page.evaluate(async () => {
        await document.fonts.load('16px "ChHsich"');
        const faces = [...document.fonts].filter(
          (face) => face.family === "ChHsich",
        );
        return {
          count: faces.length,
          loaded: faces.filter((face) => face.status === "loaded").length,
          latin: document.fonts.check('16px "ChHsich"', "A"),
          cjk: document.fonts.check('16px "ChHsich"', "\u4e2d"),
          bold: document.fonts.check('700 16px "ChHsich"', "A"),
        };
      });
      expect(oracle.count).toBe(16);
      expect(oracle.loaded).toBe(16);
      expect(oracle.latin).toBe(true);
      expect(oracle.cjk).toBe(true); // the grafted donor glyph, in the family
      expect(oracle.bold).toBe(true); // the 700 slot is its own face

      // ONE local row (the family); the data-only sibling faces never
      // surface as ghost rows.
      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      await expect(popup).toBeVisible();
      await expect(popup.locator(".kit-fp", { hasText: "ChHsich" })).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(popup).toBeHidden();

      // The sweep never re-registers the collection as one more face:
      // after it settles, the family still holds exactly sixteen.
      await page.waitForTimeout(700);
      const settled = await page.evaluate(
        () =>
          [...document.fonts].filter((face) => face.family === "ChHsich")
            .length,
      );
      expect(settled).toBe(16);

      // Idempotent re-load: the same file again registers nothing new
      // and keeps the selection.
      await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
      await page.locator("input[data-role='font-file']").setInputFiles(artifactPath);
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

  test("loading a local file selects it in the hosting slot, replacing the current pick", async ({
    page,
  }) => {
    // Small deterministic pair (no host fonts): base.ttf (AlloyBase) and
    // donor.ttf (AlloyDonor), loaded one after the other through the
    // SAME picker — the second load must TAKE the slot (owner round 20:
    // 从本地加载了肯定就直接选中了), with no scroll-and-click on rows.
    const dir = await mkdtemp(resolve(tmpdir(), "fontalloy-r20-select-"));
    await runE2eFonts([dir, "--donor-glyphs", "50"]);
    const first = resolve(dir, "base.ttf");
    const second = resolve(dir, "donor.ttf");

    collectJsErrors(page, jsErrors);
    await page.goto("/");
    await waitForFontsReady(page);

    const anchor = page.locator('[data-role="picker-en"] .kit-hd b');
    await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
    const popup = page.locator('[data-picker-popup="en"]');
    await expect(popup).toBeVisible();
    await page.locator("input[data-role='font-file']").setInputFiles(first);
    await expect(popup).toBeHidden();
    await expect(anchor).toHaveText("AlloyBase");

    // The SECOND load through the same picker replaces the pick — the
    // closed card shows the newly loaded family, no row click needed.
    await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
    await page.locator("input[data-role='font-file']").setInputFiles(second);
    await expect(popup).toBeHidden();
    await expect(anchor).toHaveText("AlloyDonor");
    await expect(
      page.locator("[data-role='font-pair'] [data-pair='base']"),
    ).toHaveText("AlloyDonor");

    // The OTHER slot keeps its own pick: loading through the CJK picker
    // selects only the CJK slot.
    await pointerClick(page, page.locator('[data-role="picker-cjk"] .kit-hd'));
    await page.locator("input[data-role='font-file']").setInputFiles(first);
    await expect(page.locator('[data-picker-popup="cjk"]')).toBeHidden();
    await expect(anchor).toHaveText("AlloyDonor");
    await expect(page.locator('[data-role="picker-cjk"] .kit-hd b')).toHaveText(
      "AlloyBase",
    );
  });

  test("the typed-path fallback loads a file path and a directory path through the config seam", async ({
    page,
  }) => {
    // The Tauri-only fallback, driven through the same config bootstrap
    // the save flows test through: a typed ABSOLUTE path resolves (the
    // seam stands in for the shell's read_font_path), file or
    // directory, and funnels into the register+select flow.
    const dir = await mkdtemp(resolve(tmpdir(), "fontalloy-r20-path-"));
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

    await page.exposeFunction(
      "__fontalloyTestReadFontPath",
      async (
        path: string,
      ): Promise<{
        isDirectory: boolean;
        files: Array<{ fileName: string; path: string; b64: string }>;
      }> => {
        const info = await stat(path);
        const readOne = async (file: string) => ({
          fileName: basename(file),
          path: file,
          b64: (await readFile(file)).toString("base64"),
        });
        if (info.isFile()) {
          return { isDirectory: false, files: [await readOne(path)] };
        }
        if (info.isDirectory()) {
          const names = (await readdir(path)).filter((name) =>
            FONT_SUFFIXES.some((suffix) =>
              name.toLowerCase().endsWith(suffix),
            ),
          );
          names.sort();
          return {
            isDirectory: true,
            files: await Promise.all(
              names.map((n) => readOne(resolve(path, n))),
            ),
          };
        }
        throw new Error("no such file or directory");
      },
    );
    await page.addInitScript(() => {
      const config = window as unknown as {
        __FONTALLOY_CONFIG__: Record<string, unknown>;
      };
      config.__FONTALLOY_CONFIG__ = {
        readFontPath: async (
          path: string,
        ): Promise<{
          isDirectory: boolean;
          files: Array<{ fileName: string; buffer: ArrayBuffer; path: string }>;
        }> => {
          const result = await (
            window as unknown as {
              __fontalloyTestReadFontPath: (
                p: string,
              ) => Promise<{
                isDirectory: boolean;
                files: Array<{ fileName: string; path: string; b64: string }>;
              }>;
            }
          ).__fontalloyTestReadFontPath(path);
          const toBuffer = (b64: string): ArrayBuffer => {
            const binary = atob(b64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
              bytes[i] = binary.charCodeAt(i);
            }
            return bytes.buffer;
          };
          return {
            isDirectory: result.isDirectory,
            files: result.files.map((f) => ({
              fileName: f.fileName,
              path: f.path,
              buffer: toBuffer(f.b64),
            })),
          };
        },
      };
    });

    collectJsErrors(page, jsErrors);
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

    // A DIRECTORY path: every font file in it loads (the sweep
    // semantics — the family's whole three-face matrix), the first
    // family takes the slot, and ONE row lists the family.
    await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
    await expect(popup).toBeVisible();
    await pathInput.fill(familyDir);
    await pathInput.press("Enter");
    await expect(popup).toBeHidden();
    await expect(page.locator('[data-role="picker-en"] .kit-hd b')).toHaveText(
      "Alloy Path",
    );
    const familyFaces = await page.evaluate(
      () =>
        [...document.fonts].filter((face) => face.family === "Alloy Path")
          .length,
    );
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
  });

  test("dropping font files on the window loads them and selects them in the last-used slot", async ({
    page,
  }) => {
    // Drag-and-drop (round 20, owner item 3b): a real DataTransfer drop
    // on the document loads the files — the same register+select flow,
    // landing in the slot the user last used. (Under Tauri the wry
    // webview intercepts drops before the DOM; the shell re-emits them
    // as tauri://drag-drop paths, wired to this same handler in
    // picker.ts — the browser-side seam here exercises the shared
    // flow.)
    const dir = await mkdtemp(resolve(tmpdir(), "fontalloy-r20-drop-"));
    await runE2eFonts([dir, "--donor-glyphs", "50"]);
    const donorB64 = (await readFile(resolve(dir, "donor.ttf"))).toString("base64");
    const baseB64 = (await readFile(resolve(dir, "base.ttf"))).toString("base64");

    collectJsErrors(page, jsErrors);
    await page.goto("/");
    await waitForFontsReady(page);

    // The EN picker was the last used slot: the drop lands there.
    await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
    const popup = page.locator('[data-picker-popup="en"]');
    await expect(popup).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popup).toBeHidden();

    await page.evaluate((payload) => {
      const binary = atob(payload.b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], payload.name));
      document.dispatchEvent(
        new DragEvent("dragover", { bubbles: true, cancelable: true }),
      );
      document.dispatchEvent(
        new DragEvent("drop", {
          dataTransfer: transfer,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, { name: "donor.ttf", b64: donorB64 });

    await expect(page.locator('[data-role="picker-en"] .kit-hd b')).toHaveText(
      "AlloyDonor",
    );
    const enOracle = await page.evaluate(() => ({
      faces: [...document.fonts].filter((f) => f.family === "AlloyDonor").length,
      check: document.fonts.check('16px "AlloyDonor"'),
    }));
    expect(enOracle.faces).toBe(1);
    expect(enOracle.check).toBe(true);

    // The CJK slot takes over as the last-used slot: the next drop
    // selects THERE, leaving the EN pick untouched.
    await pointerClick(page, page.locator('[data-role="picker-cjk"] .kit-hd'));
    await expect(page.locator('[data-picker-popup="cjk"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await page.evaluate((payload) => {
      const binary = atob(payload.b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], payload.name));
      document.dispatchEvent(
        new DragEvent("drop", {
          dataTransfer: transfer,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, { name: "base.ttf", b64: baseB64 });
    await expect(page.locator('[data-role="picker-cjk"] .kit-hd b')).toHaveText(
      "AlloyBase",
    );
    await expect(page.locator('[data-role="picker-en"] .kit-hd b')).toHaveText(
      "AlloyDonor",
    );
  });
});
