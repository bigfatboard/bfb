// ABOUTME: Proves OPS queue isolation, retry-to-DLQ, and retention sweep boundaries.
// ABOUTME: A poison job never replays siblings; retention never touches hashes or metadata.

import { describe, expect, it } from "vitest";

import { FIX } from "@bfb/domain";
import { randomUlid } from "@bfb/domain";

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { adaptBetterSqlite3, applyMigrationsForVerification, type SqlDatabase } from "@bfb/db";

import { consumeOpsQueueBatch, type OpsQueueDeps, type OpsQueueHandle } from "../src/operations/queue.js";
import { runRetentionSweep } from "../src/operations/sweep.js";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations/d1",
);

async function openDomainDb(): Promise<SqlDatabase> {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  applyMigrationsForVerification(raw, migrationsDir);
  const db = adaptBetterSqlite3(raw);
  const { seedSyntheticWorkspace } = await import("@bfb/domain");
  await seedSyntheticWorkspace(db);
  return db;
}

const NOW = "2026-09-18T12:00:00.000Z";

interface FakeR2 {
  objects: Map<string, string>;
  failures: number;
  deleted: string[];
  put(key: string, body: string): Promise<void>;
  delete(key: string): Promise<void>;
}

function fakeR2(failures = 0): FakeR2 {
  const state: FakeR2 = {
    objects: new Map(),
    failures,
    deleted: [],
    async put(key: string, body: string) {
      if (state.failures > 0) {
        state.failures -= 1;
        throw new Error("r2 unavailable");
      }
      state.objects.set(key, body);
    },
    async delete(key: string) {
      state.deleted.push(key);
      state.objects.delete(key);
    },
  };
  return state;
}

function depsFor(r2: FakeR2, db: SqlDatabase, dlq: unknown[]): OpsQueueDeps {
  return {
    db,
    r2,
    sendDlq: async (copy) => {
      dlq.push(copy);
    },
  };
}

function handle(body: unknown, events: string[], name: string, attempts = 0): OpsQueueHandle {
  return {
    body,
    attempts,
    ack: () => {
      events.push(`${name}:ack`);
    },
    retry: () => {
      events.push(`${name}:retry`);
    },
  };
}

async function seedBundle(db: SqlDatabase, state = "consented"): Promise<string> {
  const id = randomUlid();
  await db
    .prepare(
      `INSERT INTO diagnostic_bundles
       (workspace_id, id, created_by_human_id, state, inventory_json, bundle_hash,
        redaction_status, r2_key, created_at, consented_at, uploaded_at, expires_at, last_error)
       VALUES (?, ?, ?, ?, '{}', ?, 'passed', NULL, ?, ?, NULL, ?, NULL)`,
    )
    .run(FIX.workspace, id, FIX.owner, state, "a".repeat(64), NOW, state === "consented" ? NOW : null, "2026-09-19T12:00:00.000Z");
  return id;
}

describe("ops queue consumer", () => {
  it("uploads a consented bundle and acks exactly once", async () => {
    const db = await openDomainDb();
    const r2 = fakeR2();
    const dlq: unknown[] = [];
    const events: string[] = [];
    const bundle = await seedBundle(db);
    await consumeOpsQueueBatch(
      [handle({ schema_version: 1, kind: "diagnostic.upload", workspace_id: FIX.workspace, bundle_id: bundle, attempt: 1 }, events, "good")],
      depsFor(r2, db, dlq),
      NOW,
    );
    expect(events).toEqual(["good:ack"]);
    expect(dlq).toEqual([]);
    const key = `workspaces/${FIX.workspace}/diagnostics/${bundle}.json`;
    expect(r2.objects.get(key)).toBe("{}");
    const row = (await db
      .prepare(`SELECT state, r2_key FROM diagnostic_bundles WHERE workspace_id = ? AND id = ?`)
      .get(FIX.workspace, bundle)) as { state: string; r2_key: string };
    expect(row).toEqual({ state: "uploaded", r2_key: key });
  });

  it("isolates poison jobs and parks exhausted uploads in visible DLQ state", async () => {
    const db = await openDomainDb();
    const r2 = fakeR2(99);
    const dlq: unknown[] = [];
    const events: string[] = [];
    const bundle = await seedBundle(db);
    await consumeOpsQueueBatch(
      [
        handle({ schema_version: 1, kind: "diagnostic.upload", workspace_id: FIX.workspace, bundle_id: bundle, attempt: 1 }, events, "flaky", 0),
        handle({ nope: true }, events, "poison", 0),
        handle(
          { schema_version: 1, kind: "diagnostic.upload", workspace_id: FIX.workspace, bundle_id: bundle, attempt: 1 },
          events,
          "exhausted",
          7,
        ),
      ],
      depsFor(r2, db, dlq),
      NOW,
    );
    expect(events).toEqual(["flaky:retry", "poison:retry", "exhausted:ack"]);
    expect(dlq).toHaveLength(1);
    expect((dlq[0] as { error: string }).error).toBe("upload_exhausted");
    const row = (await db
      .prepare(`SELECT state FROM diagnostic_bundles WHERE workspace_id = ? AND id = ?`)
      .get(FIX.workspace, bundle)) as { state: string };
    expect(row.state).toBe("failed");
  });

  it("diverts unknown bundles and wrong-state bundles without uploading", async () => {
    const db = await openDomainDb();
    const r2 = fakeR2();
    const dlq: unknown[] = [];
    const events: string[] = [];
    const pending = await seedBundle(db, "pending_consent");
    await consumeOpsQueueBatch(
      [
        handle({ schema_version: 1, kind: "diagnostic.upload", workspace_id: FIX.workspace, bundle_id: randomUlid(), attempt: 1 }, events, "unknown"),
        handle({ schema_version: 1, kind: "diagnostic.upload", workspace_id: FIX.workspace, bundle_id: pending, attempt: 1 }, events, "unconsented"),
      ],
      depsFor(r2, db, dlq),
      NOW,
    );
    expect(events).toEqual(["unknown:ack", "unconsented:ack"]);
    expect(r2.objects.size).toBe(0);
    expect(dlq).toHaveLength(2);
  });
});

describe("retention sweep", () => {
  async function seedLogChunk(db: SqlDatabase, at: string): Promise<{ version: string; key: string; hash: string }> {
    const artifact = randomUlid();
    const version = randomUlid();
    const hash = "e".repeat(64);
    const key = `workspaces/${FIX.workspace}/runs/01JRUN00000000000000000001/logs/${version}.jsonl.zst`;
    await db
      .prepare(
        `INSERT INTO artifacts (workspace_id, id, run_id, format, role, created_by_human_id, created_at)
         VALUES (?, ?, NULL, 'log', 'log', ?, ?)`,
      )
      .run(FIX.workspace, artifact, FIX.owner, at);
    await db
      .prepare(
        `INSERT INTO artifact_versions (workspace_id, id, artifact_id, state, format, declared_size, expected_digest, content_hash, r2_key, created_at, available_at)
         VALUES (?, ?, ?, 'available', 'log', 512, ?, ?, ?, ?, ?)`,
      )
      .run(FIX.workspace, version, artifact, "d".repeat(64), hash, key, at, at);
    return { version, key, hash };
  }

  it("deletes only eligible log objects and keeps every D1 row and hash", async () => {
    const db = await openDomainDb();
    const old = await seedLogChunk(db, "2026-07-01T12:00:00.000Z");
    const fresh = await seedLogChunk(db, "2026-09-17T12:00:00.000Z");
    await db
      .prepare(
        `INSERT INTO retention_policies (workspace_id, raw_log_retention_days, version, updated_by_human_id, updated_at)
         VALUES (?, 30, 1, ?, ?)`,
      )
      .run(FIX.workspace, FIX.owner, NOW);
    const r2 = fakeR2();
    r2.objects.set(old.key, "old-bytes");
    r2.objects.set(fresh.key, "fresh-bytes");
    const result = await runRetentionSweep(db, r2, NOW);
    expect(result.deleted_objects).toBe(1);
    expect(result.deleted_bytes).toBe(512);
    expect(r2.deleted).toEqual([old.key]);
    expect(r2.objects.get(fresh.key)).toBe("fresh-bytes");
    const versions = (await db.prepare(`SELECT COUNT(*) AS count FROM artifact_versions`).get()) as { count: number };
    expect(versions.count).toBe(2);
    const kept = (await db
      .prepare(`SELECT content_hash, r2_key FROM artifact_versions WHERE workspace_id = ? AND id = ?`)
      .get(FIX.workspace, old.version)) as { content_hash: string; r2_key: string };
    expect(kept).toEqual({ content_hash: old.hash, r2_key: old.key });
    const runs = (await db.prepare(`SELECT COUNT(*) AS count FROM retention_runs`).get()) as { count: number };
    expect(runs.count).toBe(1);
  });

  it("skips workspaces without an explicit policy", async () => {
    const db = await openDomainDb();
    const result = await runRetentionSweep(db, fakeR2(), NOW);
    expect(result.deleted_objects).toBe(0);
    const runs = (await db.prepare(`SELECT COUNT(*) AS count FROM retention_runs`).get()) as { count: number };
    expect(runs.count).toBe(0);
  });
});
