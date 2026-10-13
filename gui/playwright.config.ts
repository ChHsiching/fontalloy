import { defineConfig } from "@playwright/test";

// Seam 3 — frontend end-to-end (spec issue #1, "Testing Decisions").
// Drives the shared frontend through its real UI. In this environment the
// suite runs against the Vite dev server; the same app runs inside the Tauri
// shell (gui/src-tauri) where the native build toolchain allows.

// Parallel worktrees: PLAYWRIGHT_DEV_PORT moves this server, the
// journey config's, and the serve fixture's --allow-origin together,
// so sibling checkouts can run their suites side by side. Default
// 5173 (the shared default keeps reuseExistingServer semantics).
const devPort = process.env.PLAYWRIGHT_DEV_PORT ?? "5173";

export default defineConfig({
  testDir: "tests",
  // The user-journey suite (J1–J10) has its own project —
  // playwright.journey.config.ts (one persistent browser profile, the
  // REAL dev catalog, 900s timeouts). Never pick it up here.
  testIgnore: /journey\.spec\.ts$/,
  timeout: 30_000,
  fullyParallel: true,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    baseURL: `http://localhost:${devPort}`,
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: `npm run dev -- --port ${devPort} --strictPort`,
    url: `http://localhost:${devPort}`,
    reuseExistingServer: true,
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
    // Keep test pages catalog-free by default: the dev server's fixture
    // catalog is off unless a spec injects its own origin (catalog.spec).
    // With reuseExistingServer an already-running server keeps its own
    // setting — don't leave a stray `npm run dev` while testing.
    env: { ...process.env, VITE_DEV_CATALOG: "0" },
  },
});
