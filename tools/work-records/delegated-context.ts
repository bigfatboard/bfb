// ABOUTME: Proves delegated context selection, committing delivery and cached authority on disposable real D1.
// ABOUTME: Native Hub batches and synthetic private read grants never operate providers, runners or live work.

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
  bumpMemberEpoch,
  deliverDelegatedAgentContextCommand,
  loadPrincipal,
  randomUlid,
  revokeDelegation,
  seedSyntheticWorkspace,
  type AgentContextItem,
  type CommandOutcome,
  type CommandRequest,
  type TaskRecord,
} from "@bfb/domain";
import { createTestHarness } from "wrangler";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const origin = "https://bfb.delegated-context.test";
const canary = "SYNTHETIC-C11-DELEGATED-CONTEXT";
const historicalRequestTime = "2025-01-01T00:00:00.000Z";
const server = createTestHarness({
  root,
  workers: [
    { configPath: "tools/work-records/wrangler-a.toml" },
    { configPath: "tools/work-records/wrangler-b.toml" },
    { configPath: "tools/work-records/wrangler-hub.toml" },
  ],
});
const checks: string[] = [];
const failures: Array<{ check: string; message: string }> = [];
const bounds = {
  maximum_bindings: 0,
  maximum_statement_bytes: 0,
  maximum_batch_statements: 0,
  maximum_context_items: 0,
};
const rejectedSelection = {
  ok: false,
  error: { code: "not_found", message: "task not found" },
};
const rejectedCommit = {
  ok: false,
  error: { code: "command_failed", message: "command failed" },
};

function success<T>(outcome: CommandOutcome<T>): T {
  assert(outcome.ok, outcome.ok ? undefined : outcome.error.code);
  return outcome.result;
}

async function check(name: string, run: () => Promise<void>) {
  try {
    await run();
    checks.push(name);
    console.log(JSON.stringify({ check: name, outcome: "passed" }));
  } catch (error) {
    const first = error instanceof Error ? error.message.split("\n")[0] : "assertion failed";
    failures.push({
      check: name,
      message: first?.includes(canary)
        ? "synthetic context omitted"
        : (first ?? "assertion failed").slice(0, 160),
    });
    console.log(JSON.stringify({ check: name, outcome: "failed" }));
  }
}

async function execute<T>(name: string, request: CommandRequest<unknown>, worker = "a") {
  const response = await server
    .getWorker(`bfb-work-records-${worker}`)
    .fetch(`${origin}/workspaces/${FIX.workspace}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandName: name, request }),
    });
  assert.equal(response.status, 200);
  return (await response.json()) as CommandOutcome<T>;
}

function interleave(
  binding: D1Like,
  hooks: {
    beforeSelection?: () => Promise<void>;
    beforeBatch?: () => Promise<void>;
    afterCache?: () => Promise<void>;
  },
) {
  const state = {
    selectionReached: false,
    batchReached: false,
    cacheReached: false,
    observedAt: "",
  };
  const nativeDb = adaptD1({
    prepare(sql) {
      const bytes = Buffer.byteLength(sql);
      bounds.maximum_statement_bytes = Math.max(bounds.maximum_statement_bytes, bytes);
      assert(bytes <= 100_000, "context SQL must fit the checked statement bound");
      const native = binding.prepare(sql);
      const statement: D1StatementLike = {
        bind(...parameters) {
          bounds.maximum_bindings = Math.max(bounds.maximum_bindings, parameters.length);
          assert(parameters.length <= 100, "context SQL must fit the checked parameter bound");
          if (sql.includes("INSERT INTO semantic_events")) {
            assert.equal(typeof parameters.at(-1), "string");
            state.observedAt = parameters.at(-1) as string;
          }
          // adaptD1 queues the actual native bound statement, not the read-hook wrapper.
          return native.bind(...parameters);
        },
        first: (column) => native.first(column),
        all: () => native.all(),
        run: () => native.run(),
      };
      return statement;
    },
    async batch(statements) {
      assert.equal(state.batchReached, false, "one context command must flush one atomic batch");
      state.batchReached = true;
      bounds.maximum_batch_statements = Math.max(
        bounds.maximum_batch_statements,
        statements.length,
      );
      assert(statements.length <= 80, "context delivery must retain a bounded batch");
      await hooks.beforeBatch?.();
      return binding.batch(statements);
    },
  });
  async function beforeRead(sql: string) {
    if (sql.includes("task_context_items") && !state.selectionReached) {
      state.selectionReached = true;
      await hooks.beforeSelection?.();
    }
  }
  function wrap(db: SqlDatabase): SqlDatabase {
    return {
      prepare(sql) {
        const statement = db.prepare(sql);
        return {
          run: (...parameters) => statement.run(...parameters),
          async get(...parameters) {
            await beforeRead(sql);
            const result = await statement.get(...parameters);
            if (
              !state.cacheReached &&
              result !== null &&
              result !== undefined &&
              sql.includes("idempotency_records") &&
              sql.includes("result_json")
            ) {
              state.cacheReached = true;
              await hooks.afterCache?.();
            }
            return result;
          },
          async all(...parameters) {
            await beforeRead(sql);
            return statement.all(...parameters);
          },
        };
      },
      withTransaction: (run) => db.withTransaction((tx) => run(wrap(tx))),
    };
  }
  return { db: wrap(nativeDb), state };
}

try {
  await server.listen();
  const worker = server.getWorker("bfb-work-records-hub");
  await worker.applyD1Migrations("DB");
  const binding = ((await worker.getEnv()) as unknown as { DB: D1Like }).DB;
  const db = adaptD1(binding),
    independent = adaptD1(binding);
  const manifest = loadMigrationManifest(resolve(root, "migrations/d1"));
  await seedSyntheticWorkspace(db, new Date().toISOString());

  async function effects() {
    const rows: Record<string, unknown[]> = {};
    for (const table of [
      "task_context_items",
      "task_context_deliveries",
      "semantic_events",
      "audit_events",
      "outbox_records",
      "idempotency_records",
      "workspace_cursors",
      "tasks",
      "runs",
      "task_privacy",
      "task_human_grants",
      "oauth_delegations",
      "workspace_members",
      "workspace_authorization_epochs",
      "projects",
      "project_access",
    ])
      rows[table] = await db
        .prepare(`SELECT * FROM ${table} WHERE workspace_id=? ORDER BY rowid`)
        .all(FIX.workspace);
    for (const table of [
      "artifact_mutation_guards",
      "runner_mutation_guards",
      "cli_mutation_guards",
      "security_audit_position_guards",
    ])
      rows[table] = await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    return rows;
  }
  type Effects = Awaited<ReturnType<typeof effects>>;

  async function human<I>(input: I): Promise<CommandRequest<I>> {
    const principal = await loadPrincipal(db, FIX.workspace, FIX.member);
    return {
      workspaceId: FIX.workspace,
      actorHumanId: principal.humanId,
      authorizationEpoch: principal.authorizationEpoch,
      idempotencyKey: randomUlid(),
      input,
    };
  }

  async function append(taskId: string, audience: "human" | "agent" | "both", label: string) {
    return success(
      await execute<{ id: string; version: number; contentHash: string }>(
        "context.add",
        await human({ taskId, kind: "brief", audience, body: `${canary}-${label}` }),
      ),
    );
  }

  async function fixture(
    humanId = FIX.owner,
    empty = false,
    expiryModifier = "+1 hour",
    withChild = false,
  ) {
    const task = success(
      await execute<TaskRecord>(
        "task.create",
        await human({
          projectId: FIX.projectA,
          title: `${canary}-TASK`,
          priority: "P2",
        }),
      ),
    );
    const child = withChild
      ? success(
          await execute<TaskRecord>(
            "task.create",
            await human({
              projectId: FIX.projectA,
              parentTaskId: task.id,
              title: `${canary}-RETRY-CHILD`,
              priority: "P2",
            }),
          ),
        )
      : undefined;
    if (!empty) {
      await append(task.id, "both", "BOTH");
      await append(task.id, "human", "HUMAN-ONLY");
      await append(task.id, "agent", "AGENT");
    }
    const principal = await loadPrincipal(db, FIX.workspace, humanId);
    const clock = (await db
      .prepare(
        `SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS observed_at,
      strftime('%Y-%m-%dT%H:%M:%fZ','now',?) AS expires_at`,
      )
      .get(expiryModifier)) as {
      observed_at: string;
      expires_at: string;
    };
    const delegationId = randomUlid(),
      grantId = randomUlid();
    // Dormant policy and named read grant are synthetic; no creation/sharing API is enabled.
    await db
      .prepare(
        "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
      )
      .run(FIX.workspace, task.id, FIX.member, clock.observed_at);
    await db
      .prepare(
        `INSERT INTO task_human_grants
      (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at)
      VALUES (?,?,?,?,?,'read',?)`,
      )
      .run(
        FIX.workspace,
        grantId,
        task.id,
        humanId,
        principal.authorizationEpoch,
        clock.observed_at,
      );
    await db
      .prepare(
        `INSERT INTO oauth_delegations
      (workspace_id,id,human_id,client_id,resource,project_id,task_id,scopes_json,
       authorization_epoch,expires_at,created_at)
      VALUES (?,?,?,?,'https://bfb.delegated-context.test/mcp',?,?,?,?,?,?)`,
      )
      .run(
        FIX.workspace,
        delegationId,
        humanId,
        FIX.client,
        FIX.projectA,
        task.id,
        JSON.stringify(["bfb:read"]),
        principal.authorizationEpoch,
        clock.expires_at,
        clock.observed_at,
      );
    return {
      taskId: task.id,
      childTaskId: child?.id,
      humanId,
      epoch: principal.authorizationEpoch,
      role: principal.role,
      delegationId,
      grantId,
      ...clock,
    };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  function operation(f: Fixture): CommandRequest<{ taskId: string }> {
    return {
      workspaceId: FIX.workspace,
      actorHumanId: f.humanId,
      actorDelegationId: f.delegationId,
      authorizationEpoch: f.epoch,
      idempotencyKey: randomUlid(),
      now: historicalRequestTime,
      input: { taskId: f.taskId },
    };
  }
  const cursor = () =>
    db.prepare("SELECT cursor FROM workspace_cursors WHERE workspace_id=?").get(FIX.workspace);
  const readCredential = (f: Fixture) =>
    db
      .prepare("SELECT * FROM oauth_delegations WHERE workspace_id=? AND id=?")
      .get(FIX.workspace, f.delegationId);
  async function clockWitness(f: Fixture) {
    return (await db
      .prepare(
        `SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS database_now,
      julianday(expires_at)>julianday('now') AS live FROM oauth_delegations WHERE workspace_id=? AND id=?`,
      )
      .get(FIX.workspace, f.delegationId)) as { database_now: string; live: number };
  }
  async function selected(f: Fixture) {
    return (await db
      .prepare(
        `SELECT id,kind,body,version,audience,content_hash,created_at
      FROM task_context_items WHERE workspace_id=? AND task_id=? AND audience IN ('agent','both')
      ORDER BY version`,
      )
      .all(FIX.workspace, f.taskId)) as AgentContextItem[];
  }
  async function revoke(f: Fixture) {
    const now = new Date().toISOString();
    await revokeDelegation(independent, FIX.workspace, f.delegationId, now);
    assert.deepEqual(
      await independent
        .prepare("SELECT revoked_at FROM oauth_delegations WHERE workspace_id=? AND id=?")
        .get(FIX.workspace, f.delegationId),
      { revoked_at: now },
    );
  }
  async function revokeReadGrant(f: Fixture, grantId = f.grantId) {
    const now = new Date().toISOString();
    await independent
      .prepare("UPDATE task_human_grants SET revoked_at=? WHERE workspace_id=? AND id=?")
      .run(now, FIX.workspace, grantId);
    assert.deepEqual(
      await independent
        .prepare("SELECT revoked_at FROM task_human_grants WHERE workspace_id=? AND id=?")
        .get(FIX.workspace, grantId),
      { revoked_at: now },
    );
  }
  async function restoreReadGrant(f: Fixture) {
    const id = randomUlid(),
      now = new Date().toISOString();
    await independent
      .prepare(
        `INSERT INTO task_human_grants
      (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at)
      VALUES (?,?,?,?,?,'read',?)`,
      )
      .run(FIX.workspace, id, f.taskId, f.humanId, f.epoch, now);
    assert.deepEqual(
      await independent
        .prepare(
          "SELECT permission,authorization_epoch,revoked_at FROM task_human_grants WHERE workspace_id=? AND id=?",
        )
        .get(FIX.workspace, id),
      { permission: "read", authorization_epoch: f.epoch, revoked_at: null },
    );
  }

  async function metadataOnly() {
    for (const [table, field] of [
      ["semantic_events", "kind"],
      ["audit_events", "action"],
      ["outbox_records", "kind"],
    ] as const) {
      const rows = (await db
        .prepare(`SELECT payload_json FROM ${table} WHERE workspace_id=? AND ${field}=?`)
        .all(FIX.workspace, deliverDelegatedAgentContextCommand.name)) as Array<{
        payload_json: string;
      }>;
      assert(!JSON.stringify(rows).includes(canary));
      for (const row of rows) {
        const payload = JSON.parse(row.payload_json) as { result: Array<Record<string, unknown>> };
        assert(Array.isArray(payload.result));
        for (const item of payload.result)
          assert.deepEqual(Object.keys(item).sort(), ["content_hash", "id", "version"]);
      }
    }
  }

  async function committed(
    f: Fixture,
    request: CommandRequest<{ taskId: string }>,
    outcome: CommandOutcome<AgentContextItem[]>,
    before: Effects,
    expected: AgentContextItem[],
    observedAt: string,
  ) {
    const items = success(outcome),
      after = await effects();
    assert.equal(outcome.ok && outcome.replayed, false);
    bounds.maximum_context_items = Math.max(bounds.maximum_context_items, items.length);
    assert(items.length <= 64, "context delivery must retain its frozen item bound");
    assert.deepEqual(items, expected);
    assert(items.every((item) => item.audience === "agent" || item.audience === "both"));
    assert.equal(new Set(items.map((item) => item.id)).size, items.length);
    for (const table of [
      "semantic_events",
      "audit_events",
      "outbox_records",
      "idempotency_records",
    ])
      assert.equal(after[table]!.length, before[table]!.length + 1);
    assert.equal(
      after.task_context_deliveries!.length,
      before.task_context_deliveries!.length + items.length,
    );
    assert.deepEqual(after.workspace_cursors, [
      {
        workspace_id: FIX.workspace,
        cursor: (before.workspace_cursors![0] as { cursor: number }).cursor + 1,
      },
    ]);
    for (const table of Object.keys(before))
      if (
        ![
          "semantic_events",
          "audit_events",
          "outbox_records",
          "idempotency_records",
          "task_context_deliveries",
          "workspace_cursors",
        ].includes(table)
      )
        assert.deepEqual(after[table], before[table]);
    const deliveries = await db
      .prepare(
        `SELECT context_version,content_hash,run_id,delegation_id,client_id,delivered_at
      FROM task_context_deliveries WHERE workspace_id=? AND task_id=? ORDER BY context_version`,
      )
      .all(FIX.workspace, f.taskId);
    assert.deepEqual(
      deliveries,
      items.map((item) => ({
        context_version: item.version,
        content_hash: item.content_hash,
        run_id: null,
        delegation_id: f.delegationId,
        client_id: FIX.client,
        delivered_at: observedAt,
      })),
    );
    for (const [table, field] of [
      ["semantic_events", "kind"],
      ["audit_events", "action"],
      ["outbox_records", "kind"],
    ] as const)
      assert.deepEqual(
        await db
          .prepare(
            `SELECT created_at FROM ${table} WHERE workspace_id=? AND ${field}=? ORDER BY rowid DESC LIMIT 1`,
          )
          .get(FIX.workspace, deliverDelegatedAgentContextCommand.name),
        { created_at: observedAt },
      );
    assert.deepEqual(
      await db
        .prepare(
          "SELECT created_at FROM idempotency_records WHERE workspace_id=? AND idempotency_key=?",
        )
        .get(FIX.workspace, request.idempotencyKey),
      { created_at: observedAt },
    );
    await metadataOnly();
    return items;
  }

  await check(
    "real_d1_delayed_read_only_roles_preserve_delivery_and_historical_retry",
    async () => {
      for (const [role, humanId] of [
        ["owner", FIX.owner],
        ["member", FIX.member],
        ["reviewer", FIX.reviewer],
      ] as const) {
        const f = await fixture(humanId, false, "+1 hour", role === "owner"),
          request = operation(f),
          expected = await selected(f),
          before = await effects(),
          original = await readCredential(f);
        assert.equal(f.role, role);
        let flushAt = "";
        const guarded = interleave(binding, {
          beforeBatch: async () => {
            assert.equal((await clockWitness(f)).live, 1);
            await delay(250);
            const flush = await clockWitness(f);
            assert.equal(flush.live, 1);
            flushAt = flush.database_now;
            assert.deepEqual(await readCredential(f), original);
          },
        });
        const started = Date.now();
        const outcome = await new WorkspaceHub(guarded.db).execute(
          deliverDelegatedAgentContextCommand,
          request,
        );
        assert(guarded.state.selectionReached && guarded.state.batchReached);
        assert(Date.parse(guarded.state.observedAt) >= started);
        assert(Date.parse(flushAt) - Date.parse(guarded.state.observedAt) >= 200);
        const items = await committed(
          f,
          request,
          outcome,
          before,
          expected,
          guarded.state.observedAt,
        );
        if (role === "owner") {
          await append(f.taskId, "agent", "APPENDED");
          const afterAppend = await effects();
          const retry = await execute<AgentContextItem[]>(
            deliverDelegatedAgentContextCommand.name,
            request,
            "b",
          );
          assert(retry.ok);
          assert.equal(retry.replayed, true);
          assert.deepEqual(retry.result, items);
          assert.deepEqual(await effects(), afterAppend);
          assert(f.childTaskId);
          const changed = await execute(deliverDelegatedAgentContextCommand.name, {
            ...request,
            input: { taskId: f.childTaskId },
          });
          assert.deepEqual(changed, {
            ok: false,
            error: {
              code: "request_rejected",
              message: "operation input differs from its original request",
            },
          });
          assert.deepEqual(await effects(), afterAppend);
        }
      }
    },
  );

  await check("real_d1_authorized_empty_context_is_a_delivery_scope_not_denial", async () => {
    const f = await fixture(FIX.owner, true),
      request = operation(f),
      before = await effects();
    const guarded = interleave(binding, {});
    const started = Date.now();
    const outcome = await new WorkspaceHub(guarded.db).execute(
      deliverDelegatedAgentContextCommand,
      request,
    );
    assert(guarded.state.selectionReached && guarded.state.batchReached);
    assert(Date.parse(guarded.state.observedAt) >= started);
    await committed(f, request, outcome, before, [], guarded.state.observedAt);
    const after = await effects();
    const retry = await execute<AgentContextItem[]>(
      deliverDelegatedAgentContextCommand.name,
      request,
      "b",
    );
    assert(retry.ok && retry.replayed);
    assert.deepEqual(retry.result, []);
    assert.deepEqual(await effects(), after);
  });

  await check("real_d1_production_revocation_before_context_selection_withholds_body", async () => {
    const f = await fixture(),
      request = operation(f),
      originalCursor = await cursor();
    let before: Effects | undefined,
      mutationApplied = false;
    const guarded = interleave(binding, {
      beforeSelection: async () => {
        await revoke(f);
        assert.deepEqual(await cursor(), originalCursor);
        mutationApplied = true;
        before = await effects();
      },
    });
    const outcome = await new WorkspaceHub(guarded.db).execute(
      deliverDelegatedAgentContextCommand,
      request,
    );
    assert(guarded.state.selectionReached && mutationApplied);
    assert.deepEqual(outcome, rejectedSelection);
    assert.deepEqual(await effects(), before);
  });

  await check("real_d1_production_revocation_before_empty_context_batch_rolls_back", async () => {
    const f = await fixture(FIX.owner, true),
      request = operation(f),
      originalCursor = await cursor();
    let before: Effects | undefined,
      mutationApplied = false;
    const guarded = interleave(binding, {
      beforeBatch: async () => {
        await revoke(f);
        assert.deepEqual(await cursor(), originalCursor);
        mutationApplied = true;
        before = await effects();
      },
    });
    const outcome = await new WorkspaceHub(guarded.db).execute(
      deliverDelegatedAgentContextCommand,
      request,
    );
    assert(guarded.state.selectionReached && guarded.state.batchReached && mutationApplied);
    assert.deepEqual(outcome, rejectedCommit);
    assert.deepEqual(await effects(), before);
  });

  await check("real_d1_cached_context_rechecks_revocation_even_for_empty_history", async () => {
    for (const empty of [false, true]) {
      const f = await fixture(FIX.owner, empty),
        request = operation(f);
      const original = success(
        await execute<AgentContextItem[]>(deliverDelegatedAgentContextCommand.name, request),
      );
      assert.equal(original.length, empty ? 0 : 2);
      const originalCursor = await cursor();
      let before: Effects | undefined,
        mutationApplied = false;
      const guarded = interleave(binding, {
        afterCache: async () => {
          await revoke(f);
          assert.deepEqual(await cursor(), originalCursor);
          mutationApplied = true;
          before = await effects();
        },
      });
      const outcome = await new WorkspaceHub(guarded.db).execute(
        deliverDelegatedAgentContextCommand,
        request,
      );
      assert(guarded.state.cacheReached && mutationApplied);
      assert.deepEqual(outcome, rejectedSelection);
      assert.deepEqual(await effects(), before);
    }
  });

  const losses = ["epoch", "read_scope", "project", "task_boundary", "private_read"] as const;
  for (const loss of losses) {
    await check(`real_d1_context_${loss}_loss_before_batch_rolls_back`, async () => {
      const f = await fixture(FIX.owner, loss === "private_read"),
        request = operation(f);
      const unrelated =
        loss === "task_boundary"
          ? success(
              await execute<TaskRecord>(
                "task.create",
                await human({
                  projectId: FIX.projectA,
                  title: `${canary}-UNRELATED`,
                  priority: "P2",
                }),
              ),
            )
          : undefined;
      const originalCursor = await cursor();
      let before: Effects | undefined,
        mutationApplied = false;
      const guarded = interleave(binding, {
        beforeBatch: async () => {
          if (loss === "epoch") {
            assert.equal(await bumpMemberEpoch(independent, FIX.workspace, f.humanId), f.epoch + 1);
            assert.equal(
              (await loadPrincipal(independent, FIX.workspace, f.humanId)).authorizationEpoch,
              f.epoch + 1,
            );
          }
          if (loss === "read_scope") {
            const scopes = JSON.stringify(["bfb:task:write"]);
            await independent
              .prepare("UPDATE oauth_delegations SET scopes_json=? WHERE workspace_id=? AND id=?")
              .run(scopes, FIX.workspace, f.delegationId);
            assert.deepEqual(
              await independent
                .prepare("SELECT scopes_json FROM oauth_delegations WHERE workspace_id=? AND id=?")
                .get(FIX.workspace, f.delegationId),
              { scopes_json: scopes },
            );
          }
          if (loss === "project") {
            await independent
              .prepare("UPDATE projects SET access_mode='restricted' WHERE workspace_id=? AND id=?")
              .run(FIX.workspace, FIX.projectA);
            await independent
              .prepare(
                "DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?",
              )
              .run(FIX.workspace, FIX.projectA, f.humanId);
            assert(
              !(await loadPrincipal(independent, FIX.workspace, f.humanId)).projectIds.includes(
                FIX.projectA,
              ),
            );
          }
          if (loss === "task_boundary") {
            assert(unrelated && unrelated.id !== f.taskId);
            assert.deepEqual(
              await independent
                .prepare(
                  "SELECT project_id,parent_task_id FROM tasks WHERE workspace_id=? AND id=?",
                )
                .get(FIX.workspace, unrelated.id),
              { project_id: FIX.projectA, parent_task_id: null },
            );
            await independent
              .prepare("UPDATE oauth_delegations SET task_id=? WHERE workspace_id=? AND id=?")
              .run(unrelated.id, FIX.workspace, f.delegationId);
            assert.deepEqual(
              await independent
                .prepare("SELECT task_id FROM oauth_delegations WHERE workspace_id=? AND id=?")
                .get(FIX.workspace, f.delegationId),
              { task_id: unrelated.id },
            );
          }
          if (loss === "private_read") await revokeReadGrant(f);
          assert.deepEqual(await cursor(), originalCursor);
          mutationApplied = true;
          before = await effects();
        },
      });
      try {
        const outcome = await new WorkspaceHub(guarded.db).execute(
          deliverDelegatedAgentContextCommand,
          request,
        );
        assert(guarded.state.selectionReached && guarded.state.batchReached && mutationApplied);
        assert.deepEqual(outcome, rejectedCommit);
        assert.deepEqual(await effects(), before);
        if (loss === "private_read") {
          await restoreReadGrant(f);
          const restored = await effects();
          const retry = interleave(binding, {});
          const recovered = await new WorkspaceHub(retry.db).execute(
            deliverDelegatedAgentContextCommand,
            request,
          );
          await committed(f, request, recovered, restored, [], retry.state.observedAt);
          const after = await effects();
          const exact = await execute<AgentContextItem[]>(
            deliverDelegatedAgentContextCommand.name,
            request,
            "b",
          );
          assert(exact.ok && exact.replayed);
          assert.deepEqual(exact.result, []);
          assert.deepEqual(await effects(), after);
        }
      } finally {
        if (loss === "project")
          await independent
            .prepare("UPDATE projects SET access_mode='workspace' WHERE workspace_id=? AND id=?")
            .run(FIX.workspace, FIX.projectA);
      }
    });
  }

  for (const phase of ["selection", "batch"] as const) {
    await check(`real_d1_unchanged_natural_expiry_at_context_${phase}`, async () => {
      const f = await fixture(FIX.owner, false, "+15 seconds"),
        request = operation(f),
        original = await readCredential(f),
        before = await effects();
      let arrivalLive = false,
        flushAt = "";
      const expire = async () => {
        arrivalLive = (await clockWitness(f)).live === 1;
        assert(arrivalLive, "unchanged credential must reach the boundary while valid");
        const deadline = performance.now() + 20_000;
        while ((await clockWitness(f)).live === 1) {
          assert(performance.now() < deadline, "unchanged credential must expire in bounded time");
          await delay(100);
        }
        const flush = await clockWitness(f);
        assert.equal(flush.live, 0);
        flushAt = flush.database_now;
        assert.deepEqual(await readCredential(f), original);
        assert.deepEqual(await effects(), before);
      };
      const guarded = interleave(
        binding,
        phase === "selection" ? { beforeSelection: expire } : { beforeBatch: expire },
      );
      const outcome = await new WorkspaceHub(guarded.db).execute(
        deliverDelegatedAgentContextCommand,
        request,
      );
      assert(guarded.state.selectionReached && arrivalLive);
      if (phase === "batch") {
        assert(guarded.state.batchReached);
        assert(Date.parse(guarded.state.observedAt) < Date.parse(f.expires_at));
      }
      assert(Date.parse(flushAt) >= Date.parse(f.expires_at));
      assert.deepEqual(outcome, phase === "selection" ? rejectedSelection : rejectedCommit);
      assert.deepEqual(await readCredential(f), original);
      assert.deepEqual(await effects(), before);
    });
  }

  console.log(
    JSON.stringify({
      schema_version: 1,
      stage: "delegated_context_delivery",
      migration_head: manifest.migration_head,
      checks,
      failures,
      ...bounds,
      outcome: failures.length ? "failed" : "passed",
      limits: [
        "synthetic dormant privacy and read grants only; private creation remains disabled",
        "real D1/domain/Hub proof, not mounted OAuth MCP post-Hub response delivery",
        "no run/execution, provider, runner, lease or complete private activation claim",
      ],
    }),
  );
  assert.equal(failures.length, 0, "delegated context D1 checks failed");
  console.log("C11_DELEGATED_CONTEXT_D1_OK");
} finally {
  await server.close();
}
