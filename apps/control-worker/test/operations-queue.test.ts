// ABOUTME: Proves OPS queue isolation, retry-to-DLQ, and retention sweep boundaries.
// ABOUTME: A poison job never replays siblings; retention never touches hashes or metadata.

import { describe, expect, it, vi } from "vitest";

import {
  createRunCommand,
  createTaskCommand,
  FIX,
  listSystemRetentionEligibleChunks,
  randomUlid,
  WorkspaceHub,
  type DiagnosticBundleRecord,
} from "@bfb/domain";

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { adaptBetterSqlite3, applyMigrationsForVerification, type SqlDatabase } from "@bfb/db";

import {
  consumeOpsQueueBatch,
  renderBundleBody,
  type OpsQueueDeps,
  type OpsQueueHandle,
} from "../src/operations/queue.js";
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
  deleteFailures: number;
  deleted: string[];
  put(key: string, body: string): Promise<void>;
  delete(key: string): Promise<void>;
}

function fakeR2(failures = 0, deleteFailures = 0): FakeR2 {
  const state: FakeR2 = {
    objects: new Map(),
    failures,
    deleteFailures,
    deleted: [],
    async put(key: string, body: string) {
      if (state.failures > 0) {
        state.failures -= 1;
        throw new Error("r2 unavailable");
      }
      state.objects.set(key, body);
    },
    async delete(key: string) {
      if (state.deleteFailures > 0) {
        state.deleteFailures -= 1;
        throw new Error("r2 unavailable");
      }
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
    .run(
      FIX.workspace,
      id,
      FIX.owner,
      state,
      "a".repeat(64),
      NOW,
      state === "consented" ? NOW : null,
      "2026-09-19T12:00:00.000Z",
    );
  return id;
}

describe("ops queue consumer", () => {
  it("acks a consented bundle before lookup while preserving its row and stored object", async () => {
    const db = await openDomainDb();
    const r2 = fakeR2();
    const dlq: unknown[] = [];
    const events: string[] = [];
    const bundle = await seedBundle(db);
    const key = `workspaces/${FIX.workspace}/diagnostics/${bundle}.json`;
    r2.objects.set(key, "retained synthetic inventory");
    const before = await db
      .prepare("SELECT * FROM diagnostic_bundles WHERE workspace_id=? AND id=?")
      .get(FIX.workspace, bundle);
    const queries = vi.spyOn(db, "prepare");
    await consumeOpsQueueBatch(
      [
        handle(
          {
            schema_version: 1,
            kind: "diagnostic.upload",
            workspace_id: FIX.workspace,
            bundle_id: bundle,
            attempt: 1,
          },
          events,
          "good",
        ),
      ],
      depsFor(r2, db, dlq),
      NOW,
    );
    expect(events).toEqual(["good:ack"]);
    expect(dlq).toEqual([]);
    expect(queries).not.toHaveBeenCalled();
    expect(r2.objects.get(key)).toBe("retained synthetic inventory");
    expect(r2.deleted).toEqual([]);
    const row = (await db
      .prepare(`SELECT * FROM diagnostic_bundles WHERE workspace_id = ? AND id = ?`)
      .get(FIX.workspace, bundle)) as DiagnosticBundleRecord;
    expect(row).toEqual(before);
  });

  it("isolates poison jobs while diagnostic attempts acknowledge without upload or DLQ effects", async () => {
    const db = await openDomainDb();
    const r2 = fakeR2(99);
    const dlq: unknown[] = [];
    const events: string[] = [];
    const bundle = await seedBundle(db);
    await consumeOpsQueueBatch(
      [
        handle(
          {
            schema_version: 1,
            kind: "diagnostic.upload",
            workspace_id: FIX.workspace,
            bundle_id: bundle,
            attempt: 1,
          },
          events,
          "flaky",
          0,
        ),
        handle({ nope: true }, events, "poison", 0),
        handle(
          {
            schema_version: 1,
            kind: "diagnostic.upload",
            workspace_id: FIX.workspace,
            bundle_id: bundle,
            attempt: 1,
          },
          events,
          "exhausted",
          7,
        ),
      ],
      depsFor(r2, db, dlq),
      NOW,
    );
    expect(events).toEqual(["flaky:ack", "poison:retry", "exhausted:ack"]);
    expect(dlq).toEqual([]);
    expect(r2.failures).toBe(99);
    const row = (await db
      .prepare(`SELECT state FROM diagnostic_bundles WHERE workspace_id = ? AND id = ?`)
      .get(FIX.workspace, bundle)) as { state: string };
    expect(row.state).toBe("consented");
  });

  it("treats unknown and unconsented bundles equally without lookup or state-sensitive DLQ copies", async () => {
    const db = await openDomainDb();
    const r2 = fakeR2();
    const dlq: unknown[] = [];
    const events: string[] = [];
    const pending = await seedBundle(db, "pending_consent");
    const queries = vi.spyOn(db, "prepare");
    await consumeOpsQueueBatch(
      [
        handle(
          {
            schema_version: 1,
            kind: "diagnostic.upload",
            workspace_id: FIX.workspace,
            bundle_id: randomUlid(),
            attempt: 1,
          },
          events,
          "unknown",
        ),
        handle(
          {
            schema_version: 1,
            kind: "diagnostic.upload",
            workspace_id: FIX.workspace,
            bundle_id: pending,
            attempt: 1,
          },
          events,
          "unconsented",
        ),
      ],
      depsFor(r2, db, dlq),
      NOW,
    );
    expect(events).toEqual(["unknown:ack", "unconsented:ack"]);
    expect(queries).not.toHaveBeenCalled();
    expect(r2.objects.size).toBe(0);
    expect(dlq).toEqual([]);
  });

  it("does not let a claimed newer inventory schema authorize body rendering", async () => {
    const db = await openDomainDb();
    const id = await seedBundle(db);
    await db
      .prepare("UPDATE diagnostic_bundles SET inventory_json=? WHERE workspace_id=? AND id=?")
      .run('{"schema_version":2,"tasks":17}', FIX.workspace, id);
    const row = (await db
      .prepare("SELECT * FROM diagnostic_bundles WHERE workspace_id=? AND id=?")
      .get(FIX.workspace, id)) as DiagnosticBundleRecord;
    expect(() => renderBundleBody(row)).toThrowError("diagnostic bundles are unavailable");
  });

  it("continues a valid retention sibling after a poison job and a quarantined diagnostic job", async () => {
    const db = await openDomainDb();
    const r2 = fakeR2();
    const dlq: unknown[] = [];
    const events: string[] = [];
    const id = await seedBundle(db);
    const queries = vi.spyOn(db, "prepare");
    await consumeOpsQueueBatch(
      [
        handle({ nope: true }, events, "poison"),
        handle(
          {
            schema_version: 1,
            kind: "diagnostic.upload",
            workspace_id: FIX.workspace,
            bundle_id: id,
            attempt: 1,
          },
          events,
          "held",
        ),
        handle(
          { schema_version: 1, kind: "retention.sweep", workspace_id: FIX.workspace, attempt: 1 },
          events,
          "retention",
        ),
      ],
      depsFor(r2, db, dlq),
      NOW,
    );
    expect(events).toEqual(["poison:retry", "held:ack", "retention:ack"]);
    expect(queries.mock.calls.some(([sql]) => sql.includes("SELECT id FROM workspaces"))).toBe(
      true,
    );
    expect(r2.objects.size).toBe(0);
    expect(dlq).toEqual([]);
  });
});

describe("retention sweep", () => {
  async function seedLogChunk(
    db: SqlDatabase,
    at: string,
    binding: { wrongKeyRun?: boolean; runFree?: boolean } = {},
  ): Promise<{ version: string; key: string; hash: string }> {
    const artifact = randomUlid();
    const version = randomUlid();
    const hash = "e".repeat(64);
    const hub = new WorkspaceHub(db);
    const task = await hub.execute(createTaskCommand, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      input: { projectId: FIX.projectA, title: "Synthetic retention parent", priority: "P2" },
    });
    if (!task.ok) throw new Error(task.error.code);
    const run = await hub.execute(createRunCommand, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      input: {
        taskId: task.result.id,
        expectedTaskVersion: 1,
        agentProfileId: FIX.profileCodex,
        workspacePolicyVersion: 1,
        projectPolicyVersion: 1,
        repositoryConfigVersion: 1,
        agentProfileVersion: 1,
      },
    });
    if (!run.ok) throw new Error(run.error.code);
    const keyRun = binding.wrongKeyRun ? randomUlid() : run.result.run.id;
    const key = `workspaces/${FIX.workspace}/runs/${keyRun}/logs/${version}.jsonl.zst`;
    await db
      .prepare(
        `INSERT INTO artifacts (workspace_id, id, run_id, format, role, created_by_human_id, created_at)
         VALUES (?, ?, ?, 'log', 'log', ?, ?)`,
      )
      .run(FIX.workspace, artifact, binding.runFree ? null : run.result.run.id, FIX.owner, at);
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
    const versions = (await db
      .prepare(`SELECT COUNT(*) AS count FROM artifact_versions`)
      .get()) as { count: number };
    expect(versions.count).toBe(2);
    const kept = (await db
      .prepare(
        `SELECT state, content_hash, r2_key FROM artifact_versions WHERE workspace_id = ? AND id = ?`,
      )
      .get(FIX.workspace, old.version)) as {
      state: string;
      content_hash: string;
      r2_key: string;
    };
    expect(kept).toEqual({ state: "retained", content_hash: old.hash, r2_key: old.key });
    const runs = (await db.prepare(`SELECT COUNT(*) AS count FROM retention_runs`).get()) as {
      count: number;
    };
    expect(runs.count).toBe(1);
  });

  it("never re-deletes or re-counts purged chunks on later ticks", async () => {
    const db = await openDomainDb();
    const old = await seedLogChunk(db, "2026-07-01T12:00:00.000Z");
    await db
      .prepare(
        `INSERT INTO retention_policies (workspace_id, raw_log_retention_days, version, updated_by_human_id, updated_at)
         VALUES (?, 30, 1, ?, ?)`,
      )
      .run(FIX.workspace, FIX.owner, NOW);
    const r2 = fakeR2();
    r2.objects.set(old.key, "old-bytes");
    const first = await runRetentionSweep(db, r2, NOW);
    expect(first.deleted_objects).toBe(1);
    expect(first.deleted_bytes).toBe(512);
    const second = await runRetentionSweep(db, r2, NOW);
    expect(second.deleted_objects).toBe(0);
    expect(second.deleted_bytes).toBe(0);
    expect(second.examined).toBe(0);
    expect(r2.deleted).toEqual([old.key]);
    const listed = await listSystemRetentionEligibleChunks(db, FIX.workspace, NOW);
    expect(listed.eligible).toEqual([]);
    const totals = (await db
      .prepare(`SELECT SUM(deleted_bytes) AS bytes FROM retention_runs WHERE workspace_id = ?`)
      .get(FIX.workspace)) as { bytes: number };
    expect(totals.bytes).toBe(512);
  });

  it("keeps failed deletes available so the next tick retries them", async () => {
    const db = await openDomainDb();
    const old = await seedLogChunk(db, "2026-07-01T12:00:00.000Z");
    await db
      .prepare(
        `INSERT INTO retention_policies (workspace_id, raw_log_retention_days, version, updated_by_human_id, updated_at)
         VALUES (?, 30, 1, ?, ?)`,
      )
      .run(FIX.workspace, FIX.owner, NOW);
    const flaky = fakeR2(0, 99);
    flaky.objects.set(old.key, "old-bytes");
    const failed = await runRetentionSweep(db, flaky, NOW);
    expect(failed.deleted_objects).toBe(0);
    expect(failed.errors).toHaveLength(1);
    const row = (await db
      .prepare(`SELECT state FROM artifact_versions WHERE workspace_id = ? AND id = ?`)
      .get(FIX.workspace, old.version)) as { state: string };
    expect(row.state).toBe("available");
    const healthy = fakeR2();
    healthy.objects.set(old.key, "old-bytes");
    const retried = await runRetentionSweep(db, healthy, NOW);
    expect(retried.deleted_objects).toBe(1);
    expect(retried.deleted_bytes).toBe(512);
  });

  it("skips workspaces without an explicit policy", async () => {
    const db = await openDomainDb();
    const result = await runRetentionSweep(db, fakeR2(), NOW);
    expect(result.deleted_objects).toBe(0);
    const runs = (await db.prepare(`SELECT COUNT(*) AS count FROM retention_runs`).get()) as {
      count: number;
    };
    expect(runs.count).toBe(0);
  });

  it("does not delete misbound log keys or run-free log objects", async () => {
    const db = await openDomainDb();
    const wrongRun = await seedLogChunk(db, "2026-07-01T12:00:00.000Z", { wrongKeyRun: true });
    const runFree = await seedLogChunk(db, "2026-07-01T12:00:00.000Z", { runFree: true });
    await db
      .prepare(
        `INSERT INTO retention_policies (workspace_id, raw_log_retention_days, version, updated_by_human_id, updated_at)
         VALUES (?, 30, 1, ?, ?)`,
      )
      .run(FIX.workspace, FIX.owner, NOW);
    const r2 = fakeR2();
    r2.objects.set(wrongRun.key, "misbound synthetic bytes");
    r2.objects.set(runFree.key, "run-free synthetic bytes");
    const result = await runRetentionSweep(db, r2, NOW);
    expect(result).toMatchObject({ examined: 0, deleted_objects: 0, deleted_bytes: 0, errors: [] });
    expect(r2.deleted).toEqual([]);
    expect(r2.objects.size).toBe(2);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM artifact_versions WHERE state = 'available'")
        .get(),
    ).toEqual({ count: 2 });
  });
});
