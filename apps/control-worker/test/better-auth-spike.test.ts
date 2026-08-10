// ABOUTME: Proves the disposable Better Auth 1.6.26 spike constructs without product routes.
// ABOUTME: Asserts the spike module does not register auth handlers on the control app.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createDisposableBetterAuthSpike } from "../src/better-auth-spike.js";
import { createControlApp } from "../src/routes.js";

describe("better auth disposable spike", () => {
  it("constructs the pinned Better Auth package", () => {
    const spike = createDisposableBetterAuthSpike();
    expect(spike.version).toBe("1.6.26");
    expect(spike.hasHandler).toBe(true);
  });

  it("does not mount Better Auth on the control app source", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const index = readFileSync(path.join(root, "src/index.ts"), "utf8");
    const routes = readFileSync(path.join(root, "src/routes.ts"), "utf8");
    expect(index).not.toMatch(/betterAuth\(/);
    expect(routes).not.toMatch(/better-auth/);
    expect(routes).toMatch(/auth_not_implemented/);
    // App factory still constructs without auth plugins.
    expect(createControlApp()).toBeTruthy();
  });
});
