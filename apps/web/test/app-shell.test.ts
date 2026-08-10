// ABOUTME: Tests the authenticated AppShell sign-in, board load, and work mutations.
// ABOUTME: Uses a fetch stub that drives the real control-worker app with fixture DB.

import { describe, expect, it } from "vitest";

import { openDomainDb } from "../../../packages/domain/test/helpers.js";
import { FIX } from "../../../packages/domain/src/fixtures.js";
import { SYNTHETIC_PASSWORD } from "../../../packages/domain/src/passwords.js";
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

  it("signs in with password, loads board, and mutates work", async () => {
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

    // Empty password rejected.
    const emptyPassword = await fetchImpl("/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@synthetic.test", password: "" }),
    });
    expect(emptyPassword.status).toBe(400);

    // Wrong password rejected.
    const wrongPassword = await fetchImpl("/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@synthetic.test", password: "wrong" }),
    });
    expect(wrongPassword.status).toBe(401);

    const signIn = await fetchImpl("/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@synthetic.test", password: SYNTHETIC_PASSWORD }),
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

    // Create task + comment + context + propose through real work APIs.
    const created = await fetchImpl(`/api/v1/workspaces/${FIX.workspace}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project_id: FIX.projectA,
        title: "UI created task",
        priority: "P1",
        request_id: "ui-create-1",
      }),
    });
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as {
      ok: boolean;
      result: { id: string; state: string };
    };
    expect(createdBody.ok).toBe(true);
    expect(createdBody.result.state).toBe("ready");

    const proposed = await fetchImpl(`/api/v1/workspaces/${FIX.workspace}/tasks/propose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project_id: FIX.projectA,
        title: "UI proposed",
        priority: "P2",
        request_id: "ui-propose-1",
      }),
    });
    expect(proposed.status).toBe(200);
    const proposedBody = (await proposed.json()) as {
      ok: boolean;
      result: { id: string; state: string };
    };
    expect(proposedBody.ok).toBe(true);
    expect(proposedBody.result.state).toBe("proposed");

    const comment = await fetchImpl(
      `/api/v1/workspaces/${FIX.workspace}/tasks/${createdBody.result.id}/comments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "UI comment", kind: "discussion", request_id: "ui-cmt-1" }),
      },
    );
    expect(comment.status).toBe(200);

    const context = await fetchImpl(
      `/api/v1/workspaces/${FIX.workspace}/tasks/${createdBody.result.id}/context`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          audience: "agent",
          body: "UI agent context",
          request_id: "ui-ctx-1",
        }),
      },
    );
    expect(context.status).toBe(200);

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
      body: JSON.stringify({
        email: "restricted@synthetic.test",
        password: SYNTHETIC_PASSWORD,
      }),
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
