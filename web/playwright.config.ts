import { defineConfig } from "@playwright/test";

// Seam 3 — frontend end-to-end (spec issue #1, "Testing Decisions"),
// WebApp target (issue #21). The suite runs against the BUILT site:
// the webServer builds once and serves `dist/` through
// `vite preview`, so relative-path correctness (base "./") is part of
// what is under test.

// Parallel worktrees: PLAYWRIGHT_PREVIEW_PORT moves this preview
// server and the serve fixture's PREVIEW_ORIGIN together, so sibling
// checkouts can run their suites side by side. Default 4173.
const previewPort = process.env.PLAYWRIGHT_PREVIEW_PORT ?? "4173";

export default defineConfig({
  testDir: "tests",
  // The user-journey suite (J11) has its own project —
  // playwright.journey.config.ts (the built WebApp against a real
  // serve over the fetched catalog, 900s timeouts). Never pick it up
  // here.
  testIgnore: /journey\.spec\.ts$/,
  timeout: 30_000,
  fullyParallel: true,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    baseURL: `http://localhost:${previewPort}`,
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: `npm run build && npm run preview -- --port ${previewPort} --strictPort`,
    // The dev catalog serves a MANIFEST SUBSET (the seven families the
    // real-catalog specs assert on) — round-20's full-family zips grew
    // the whole catalog to gigabytes, and the app's first-run IndexedDB
    // download of everything would time the suite out. The acceptance
    // stack serves the full catalog; tests do not need it.
    env: {
      ...process.env,
      FONTALLOY_DEV_CATALOG_MANIFEST: "tests/fixtures/catalog-subset.manifest.json",
    },
    url: `http://localhost:${previewPort}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
