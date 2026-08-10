// ABOUTME: Tests the authenticated AppShell sign-in and Work surface open path.
// ABOUTME: Uses a fetch stub that drives the real control-worker app with fixture DB.

import { describe, expect, it } from "vitest";

import { openDomainDb } from "../../../packages/domain/test/helpers.js";
import { FIX } from "../../../packages/domain/src/fixtures.js";
import { validateControlEnv, type ControlBindings } from "../../control-worker/src/env.js";
import { createControlApp } from "../../control-worker/src/routes.js";
import { parseWorkspaceSlugForTest } from "../src/routing.js";

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

describe("authenticated app shell routing", () => {
  it("parses /w/<slug> workspace paths", () => {
    expect(parseWorkspaceSlugForTest("/w/synthetic")).toBe("synthetic");
    expect(parseWorkspaceSlugForTest("/")).toBeNull();
  });

  it("signs in and loads board for permitted role", async () => {
    const db = openDomainDb();
    const validated = validateControlEnv(env());
    const app = createControlApp(validated, { db, now: "2026-08-07T12:00:00Z" });
    const cookies = new Map<string, string>();

    const fetchImpl: typeof fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? new URL(input, "https://bfb.example.test")
          : input instanceof URL
            ? input
            : new URL(input.url);
      const headers = new Headers(init?.headers);
      if (cookies.has("bfb_session")) {
        headers.set("cookie", "bfb_session=" + cookies.get("bfb_session"));
      }
      const response = await app.request(new Request(url.toString(), { ...init, headers }), env());
      const setCookie = response.headers.get("set-cookie");
      if (setCookie?.includes("bfb_session=")) {
        const value = setCookie.split(";")[0]?.split("=")[1];
        if (value) {
          cookies.set("bfb_session", decodeURIComponent(value));
        }
      }
      return response;
    };

    const signIn = await fetchImpl("/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@synthetic.test" }),
    });
    expect(signIn.status).toBe(200);

    const board = await fetchImpl(`/api/v1/workspaces/${FIX.workspace}/board`);
    expect(board.status).toBe(200);
    const body = (await board.json()) as {
      role: string;
      lanes: unknown[];
      needs_now: unknown[];
      agent_work_available: boolean;
    };
    expect(body.role).toBe("owner");
    expect(body.lanes.length).toBeGreaterThan(0);
    expect(body.agent_work_available).toBe(false);

    // Restricted member only sees granted project via a fresh cookie jar.
    const restrictedCookies = new Map<string, string>();
    const restrictedFetch: typeof fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? new URL(input, "https://bfb.example.test")
          : input instanceof URL
            ? input
            : new URL(input.url);
      const headers = new Headers(init?.headers);
      if (restrictedCookies.has("bfb_session")) {
        headers.set("cookie", "bfb_session=" + restrictedCookies.get("bfb_session"));
      }
      const response = await app.request(new Request(url.toString(), { ...init, headers }), env());
      const setCookie = response.headers.get("set-cookie");
      if (setCookie?.includes("bfb_session=")) {
        const value = setCookie.split(";")[0]?.split("=")[1];
        if (value) {
          restrictedCookies.set("bfb_session", decodeURIComponent(value));
        }
      }
      return response;
    };
    const restrictedSignIn = await restrictedFetch("/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "restricted@synthetic.test" }),
    });
    expect(restrictedSignIn.status).toBe(200);
    const restrictedBoard = await restrictedFetch(`/api/v1/workspaces/${FIX.workspace}/board`);
    expect(restrictedBoard.status).toBe(200);
    const restrictedBody = (await restrictedBoard.json()) as {
      role: string;
      lanes: Array<{ projectId: string }>;
    };
    expect(restrictedBody.role).toBe("restricted_member");
    expect(restrictedBody.lanes.every((lane) => lane.projectId === FIX.projectA)).toBe(true);
  });
});
