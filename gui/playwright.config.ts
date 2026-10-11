import { defineConfig } from "@playwright/test";

// Seam 3 — frontend end-to-end (spec issue #1, "Testing Decisions").
// Drives the shared frontend through its real UI. In this environment the
// suite runs against the Vite dev server; the same app runs inside the Tauri
// shell (gui/src-tauri) where the native build toolchain allows.
export default defineConfig({
  testDir: "tests",
  timeout: 30_000,
  fullyParallel: true,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    baseURL: "http://localhost:5173",
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
    // Keep test pages catalog-free by default: the dev server's fixture
    // catalog is off unless a spec injects its own origin (catalog.spec).
    // With reuseExistingServer an already-running server keeps its own
    // setting — don't leave a stray `npm run dev` on 5173 while testing.
    env: { ...process.env, VITE_DEV_CATALOG: "0" },
  },
});
