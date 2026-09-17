// ABOUTME: Playwright config for V02 isolated viewer E2E on dedicated two-origin ports.
// ABOUTME: The spec starts its own app and artifact servers; no shared webServer is used.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig({
  testDir: path.join(rootDir, "apps/web/test/e2e"),
  testMatch: ["v02-viewer.spec.ts"],
  outputDir: path.join(rootDir, "apps/web/test/e2e/test-results"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    headless: true,
    trace: "off",
    video: "off",
    screenshot: "off",
  },
});
