import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import {
  expandLocalFontEntries,
  extractCollectionFaces,
  isFontCollection,
} from "../src/fonts/ttc";
import { parseFontMeta } from "../src/fonts/sfnt";
import {
  assertNoJsErrors,
  collectJsErrors,
  pointerClick,
  waitForFontsReady,
} from "./helpers";
import { generateTtc } from "./serve";

/**
 * Round 19, owner item 3: the local-load flow must load COLLECTIONS
 * (.ttc/.otc) — every face as its own font. The fixture is a REAL
 * fontTools-built three-face collection (the first two faces' identical
 * tables deduped into the shared region exactly like the build
 * pipeline's own ttc output); the unit level proves each extracted
 * face is a standalone font fontTools re-parses with a spec-correct
 * whole-file checksum, and that the browser's font sanitizer (the
 * FontFace load) accepts it — the OTS-equivalent acceptance gate.
 */

const FACE_FAMILIES = ["Alloy TTC One", "Alloy TTC Two", "Alloy TTC CJK"];
/** The rows' display names (round 9: the name table's own words). */
const FACE_DISPLAYS = ["Alloy TTC One", "Alloy TTC Two Bold", "Alloy TTC CJK"];

/** The shared fixture (one generation per worker process). */
let fixture: { dir: string; path: string } | null = null;
async function ttcFixture(): Promise<{ dir: string; path: string }> {
  if (fixture === null) {
    const dir = await mkdtemp(resolve(tmpdir(), "fontalloy-ttc-"));
    fixture = { dir, path: await generateTtc(dir) };
  }
  return fixture;
}

async function readTtcBytes(path: string): Promise<ArrayBuffer> {
  const bytes = await readFile(path);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

/**
 * fontTools as the independent oracle: every face file must re-parse,
 * under its own family name, with the spec's whole-file checksum
 * (0xB1B0AFBA — the checkSumAdjustment contract).
 */
function fontToolsReport(paths: string[]): Promise<string> {
  const script = [
    "import struct, sys",
    "from fontTools.ttLib import TTFont",
    "def whole_sum(data):",
    "    data = data + b'\\0' * (-len(data) % 4)",
    "    return sum(struct.unpack(f'>{len(data) // 4}I', data)) & 0xFFFFFFFF",
    "for path in sys.argv[1:]:",
    "    font = TTFont(path)",
    "    name = font['name'].getDebugName(1)",
    "    with open(path, 'rb') as handle:",
    "        checksum = whole_sum(handle.read())",
    "    print(f'{name}\\t{len(font.getGlyphOrder())}\\t{checksum:08x}')",
  ].join("\n");
  return new Promise((resolvePromise, rejectPromise) => {
    const python = process.env.FONTALLOY_PYTHON ?? "python";
    const child = spawn(python, ["-c", script, ...paths], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", (err2) => rejectPromise(new Error(String(err2))));
    child.on("close", (code) =>
      code === 0
        ? resolvePromise(out)
        : rejectPromise(new Error(`fontTools exited ${code}: ${err}`)),
    );
  });
}

test.describe("collection extraction (unit)", () => {
  test("every face of a fontTools ttc reassembles standalone and parses in fontTools again", async () => {
    const { dir, path } = await ttcFixture();
    const bytes = await readTtcBytes(path);

    expect(isFontCollection(bytes)).toBe(true);
    const faces = extractCollectionFaces(bytes);
    expect(faces.map((face) => face.index)).toEqual([1, 2, 3]);
    expect(faces.map((face) => face.tag)).toEqual(["1.0", "1.0", "1.0"]);
    // Each face's own name table names it (shared tables and all).
    expect(faces.map((face) => parseFontMeta(face.buffer).family)).toEqual(
      FACE_FAMILIES,
    );
    // A non-collection buffer passes the recognizer as false.
    expect(isFontCollection(faces[0]!.buffer)).toBe(false);

    const facePaths = await Promise.all(
      faces.map(async (face, i) => {
        const target = resolve(dir, `extracted-face-${i + 1}.ttf`);
        await writeFile(target, Buffer.from(face.buffer));
        return target;
      }),
    );
    const lines = (await fontToolsReport(facePaths)).trim().split(/\r?\n/);
    expect(lines).toHaveLength(3);
    lines.forEach((line, i) => {
      const [family, glyphs, checksum] = line.split("\t");
      expect(family).toBe(FACE_FAMILIES[i]);
      expect(Number(glyphs)).toBeGreaterThan(1);
      expect(checksum).toBe("b1b0afba");
    });
  });

  test("each extracted face loads through FontFace in the page (the sanitizer gate)", async ({ page }) => {
    const { path } = await ttcFixture();
    const faces = extractCollectionFaces(await readTtcBytes(path));
    const payload = faces.map((face) => ({
      family: parseFontMeta(face.buffer).family,
      b64: Buffer.from(face.buffer).toString("base64"),
    }));

    const verdicts = await page.evaluate(async (items) => {
      const results: string[] = [];
      for (const item of items) {
        const binary = atob(item.b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        const face = new FontFace(`ttc-acceptance ${item.family}`, bytes.buffer);
        try {
          await face.load();
          results.push(`${item.family}:ok`);
        } catch (err) {
          results.push(`${item.family}:FAIL:${(err as Error).message}`);
        }
      }
      return results;
    }, payload);

    expect(verdicts).toEqual([
      "Alloy TTC One:ok",
      "Alloy TTC Two:ok",
      "Alloy TTC CJK:ok",
    ]);
  });

  test("a malformed face is named and never kills its siblings", async () => {
    const { path } = await ttcFixture();
    const corrupted = Buffer.from(await readFile(path));
    // Face #2's offset in the ttcf header (offsets start at byte 12)
    // pushed outside the file: face 2 is unreadable, 1 and 3 stay fine.
    corrupted.writeUInt32BE(0x7fff0000, 16);
    const buffer = corrupted.buffer.slice(
      corrupted.byteOffset,
      corrupted.byteOffset + corrupted.byteLength,
    ) as ArrayBuffer;

    // The strict extractor names the face it died on.
    expect(() => extractCollectionFaces(buffer)).toThrow(/face #2/);

    // The load path's per-face expansion keeps the siblings.
    const entries = expandLocalFontEntries([
      { buffer, fileName: "Broken.ttc" },
    ]);
    expect(entries.map((entry) => entry.fileName)).toEqual([
      "Broken.ttc#1",
      "Broken.ttc#2",
      "Broken.ttc#3",
    ]);
    expect(entries[0]!.buffer).toBeDefined();
    expect(entries[1]!.buffer).toBeUndefined();
    expect(entries[1]!.error ?? "").not.toBe("");
    expect(entries[2]!.buffer).toBeDefined();

    // The single-font path is unchanged: a non-collection passes through.
    const plain = extractCollectionFaces(await readTtcBytes(path))[0]!;
    const passthrough = expandLocalFontEntries([
      { buffer: plain.buffer, fileName: "plain.ttf" },
    ]);
    expect(passthrough).toEqual([
      { fileName: "plain.ttf", buffer: plain.buffer, path: undefined },
    ]);
  });
});

test.describe("local collection loading (flow)", () => {
  const jsErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    jsErrors.length = 0;
    collectJsErrors(page, jsErrors);
    await page.goto("/");
    await waitForFontsReady(page);
  });

  test.afterEach(() => assertNoJsErrors(jsErrors));

  test("every face of a picked .ttc registers, lists and renders", async ({
    page,
  }) => {
    const { path } = await ttcFixture();

    await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
    const popup = page.locator('[data-picker-popup="en"]');
    await expect(popup).toBeVisible();
    await page.locator("input[data-role='font-file']").setInputFiles(path);

    // A successful load closes the picker (prototype parity); no error
    // line — the collection is not one unloadable file but three faces.
    await expect(popup).toBeHidden();
    await expect(popup.locator("[data-picker-error]")).toBeHidden();

    // Reopen: one row per face, each named by its OWN name table.
    await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
    const rows = popup.locator(".kit-fp");
    await expect(rows).toHaveCount(3);
    for (let i = 0; i < 3; i++) {
      await expect(rows.nth(i).locator(".kit-nm")).toHaveText(
        FACE_DISPLAYS[i]!,
      );
    }

    // The anchor shows the auto-selected first face, in its own face.
    await expect(
      page.locator('[data-role="picker-en"] .kit-hd b'),
    ).toHaveText(FACE_FAMILIES[0]!);

    // Independent oracle: the browser font subsystem holds ONE loaded
    // FontFace per collection face, under its own name-table family
    // (check() alone is not enough — it reads vacuously true for a
    // family with no registered face and falls through to system fonts
    // for uncovered text, so the positive checks ride on the count).
    const oracle = await page.evaluate((families) => {
      const loaded = families.filter((family) =>
        Array.from(document.fonts).some(
          (face) => face.family === family && face.status === "loaded",
        ),
      );
      return {
        loaded,
        latin: document.fonts.check(`16px "${families[0]}"`, "A"),
        cjk: document.fonts.check(`16px "${families[2]}"`, "\u4e00"),
      };
    }, FACE_FAMILIES);
    expect(oracle.loaded).toEqual(FACE_FAMILIES);
    expect(oracle.latin).toBe(true);
    expect(oracle.cjk).toBe(true);

    // The grid renders U+0041 in the selected base's own face.
    const cellFont = await page
      .locator(".charmap-grid .kit-cell[data-cp='U+0041']")
      .evaluate((el) => getComputedStyle(el).fontFamily);
    expect(cellFont).toContain(FACE_FAMILIES[0]!);
    await expect(page.locator("[data-stat='en']")).not.toHaveText("0");
  });

  test("a malformed face reports its own name and the other faces still load", async ({
    page,
  }) => {
    const { path } = await ttcFixture();
    const corrupted = Buffer.from(await readFile(path));
    corrupted.writeUInt32BE(0x7fff0000, 16);

    await pointerClick(page, page.locator('[data-role="picker-en"] .kit-hd'));
    const popup = page.locator('[data-picker-popup="en"]');
    await page.locator("input[data-role='font-file']").setInputFiles({
      name: "Broken.ttc",
      mimeType: "font/collection",
      buffer: corrupted,
    });

    // The failure keeps the picker open; the error line names THE FACE.
    const error = popup.locator("[data-picker-error]");
    await expect(error).toBeVisible();
    expect((await error.textContent()) ?? "").toContain("Broken.ttc#2");

    // Faces 1 and 3 loaded regardless — the file did not die as one.
    const rows = popup.locator(".kit-fp");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).locator(".kit-nm")).toHaveText(FACE_DISPLAYS[0]!);
    await expect(rows.nth(1).locator(".kit-nm")).toHaveText(FACE_DISPLAYS[2]!);
  });
});
