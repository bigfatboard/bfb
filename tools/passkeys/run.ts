// ABOUTME: Proves C03 passkey abuse limits in two real Workerd isolates sharing D1.
// ABOUTME: Enrollment, challenge, assertion, and removal attempts retain only hashed dimensions.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createTestHarness } from "wrangler";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const origin = "https://bfb.passkeys.test";
const currentSecret = "c03-runtime-current-signing-key-84d1e9";
const sessionId = "workerd-auth-session-c03";
const server = createTestHarness({
  root: repoRoot,
  workers: [
    { configPath: "tools/passkeys/wrangler-a.toml" },
    { configPath: "tools/passkeys/wrangler-b.toml" },
  ],
});

interface PasskeyEnv {
  DB: {
    prepare(sql: string): {
      bind(...values: unknown[]): {
        run(): Promise<unknown>;
      };
      first(): Promise<unknown>;
    };
  };
}

interface Surface {
  path: string;
  body: unknown;
  acceptedStatus: number;
}

function worker(index: number) {
  return server.getWorker(index % 2 === 0 ? "bfb-passkeys-a" : "bfb-passkeys-b");
}

function signedCookie(token: string): string {
  const signature = createHmac("sha256", currentSecret).update(token).digest("base64");
  return `__Host-bfb_session=${encodeURIComponent(`${token}.${signature}`)}`;
}

function csrfToken(): string {
  const signature = createHmac("sha256", currentSecret)
    .update(`bfb-csrf:${sessionId}`)
    .digest("hex");
  return `2.${signature}`;
}

async function seedSession(env: PasskeyEnv): Promise<string> {
  const now = "2026-08-11T20:00:00.000Z";
  const userId = "workerd-auth-user-c03";
  const token = "workerd-auth-token-c03";
  await env.DB.prepare(
    `INSERT INTO better_auth_users
     (id, name, email, email_verified, image, created_at, updated_at)
     VALUES (?, 'Workerd Passkey Human', 'workerd-passkey@synthetic.test', 1, NULL, ?, ?)`,
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
  await env.DB.prepare(
    `INSERT INTO better_auth_passkeys
     (id, name, public_key, user_id, credential_id, counter, device_type,
      backed_up, transports, created_at, aaguid)
     VALUES ('01K2E2N5T8P4SSKEYC03TEST00', 'Workerd credential', 'AA', ?,
             'cGFzc2tleS13b3JrZXJkLWMwMw', 0, 'singleDevice', 0, 'internal', ?, NULL)`,
  )
    .bind(userId, now)
    .run();
  return signedCookie(token);
}

async function attempt(index: number, cookie: string | undefined, surface: Surface, ip: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    origin,
    "sec-fetch-site": "same-origin",
    "x-bfb-csrf": csrfToken(),
    "cf-connecting-ip": ip,
  };
  if (cookie) {
    headers.cookie = cookie;
  }
  return worker(index).fetch(origin + surface.path, {
    method: "POST",
    headers,
    body: JSON.stringify(surface.body),
  });
}

async function exerciseSurface(
  cookie: string | undefined,
  surface: Surface,
  ip: string,
): Promise<number[]> {
  const statuses: number[] = [];
  for (let index = 0; index < 11; index += 1) {
    const response = await attempt(index, cookie, surface, ip);
    statuses.push(response.status);
    const body = (await response.json()) as { error?: string };
    if (index === 10) {
      assert.deepEqual(body, { error: "request_rejected", message: "request rejected" });
    }
  }
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(surface.acceptedStatus));
  assert.equal(statuses[10], 429);
  return statuses;
}

async function main(): Promise<void> {
  try {
    await server.listen();
    const workerA = server.getWorker("bfb-passkeys-a");
    const workerB = server.getWorker("bfb-passkeys-b");
    await workerA.applyD1Migrations("DB");
    const envA = (await workerA.getEnv()) as unknown as PasskeyEnv;
    const cookie = await seedSession(envA);

    for (const selected of [workerA, workerB]) {
      const session = await selected.fetch(origin + "/auth/session", { headers: { cookie } });
      assert.equal(session.status, 200, await session.clone().text());
    }

    const rawProof = "raw-proof-capability-c03";
    const rawAssertion = "raw-assertion-capability-c03";
    const surfaces: Surface[] = [
      {
        path: "/auth/step-up/options",
        acceptedStatus: 200,
        body: {
          action: {
            action: "passkey.enroll.additional",
            targetId: rawProof,
            scopes: [],
            authorizationEpoch: 0,
          },
        },
      },
      { path: "/auth/passkeys/enroll/start", acceptedStatus: 403, body: {} },
      {
        path: "/auth/passkeys/enroll/options",
        acceptedStatus: 403,
        body: { flow_id: rawProof },
      },
      {
        path: "/auth/step-up/verify",
        acceptedStatus: 403,
        body: { challenge_id: rawProof, response: { signature: rawAssertion } },
      },
      {
        path: "/auth/passkeys/remove",
        acceptedStatus: 403,
        body: { passkey_id: rawProof, proof_id: rawProof, proof_action: {} },
      },
    ];
    const results: Record<string, number[]> = {};
    for (const [index, surface] of surfaces.entries()) {
      results[surface.path] = await exerciseSurface(cookie, surface, `192.0.2.${80 + index}`);
    }
    results["unauthenticated:/auth/step-up/options"] = await exerciseSurface(
      undefined,
      { ...surfaces[0]!, acceptedStatus: 403 },
      "192.0.2.90",
    );

    const stored = (await envA.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM rate_limit_buckets) AS buckets,
         (SELECT GROUP_CONCAT(bucket_key, ',') FROM rate_limit_buckets) AS bucket_keys,
         (SELECT COUNT(*) FROM passkey_ceremonies WHERE kind = 'authentication') AS challenges,
         (SELECT COUNT(*) FROM passkey_security_events WHERE outcome = 'failed') AS failed_events`,
    ).first()) as {
      buckets: number;
      bucket_keys: string;
      challenges: number;
      failed_events: number;
    } | null;
    assert(stored);
    assert.equal(stored.buckets, surfaces.length + 1);
    assert.equal(stored.challenges, 10);
    assert(stored.failed_events >= 30);
    for (const raw of ["192.0.2.", rawProof, rawAssertion, "passkey.enroll.additional", "/auth/"]) {
      assert(!stored.bucket_keys.includes(raw));
    }
    assert.match(stored.bucket_keys, /^[0-9a-f]{64}(,[0-9a-f]{64}){5}$/);

    console.log(
      JSON.stringify({
        workers: ["bfb-passkeys-a", "bfb-passkeys-b"],
        abuseBuckets: stored.buckets,
        challenges: stored.challenges,
        failedEvents: stored.failed_events,
        surfaces: results,
      }),
    );
    console.log("C03_D1_OK");
  } catch (error) {
    server.debug();
    throw error;
  } finally {
    await server.close();
  }
}

await main();
