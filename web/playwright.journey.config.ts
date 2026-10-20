import { defineConfig } from "@playwright/test";

/**
 * The WEB user-journey e2e project (J11) — the same core journey as
 * gui/tests/journey.spec.ts, on the BUILT static target:
 *
 *   npx playwright test --config playwright.journey.config.ts
 *
 * One journey walks the WebApp against a real `fontalloy serve` over
 * the owner's fetched catalog layout (FONTALLOY_RUN_ASSETS): service
 * detection through ?serve=, catalog picks (JetBrains Mono row +
 * Maple Mono NF-CN via the 等宽 chip), a language preset, a live
 * synthesize through the seven report-copy stages, the verification
 * report, and the artifact as a real browser download — then the
 * no-service degrade panel (an address nothing answers): the copy-CLI
 * command and the recipe YAML download.
 *
 * `reuseExistingServer: false` keeps the build fresh; the preview
 * server serves the real local catalog (/dev-catalog, the same plugin
 * the gui dev server runs).
 */
// Parallel worktrees: PLAYWRIGHT_PREVIEW_PORT (default 4173) keeps
// sibling checkouts' preview servers off each other's port.
//
// A local run MUST set the port explicitly (ticket #37): the default
// band is shared with the acceptance stack, and a leftover server
// there silently answers as this suite's own app. CI's isolated
// runners keep the default.
if (!process.env.CI && process.env.PLAYWRIGHT_PREVIEW_PORT === undefined) {
  throw new Error(
    "PLAYWRIGHT_PREVIEW_PORT is not set — pick an explicit port " +
      "(4273-4299 locally; the 4173 default is CI-only)",
  );
}
const previewPort = process.env.PLAYWRIGHT_PREVIEW_PORT ?? "4173";

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
    baseURL: `http://localhost:${previewPort}`,
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
  },
  webServer: {
    command: `npm run build && npm run preview -- --port ${previewPort} --strictPort`,
    url: `http://localhost:${previewPort}`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
