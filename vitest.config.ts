// ABOUTME: Configures the repository unit-test suite and its deterministic test discovery.
// ABOUTME: Keeps verification tests isolated from generated build output and dependencies.

import { defineConfig } from "vitest/config";

export default defineConfig({
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
  },
});
