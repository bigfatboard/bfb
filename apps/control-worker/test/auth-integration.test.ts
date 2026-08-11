// ABOUTME: Exercises GitHub OAuth, D1-backed sessions, normalization, and route separation.
// ABOUTME: Provider HTTP is deterministic while Better Auth owns the real OAuth state machine.

import { afterEach, describe, expect, it, vi } from "vitest";
import { symmetricDecrypt } from "better-auth/crypto";

import { parseAuthKeys } from "../src/auth/better-auth.js";
import { SESSION_COOKIE } from "../src/auth/session.js";
import { validateControlEnv, type ControlBindings } from "../src/env.js";
import { createControlApp } from "../src/routes.js";
import { AUTH_TEST_ENV, openAuthTestContext, type AuthTestContext } from "./auth-helpers.js";

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
    now: "2026-08-11T20:00:00Z",
    humanAuth: () => ({
      auth: context.auth,
      keys: parseAuthKeys(AUTH_TEST_ENV.BETTER_AUTH_SECRETS),
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
    }),
  });
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .filter((value): value is string => Boolean(value))
    .join("; ");
}

async function beginGitHubSignIn(context: AuthTestContext) {
  const app = appFor(context);
  const response = await app.request(
    new Request(`${AUTH_TEST_ENV.APP_ORIGIN}/auth/sign-in/github`, {
      method: "POST",
      headers: {
        origin: AUTH_TEST_ENV.APP_ORIGIN,
        "sec-fetch-site": "same-origin",
        "cf-connecting-ip": "192.0.2.10",
      },
    }),
    undefined,
    bindings(),
  );
  const body = (await response.json()) as { redirect: boolean; url: string };
  return { app, body, cookies: cookieHeader(response), response };
}

function mockGitHub(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const request = input instanceof Request ? input : new Request(input);
      if (request.url === "https://github.com/login/oauth/access_token") {
        return Response.json({
          access_token: "github-access-token-plain",
          refresh_token: "github-refresh-token-plain",
          token_type: "bearer",
          scope: "read:user,user:email",
        });
      }
      if (request.url === "https://api.github.com/user") {
        return Response.json({
          id: 4242,
          login: "c02-human",
          name: "C02 Human",
          email: null,
          avatar_url: "https://avatars.example.test/c02.png",
        });
      }
      if (request.url === "https://api.github.com/user/emails") {
        return Response.json([
          { email: "c02-human@synthetic.test", primary: true, verified: true },
        ]);
      }
      throw new Error(`unexpected provider request: ${request.url}`);
    }),
  );
}

async function finishGitHubSignIn(context: AuthTestContext) {
  const started = await beginGitHubSignIn(context);
  expect(started.response.status).toBe(200);
  const authorize = new URL(started.body.url);
  expect(authorize.origin + authorize.pathname).toBe("https://github.com/login/oauth/authorize");
  expect(authorize.searchParams.get("client_id")).toBe(AUTH_TEST_ENV.GITHUB_CLIENT_ID);
  expect(authorize.searchParams.get("redirect_uri")).toBe(
    `${AUTH_TEST_ENV.APP_ORIGIN}/auth/callback/github`,
  );
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorize.searchParams.get("scope")?.split(" ").sort()).toEqual([
    "read:user",
    "user:email",
  ]);
  const state = authorize.searchParams.get("state");
  expect(state).toBeTruthy();

  mockGitHub();
  const callback = new URL(`${AUTH_TEST_ENV.APP_ORIGIN}/auth/callback/github`);
  callback.searchParams.set("code", "github-code-c02");
  callback.searchParams.set("state", state!);
  const response = await started.app.request(
    new Request(callback, { headers: { cookie: started.cookies } }),
    undefined,
    bindings(),
  );
  return { ...started, callback: response, sessionCookies: cookieHeader(response) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitHub human identity integration", () => {
  it("creates an encrypted Better Auth session and permission-free BFB principal", async () => {
    const context = openAuthTestContext();
    const completed = await finishGitHubSignIn(context);
    expect(completed.callback.status).toBe(302);
    expect(completed.callback.headers.get("location")).toBe("/");
    expect(completed.sessionCookies).toContain(`${SESSION_COOKIE}=`);

    const session = await completed.app.request(
      new Request(`${AUTH_TEST_ENV.APP_ORIGIN}/auth/session`, {
        headers: { cookie: completed.sessionCookies },
      }),
      undefined,
      bindings(),
    );
    expect(session.status).toBe(200);
    const body = (await session.json()) as {
      authenticated: boolean;
      human: { id: string; email: string; display_name: string };
      csrf_token: string;
    };
    expect(body).toMatchObject({
      authenticated: true,
      human: {
        id: expect.stringMatching(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
        email: "c02-human@synthetic.test",
        display_name: "C02 Human",
      },
      csrf_token: expect.stringMatching(/^2\.[0-9a-f]{64}$/),
    });
    expect(context.raw.prepare("SELECT COUNT(*) AS count FROM workspace_members").get()).toEqual({
      count: 0,
    });
    const account = context.raw
      .prepare(
        `SELECT provider_id, access_token, refresh_token
         FROM better_auth_accounts WHERE provider_id = 'github'`,
      )
      .get() as { provider_id: string; access_token: string; refresh_token: string };
    expect(account.provider_id).toBe("github");
    expect(account.access_token).toMatch(/^\$ba\$2\$/);
    expect(account.refresh_token).toMatch(/^\$ba\$2\$/);
    expect(JSON.stringify(account)).not.toContain("github-access-token-plain");
    expect(JSON.stringify(account)).not.toContain("github-refresh-token-plain");
    const previousKey = parseAuthKeys(AUTH_TEST_ENV.BETTER_AUTH_SECRETS)[0]!;
    const rotatedKeys = parseAuthKeys(
      `3:c02-next-signing-and-encryption-key-2c61a4,${previousKey.version}:${previousKey.value}`,
    );
    const secretConfig = {
      keys: new Map(rotatedKeys.map((key) => [key.version, key.value])),
      currentVersion: rotatedKeys[0]!.version,
    };
    expect(await symmetricDecrypt({ key: secretConfig, data: account.access_token })).toBe(
      "github-access-token-plain",
    );
  });

  it("does not implicitly link an existing normalized human by email", async () => {
    const context = openAuthTestContext();
    context.raw
      .prepare(
        `INSERT INTO humans (id, email, display_name, created_at)
         VALUES ('01JBFB0HVMANC0200000000000', 'c02-human@synthetic.test', 'Existing',
                 '2026-08-11T19:00:00Z')`,
      )
      .run();
    const completed = await finishGitHubSignIn(context);
    expect(completed.callback.status).toBe(302);
    const session = await completed.app.request(
      new Request(`${AUTH_TEST_ENV.APP_ORIGIN}/auth/session`, {
        headers: { cookie: completed.sessionCookies },
      }),
      undefined,
      bindings(),
    );
    expect(session.status).toBe(409);
    expect(
      context.raw
        .prepare("SELECT better_auth_user_id FROM humans WHERE email = ?")
        .get("c02-human@synthetic.test"),
    ).toEqual({ better_auth_user_id: null });
  });

  it("keeps password, user mutation, and organization-style paths unreachable", async () => {
    const context = openAuthTestContext();
    const app = appFor(context);
    for (const path of [
      "/auth/sign-in/email",
      "/auth/sign-up/email",
      "/auth/delete-user",
      "/auth/update-user",
      "/auth/organization/create",
    ]) {
      const response = await app.request(
        new Request(AUTH_TEST_ENV.APP_ORIGIN + path, {
          method: "POST",
          headers: {
            origin: AUTH_TEST_ENV.APP_ORIGIN,
            "sec-fetch-site": "same-origin",
          },
        }),
        undefined,
        bindings(),
      );
      expect(response.status, path).toBe(404);
    }
  });

  it("shares durable public-auth abuse limits across app instances", async () => {
    const context = openAuthTestContext();
    const apps = [appFor(context), appFor(context)];
    const statuses: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      const response = await apps[index % apps.length]!.request(
        new Request(`${AUTH_TEST_ENV.APP_ORIGIN}/auth/sign-in/github`, {
          method: "POST",
          headers: {
            origin: AUTH_TEST_ENV.APP_ORIGIN,
            "sec-fetch-site": "same-origin",
            "cf-connecting-ip": "192.0.2.55",
          },
        }),
        undefined,
        bindings(),
      );
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(statuses[10]).toBe(429);
    const rows = context.raw
      .prepare("SELECT bucket_key, count FROM rate_limit_buckets")
      .all() as Array<{ bucket_key: string; count: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      bucket_key: expect.stringMatching(/^[0-9a-f]{64}$/),
      count: 11,
    });
    expect(JSON.stringify(rows)).not.toContain("192.0.2.55");
  });
});
