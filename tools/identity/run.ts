// ABOUTME: Proves C02 human sessions and public-auth limits in real Workerd isolates.
// ABOUTME: Two Workers share one migrated D1 while browser cookies stay off MCP.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createTestHarness } from "wrangler";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const origin = "https://bfb.identity.test";
const currentSecret = "c02-runtime-current-signing-key-4f57d1";
const server = createTestHarness({
  root: repoRoot,
  workers: [
    { configPath: "tools/identity/wrangler-a.toml" },
    { configPath: "tools/identity/wrangler-b.toml" },
  ],
});

interface IdentityEnv {
  DB: {
    prepare(sql: string): {
      bind(...values: unknown[]): {
        run(): Promise<unknown>;
      };
      first(): Promise<unknown>;
    };
  };
}

function worker(index: number) {
  return server.getWorker(index % 2 === 0 ? "bfb-identity-a" : "bfb-identity-b");
}

async function seedSession(env: IdentityEnv): Promise<string> {
  const now = "2026-08-11T20:00:00.000Z";
  const userId = "workerd-auth-user-c02";
  const sessionId = "workerd-auth-session-c02";
  const token = "workerd-auth-token-c02";
  await env.DB.prepare(
    `INSERT INTO better_auth_users
     (id, name, email, email_verified, image, created_at, updated_at)
     VALUES (?, 'Workerd Human', 'workerd-human@synthetic.test', 1, NULL, ?, ?)`,
  )
    .bind(userId, now, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO better_auth_sessions
     (id, expires_at, token, created_at, updated_at, ip_address, user_agent, user_id)
     VALUES (?, '2027-08-11T20:00:00.000Z', ?, ?, ?, NULL, NULL, ?)`,
  )
    .bind(sessionId, token, now, now, userId)
    .run();
  const signature = createHmac("sha256", currentSecret).update(token).digest("base64");
  return `__Host-bfb_session=${encodeURIComponent(`${token}.${signature}`)}`;
}

async function main(): Promise<void> {
  try {
    await server.listen();
    const workerA = server.getWorker("bfb-identity-a");
    const workerB = server.getWorker("bfb-identity-b");
    await workerA.applyD1Migrations("DB");
    const envA = (await workerA.getEnv()) as unknown as IdentityEnv;
    const cookie = await seedSession(envA);

    const sessionA = await workerA.fetch(origin + "/auth/session", {
      headers: { cookie },
    });
    const sessionB = await workerB.fetch(origin + "/auth/session", {
      headers: { cookie },
    });
    const sessionAText = await sessionA.text();
    const sessionBText = await sessionB.text();
    assert.equal(sessionA.status, 200, sessionAText);
    assert.equal(sessionB.status, 200, sessionBText);
    const principalA = JSON.parse(sessionAText) as {
      human: { id: string; email: string };
      csrf_token: string;
    };
    const principalB = JSON.parse(sessionBText) as typeof principalA;
    assert.equal(principalA.human.id, principalB.human.id);
    assert.equal(principalA.human.email, "workerd-human@synthetic.test");
    assert.match(principalA.csrf_token, /^2\.[0-9a-f]{64}$/);

    const unauthorizedWorkspace = await workerB.fetch(
      origin + "/api/v1/workspaces/01JBFB0W0RKSPACE0000000000/board",
      { headers: { cookie } },
    );
    assert.equal(unauthorizedWorkspace.status, 403);

    const cookieMcp = await workerA.fetch(origin + "/mcp", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/list",
      },
      body: JSON.stringify({ method: "tools/list" }),
    });
    assert.equal(cookieMcp.status, 401);
    for (const [path, method] of [
      ["/oauth/token", "POST"],
      ["/runner/connect", "GET"],
      ["/webhooks/github", "POST"],
    ] as const) {
      const response = await workerA.fetch(origin + path, {
        method,
        headers: { cookie },
      });
      assert.equal(response.status, 401, path);
      assert.equal(((await response.json()) as { error: string }).error, "credential_confusion");
    }

    const signInStatuses: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      signInStatuses.push(
        (
          await worker(index).fetch(origin + "/auth/sign-in/github", {
            method: "POST",
            headers: {
              origin,
              "sec-fetch-site": "same-origin",
              "cf-connecting-ip": "192.0.2.70",
            },
          })
        ).status,
      );
    }
    assert.deepEqual(signInStatuses.slice(0, 10), Array(10).fill(200));
    assert.equal(signInStatuses[10], 429);

    const callbackStatuses: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      callbackStatuses.push(
        (
          await worker(index).fetch(
            `${origin}/auth/callback/github?code=raw-code-${index}&state=raw-state-${index}`,
            { headers: { "cf-connecting-ip": "192.0.2.71" } },
          )
        ).status,
      );
    }
    assert.deepEqual(callbackStatuses.slice(0, 10), Array(10).fill(400));
    assert.equal(callbackStatuses[10], 429);

    const oversized = await workerA.fetch(origin + "/auth/sign-in/github", {
      method: "POST",
      headers: {
        origin,
        "sec-fetch-site": "same-origin",
        "cf-connecting-ip": "192.0.2.72",
      },
      body: "x".repeat(16_385),
    });
    assert.equal(oversized.status, 429);

    const stored = (await envA.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM humans) AS humans,
         (SELECT COUNT(*) FROM workspace_members) AS memberships,
         (SELECT COUNT(*) FROM better_auth_sessions) AS sessions,
         (SELECT COUNT(*) FROM rate_limit_buckets) AS buckets,
         (SELECT GROUP_CONCAT(bucket_key, ',') FROM rate_limit_buckets) AS bucket_keys`,
    ).first()) as {
      humans: number;
      memberships: number;
      sessions: number;
      buckets: number;
      bucket_keys: string;
    } | null;
    assert(stored);
    assert.equal(stored.humans, 1);
    assert.equal(stored.memberships, 0);
    assert.equal(stored.sessions, 1);
    assert.equal(stored.buckets, 2);
    assert(!stored.bucket_keys.includes("192.0.2.70"));
    assert(!stored.bucket_keys.includes("raw-code"));
    assert(!stored.bucket_keys.includes("raw-state"));

    console.log(
      JSON.stringify({
        workers: ["bfb-identity-a", "bfb-identity-b"],
        sharedHumanId: principalA.human.id,
        sessions: stored.sessions,
        memberships: stored.memberships,
        abuseBuckets: stored.buckets,
        signInStatuses,
        callbackStatuses,
      }),
    );
    console.log("C02_D1_OK");
  } catch (error) {
    server.debug();
    throw error;
  } finally {
    await server.close();
  }
}

await main();
