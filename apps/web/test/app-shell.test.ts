// ABOUTME: Tests the authenticated AppShell sign-in, board load, and work mutations.
// ABOUTME: Uses a fetch stub that drives the real control-worker app with fixture DB.

import { describe, expect, it } from "vitest";

import { FIX, seedSyntheticWorkspace } from "../../../packages/domain/src/fixtures.js";
import { parseAuthKeys } from "../../control-worker/src/auth/better-auth.js";
import { validateControlEnv, type ControlBindings } from "../../control-worker/src/env.js";
import { createControlApp } from "../../control-worker/src/routes.js";
import { createTestWorkspaceHubNamespace } from "../../control-worker/src/hub-client.js";
import {
  AUTH_TEST_ENV,
  openAuthTestContext,
  seedAuthSession,
} from "../../control-worker/test/auth-helpers.js";
import { parseWorkspaceSlugForTest } from "../src/routing.js";

function fakeBinding<T extends object>(label: string): T {
  return { __synthetic: label } as unknown as T;
}

function env(db?: import("@bfb/db").SqlDatabase): ControlBindings {
  return {
    DB: fakeBinding<D1Database>("db"),
    ARTIFACTS: fakeBinding<R2Bucket>("r2"),
    ASSETS: fakeBinding<Fetcher>("assets"),
    JOBS: fakeBinding<Queue>("jobs"),
    JOBS_DLQ: fakeBinding<Queue>("dlq"),
    WORKSPACE_HUB: db
      ? createTestWorkspaceHubNamespace(db)
      : fakeBinding<DurableObjectNamespace>("hub"),
    APP_ORIGIN: "https://bfb.example.test",
    ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
    LAUNCH_ORIGIN: "https://launch.bfb.example.test",
    JURISDICTION: "eu",
    ENVIRONMENT: "local",
  };
}

describe("authenticated app shell routing", () => {
  it("parses /w/<slug> workspace paths", async () => {
    expect(parseWorkspaceSlugForTest("/w/synthetic")).toBe("synthetic");
    expect(parseWorkspaceSlugForTest("/")).toBeNull();
  });

  it("uses Better Auth sessions to load board and mutate work", async () => {
    const authContext = openAuthTestContext();
    await seedSyntheticWorkspace(authContext.db);
    const db = authContext.db;
    const validated = validateControlEnv(env());
    const app = createControlApp(validated, {
      db,
      now: "2026-08-07T12:00:00Z",
      humanAuth: () => ({
        auth: authContext.auth,
        keys: parseAuthKeys(AUTH_TEST_ENV.BETTER_AUTH_SECRETS),
        abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
      }),
    });
    const cookies = new Map<string, string>();
    let csrfToken = "";
    const ownerSession = await seedAuthSession(authContext, {
      userId: "auth-owner-web",
      sessionId: "auth-owner-web-session",
      token: "auth-owner-web-token",
      email: "owner@synthetic.test",
      name: "Synthetic Owner",
      humanId: FIX.owner,
    });
    cookies.set("__Host-bfb_session", ownerSession.cookie.split("=", 2)[1] ?? "");

    const fetchImpl: typeof fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? new URL(input, "https://bfb.example.test")
          : input instanceof URL
            ? input
            : new URL(input.url);
      const headers = new Headers(init?.headers);
      if (!headers.has("origin")) {
        headers.set("origin", "https://bfb.example.test");
      }
      if (!headers.has("sec-fetch-site")) {
        headers.set("sec-fetch-site", "same-origin");
      }
      if (cookies.has("__Host-bfb_session")) {
        headers.set("cookie", "__Host-bfb_session=" + cookies.get("__Host-bfb_session"));
      }
      if (
        csrfToken &&
        !headers.has("x-bfb-csrf") &&
        (init?.method ?? "GET").toUpperCase() !== "GET"
      ) {
        headers.set("x-bfb-csrf", csrfToken);
      }
      // Hono: third arg is Worker bindings (Env); second is RequestInit only.
      const response = await app.request(
        new Request(url.toString(), { ...init, headers }),
        undefined,
        env(db),
      );
      const setCookie = response.headers.get("set-cookie");
      if (setCookie?.includes("__Host-bfb_session=")) {
        const value = setCookie.split(";")[0]?.split("=")[1];
        if (value) {
          cookies.set("__Host-bfb_session", decodeURIComponent(value));
        }
      }
      return response;
    };

    const session = await fetchImpl("/auth/session");
    expect(session.status).toBe(200);
    const sessionBody = (await session.json()) as { csrf_token?: string };
    csrfToken = sessionBody.csrf_token ?? "";
    expect(csrfToken.length).toBeGreaterThan(10);

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
    let restrictedCsrf = "";
    const restrictedSession = await seedAuthSession(authContext, {
      userId: "auth-restricted-web",
      sessionId: "auth-restricted-web-session",
      token: "auth-restricted-web-token",
      email: "restricted@synthetic.test",
      name: "Synthetic Restricted",
      humanId: FIX.restricted,
    });
    restrictedCookies.set("__Host-bfb_session", restrictedSession.cookie.split("=", 2)[1] ?? "");
    const restrictedFetch: typeof fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? new URL(input, "https://bfb.example.test")
          : input instanceof URL
            ? input
            : new URL(input.url);
      const headers = new Headers(init?.headers);
      if (!headers.has("origin")) {
        headers.set("origin", "https://bfb.example.test");
      }
      if (!headers.has("sec-fetch-site")) {
        headers.set("sec-fetch-site", "same-origin");
      }
      if (restrictedCookies.has("__Host-bfb_session")) {
        headers.set("cookie", "__Host-bfb_session=" + restrictedCookies.get("__Host-bfb_session"));
      }
      if (
        restrictedCsrf &&
        !headers.has("x-bfb-csrf") &&
        (init?.method ?? "GET").toUpperCase() !== "GET"
      ) {
        headers.set("x-bfb-csrf", restrictedCsrf);
      }
      const response = await app.request(
        new Request(url.toString(), { ...init, headers }),
        undefined,
        env(db),
      );
      const setCookie = response.headers.get("set-cookie");
      if (setCookie?.includes("__Host-bfb_session=")) {
        const value = setCookie.split(";")[0]?.split("=")[1];
        if (value) {
          restrictedCookies.set("__Host-bfb_session", decodeURIComponent(value));
        }
      }
      return response;
    };
    const restrictedAuth = await restrictedFetch("/auth/session");
    expect(restrictedAuth.status).toBe(200);
    restrictedCsrf = ((await restrictedAuth.json()) as { csrf_token?: string }).csrf_token ?? "";
    const restrictedBoard = await restrictedFetch(`/api/v1/workspaces/${FIX.workspace}/board`);
    expect(restrictedBoard.status).toBe(200);
    const restrictedBody = (await restrictedBoard.json()) as {
      role: string;
      lanes: Array<{ projectId: string }>;
    };
    expect(restrictedBody.role).toBe("reviewer");
    expect(restrictedBody.lanes.every((lane) => lane.projectId === FIX.projectA)).toBe(true);
  });
});
