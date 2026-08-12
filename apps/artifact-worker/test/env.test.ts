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

  it("rejects shared hostnames even on different ports", () => {
    expect(() =>
      validateArtifactEnv(env({ ARTIFACT_ORIGIN: "https://bfb.example.test:9443" })),
    ).toThrow(/artifact hostname must differ/);
  });

  it("rejects non-HTTP origins and user information", () => {
    expect(() =>
      validateArtifactEnv(env({ ARTIFACT_ORIGIN: "ftp://artifacts.example.test" })),
    ).toThrow(/invalid origin protocol/);
    expect(() =>
      validateArtifactEnv(env({ ARTIFACT_ORIGIN: "https://user@artifacts.example.test" })),
    ).toThrow(/scheme\+host only/);
  });

  it("requires HTTPS outside local development", () => {
    expect(() =>
      validateArtifactEnv(
        env({
          ENVIRONMENT: "staging",
          ARTIFACT_ORIGIN: "http://artifacts.bfb.staging.example.test",
          APP_ORIGIN: "https://bfb.staging.example.test",
        }),
      ),
    ).toThrow(/must use https/);
  });

  it("rejects app session cookies", () => {
    const request = new Request("https://artifacts.bfb.example.test/healthz", {
      headers: { cookie: "__Host-bfb_session=synthetic" },
    });
    expect(() => assertNoAppCookie(request)).toThrow(/session cookie/);
  });

  it("never enables credentialed CORS", () => {
    const request = new Request("https://artifacts.bfb.example.test/healthz", {
      headers: { origin: "https://artifacts.bfb.example.test" },
    });
    const headers = corsHeaders(request, "https://artifacts.bfb.example.test");
    expect(headers.get("access-control-allow-credentials")).toBeNull();
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
