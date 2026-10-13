import { defineConfig } from "@playwright/test";

/**
 * The USER-JOURNEY e2e project (separate from the component-style suite
 * in playwright.config.ts — run it explicitly, never via plain
 * `playwright test`):
 *
 *   npx playwright test --config playwright.journey.config.ts
 *
 * Ten journeys (J1–J10) walk the app like one real user: the REAL dev
 * catalog is ON (the vite server serves /dev-catalog — the repo
 * manifest's families zipped from the local prototype fonts directory)
 * and ONE persistent browser profile spans the whole run, exactly like
 * a user's machine: the first boot (J1 初次启动) pays the one-time
 * catalog download, every later launch starts from stored catalog +
 * theme state (picks, rules, and settings still reset per launch —
 * only the catalog and the theme preference persist by design).
 *
 * J9 合成 runs against the owner's real serve layout
 * (FONTALLOY_RUN_ASSETS, default the fontalloy-run checkout): the
 * repo's own `fontalloy serve` binary over the fetched catalog
 * directory, so the catalog picks resolve through the manifest's
 * catalog-family references — the production build path.
 *
 * `reuseExistingServer: false` is deliberate: a stray dev server on
 * 5173 could have the catalog OFF (the component suite's setting), and
 * the journeys would silently run catalog-free. A port conflict fails
 * loudly instead.
 *
 * Parallel worktrees: PLAYWRIGHT_DEV_PORT moves every 5173 reference
 * (this server, the component config's, the serve fixture's
 * --allow-origin, the journey profile's baseURL) so sibling checkouts
 * can run their suites side by side. Default 5173.
 */
const devPort = process.env.PLAYWRIGHT_DEV_PORT ?? "5173";

export default defineConfig({
  testDir: "tests",
  testMatch: /journey\.spec\.ts$/,
  timeout: 900_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results-journey",
  use: {
    baseURL: `http://localhost:${devPort}`,
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
  },
  webServer: {
    command: `npm run dev -- --port ${devPort} --strictPort`,
    url: `http://localhost:${devPort}`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
    // The journeys' whole point: the REAL dev catalog, the same families
    // production serves, from the local prototype fonts directory.
    env: { ...process.env, VITE_DEV_CATALOG: "1" },
  },
});
