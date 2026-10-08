// ABOUTME: Certifies single CLI credential exchange and revocation across two Worker isolates.
// ABOUTME: Production D1 batches, durable abuse limits, and hash-only storage are asserted.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { adaptD1, type D1Like } from "@bfb/db";
import { FIX, seedSyntheticWorkspace } from "@bfb/domain";
import { createTestHarness } from "wrangler";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ORIGIN = "https://bfb.cli.test";
const NOW = "2026-09-12T20:00:00.000Z";
const SIGNING_KEY = "c05-runtime-current-signing-key-91e4b7";
const sessionId = "c05-synthetic-session";
const sessionToken = "c05-synthetic-session-token";
const cookie = `__Host-bfb_session=${encodeURIComponent(`${sessionToken}.${createHmac("sha256", SIGNING_KEY).update(sessionToken).digest("base64")}`)}`;
const csrf = `2.${createHmac("sha256", SIGNING_KEY).update(`bfb-csrf:${sessionId}`).digest("hex")}`;
const server = createTestHarness({
  root: repoRoot,
  workers: [
    { configPath: "tools/cli-credentials/wrangler-a.toml" },
    { configPath: "tools/cli-credentials/wrangler-b.toml" },
    { configPath: "tools/cli-credentials/wrangler-hub.toml" },
  ],
});

function post(index: number, path: string, body: unknown, browser = false, ip = "192.0.2.21") {
  return server.getWorker(index % 2 === 0 ? "bfb-cli-a" : "bfb-cli-b").fetch(ORIGIN + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": ip,
      ...(browser
        ? { cookie, origin: ORIGIN, "sec-fetch-site": "same-origin", "x-bfb-csrf": csrf }
        : {}),
    },
    body: JSON.stringify(body),
  });
}

function get(index: number, path: string, headers: Record<string, string> = {}) {
  return server
    .getWorker(index % 2 === 0 ? "bfb-cli-a" : "bfb-cli-b")
    .fetch(ORIGIN + path, { headers });
}

async function accepted<T>(response: Awaited<ReturnType<typeof post>>, status = 200): Promise<T> {
  assert.equal(response.status, status, `unexpected status ${response.status}`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return (await response.json()) as T;
}

async function main() {
  try {
    await server.listen();
    const worker = server.getWorker("bfb-cli-a");
    await worker.applyD1Migrations("DB");
    const env = (await worker.getEnv()) as unknown as { DB: D1Like };
    const db = adaptD1(env.DB);
    // Workerd does not implement jurisdiction selection. Hub-client unit tests
    // cover persisted EU/US routing; this fixture exercises the global namespace.
    await seedSyntheticWorkspace(db, NOW, "global");
    await db
      .prepare(
        `INSERT INTO better_auth_users (id, name, email, email_verified, created_at, updated_at) VALUES ('c05-user', 'Synthetic CLI Owner', 'owner@synthetic.test', 1, ?, ?)`,
      )
      .run(NOW, NOW);
    await db
      .prepare(`UPDATE humans SET better_auth_user_id = 'c05-user' WHERE id = ?`)
      .run(FIX.owner);
    await db
      .prepare(
        `INSERT INTO better_auth_sessions (id, expires_at, token, created_at, updated_at, user_id) VALUES (?, '2027-09-12T20:00:00.000Z', ?, ?, ?, 'c05-user')`,
      )
      .run(sessionId, sessionToken, NOW, NOW);

    async function issue(index: number, ip = "192.0.2.21") {
      return accepted<{ device_code: string; user_code: string }>(
        await post(index, "/auth/device/code", { client_id: "bfb-cli" }, false, ip),
      );
    }
    async function authorize(index: number, userCode: string, ip = "192.0.2.21") {
      return accepted<{ binding: { binding_id: string } }>(
        await post(
          index,
          `/api/v1/workspaces/${FIX.workspace}/cli/authorize`,
          { user_code: userCode, project_ids: [] },
          true,
          ip,
        ),
        201,
      );
    }
    async function exchange(index: number, deviceCode: string, ip = "192.0.2.21") {
      return post(
        index,
        "/api/v1/cli/exchange",
        { client_id: "bfb-cli", device_code: deviceCode },
        false,
        ip,
      );
    }

    const codes = await issue(0);
    const approval = await authorize(1, codes.user_code);
    const race = await Promise.all([
      exchange(0, codes.device_code),
      exchange(1, codes.device_code),
    ]);
    assert.deepEqual(race.map((response) => response.status).sort(), [200, 403]);
    const winner = race.find((response) => response.status === 200)!;
    const issued = await accepted<{
      credential: string;
      binding_id: string;
      key_prefix: string;
    }>(winner);
    assert.match(issued.credential, /^bfb_cli_[A-Za-z0-9_-]{43}$/);
    assert.equal(issued.binding_id, approval.binding.binding_id);
    assert.equal(issued.key_prefix, issued.credential.slice(0, 12));

    const replay = await exchange(0, codes.device_code);
    assert.equal(replay.status, 403);
    assert.deepEqual(await replay.json(), {
      error: "request_rejected",
      message: "request rejected",
    });
    const devices = (await db
      .prepare(`SELECT COUNT(*) AS count FROM better_auth_device_codes WHERE device_code = ?`)
      .get(codes.device_code)) as { count: number };
    assert.equal(devices.count, 0);

    const whoami = await accepted<{
      binding_id: string;
      key_prefix: string;
      scopes: string[];
    }>(
      await get(1, "/api/v1/cli/session", {
        authorization: `Bearer ${issued.credential}`,
      }),
    );
    assert.equal(whoami.binding_id, issued.binding_id);
    assert.deepEqual(whoami.scopes, ["bfb:read", "bfb:task:write"]);

    const token = await post(0, "/auth/device/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: codes.device_code,
      client_id: "bfb-cli",
    });
    assert.equal(token.status, 404);
    const sessions = (await db
      .prepare(`SELECT COUNT(*) AS count FROM better_auth_sessions`)
      .get()) as { count: number };
    assert.equal(sessions.count, 1);

    const burn = await issue(1, "192.0.2.22");
    for (let index = 0; index < 61; index += 1) {
      assert.equal((await exchange(index, burn.device_code, "192.0.2.23")).status, 403);
    }
    const limited = await issue(0, "192.0.2.24");
    await authorize(0, limited.user_code, "192.0.2.24");
    assert.equal((await exchange(1, limited.device_code, "192.0.2.23")).status, 403);
    const recovered = await accepted<{ credential: string }>(
      await exchange(0, limited.device_code, "192.0.2.25"),
    );
    assert.match(recovered.credential, /^bfb_cli_/);

    const revoked = await accepted<{ binding: { status: string } }>(
      await post(
        0,
        `/api/v1/workspaces/${FIX.workspace}/cli/bindings/${issued.binding_id}/revoke`,
        {},
        true,
      ),
    );
    assert.equal(revoked.binding.status, "revoked");
    assert.equal(
      (
        await get(1, "/api/v1/cli/session", {
          authorization: `Bearer ${issued.credential}`,
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await get(0, "/api/v1/cli/session", {
          authorization: `Bearer ${recovered.credential}`,
        })
      ).status,
      200,
    );

    const dump = JSON.stringify({
      bindings: await db.prepare(`SELECT * FROM api_key_bindings`).all(),
      audit: await db.prepare(`SELECT payload_json FROM audit_events`).all(),
      events: await db.prepare(`SELECT payload_json FROM semantic_events`).all(),
      idempotency: await db.prepare(`SELECT result_json FROM idempotency_records`).all(),
      buckets: await db.prepare(`SELECT bucket_key FROM rate_limit_buckets`).all(),
    });
    for (const secret of [
      issued.credential,
      recovered.credential,
      codes.device_code,
      codes.user_code,
    ]) {
      assert(!dump.includes(secret), "secret retained outside its hashed binding");
    }
    assert(dump.includes("192.0.2.") === false, "raw IP retained in diagnostics");
    assert(dump.includes("/Users/") === false, "local path retained in diagnostics");
    const buckets = (await db
      .prepare(`SELECT bucket_key, count FROM rate_limit_buckets`)
      .all()) as { bucket_key: string; count: number }[];
    assert(buckets.some((bucket) => bucket.count > 20));
    for (const bucket of buckets) assert.match(bucket.bucket_key, /^[0-9a-f]{64}$/);

    console.log(
      JSON.stringify({
        workers: 3,
        exchanges: 2,
        exchangeRace: race.map((item) => item.status).sort(),
        tokenEndpoint: 404,
        sessions: sessions.count,
        abuseCounters: "shared-and-hashed",
        revocationBeforeCleanup: true,
        persistedRawCredentials: false,
      }),
    );
    console.log("C05_D1_OK");
  } finally {
    await server.close();
  }
}

await main();
