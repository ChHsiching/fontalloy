import { defineConfig } from "vite";
import { resolve } from "node:path";

// The WebApp build target: a pure static site built from the shared
// frontend source (gui/src — see web/README.md for the two-target
// layout). `base: "./"` keeps every asset URL relative, so the build
// works from any static host and any sub-path (GitHub Pages project
// sites, Vercel preview URLs, a local `vite preview`).
export default defineConfig({
  root: __dirname,
  clearScreen: false,
  base: "./",
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
