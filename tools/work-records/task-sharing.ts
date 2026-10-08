// ABOUTME: Proves creator-sharing lifecycle and atomic authority rollback on disposable native D1.
// ABOUTME: Registered Hub commands retain immutable synthetic policies, minimal receipts and complete canonical witnesses.

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adaptD1, loadMigrationManifest, type D1Like, type D1StatementLike } from "@bfb/db";
import {
  FIX,
  WorkspaceHub,
  assertTaskAccess,
  bumpMemberEpoch,
  loadPrincipal,
  randomUlid,
  readTaskSharing,
  resolveCommand,
  seedSyntheticWorkspace,
  type CommandOutcome,
  type CommandRequest,
  type GrantTaskSharingInput,
  type HubCommand,
  type TaskRecord,
  type TaskSharingReceipt,
} from "@bfb/domain";
import { createTestHarness } from "wrangler";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const origin = "https://bfb.task-sharing.test";
const server = createTestHarness({
  root,
  workers: [
    { configPath: "tools/work-records/wrangler-a.toml" },
    { configPath: "tools/work-records/wrangler-b.toml" },
    { configPath: "tools/work-records/wrangler-hub.toml" },
  ],
});
type Row = Record<string, unknown>;
type Snapshot = Record<string, Row[]>;
const checks: Array<{
  check: string;
  outcome: "passed" | "failed";
  witness: Record<string, boolean>;
}> = [];
const failures: Array<{ check: string; phase: string; error_name: string }> = [];
const bounds = { maximum_bindings: 0, maximum_statement_bytes: 0, maximum_batch_statements: 0 };

function success<T>(value: CommandOutcome<T>): T {
  assert(value.ok, "registered sharing command must succeed");
  return value.result;
}
function registered<TInput, TResult>(name: string): HubCommand<TInput, TResult> {
  const command = resolveCommand(name);
  assert(command, "sharing command must be registered");
  return command as HubCommand<TInput, TResult>;
}
async function execute<T>(name: string, request: CommandRequest<unknown>, client = "a") {
  const response = await server
    .getWorker(`bfb-work-records-${client}`)
    .fetch(`${origin}/workspaces/${FIX.workspace}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandName: name, request }),
    });
  assert.equal(response.status, 200, "native Worker must deliver the actual Hub envelope");
  return (await response.json()) as CommandOutcome<T>;
}

try {
  await server.listen();
  const worker = server.getWorker("bfb-work-records-hub");
  await worker.applyD1Migrations("DB");
  const binding = ((await worker.getEnv()) as unknown as { DB: D1Like }).DB;
  const db = adaptD1(binding),
    independent = adaptD1(binding);
  const manifest = loadMigrationManifest(resolve(root, "migrations/d1"));
  await seedSyntheticWorkspace(db, new Date().toISOString(), "global");
  await db
    .prepare("UPDATE projects SET access_mode='restricted' WHERE workspace_id=? AND id=?")
    .run(FIX.workspace, FIX.projectA);
  const engine = new Set(["sqlite_sequence", "d1_migrations", "_cf_METADATA", "_cf_KV"]);
  const tables = (await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()) as Array<{ name: string }>;
  for (const { name } of tables) {
    assert(/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name));
    assert(
      engine.has(name) || (!name.startsWith("sqlite_") && !name.startsWith("_cf_")),
      "unexpected native snapshot engine table",
    );
  }
  async function snapshot(): Promise<Snapshot> {
    const result: Snapshot = {};
    for (const { name } of tables) {
      if (engine.has(name) || name === "rate_limit_buckets") continue;
      result[name] = (await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()) as Row[];
    }
    return result;
  }
  async function budgets() {
    return db.prepare("SELECT * FROM rate_limit_buckets ORDER BY rowid").all();
  }
  async function integrity() {
    assert.deepEqual(await db.prepare("PRAGMA foreign_key_check").all(), []);
    for (const [name, rows] of Object.entries(await snapshot()))
      if (name.endsWith("_guards")) assert.deepEqual(rows, [], "transient guards must be empty");
  }
  async function unchanged(before: Snapshot, http: unknown[]) {
    assert.deepEqual(
      await snapshot(),
      before,
      "all canonical rows must equal the after-cut baseline",
    );
    assert.deepEqual(await budgets(), http, "native operations must not affect HTTP abuse budgets");
    await integrity();
  }
  async function fixture() {
    const creator = await loadPrincipal(db, FIX.workspace, FIX.member);
    const request = <T>(input: T, key = randomUlid()): CommandRequest<T> => ({
      workspaceId: FIX.workspace,
      actorHumanId: FIX.member,
      authorizationEpoch: creator.authorizationEpoch,
      idempotencyKey: key,
      input,
    });
    const task = success(
      await execute<TaskRecord>(
        "task.create",
        request({
          projectId: FIX.projectA,
          title: "SYNTHETIC dormant native sharing task",
          priority: "P2",
        }),
      ),
    );
    // Fixture-only dormant policy: no private creation command, inheritance or activation.
    await db
      .prepare(
        `INSERT INTO task_privacy
      (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)`,
      )
      .run(FIX.workspace, task.id, FIX.member, new Date().toISOString());
    await integrity();
    const input = (
      version = 1,
      human = FIX.reviewer,
      permission: "read" | "contribute" | "edit" = "read",
    ): GrantTaskSharingInput => ({
      taskId: task.id,
      humanId: human,
      permission,
      expectedAccessVersion: version,
    });
    return { creator, task, request, input };
  }
  function preparedBatch(change: () => Promise<void>) {
    const originals = new Map<D1StatementLike, { sql: string; parameters: unknown[] }>();
    let fired = false,
      after: Snapshot | undefined,
      afterBudgets: unknown[] | undefined;
    let forwarded = false,
      guardPrepared = false;
    const database = adaptD1({
      prepare(sql) {
        const native = binding.prepare(sql);
        bounds.maximum_statement_bytes = Math.max(
          bounds.maximum_statement_bytes,
          Buffer.byteLength(sql),
        );
        assert(
          Buffer.byteLength(sql) <= 100_000,
          "native sharing statements must fit the SQL bound",
        );
        const remember = (statement: D1StatementLike, parameters: unknown[]) => {
          originals.set(statement, { sql, parameters: [...parameters] });
          bounds.maximum_bindings = Math.max(bounds.maximum_bindings, parameters.length);
          assert(parameters.length <= 100, "native sharing statements must fit the binding bound");
          return statement;
        };
        remember(native, []);
        // bind() returns the ORIGINAL native object required by workerd's batch(), with exact parameters.
        return {
          bind: (...parameters) => remember(native.bind(...parameters), parameters),
          first: (column) => native.first(column),
          all: () => native.all(),
          run: () => native.run(),
        };
      },
      async batch(statements) {
        assert.equal(fired, false, "one command must reach one actual prepared batch");
        fired = true;
        const retained = statements.map((statement) => originals.get(statement));
        assert(
          retained.every((entry) => entry !== undefined),
          "every queued write is an original native bound object",
        );
        guardPrepared = retained.some((entry) =>
          entry!.sql.includes("INSERT INTO artifact_mutation_guards"),
        );
        assert(guardPrepared, "sharing CHECK must be prepared and bound before independent loss");
        bounds.maximum_batch_statements = Math.max(
          bounds.maximum_batch_statements,
          statements.length,
        );
        await change();
        await integrity();
        after = await snapshot();
        afterBudgets = await budgets();
        forwarded = true;
        return binding.batch(statements);
      },
    });
    return {
      database,
      async rollback() {
        assert(
          fired && forwarded && guardPrepared && after && afterBudgets,
          "the independent cut must complete before the actual bound batch",
        );
        await unchanged(after, afterBudgets);
      },
    };
  }
  async function collect(
    name: string,
    run: (state: { phase: string; witness: Record<string, boolean> }) => Promise<void>,
  ) {
    const state = { phase: "fixture", witness: {} as Record<string, boolean> };
    try {
      await run(state);
      checks.push({ check: name, outcome: "passed", witness: state.witness });
      console.log(JSON.stringify(checks.at(-1)));
    } catch (error) {
      checks.push({ check: name, outcome: "failed", witness: state.witness });
      failures.push({
        check: name,
        phase: state.phase,
        error_name: error instanceof Error ? error.name : "unknown",
      });
      console.log(JSON.stringify(checks.at(-1)));
    }
  }

  await collect("creator_sharing_native_lifecycle", async (state) => {
    const f = await fixture();
    state.phase = "registered lifecycle";
    const empty = await readTaskSharing(db, f.creator, f.task.id);
    assert.deepEqual(empty, { task_id: f.task.id, access_version: 1, grants: [], has_more: false });
    let version = 1;
    for (const permission of ["read", "contribute", "edit"] as const) {
      const input = f.input(version, FIX.reviewer, permission),
        key = randomUlid();
      const initial = await execute<TaskSharingReceipt>(
        "task.sharing.grant",
        f.request(input, key),
      );
      const issued = success(initial);
      assert.deepEqual(Object.keys(issued).sort(), ["access_version", "grant_id", "task_id"]);
      assert.equal(issued.access_version, ++version);
      assert.equal(
        (await readTaskSharing(db, f.creator, f.task.id)).grants[0]?.permission,
        permission,
      );
      const viewer = await loadPrincipal(db, FIX.workspace, FIX.reviewer);
      await assertTaskAccess(db, viewer, f.task.id, "read");
      if (permission === "read")
        await assert.rejects(assertTaskAccess(db, viewer, f.task.id, "contribute"), {
          code: "not_found",
        });
      else await assertTaskAccess(db, viewer, f.task.id, "contribute");
      await assert.rejects(assertTaskAccess(db, viewer, f.task.id, "edit"), { code: "not_found" });
      await assert.rejects(readTaskSharing(db, viewer, f.task.id), { code: "not_found" });
      const revokeKey = randomUlid(),
        revokeInput = {
          taskId: f.task.id,
          grantId: issued.grant_id,
          expectedAccessVersion: version,
        };
      const revoked = success(
        await execute<TaskSharingReceipt>(
          "task.sharing.revoke",
          f.request(revokeInput, revokeKey),
          "b",
        ),
      );
      assert.equal(revoked.access_version, ++version);
      const beforeRetry = await snapshot(),
        http = await budgets();
      const retry = await execute<TaskSharingReceipt>(
        "task.sharing.grant",
        f.request(input, key),
        "b",
      );
      assert.deepEqual(success(retry), issued);
      assert(retry.ok && retry.replayed && initial.ok && retry.cursor === initial.cursor);
      const revokeRetry = await execute<TaskSharingReceipt>(
        "task.sharing.revoke",
        f.request(revokeInput, revokeKey),
      );
      assert.deepEqual(success(revokeRetry), revoked);
      assert(revokeRetry.ok && revokeRetry.replayed);
      const changed = await execute(
        "task.sharing.grant",
        f.request({ ...input, humanId: FIX.owner }, key),
      );
      assert.deepEqual(changed, {
        ok: false,
        error: {
          code: "request_rejected",
          message: "operation input differs from its original request",
        },
      });
      await unchanged(beforeRetry, http);
    }
    assert.deepEqual(await readTaskSharing(db, f.creator, f.task.id), {
      task_id: f.task.id,
      access_version: version,
      grants: [],
      has_more: false,
    });
    const history = (await db
      .prepare("SELECT * FROM task_human_grants WHERE task_id=? ORDER BY rowid")
      .all(f.task.id)) as Row[];
    assert.equal(history.length, 3);
    assert(history.every((row) => typeof row.revoked_at === "string"));
    for (const table of ["audit_events", "semantic_events", "outbox_records"]) {
      const rows = (await db
        .prepare(`SELECT payload_json FROM ${table} WHERE workspace_id=?`)
        .all(FIX.workspace)) as Array<{ payload_json: string }>;
      const sharing = rows
        .map((row) => JSON.parse(row.payload_json) as { input?: Row; result?: Row })
        .filter((row) => row.result?.task_id === f.task.id);
      assert.equal(sharing.length, 6);
      for (const row of sharing) {
        assert.deepEqual(Object.keys(row.result!).sort(), [
          "access_version",
          "grant_id",
          "task_id",
        ]);
        assert(
          !Object.hasOwn(row.input ?? {}, "humanId") &&
            !Object.hasOwn(row.input ?? {}, "permission"),
        );
      }
    }
    await integrity();
    state.witness = {
      registered_two_worker_lifecycle: true,
      reviewer_three_permission_intersections: true,
      retained_revocations: true,
      unchanged_historical_retries: true,
      minimal_receipts: true,
    };
  });

  await collect("recipient_project_prebatch_rollback_and_same_key_retry", async (state) => {
    const f = await fixture(),
      input = f.input(),
      key = randomUlid();
    const cut = preparedBatch(async () => {
      const removed = await independent
        .prepare("DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?")
        .run(FIX.workspace, FIX.projectA, FIX.reviewer);
      assert.equal(removed.changes, 1, "exact recipient project grant is removed independently");
    });
    state.phase = "prepared bound batch";
    const outcome = await new WorkspaceHub(cut.database).execute(
      registered<GrantTaskSharingInput, TaskSharingReceipt>("task.sharing.grant"),
      f.request(input, key),
    );
    assert.deepEqual(outcome, {
      ok: false,
      error: { code: "command_failed", message: "command failed" },
    });
    await cut.rollback();
    await independent
      .prepare("INSERT INTO project_access(workspace_id,project_id,human_id) VALUES (?,?,?)")
      .run(FIX.workspace, FIX.projectA, FIX.reviewer);
    state.phase = "same failed key retry";
    const issued = success(
      await execute<TaskSharingReceipt>("task.sharing.grant", f.request(input, key)),
    );
    assert.equal(issued.access_version, 2);
    assert.equal((await readTaskSharing(db, f.creator, f.task.id)).grants.length, 1);
    await integrity();
    state.witness = {
      original_bound_batch_forwarded: true,
      independent_recipient_loss: true,
      full_after_cut_rollback: true,
      failed_key_retry_success: true,
    };
  });

  await collect("creator_epoch_prebatch_rollback_and_current_retry", async (state) => {
    const f = await fixture(),
      input = f.input(),
      key = randomUlid();
    let newEpoch = 0;
    const cut = preparedBatch(async () => {
      newEpoch = await bumpMemberEpoch(independent, FIX.workspace, FIX.member);
      assert.equal(newEpoch, f.creator.authorizationEpoch + 1);
    });
    state.phase = "prepared bound batch";
    const outcome = await new WorkspaceHub(cut.database).execute(
      registered<GrantTaskSharingInput, TaskSharingReceipt>("task.sharing.grant"),
      f.request(input, key),
    );
    assert.deepEqual(outcome, {
      ok: false,
      error: { code: "command_failed", message: "command failed" },
    });
    await cut.rollback();
    state.phase = "new retained authority retry";
    const issued = success(
      await execute<TaskSharingReceipt>("task.sharing.grant", {
        ...f.request(input, key),
        authorizationEpoch: newEpoch,
      }),
    );
    assert.equal(issued.access_version, 2);
    await integrity();
    state.witness = {
      original_bound_batch_forwarded: true,
      independent_creator_epoch_loss: true,
      full_after_cut_rollback: true,
      fresh_epoch_failed_key_retry_success: true,
    };
  });

  await collect("synthetic_parallel_hub_version_backstop_and_optimistic_retry", async (state) => {
    const f = await fixture(),
      key = randomUlid(),
      input = f.input();
    let competing: TaskSharingReceipt | undefined;
    const cut = preparedBatch(async () => {
      competing = success(
        await new WorkspaceHub(independent).execute(
          registered<GrantTaskSharingInput, TaskSharingReceipt>("task.sharing.grant"),
          f.request(f.input(1, FIX.owner, "edit")),
        ),
      );
      assert.equal(competing.access_version, 2);
    });
    state.phase = "prepared bound batch";
    const outcome = await new WorkspaceHub(cut.database).execute(
      registered<GrantTaskSharingInput, TaskSharingReceipt>("task.sharing.grant"),
      f.request(input, key),
    );
    assert.deepEqual(outcome, {
      ok: false,
      error: { code: "command_failed", message: "command failed" },
    });
    await cut.rollback();
    state.phase = "optimistic retry";
    const retained = await snapshot(),
      http = await budgets();
    const stale = await execute("task.sharing.grant", f.request(input, key));
    assert.deepEqual(stale, {
      ok: false,
      error: { code: "stale_version", message: "task sharing version conflict" },
    });
    await unchanged(retained, http);
    const issued = success(
      await execute<TaskSharingReceipt>("task.sharing.grant", f.request(f.input(2), key)),
    );
    assert.equal(issued.access_version, 3);
    assert.equal((await readTaskSharing(db, f.creator, f.task.id)).grants.length, 2);
    await assert.rejects(
      readTaskSharing(db, await loadPrincipal(db, FIX.workspace, FIX.owner), f.task.id),
      { code: "not_found" },
    );
    await integrity();
    state.witness = {
      original_bound_batch_forwarded: true,
      synthetic_parallel_registered_hub_command: true,
      full_after_cut_rollback: true,
      new_version_failed_key_retry_success: true,
      no_owner_override: true,
    };
  });

  console.log(
    JSON.stringify({
      fixture: "synthetic_dormant_private_task_sharing",
      migration_head: manifest.migration_head,
      checks,
      failures,
      bounds,
      canonical_table_count: tables.filter(
        ({ name }) => !engine.has(name) && name !== "rate_limit_buckets",
      ).length,
      excluded_engine_tables: tables.filter(({ name }) => engine.has(name)).map(({ name }) => name),
      separately_compared_budget_tables: ["rate_limit_buckets"],
      bounds_scope:
        "instrumented prebatch-cut command preparations only; excludes lifecycle/metadata/Worker internals",
      limits:
        "Local disposable D1 and synthetic task privacy only; no private creation, inheritance, live deployment or execution certification.",
    }),
  );
  assert.equal(
    failures.length,
    0,
    "all four independently collecting native sharing groups must pass",
  );
  assert.equal(checks.length, 4);
  console.log("C11_TASK_SHARING_D1_OK");
} finally {
  await server.close();
}
