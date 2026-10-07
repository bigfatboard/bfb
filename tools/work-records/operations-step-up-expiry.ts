// ABOUTME: Proves operations-local step-up expiry at actual disposable native D1 batch execution.
// ABOUTME: Unchanged proofs, original bound statements and complete snapshots separate rollback from committed return delay.

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { adaptD1, loadMigrationManifest, type D1Like, type D1StatementLike } from "@bfb/db";
import {
  FIX,
  WorkspaceHub,
  issueStepUpProof,
  isUlid,
  loadPrincipal,
  randomUlid,
  recoveryActionId,
  resolveStuckUploadCommand,
  seedSyntheticWorkspace,
  setRetentionPolicyCommand,
  type CommandOutcome,
  type CreateRunResult,
  type HubCommand,
  type TaskRecord,
} from "@bfb/domain";
import { createTestHarness } from "wrangler";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const origin = "https://bfb.operations-step-up-expiry.test";
const server = createTestHarness({
  root,
  workers: [
    { configPath: "tools/work-records/wrangler-a.toml" },
    { configPath: "tools/work-records/wrangler-b.toml" },
    { configPath: "tools/work-records/wrangler-hub.toml" },
  ],
});
const preBatchDelayMs = 5_000;
const proofLifetimeMs = { expired: 4_000, live: 10_000 } as const;
type Mode = keyof typeof proofLifetimeMs;
type Family = "retention_set" | "fresh_upload_recovery" | "target_ledger_retry";
type Snapshot = Record<string, Record<string, unknown>[]>;
interface ProofWindow {
  id: string;
  createdAt: string;
  expiresAt: string;
}
interface ProofClock {
  database_now: string;
  live: number;
  expires_at: string;
  consumed_at: string | null;
}
interface Witness {
  prepared_bound: boolean;
  live_at_seam: boolean;
  unchanged_during_delay: boolean;
  expected_clock_boundary: boolean;
  original_statements_forwarded: boolean;
  batch_rolled_back: boolean;
  committed_before_return_delay: boolean;
  return_after_expiry: boolean;
  committed_history_unchanged: boolean;
  original_occurrence_times: boolean;
}
const bounds = { maximum_bindings: 0, maximum_statement_bytes: 0, maximum_batch_statements: 0 };
const groups: Array<{
  check: Family;
  mode: Mode;
  outcome: "passed" | "failed";
  hub_outcome: string | null;
  proof_consumed: boolean | null;
  witness: Witness;
}> = [];
const failures: Array<{ check: Family; mode: Mode; phase: string; error_name: string }> = [];

function success<T>(outcome: CommandOutcome<T>): T {
  assert(outcome.ok, "synthetic setup command must succeed");
  return outcome.result;
}

try {
  await server.listen();
  const worker = server.getWorker("bfb-work-records-hub");
  await worker.applyD1Migrations("DB");
  const binding = ((await worker.getEnv()) as unknown as { DB: D1Like }).DB;
  const db = adaptD1(binding);
  const manifest = loadMigrationManifest(resolve(root, "migrations/d1"));
  await seedSyntheticWorkspace(db, new Date().toISOString(), "global");
  const principal = await loadPrincipal(db, FIX.workspace, FIX.owner);
  assert.equal(principal.role, "owner");
  const allTables = (await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()) as Array<{ name: string }>;
  const engineTables = new Set(["sqlite_sequence", "_cf_KV", "_cf_METADATA", "d1_migrations"]);
  const tables = allTables.filter(({ name }) => !engineTables.has(name));
  for (const { name } of tables) assert(/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name));

  async function snapshot(): Promise<Snapshot> {
    return Object.fromEntries(
      await Promise.all(
        tables.map(async ({ name }) => [
          name,
          (await db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()) as Record<
            string,
            unknown
          >[],
        ]),
      ),
    );
  }
  async function foreignKeys() {
    assert.deepEqual(await db.prepare("PRAGMA foreign_key_check").all(), []);
  }
  async function clock(proofId: string): Promise<ProofClock> {
    const row = (await db
      .prepare(
        `SELECT expires_at,consumed_at,strftime('%Y-%m-%dT%H:%M:%fZ','now') AS database_now,
          julianday(expires_at)>julianday('now') AS live
         FROM passkey_step_up_proofs WHERE proof_id=?`,
      )
      .get(proofId)) as ProofClock | undefined;
    assert(row, "synthetic proof must remain canonical");
    return row;
  }
  async function waitForExpiry(proofId: string) {
    const started = Date.now();
    for (;;) {
      const current = await clock(proofId);
      if (current.live === 0) return current;
      assert(Date.now() - started < 15_000, "post-commit expiry wait must remain bounded");
      await delay(50);
    }
  }
  async function issue(action: string, targetId: string, lifetimeMs: number): Promise<ProofWindow> {
    const window = (await db
      .prepare(
        `SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS created_at,
          strftime('%Y-%m-%dT%H:%M:%fZ','now',?) AS expires_at`,
      )
      .get(`+${lifetimeMs / 1000} seconds`)) as { created_at: string; expires_at: string };
    const id = await issueStepUpProof(
      db,
      principal.humanId,
      {
        action,
        workspaceId: FIX.workspace,
        targetId,
        scopes: [],
        authorizationEpoch: principal.authorizationEpoch,
        expiresAt: window.expires_at,
      },
      window.created_at,
    );
    return { id, createdAt: window.created_at, expiresAt: window.expires_at };
  }
  async function setupCommand<T>(name: string, input: unknown): Promise<T> {
    const response = await server
      .getWorker("bfb-work-records-a")
      .fetch(`${origin}/workspaces/${FIX.workspace}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandName: name,
          request: {
            workspaceId: FIX.workspace,
            actorHumanId: principal.humanId,
            authorizationEpoch: principal.authorizationEpoch,
            idempotencyKey: randomUlid(),
            input,
          },
        }),
      });
    assert.equal(response.status, 200);
    return success((await response.json()) as CommandOutcome<T>);
  }
  const task = await setupCommand<TaskRecord>("task.create", {
    projectId: FIX.projectA,
    title: "Synthetic operations expiry parent",
    priority: "P2",
  });
  const run = await setupCommand<CreateRunResult>("run.create", {
    taskId: task.id,
    expectedTaskVersion: task.resource_version,
    agentProfileId: FIX.profileCodex,
    workspacePolicyVersion: 1,
    projectPolicyVersion: 1,
    repositoryConfigVersion: 1,
    agentProfileVersion: 1,
  });
  async function abandonedTargets() {
    const old = (await db
      .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour') AS created_at")
      .get()) as { created_at: string };
    const ids: string[] = [];
    for (const runId of [run.run.id, null]) {
      const artifactId = randomUlid();
      const versionId = randomUlid();
      // Dormant bookkeeping fixtures have no grants, object bytes or execution authority.
      await db
        .prepare(
          "INSERT INTO artifacts (workspace_id,id,run_id,format,role,created_by_human_id,created_at) VALUES (?,?,?,'log','log',?,?)",
        )
        .run(FIX.workspace, artifactId, runId, principal.humanId, old.created_at);
      await db
        .prepare(
          `INSERT INTO artifact_versions
          (workspace_id,id,artifact_id,state,format,declared_size,expected_digest,created_at)
          VALUES (?,?,?,'uploading','log',64,?,?)`,
        )
        .run(FIX.workspace, versionId, artifactId, "d".repeat(64), old.created_at);
      ids.push(versionId);
    }
    return ids;
  }

  function measuredBinding(proof: ProofWindow, mode: Mode, witness: Witness) {
    const original = new WeakMap<D1StatementLike, D1StatementLike>();
    const metadata = new WeakMap<D1StatementLike, { sql: string; parameters: unknown[] }>();
    let consumptionStamp = "";
    let observedAt = "";
    let beforeBatch: Snapshot | undefined;
    let committed: Snapshot | undefined;
    const measured: D1Like = {
      prepare(sql) {
        bounds.maximum_statement_bytes = Math.max(
          bounds.maximum_statement_bytes,
          Buffer.byteLength(sql),
        );
        assert(Buffer.byteLength(sql) <= 100_000, "production statement exceeds checked SQL bound");
        const native = binding.prepare(sql);
        const wrapper: D1StatementLike = {
          bind(...parameters) {
            bounds.maximum_bindings = Math.max(bounds.maximum_bindings, parameters.length);
            assert(parameters.length <= 100, "production statement exceeds checked binding bound");
            const bound = native.bind(...parameters);
            original.set(bound, bound);
            metadata.set(bound, { sql, parameters: [...parameters] });
            return bound;
          },
          first: (column) => native.first(column),
          all: () => native.all(),
          run: () => native.run(),
        };
        original.set(wrapper, native);
        metadata.set(wrapper, { sql, parameters: [] });
        return wrapper;
      },
      async batch(statements) {
        assert.equal(witness.prepared_bound, false, "one command must have one consumption batch");
        bounds.maximum_batch_statements = Math.max(
          bounds.maximum_batch_statements,
          statements.length,
        );
        const consume = statements.filter((statement) =>
          /UPDATE\s+passkey_step_up_proofs\s+SET\s+consumed_at\s*=/iu.test(
            metadata.get(statement)?.sql ?? "",
          ),
        );
        assert.equal(
          consume.length,
          1,
          "actual operations consumption UPDATE must reach native batch",
        );
        const parameters = metadata.get(consume[0]!)!.parameters;
        assert.equal(parameters.length, 3);
        assert.equal(parameters[1], proof.id);
        assert.equal(typeof parameters[0], "string");
        assert.equal(typeof parameters[2], "string");
        consumptionStamp = parameters[0] as string;
        observedAt = parameters[2] as string;
        assert.equal(consumptionStamp.length, 26);
        assert(isUlid(consumptionStamp));
        assert(Number.isNaN(Date.parse(consumptionStamp)));
        assert(Date.parse(observedAt) >= Date.parse(proof.createdAt));
        assert(Date.parse(observedAt) < Date.parse(proof.expiresAt));
        assert(statements.every((statement) => original.has(statement)));
        witness.prepared_bound = true;
        await foreignKeys();
        beforeBatch = await snapshot();
        const arrival = await clock(proof.id);
        assert.equal(arrival.expires_at, proof.expiresAt);
        assert.equal(arrival.consumed_at, null);
        assert.equal(arrival.live, 1, "early expiry is not a natural batch-expiry proof");
        const remaining = Date.parse(arrival.expires_at) - Date.parse(arrival.database_now);
        assert(remaining >= 500, "proof must still have a witnessed live arrival margin");
        if (mode === "live") assert(remaining > preBatchDelayMs + 1_000);
        else assert(remaining < preBatchDelayMs);
        witness.live_at_seam = true;
        await delay(preBatchDelayMs);
        assert.deepEqual(await snapshot(), beforeBatch);
        await foreignKeys();
        witness.unchanged_during_delay = true;
        const execution = await clock(proof.id);
        assert.equal(execution.expires_at, proof.expiresAt);
        assert.equal(execution.consumed_at, null);
        assert.equal(execution.live, mode === "expired" ? 0 : 1);
        witness.expected_clock_boundary = true;
        witness.original_statements_forwarded = true;
        let result;
        try {
          // Do not reprepare, rebind or replace any statement at this seam.
          result = await binding.batch(statements.map((statement) => original.get(statement)!));
        } catch (error) {
          witness.batch_rolled_back =
            JSON.stringify(await snapshot()) === JSON.stringify(beforeBatch);
          await foreignKeys();
          throw error;
        }
        if (mode === "live") {
          const consumed = await clock(proof.id);
          assert.equal(consumed.consumed_at, consumptionStamp);
          assert.equal(consumed.expires_at, proof.expiresAt);
          assert.equal(consumed.live, 1, "live control must commit before expiry");
          committed = await snapshot();
          await foreignKeys();
          witness.committed_before_return_delay = true;
          const expired = await waitForExpiry(proof.id);
          assert.equal(expired.expires_at, proof.expiresAt);
          assert.equal(expired.consumed_at, consumptionStamp);
          witness.return_after_expiry = true;
          assert.deepEqual(await snapshot(), committed);
          await foreignKeys();
          witness.committed_history_unchanged = true;
        }
        return result;
      },
    };
    return {
      db: adaptD1(measured),
      observedAt: () => observedAt,
      stamp: () => consumptionStamp,
      beforeBatch: () => beforeBatch,
      committed: () => committed,
    };
  }

  async function wave(family: Family, mode: Mode) {
    let phase = "fixture";
    let hubOutcome: string | null = null;
    let proofConsumed: boolean | null = null;
    const witness: Witness = {
      prepared_bound: false,
      live_at_seam: false,
      unchanged_during_delay: false,
      expected_clock_boundary: false,
      original_statements_forwarded: false,
      batch_rolled_back: false,
      committed_before_return_delay: false,
      return_after_expiry: false,
      committed_history_unchanged: false,
      original_occurrence_times: false,
    };
    try {
      const ids = family === "retention_set" ? [] : await abandonedTargets();
      if (family === "target_ledger_retry") {
        const originalProof = await issue(
          "ops.recover",
          `ops-recover:resolve_stuck_upload:${FIX.workspace}`,
          5 * 60_000,
        );
        const first = success(
          await new WorkspaceHub(db).execute(resolveStuckUploadCommand, {
            workspaceId: FIX.workspace,
            actorHumanId: principal.humanId,
            authorizationEpoch: principal.authorizationEpoch,
            idempotencyKey: randomUlid(),
            now: originalProof.createdAt,
            input: { versionIds: ids, stepUpProofId: originalProof.id },
          }),
        );
        assert.equal(first.replayed, false);
        assert.deepEqual(first.detail, { resolved: ids.length });
        assert.notEqual((await clock(originalProof.id)).consumed_at, null);
      }
      const proof = await issue(
        family === "retention_set" ? "ops.retention" : "ops.recover",
        family === "retention_set"
          ? `ops-retention:${FIX.workspace}`
          : `ops-recover:resolve_stuck_upload:${FIX.workspace}`,
        proofLifetimeMs[mode],
      );
      await foreignKeys();
      const before = await snapshot();
      const probe = measuredBinding(proof, mode, witness);
      const hub = new WorkspaceHub(probe.db);
      const request = {
        workspaceId: FIX.workspace,
        actorHumanId: principal.humanId,
        authorizationEpoch: principal.authorizationEpoch,
        idempotencyKey: randomUlid(),
        now: proof.createdAt,
      };
      phase = "actual_prepared_bound_consume_batch";
      async function execute<I, R>(command: HubCommand<I, R>, input: I) {
        return hub.execute(command, { ...request, input });
      }
      const outcome =
        family === "retention_set"
          ? await execute(setRetentionPolicyCommand, {
              rawLogRetentionDays: 7,
              stepUpProofId: proof.id,
            })
          : await execute(resolveStuckUploadCommand, { versionIds: ids, stepUpProofId: proof.id });
      hubOutcome = outcome.ok ? "success" : outcome.error.code;
      proofConsumed = (await clock(proof.id)).consumed_at !== null;
      assert(witness.prepared_bound && witness.live_at_seam && witness.unchanged_during_delay);
      assert(witness.expected_clock_boundary && witness.original_statements_forwarded);
      assert.deepEqual(probe.beforeBatch(), before);
      if (mode === "expired") {
        phase = "expect_natural_expiry_rollback";
        assert.deepEqual(outcome, {
          ok: false,
          error: { code: "command_failed", message: "command failed" },
        });
        assert(witness.batch_rolled_back);
        assert.deepEqual(await snapshot(), before);
        assert.equal((await clock(proof.id)).consumed_at, null);
      } else {
        phase = "expect_live_committed_return_after_expiry";
        assert(outcome.ok, "timed live command must succeed");
        const result = outcome.result;
        assert(
          witness.committed_before_return_delay &&
            witness.return_after_expiry &&
            witness.committed_history_unchanged,
        );
        const after = await snapshot();
        assert.deepEqual(after, probe.committed());
        assert.equal((await clock(proof.id)).consumed_at, probe.stamp());
        assert.equal((await clock(proof.id)).live, 0);
        const expected: Snapshot = Object.fromEntries(
          Object.entries(before).map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]),
        );
        function addedRows(table: string, identity: string, count: number) {
          const previousIds = new Set(before[table]!.map((row) => row[identity]));
          const added = after[table]!.filter((row) => !previousIds.has(row[identity]));
          assert.equal(added.length, count);
          return added;
        }
        function opaqueId(row: Record<string, unknown>, identity: string) {
          const id = row[identity];
          assert(typeof id === "string");
          assert.equal(id.length, 26);
          assert(isUlid(id));
          return id;
        }
        function appendReceipt(table: string, identity: string, fields: Record<string, unknown>) {
          const [added] = addedRows(table, identity, 1);
          expected[table]!.push({ [identity]: opaqueId(added!, identity), ...fields });
        }
        expected.passkey_step_up_proofs = before.passkey_step_up_proofs!.map((row) =>
          row.proof_id === proof.id ? { ...row, consumed_at: probe.stamp() } : { ...row },
        );
        const previousCursor = before.workspace_cursors!.find(
          (row) => row.workspace_id === FIX.workspace,
        );
        assert(previousCursor, "production setup must already have reserved a workspace cursor");
        assert(typeof previousCursor.cursor === "number");
        assert(Number.isSafeInteger(previousCursor.cursor));
        const nextCursor = previousCursor.cursor + 1;
        assert(Number.isSafeInteger(nextCursor));
        assert.equal(outcome.cursor, nextCursor);
        assert.equal(outcome.replayed, false);
        expected.workspace_cursors = before.workspace_cursors!.map((row) =>
          row.workspace_id === FIX.workspace ? { ...row, cursor: nextCursor } : { ...row },
        );
        const commandName =
          family === "retention_set"
            ? setRetentionPolicyCommand.name
            : resolveStuckUploadCommand.name;
        let expectedResult: Record<string, unknown>;
        let auditResult: Record<string, unknown>;
        if (family === "retention_set") {
          const prior = before.retention_policies!.find(
            (row) => row.workspace_id === FIX.workspace,
          );
          const policy = {
            workspace_id: FIX.workspace,
            raw_log_retention_days: 7,
            version: Number(prior?.version ?? 0) + 1,
            updated_by_human_id: principal.humanId,
            updated_at: probe.observedAt(),
          };
          expected.retention_policies = prior
            ? before.retention_policies!.map((row) =>
                row.workspace_id === FIX.workspace ? policy : { ...row },
              )
            : [...expected.retention_policies!, policy];
          expectedResult = policy;
          auditResult = policy;
        } else {
          const actionId = recoveryActionId("resolve_stuck_upload", { version_ids: ids });
          expectedResult = {
            action_id: actionId,
            kind: "resolve_stuck_upload",
            replayed: family === "target_ledger_retry",
            detail: { resolved: ids.length },
          };
          auditResult = {
            action_id: actionId,
            kind: "resolve_stuck_upload",
            replayed: family === "target_ledger_retry",
            resolved: ids.length,
          };
          const selectedVersions = before.artifact_versions!.filter(
            (row) => row.workspace_id === FIX.workspace && ids.some((id) => row.id === id),
          );
          assert.equal(selectedVersions.length, ids.length);
          assert(
            selectedVersions.every(
              (row) => row.state === (family === "fresh_upload_recovery" ? "uploading" : "failed"),
            ),
          );
          const priorLedger = before.ops_recovery_ledger!.find(
            (row) => row.workspace_id === FIX.workspace && row.action_id === actionId,
          );
          if (family === "fresh_upload_recovery") {
            assert.equal(priorLedger, undefined);
            expected.artifact_versions = before.artifact_versions!.map((row) =>
              row.workspace_id === FIX.workspace && ids.some((id) => row.id === id)
                ? { ...row, state: "failed" }
                : { ...row },
            );
            expected.ops_recovery_ledger!.push({
              workspace_id: FIX.workspace,
              action_id: actionId,
              kind: "resolve_stuck_upload",
              target_json: JSON.stringify({ version_ids: ids }),
              state: "applied",
              attempt_count: 1,
              result_json: JSON.stringify({ resolved: ids.length }),
              created_by_human_id: principal.humanId,
              created_at: probe.observedAt(),
              updated_at: probe.observedAt(),
            });
            const abandoned = addedRows("artifact_audit_outbox", "id", ids.length);
            for (const [index, versionId] of ids.entries()) {
              expected.artifact_audit_outbox!.push({
                workspace_id: FIX.workspace,
                id: opaqueId(abandoned[index]!, "id"),
                version_id: versionId,
                grant_id: null,
                action: "artifact.abandoned",
                payload_json: JSON.stringify({ version_id: versionId }),
                created_at: probe.observedAt(),
                dispatched_at: null,
              });
            }
          } else {
            assert(priorLedger, "target-ledger retry must retain its original recovery row");
            assert.equal(priorLedger.kind, "resolve_stuck_upload");
            assert.equal(priorLedger.target_json, JSON.stringify({ version_ids: ids }));
            assert.equal(priorLedger.state, "applied");
            assert.equal(priorLedger.attempt_count, 1);
            assert.equal(priorLedger.result_json, JSON.stringify({ resolved: ids.length }));
            assert.equal(priorLedger.created_by_human_id, principal.humanId);
            // The cloned expectation preserves every original ledger, version,
            // artifact receipt and first-proof field during this fresh-proof retry.
          }
        }
        assert.deepEqual(result, expectedResult);
        const payload = JSON.stringify({
          actor: {
            humanId: principal.humanId,
            authorizationEpoch: principal.authorizationEpoch,
          },
          input: family === "retention_set" ? { raw_log_retention_days: 7 } : { version_ids: ids },
          result: auditResult,
        });
        appendReceipt("audit_events", "audit_id", {
          workspace_id: FIX.workspace,
          actor_principal_id: principal.humanId,
          action: commandName,
          payload_json: payload,
          created_at: probe.observedAt(),
        });
        appendReceipt("semantic_events", "event_id", {
          workspace_id: FIX.workspace,
          workspace_cursor: nextCursor,
          kind: commandName,
          payload_json: payload,
          created_at: probe.observedAt(),
        });
        appendReceipt("outbox_records", "outbox_id", {
          workspace_id: FIX.workspace,
          kind: commandName,
          payload_json: payload,
          created_at: probe.observedAt(),
          delivered_at: null,
        });
        const [stored] = addedRows("idempotency_records", "idempotency_key", 1);
        assert.equal(stored!.idempotency_key, request.idempotencyKey);
        expected.idempotency_records!.push({
          workspace_id: FIX.workspace,
          idempotency_key: request.idempotencyKey,
          command_name: commandName,
          result_json: JSON.stringify({
            result: expectedResult,
            cursor: nextCursor,
            authorizationEpoch: principal.authorizationEpoch,
            actorHumanId: principal.humanId,
          }),
          created_at: probe.observedAt(),
        });
        assert.deepEqual(after, expected);
        witness.original_occurrence_times = true;
      }
      await foreignKeys();
      assert.deepEqual(await db.prepare("SELECT id FROM artifact_mutation_guards").all(), []);
      assert.deepEqual(await db.prepare("SELECT id FROM runner_mutation_guards").all(), []);
      groups.push({
        check: family,
        mode,
        outcome: "passed",
        hub_outcome: hubOutcome,
        proof_consumed: proofConsumed,
        witness,
      });
    } catch (error) {
      groups.push({
        check: family,
        mode,
        outcome: "failed",
        hub_outcome: hubOutcome,
        proof_consumed: proofConsumed,
        witness,
      });
      failures.push({
        check: family,
        mode,
        phase,
        error_name: error instanceof Error ? error.name : "unknown_error",
      });
    }
  }

  for (const family of ["retention_set", "fresh_upload_recovery", "target_ledger_retry"] as const) {
    for (const mode of ["live", "expired"] as const) await wave(family, mode);
  }
  console.log(
    JSON.stringify({
      checks: groups.map((group) => ({ ...group, check: `${group.check}_${group.mode}` })),
      failures,
      bounds,
      pre_batch_delay_ms: preBatchDelayMs,
      canonical_table_count: tables.length,
      http_budget_tables: tables
        .filter(({ name }) => name === "rate_limit_buckets")
        .map(({ name }) => name),
      excluded_snapshot_tables: allTables
        .filter(({ name }) => engineTables.has(name))
        .map(({ name }) => name),
      measured_scope:
        "timed production domain Hub statements; excludes migrations, setup and snapshots",
      schema_migrations: manifest.migrations.length,
      limitations: [
        "disposable native D1/domain Hub proof, not mounted auth or live infrastructure",
        "operations-local consume UPDATE only, not later-statement deadlines or private activation",
        "no R2 deletion, bytes, runner, provider or lease behavior",
      ],
    }),
  );
  assert.equal(
    failures.length,
    0,
    "operations step-up expiry proof failed; inspect bounded wave classifications",
  );
  assert.equal(groups.length, 6);
  console.log("C11_OPERATIONS_STEP_UP_EXPIRY_D1_OK");
} finally {
  await server.close();
}
