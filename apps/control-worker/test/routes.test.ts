// ABOUTME: Exercises Control Worker route shells through the real Hono app factory.
// ABOUTME: Confirms reserved paths fail closed without product handlers yet.

import { describe, expect, it } from "vitest";

import { createControlApp } from "../src/routes.js";
import { validateControlEnv, type ControlBindings } from "../src/env.js";

function fakeBinding<T extends object>(label: string): T {
  return { __synthetic: label } as unknown as T;
}

function env(): ControlBindings {
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
  };
}

async function request(path: string): Promise<Response> {
  const validated = validateControlEnv(env());
  const app = createControlApp(validated);
  return app.request(path, {}, env());
}

describe("control routes", () => {
  it("serves healthz with substrate metadata", async () => {
    const response = await request("/healthz");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { package: string; environment: string };
    expect(body.package).toBe("F03");
    expect(body.environment).toBe("local");
  });

  it("reserves mcp without implementing protocol", async () => {
    const response = await request("/mcp");
    expect(response.status).toBe(501);
  });

  it("reserves auth without enabling Better Auth routes", async () => {
    const response = await request("/auth/sign-in");
    expect(response.status).toBe(501);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("auth_not_implemented");
  });
});
