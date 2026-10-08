// ABOUTME: Proves unregistered private creation and retained descendant authority on disposable native D1.
// ABOUTME: Original bound batches and independent registered revocations preserve canonical rollback history.

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  adaptD1,
  loadMigrationManifest,
  type D1Like,
  type D1StatementLike,
  type SqlDatabase,
} from "@bfb/db";
import {
  FIX,
  WorkspaceHub,
  assertTaskAccess,
  createPrivateTaskCommand,
  finalizePublicBusinessResult,
  getTask,
  listTasksPage,
  loadPrincipal,
  persistTaskCreation,
  prepareTaskCreation,
  randomUlid,
  readPrivateProgress,
  readTaskSharing,
  resolveCommand,
  seedSyntheticWorkspace,
  withPublicBusinessAuthority,
  type CommandOutcome,
  type CommandRequest,
  type CreateTaskInput,
  type HubContext,
  type PublicBusinessAuthority,
  type TaskRecord,
  type TaskSharingReceipt,
} from "@bfb/domain";
import { createTestHarness } from "wrangler";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
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

function success<T>(outcome: CommandOutcome<T>): T {
  assert(outcome.ok, "native command must succeed");
  return outcome.result;
}
async function execute<T>(name: string, request: CommandRequest<unknown>, client = "a") {
  const response = await server
    .getWorker(`bfb-work-records-${client}`)
    .fetch(`https://bfb.private-inheritance.test/workspaces/${FIX.workspace}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandName: name, request }),
    });
  assert.equal(response.status, 200);
  return (await response.json()) as CommandOutcome<T>;
}

try {
  await server.listen();
  const worker = server.getWorker("bfb-work-records-hub");
  await worker.applyD1Migrations("DB");
  const binding = ((await worker.getEnv()) as unknown as { DB: D1Like }).DB;
  const db = adaptD1(binding);
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
      "unexpected engine table",
    );
  }
  async function snapshot(): Promise<Snapshot> {
    const result: Snapshot = {};
    for (const { name } of tables)
      if (!engine.has(name) && name !== "rate_limit_buckets")
        result[name] = (await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()) as Row[];
    return result;
  }
  async function budgets() {
    return db.prepare("SELECT * FROM rate_limit_buckets ORDER BY rowid").all();
  }
  async function integrity() {
    assert.deepEqual(await db.prepare("PRAGMA foreign_key_check").all(), []);
    for (const { name } of tables)
      if (name.endsWith("_guards"))
        assert.deepEqual(
          await db.prepare(`SELECT * FROM "${name}"`).all(),
          [],
          "transient guards must be empty",
        );
  }
  async function unchanged(before: Snapshot, http: unknown[]) {
    assert.deepEqual(await snapshot(), before, "whole canonical history must remain unchanged");
    assert.deepEqual(await budgets(), http, "HTTP budget bookkeeping is compared separately");
    await integrity();
  }
  function request<I>(
    authority: PublicBusinessAuthority,
    input: I,
    key = randomUlid(),
  ): CommandRequest<I> {
    return {
      workspaceId: authority.workspaceId,
      actorHumanId: authority.humanId,
      authorizationEpoch: authority.authorizationEpoch,
      idempotencyKey: key,
      input,
    };
  }
  function creationRequest(
    authority: PublicBusinessAuthority,
    parentTaskId?: string,
    key = randomUlid(),
  ) {
    const input: CreateTaskInput = {
      projectId: FIX.projectA,
      title: "SYNTHETIC prepared private task",
      priority: "P2",
      ...(parentTaskId === undefined ? {} : { parentTaskId }),
    };
    return request(
      authority,
      withPublicBusinessAuthority(createPrivateTaskCommand, input, authority),
      key,
    );
  }
  async function preparedCreate(authority: PublicBusinessAuthority, parentTaskId?: string) {
    // Direct domain execution is preparation proof, never production registration or transport admission.
    return success(
      await new WorkspaceHub(db).execute(
        createPrivateTaskCommand,
        creationRequest(authority, parentTaskId),
      ),
    );
  }
  async function policyVersion(taskId: string) {
    const row = (await db
      .prepare("SELECT access_version FROM task_privacy WHERE workspace_id=? AND task_id=?")
      .get(FIX.workspace, taskId)) as { access_version: number } | undefined;
    assert(row);
    return row.access_version;
  }
  async function grant(creator: PublicBusinessAuthority, taskId: string) {
    return success(
      await execute<TaskSharingReceipt>(
        "task.sharing.grant",
        request(creator, {
          taskId,
          humanId: FIX.owner,
          permission: "edit",
          expectedAccessVersion: await policyVersion(taskId),
        }),
      ),
    );
  }
  async function fixture() {
    const creator = await loadPrincipal(db, FIX.workspace, FIX.member);
    const recipient = await loadPrincipal(db, FIX.workspace, FIX.owner);
    const created = await preparedCreate(creator);
    const sharing = await grant(creator, created.task_id);
    return { creator, recipient, created, sharing };
  }
  async function loseProject(humanId: string) {
    const result = await db
      .prepare("DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?")
      .run(FIX.workspace, FIX.projectA, humanId);
    assert.equal(result.changes, 1, "exact canonical project grant must be independently removed");
    assert.equal(
      await db
        .prepare(
          "SELECT 1 FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?",
        )
        .get(FIX.workspace, FIX.projectA, humanId),
      null,
    );
  }
  async function restoreProject(humanId: string) {
    await db
      .prepare("INSERT INTO project_access(workspace_id,project_id,human_id) VALUES (?,?,?)")
      .run(FIX.workspace, FIX.projectA, humanId);
  }
  function preparedBatch(change: () => Promise<void>, inherited: boolean) {
    const originals = new Map<D1StatementLike, { sql: string; parameters: unknown[] }>();
    let fired = false,
      forwarded = false,
      after: Snapshot | undefined,
      http: unknown[] | undefined;
    const database = adaptD1({
      prepare(sql) {
        const bytes = Buffer.byteLength(sql);
        bounds.maximum_statement_bytes = Math.max(bounds.maximum_statement_bytes, bytes);
        assert(bytes <= 100_000, "prepared creation SQL must stay bounded");
        const native = binding.prepare(sql);
        const remember = (statement: D1StatementLike, parameters: unknown[]) => {
          originals.set(statement, { sql, parameters: [...parameters] });
          bounds.maximum_bindings = Math.max(bounds.maximum_bindings, parameters.length);
          assert(parameters.length <= 100, "prepared creation bindings must stay bounded");
          return statement;
        };
        remember(native, []);
        return {
          bind: (...parameters) => remember(native.bind(...parameters), parameters),
          first: (column) => native.first(column),
          all: () => native.all(),
          run: () => native.run(),
        };
      },
      async batch(statements) {
        assert.equal(fired, false);
        fired = true;
        const selected = statements.map((statement) => originals.get(statement));
        assert(
          selected.every((entry) => entry !== undefined),
          "every queued write must be an original native bound object",
        );
        assert(
          selected.some((entry) => entry!.sql.includes("INSERT INTO tasks")),
          "creation writes must already be bound",
        );
        assert(
          selected.some((entry) =>
            entry!.sql.includes(
              inherited ? "INSERT INTO task_privacy_inheritance" : "INSERT INTO task_privacy (",
            ),
          ),
          "exact privacy writes must already be bound",
        );
        assert(
          selected.some((entry) => entry!.sql.includes("INSERT INTO artifact_mutation_guards")),
          "current-authority CHECK must already be bound",
        );
        bounds.maximum_batch_statements = Math.max(
          bounds.maximum_batch_statements,
          statements.length,
        );
        await change();
        await integrity();
        after = await snapshot();
        http = await budgets();
        forwarded = true;
        return binding.batch(statements);
      },
    });
    return {
      database,
      async rollback() {
        assert(
          fired && forwarded && after && http,
          "independent cut must precede the actual native batch",
        );
        await unchanged(after, http);
      },
    };
  }
  function afterCacheRead(database: SqlDatabase, key: string, change: () => Promise<void>) {
    let fired = false,
      after: Snapshot | undefined,
      http: unknown[] | undefined;
    const wrap = (source: SqlDatabase): SqlDatabase => ({
      prepare(sql) {
        const native = source.prepare(sql);
        return {
          run: (...parameters) => native.run(...parameters),
          all: (...parameters) => native.all(...parameters),
          async get(...parameters) {
            const row = await native.get(...parameters);
            if (
              sql.includes("SELECT command_name, result_json FROM idempotency_records") &&
              parameters.includes(key)
            ) {
              assert.equal(fired, false);
              assert(row, "actual retained Hub outcome must exist before the cut");
              fired = true;
              await change();
              after = await snapshot();
              http = await budgets();
            }
            return row;
          },
        };
      },
      withTransaction: (fn) => source.withTransaction((tx) => fn(wrap(tx))),
    });
    return {
      database: wrap(database),
      async retained() {
        assert(fired && after && http, "actual idempotency selection must finish before the cut");
        await unchanged(after, http);
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
    } catch (error) {
      checks.push({ check: name, outcome: "failed", witness: state.witness });
      failures.push({
        check: name,
        phase: state.phase,
        error_name: error instanceof Error ? error.name : "unknown",
      });
    }
    console.log(JSON.stringify(checks.at(-1)));
  }

  await collect("unregistered_preparation_and_retained_root_family", async (state) => {
    state.phase = "unregistered_catalog_control";
    assert.equal(
      resolveCommand("task.private.create"),
      undefined,
      "private creation must remain unregistered",
    );
    state.phase = "prepared_root_and_registered_sharing_fixture";
    const f = await fixture();
    state.phase = "prepared_child_creation";
    const child = await preparedCreate(f.recipient, f.created.task_id);
    state.phase = "prepared_grandchild_creation";
    const grandchild = await preparedCreate(f.recipient, child.task_id);
    for (const [index, receipt] of [f.created, child, grandchild].entries()) {
      const label = ["root", "child", "grandchild"][index]!;
      state.phase = `${label}_minimal_receipt_shape`;
      assert.deepEqual(Object.keys(receipt).sort(), [
        "parent_task_id",
        "privacy_root_task_id",
        "project_id",
        "task_id",
      ]);
      state.phase = `${label}_retained_root_identity`;
      assert.equal(receipt.privacy_root_task_id, f.created.task_id);
      state.phase = `${label}_current_edit_metadata_selection`;
      const metadata = await assertTaskAccess(db, f.recipient, receipt.task_id, "edit");
      state.phase = `${label}_current_root_creator_metadata`;
      assert.equal(metadata.privateOwnerHumanId, f.creator.humanId);
      state.phase = `${label}_current_root_access_version`;
      assert.equal(metadata.accessVersion, 2);
      state.phase = `${label}_canonical_authorship_selection`;
      const source = (await db
        .prepare(
          "SELECT created_by_human_id,created_by_delegation_id FROM tasks WHERE workspace_id=? AND id=?",
        )
        .get(FIX.workspace, receipt.task_id)) as Row;
      state.phase = `${label}_truthful_human_authorship`;
      assert.equal(
        source.created_by_human_id,
        receipt === f.created ? f.creator.humanId : f.recipient.humanId,
      );
      state.phase = `${label}_truthful_delegation_authorship`;
      assert.equal(source.created_by_delegation_id, null);
      state.phase = `${label}_unscoped_private_denial`;
      assert.equal(await getTask(db, FIX.workspace, receipt.task_id), undefined);
    }
    state.phase = "depth_two_immediate_parent_receipts";
    assert.equal(child.parent_task_id, f.created.task_id);
    assert.equal(grandchild.parent_task_id, child.task_id);
    state.phase = "ordinary_registered_shared_creation";
    const shared = success(
      await execute<TaskRecord>(
        "task.create",
        request(f.recipient, {
          projectId: FIX.projectA,
          title: "SYNTHETIC registered shared task",
          priority: "P2",
        }),
      ),
    );
    state.phase = "ordinary_registered_shared_read";
    assert(await getTask(db, FIX.workspace, shared.id), "ordinary registered root remains shared");
    state.phase = "ordered_inherited_fixture_parent_selection";
    const parent = await getTask(db, FIX.workspace, f.created.task_id, f.recipient);
    assert(parent);
    state.phase = "ordered_inherited_fixture_preparation";
    const fixtureContext: HubContext = {
      db,
      workspaceId: FIX.workspace,
      authorizationEpoch: f.recipient.authorizationEpoch,
      actorHumanId: f.recipient.humanId,
      cursorBase: 0,
      now: new Date().toISOString(),
    };
    const orderedChild = await prepareTaskCreation(
      { projectId: FIX.projectA, title: "SYNTHETIC ordered inherited child", priority: "P2" },
      fixtureContext,
      false,
      parent,
    );
    // This new fixture row precedes every generated "01" ID without changing retained source IDs.
    orderedChild.id = "00000000000000000000000001";
    state.phase = "ordered_inherited_fixture_persistence";
    await persistTaskCreation(fixtureContext, orderedChild, {
      humanId: f.recipient.humanId,
      delegationId: null,
    });
    await db
      .prepare(
        `INSERT INTO task_privacy_inheritance
          (workspace_id,project_id,task_id,root_task_id,created_at) VALUES (?,?,?,?,?)`,
      )
      .run(FIX.workspace, FIX.projectA, orderedChild.id, f.created.task_id, fixtureContext.now);
    state.phase = "ordered_inherited_fixture_unscoped_denial";
    assert.equal(await getTask(db, FIX.workspace, orderedChild.id), undefined);
    state.phase = "raw_hidden_first_selection";
    const first = (await db
      .prepare("SELECT id FROM tasks WHERE workspace_id=? AND project_id=? ORDER BY id LIMIT 1")
      .get(FIX.workspace, FIX.projectA)) as Row;
    state.phase = "raw_hidden_first_witness";
    assert.equal(
      first.id,
      orderedChild.id,
      "the exact hidden inherited fixture must precede the shared LIMIT control",
    );
    state.phase = "shared_limit_before_snapshot";
    const before = await snapshot(),
      http = await budgets();
    state.phase = "shared_limit_final_selection";
    const page = await listTasksPage(db, FIX.workspace, [FIX.projectA], { limit: 1 });
    state.phase = "shared_limit_filtered_body";
    assert.deepEqual(
      page.tasks.map((item) => item.id),
      [shared.id],
    );
    state.phase = "shared_limit_lookahead";
    assert.equal(page.has_more, false);
    state.phase = "shared_limit_unchanged_snapshot";
    await unchanged(before, http);
    state.witness = {
      unregistered_command: true,
      inferred_root_creator: true,
      named_edit_depth_two: true,
      truthful_authorship: true,
      deterministic_inherited_limit_fixture: true,
      shared_only_before_limit: true,
      ordinary_registered_root_shared: true,
    };
  });

  await collect(
    "immutable_lineage_exact_root_sharing_and_private_author_history",
    async (state) => {
      const f = await fixture(),
        child = await preparedCreate(f.recipient, f.created.task_id);
      state.phase = "native retained lineage and exact-root sharing";
      const before = await snapshot(),
        http = await budgets();
      for (const [sql, parameters] of [
        [
          "UPDATE task_privacy_inheritance SET root_task_id=? WHERE workspace_id=? AND task_id=?",
          [child.task_id, FIX.workspace, child.task_id],
        ],
        [
          "DELETE FROM task_privacy_inheritance WHERE workspace_id=? AND task_id=?",
          [FIX.workspace, child.task_id],
        ],
        [
          "UPDATE tasks SET parent_task_id=NULL WHERE workspace_id=? AND id=?",
          [FIX.workspace, child.task_id],
        ],
        [
          "UPDATE tasks SET project_id=? WHERE workspace_id=? AND id=?",
          [FIX.projectB, FIX.workspace, child.task_id],
        ],
        [
          "UPDATE tasks SET created_by_human_id=? WHERE workspace_id=? AND id=?",
          [f.creator.humanId, FIX.workspace, child.task_id],
        ],
        [
          "INSERT INTO task_privacy(workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
          [FIX.workspace, child.task_id, f.recipient.humanId, new Date().toISOString()],
        ],
      ] as Array<[string, unknown[]]>)
        await assert.rejects(db.prepare(sql).run(...parameters));
      await assert.rejects(readTaskSharing(db, f.creator, child.task_id), {
        code: "not_found",
        message: "task sharing not found",
      });
      const denied = await execute(
        "task.sharing.grant",
        request(f.creator, {
          taskId: child.task_id,
          humanId: FIX.reviewer,
          permission: "read",
          expectedAccessVersion: 1,
        }),
      );
      assert.deepEqual(denied, {
        ok: false,
        error: { code: "not_found", message: "task sharing not found" },
      });
      await unchanged(before, http);
      const checkpoint = success(
        await execute<{ task_id: string; checkpoint_id: string }>(
          "progress.private.report",
          request(f.recipient, {
            taskId: child.task_id,
            body: "SYNTHETIC descendant-author checkpoint",
          }),
        ),
      );
      const retained = await snapshot(),
        retainedHttp = await budgets();
      assert.equal(checkpoint.task_id, child.task_id);
      assert.deepEqual(
        (await readPrivateProgress(db, f.recipient, child.task_id)).checkpoints.map(
          (item) => item.id,
        ),
        [checkpoint.checkpoint_id],
      );
      assert.deepEqual((await readPrivateProgress(db, f.creator, child.task_id)).checkpoints, []);
      assert.deepEqual(
        (await readPrivateProgress(db, f.recipient, f.created.task_id)).checkpoints,
        [],
      );
      const checkpointRow = (await db
        .prepare(
          "SELECT task_id,owner_human_id FROM task_private_checkpoints WHERE workspace_id=? AND id=?",
        )
        .get(FIX.workspace, checkpoint.checkpoint_id)) as Row;
      assert.deepEqual(checkpointRow, {
        task_id: child.task_id,
        owner_human_id: f.recipient.humanId,
      });
      await unchanged(retained, retainedHttp);
      state.witness = {
        immutable_association_parent_project_authorship: true,
        direct_policy_excluded: true,
        descendant_sharing_denied: true,
        registered_checkpoint_exact_task_author: true,
        root_creator_no_author_history_override: true,
      };
    },
  );

  await collect(
    "independent_registered_root_revoke_before_original_creation_batch",
    async (state) => {
      const f = await fixture(),
        creation = creationRequest(f.recipient, f.created.task_id);
      const cut = preparedBatch(async () => {
        // The independent registered Hub completes its revoke before an unregistered DirectDomainHub flush.
        // This deliberately bypasses production FIFO and is a synthetic atomic-backstop probe only.
        const revoked = success(
          await execute<TaskSharingReceipt>(
            "task.sharing.revoke",
            request(f.creator, {
              taskId: f.created.task_id,
              grantId: f.sharing.grant_id,
              expectedAccessVersion: 2,
            }),
            "b",
          ),
        );
        assert.equal(revoked.access_version, 3);
        const row = (await db
          .prepare("SELECT revoked_at FROM task_human_grants WHERE workspace_id=? AND id=?")
          .get(FIX.workspace, f.sharing.grant_id)) as Row;
        assert.notEqual(row.revoked_at, null);
      }, true);
      state.phase = "independent registered revoke before original native bound flush";
      assert.deepEqual(
        await new WorkspaceHub(cut.database).execute(createPrivateTaskCommand, creation),
        { ok: false, error: { code: "command_failed", message: "command failed" } },
      );
      await cut.rollback();
      const restored = await grant(f.creator, f.created.task_id);
      assert.equal(restored.access_version, 4);
      state.phase = "same failed creation key after explicit re-share";
      const created = success(
        await new WorkspaceHub(db).execute(createPrivateTaskCommand, creation),
      );
      assert.equal(created.privacy_root_task_id, f.created.task_id);
      assert(await getTask(db, FIX.workspace, created.task_id, f.recipient));
      await integrity();
      state.witness = {
        exact_original_bound_objects: true,
        registered_independent_revoke_completed: true,
        full_after_cut_rollback: true,
        failed_key_succeeds_after_explicit_reshare: true,
        synthetic_non_fifo_backstop: true,
      };
    },
  );

  await collect("current_project_batch_cache_and_post_await_finalizer", async (state) => {
    const creator = await loadPrincipal(db, FIX.workspace, FIX.member),
      creation = creationRequest(creator);
    const cut = preparedBatch(() => loseProject(creator.humanId), false);
    state.phase = "exact project removal before original bound root creation";
    assert.deepEqual(
      await new WorkspaceHub(cut.database).execute(createPrivateTaskCommand, creation),
      { ok: false, error: { code: "command_failed", message: "command failed" } },
    );
    await cut.rollback();
    await restoreProject(creator.humanId);
    const created = success(await new WorkspaceHub(db).execute(createPrivateTaskCommand, creation));
    const cacheCut = afterCacheRead(db, creation.idempotencyKey, () =>
      loseProject(creator.humanId),
    );
    state.phase = "exact project removal after actual retained idempotency selection";
    const denied = await new WorkspaceHub(cacheCut.database).execute(
      createPrivateTaskCommand,
      creation,
    );
    assert.deepEqual(denied, {
      ok: false,
      error: { code: "not_found", message: "resource not available" },
    });
    await cacheCut.retained();
    await restoreProject(creator.humanId);
    const historical = await new WorkspaceHub(db).execute(createPrivateTaskCommand, creation);
    assert(historical.ok && historical.replayed);
    assert.deepEqual(historical.result, created);
    state.phase = "current finalizer after successful cached native Hub await";
    await loseProject(creator.humanId);
    const retained = await snapshot(),
      http = await budgets();
    const ctx: HubContext = {
      db,
      workspaceId: FIX.workspace,
      actorHumanId: creator.humanId,
      authorizationEpoch: creator.authorizationEpoch,
      now: new Date().toISOString(),
      cursorBase: 0,
    };
    await assert.rejects(
      finalizePublicBusinessResult(
        createPrivateTaskCommand,
        creation.input,
        historical.result,
        ctx,
      ),
      { code: "not_found", message: "resource not available" },
    );
    assert(
      await db
        .prepare("SELECT 1 FROM tasks WHERE workspace_id=? AND id=?")
        .get(FIX.workspace, created.task_id),
      "successful historical task must remain committed",
    );
    await unchanged(retained, http);
    await restoreProject(creator.humanId);
    state.witness = {
      exact_project_row_cut: true,
      original_bound_batch_rollback: true,
      same_failed_key_success: true,
      actual_cache_read_late_denial: true,
      current_post_await_finalizer_denial: true,
      committed_history_retained: true,
    };
  });

  console.log(
    JSON.stringify({
      fixture: "synthetic_unregistered_private_inheritance_preparation",
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
        "Instrumented prepared creation reads/writes/batches in the two prebatch-cut groups only; excludes fixtures, snapshots and registered Worker/Hub internals.",
      limitations:
        "Disposable native D1; task.private.create runs unregistered in a direct Node DomainHub. The ordered inherited LIMIT source is a new synthetic fixture persisted without a command receipt. Independent registered revoke intentionally bypasses production FIFO; project cuts are synthetic. No browser/CLI/OAuth admission, private creation activation, agent execution, runner/lease/cleanup, provider, destructive retention or deployment proof.",
    }),
  );
  assert.equal(checks.length, 4);
  assert.equal(failures.length, 0, "all four bounded native inheritance groups must pass");
  console.log("C11_PRIVATE_INHERITANCE_D1_OK");
} finally {
  await server.close();
}
