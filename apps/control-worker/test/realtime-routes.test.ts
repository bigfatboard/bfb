// ABOUTME: Exercises the browser realtime upgrade through production cookie auth and roles.
// ABOUTME: Asserts credential separation and secret-free hub forwarding without opening sockets.

import { describe, expect, it } from "vitest";

import { FIX, seedSyntheticWorkspace } from "@bfb/domain";

import { handleBrowserRealtimeApi } from "../src/api/realtime.js";
import type { BrowserPrincipal } from "../src/auth/session.js";
import { parseAuthKeys } from "../src/auth/better-auth.js";
import { validateControlEnv, type ControlBindings } from "../src/env.js";
import { createControlApp } from "../src/routes.js";
import { AUTH_TEST_ENV, openAuthTestContext, seedAuthSession } from "./auth-helpers.js";

const ORIGIN = AUTH_TEST_ENV.APP_ORIGIN;
const NOW = "2026-08-11T20:00:00.000Z";
const UPGRADE = {
  upgrade: "websocket",
  "sec-websocket-protocol": "bfb.browser.v1",
  origin: ORIGIN,
};

async function fixture() {
  const context = openAuthTestContext(NOW);
  await seedSyntheticWorkspace(context.db, NOW);
  const owner = await seedAuthSession(context, {
    userId: "auth-user-e02-owner",
    sessionId: "auth-session-e02-owner",
    token: "auth-token-e02-owner",
    email: "owner@synthetic.test",
    name: "Synthetic Owner",
    humanId: FIX.owner,
  });
  const reviewer = await seedAuthSession(context, {
    userId: "auth-user-e02-reviewer",
    sessionId: "auth-session-e02-reviewer",
    token: "auth-token-e02-reviewer",
    email: "restricted@synthetic.test",
    name: "Synthetic Restricted",
    humanId: FIX.restricted,
  });
  const expired = await seedAuthSession(context, {
    userId: "auth-user-e02-expired",
    sessionId: "auth-session-e02-expired",
    token: "auth-token-e02-expired",
    email: "expired@synthetic.test",
    name: "Synthetic Expired",
    expiresAt: "2026-08-11T19:00:00.000Z",
  });
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const hubNamespace = {
    jurisdiction() {
      return hubNamespace;
    },
    idFromName(name: string) {
      return { name, toString: () => name };
    },
    get(_id: { name: string }) {
      return {
        async fetch(url: string, init: RequestInit): Promise<Response> {
          calls.push({ url, init });
          // Node cannot construct a 101 response; the stub echoes so the
          // unit can assert the forwarded handshake. The live 101 path is
          // proven by the E02 workerd harness.
          return Response.json({ forwarded: true });
        },
      };
    },
  };
  const env = {
    DB: {},
    ARTIFACTS: {},
    ASSETS: {},
    JOBS: {},
    JOBS_DLQ: {},
    WORKSPACE_HUB: hubNamespace,
    APP_ORIGIN: ORIGIN,
    ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
    LAUNCH_ORIGIN: "https://launch.bfb.example.test",
    JURISDICTION: "eu",
    ENVIRONMENT: "local",
  } as unknown as ControlBindings;
  function app() {
    return createControlApp(validateControlEnv(env), {
      db: context.db,
      now: NOW,
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
      humanAuth: () => ({
        auth: context.auth,
        keys: parseAuthKeys(AUTH_TEST_ENV.BETTER_AUTH_SECRETS),
        abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
      }),
    });
  }
  const path = `/realtime/workspaces/${FIX.workspace}/subscribe`;
  function get(cookie: string, headers: Record<string, string> = {}) {
    return app().request(
      new Request(`${ORIGIN}${path}`, { headers: { cookie, ...UPGRADE, ...headers } }),
      undefined,
      env,
    );
  }
  const ownerPrincipal: BrowserPrincipal = {
    type: "human",
    humanId: FIX.owner,
    authUserId: "auth-user-e02-owner",
    email: "owner@synthetic.test",
    emailVerified: true,
    displayName: "Synthetic Owner",
    sessionId: "auth-session-e02-owner",
  };
  return { context, app, env, get, path, calls, owner, reviewer, expired, ownerPrincipal };
}

describe("browser realtime upgrade", () => {
  it("rejects anonymous, bearer, cross-origin, and malformed upgrades", async () => {
    const f = await fixture();
    expect((await f.get("")).status).toBe(401);
    expect(
      (
        await f.get(f.owner.cookie, {
          authorization: "Bearer [REDACTED]",
        })
      ).status,
    ).toBe(401);
    expect((await f.get(f.owner.cookie, { origin: "https://evil.example.test" })).status).toBe(403);
    expect((await f.get(f.owner.cookie, { upgrade: "h2c" })).status).toBe(400);
    expect(
      (await f.get(f.owner.cookie, { "sec-websocket-protocol": "bfb.runner.v1" })).status,
    ).toBe(400);
    const queried = await f.app().request(
      new Request(`${ORIGIN}${f.path}?client_cursor=3`, {
        headers: { cookie: f.owner.cookie, ...UPGRADE },
      }),
      undefined,
      f.env,
    );
    expect(queried.status).toBe(400);
    const posted = await f.app().request(
      new Request(`${ORIGIN}${f.path}`, {
        method: "POST",
        headers: { cookie: f.owner.cookie, ...UPGRADE },
      }),
      undefined,
      f.env,
    );
    expect(posted.status).toBe(400);
    const unknown = await f.app().request(
      new Request(`${ORIGIN}/realtime/workspaces/${FIX.workspace}/publish`, {
        headers: { cookie: f.owner.cookie, ...UPGRADE },
      }),
      undefined,
      f.env,
    );
    expect(unknown.status).toBe(404);
  });

  it("keeps reviewers project-scoped and rejects expired sessions", async () => {
    const f = await fixture();
    const reviewer = await f.get(f.reviewer.cookie);
    expect(reviewer.status).toBe(403);
    expect(f.calls).toEqual([]);
    const expired = await f.get(f.expired.cookie);
    expect(expired.status).toBe(401);
    expect(f.calls).toEqual([]);
  });

  it("forwards an authenticated upgrade with IDs, epochs, and expiry but no secrets", async () => {
    const f = await fixture();
    // A live 101 upgrade cannot round-trip through Hono in Node; the
    // switching-protocol path is proven by the E02 workerd harness while this
    // unit asserts the exact forwarded handshake.
    const response = await handleBrowserRealtimeApi(
      new Request(`${ORIGIN}${f.path}`, { headers: { cookie: f.owner.cookie, ...UPGRADE } }),
      {
        db: f.context.db,
        principal: f.ownerPrincipal,
        workspaceId: FIX.workspace,
        now: NOW,
        jurisdiction: "eu",
        appOrigin: ORIGIN,
        abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
        workspaceHubNs: f.env.WORKSPACE_HUB,
        auth: f.context.auth,
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ forwarded: true });
    expect(f.calls).toHaveLength(1);
    const call = f.calls[0] as { url: string; init: RequestInit };
    expect(call.url).toBe("https://bfb-hub.internal/browser/connect");
    const headers = new Headers(call.init.headers);
    expect(headers.get("upgrade")).toBe("websocket");
    expect(headers.get("sec-websocket-protocol")).toBe("bfb.browser.v1");
    const principal = JSON.parse(headers.get("x-bfb-browser-principal") as string) as Record<
      string,
      unknown
    >;
    expect(principal).toMatchObject({
      schema_version: 1,
      workspaceId: FIX.workspace,
      humanId: FIX.owner,
      authorizationEpoch: 1,
      role: "owner",
    });
    expect(typeof principal.sessionExpiresAt).toBe("string");
    expect(Object.keys(principal).sort()).toEqual(
      [
        "authorizationEpoch",
        "humanId",
        "role",
        "schema_version",
        "sessionExpiresAt",
        "sessionId",
        "workspaceId",
      ].sort(),
    );
    const forwarded = JSON.stringify(principal);
    expect(forwarded).not.toContain("auth-token-e02-owner");
    expect(forwarded).not.toContain(f.owner.cookie);
    expect(forwarded.toLowerCase()).not.toContain("cookie");
    expect(forwarded.toLowerCase()).not.toContain("bearer");
  });
});
