// ABOUTME: Playwright config for W01 real-browser E2E against the local fixture control+SPA server.
// ABOUTME: Starts tools/e2e server on port 4173 with transient browser artifacts by default.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const port = Number(process.env.BFB_E2E_PORT ?? "4173");
const host = process.env.BFB_E2E_HOST ?? "127.0.0.1";
const originHost = process.env.BFB_E2E_ORIGIN_HOST ?? "bfb.localhost";
const origin = `http://${originHost}:${port}`;
const healthOrigin = `http://${host}:${port}`;

export default defineConfig({
  testDir: path.join(rootDir, "apps/web/test/e2e"),
  outputDir: path.join(rootDir, "apps/web/test/e2e/test-results"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: origin,
    headless: true,
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  webServer: {
    command: `pnpm exec tsx ${path.join(rootDir, "tools/e2e/src/server.ts")}`,
    cwd: rootDir,
    url: `${healthOrigin}/healthz`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      BFB_E2E_PORT: String(port),
      BFB_E2E_HOST: host,
      BFB_E2E_ORIGIN_HOST: originHost,
    },
  },
});
