// Round 29 permanent loop: a base whose release carries style
// side-cuts (Oblique faces with sheared glyphs but upright flags —
// all under one umbrella typographic family) must merge to ONE face
// per (weight, style) slot. The owner report this pins: after merging
// AnnotationMono x Xiaolai and loading the output, REGULAR text and
// the picker's own font-name row rendered ITALIC — the output carried
// two faces on the 400-upright slot, one of them the Oblique file's
// sheared ink, and the browser's slot match handed normal text the
// slanted face.
//
// Real bytes throughout: AnnotationMNerdFont's Regular/Italic/
// RegularOblique (the side-cut layout) + Xiaolai as the CJK donor,
// built by a real serve, loaded through the real picker file-input
// path, asserted on document.fonts + canvas ink (canvas ignores CSS
// font-synthesis — it draws the font's own glyphs, so a sheared
// upright slot shows up as measured slant).
import { test, expect } from "@playwright/test";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pointerClick, waitForFontsReady } from "./helpers";
import { spawnServeOverFonts } from "./serve";

const APP = String.raw`C:\Users\Administrator\AppData\Roaming\io.github.chhsiching.fontalloy\catalog\families`;

test.setTimeout(420_000);

test("style parity: an oblique side-cut base merges one face per slot", async ({
  page,
}) => {
  const dir = await mkdtemp(resolve(tmpdir(), "fontalloy-style-"));
  const cut = resolve(dir, "AnnotationMono");
  await mkdir(cut, { recursive: true });
  await cp(
    resolve(APP, "AnnotationMono", "AnnotationMNerdFont-Regular.ttf"),
    resolve(cut, "AnnotationMNerdFont-Regular.ttf"),
  );
  await cp(
    resolve(APP, "AnnotationMono", "AnnotationMNerdFont-Italic.ttf"),
    resolve(cut, "AnnotationMNerdFont-Italic.ttf"),
  );
  await cp(
    resolve(APP, "AnnotationMono", "AnnotationMNerdFont-RegularOblique.ttf"),
    resolve(cut, "AnnotationMNerdFont-RegularOblique.ttf"),
  );
  const donor = resolve(dir, "Xiaolai-Regular.ttf");
  await cp(resolve(APP, "Xiaolai", "Xiaolai-Regular.ttf"), donor);
  const service = await spawnServeOverFonts(dir);
  const serviceUrl = await service.url;

  // The build: the family-cut pattern pools the three styles exactly
  // like the picker's recipe does.
  const submitted = await fetch(`${serviceUrl}/builds`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      base: {
        path: resolve(cut, "AnnotationMNerdFont-Regular.ttf"),
        pattern: "AnnotationMNerdFont-*.ttf",
      },
      donors: [{ path: donor }],
      output: { family: "styleparity", format: "ttc" },
    }),
  });
  expect(submitted.status).toBe(202);
  const { href } = (await submitted.json()) as { href: string };
  let build: Record<string, unknown> = {};
  for (let i = 0; i < 400; i++) {
    await page.waitForTimeout(1000);
    const doc = (await (await fetch(`${serviceUrl}${href}`)).json()) as Record<
      string,
      unknown
    >;
    build = doc;
    if (String(doc.status) !== "running" && String(doc.status) !== "queued") break;
  }
  expect(build.status, JSON.stringify(build)).toBe("done");

  // Server-side truth: one face per slot, the side-cut drop stated.
  const report = (await (await fetch(`${serviceUrl}${href}/report`)).json()) as {
    output: {
      faces: { weight: number; subfamily: string }[];
      skipped_faces: { subfamily: string; reason: string }[];
    };
  };
  const faceStyles = report.output.faces.map((face) => [
    face.weight,
    face.subfamily,
  ]);
  expect(faceStyles).toEqual(
    expect.arrayContaining([
      [400, expect.any(String)],
      [400, expect.any(String)],
    ]),
  );
  expect(report.output.faces).toHaveLength(2);
  expect(report.output.skipped_faces.map((skip) => skip.subfamily)).toEqual([
    "Regular Oblique",
  ]);

  const fontResponse = await fetch(`${serviceUrl}${href}/font`);
  const artifact = resolve(dir, "styleparity.ttc");
  await writeFile(artifact, Buffer.from(await fontResponse.arrayBuffer()));

  // The owner's flow: load the merged output through the picker.
  await page.goto("/");
  await waitForFontsReady(page);
  await pointerClick(page, page.locator('[data-role="picker-cjk"] .kit-hd'));
  await expect(page.locator('[data-picker-popup="cjk"]')).toBeVisible();
  await page.locator("input[data-role='font-file']").setInputFiles(artifact);
  await waitForFontsReady(page);
  await page.waitForTimeout(2500);

  const probe = await page.evaluate(() => {
    const family = [...document.fonts]
      .map((f) => f.family)
      .find((f) => f === "styleparity");
    const faces = [...document.fonts]
      .filter((f) => f.family === family)
      .map((f) => `${f.weight}/${f.style}`);
    const slant = (text: string, font: string): number | null => {
      const W = 300;
      const H = 140;
      const c = document.createElement("canvas");
      c.width = W;
      c.height = H;
      const ctx = c.getContext("2d", { willReadFrequently: true })!;
      ctx.font = font;
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = "#000";
      ctx.fillText(text, 40, 110);
      const data = ctx.getImageData(0, 0, W, H).data;
      const rows: [number, number][] = [];
      for (let y = 0; y < H; y++) {
        let min = -1;
        let max = -1;
        for (let x = 0; x < W; x++) {
          if (data[(y * W + x) * 4 + 3]! > 40) {
            if (min < 0) min = x;
            max = x;
          }
        }
        if (min >= 0) rows.push([min, max]);
      }
      if (rows.length < 40) return null;
      const band = (from: number, to: number): number => {
        let sum = 0;
        let n = 0;
        for (let i = from; i < to; i++) {
          sum += (rows[i]![0] + rows[i]![1]) / 2;
          n++;
        }
        return sum / n;
      };
      const n = rows.length;
      return Math.round((band(n - 10, n - 2) - band(2, 10)) * 10) / 10;
    };
    return {
      family,
      faces,
      // The owner's symptom, measured: the upright slot's LATIN ink
      // must be upright (the bug measured about -17px lean).
      latinUpright: slant("H", `400 100px "${family}"`),
      // The italic slot really slants; the CJK carries the donor's own
      // kai lean (about +6px), never more.
      latinItalic: slant("H", `italic 400 100px "${family}"`),
      cjkUpright: slant("汉", `400 100px "${family}"`),
    };
  });

  // One FontFace per (weight, style) descriptor — no slot duplicates.
  expect(probe.faces).toEqual(["400/normal", "400/italic"]);
  // Upright Latin ink (the picker's self-rendered NAME rides this).
  expect(Math.abs(probe.latinUpright ?? 0)).toBeLessThan(3);
  // Italic requests reach a genuinely slanted face.
  expect(probe.latinItalic ?? 0).toBeLessThan(-8);
  // The donor's kai lean passes through verbatim (about +6px at 100px).
  expect(probe.cjkUpright ?? 0).toBeGreaterThan(2);
  expect(probe.cjkUpright ?? 0).toBeLessThan(11);

  await service.dispose();
});
