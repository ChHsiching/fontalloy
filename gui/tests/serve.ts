import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The dev/e2e stand-in for the Tauri sidecar (issue #16): a REAL
 * `fontalloy serve` subprocess from the repo's uv environment, spawned
 * with the same flags the shell will pass (ephemeral port, the webview
 * origin allowed, the fixture directory as --font-dir), discovered
 * through the same startup-line contract (`http://127.0.0.1:<port>` on
 * stdout). The frontend is pointed at it through the injected config
 * bootstrap — never through a test-only code path.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
// Parallel-stream runs: the allow-origin must name whichever origin the
// Playwright configs actually use — an explicit FONTALLOY_E2E_ORIGIN wins,
// else derive from PLAYWRIGHT_DEV_PORT (default: the shared 5173).
const devOrigin =
  process.env.FONTALLOY_E2E_ORIGIN ??
  `http://localhost:${process.env.PLAYWRIGHT_DEV_PORT ?? "5173"}`;

/** The startup-line contract from ticket #11 (the port discovery regex). */
const STARTUP_LINE = /^http:\/\/127\.0\.0\.1:(\d+)\r?\n?$/;

export interface ServeFixture {
  /** The bound service URL (`http://127.0.0.1:<port>`). */
  url: string;
  /** Directory serve scans (--font-dir): base.ttf + donor.ttf. */
  fontsDir: string;
  baseFont: string;
  donorFont: string;
  dispose: () => Promise<void>;
}

/** Options for the synthetic fixture fonts. */
export interface FixtureFontOptions {
  /** Glyph count of the CJK donor run (build-duration knob). */
  donorGlyphs?: number;
  /**
   * The donor ALSO covers the first N ASCII letters (default 0), so the
   * two coverages overlap and override cases exist (precedence tests).
   */
  donorAscii?: number;
  /**
   * The donor ALSO maps N private-use codepoints onto ONE shared box
   * glyph (round 18: the fake-coverage fixture — those codepoints must
   * read as missing everywhere, never as donor coverage). Round 19: the
   * shared glyph carries .notdef's exact outline, the shape the outline
   * rule catches.
   */
  placeholderDonor?: number;
  /**
   * The donor ALSO maps N private-use codepoints onto ONE shared glyph
   * with its OWN outline (round 19: the concentration negative — a
   * shared glyph of real shape is plain coverage, never a placeholder).
   */
  sharedGlyphDonor?: number;
  /**
   * Write the donor as a CFF (OTF) face instead of a TTF one (round
   * 19: the GUI's CFF parse path — charstring compare — gets the same
   * fixtures the glyf path has).
   */
  cffDonor?: boolean;
  /**
   * The donor's family name (round 20: a LONG name forces the report's
   * 「N 档全部取自 …」 sentence to wrap — the geometry fixture for the
   * wrapped-tag-flush-right pin).
   */
  donorName?: string;
}

/** Generate the synthetic fixture pair into `fontsDir` (no service). */
export async function generateFonts(
  fontsDir: string,
  options: FixtureFontOptions = {},
): Promise<{ base: string; donor: string }> {
  const python = process.env.FONTALLOY_PYTHON ?? "python";
  const args = [
    resolve(repoRoot, "gui/scripts/e2e_fonts.py"),
    fontsDir,
    "--donor-glyphs",
    String(options.donorGlyphs ?? 2000),
  ];
  if (options.donorAscii) {
    args.push("--donor-ascii", String(options.donorAscii));
  }
  if (options.placeholderDonor) {
    args.push("--placeholder-donor", String(options.placeholderDonor));
  }
  if (options.sharedGlyphDonor) {
    args.push("--shared-glyph-donor", String(options.sharedGlyphDonor));
  }
  if (options.cffDonor) {
    args.push("--cff-donor");
  }
  if (options.donorName) {
    args.push("--donor-name", options.donorName);
  }
  await run(python, args, repoRoot);
  return {
    base: resolve(fontsDir, "base.ttf"),
    donor: resolve(fontsDir, "donor.ttf"),
  };
}

/**
 * Generate the round-12 family fixture into `outdir` (no service): one
 * family, three faces (Regular 400 / Bold 700 / Italic 400-italic,
 * one shared name-table family). Returns the face file paths.
 */
export async function generateFamily(
  outdir: string,
  familyName = "Alloy Family",
  stem = "AlloyFamily",
): Promise<string[]> {
  const python = process.env.FONTALLOY_PYTHON ?? "python";
  await run(
    python,
    [
      resolve(repoRoot, "gui/scripts/e2e_fonts.py"),
      outdir,
      "--family",
      "--family-name",
      familyName,
      "--family-stem",
      stem,
    ],
    repoRoot,
  );
  return ["Regular", "Bold", "Italic"].map((style) =>
    resolve(outdir, `${stem}-${style}.ttf`),
  );
}

/**
 * Generate the round-19 collection fixture into `outdir` (no service):
 * a real fontTools three-face .ttc — distinct family names, the first
 * two faces' identical tables deduped into the shared region exactly
 * like the pipeline's own ttc output. Returns the collection path.
 */
export async function generateTtc(
  outdir: string,
  stem = "AlloyTTC",
): Promise<string> {
  const python = process.env.FONTALLOY_PYTHON ?? "python";
  await run(
    python,
    [
      resolve(repoRoot, "gui/scripts/e2e_fonts.py"),
      outdir,
      "--ttc",
      "--ttc-stem",
      stem,
    ],
    repoRoot,
  );
  return resolve(outdir, `${stem}.ttc`);
}

/** Run a command to completion, failing loudly with its output. */
function run(
  command: string,
  args: string[],
  cwd: string,
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("error", (err) => rejectPromise(new Error(`${command}: ${err}`)));
    child.on("close", (code) =>
      code === 0
        ? resolvePromise()
        : rejectPromise(new Error(`${command} exited ${code}: ${out}`)),
    );
  });
}

/** The `fontalloy` console script of the worktree's uv environment. */
function defaultServeBin(): string {
  const candidates =
    process.platform === "win32"
      ? [".venv/Scripts/fontalloy.exe", ".venv/Scripts/fontalloy.cmd"]
      : [".venv/bin/fontalloy"];
  for (const candidate of candidates) {
    const path = resolve(repoRoot, candidate);
    if (existsSync(path)) return path;
  }
  throw new Error(
    "the fontalloy serve binary was not found in .venv — run `uv sync` " +
      "at the repo root, or set FONTALLOY_SERVE_BIN",
  );
}

/** Spawn a real `fontalloy serve` over `fontsDir` (ephemeral port). */
export function spawnServeOverFonts(
  fontsDir: string,
  extraArgs: readonly string[] = [],
): Promise<{
  url: string;
  dispose: () => Promise<void>;
}> {
  const bin = process.env.FONTALLOY_SERVE_BIN ?? defaultServeBin();
  const child: ChildProcess = spawn(
    bin,
    [
      "serve",
      "--port",
      "0",
      "--allow-origin",
      devOrigin,
      "--font-dir",
      fontsDir,
      ...extraArgs,
    ],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  const url = new Promise<string>((resolvePromise, rejectPromise) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      rejectPromise(
        new Error(
          `fontalloy serve did not print its startup line in 20s ` +
            `(stdout so far: ${stdout}; stderr: ${stderr})`,
        ),
      );
    }, 20_000);
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
      const match = STARTUP_LINE.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolvePromise(`http://127.0.0.1:${match[1]}`);
      }
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      rejectPromise(
        new Error(
          `fontalloy serve exited before binding (code ${code}; ` +
            `stdout: ${stdout}; stderr: ${stderr})`,
        ),
      );
    });
  });
  return {
    url,
    dispose: async () => {
      if (child.pid !== undefined) {
        if (process.platform === "win32") {
          await run(
            "taskkill",
            ["/pid", String(child.pid), "/T", "/F"],
            repoRoot,
          ).catch(() => child.kill());
        } else {
          child.kill("SIGTERM");
        }
      }
      await new Promise<void>((resolvePromise) => {
        const timer = setTimeout(() => resolvePromise(), 3_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolvePromise();
        });
      });
    },
  };
}

/**
 * Generate the fixture fonts and spawn the real service. `donorGlyphs`
 * is the build-duration knob: ~30k glyphs makes a merge take ~2s, long
 * enough to observe progress mid-build.
 */
export async function startServeFixture(
  options: number | FixtureFontOptions = 30000,
): Promise<ServeFixture> {
  const fixture: FixtureFontOptions =
    typeof options === "number" ? { donorGlyphs: options } : options;
  const root = await mkdtemp(resolve(tmpdir(), "fontalloy-e2e-"));
  const fontsDir = resolve(root, "fonts");
  await generateFonts(fontsDir, fixture);

  const bin = process.env.FONTALLOY_SERVE_BIN ?? defaultServeBin();
  const child: ChildProcess = spawn(
    bin,
    [
      "serve",
      "--port",
      "0",
      "--allow-origin",
      devOrigin,
      "--font-dir",
      fontsDir,
      "--work-dir",
      resolve(root, "work"),
    ],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
  );

  const url = await new Promise<string>((resolvePromise, rejectPromise) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      rejectPromise(
        new Error(
          `fontalloy serve did not print its startup line in 20s ` +
            `(stdout so far: ${stdout}; stderr: ${stderr})`,
        ),
      );
    }, 20_000);
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
      const match = STARTUP_LINE.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolvePromise(`http://127.0.0.1:${match[1]}`);
      }
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      rejectPromise(
        new Error(
          `fontalloy serve exited before binding (code ${code}; ` +
            `stdout: ${stdout}; stderr: ${stderr})`,
        ),
      );
    });
  });

  return {
    url,
    fontsDir,
    baseFont: resolve(fontsDir, "base.ttf"),
    donorFont: resolve(fontsDir, "donor.ttf"),
    dispose: async () => {
      // A tree kill: the console-script launcher (and, on Windows, any
      // child it spawned) must not survive the test — a leaked serve
      // holds the work dir and, for the frozen sidecar, the binary.
      if (child.pid !== undefined) {
        if (process.platform === "win32") {
          await run("taskkill", ["/pid", String(child.pid), "/T", "/F"], repoRoot).catch(
            () => child.kill(),
          );
        } else {
          child.kill("SIGTERM");
        }
      }
      await new Promise<void>((resolvePromise) => {
        const timer = setTimeout(() => resolvePromise(), 3_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolvePromise();
        });
      });
      await rm(root, { recursive: true, force: true });
    },
  };
}
