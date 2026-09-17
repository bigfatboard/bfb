// ABOUTME: Exercises mounted CLI device bootstrap, exchange, and credential separation.
// ABOUTME: Real plugin codes prove single issuance, uniform failures, and route rejection.

import { describe, expect, it } from "vitest";

import { FIX, seedSyntheticWorkspace } from "@bfb/domain";

import { parseAuthKeys } from "../src/auth/better-auth.js";
import { validateControlEnv, type ControlBindings } from "../src/env.js";
import { createTestWorkspaceHubNamespace } from "../src/hub-client.js";
import { createControlApp } from "../src/routes.js";
import { handleCliBrowserApi, type CliApiDeps } from "../src/api/cli-credentials.js";
import { AUTH_TEST_ENV, openAuthTestContext, seedAuthSession } from "./auth-helpers.js";

const NOW = "2026-09-11T20:00:00.000Z";
const ORIGIN = AUTH_TEST_ENV.APP_ORIGIN;

async function fixture() {
  const context = openAuthTestContext(NOW);
  await seedSyntheticWorkspace(context.db, NOW);
  const session = await seedAuthSession(context, {
    userId: "cli-route-user",
    sessionId: "cli-route-session",
    token: "cli-route-token",
    humanId: FIX.owner,
    email: "owner@synthetic.test",
    now: NOW,
  });
  const fake = {};
  const env = {
    DB: fake,
    ARTIFACTS: fake,
    ASSETS: fake,
    JOBS: fake,
    JOBS_DLQ: fake,
    WORKSPACE_HUB: createTestWorkspaceHubNamespace(context.db),
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
  const authenticated = await app().request(
    new Request(ORIGIN + "/auth/session", { headers: { cookie: session.cookie } }),
    undefined,
    env,
  );
  expect(authenticated.status).toBe(200);
  const csrf = ((await authenticated.json()) as { csrf_token: string }).csrf_token;
  function browserHeaders(extra: Record<string, string> = {}) {
    return {
      cookie: session.cookie,
      origin: ORIGIN,
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      "x-bfb-csrf": csrf,
      ...extra,
    };
  }
  async function issue(ip = "192.0.2.101", scope?: string) {
    return app().request(
      new Request(ORIGIN + "/auth/device/code", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify(
          scope === undefined ? { client_id: "bfb-cli" } : { client_id: "bfb-cli", scope },
        ),
      }),
      undefined,
      env,
    );
  }
  async function authorize(userCode: string, ip = "192.0.2.101", projectIds: string[] = []) {
    return app().request(
      new Request(ORIGIN + `/api/v1/workspaces/${FIX.workspace}/cli/authorize`, {
        method: "POST",
        headers: { ...browserHeaders(), "cf-connecting-ip": ip },
        body: JSON.stringify({ user_code: userCode, project_ids: projectIds }),
      }),
      undefined,
      env,
    );
  }
  async function exchange(deviceCode: string, ip = "192.0.2.101") {
    return app().request(
      new Request(ORIGIN + "/api/v1/cli/exchange", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify({ client_id: "bfb-cli", device_code: deviceCode }),
      }),
      undefined,
      env,
    );
  }
  async function cliSession(credential: string) {
    return app().request(
      new Request(ORIGIN + "/api/v1/cli/session", {
        headers: { authorization: `Bearer ${credential}` },
      }),
      undefined,
      env,
    );
  }
  return {
    context,
    env,
    app,
    session,
    csrf,
    browserHeaders,
    issue,
    authorize,
    exchange,
    cliSession,
  };
}

describe("CLI device credentials", () => {
  it("runs issuance, approval, single exchange, session, and revocation", async () => {
    const f = await fixture();
    const issued = await f.issue();
    expect(issued.status).toBe(200);
    expect(issued.headers.get("cache-control")).toBe("no-store");
    const codes = (await issued.json()) as { device_code: string; user_code: string };
    expect(typeof codes.device_code).toBe("string");
    expect(typeof codes.user_code).toBe("string");

    const statusAnon = await f
      .app()
      .request(
        new Request(ORIGIN + `/auth/device?user_code=${encodeURIComponent(codes.user_code)}`, {
          headers: { "cf-connecting-ip": "192.0.2.101" },
        }),
        undefined,
        f.env,
      );
    expect(statusAnon.status).toBe(401);

    const authorized = await f.authorize(codes.user_code);
    expect(authorized.status, await authorized.clone().text()).toBe(201);
    const binding = ((await authorized.json()) as { binding: { binding_id: string } }).binding;
    expect(typeof binding.binding_id).toBe("string");

    const first = await f.exchange(codes.device_code);
    expect(first.status, await first.clone().text()).toBe(200);
    const credential = ((await first.json()) as { credential: string }).credential;
    expect(credential).toMatch(/^bfb_cli_[A-Za-z0-9_-]{43}$/);

    const replay = await f.exchange(codes.device_code);
    expect(replay.status).toBe(403);
    expect(await replay.json()).toEqual({ error: "request_rejected", message: "request rejected" });

    const whoami = await f.cliSession(credential);
    expect(whoami.status).toBe(200);
    const projection = (await whoami.json()) as Record<string, unknown>;
    expect(projection).toMatchObject({
      human_id: FIX.owner,
      workspace_id: FIX.workspace,
      binding_id: binding.binding_id,
      scopes: ["bfb:read", "bfb:task:write"],
    });
    expect(JSON.stringify(projection).includes(credential)).toBe(false);

    const token = await f.app().request(
      new Request(ORIGIN + "/auth/device/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: codes.device_code,
          client_id: "bfb-cli",
        }),
      }),
      undefined,
      f.env,
    );
    expect(token.status).toBe(404);
    const sessions = (await f.context.db
      .prepare(`SELECT COUNT(*) AS count FROM better_auth_sessions`)
      .get()) as { count: number };
    expect(sessions.count).toBe(1);

    const revoked = await f
      .app()
      .request(
        new Request(
          ORIGIN + `/api/v1/workspaces/${FIX.workspace}/cli/bindings/${binding.binding_id}/revoke`,
          {
            method: "POST",
            headers: { ...f.browserHeaders(), "cf-connecting-ip": "192.0.2.101" },
            body: "{}",
          },
        ),
        undefined,
        f.env,
      );
    expect(revoked.status).toBe(200);
    expect((await f.cliSession(credential)).status).toBe(401);
  });

  it("rejects foreign clients, pre-bound users, widened scopes, and oversized bodies", async () => {
    const f = await fixture();
    async function code(body: unknown, ip = "192.0.2.102") {
      return f.app().request(
        new Request(ORIGIN + "/auth/device/code", {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": ip },
          body: typeof body === "string" ? body : JSON.stringify(body),
        }),
        undefined,
        f.env,
      );
    }
    expect((await code({ client_id: "other-client" })).status).not.toBe(200);
    expect((await code({ client_id: "bfb-cli", user_id: "attacker" })).status).not.toBe(200);
    expect((await code({ client_id: "bfb-cli", scope: "bfb:read bfb:admin" })).status).not.toBe(
      200,
    );
    expect((await code({ client_id: "bfb-cli" }, "192.0.2.103")).status).toBe(200);
    expect((await code({ client_id: "bfb-cli", scope: "bfb:read" }, "192.0.2.104")).status).toBe(
      200,
    );
    const huge = await code("x".repeat(20_000), "192.0.2.105");
    expect(huge.status).not.toBe(200);
    const rows = (await f.context.db
      .prepare(
        `SELECT COUNT(*) AS count FROM better_auth_device_codes WHERE client_id != 'bfb-cli' OR user_id IS NOT NULL`,
      )
      .get()) as { count: number };
    expect(rows.count).toBe(0);
  });

  it("rejects cross-user and unknown-code approval without creating bindings", async () => {
    const f = await fixture();
    const issued = (await (await f.issue("192.0.2.106")).json()) as { user_code: string };
    const claimed = await f.app().request(
      new Request(ORIGIN + `/auth/device?user_code=${encodeURIComponent(issued.user_code)}`, {
        headers: { cookie: f.session.cookie, "cf-connecting-ip": "192.0.2.106" },
      }),
      undefined,
      f.env,
    );
    expect(claimed.status).toBe(200);
    const memberSession = await seedAuthSession(f.context, {
      userId: "cli-route-member",
      sessionId: "cli-route-member-session",
      token: "cli-route-member-token",
      humanId: FIX.member,
      email: "member@synthetic.test",
      now: NOW,
    });
    const memberAuth = await f
      .app()
      .request(
        new Request(ORIGIN + "/auth/session", { headers: { cookie: memberSession.cookie } }),
        undefined,
        f.env,
      );
    const memberCsrf = ((await memberAuth.json()) as { csrf_token: string }).csrf_token;
    const cross = await f.app().request(
      new Request(ORIGIN + `/api/v1/workspaces/${FIX.workspace}/cli/authorize`, {
        method: "POST",
        headers: {
          cookie: memberSession.cookie,
          origin: ORIGIN,
          "content-type": "application/json",
          "sec-fetch-site": "same-origin",
          "x-bfb-csrf": memberCsrf,
          "cf-connecting-ip": "192.0.2.106",
        },
        body: JSON.stringify({ user_code: issued.user_code, project_ids: [] }),
      }),
      undefined,
      f.env,
    );
    expect(cross.status).toBe(403);
    const unknown = await f.authorize("C05-UNKNOWN", "192.0.2.107");
    expect(unknown.status).toBe(403);
    const bindings = (await f.context.db
      .prepare(`SELECT COUNT(*) AS count FROM api_key_bindings`)
      .get()) as { count: number };
    expect(bindings.count).toBe(0);
    const own = (await (await f.issue("192.0.2.108")).json()) as { user_code: string };
    const self = await f.app().request(
      new Request(ORIGIN + `/api/v1/workspaces/${FIX.workspace}/cli/authorize`, {
        method: "POST",
        headers: {
          cookie: memberSession.cookie,
          origin: ORIGIN,
          "content-type": "application/json",
          "sec-fetch-site": "same-origin",
          "x-bfb-csrf": memberCsrf,
          "cf-connecting-ip": "192.0.2.108",
        },
        body: JSON.stringify({ user_code: own.user_code, project_ids: [] }),
      }),
      undefined,
      f.env,
    );
    expect(self.status).toBe(201);
  });

  it("rejects credential confusion on every non-designated surface", async () => {
    const f = await fixture();
    const issued = (await (await f.issue("192.0.2.108")).json()) as {
      device_code: string;
      user_code: string;
    };
    expect((await f.authorize(issued.user_code, "192.0.2.108")).status).toBe(201);
    const credential = (
      (await (await f.exchange(issued.device_code, "192.0.2.108")).json()) as {
        credential: string;
      }
    ).credential;

    const browserWithBearer = await f.app().request(
      new Request(ORIGIN + `/api/v1/workspaces/${FIX.workspace}/cli/authorize`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          origin: ORIGIN,
          "content-type": "application/json",
          "sec-fetch-site": "same-origin",
          "cf-connecting-ip": "192.0.2.108",
        },
        body: JSON.stringify({ user_code: issued.user_code }),
      }),
      undefined,
      f.env,
    );
    expect(browserWithBearer.status).toBe(401);

    const exchangeWithCookie = await f.app().request(
      new Request(ORIGIN + "/api/v1/cli/exchange", {
        method: "POST",
        headers: {
          cookie: f.session.cookie,
          "content-type": "application/json",
          "cf-connecting-ip": "192.0.2.108",
        },
        body: JSON.stringify({ client_id: "bfb-cli", device_code: issued.device_code }),
      }),
      undefined,
      f.env,
    );
    expect(exchangeWithCookie.status).toBe(401);

    const workspaceList = await f.app().request(
      new Request(ORIGIN + "/api/v1/workspaces", {
        headers: { authorization: `Bearer ${credential}` },
      }),
      undefined,
      f.env,
    );
    expect(workspaceList.status).toBe(401);

    const authSession = await f.app().request(
      new Request(ORIGIN + "/auth/session", {
        headers: { authorization: `Bearer ${credential}` },
      }),
      undefined,
      f.env,
    );
    expect(authSession.status).toBe(401);

    const mcp = await f.app().request(
      new Request(ORIGIN + "/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
      undefined,
      f.env,
    );
    expect(mcp.status).toBe(401);

    const runner = await f.app().request(
      new Request(ORIGIN + `/runner/workspaces/${FIX.workspace}/runners/x`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
        },
        body: "{}",
      }),
      undefined,
      f.env,
    );
    expect(runner.status).not.toBe(200);

    const sessionWithCode = await f.app().request(
      new Request(ORIGIN + "/api/v1/cli/session", {
        headers: { authorization: `Bearer ${issued.device_code}` },
      }),
      undefined,
      f.env,
    );
    expect(sessionWithCode.status).toBe(401);
  });

  it("revokes the binding when browser approval cannot complete", async () => {
    const f = await fixture();
    const issued = (await (await f.issue("192.0.2.109")).json()) as { user_code: string };
    const failing: CliApiDeps = {
      db: f.context.db,
      auth: {
        handler: async (request: Request) => {
          if (new URL(request.url).pathname === "/auth/device/approve") {
            return new Response(JSON.stringify({ error: "access_denied" }), { status: 403 });
          }
          return f.context.auth.handler(request);
        },
      } as CliApiDeps["auth"],
      now: NOW,
      jurisdiction: "eu",
      appOrigin: ORIGIN,
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
      workspaceHubNs: createTestWorkspaceHubNamespace(f.context.db),
    };
    const approved = await handleCliBrowserApi(
      new Request(ORIGIN + `/api/v1/workspaces/${FIX.workspace}/cli/authorize`, {
        method: "POST",
        headers: {
          cookie: f.session.cookie,
          origin: ORIGIN,
          "content-type": "application/json",
          "sec-fetch-site": "same-origin",
          "x-bfb-csrf": f.csrf,
          "cf-connecting-ip": "192.0.2.109",
        },
        body: JSON.stringify({ user_code: issued.user_code, project_ids: [] }),
      }),
      {
        ...failing,
        principal: {
          type: "human",
          humanId: FIX.owner,
          authUserId: "cli-route-user",
          email: "owner@synthetic.test",
          emailVerified: true,
          displayName: "Owner",
          sessionId: "cli-route-session",
        },
        workspaceId: FIX.workspace,
      },
    );
    expect(approved.status).toBe(403);
    const pending = (await f.context.db
      .prepare(`SELECT id, revoked_at, key_hash FROM api_key_bindings WHERE revoked_at IS NOT NULL`)
      .get()) as { id: string; revoked_at: string; key_hash: string | null };
    expect(pending.revoked_at).toBe(NOW);
    expect(pending.key_hash).toBeNull();
    expect((await f.exchange(issued.device_code, "192.0.2.109")).status).toBe(403);
  });

  it("caps issuance attempts and exchange polls with hashed keys", async () => {
    const f = await fixture();
    const burn = (await (await f.issue("192.0.2.120")).json()) as { device_code: string };
    for (let index = 0; index < 61; index += 1) {
      expect((await f.exchange(burn.device_code, "192.0.2.121")).status).toBe(403);
    }
    const first = (await (await f.issue("192.0.2.122")).json()) as {
      device_code: string;
      user_code: string;
    };
    expect((await f.authorize(first.user_code, "192.0.2.122")).status).toBe(201);
    expect((await f.exchange(first.device_code, "192.0.2.121")).status).toBe(403);
    const valid = await f.exchange(first.device_code, "192.0.2.123");
    expect(valid.status, await valid.clone().text()).toBe(200);

    const second = (await (await f.issue("192.0.2.124")).json()) as {
      device_code: string;
      user_code: string;
    };
    for (let ip = 0; ip < 6; ip += 1) {
      for (let index = 0; index < 10; index += 1) {
        expect((await f.exchange(second.device_code, `192.0.2.${130 + ip}`)).status).toBe(403);
      }
    }
    expect((await f.authorize(second.user_code, "192.0.2.140")).status).toBe(201);
    const blocked = await f.exchange(second.device_code, "192.0.2.141");
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toEqual({
      error: "request_rejected",
      message: "request rejected",
    });

    for (let index = 0; index < 17; index += 1) {
      expect((await f.issue("192.0.2.150")).status).toBe(200);
    }
    const exhausted = await f.issue("192.0.2.150");
    expect(exhausted.status).toBe(429);
    expect(await exhausted.json()).toEqual({
      error: "request_rejected",
      message: "request rejected",
    });

    const buckets = (await f.context.db
      .prepare(`SELECT bucket_key FROM rate_limit_buckets`)
      .all()) as { bucket_key: string }[];
    expect(buckets.length).toBeGreaterThan(0);
    for (const bucket of buckets) expect(bucket.bucket_key).toMatch(/^[0-9a-f]{64}$/);
    const dump = JSON.stringify(
      await f.context.db.prepare(`SELECT bucket_key, count FROM rate_limit_buckets`).all(),
    );
    expect(dump.includes(first.device_code)).toBe(false);
    expect(dump.includes(first.user_code)).toBe(false);
    expect(dump.includes(second.device_code)).toBe(false);
    expect(dump.includes("192.0.2.")).toBe(false);
  });

  it("keeps raw credentials out of D1 tables, logs, and diagnostics", async () => {
    const f = await fixture();
    const issued = (await (await f.issue("192.0.2.115")).json()) as {
      device_code: string;
      user_code: string;
    };
    await f.authorize(issued.user_code, "192.0.2.115");
    const credential = (
      (await (await f.exchange(issued.device_code, "192.0.2.115")).json()) as {
        credential: string;
      }
    ).credential;
    const dump = JSON.stringify({
      bindings: await f.context.db.prepare(`SELECT * FROM api_key_bindings`).all(),
      audit: await f.context.db.prepare(`SELECT payload_json FROM audit_events`).all(),
      events: await f.context.db.prepare(`SELECT payload_json FROM semantic_events`).all(),
      idempotency: await f.context.db.prepare(`SELECT result_json FROM idempotency_records`).all(),
      buckets: await f.context.db.prepare(`SELECT bucket_key FROM rate_limit_buckets`).all(),
    });
    expect(dump.includes(credential)).toBe(false);
    expect(dump.includes(issued.device_code)).toBe(false);
    expect(dump.includes(issued.user_code)).toBe(false);
    expect(dump.includes("192.0.2.")).toBe(false);
  });
});
