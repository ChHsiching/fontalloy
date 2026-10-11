import { defineConfig } from "vite";
import { resolve } from "node:path";
import { devCatalogPlugin } from "../gui/scripts/dev-catalog.mjs";

// The WebApp build target: the SAME workspace app the Tauri GUI mounts
// (gui/src — see web/README.md), as a pure static site. `base: "./"`
// keeps every asset URL relative, so the build works from any static
// host and any sub-path (GitHub Pages project sites, Vercel preview
// URLs, a local `vite preview`).
//
// The preview server also serves the REAL local catalog at
// /dev-catalog/ (the same plugin the gui dev server runs — manifest
// families zipped from a local fonts directory), and VITE_WEB_CATALOG=1
// makes the built bundle bootstrap it: `vite preview` of the static
// target shows the same real picker/rail/grid as the desktop app.
// Deploying the dist elsewhere (a real static host) keeps the injected
// config seam: without the local catalog path the page runs
// catalog-free unless a config names an origin.
export default defineConfig({
  root: __dirname,
  clearScreen: false,
  base: "./",
  define: {
    "import.meta.env.VITE_WEB_CATALOG": '"1"',
  },
  plugins: [devCatalogPlugin()],
  server: {
    port: 5174,
    strictPort: true,
    // The shared source lives outside this target's root; allow the
    // dev server to serve it (build resolves it regardless).
    fs: {
      allow: [resolve(__dirname, "..")],
    },
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
  build: {
    target: "es2022",
    outDir: "dist",
  },
});
