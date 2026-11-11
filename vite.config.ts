import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig(async () => ({
  // Relative asset paths: the same dist/ is served from the GitHub Pages
  // subpath (/zero-light/) and from Tauri's local protocol.
  base: "./",
  // Prevent Vite from clearing the screen, so Rust compiler errors stay visible.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Tell Vite to ignore changes in src-tauri (Rust side has its own tooling).
      ignored: ["**/src-tauri/**"],
    },
  },
}));
