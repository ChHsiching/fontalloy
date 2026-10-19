import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { exposeSaveSeam, saveSeamPageScript } from "./save-seam";

/**
 * The journey save seam at REAL artifact scale (ticket #37, round 31's
 * J9 failure: the build row died at the save with `Invalid array
 * length`).
 *
 * The old seam encoded the whole artifact with the one-shot
 * `btoa(Array.from(bytes, …).join(""))`. In Chromium `Array.from` over
 * a ≥ ~134 MiB Uint8Array throws `RangeError: Invalid array length`
 * (measured: 100 MB fine, 200 MB throws; the real-scale J9 ttc ≈
 * 300 MB reproduced the exact recorded signature), and any seam that
 * accumulates one whole-artifact base64 string additionally crosses
 * V8's max string length past ~400 MB (`Invalid string length`). This
 * spec drives the SHARED seam (./save-seam — the same page-side
 * installer and Node-side bindings the journeys use) at a size past
 * the `Array.from` cliff, so the old seam is red here and the chunked
 * seam proves the disk file is byte-identical to the page's bytes.
 *
 * 220 MiB (230,686,720 bytes, mod 3 = 1) also pins the final chunk's
 * '=' padding through the decode; the per-4 KiB block pattern (block i
 * carries i & 0xff) would catch any chunk reordering or truncation.
 */

/** Past Chromium's `Array.from` cliff (~134 MiB) with margin; NOT a
 *  multiple of 3, so the last chunk is the padded one. */
const SCALE_BYTES = 220 * 1_048_576;
/** The 另存为 plumbing payload: shares the encoder, adds the as- name
 *  prefix and the dialog counter; also not a multiple of 3. */
const SMALL_BYTES = 1_000_003;
/** Both sides fill per-block: block i carries (i / BLOCK) & 0xff. */
const BLOCK = 4096;

/** SHA-256 of the deterministic pattern, computed on the Node side. */
function patternSha256(size: number): string {
  const buffer = Buffer.alloc(size);
  for (let i = 0; i < size; i += BLOCK) {
    // Buffer#fill (unlike Uint8Array#fill) rejects an end past the
    // buffer, so clamp the final block to the exact size.
    buffer.fill((i / BLOCK) & 0xff, i, Math.min(i + BLOCK, size));
  }
  return createHash("sha256").update(buffer).digest("hex");
}

test("the journey save seam round-trips a real-scale artifact byte-exactly (#37)", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const saveDir = await mkdtemp(resolve(tmpdir(), "fontalloy-saveseam-"));
  let dialogSaves = 0;
  await exposeSaveSeam(page, {
    resolveSaveDir: () => saveDir,
    onDialogSave: () => {
      dialogSaves += 1;
    },
  });
  await page.addInitScript(saveSeamPageScript);
  await page.goto("about:blank");

  // The default-path save at real scale (red on the old seam: the
  // in-page Array.from threw before the transfer ever started).
  const saved = await page.evaluate(
    async (size: number) => {
      const bytes = new Uint8Array(size);
      for (let i = 0; i < bytes.length; i += 4096) {
        bytes.fill((i / 4096) & 0xff, i, i + 4096);
      }
      const config = (
        window as unknown as {
          __FONTALLOY_CONFIG__: {
            saveArtifact(
              name: string,
              bytes: Uint8Array,
            ): Promise<{ saved: boolean; path: string | null }>;
          };
        }
      ).__FONTALLOY_CONFIG__;
      return config.saveArtifact("scale.ttc", bytes);
    },
    SCALE_BYTES,
  );
  expect(saved.saved).toBe(true);
  const onDisk = await readFile(saved.path as string);
  expect(onDisk.length).toBe(SCALE_BYTES);
  expect(createHash("sha256").update(onDisk).digest("hex")).toBe(
    patternSha256(SCALE_BYTES),
  );

  // The 另存为 flow rides the same chunked encoder end to end: the
  // as- name prefix, the dialog counter, and the padded final chunk.
  const savedAs = await page.evaluate(async (size: number) => {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < bytes.length; i += 4096) {
      bytes.fill((i / 4096) & 0xff, i, i + 4096);
    }
    const config = (
      window as unknown as {
        __FONTALLOY_CONFIG__: {
          saveArtifactAs(
            name: string,
            bytes: Uint8Array,
          ): Promise<{ saved: boolean; path: string | null }>;
        };
      }
    ).__FONTALLOY_CONFIG__;
    return config.saveArtifactAs("small.ttf", bytes);
  }, SMALL_BYTES);
  expect(savedAs.saved).toBe(true);
  expect(savedAs.path).toContain("as-small.ttf");
  expect(dialogSaves).toBe(1);
  const asOnDisk = await readFile(savedAs.path as string);
  expect(asOnDisk.length).toBe(SMALL_BYTES);
  expect(createHash("sha256").update(asOnDisk).digest("hex")).toBe(
    patternSha256(SMALL_BYTES),
  );

  await rm(saveDir, { recursive: true, force: true });
});
