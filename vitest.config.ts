// ABOUTME: Configures the repository unit-test suite and its deterministic test discovery.
// ABOUTME: Keeps verification tests isolated from generated build output and dependencies.

import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const cloudflareRuntime = fileURLToPath(
  new URL("./apps/control-worker/test/runtime-base.ts", import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": cloudflareRuntime,
    },
  },
  test: {
    coverage: { enabled: false },
    include: [
      "tools/repository/test/**/*.test.ts",
      "packages/protocol-ts/test/**/*.test.ts",
      "apps/control-worker/test/**/*.test.ts",
      "apps/artifact-worker/test/**/*.test.ts",
      "apps/web/test/**/*.test.ts",
      "packages/db/test/**/*.test.ts",
      "packages/domain/test/**/*.test.ts",
    ],
    restoreMocks: true,
    // Migration replay and protocol generation do real work per test; a loaded machine exceeds the 5 s default.
    testTimeout: 60_000,
  },
});
