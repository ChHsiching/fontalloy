import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The real-service test bootstrap (issue #22): spawn `fontalloy serve`
 * exactly the way a consumer sees it — a subprocess on an OS-assigned
 * 127.0.0.1 port, the ready URL read from stdout (the ticket-11 startup
 * line contract) — plus the synthetic fixture fonts the merges consume.
 *
 * The service runs through the project env (`uv run --no-sync`), so the
 * web suite needs no globally installed console script; `--no-sync`
 * keeps the spawned runs from re-locking while the dev env exists.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");

const READY_LINE = /^http:\/\/127\.0\.0\.1:(\d+)\s*$/;

/** The origin the built site is previewed at (playwright baseURL). */
export const PREVIEW_ORIGIN = "http://localhost:4173";

/** A serve allowlist entry that is NOT the preview origin (CORS tests). */
export const OTHER_ORIGIN = "http://allowlist.example";

export interface ServeHandle {
  baseUrl: string;
  port: number;
  /** Kill the service and await its exit (best effort, never throws). */
  stop(): Promise<void>;
}

let fixtureFonts: Promise<string> | null = null;

/**
 * The synthetic merge inputs (Alpha/Beta tiny, Slow wide), generated
 * once per test worker into a fresh temp directory.
 */
export function serveFixtureDir(): Promise<string> {
  if (fixtureFonts === null) {
    fixtureFonts = (async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "fontalloy-web-fixtures-"));
      await run(
        ["run", "--no-sync", "python", path.join("web", "scripts", "make-serve-fixture-fonts.py"), dir],
        REPO_ROOT,
      );
      return dir;
    })();
  }
  return fixtureFonts;
}

async function run(args: string[], cwd: string): Promise<void> {
  const child = spawn("uv", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (exitCode) => resolve(exitCode));
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new Error(
        "the `uv` executable is not on PATH — the web serve e2e suite " +
          "spawns `uv run fontalloy serve` from the repo's project env",
      );
    }
    throw error;
  });
  if (code !== 0) {
    throw new Error(
      `command failed (exit ${code}): uv ${args.join(" ")}\n${stderr.slice(-2000)}`,
    );
  }
}

/** Spawn one serve instance and resolve once it is accepting. */
export async function startServe(opts: {
  allowOrigin: string;
  fontDir?: string;
  /**
   * The catalog manifest to enumerate at /catalog AND resolve
   * catalog-family references against (the default is the repo
   * checkout's own manifest; the journey suite passes the owner's
   * fetched-catalog layout manifest instead).
   */
  manifest?: string;
}): Promise<ServeHandle> {
  const workDir = mkdtempSync(path.join(tmpdir(), "fontalloy-web-serve-"));
  const args = [
    "run",
    "--no-sync",
    "fontalloy",
    "serve",
    "--port",
    "0",
    "--allow-origin",
    opts.allowOrigin,
    "--work-dir",
    workDir,
  ];
  if (opts.fontDir !== undefined) {
    args.push("--font-dir", opts.fontDir);
  }
  if (opts.manifest !== undefined) {
    args.push("--manifest", opts.manifest);
  }

  const child: ChildProcess = spawn("uv", args, {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stopped = false;
  let stderrTail = "";

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `serve did not print a ready line within 60s (stderr tail: ${stderrTail.slice(-1500)})`,
          ),
        ),
      60_000,
    );
    let stdoutBuffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const line = stdoutBuffer.split("\r\n")[0].split("\n")[0];
      const match = READY_LINE.exec(line.trim());
      if (match) {
        clearTimeout(timer);
        resolve(Number.parseInt(match[1], 10));
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail += chunk.toString("utf8");
    });
    child.on("exit", (code) => {
      if (!stopped) {
        clearTimeout(timer);
        reject(
          new Error(
            `serve exited early with code ${code} (stderr tail: ${stderrTail.slice(-1500)})`,
          ),
        );
      }
    });
  });

  const stop = async (): Promise<void> => {
    stopped = true;
    if (child.exitCode === null) {
      // On Windows the console-script launcher spawns a child process:
      // a plain kill() orphans it (found while running the suites
      // locally — CI's Linux runners never see this). Kill the TREE.
      if (process.platform === "win32" && child.pid !== undefined) {
        await new Promise<void>((resolve) => {
          const killer = spawn(
            "taskkill",
            ["/pid", String(child.pid), "/T", "/F"],
            { stdio: "ignore" },
          );
          killer.on("error", () => child.kill());
          killer.on("close", () => resolve());
        });
      } else {
        child.kill();
      }
      await new Promise<void>((resolve) => {
        child.on("exit", () => resolve());
        setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 10_000).unref();
      });
    }
  };

  return { baseUrl: `http://127.0.0.1:${port}`, port, stop };
}
