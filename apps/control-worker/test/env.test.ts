// ABOUTME: Verifies Control Worker environment validation and worker-first path ownership.
// ABOUTME: Drives the real validateControlEnv and isWorkerFirstPath implementations.

import { describe, expect, it } from "vitest";

import { isWorkerFirstPath, validateControlEnv, type ControlBindings } from "../src/env.js";

function fakeBinding<T extends object>(label: string): T {
  return { __synthetic: label } as unknown as T;
}

function validEnv(overrides: Partial<ControlBindings> = {}): ControlBindings {
  return {
    DB: fakeBinding<D1Database>("db"),
    ARTIFACTS: fakeBinding<R2Bucket>("r2"),
    JOBS: fakeBinding<Queue>("jobs"),
    JOBS_DLQ: fakeBinding<Queue>("dlq"),
    WORKSPACE_HUB: fakeBinding<DurableObjectNamespace>("hub"),
    APP_ORIGIN: "https://bfb.example.test",
    ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
    LAUNCH_ORIGIN: "https://launch.bfb.example.test",
    JURISDICTION: "eu",
    ENVIRONMENT: "local",
    ...overrides,
  };
}

describe("validateControlEnv", () => {
  it("accepts a complete local environment", () => {
    const validated = validateControlEnv(validEnv());
    expect(validated.environment).toBe("local");
    expect(validated.jurisdiction).toBe("eu");
    expect(validated.origins.appHostname).toBe("bfb.example.test");
  });

  it("fails closed when D1 is missing", () => {
    const env = validEnv();
    delete (env as { DB?: D1Database }).DB;
    expect(() => validateControlEnv(env)).toThrow(/missing binding: DB/);
  });

  it("fails closed when R2 is missing", () => {
    const env = validEnv();
    delete (env as { ARTIFACTS?: R2Bucket }).ARTIFACTS;
    expect(() => validateControlEnv(env)).toThrow(/missing binding: ARTIFACTS/);
  });

  it("fails closed when Queue is missing", () => {
    const env = validEnv();
    delete (env as { JOBS?: Queue }).JOBS;
    expect(() => validateControlEnv(env)).toThrow(/missing binding: JOBS/);
  });

  it("fails closed when Durable Object binding is missing", () => {
    const env = validEnv();
    delete (env as { WORKSPACE_HUB?: DurableObjectNamespace }).WORKSPACE_HUB;
    expect(() => validateControlEnv(env)).toThrow(/missing binding: WORKSPACE_HUB/);
  });

  it("fails when artifact origin matches app origin", () => {
    expect(() =>
      validateControlEnv(
        validEnv({
          ARTIFACT_ORIGIN: "https://bfb.example.test",
        }),
      ),
    ).toThrow(/artifact origin must differ/);
  });

  it("fails on invalid jurisdiction", () => {
    expect(() => validateControlEnv(validEnv({ JURISDICTION: "mars" }))).toThrow(
      /invalid jurisdiction/,
    );
  });
});

describe("isWorkerFirstPath", () => {
  it("protects API auth MCP realtime runner webhook and discovery paths", () => {
    expect(isWorkerFirstPath("/api/v1/tasks")).toBe(true);
    expect(isWorkerFirstPath("/auth/sign-in")).toBe(true);
    expect(isWorkerFirstPath("/mcp")).toBe(true);
    expect(isWorkerFirstPath("/realtime/workspaces/x")).toBe(true);
    expect(isWorkerFirstPath("/runner/connect")).toBe(true);
    expect(isWorkerFirstPath("/webhooks/github")).toBe(true);
    expect(isWorkerFirstPath("/.well-known/oauth-authorization-server")).toBe(true);
  });

  it("leaves SPA paths to assets", () => {
    expect(isWorkerFirstPath("/")).toBe(false);
    expect(isWorkerFirstPath("/w/demo")).toBe(false);
    expect(isWorkerFirstPath("/settings")).toBe(false);
  });
});
