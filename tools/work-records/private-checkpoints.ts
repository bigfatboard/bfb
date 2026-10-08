// ABOUTME: Proves author-private checkpoint history and atomic authority cuts on disposable native D1.
// ABOUTME: Registered commands and original bound batches preserve complete canonical rollback witnesses and safe receipts.

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adaptD1, loadMigrationManifest, type D1Like, type D1StatementLike } from "@bfb/db";
import {
  FIX,
  WorkspaceHub,
  loadPrincipal,
  mcpResource,
  randomUlid,
  readPrivateProgress,
  readSecurityAudit,
  reportPrivateProgressCommand,
  resolveCommand,
  revokeDelegation,
  revokeTaskSharingCommand,
  seedSyntheticWorkspace,
  withPublicBusinessAuthority,
  type CommandOutcome,
  type CommandRequest,
  type HubCommand,
  type PublicBusinessAuthority,
  type TaskRecord,
} from "@bfb/domain";
import { createTestHarness } from "wrangler";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const origin = "https://bfb.private-checkpoints.test";
const BODY = "SYNTHETIC native author-private checkpoint";
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
type Receipt = { task_id: string; checkpoint_id: string; content_hash: string };
type Input = { taskId: string; body: string };
const checks: Array<{
  check: string;
  outcome: "passed" | "failed";
  witness: Record<string, boolean>;
}> = [];
const failures: Array<{ check: string; phase: string; error_name: string }> = [];
const bounds = { maximum_bindings: 0, maximum_statement_bytes: 0, maximum_batch_statements: 0 };
function success<T>(outcome: CommandOutcome<T>): T {
  assert(outcome.ok, "registered checkpoint command must succeed");
  return outcome.result;
}
function registered<I, R>(name: string): HubCommand<I, R> {
  const command = resolveCommand(name);
  assert(command, "checkpoint command must be registered");
  return command as HubCommand<I, R>;
}
async function execute<T>(name: string, request: CommandRequest<unknown>, client = "a") {
  const response = await server
    .getWorker(`bfb-work-records-${client}`)
    .fetch(`${origin}/workspaces/${FIX.workspace}/execute`, {
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
    for (const [name, rows] of Object.entries(await snapshot()))
      if (name.endsWith("_guards")) assert.deepEqual(rows, [], "transient guards must be empty");
  }
  async function unchanged(before: Snapshot, http: unknown[]) {
    assert.deepEqual(
      await snapshot(),
      before,
      "whole canonical after-cut history must remain unchanged",
    );
    assert.deepEqual(await budgets(), http);
    await integrity();
  }
  async function fixture() {
    const creator = await loadPrincipal(db, FIX.workspace, FIX.member);
    const request = <I>(input: I, key = randomUlid()): CommandRequest<I> => ({
      workspaceId: FIX.workspace,
      actorHumanId: creator.humanId,
      authorizationEpoch: creator.authorizationEpoch,
      idempotencyKey: key,
      input,
    });
    const task = success(
      await execute<TaskRecord>(
        "task.create",
        request({
          projectId: FIX.projectA,
          title: "SYNTHETIC dormant native checkpoint task",
          priority: "P2",
        }),
      ),
    );
    success(
      await execute(
        "comment.add",
        request({
          taskId: task.id,
          body: "SYNTHETIC retained ordinary comment",
          kind: "discussion",
        }),
      ),
    );
    success(
      await execute(
        "context.add",
        request({
          taskId: task.id,
          kind: "brief",
          audience: "both",
          body: "SYNTHETIC retained ordinary context",
        }),
      ),
    );
    // Fixture-only dormant policy; no private creation or execution command is exercised.
    await db
      .prepare(
        "INSERT INTO task_privacy(workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
      )
      .run(FIX.workspace, task.id, creator.humanId, new Date().toISOString());
    const grant = success(
      await execute<{ grant_id: string; access_version: number }>(
        "task.sharing.grant",
        request({
          taskId: task.id,
          humanId: FIX.owner,
          permission: "contribute",
          expectedAccessVersion: 1,
        }),
      ),
    );
    return { creator, request, task, grant };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function delegated(
    f: Fixture,
    humanId = FIX.member,
    scopes = ["bfb:read", "bfb:task:write"],
  ) {
    const sponsor = await loadPrincipal(db, FIX.workspace, humanId),
      id = randomUlid();
    const clock = (await db
      .prepare(
        "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS created_at,strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes') AS expires_at",
      )
      .get()) as { created_at: string; expires_at: string };
    // Retained synthetic OAuth metadata, not a native credential exchange claim.
    await db
      .prepare(
        `INSERT INTO oauth_delegations(workspace_id,id,human_id,client_id,resource,project_id,task_id,scopes_json,authorization_epoch,expires_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        FIX.workspace,
        id,
        humanId,
        FIX.client,
        mcpResource(origin),
        f.task.project_id,
        f.task.id,
        JSON.stringify(scopes),
        sponsor.authorizationEpoch,
        clock.expires_at,
        clock.created_at,
      );
    const authority: PublicBusinessAuthority = {
      ...sponsor,
      credential: {
        kind: "delegation",
        delegationId: id,
        clientId: FIX.client,
        projectId: f.task.project_id,
        taskId: f.task.id,
        scopes,
      },
    };
    const request = (body = BODY, key = randomUlid()): CommandRequest<Input> => ({
      workspaceId: FIX.workspace,
      actorHumanId: humanId,
      actorDelegationId: id,
      authorizationEpoch: sponsor.authorizationEpoch,
      idempotencyKey: key,
      input: withPublicBusinessAuthority(
        reportPrivateProgressCommand,
        { taskId: f.task.id, body },
        authority,
      ),
    });
    return { id, authority, request };
  }
  function preparedBatch(change: () => Promise<void>) {
    const originals = new Map<D1StatementLike, { sql: string; parameters: unknown[] }>();
    let fired = false,
      forwarded = false,
      guarded = false,
      after: Snapshot | undefined,
      http: unknown[] | undefined;
    const database = adaptD1({
      prepare(sql) {
        bounds.maximum_statement_bytes = Math.max(
          bounds.maximum_statement_bytes,
          Buffer.byteLength(sql),
        );
        assert(Buffer.byteLength(sql) <= 100_000, "checkpoint SQL must fit D1's statement bound");
        const native = binding.prepare(sql);
        const remember = (statement: D1StatementLike, parameters: unknown[]) => {
          originals.set(statement, { sql, parameters: [...parameters] });
          bounds.maximum_bindings = Math.max(bounds.maximum_bindings, parameters.length);
          assert(parameters.length <= 100, "checkpoint SQL must fit D1's binding bound");
          return statement;
        };
        remember(native, []);
        // Forward the original native bound object, not a proxy reimplementation of batch writes.
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
          "every queued write must have exact original bindings",
        );
        guarded = selected.some((entry) =>
          entry!.sql.includes("INSERT INTO artifact_mutation_guards"),
        );
        assert(guarded, "public checkpoint CHECK must be bound before the cut");
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
          fired && forwarded && guarded && after && http,
          "authority cut must finish before actual native batch",
        );
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

  await collect("registered_author_and_exact_delegation_history", async (state) => {
    const f = await fixture(),
      a = await delegated(f),
      b = await delegated(f);
    state.phase = "registered two-worker lifecycle";
    const baseline = await snapshot(),
      http = await budgets();
    const humanInput = { taskId: f.task.id, body: BODY },
      key = randomUlid();
    const human = success(
      await execute<Receipt>("progress.private.report", f.request(humanInput, key)),
    );
    const aRequest = a.request("SYNTHETIC exact delegation A checkpoint"),
      bRequest = b.request("SYNTHETIC exact delegation B checkpoint");
    const first = success(await execute<Receipt>("progress.private.report", aRequest, "b")),
      second = success(await execute<Receipt>("progress.private.report", bRequest));
    for (const value of [human, first, second])
      assert.deepEqual(Object.keys(value).sort(), ["checkpoint_id", "content_hash", "task_id"]);
    const humanView = await readPrivateProgress(db, f.creator, f.task.id);
    assert.equal(humanView.checkpoints.length, 3);
    assert.equal(humanView.checkpoints.filter((row) => row.origin === "human").length, 1);
    assert.deepEqual(
      (await readPrivateProgress(db, a.authority, f.task.id)).checkpoints.map((row) => row.id),
      [first.checkpoint_id],
    );
    assert.deepEqual(
      (await readPrivateProgress(db, b.authority, f.task.id)).checkpoints.map((row) => row.id),
      [second.checkpoint_id],
    );
    assert.deepEqual(
      (await readPrivateProgress(db, await loadPrincipal(db, FIX.workspace, FIX.owner), f.task.id))
        .checkpoints,
      [],
    );
    const after = await snapshot();
    for (const name of [
      "tasks",
      "comments",
      "task_context_items",
      "task_context_deliveries",
      "notification_deliveries",
      "measurement_intervals",
    ])
      assert.deepEqual(
        after[name],
        baseline[name],
        "checkpoints must not become generic work or telemetry",
      );
    for (const name of [
      "audit_events",
      "semantic_events",
      "outbox_records",
      "idempotency_records",
    ]) {
      assert.equal(after[name]!.length, baseline[name]!.length + 3);
      for (const row of after[name]!.slice(baseline[name]!.length)) {
        assert(
          !JSON.stringify(row).includes("SYNTHETIC"),
          "checkpoint prose must not enter receipts",
        );
      }
    }
    assert.deepEqual(await budgets(), http);
    // Rejected writes leave the append-only checkpoint source unchanged; no trigger bypass is used.
    await assert.rejects(
      db
        .prepare("UPDATE task_private_checkpoints SET body=? WHERE workspace_id=? AND id=?")
        .run("SYNTHETIC rejected rewrite", FIX.workspace, human.checkpoint_id),
    );
    await assert.rejects(
      db
        .prepare("DELETE FROM task_private_checkpoints WHERE workspace_id=? AND id=?")
        .run(FIX.workspace, human.checkpoint_id),
    );
    await unchanged(after, http);
    const retry = await execute<Receipt>("progress.private.report", aRequest);
    assert(retry.ok && retry.replayed);
    assert.deepEqual(retry.result, first);
    const changed = await execute("progress.private.report", {
      ...aRequest,
      input: withPublicBusinessAuthority(
        reportPrivateProgressCommand,
        { taskId: f.task.id, body: "SYNTHETIC changed input" },
        a.authority,
      ),
    });
    assert.deepEqual(changed, {
      ok: false,
      error: {
        code: "request_rejected",
        message: "operation input differs from its original request",
      },
    });
    await unchanged(after, http);
    await revokeDelegation(independent, FIX.workspace, a.id, new Date().toISOString());
    const retained = await snapshot(),
      retainedHttp = await budgets();
    assert.equal((await readPrivateProgress(db, f.creator, f.task.id)).checkpoints.length, 3);
    const audit = await readSecurityAudit(db, FIX.workspace, {
      access: await loadPrincipal(db, FIX.workspace, FIX.owner),
      limit: 100,
    });
    assert(!JSON.stringify(audit).includes("progress.private.report"));
    await unchanged(retained, retainedHttp);
    state.witness = {
      registered_two_worker_lifecycle: true,
      exact_origins: true,
      owner_history_survives_origin_revoke: true,
      unchanged_historical_retry: true,
      changed_retry_rejected: true,
      safe_receipts_no_generic_effects: true,
    };
  });

  await collect("write_only_reviewer_receipt_and_origin_ceiling", async (state) => {
    const f = await fixture();
    success(
      await execute(
        "task.sharing.grant",
        f.request({
          taskId: f.task.id,
          humanId: FIX.reviewer,
          permission: "contribute",
          expectedAccessVersion: 2,
        }),
      ),
    );
    const delegatedReviewer = await delegated(f, FIX.reviewer, ["bfb:task:write"]);
    state.phase = "registered write-only Reviewer command";
    const request = delegatedReviewer.request(),
      issued = success(await execute<Receipt>("progress.private.report", request));
    assert.deepEqual(Object.keys(issued).sort(), ["checkpoint_id", "content_hash", "task_id"]);
    const before = await snapshot(),
      http = await budgets();
    await assert.rejects(readPrivateProgress(db, delegatedReviewer.authority, f.task.id), {
      code: "not_found",
      message: "private progress not found",
    });
    assert.equal(
      (
        await readPrivateProgress(
          db,
          await loadPrincipal(db, FIX.workspace, FIX.reviewer),
          f.task.id,
        )
      ).checkpoints[0]?.id,
      issued.checkpoint_id,
    );
    assert.equal((await readPrivateProgress(db, f.creator, f.task.id)).checkpoints.length, 0);
    const replay = await execute<Receipt>("progress.private.report", request, "b");
    assert(replay.ok && replay.replayed);
    assert.deepEqual(replay.result, issued);
    await unchanged(before, http);
    state.witness = {
      write_only_receipt: true,
      reviewer_contribute_ceiling: true,
      exact_owner_history: true,
      no_read_widening: true,
    };
  });

  await collect(
    "independent_contribution_revoke_atomic_rollback_and_failed_key_retry",
    async (state) => {
      const f = await fixture(),
        actor = await loadPrincipal(db, FIX.workspace, FIX.owner),
        key = randomUlid();
      const request: CommandRequest<Input> = {
        workspaceId: FIX.workspace,
        actorHumanId: actor.humanId,
        authorizationEpoch: actor.authorizationEpoch,
        idempotencyKey: key,
        input: withPublicBusinessAuthority(
          reportPrivateProgressCommand,
          { taskId: f.task.id, body: BODY },
          actor,
        ),
      };
      const cut = preparedBatch(async () => {
        const revoked = success(
          await new WorkspaceHub(independent).execute(
            revokeTaskSharingCommand,
            f.request({ taskId: f.task.id, grantId: f.grant.grant_id, expectedAccessVersion: 2 }),
          ),
        );
        assert.equal(revoked.access_version, 3);
        assert(
          (
            (await independent
              .prepare("SELECT revoked_at FROM task_human_grants WHERE id=?")
              .get(f.grant.grant_id)) as Row
          ).revoked_at !== null,
        );
      });
      state.phase = "independent production revoke before original bound batch";
      const outcome = await new WorkspaceHub(cut.database).execute(
        registered<Input, Receipt>("progress.private.report"),
        request,
      );
      assert.deepEqual(outcome, {
        ok: false,
        error: { code: "command_failed", message: "command failed" },
      });
      await cut.rollback();
      success(
        await execute(
          "task.sharing.grant",
          f.request({
            taskId: f.task.id,
            humanId: FIX.owner,
            permission: "contribute",
            expectedAccessVersion: 3,
          }),
        ),
      );
      state.phase = "same failed key retry with new valid contribution";
      const issued = success(await execute<Receipt>("progress.private.report", request));
      assert.equal(
        (await readPrivateProgress(db, actor, f.task.id)).checkpoints[0]?.id,
        issued.checkpoint_id,
      );
      await integrity();
      state.witness = {
        original_bound_objects_forwarded: true,
        independent_revoke_completed: true,
        full_after_cut_rollback: true,
        failed_key_retry_success: true,
      };
    },
  );

  await collect("independent_delegation_revoke_atomic_rollback", async (state) => {
    const f = await fixture(),
      authority = await delegated(f);
    const request = authority.request();
    const cut = preparedBatch(async () => {
      const cursor = await independent
        .prepare("SELECT * FROM workspace_cursors ORDER BY rowid")
        .all();
      await revokeDelegation(independent, FIX.workspace, authority.id, new Date().toISOString());
      assert(
        (
          (await independent
            .prepare("SELECT revoked_at FROM oauth_delegations WHERE workspace_id=? AND id=?")
            .get(FIX.workspace, authority.id)) as Row
        ).revoked_at !== null,
      );
      assert.deepEqual(
        await independent.prepare("SELECT * FROM workspace_cursors ORDER BY rowid").all(),
        cursor,
      );
    });
    state.phase = "independent production delegation revoke before original bound batch";
    assert.deepEqual(
      await new WorkspaceHub(cut.database).execute(
        registered<Input, Receipt>("progress.private.report"),
        request,
      ),
      { ok: false, error: { code: "command_failed", message: "command failed" } },
    );
    await cut.rollback();
    state.witness = {
      original_bound_objects_forwarded: true,
      independent_revoke_completed: true,
      full_after_cut_rollback: true,
      cursor_and_safe_history_retained: true,
    };
  });

  console.log(
    JSON.stringify({
      fixture: "synthetic_dormant_author_private_checkpoints",
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
        "instrumented prebatch-cut checkpoint command preparations only; excludes lifecycle/read/Worker internals",
      limits:
        "Disposable native D1, registered Worker/Hub commands and synthetic retained OAuth/policies; no native OAuth exchange, private creation, local checkpoint delivery, provider operation, activation or deployment.",
    }),
  );
  assert.equal(checks.length, 4);
  assert.equal(failures.length, 0, "all four collecting native checkpoint groups must pass");
  console.log("C11_PRIVATE_CHECKPOINT_D1_OK");
} finally {
  await server.close();
}
