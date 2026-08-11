// ABOUTME: Exercises BFB-owned passkey routes, fresh GitHub reauthentication, and route hiding.
// ABOUTME: Session-only, cross-session, replayed, malformed, and unverified flows fail closed.

import { afterEach, describe, expect, it, vi } from "vitest";

import { FIX, seedSyntheticWorkspace } from "@bfb/domain";

import { parseAuthKeys } from "../src/auth/better-auth.js";
import { validateControlEnv, type ControlBindings } from "../src/env.js";
import { createControlApp } from "../src/routes.js";
import {
  AUTH_TEST_ENV,
  openAuthTestContext,
  seedAuthSession,
  type AuthTestContext,
} from "./auth-helpers.js";

const NOW = "2026-08-11T20:00:00Z";

function fakeBinding<T extends object>(label: string): T {
  return { __synthetic: label } as unknown as T;
}

function bindings(): ControlBindings {
  return {
    DB: fakeBinding<D1Database>("db"),
    ARTIFACTS: fakeBinding<R2Bucket>("r2"),
    ASSETS: fakeBinding<Fetcher>("assets"),
    JOBS: fakeBinding<Queue>("jobs"),
    JOBS_DLQ: fakeBinding<Queue>("dlq"),
    WORKSPACE_HUB: fakeBinding<DurableObjectNamespace>("hub"),
    APP_ORIGIN: AUTH_TEST_ENV.APP_ORIGIN,
    ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
    LAUNCH_ORIGIN: "https://launch.bfb.example.test",
    JURISDICTION: "eu",
    ENVIRONMENT: "local",
  };
}

function appFor(context: AuthTestContext) {
  return createControlApp(validateControlEnv(bindings()), {
    db: context.db,
    now: NOW,
    humanAuth: () => ({
      auth: context.auth,
      keys: parseAuthKeys(AUTH_TEST_ENV.BETTER_AUTH_SECRETS),
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
    }),
  });
}

function responseCookies(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .filter((value): value is string => Boolean(value))
    .join("; ");
}

function mergeCookies(...headers: string[]): string {
  const cookies = new Map<string, string>();
  for (const header of headers) {
    for (const item of header.split(/;\s*/)) {
      const separator = item.indexOf("=");
      if (separator > 0) {
        cookies.set(item.slice(0, separator), item.slice(separator + 1));
      }
    }
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function prepareHuman(context: AuthTestContext) {
  await seedSyntheticWorkspace(context.db, NOW);
  const session = await seedAuthSession(context, {
    userId: "auth-owner-c03",
    sessionId: "auth-owner-c03-session",
    token: "auth-owner-c03-token",
    email: "owner@synthetic.test",
    name: "Synthetic Owner",
    humanId: FIX.owner,
  });
  context.raw
    .prepare(
      `INSERT INTO better_auth_accounts
       (id, account_id, provider_id, user_id, access_token, refresh_token, id_token,
        access_token_expires_at, refresh_token_expires_at, scope, password, created_at, updated_at)
       VALUES ('account-owner-c03', '4242', 'github', ?, NULL, NULL, NULL,
               NULL, NULL, NULL, NULL, ?, ?)`,
    )
    .run(session.userId, NOW, NOW);
  return session;
}

async function csrfFor(app: ReturnType<typeof appFor>, cookie: string): Promise<string> {
  const response = await app.request(
    new Request(`${AUTH_TEST_ENV.APP_ORIGIN}/auth/session`, { headers: { cookie } }),
    undefined,
    bindings(),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { csrf_token: string }).csrf_token;
}

function passkeyPost(path: string, cookie: string, csrf: string, body: unknown): Request {
  return new Request(AUTH_TEST_ENV.APP_ORIGIN + path, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      origin: AUTH_TEST_ENV.APP_ORIGIN,
      "sec-fetch-site": "same-origin",
      "x-bfb-csrf": csrf,
      "cf-connecting-ip": "192.0.2.33",
    },
    body: JSON.stringify(body),
  });
}

function mockGitHub(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const request = input instanceof Request ? input : new Request(input);
      if (request.url === "https://github.com/login/oauth/access_token") {
        return Response.json({
          access_token: "github-reauth-access-token",
          token_type: "bearer",
          scope: "read:user,user:email",
        });
      }
      if (request.url === "https://api.github.com/user") {
        return Response.json({
          id: 4242,
          login: "owner-c03",
          name: "Synthetic Owner",
          email: null,
          avatar_url: "https://avatars.example.test/c03.png",
        });
      }
      if (request.url === "https://api.github.com/user/emails") {
        return Response.json([{ email: "owner@synthetic.test", primary: true, verified: true }]);
      }
      throw new Error(`unexpected provider request: ${request.url}`);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BFB passkey routes", () => {
  it("requires a fresh action-bound GitHub round trip for initial enrollment", async () => {
    const context = openAuthTestContext();
    const session = await prepareHuman(context);
    const app = appFor(context);
    const csrf = await csrfFor(app, session.cookie);

    const started = await app.request(
      passkeyPost("/auth/passkeys/enroll/start", session.cookie, csrf, {}),
      undefined,
      bindings(),
    );
    expect(started.status).toBe(200);
    const body = (await started.clone().json()) as {
      flow_id: string;
      requires_reauthentication: boolean;
      url: string;
    };
    expect(body.requires_reauthentication).toBe(true);
    expect(body.flow_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.url).not.toContain("completion=");

    const direct = await app.request(
      new Request(
        `${AUTH_TEST_ENV.APP_ORIGIN}/auth/passkeys/enroll/reauth?flow_id=${body.flow_id}`,
        { headers: { cookie: session.cookie, "cf-connecting-ip": "192.0.2.34" } },
      ),
      undefined,
      bindings(),
    );
    expect(direct.status).toBe(403);

    const authorize = new URL(body.url);
    const state = authorize.searchParams.get("state");
    expect(state).toBeTruthy();
    mockGitHub();
    const callback = new URL(`${AUTH_TEST_ENV.APP_ORIGIN}/auth/callback/github`);
    callback.searchParams.set("code", "fresh-github-code-c03");
    callback.searchParams.set("state", state!);
    const callbackResponse = await app.request(
      new Request(callback, {
        headers: {
          cookie: mergeCookies(session.cookie, responseCookies(started)),
          "cf-connecting-ip": "192.0.2.35",
        },
      }),
      undefined,
      bindings(),
    );
    expect(callbackResponse.status).toBe(302);
    const completionLocation = callbackResponse.headers.get("location");
    expect(completionLocation).toContain("/auth/passkeys/enroll/reauth?");
    expect(completionLocation).toContain("completion=");
    const freshCookie = mergeCookies(session.cookie, responseCookies(callbackResponse));

    const completed = await app.request(
      new Request(completionLocation!, {
        headers: { cookie: freshCookie, "cf-connecting-ip": "192.0.2.35" },
      }),
      undefined,
      bindings(),
    );
    expect(completed.status).toBe(302);
    expect(completed.headers.get("location")).toBe(
      `/settings/security?passkey_enrollment=${body.flow_id}`,
    );

    const replay = await app.request(
      new Request(completionLocation!, {
        headers: { cookie: freshCookie, "cf-connecting-ip": "192.0.2.35" },
      }),
      undefined,
      bindings(),
    );
    expect(replay.status).toBe(403);

    const freshCsrf = await csrfFor(app, freshCookie);
    const options = await app.request(
      passkeyPost("/auth/passkeys/enroll/options", freshCookie, freshCsrf, {
        flow_id: body.flow_id,
        name: "Primary",
      }),
      undefined,
      bindings(),
    );
    expect(options.status, await options.clone().text()).toBe(200);
    const optionsBody = (await options.json()) as {
      options: { rp: { id: string }; authenticatorSelection?: { userVerification?: string } };
    };
    expect(optionsBody.options.rp.id).toBe("bfb.example.test");
    expect(optionsBody.options.authenticatorSelection?.userVerification).toBe("required");
  });

  it("hides ordinary Better Auth passkey mutations and rejects a cookie-only shortcut", async () => {
    const context = openAuthTestContext();
    const session = await prepareHuman(context);
    const app = appFor(context);
    const csrf = await csrfFor(app, session.cookie);

    for (const path of [
      "/auth/passkey/generate-register-options",
      "/auth/passkey/verify-registration",
      "/auth/passkey/delete-passkey",
      "/auth/passkey/update-passkey",
    ]) {
      const response = await app.request(
        passkeyPost(path, session.cookie, csrf, {}),
        undefined,
        bindings(),
      );
      expect(response.status, path).toBe(404);
    }

    const optionsWithoutFlow = await app.request(
      passkeyPost("/auth/passkeys/enroll/options", session.cookie, csrf, {
        flow_id: "01JBFB0MISSINGC03000000000",
      }),
      undefined,
      bindings(),
    );
    expect(optionsWithoutFlow.status).toBe(403);
    expect(context.raw.prepare("SELECT COUNT(*) AS count FROM better_auth_passkeys").get()).toEqual(
      {
        count: 0,
      },
    );
  });

  it("requires origin, Fetch Metadata, CSRF, bounded bodies, and a registered passkey", async () => {
    const context = openAuthTestContext();
    const session = await prepareHuman(context);
    const app = appFor(context);
    const csrf = await csrfFor(app, session.cookie);
    const action = {
      action: "oauth.delegation.create",
      clientId: FIX.client,
      resource: `${AUTH_TEST_ENV.APP_ORIGIN}/mcp`,
      workspaceId: FIX.workspace,
      projectId: FIX.projectA,
      scopes: ["bfb:read"],
      authorizationEpoch: 1,
    };

    for (const headers of [
      { cookie: session.cookie, "x-bfb-csrf": csrf },
      {
        cookie: session.cookie,
        "x-bfb-csrf": csrf,
        origin: "https://hostile.example",
        "sec-fetch-site": "cross-site",
      },
      {
        cookie: session.cookie,
        origin: AUTH_TEST_ENV.APP_ORIGIN,
        "sec-fetch-site": "same-origin",
      },
    ]) {
      const response = await app.request(
        new Request(`${AUTH_TEST_ENV.APP_ORIGIN}/auth/step-up/options`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ action }),
        }),
        undefined,
        bindings(),
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
    }

    const noPasskey = await app.request(
      passkeyPost("/auth/step-up/options", session.cookie, csrf, { action }),
      undefined,
      bindings(),
    );
    expect(noPasskey.status).toBe(403);

    const oversized = await app.request(
      new Request(`${AUTH_TEST_ENV.APP_ORIGIN}/auth/step-up/options`, {
        method: "POST",
        headers: {
          cookie: session.cookie,
          "content-type": "application/json",
          origin: AUTH_TEST_ENV.APP_ORIGIN,
          "sec-fetch-site": "same-origin",
          "x-bfb-csrf": csrf,
        },
        body: JSON.stringify({ action, padding: "x".repeat(17_000) }),
      }),
      undefined,
      bindings(),
    );
    expect(oversized.status).toBe(429);
  });
});
