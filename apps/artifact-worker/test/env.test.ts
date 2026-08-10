// ABOUTME: Verifies Artifact Worker cookie-less origin rules and binding validation.
// ABOUTME: Drives real validateArtifactEnv, assertNoAppCookie, and corsHeaders helpers.

import { describe, expect, it } from "vitest";

import {
  assertNoAppCookie,
  corsHeaders,
  validateArtifactEnv,
  type ArtifactBindings,
} from "../src/env.js";

function env(overrides: Partial<ArtifactBindings> = {}): ArtifactBindings {
  return {
    ARTIFACTS: { __synthetic: "r2" } as unknown as R2Bucket,
    ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
    APP_ORIGIN: "https://bfb.example.test",
    ENVIRONMENT: "local",
    ...overrides,
  };
}

describe("artifact env", () => {
  it("validates a complete artifact environment", () => {
    const validated = validateArtifactEnv(env());
    expect(validated.artifactOrigin).toBe("https://artifacts.bfb.example.test");
    expect(validated.environment).toBe("local");
  });

  it("rejects missing R2", () => {
    const value = env();
    delete (value as { ARTIFACTS?: R2Bucket }).ARTIFACTS;
    expect(() => validateArtifactEnv(value)).toThrow(/missing binding: ARTIFACTS/);
  });

  it("rejects shared origins", () => {
    expect(() => validateArtifactEnv(env({ ARTIFACT_ORIGIN: "https://bfb.example.test" }))).toThrow(
      /artifact origin must differ/,
    );
  });

  it("rejects app session cookies", () => {
    const request = new Request("https://artifacts.bfb.example.test/healthz", {
      headers: { cookie: "bfb_session=synthetic" },
    });
    expect(() => assertNoAppCookie(request)).toThrow(/session cookie/);
  });

  it("never enables credentialed CORS", () => {
    const request = new Request("https://artifacts.bfb.example.test/healthz", {
      headers: { origin: "https://artifacts.bfb.example.test" },
    });
    const headers = corsHeaders(request, "https://artifacts.bfb.example.test");
    expect(headers.get("access-control-allow-credentials")).toBe("false");
    expect(headers.get("access-control-allow-origin")).toBe("https://artifacts.bfb.example.test");
  });

  it("does not reflect foreign origins", () => {
    const request = new Request("https://artifacts.bfb.example.test/healthz", {
      headers: { origin: "https://evil.example" },
    });
    const headers = corsHeaders(request, "https://artifacts.bfb.example.test");
    expect(headers.get("access-control-allow-origin")).toBeNull();
  });
});
