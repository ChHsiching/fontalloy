import { defineConfig } from "vite";

// The frontend is shared by the Tauri GUI shell and the future static WebApp
// build. Keep it framework-free and environment-detecting (src/platform).
export default defineConfig({
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "es2022",
    outDir: "dist",
  },
});
