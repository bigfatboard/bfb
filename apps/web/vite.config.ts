// ABOUTME: Configures the Vite build for the BFB web SPA static assets bundle.
// ABOUTME: Assets are served by the Control Worker Static Assets binding in F03.

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
  },
});
