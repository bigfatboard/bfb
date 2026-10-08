// ABOUTME: Proves operations step-up expiry at the prepared atomic consumption batch.
// ABOUTME: Unchanged SQLite fixtures distinguish rollback from delayed committed history and ledger retries.

import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { adaptD1, type D1Like, type D1StatementLike, type SqlDatabase } from "@bfb/db";

import { FIX } from "../src/fixtures.js";
import { WorkspaceHub, type CommandOutcome } from "../src/hub.js";
import { isUlid, randomUlid } from "../src/ids.js";
import {
  OPS_STEP_UP_ACTIONS,
  recoveryActionId,
  resolveStuckUploadCommand,
  setRetentionPolicyCommand,
  type OpsRecoveryResult,
  type RetentionPolicy,
} from "../src/operations.js";
import { issueStepUpProof } from "../src/step-up.js";
import { createTaskCommand } from "../src/work-commands.js";
import { createRunCommand } from "../src/work-records.js";
import { openDomainDb } from "./helpers.js";
import { success } from "./launch-fixture.js";

type Family = "retention" | "recovery" | "recovery_retry";
type Row = Record<string, unknown>;
type Snapshot = { canonical: Record<string, Row[]>; budgets: Row[] };
type Proof = Row & {
  proof_id: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
};

const DELAY_MS = 2_200;
const SHORT_TTL_SECONDS = 2;
const LIVE_TTL_SECONDS = 120;
const FAILED_BATCH = {
  ok: false,
  error: { code: "command_failed", message: "command failed" },
};

async function snapshot(db: SqlDatabase): Promise<Snapshot> {
  const canonical: Record<string, Row[]> = {};
  const tables = (await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()) as Array<{ name: string }>;
  for (const { name } of tables) {
    if (
      name.startsWith("sqlite_") ||
      name.startsWith("_cf_") ||
      name === "d1_migrations" ||
      name === "rate_limit_buckets"
    )
      continue;
    expect(name).toMatch(/^[a-z_][a-z0-9_]*$/);
    canonical[name] = (await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()) as Row[];
  }
  // No HTTP route is called; budgets are still independently retained and compared.
  const budgets = (await db
    .prepare("SELECT * FROM rate_limit_buckets ORDER BY rowid")
    .all()) as Row[];
  return { canonical, budgets };
}

async function clock(db: SqlDatabase) {
  return (await db
    .prepare(
      "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now, strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second') AS issued_at",
    )
    .get()) as { now: string; issued_at: string };
}

async function issueProof(db: SqlDatabase, family: Family, ttlSeconds = LIVE_TTL_SECONDS) {
  const observed = await clock(db);
  const proofId = await issueStepUpProof(
    db,
    FIX.owner,
    {
      action: family === "retention" ? OPS_STEP_UP_ACTIONS.retention : OPS_STEP_UP_ACTIONS.recover,
      workspaceId: FIX.workspace,
      targetId:
        family === "retention"
          ? `ops-retention:${FIX.workspace}`
          : `ops-recover:resolve_stuck_upload:${FIX.workspace}`,
      scopes: [],
      authorizationEpoch: 1,
      expiresAt: new Date(Date.parse(observed.now) + ttlSeconds * 1_000).toISOString(),
    },
    observed.issued_at,
  );
  // Synthetic passkey assertion setup uses the real proof issuer and an initial
  // SQL-relative window, not an expiry UPDATE or a replaced database clock.
  const proof = (await db
    .prepare("SELECT * FROM passkey_step_up_proofs WHERE proof_id=?")
    .get(proofId)) as Proof;
  return { proofId, proof, observedAt: observed.now };
}

async function expired(db: SqlDatabase, proofId: string) {
  const row = (await db
    .prepare(
      "SELECT CASE WHEN julianday(expires_at)<=julianday('now') THEN 1 ELSE 0 END AS expired FROM passkey_step_up_proofs WHERE proof_id=?",
    )
    .get(proofId)) as { expired: number } | undefined;
  expect(row).toBeDefined();
  return row!.expired === 1;
}

async function fixture(family: Family) {
  const db = await openDomainDb();
  let versionId: string | undefined;
  if (family === "retention") {
    const initial = await issueProof(db, family);
    success(
      await new WorkspaceHub(db).execute(setRetentionPolicyCommand, {
        workspaceId: FIX.workspace,
        actorHumanId: FIX.owner,
        authorizationEpoch: 1,
        idempotencyKey: randomUlid(),
        now: initial.observedAt,
        input: { rawLogRetentionDays: 7, stepUpProofId: initial.proofId },
      }),
    );
  } else {
    const task = success(
      await new WorkspaceHub(db).execute(createTaskCommand, {
        workspaceId: FIX.workspace,
        actorHumanId: FIX.member,
        authorizationEpoch: 1,
        idempotencyKey: randomUlid(),
        input: {
          projectId: FIX.projectA,
          title: "Synthetic step-up recovery parent",
          priority: "P2",
        },
      }),
    );
    const run = success(
      await new WorkspaceHub(db).execute(createRunCommand, {
        workspaceId: FIX.workspace,
        actorHumanId: FIX.owner,
        authorizationEpoch: 1,
        idempotencyKey: randomUlid(),
        input: {
          taskId: task.id,
          expectedTaskVersion: task.resource_version,
          agentProfileId: FIX.profileCodex,
          workspacePolicyVersion: 1,
          projectPolicyVersion: 1,
          repositoryConfigVersion: 1,
          agentProfileVersion: 1,
        },
      }),
    );
    const artifactId = randomUlid();
    versionId = randomUlid();
    const observed = await clock(db);
    const old = new Date(Date.parse(observed.now) - 60 * 60_000).toISOString();
    // Synthetic immutable uploading metadata, with genuine shared task/run
    // lineage and no capability/object. It is beyond V01's TTL plus grace.
    await db
      .prepare(
        "INSERT INTO artifacts (workspace_id,id,run_id,format,role,created_by_human_id,created_at) VALUES (?,?,?,'log','log',?,?)",
      )
      .run(FIX.workspace, artifactId, run.run.id, FIX.member, old);
    await db
      .prepare(
        "INSERT INTO artifact_versions (workspace_id,id,artifact_id,state,format,declared_size,expected_digest,created_at) VALUES (?,?,?,'uploading','log',64,?,?)",
      )
      .run(FIX.workspace, versionId, artifactId, "a".repeat(64), old);
    if (family === "recovery_retry") {
      const initial = await issueProof(db, family);
      const original = success(
        await new WorkspaceHub(db).execute(resolveStuckUploadCommand, {
          workspaceId: FIX.workspace,
          actorHumanId: FIX.owner,
          authorizationEpoch: 1,
          idempotencyKey: randomUlid(),
          input: { versionIds: [versionId], stepUpProofId: initial.proofId },
        }),
      );
      expect(original.replayed).toBe(false);
      expect(original.detail).toEqual({ resolved: 1 });
    }
  }
  expect(await db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  return { db, family, versionId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function execute(
  f: Fixture,
  db: SqlDatabase,
  proof: Awaited<ReturnType<typeof issueProof>>,
  key: string,
): Promise<CommandOutcome<RetentionPolicy> | CommandOutcome<OpsRecoveryResult>> {
  const request = {
    workspaceId: FIX.workspace,
    actorHumanId: FIX.owner,
    authorizationEpoch: 1,
    idempotencyKey: key,
    now: proof.observedAt,
  };
  return f.family === "retention"
    ? new WorkspaceHub(db).execute(setRetentionPolicyCommand, {
        ...request,
        input: { rawLogRetentionDays: 14, stepUpProofId: proof.proofId },
      })
    : new WorkspaceHub(db).execute(resolveStuckUploadCommand, {
        ...request,
        input: { versionIds: [f.versionId!], stepUpProofId: proof.proofId },
      });
}

function stagedProofConsumption(
  f: Fixture,
  proof: Awaited<ReturnType<typeof issueProof>>,
  baseline: Snapshot,
  mode: "expired" | "live" | "committed",
) {
  const entries = new Map<D1StatementLike, { sql: string; params: unknown[] }>();
  const witness = {
    batches: 0,
    preparedLive: false,
    delayedUnchanged: false,
    committedBeforeExpiry: false,
    observation: "",
    stamp: "",
    probeError: undefined as unknown,
    maximumBindings: 0,
    maximumSqlBytes: 0,
    batchLengths: [] as number[],
    committedSnapshot: undefined as Snapshot | undefined,
  };
  async function observe(check: () => Promise<void>) {
    try {
      await check();
    } catch (error) {
      // A failed witness must not look like the expected Hub batch rejection.
      witness.probeError = error;
      throw error;
    }
  }
  const binding: D1Like = {
    prepare(sql) {
      witness.maximumSqlBytes = Math.max(witness.maximumSqlBytes, Buffer.byteLength(sql, "utf8"));
      const entry = { sql, params: [] as unknown[] };
      const statement: D1StatementLike = {
        bind(...params) {
          entry.params = params;
          witness.maximumBindings = Math.max(witness.maximumBindings, params.length);
          return statement;
        },
        async first(column) {
          const row = (await f.db.prepare(sql).get(...entry.params)) as Row | undefined;
          return column ? (row?.[column] ?? null) : (row ?? null);
        },
        all: async () => ({ results: await f.db.prepare(sql).all(...entry.params) }),
        async run() {
          const result = await f.db.prepare(sql).run(...entry.params);
          if (result.changes === null) throw new Error("synthetic SQLite write must have a result");
          return { meta: { changes: result.changes } };
        },
      };
      entries.set(statement, entry);
      return statement;
    },
    async batch(pending) {
      const writes = pending.map((statement) => entries.get(statement)!);
      const consumption = writes.filter((entry) =>
        /UPDATE passkey_step_up_proofs\s+SET consumed_at\s*=/i.test(entry.sql),
      );
      await observe(async () => {
        expect(consumption).toHaveLength(1);
        const prepared = consumption[0]!;
        expect(prepared.params).toHaveLength(3);
        expect(prepared.params[1]).toBe(proof.proofId);
        expect(typeof prepared.params[0]).toBe("string");
        expect(typeof prepared.params[2]).toBe("string");
        witness.stamp = prepared.params[0] as string;
        witness.observation = prepared.params[2] as string;
        expect(witness.stamp).toHaveLength(26);
        expect(isUlid(witness.stamp)).toBe(true);
        expect(Date.parse(witness.stamp)).toBeNaN();
        expect(Date.parse(witness.observation)).toBeLessThan(Date.parse(proof.proof.expires_at));
        if (f.family === "retention") expect(witness.observation).toBe(proof.observedAt);
        expect(await expired(f.db, proof.proofId)).toBe(false);
        expect(await snapshot(f.db)).toEqual(baseline);
        witness.preparedLive = true;
        witness.batches++;
        witness.batchLengths.push(writes.length);
        if (mode !== "committed") {
          // Identical real delay, with no proof/authority/source writes, for the
          // expired and comfortably live cases. No timer or SQL clock is mocked.
          await delay(DELAY_MS);
          expect(await snapshot(f.db)).toEqual(baseline);
          expect(await expired(f.db, proof.proofId)).toBe(mode === "expired");
          witness.delayedUnchanged = true;
        }
      });
      const committed = await f.db.withTransaction(async (tx) => {
        const results = [];
        for (const entry of writes) {
          // Forward the actual queued SQL and original bound values unchanged.
          const result = await tx.prepare(entry.sql).run(...entry.params);
          if (result.changes === null) throw new Error("synthetic SQLite batch must have a result");
          results.push({ meta: { changes: result.changes } });
        }
        return results;
      });
      if (mode === "committed") {
        await observe(async () => {
          expect(await expired(f.db, proof.proofId)).toBe(false);
          expect(
            await f.db
              .prepare("SELECT consumed_at FROM passkey_step_up_proofs WHERE proof_id=?")
              .get(proof.proofId),
          ).toEqual({ consumed_at: witness.stamp });
          witness.committedBeforeExpiry = true;
          witness.committedSnapshot = await snapshot(f.db);
          // The real transaction has committed; only its response is withheld.
          await delay(DELAY_MS);
          expect(await expired(f.db, proof.proofId)).toBe(true);
          expect(await snapshot(f.db)).toEqual(witness.committedSnapshot);
          witness.delayedUnchanged = true;
        });
      }
      return committed;
    },
  };
  return {
    db: adaptD1(binding),
    witness,
    assertWitness() {
      expect(witness.probeError).toBeUndefined();
      expect(witness.preparedLive).toBe(true);
      expect(witness.delayedUnchanged).toBe(true);
      expect(witness.batches).toBe(1);
      expect(witness.batchLengths).toEqual([
        f.family === "retention" ? 9 : f.family === "recovery_retry" ? 14 : 17,
      ]);
      expect(witness.maximumBindings).toBeGreaterThan(0);
      expect(witness.maximumBindings).toBeLessThanOrEqual(100);
      expect(witness.maximumSqlBytes).toBeGreaterThan(0);
      expect(witness.maximumSqlBytes).toBeLessThanOrEqual(100_000);
      expect(witness.committedBeforeExpiry).toBe(mode === "committed");
    },
  };
}

async function assertSuccess(
  f: Fixture,
  proof: Awaited<ReturnType<typeof issueProof>>,
  before: Snapshot,
  key: string,
  outcome: CommandOutcome<RetentionPolicy> | CommandOutcome<OpsRecoveryResult>,
  observed: string,
  stamp: string,
) {
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error("synthetic healthy operations command failed");
  expect(outcome.replayed).toBe(false);
  const command = f.family === "retention" ? setRetentionPolicyCommand : resolveStuckUploadCommand;
  const result =
    f.family === "retention"
      ? {
          workspace_id: FIX.workspace,
          raw_log_retention_days: 14,
          version: 2,
          updated_by_human_id: FIX.owner,
          updated_at: observed,
        }
      : {
          action_id: recoveryActionId("resolve_stuck_upload", { version_ids: [f.versionId!] }),
          kind: "resolve_stuck_upload",
          replayed: f.family === "recovery_retry",
          detail: { resolved: 1 },
        };
  expect(outcome.result).toEqual(result);
  const after = await snapshot(f.db);
  const expected = structuredClone(before);
  expected.canonical.passkey_step_up_proofs = before.canonical.passkey_step_up_proofs!.map((row) =>
    row.proof_id === proof.proofId ? { ...row, consumed_at: stamp } : row,
  );
  expect(
    after.canonical.passkey_step_up_proofs!.find((row) => row.proof_id === proof.proofId),
  ).toEqual({ ...proof.proof, consumed_at: stamp });

  if (f.family === "retention") {
    expected.canonical.retention_policies = [result];
  } else if (f.family === "recovery") {
    expected.canonical.artifact_versions = before.canonical.artifact_versions!.map((row) =>
      row.id === f.versionId ? { ...row, state: "failed" } : row,
    );
    for (const table of ["artifact_audit_outbox", "ops_recovery_ledger"]) {
      const added = after.canonical[table]!.slice(before.canonical[table]!.length);
      expect(added).toHaveLength(1);
      expected.canonical[table] = [...before.canonical[table]!, ...added];
      if (table === "artifact_audit_outbox") {
        expect(added[0]).toMatchObject({
          workspace_id: FIX.workspace,
          version_id: f.versionId,
          grant_id: null,
          action: "artifact.abandoned",
          payload_json: JSON.stringify({ version_id: f.versionId }),
          created_at: observed,
          dispatched_at: null,
        });
      } else {
        expect(added[0]).toEqual({
          workspace_id: FIX.workspace,
          action_id: (result as OpsRecoveryResult).action_id,
          kind: "resolve_stuck_upload",
          target_json: JSON.stringify({ version_ids: [f.versionId] }),
          state: "applied",
          attempt_count: 1,
          result_json: '{"resolved":1}',
          created_by_human_id: FIX.owner,
          created_at: observed,
          updated_at: observed,
        });
      }
    }
  }
  const oldCursor = before.canonical.workspace_cursors!.find(
    (row) => row.workspace_id === FIX.workspace,
  );
  expect(outcome.cursor).toBe(Number(oldCursor?.cursor ?? 0) + 1);
  expected.canonical.workspace_cursors = before.canonical.workspace_cursors!.map((row) =>
    row.workspace_id === FIX.workspace ? { ...row, cursor: outcome.cursor } : row,
  );
  for (const table of [
    "semantic_events",
    "audit_events",
    "outbox_records",
    "idempotency_records",
  ]) {
    const added = after.canonical[table]!.slice(before.canonical[table]!.length);
    expect(added).toHaveLength(1);
    const row = added[0]!;
    expect(row.workspace_id).toBe(FIX.workspace);
    expect(row.created_at).toBe(observed);
    if (table === "idempotency_records") {
      expect(row.idempotency_key).toBe(key);
      expect(row.command_name).toBe(command.name);
      expect(JSON.parse(row.result_json as string)).toEqual({
        result,
        cursor: outcome.cursor,
        authorizationEpoch: 1,
        actorHumanId: FIX.owner,
      });
    } else {
      expect(row[table === "audit_events" ? "action" : "kind"]).toBe(command.name);
      const payload = JSON.parse(row.payload_json as string) as {
        actor: unknown;
        input: unknown;
        result: unknown;
      };
      expect(payload.actor).toEqual({ humanId: FIX.owner, authorizationEpoch: 1 });
      expect(payload.input).toEqual(
        f.family === "retention" ? { raw_log_retention_days: 14 } : { version_ids: [f.versionId] },
      );
      expect(payload.result).toEqual(
        f.family === "retention"
          ? result
          : {
              action_id: (result as OpsRecoveryResult).action_id,
              kind: "resolve_stuck_upload",
              replayed: f.family === "recovery_retry",
              resolved: 1,
            },
      );
      expect(row.payload_json as string).not.toContain(proof.proofId);
      if (table === "semantic_events") expect(row.workspace_cursor).toBe(outcome.cursor);
      if (table === "audit_events") expect(row.actor_principal_id).toBe(FIX.owner);
      if (table === "outbox_records") expect(row.delivered_at).toBeNull();
    }
    expected.canonical[table] = [...before.canonical[table]!, ...added];
  }
  // Includes all business/OAuth history, exact prior ledger retry rows and the
  // transient CHECK tables, not just newly written table counts.
  expect(after).toEqual(expected);
  expect(await f.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  const reused = await execute(f, f.db, proof, randomUlid());
  expect(reused).toEqual({
    ok: false,
    error: { code: "step_up_replayed", message: "proof already consumed" },
  });
  expect(await snapshot(f.db)).toEqual(after);
}

describe("operations step-up atomic natural expiry", () => {
  for (const family of ["retention", "recovery", "recovery_retry"] as const) {
    it(`${family} rolls back when an unchanged live prepared proof expires before batch execution`, async () => {
      const f = await fixture(family);
      const proof = await issueProof(f.db, family, SHORT_TTL_SECONDS);
      const baseline = await snapshot(f.db);
      const staged = stagedProofConsumption(f, proof, baseline, "expired");
      const outcome = await execute(f, staged.db, proof, randomUlid());
      staged.assertWitness();
      expect.soft(outcome).toEqual(FAILED_BATCH);
      expect.soft(await snapshot(f.db)).toEqual(baseline);
      expect(await expired(f.db, proof.proofId)).toBe(true);
      expect(await f.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });

    it(`${family} commits after the same delay with a comfortably live unchanged proof`, async () => {
      const f = await fixture(family);
      const proof = await issueProof(f.db, family);
      const baseline = await snapshot(f.db);
      const staged = stagedProofConsumption(f, proof, baseline, "live");
      const key = randomUlid();
      const outcome = await execute(f, staged.db, proof, key);
      staged.assertWitness();
      await assertSuccess(
        f,
        proof,
        baseline,
        key,
        outcome,
        staged.witness.observation,
        staged.witness.stamp,
      );
    });
  }

  for (const family of ["retention", "recovery"] as const) {
    it(`${family} retains success when the committed batch response arrives after proof expiry`, async () => {
      const f = await fixture(family);
      const proof = await issueProof(f.db, family, SHORT_TTL_SECONDS);
      const baseline = await snapshot(f.db);
      const staged = stagedProofConsumption(f, proof, baseline, "committed");
      const key = randomUlid();
      const outcome = await execute(f, staged.db, proof, key);
      staged.assertWitness();
      await assertSuccess(
        f,
        proof,
        baseline,
        key,
        outcome,
        staged.witness.observation,
        staged.witness.stamp,
      );
      expect(await snapshot(f.db)).toEqual(staged.witness.committedSnapshot);
    });
  }
});
