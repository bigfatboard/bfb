// ABOUTME: Proves historical attention lineage in complete measurement projections against disposable native D1.
// ABOUTME: Synthetic ended assignments and malformed retained requests preserve source rows without provider or runner activity.

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import { adaptD1, loadMigrationManifest, type D1Like, type D1StatementLike } from "@bfb/db";
import {
  FIX,
  aggregateMeasurements,
  getRunMeasurements,
  getTaskMeasurements,
  loadPrincipal,
  randomUlid,
  seedSyntheticWorkspace,
  type CommandOutcome,
  type CreateRunResult,
  type TaskRecord,
} from "@bfb/domain";
import { createTestHarness } from "wrangler";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const origin = "https://bfb.measurement-attention.test";
const server = createTestHarness({
  root,
  workers: [
    { configPath: "tools/work-records/wrangler-a.toml" },
    { configPath: "tools/work-records/wrangler-b.toml" },
    { configPath: "tools/work-records/wrangler-hub.toml" },
  ],
});
const bounds = { maximum_bindings: 0, maximum_statement_bytes: 0 };
const checks: Array<{ check: string; outcome: "passed" | "failed" }> = [];
const failures: Array<{ check: string; phase: string; error_name: string }> = [];
const witnesses: Array<{ check: string; dimensions: Record<string, boolean> }> = [];

interface HistoricalWork {
  taskId: string;
  projectId: string;
  runId: string;
  executionId: string;
}

async function check(name: string, run: (phase: (value: string) => void) => Promise<void>) {
  let phase = "fixture";
  try {
    await run((value) => {
      phase = value;
    });
    checks.push({ check: name, outcome: "passed" });
  } catch (error) {
    checks.push({ check: name, outcome: "failed" });
    // Assertion messages can contain source rows. Retain only bounded classification.
    failures.push({
      check: name,
      phase,
      error_name: error instanceof Error ? error.name : "unknown_error",
    });
  }
  console.log(JSON.stringify(checks.at(-1)));
}

/** Binding returns the real native statement; reads and batches keep the D1 adapter semantics. */
function checkedBinding(binding: D1Like): D1Like {
  return {
    prepare(sql) {
      const bytes = Buffer.byteLength(sql);
      bounds.maximum_statement_bytes = Math.max(bounds.maximum_statement_bytes, bytes);
      assert(bytes <= 100_000, "measurement SQL exceeds the checked D1 statement bound");
      const native = binding.prepare(sql);
      const statement: D1StatementLike = {
        bind(...parameters) {
          bounds.maximum_bindings = Math.max(bounds.maximum_bindings, parameters.length);
          assert(parameters.length <= 100, "measurement SQL exceeds the checked D1 binding bound");
          return native.bind(...parameters);
        },
        first: (column) => native.first(column),
        all: () => native.all(),
        run: () => native.run(),
      };
      return statement;
    },
    batch: (statements) => binding.batch(statements),
  };
}

try {
  await server.listen();
  const worker = server.getWorker("bfb-work-records-hub");
  await worker.applyD1Migrations("DB");
  const binding = ((await worker.getEnv()) as unknown as { DB: D1Like }).DB;
  const db = adaptD1(binding),
    measuredDb = adaptD1(checkedBinding(binding));
  const manifest = loadMigrationManifest(resolve(root, "migrations/d1"));
  // The existing proxy resolves the global test Hub. No second jurisdictional object is used.
  await seedSyntheticWorkspace(db, new Date().toISOString(), "global");
  const viewer = await loadPrincipal(db, FIX.workspace, FIX.member);
  const tables = (await db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table'
       AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'
       AND name NOT IN ('d1_migrations','rate_limit_buckets') ORDER BY name`,
    )
    .all()) as Array<{ name: string }>;
  for (const { name } of tables) assert(/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(name));

  async function snapshot() {
    const rows: Record<string, unknown[]> = {};
    for (const { name } of tables)
      rows[name] = await db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all();
    return rows;
  }
  async function validForeignKeys() {
    assert.deepEqual(await db.prepare("PRAGMA foreign_key_check").all(), []);
  }
  async function command<T>(name: string, input: unknown) {
    const principal = await loadPrincipal(db, FIX.workspace, FIX.owner);
    const response = await server
      .getWorker("bfb-work-records-a")
      .fetch(`${origin}/workspaces/${FIX.workspace}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandName: name,
          request: {
            workspaceId: FIX.workspace,
            actorHumanId: FIX.owner,
            authorizationEpoch: principal.authorizationEpoch,
            idempotencyKey: randomUlid(),
            now: new Date().toISOString(),
            input,
          },
        }),
      });
    assert.equal(response.status, 200);
    const outcome = (await response.json()) as CommandOutcome<T>;
    assert(outcome.ok, "synthetic task/run setup must use a successful production command");
    return outcome.result;
  }

  async function fixture() {
    async function work(label: string) {
      const task = await command<TaskRecord>("task.create", {
        projectId: FIX.projectA,
        title: `Synthetic measurement attention ${label}`,
        priority: "P2",
      });
      const created = await command<CreateRunResult>("run.create", {
        taskId: task.id,
        expectedTaskVersion: task.resource_version,
        agentProfileId: FIX.profileCodex,
        workspacePolicyVersion: 1,
        projectPolicyVersion: 1,
        repositoryConfigVersion: 1,
        agentProfileVersion: 1,
      });
      return { task, run: created.run };
    }
    const shared = await work("shared history"),
      privateWork = await work("private history");
    const createdRows = await db
      .prepare("SELECT id,created_at FROM runs WHERE workspace_id=? AND id IN (?,?)")
      .all(FIX.workspace, shared.run.id, privateWork.run.id);
    assert.equal(createdRows.length, 2);
    const createdTimes = new Map<string, string>();
    for (const row of createdRows) {
      assert(typeof row === "object" && row !== null && "id" in row && "created_at" in row);
      assert(typeof row.id === "string" && typeof row.created_at === "string");
      createdTimes.set(row.id, row.created_at);
    }
    const sharedCreatedAt = createdTimes.get(shared.run.id),
      privateCreatedAt = createdTimes.get(privateWork.run.id);
    assert(typeof sharedCreatedAt === "string" && typeof privateCreatedAt === "string");
    // This is a synthetic read-time timeline, not a live process clock or provider observation.
    const base = Math.max(Date.parse(sharedCreatedAt), Date.parse(privateCreatedAt));
    assert(Number.isFinite(base));
    const at = (seconds: number) => new Date(base + seconds * 1000).toISOString();
    const now = at(600),
      runnerId = randomUlid(),
      keyThumbprint = `synthetic-measurement-history-${runnerId}`;
    await db
      .prepare(
        `INSERT INTO runners
         (workspace_id,id,owner_human_id,device_label,public_key_json,key_thumbprint,
          authorization_epoch,grant_epoch,token_epoch,enrolled_at,revoked_at)
         VALUES (?,?,?,'Synthetic dormant historical Mac','{}',?,1,1,1,?,?)`,
      )
      .run(FIX.workspace, runnerId, FIX.owner, keyThumbprint, at(0), at(240));
    const sponsor = await loadPrincipal(db, FIX.workspace, FIX.owner);
    async function ended(source: typeof shared): Promise<HistoricalWork> {
      const executionId = randomUlid();
      // Fixture-only ended execution/immutable assignment: no launch, grant, lease or process.
      await db
        .prepare(
          `INSERT INTO run_executions
           (workspace_id,id,run_id,state,end_reason,resource_version,created_at,ended_at)
           VALUES (?,?,?,'ended','process_exit',1,?,?)`,
        )
        .run(FIX.workspace, executionId, source.run.id, at(0), at(240));
      await db
        .prepare(
          `INSERT INTO execution_assignments
           (workspace_id,execution_id,assignment_generation,run_id,task_id,project_id,
            runner_id,checkout_id,physical_worktree_hash,requesting_human_id,
            requesting_human_epoch,runner_authorization_epoch,runner_grant_epoch,
            runner_key_thumbprint,created_at)
           VALUES (?,?,1,?,?,?,?,?,?,?,?,1,1,?,?)`,
        )
        .run(
          FIX.workspace,
          executionId,
          source.run.id,
          source.task.id,
          source.task.project_id,
          runnerId,
          randomUlid(),
          `sha256:${"c".repeat(64)}`,
          FIX.owner,
          sponsor.authorizationEpoch,
          keyThumbprint,
          at(0),
        );
      return {
        taskId: source.task.id,
        projectId: source.task.project_id,
        runId: source.run.id,
        executionId,
      };
    }
    const readable = await ended(shared),
      hidden = await ended(privateWork);
    await db
      .prepare(
        "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
      )
      .run(FIX.workspace, hidden.taskId, FIX.owner, at(0));

    async function attention(
      declared: Pick<HistoricalWork, "projectId" | "taskId" | "runId">,
      retained: HistoricalWork,
      resolved: boolean,
    ) {
      const id = randomUlid(),
        requestedAt = at(resolved ? 60 : 180),
        answeredAt = resolved ? at(90) : null,
        resolvedAt = resolved ? at(120) : null;
      // The attention FK proves only execution/generation existence, not its declared parent tuple.
      await db
        .prepare(
          `INSERT INTO attention_requests
           (workspace_id,id,project_id,task_id,run_id,run_execution_id,assignment_generation,
            kind,required_role,question,blocking,state,answer,answered_by_human_id,
            requested_at,first_response_at,answered_at,resolved_at,resource_version)
           VALUES (?,?,?,?,?,?,1,?,'reviewer',?,1,?,?,?,?,?,?,?,?)`,
        )
        .run(
          FIX.workspace,
          id,
          declared.projectId,
          declared.taskId,
          declared.runId,
          retained.executionId,
          resolved ? "clarification" : "blocker",
          resolved
            ? "Synthetic canonical shared historical question"
            : "SYNTHETIC-PRIVATE-HISTORICAL-ATTENTION-QUESTION",
          resolved ? "resolved" : "open",
          resolved ? "Synthetic canonical historical answer" : null,
          resolved ? FIX.owner : null,
          requestedAt,
          answeredAt,
          answeredAt,
          resolvedAt,
          resolved ? 3 : 1,
        );
      const observations = [
        { kind: "requested", at: requestedAt },
        ...(answeredAt ? [{ kind: "answered", at: answeredAt }] : []),
        ...(resolvedAt ? [{ kind: "resolved", at: resolvedAt }] : []),
      ];
      for (const observation of observations)
        await db
          .prepare(
            `INSERT INTO attention_observations
             (workspace_id,observation_id,attention_id,observed_kind,actor_type,actor_id,occurred_at)
             VALUES (?,?,?,?,'human',?,?)`,
          )
          .run(FIX.workspace, randomUlid(), id, observation.kind, FIX.owner, observation.at);
      return id;
    }
    const canonicalId = await attention(readable, readable, true);
    await attention(hidden, hidden, false);
    await validForeignKeys();
    const beforeDenial = await snapshot();
    await assert.rejects(getRunMeasurements(measuredDb, FIX.workspace, hidden.runId, now, viewer), {
      code: "not_found",
      message: "run not found",
    });
    assert.deepEqual(await snapshot(), beforeDenial);
    const projections = async () => ({
      run: await getRunMeasurements(measuredDb, FIX.workspace, readable.runId, now, viewer),
      task: await getTaskMeasurements(measuredDb, FIX.workspace, readable.taskId, now, viewer),
      aggregate: await aggregateMeasurements(
        measuredDb,
        FIX.workspace,
        { projectId: readable.projectId },
        now,
        viewer,
      ),
    });
    async function readUnchanged() {
      await validForeignKeys();
      const before = await snapshot(),
        result = await projections();
      assert.deepEqual(await snapshot(), before);
      await validForeignKeys();
      return result;
    }
    return { readable, hidden, attention, canonicalId, readUnchanged };
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>;
  type Projections = Awaited<ReturnType<Fixture["readUnchanged"]>>;

  function assertCanonical(f: Fixture, value: Projections) {
    assert.deepEqual(value.run.attention, [
      {
        request_id: f.canonicalId,
        kind: "clarification",
        blocking: true,
        state: "resolved",
        first_response_ms: 30_000,
        resolution_ms: 60_000,
        open: false,
      },
    ]);
    assert.equal(value.run.provenance.attention_observations, 3);
    assert.equal(value.run.times.attention_wait_ms, 30_000);
    assert.equal(value.run.times.attention_open, false);
    assert.equal(value.run.times.live_execution, false);
    assert.equal(value.run.sources, null);
    assert.deepEqual(value.task.attention, value.run.attention);
    assert.deepEqual(value.task.interventions.attention_by_kind, {
      clarification: { open: 0, answered: 0, resolved: 1 },
    });
    assert(value.aggregate.cells.some((cell) => cell.attention_requests >= 1));
    assert.equal(value.aggregate.truncated, false);
  }

  await check(
    "canonical_ended_history_remains_measurable_and_reads_preserve_all_tables",
    async (phase) => {
      const f = await fixture();
      phase("canonical_projection");
      const baseline = await f.readUnchanged();
      assertCanonical(f, baseline);
      assert.equal(baseline.aggregate.cells.length, 1);
      assert.equal(baseline.aggregate.cells[0]?.attention_requests, 1);
      assert.equal(baseline.aggregate.cells[0]?.attention_wait_ms, 30_000);
      assert.deepEqual(await f.readUnchanged(), baseline);
    },
  );

  const variants = [
    {
      name: "private_declared_tuple_cannot_borrow_a_readable_run",
      declared: (f: Fixture) => ({ ...f.hidden, runId: f.readable.runId }),
    },
    {
      name: "private_run_cannot_borrow_a_readable_task",
      declared: (f: Fixture) => ({ ...f.readable, runId: f.hidden.runId }),
    },
    {
      name: "coherent_readable_declared_tuple_cannot_borrow_a_private_assignment",
      declared: (f: Fixture) => f.readable,
    },
  ];
  for (const variant of variants)
    await check(variant.name, async (phase) => {
      const f = await fixture();
      phase("canonical_baseline");
      const baseline = await f.readUnchanged();
      assertCanonical(f, baseline);
      phase("malformed_fixture");
      await f.attention(variant.declared(f), f.hidden, false);
      await validForeignKeys();
      phase("malformed_projection");
      const actual = await f.readUnchanged();
      witnesses.push({
        check: variant.name,
        dimensions: {
          run_body_equal: isDeepStrictEqual(actual.run.attention, baseline.run.attention),
          task_body_equal: isDeepStrictEqual(actual.task.attention, baseline.task.attention),
          observation_count_equal:
            actual.run.provenance.attention_observations ===
            baseline.run.provenance.attention_observations,
          waits_equal:
            actual.run.times.attention_wait_ms === baseline.run.times.attention_wait_ms &&
            actual.run.times.attention_open === baseline.run.times.attention_open &&
            actual.task.totals.attention_wait_ms === baseline.task.totals.attention_wait_ms &&
            isDeepStrictEqual(
              actual.aggregate.cells.map((cell) => cell.attention_wait_ms),
              baseline.aggregate.cells.map((cell) => cell.attention_wait_ms),
            ),
          task_by_kind_equal: isDeepStrictEqual(
            actual.task.interventions.attention_by_kind,
            baseline.task.interventions.attention_by_kind,
          ),
          aggregate_counts_equal: isDeepStrictEqual(
            actual.aggregate.cells.map((cell) => cell.attention_requests),
            baseline.aggregate.cells.map((cell) => cell.attention_requests),
          ),
          complete_projections_equal: isDeepStrictEqual(actual, baseline),
        },
      });
      assert.deepEqual(actual, baseline);
      assertCanonical(f, actual);
    });

  console.log(
    JSON.stringify({
      schema_version: 1,
      migration_head: manifest.migrations.at(-1)?.id ?? "unknown",
      checks,
      failures,
      witnesses,
      bounds,
      outcome: failures.length === 0 ? "passed" : "failed",
      limits: [
        "Four groups prove synthetic retained attention lineage against disposable D1; source rows remain unchanged",
        "Historical execution and observation timelines are fixture-only; no provider, runner, lease, ingestion or live arithmetic certificate",
        "Direct domain measurement reads, not mounted transport authentication or private creation/sharing activation",
      ],
    }),
  );
  if (failures.length === 0) console.log("C11_MEASUREMENT_ATTENTION_D1_OK");
  else process.exitCode = 1;
} finally {
  await server.close();
}
