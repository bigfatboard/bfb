// ABOUTME: Proves human artifact grants expire at atomic consumption without extending captured observations.
// ABOUTME: Real SQLite batches and mounted handlers separate consumption from fake R2 completion and HTTP budgets.

import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";

import { adaptD1, type D1Like, type D1StatementLike, type SqlDatabase } from "@bfb/db";
import {
  artifactHash,
  createArtifactCommand,
  createRunCommand,
  createTaskCommand,
  createViewGrantCommand,
  finalizeArtifactCommand,
  FIX,
  mintUploadGrantSecret,
  mintViewGrantSecret,
  mintViewNonce,
  randomUlid,
  recordVerifiedUpload,
  redeemUploadGrant,
  WorkspaceHub,
  type HubCommand,
} from "@bfb/domain";

import { openDomainDb } from "../../../packages/domain/test/helpers.js";
import { createArtifactFetchHandler } from "../src/index.js";

type Family = "upload" | "view";
type Snapshot = Record<string, unknown[]>;

const ORIGIN = "https://artifacts.bfb.example.test";
const TEXT = "SYNTHETIC-HUMAN-GRANT-EXPIRY-BYTES";
const BYTES = new TextEncoder().encode(TEXT);
const DIGEST = artifactHash(BYTES);
const DELAY_MS = 2_200;

async function canonicalSnapshot(db: SqlDatabase): Promise<Snapshot> {
  const snapshot: Snapshot = {};
  const tables = (await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()) as Array<{ name: string }>;
  for (const { name } of tables) {
    if (
      name.startsWith("sqlite_") ||
      name.startsWith("_cf_") ||
      ["d1_migrations", "rate_limit_buckets"].includes(name)
    )
      continue;
    expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/u);
    snapshot[name] = await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
  }
  return snapshot;
}

async function fixture(family: Family, lifetimeSeconds: 2 | 60) {
  const db = await openDomainDb(),
    hub = new WorkspaceHub(db);
  const setupClock = (await db
    .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now")
    .get()) as { now: string };
  const execute = async <I, R>(command: HubCommand<I, R>, input: I, humanId = FIX.owner) => {
    const outcome = await hub.execute(command, {
      workspaceId: FIX.workspace,
      actorHumanId: humanId,
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      now: setupClock.now,
      input,
    });
    if (!outcome.ok) throw new Error(JSON.stringify(outcome));
    return outcome.result;
  };
  const task = await execute(createTaskCommand, {
    projectId: FIX.projectA,
    title: "Synthetic human grant expiry task",
    priority: "P2",
  });
  const createdRun = await execute(createRunCommand, {
    taskId: task.id,
    expectedTaskVersion: task.resource_version,
    agentProfileId: FIX.profileCodex,
    workspacePolicyVersion: 1,
    projectPolicyVersion: 1,
    repositoryConfigVersion: 1,
    agentProfileVersion: 1,
  });
  const uploadSecret = mintUploadGrantSecret();
  const publication = await execute(createArtifactCommand, {
    runId: createdRun.run.id,
    format: "markdown",
    role: "review",
    declaredSize: BYTES.length,
    expectedDigest: DIGEST,
    grantSecretHash: uploadSecret.secretHash,
  });

  let originalGrantId = publication.upload_grant.grant_id;
  const secret = family === "upload" ? mintUploadGrantSecret() : mintViewGrantSecret();
  const nonce = mintViewNonce();
  if (family === "view") {
    const consumed = await db.withTransaction((tx) =>
      redeemUploadGrant(tx, {
        grantId: originalGrantId,
        secret: uploadSecret.secret,
        now: setupClock.now,
      }),
    );
    await db.withTransaction((tx) =>
      recordVerifiedUpload(tx, {
        grantId: consumed.grantId,
        consumeAttemptId: consumed.consumeAttemptId,
        contentHash: DIGEST,
        size: BYTES.length,
        now: setupClock.now,
      }),
    );
    await execute(finalizeArtifactCommand, {
      versionId: publication.version_id,
      contentHash: DIGEST,
      size: BYTES.length,
    });
    const issued = await execute(
      createViewGrantCommand,
      {
        versionId: publication.version_id,
        grantSecretHash: mintViewGrantSecret().secretHash,
        viewNonce: nonce,
        sessionHash: artifactHash("synthetic expiry view session"),
      },
      FIX.reviewer,
    );
    originalGrantId = issued.view_id;
  }

  const clock = (await db
    .prepare(
      `SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now,
              strftime('%Y-%m-%dT%H:%M:%fZ','now',?) AS expires_at`,
    )
    .get(`+${lifetimeSeconds} seconds`)) as { now: string; expires_at: string };
  const grantId = randomUlid();
  // Fresh synthetic short-lived grants retain every genuine issued source field.
  // Their expiry is assigned once at INSERT, never rewritten during a delay.
  if (family === "upload") {
    await db
      .prepare(
        `INSERT INTO artifact_upload_grants
         (workspace_id,id,version_id,grant_hash,human_id,authorization_epoch,run_id,
          format,declared_size,expected_digest,expires_at,consumed_at,created_at)
         SELECT workspace_id,?,version_id,?,human_id,authorization_epoch,run_id,
                format,declared_size,expected_digest,?,NULL,?
         FROM artifact_upload_grants WHERE workspace_id=? AND id=?`,
      )
      .run(grantId, secret.secretHash, clock.expires_at, clock.now, FIX.workspace, originalGrantId);
  } else {
    await db
      .prepare(
        `INSERT INTO artifact_view_grants
         (workspace_id,id,version_id,grant_hash,view_nonce_hash,human_id,session_hash,
          authorization_epoch,content_hash,expires_at,consumed_at,created_at)
         SELECT workspace_id,?,version_id,?,view_nonce_hash,human_id,session_hash,
                authorization_epoch,content_hash,?,NULL,?
         FROM artifact_view_grants WHERE workspace_id=? AND id=?`,
      )
      .run(grantId, secret.secretHash, clock.expires_at, clock.now, FIX.workspace, originalGrantId);
  }

  const effects = { uploadBody: 0, puts: 0, gets: 0, objectBodies: 0 };
  const hooks: { completion?: () => Promise<void> } = {};
  const bucket = {
    async put(key: string) {
      effects.puts++;
      await hooks.completion?.();
      return { key };
    },
    async get() {
      effects.gets++;
      return {
        async arrayBuffer() {
          effects.objectBodies++;
          await hooks.completion?.();
          return BYTES.slice().buffer as ArrayBuffer;
        },
      };
    },
  } as unknown as R2Bucket;
  const request = async (requestDb: SqlDatabase) => {
    const url = `${ORIGIN}/${family}/${grantId}${family === "view" ? "/redeem" : ""}`;
    let input: Request;
    if (family === "upload") {
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            effects.uploadBody++;
            controller.enqueue(BYTES);
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      input = new Request(url, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${secret.secret}`,
          "cf-connecting-ip": "192.0.2.83",
        },
        body,
        duplex: "half",
      } as RequestInit);
    } else {
      input = new Request(url, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "cf-connecting-ip": "192.0.2.84",
        },
        // Parsing the capability form precedes consumption; artifact bytes do not.
        body: new URLSearchParams({ view_secret: secret.secret, view_nonce: nonce }).toString(),
      });
    }
    return createArtifactFetchHandler({ db: requestDb, now: clock.now })(input, {
      ARTIFACTS: bucket,
      DB: {} as D1Database,
      ARTIFACT_ORIGIN: ORIGIN,
      APP_ORIGIN: "https://bfb.example.test",
      ENVIRONMENT: "local",
      ARTIFACT_VIEWER_ENABLED: "true",
      UPLOAD_ABUSE_SECRET: "synthetic-human-expiry-abuse-secret-83a2f44c",
    });
  };
  const table = family === "upload" ? "artifact_upload_grants" : "artifact_view_grants";
  const grant = () =>
    db.prepare(`SELECT * FROM ${table} WHERE workspace_id=? AND id=?`).get(FIX.workspace, grantId);
  const expired = async () => {
    const current = (await db
      .prepare("SELECT julianday('now') >= julianday(?) AS expired")
      .get(clock.expires_at)) as { expired: number };
    return current.expired === 1;
  };
  expect(await db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  const baseline = await canonicalSnapshot(db);
  const budgets = (await db
    .prepare("SELECT COALESCE(SUM(count),0) AS count FROM rate_limit_buckets")
    .get()) as { count: number };
  return {
    db,
    family,
    table,
    grantId,
    now: clock.now,
    expiresAt: clock.expires_at,
    publication,
    effects,
    hooks,
    request,
    grant,
    expired,
    baseline,
    budgetCount: budgets.count,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function stagedConsumption(f: Fixture, beforeConsume: () => Promise<void>) {
  const entries = new Map<D1StatementLike, { sql: string; parameters: unknown[] }>();
  let consumeBatches = 0;
  let maximumBindings = 0;
  const binding: D1Like = {
    prepare(sql) {
      const entry = { sql, parameters: [] as unknown[] };
      const statement: D1StatementLike = {
        bind(...parameters) {
          entry.parameters = parameters;
          maximumBindings = Math.max(maximumBindings, parameters.length);
          return statement;
        },
        first: async () => (await f.db.prepare(sql).get(...entry.parameters)) ?? null,
        all: async () => ({ results: await f.db.prepare(sql).all(...entry.parameters) }),
        async run() {
          const meta = await f.db.prepare(sql).run(...entry.parameters);
          if (meta.changes === null) throw new Error("SQLite writes must report changes");
          return { meta: { changes: meta.changes } };
        },
      };
      entries.set(statement, entry);
      return statement;
    },
    async batch(pending) {
      const consumed = pending
        .map((statement) => entries.get(statement)!)
        .filter((entry) => entry.sql.includes(`UPDATE ${f.table} SET consumed_at =`));
      if (consumed.length) {
        expect(consumed).toHaveLength(1);
        // Production adaptD1 has already prepared and bound the exact UPDATE.
        expect(consumed[0]!.parameters).toContain(f.grantId);
        expect(consumed[0]!.parameters[0]).toBe(f.now);
        expect(await f.expired()).toBe(false);
        expect((await f.grant()) as { consumed_at: string | null }).toMatchObject({
          consumed_at: null,
          expires_at: f.expiresAt,
        });
        expect(await canonicalSnapshot(f.db)).toEqual(f.baseline);
        consumeBatches++;
        await beforeConsume();
        // No authority, grant or source row changed while the database clock advanced.
        expect(await canonicalSnapshot(f.db)).toEqual(f.baseline);
      }
      // Forward every queued write into the real SQLite atomic transaction.
      return f.db.withTransaction(async (tx) => {
        const results = [];
        for (const statement of pending) {
          const entry = entries.get(statement)!;
          const meta = await tx.prepare(entry.sql).run(...entry.parameters);
          if (meta.changes === null) throw new Error("SQLite batches must report changes");
          results.push({ meta: { changes: meta.changes } });
        }
        return results;
      });
    },
  };
  return {
    db: adaptD1(binding),
    assertWitness() {
      expect(consumeBatches).toBe(1);
      expect(maximumBindings).toBeGreaterThan(0);
      expect(maximumBindings).toBeLessThanOrEqual(100);
    },
  };
}

async function assertBudgets(f: Fixture, attempts: number) {
  const row = (await f.db
    .prepare("SELECT COALESCE(SUM(count),0) AS count FROM rate_limit_buckets")
    .get()) as { count: number };
  // IP and capability-attempt budgets are separate, intentionally durable HTTP effects.
  expect(row.count - f.budgetCount).toBe(attempts * 2);
}

async function assertDenied(response: Response, f: Fixture, soft = false) {
  const assertion = soft ? expect.soft : expect;
  assertion(response.status).toBe(403);
  assertion(response.headers.get("cache-control")).toBe(
    f.family === "upload" ? "no-store" : "private, no-store",
  );
  assertion(response.headers.get("set-cookie")).toBeNull();
  assertion(response.headers.get("etag")).toBeNull();
  assertion(await response.text()).toBe(
    JSON.stringify({ error: "request_rejected", message: "request rejected" }),
  );
}

async function assertSuccess(response: Response, f: Fixture) {
  expect(response.status).toBe(200);
  if (f.family === "upload") {
    expect(await response.json()).toMatchObject({
      artifact_id: f.publication.artifact_id,
      version_id: f.publication.version_id,
      content_hash: DIGEST,
      size: BYTES.length,
      deduplicated: false,
    });
    expect(f.effects).toEqual({ uploadBody: 1, puts: 1, gets: 0, objectBodies: 0 });
    expect(
      await f.db
        .prepare("SELECT consumed_at FROM artifact_upload_consumptions WHERE grant_id=?")
        .all(f.grantId),
    ).toEqual([{ consumed_at: f.now }]);
    expect(
      await f.db
        .prepare("SELECT verified_at FROM artifact_upload_receipts WHERE version_id=?")
        .get(f.publication.version_id),
    ).toEqual({ verified_at: f.now });
    expect(
      await f.db
        .prepare("SELECT verified_at FROM artifact_upload_receipt_sources WHERE grant_id=?")
        .get(f.grantId),
    ).toEqual({ verified_at: f.now });
  } else {
    expect(await response.text()).toContain(TEXT);
    expect(f.effects).toEqual({ uploadBody: 0, puts: 0, gets: 1, objectBodies: 1 });
  }
  expect(await f.grant()).toMatchObject({ consumed_at: f.now, expires_at: f.expiresAt });
  const audit = (await f.db
    .prepare("SELECT action,created_at FROM artifact_audit_outbox WHERE grant_id=? ORDER BY rowid")
    .all(f.grantId)) as Array<{ action: string; created_at: string }>;
  expect(audit).toEqual(
    (f.family === "upload"
      ? ["artifact.grant_consumed", "artifact.upload_verified"]
      : ["artifact.view_redeemed"]
    ).map((action) => ({ action, created_at: f.now })),
  );
  expect(await f.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}

describe("human artifact grant atomic expiry", () => {
  it.each(["upload", "view"] as const)(
    "rejects unchanged %s grants that naturally expire after binding but before consumption",
    async (family) => {
      const f = await fixture(family, 2);
      const staged = stagedConsumption(f, async () => {
        await delay(DELAY_MS);
        expect(await f.expired()).toBe(true);
      });
      const response = await f.request(staged.db);
      staged.assertWitness();
      // Soft assertions collect the OLD response, byte effects and durable effects independently.
      await assertDenied(response, f, true);
      expect.soft(f.effects).toEqual({ uploadBody: 0, puts: 0, gets: 0, objectBodies: 0 });
      expect.soft(await canonicalSnapshot(f.db)).toEqual(f.baseline);
      expect(await f.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      await assertBudgets(f, 1);
    },
  );

  it.each(["upload", "view"] as const)(
    "preserves original %s observations through the equally delayed live consume batch",
    async (family) => {
      const f = await fixture(family, 60);
      const staged = stagedConsumption(f, async () => {
        await delay(DELAY_MS);
        expect(await f.expired()).toBe(false);
      });
      await assertSuccess(await f.request(staged.db), f);
      staged.assertWitness();
      const committed = await canonicalSnapshot(f.db),
        effects = { ...f.effects };
      await assertDenied(await f.request(staged.db), f);
      expect(f.effects).toEqual(effects);
      expect(await canonicalSnapshot(f.db)).toEqual(committed);
      await assertBudgets(f, 2);
    },
  );

  it.each(["upload", "view"] as const)(
    "allows already-consumed %s grants to complete byte delivery after TTL",
    async (family) => {
      const f = await fixture(family, 2);
      const staged = stagedConsumption(f, async () => {
        expect(await f.expired()).toBe(false);
      });
      let completionWaits = 0;
      f.hooks.completion = async () => {
        expect(await f.expired()).toBe(false);
        expect(await f.grant()).toMatchObject({ consumed_at: f.now });
        const consumed = await canonicalSnapshot(f.db);
        completionWaits++;
        await delay(DELAY_MS);
        expect(await f.expired()).toBe(true);
        expect(await canonicalSnapshot(f.db)).toEqual(consumed);
      };
      await assertSuccess(await f.request(staged.db), f);
      staged.assertWitness();
      expect(completionWaits).toBe(1);
      const committed = await canonicalSnapshot(f.db),
        effects = { ...f.effects };
      await assertDenied(await f.request(staged.db), f);
      expect(f.effects).toEqual(effects);
      expect(await canonicalSnapshot(f.db)).toEqual(committed);
      await assertBudgets(f, 2);
    },
  );
});
