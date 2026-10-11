import { defineConfig } from "vite";
import { devCatalogPlugin } from "./scripts/dev-catalog.mjs";

// The frontend is shared by the Tauri GUI shell and the future static WebApp
// build. Keep it framework-free and environment-detecting (src/platform).
//
// The dev server also serves the fixture catalog at /dev-catalog/ (host
// font files zipped in memory) so a plain `npm run dev` boots a working
// catalog — see scripts/dev-catalog.mjs. The e2e suite opts out by
// setting VITE_DEV_CATALOG=0 on its web server (tests inject their own
// catalog or run catalog-free).
export default defineConfig({
  clearScreen: false,
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
