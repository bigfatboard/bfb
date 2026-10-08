// ABOUTME: Compiles the production artifact viewer into a synthetic browser-proof entry.
// ABOUTME: The test bundle stays separate from the normal application build and runtime.

import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./test/viewer-runtime", import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("./dist/viewer-runtime", import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
  },
});
