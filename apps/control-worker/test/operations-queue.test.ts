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
const HELD_SWEEP = {
  workspaces: 0,
  examined: 0,
  deleted_objects: 0,
  deleted_bytes: 0,
  expired_bundles: 0,
  errors: [],
};

async function canonicalRows(db: SqlDatabase) {
  const tables = (await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()) as Array<{ name: string }>;
  const rows: Record<string, unknown> = {};
  for (const { name } of tables) {
    if (["sqlite_sequence", "d1_migrations"].includes(name)) continue;
    expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(name.startsWith("sqlite_") || name.startsWith("_cf_")).toBe(false);
    rows[name] = await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
  }
  expect(await db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  return rows;
}

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

function observeR2Access(r2: FakeR2) {
  const accessed = vi.fn();
  return {
    accessed,
    r2: new Proxy(r2, {
      get(target, property, receiver) {
        accessed(String(property));
        return Reflect.get(target, property, receiver);
      },
    }),
  };
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

async function seedBundle(
  db: SqlDatabase,
  state = "consented",
  expiresAt = "2026-09-19T12:00:00.000Z",
): Promise<string> {
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
      expiresAt,
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
    expect(queries).toHaveBeenCalledTimes(1);
    expect(queries.mock.calls[0]?.[0]).toMatch(
      /UPDATE diagnostic_bundles[\s\S]+WHERE state = 'pending_consent'/,
    );
    expect(r2.objects.size).toBe(0);
    expect(dlq).toEqual([]);
  });
});

describe("retention sweep", () => {
  async function seedLogChunk(
    db: SqlDatabase,
    at: string,
    binding: { wrongKeyRun?: boolean; runFree?: boolean; private?: boolean } = {},
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
    if (binding.private) {
      // Synthetic dormant privacy is applied only after genuine shared task/run preparation.
      await db
        .prepare(
          "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
        )
        .run(FIX.workspace, task.result.id, FIX.owner, at);
    }
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

  it("holds configured eligible shared/private logs and all metadata unchanged across repeated sweeps", async () => {
    const db = await openDomainDb();
    const shared = await seedLogChunk(db, "2026-07-01T12:00:00.000Z");
    const privateLog = await seedLogChunk(db, "2026-07-01T12:00:00.000Z", { private: true });
    const fresh = await seedLogChunk(db, "2026-09-17T12:00:00.000Z");
    const wrongRun = await seedLogChunk(db, "2026-07-01T12:00:00.000Z", { wrongKeyRun: true });
    const runFree = await seedLogChunk(db, "2026-07-01T12:00:00.000Z", { runFree: true });
    await db
      .prepare(
        `INSERT INTO retention_policies (workspace_id, raw_log_retention_days, version, updated_by_human_id, updated_at)
         VALUES (?, 30, 1, ?, ?)`,
      )
      .run(FIX.workspace, FIX.owner, NOW);
    const listed = await listSystemRetentionEligibleChunks(db, FIX.workspace, NOW);
    expect(listed.eligible.map((chunk) => chunk.version_id).sort()).toEqual(
      [shared.version, privateLog.version].sort(),
    );
    const r2 = fakeR2(99, 99);
    for (const chunk of [shared, privateLog, fresh, wrongRun, runFree])
      r2.objects.set(chunk.key, "retained synthetic bytes");
    const objects = new Map(r2.objects);
    const before = await canonicalRows(db);
    expect(before.retention_runs).toEqual([]);
    const observed = observeR2Access(r2);
    const queries = vi.spyOn(db, "prepare");
    expect(await runRetentionSweep(db, observed.r2, NOW)).toEqual(HELD_SWEEP);
    expect(await runRetentionSweep(db, observed.r2, "2026-10-18T12:00:00.000Z")).toEqual(
      HELD_SWEEP,
    );
    expect(queries.mock.calls.map(([sql]) => sql)).toEqual([
      expect.stringMatching(/UPDATE diagnostic_bundles[\s\S]+WHERE state = 'pending_consent'/),
      expect.stringMatching(/UPDATE diagnostic_bundles[\s\S]+WHERE state = 'pending_consent'/),
    ]);
    queries.mockRestore();
    expect(observed.accessed).not.toHaveBeenCalled();
    expect(r2.objects).toEqual(objects);
    expect(r2.deleted).toEqual([]);
    expect(r2.failures).toBe(99);
    expect(r2.deleteFailures).toBe(99);
    expect(await canonicalRows(db)).toEqual(before);
  });

  it("does not enumerate unconfigured workspaces or access R2", async () => {
    const db = await openDomainDb();
    const before = await canonicalRows(db);
    const observed = observeR2Access(fakeR2());
    const queries = vi.spyOn(db, "prepare");
    expect(await runRetentionSweep(db, observed.r2, NOW)).toEqual(HELD_SWEEP);
    expect(queries).toHaveBeenCalledTimes(1);
    expect(queries.mock.calls[0]?.[0]).toMatch(
      /UPDATE diagnostic_bundles[\s\S]+WHERE state = 'pending_consent'/,
    );
    queries.mockRestore();
    expect(observed.accessed).not.toHaveBeenCalled();
    expect(await canonicalRows(db)).toEqual(before);
  });

  it("expires only pending consent at or before the supplied cutoff without purge bookkeeping", async () => {
    const db = await openDomainDb();
    const beforeCutoff = await seedBundle(db, "pending_consent", "2026-09-18T11:59:59.000Z");
    const atCutoff = await seedBundle(db, "pending_consent", NOW);
    await seedBundle(db, "pending_consent", "2026-09-18T12:00:01.000Z");
    await seedBundle(db, "consented", "2026-09-18T11:59:59.000Z");
    await seedBundle(db, "expired", "2026-09-18T11:59:59.000Z");
    await seedBundle(db, "failed", "2026-09-18T11:59:59.000Z");
    const before = await canonicalRows(db);
    const observed = observeR2Access(fakeR2());
    expect(await runRetentionSweep(db, observed.r2, NOW)).toEqual({
      ...HELD_SWEEP,
      expired_bundles: 2,
    });
    const expected = {
      ...before,
      diagnostic_bundles: (before.diagnostic_bundles as DiagnosticBundleRecord[]).map((row) =>
        [beforeCutoff, atCutoff].includes(row.id)
          ? { ...row, state: "expired", last_error: "consent_expired" }
          : row,
      ),
    };
    expect(await canonicalRows(db)).toEqual(expected);
    expect(await runRetentionSweep(db, observed.r2, NOW)).toEqual(HELD_SWEEP);
    expect(await canonicalRows(db)).toEqual(expected);
    expect(observed.accessed).not.toHaveBeenCalled();
  });
});
