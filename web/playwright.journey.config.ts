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
    baseURL: "http://localhost:4173",
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
  },
  webServer: {
    command: "npm run build && npm run preview",
    url: "http://localhost:4173",
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
