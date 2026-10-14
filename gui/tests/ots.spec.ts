import {
  test,
  expect,
  type ConsoleMessage,
  type Page,
} from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateFamily,
  generateFonts,
  spawnServeOverFonts,
} from "./serve";

/**
 * Round 19 (owner item 3): every synthesized artifact must clear OTS —
 * the OpenType Sanitizer, the gate Chromium itself runs on every web
 * font ("Invalid font data" is its verdict string). This is the
 * industry answer to "is this font file acceptable to browsers".
 *
 * Route (the search for a standalone OTS is documented here so it is
 * never re-done blindly): no npm package wraps the sanitizer —
 * `ots-sanitize` and `opentype-sanitizer` do not exist on the registry,
 * `ots` is an unrelated Aliyun table-store SDK, and every other
 * candidate name probes 404 — and a C++ source build would chain the
 * gui suite to a compiler toolchain. So the gate is exercised the
 * direct way: through this suite's own Playwright Chromium, whose font
 * stack IS OTS. A FontFace load of the artifact bytes either resolves
 * (the sanitizer accepted, and its console stayed silent) or rejects
 * with exactly the browser's "Invalid font data" SyntaxError plus the
 * verbatim "OTS parsing error: ..." diagnostic on the console — the
 * same evidence a developer sees in DevTools on a rejected web font.
 *
 * The artifacts are real pipeline output, built through the same
 * fixture-service harness the synthesize spec uses (a real
 * `fontalloy serve` subprocess over the standard e2e fixtures), driven
 * here through the service's public HTTP contract — the same POST
 * /builds + GET /builds/{id}/font the GUI itself speaks — so the
 * validated bytes are the bytes the pipeline writes, unmodified. One
 * service, one fixture pair, three builds (ttf, woff2, ttc) keep the
 * runtime to seconds.
 *
 * ttc: @font-face takes single fonts, not collections, so the faces
 * are split out first with fontTools (gui/scripts/split_ttc.py —
 * test-side tooling that re-serializes each face; the pipeline's own
 * serialized bytes stay covered by the ttf and woff2 artifacts).
 *
 * The first test proves the oracle red-capable — OTS REJECTS a
 * deliberately corrupted copy of the real ttf artifact (bytes flipped
 * inside its glyf table) — so the passing tests mean the gate actually
 * judged the bytes, not that it accepts anything.
 *
 * No zero-JS-errors gate in this file: the corruption test
 * intentionally makes Chromium log OTS parsing errors.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

/** The three output format tiers, one build each. */
type Format = "ttf" | "woff2" | "ttc";

/** One OTS verdict over a buffer of font bytes. */
interface OtsVerdict {
  /** FontFace.load() resolved — Chromium's sanitizer accepted the bytes. */
  accepted: boolean;
  /** The rejection message when rejected (Chromium: "Invalid font data in ArrayBuffer."). */
  failure: string | null;
  /** Verbatim "OTS parsing error: ..." console diagnostics; empty when OTS is silent. */
  diagnostics: string[];
}

let service: Awaited<ReturnType<typeof spawnServeOverFonts>> | null = null;
let scratchRoot = "";
let artifacts: Record<Format, Buffer> | null = null;

test.describe("artifact OTS gate", () => {
  test.describe.configure({ mode: "serial" });
  // OTS lives in Chromium's font stack — the gate is meaningless under
  // engines with their own validators (Firefox/WebKit).
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "OTS is Chromium's font gate",
  );

  test.beforeAll(async () => {
    // Three real merges plus fixture generation on one worker.
    test.info().setTimeout(240_000);
    scratchRoot = await mkdtemp(resolve(tmpdir(), "fontalloy-ots-"));
    const pairDir = resolve(scratchRoot, "pair"); // base.ttf + donor.ttf
    const familyDir = resolve(scratchRoot, "family"); // the 3-face family
    await generateFonts(pairDir, { donorGlyphs: 30_000 });
    await generateFamily(familyDir);
    service = await spawnServeOverFonts(pairDir, ["--font-dir", familyDir]);
    const url = await service.url;

    // The same recipe bodies the GUI submits: a single-face base for
    // the single-font tiers, the family pattern for the collection.
    const donor = resolve(pairDir, "donor.ttf");
    const single = resolve(pairDir, "base.ttf");
    const recipes: Record<Format, Record<string, unknown>> = {
      ttf: {
        base: single,
        donors: [donor],
        output: { format: "ttf", family: "ChHsich" },
      },
      woff2: {
        base: single,
        donors: [donor],
        output: { format: "woff2", family: "ChHsich" },
      },
      ttc: {
        base: {
          path: resolve(familyDir, "AlloyFamily-Regular.ttf"),
          pattern: "AlloyFamily-*",
        },
        donors: [donor],
        output: { format: "ttc", family: "ChHsich" },
      },
    };
    const built: Partial<Record<Format, Buffer>> = {};
    for (const format of Object.keys(recipes) as Format[]) {
      built[format] = await fetchArtifact(url, await submitBuild(url, recipes[format]));
    }
    artifacts = built as Record<Format, Buffer>;
  });

  test.afterAll(async () => {
    await service?.dispose();
    if (scratchRoot !== "") {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });

  test("the gate is provably red-capable: OTS rejects the ttf artifact with flipped glyf bytes", async ({
    page,
  }) => {
    const ttf = built().ttf;
    const glyf = sfntTables(ttf).find((table) => table.tag === "glyf");
    expect(glyf, "the ttf artifact carries a glyf table").toBeDefined();

    // Flip 64 bytes at the glyf table's start: the first glyph's
    // header (contour count, composite-component indices) becomes
    // structural garbage OTS cannot parse, while the table checksum
    // goes stale. Any structural parse of glyph data must reject.
    const corrupted = Buffer.from(ttf);
    for (let i = 0; i < 64; i++) {
      corrupted[glyf!.offset + i] ^= 0xff;
    }
    const verdict = await otsGate(page, corrupted);
    expect(
      verdict.accepted,
      `OTS accepted a corrupted font (failure: ${verdict.failure}; ` +
        `diagnostics: ${verdict.diagnostics.join(" | ")})`,
    ).toBe(false);
    expect(verdict.failure).toContain("Invalid font data");
    expect(
      verdict.diagnostics.join("\n"),
    ).toContain("OTS parsing error");
  });

  test("the ttf artifact clears OTS", async ({ page }) => {
    const bytes = built().ttf;
    expect(bytes.readUInt32BE(0)).toBe(0x00010000); // sfnt TrueType flavor
    const verdict = await otsGate(page, bytes);
    expect(
      verdict.accepted,
      `OTS rejected the ttf artifact: ${verdict.failure} ` +
        `(${verdict.diagnostics.join(" | ")})`,
    ).toBe(true);
    // Accepted-but-warned is still a finding: OTS must stay silent.
    expect(
      verdict.diagnostics,
      `OTS warned while accepting the ttf artifact: ` +
        `${verdict.diagnostics.join(" | ")}`,
    ).toEqual([]);
  });

  test("the woff2 artifact clears OTS", async ({ page }) => {
    const bytes = built().woff2;
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("wOF2");
    const verdict = await otsGate(page, bytes);
    expect(
      verdict.accepted,
      `OTS rejected the woff2 artifact: ${verdict.failure} ` +
        `(${verdict.diagnostics.join(" | ")})`,
    ).toBe(true);
    expect(
      verdict.diagnostics,
      `OTS warned while accepting the woff2 artifact: ` +
        `${verdict.diagnostics.join(" | ")}`,
    ).toEqual([]);
  });

  test("the ttc artifact clears OTS face by face", async ({ page }) => {
    test.info().setTimeout(60_000);
    const ttc = built().ttc;
    expect(ttc.subarray(0, 4).toString("latin1")).toBe("ttcf");

    // @font-face cannot load a collection: split each face out with the
    // fontTools test-side helper, then feed every face to the gate.
    const ttcPath = resolve(scratchRoot, "ChHsich.ttc");
    await writeFile(ttcPath, ttc);
    const facesDir = resolve(scratchRoot, "faces");
    const facePaths = await splitTtc(ttcPath, facesDir);
    // The family fixture's whole matrix: 400 upright + 400 italic + 700.
    expect(facePaths.length).toBe(3);
    for (const [index, facePath] of facePaths.entries()) {
      const verdict = await otsGate(page, readFileSync(facePath));
      expect(
        verdict.accepted,
        `OTS rejected ttc face ${index} (${facePath}): ` +
          `${verdict.failure} (${verdict.diagnostics.join(" | ")})`,
      ).toBe(true);
      expect(
        verdict.diagnostics,
        `OTS warned while accepting ttc face ${index}: ` +
          `${verdict.diagnostics.join(" | ")}`,
      ).toEqual([]);
    }
  });
});

/** The built artifacts, or a loud failure when the setup did not run. */
function built(): Record<Format, Buffer> {
  if (artifacts === null) {
    throw new Error("the beforeAll fixture builds did not run");
  }
  return artifacts;
}

/**
 * Hand `bytes` to Chromium's OTS through a FontFace load and collect
 * the verdict. Runs on about:blank — the gate needs no app, and the
 * page stays free of the workspace's own font traffic.
 */
async function otsGate(page: Page, bytes: Uint8Array): Promise<OtsVerdict> {
  await page.goto("about:blank");
  const diagnostics: string[] = [];
  const onConsole = (msg: ConsoleMessage): void => {
    const text = msg.text();
    if (text.includes("OTS parsing error")) diagnostics.push(text);
  };
  page.on("console", onConsole);
  try {
    const failure = await page.evaluate(
      async (b64: string): Promise<string | null> => {
        const binary = atob(b64);
        const buffer = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          buffer[i] = binary.charCodeAt(i);
        }
        const face = new FontFace("fontalloy-ots-gate", buffer.buffer);
        try {
          await face.load();
          return null; // accepted
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      },
      Buffer.from(bytes).toString("base64"),
    );
    // The OTS diagnostic lands on the console with (or right after) the
    // rejection; give the pipe a beat before judging silence.
    await page.waitForTimeout(400);
    return {
      accepted: failure === null,
      failure,
      diagnostics,
    };
  } finally {
    page.off("console", onConsole);
  }
}

/** One directory entry of an sfnt TrueType font. */
interface TableEntry {
  tag: string;
  offset: number;
  length: number;
}

/** Parse an sfnt table directory (TrueType flavor fonts only). */
function sfntTables(bytes: Buffer): TableEntry[] {
  expect(bytes.readUInt32BE(0)).toBe(0x00010000);
  const count = bytes.readUInt16BE(4);
  const tables: TableEntry[] = [];
  for (let index = 0; index < count; index++) {
    const at = 12 + index * 16;
    tables.push({
      tag: bytes.subarray(at, at + 4).toString("latin1"),
      offset: bytes.readUInt32BE(at + 8),
      length: bytes.readUInt32BE(at + 12),
    });
  }
  return tables;
}

/** Submit one merge to the fixture service and await its completion. */
async function submitBuild(
  serviceUrl: string,
  recipe: Record<string, unknown>,
): Promise<string> {
  const response = await fetch(`${serviceUrl}/builds`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(recipe),
  });
  expect(response.status).toBe(202);
  const submitted = (await response.json()) as { id: string; href: string };
  const deadline = Date.now() + 180_000;
  for (;;) {
    const status = (await (await fetch(`${serviceUrl}${submitted.href}`))
      .json()) as { status: string; error: string | null };
    if (status.status === "done") return submitted.id;
    if (status.status === "failed") {
      throw new Error(`the fixture build failed: ${status.error}`);
    }
    if (Date.now() > deadline) {
      throw new Error("the fixture build did not finish within 180s");
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
}

/** Fetch a finished build's font bytes through the service contract. */
async function fetchArtifact(
  serviceUrl: string,
  buildId: string,
): Promise<Buffer> {
  const response = await fetch(`${serviceUrl}/builds/${buildId}/font`);
  expect(response.status).toBe(200);
  return Buffer.from(await response.arrayBuffer());
}

/** Split a ttc into per-face ttfs (test-side; prints JSON path list). */
function splitTtc(ttcPath: string, outDir: string): Promise<string[]> {
  const python = process.env.FONTALLOY_PYTHON ?? "python";
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      python,
      [
        resolve(repoRoot, "gui/scripts/split_ttc.py"),
        ttcPath,
        "--out-dir",
        outDir,
      ],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("error", (err) => rejectPromise(new Error(`${python}: ${err}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        rejectPromise(new Error(`split_ttc.py exited ${code}: ${out}`));
        return;
      }
      const line = out
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.startsWith("["))
        .pop();
      try {
        resolvePromise(JSON.parse(line ?? "") as string[]);
      } catch {
        rejectPromise(
          new Error(`split_ttc.py printed no JSON face list: ${out}`),
        );
      }
    });
  });
}
