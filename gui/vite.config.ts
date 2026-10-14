import { defineConfig } from "vite";
import { execSync } from "node:child_process";
import { devCatalogPlugin } from "./scripts/dev-catalog.mjs";

// The frontend is shared by the Tauri GUI shell and the future static WebApp
// build. Keep it framework-free and environment-detecting (src/platform).
//
// The dev server also serves the fixture catalog at /dev-catalog/ (host
// font files zipped in memory) so a plain `npm run dev` boots a working
// catalog — see scripts/dev-catalog.mjs. The e2e suite opts out by
// setting VITE_DEV_CATALOG=0 on its web server (tests inject their own
// catalog or run catalog-free).
//
// __BUILD_STAMP__ (round 22, owner item 3): commit + build time, baked
// at server start / build time, shown DEV-ONLY in the top bar so a
// stale window is recognizable at a glance (the round-15/16 lesson:
// "which window am I looking at" must never need guessing).
const buildStamp = (() => {
  try {
    const sha = execSync("git rev-parse --short=7 HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    return `v0.1.0 · ${sha} · ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  } catch {
    return "v0.1.0 · dev";
  }
})();

export default defineConfig({
  clearScreen: false,
  define: {
    __BUILD_STAMP__: JSON.stringify(buildStamp),
  },
  plugins: [devCatalogPlugin()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "es2022",
    outDir: "dist",
  },
});
