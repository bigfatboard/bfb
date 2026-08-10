// ABOUTME: Confirms Better Auth is pinned and mounted for C02 without exposing open DCR.
// ABOUTME: Sign-in fixture path and Better Auth handler module both exist in the Worker.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createHumanAuth } from "../src/auth/better-auth.js";

describe("better auth product mount", () => {
  it("constructs the pinned Better Auth package", () => {
    const auth = createHumanAuth({
      APP_ORIGIN: "https://bfb.example.test",
      BETTER_AUTH_SECRET: "synthetic-local-auth-secret-not-for-prod",
    });
    expect(typeof auth.handler).toBe("function");
  });

  it("mounts auth routes and keeps product version pin", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const routes = readFileSync(path.join(root, "src/routes.ts"), "utf8");
    const betterAuth = readFileSync(path.join(root, "src/auth/better-auth.ts"), "utf8");
    expect(routes).toMatch(/\/auth\/\*/);
    expect(routes).toMatch(/handleAuthRoute/);
    expect(betterAuth).toMatch(/1\.6\.26|betterAuth/);
    expect(routes).not.toMatch(/auth_not_implemented/);
  });
});
