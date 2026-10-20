import { defineConfig } from "@playwright/test";

/**
 * The USER-JOURNEY e2e project (separate from the component-style suite
 * in playwright.config.ts — run it explicitly, never via plain
 * `playwright test`):
 *
 *   npx playwright test --config playwright.journey.config.ts
 *
 * Ten journeys (J1–J10) walk the app like one real user, ONE persistent
 * browser profile spanning the whole run, exactly like a user's
 * machine: theme state persists across launches; everything else
 * resets per launch or lives with its serve by design.
 *
 * Ticket #37's serve-less conversion: J1/J8/J10 boot with NO serve
 * (?noservice=1 — the T3 catalog model's terminal "none" state: zero
 * rows, no sweep wait, the honest degrade) and J2 runs its picker
 * surface against its own TINY fixture catalog serve, so a run of
 * those four journeys touches no real catalog bytes at all. J3–J7/J9
 * still run against the real layout: the shared coloring serve and
 * J9's own serve sync the journey catalog from this server's
 * /dev-catalog (the repo manifest's families zipped from the local
 * prototype fonts directory), and J9 submits builds over the run
 * assets (FONTALLOY_RUN_ASSETS, default the fontalloy-run checkout) —
 * the production build path.
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
// A local run MUST set the port explicitly (ticket #37): the 5173
// band is shared with other stacks, and a leftover server there
// silently answers as this suite's own app. CI's isolated runners
// keep the default.
if (!process.env.CI && process.env.PLAYWRIGHT_DEV_PORT === undefined) {
  throw new Error(
    "PLAYWRIGHT_DEV_PORT is not set — pick an explicit port " +
      "(5351-5399 locally; the 5173 default is CI-only)",
  );
}
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
    // The coloring serves' release origin: the REAL dev catalog (the
    // same families production serves) from the local prototype fonts
    // directory. The serve-less journeys never request it.
    env: { ...process.env, VITE_DEV_CATALOG: "1" },
  },
});
