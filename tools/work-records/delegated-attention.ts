// ABOUTME: Proves delegated attention committing authority on disposable real D1 and production Hub commands.
// ABOUTME: Synthetic immutable waiter context and unchanged credential expiry never operate providers or runners.

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
  loadPrincipal,
  randomUlid,
  requestDelegatedAttentionCommand,
  revokeDelegation,
  seedSyntheticWorkspace,
  type AttentionRecord,
  type CommandOutcome,
  type CommandRequest,
  type RequestDelegatedAttentionInput,
  type TaskRecord,
} from "@bfb/domain";
import { createTestHarness } from "wrangler";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const origin = "https://bfb.delegated-attention.test";
const question = "SYNTHETIC-C11-DELEGATED-ATTENTION-QUESTION";
const taskCanary = "SYNTHETIC-C11-DELEGATED-ATTENTION-TASK";
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
const bounds = { maximum_bindings: 0, maximum_statement_bytes: 0, maximum_batch_statements: 0 };
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
    const message =
      first?.includes(question) || first?.includes(taskCanary)
        ? "synthetic content omitted"
        : (first ?? "assertion failed").slice(0, 160);
    failures.push({ check: name, message });
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

function atBatch(
  binding: D1Like,
  before: () => Promise<void>,
): {
  db: SqlDatabase;
  reached: () => boolean;
  observedAt: () => string;
  observationAt: () => string;
} {
  let reached = false,
    observedAt = "",
    observationAt = "";
  const db = adaptD1({
    prepare(sql) {
      const bytes = Buffer.byteLength(sql);
      bounds.maximum_statement_bytes = Math.max(bounds.maximum_statement_bytes, bytes);
      assert(bytes <= 100_000, "attention SQL must fit D1's statement bound");
      const native = binding.prepare(sql);
      const statement: D1StatementLike = {
        bind(...parameters) {
          bounds.maximum_bindings = Math.max(bounds.maximum_bindings, parameters.length);
          assert(parameters.length <= 100, "attention SQL must fit D1's parameter bound");
          if (sql.includes("INSERT INTO attention_requests")) {
            assert.equal(typeof parameters.at(-1), "string");
            observedAt = parameters.at(-1) as string;
          }
          if (sql.includes("INSERT INTO attention_observations")) {
            assert.equal(typeof parameters.at(-1), "string");
            observationAt = parameters.at(-1) as string;
          }
          // The real batch receives native bound statements, never adapter wrappers.
          return native.bind(...parameters);
        },
        first: (column) => native.first(column),
        all: () => native.all(),
        run: () => native.run(),
      };
      return statement;
    },
    async batch(statements) {
      assert.equal(reached, false, "one attention command must flush one atomic batch");
      reached = true;
      bounds.maximum_batch_statements = Math.max(
        bounds.maximum_batch_statements,
        statements.length,
      );
      assert(statements.length <= 32, "attention command must retain a bounded batch");
      await before();
      return binding.batch(statements);
    },
  });
  return {
    db,
    reached: () => reached,
    observedAt: () => observedAt,
    observationAt: () => observationAt,
  };
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
      "attention_requests",
      "attention_observations",
      "semantic_events",
      "audit_events",
      "outbox_records",
      "idempotency_records",
      "workspace_cursors",
      "tasks",
      "runs",
      "run_executions",
      "execution_assignments",
      "runners",
      "runner_project_grants",
      "checkout_leases",
      "result_submissions",
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
      actorHumanId: FIX.member,
      authorizationEpoch: principal.authorizationEpoch,
      idempotencyKey: randomUlid(),
      input,
    };
  }

  async function fixture(humanId = FIX.owner, expiryModifier = "+1 hour") {
    const task = success(
      await execute<TaskRecord>(
        "task.create",
        await human({
          projectId: FIX.projectA,
          title: taskCanary,
          priority: "P2",
        }),
      ),
    );
    const run = success(
      await execute<{ run: { id: string } }>(
        "run.create",
        await human({
          taskId: task.id,
          expectedTaskVersion: 1,
          agentProfileId: FIX.profileCodex,
          workspacePolicyVersion: 1,
          projectPolicyVersion: 1,
          repositoryConfigVersion: 1,
          agentProfileVersion: 1,
        }),
      ),
    );
    const execution = success(
      await execute<{ id: string }>("execution.create", await human({ runId: run.run.id })),
    );
    const requester = await loadPrincipal(db, FIX.workspace, FIX.member);
    const runnerId = randomUlid(),
      thumbprint = `synthetic-attention-key-${runnerId}`,
      assignedAt = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO runners
      (workspace_id,id,owner_human_id,device_label,public_key_json,key_thumbprint,
       authorization_epoch,grant_epoch,token_epoch,enrolled_at,revoked_at)
      VALUES (?,?,?,'Synthetic attention fixture Mac','{}',?,1,1,1,?,NULL)`,
      )
      .run(FIX.workspace, runnerId, FIX.member, thumbprint, assignedAt);
    await db
      .prepare(
        "INSERT INTO runner_project_grants (workspace_id,runner_id,project_id) VALUES (?,?,?)",
      )
      .run(FIX.workspace, runnerId, FIX.projectA);
    // Immutable synthetic waiter context only; no launch, lease, acknowledgement or process is installed.
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
        execution.id,
        run.run.id,
        task.id,
        FIX.projectA,
        runnerId,
        randomUlid(),
        `sha256:${"a".repeat(64)}`,
        FIX.member,
        requester.authorizationEpoch,
        thumbprint,
        assignedAt,
      );
    assert.deepEqual(
      await db
        .prepare(
          `SELECT assignment.run_id,assignment.task_id,assignment.project_id,assignment.requesting_human_id,
        assignment.assignment_generation,execution.state
      FROM execution_assignments AS assignment
      JOIN run_executions AS execution ON execution.workspace_id=assignment.workspace_id
        AND execution.run_id=assignment.run_id AND execution.id=assignment.execution_id
      WHERE assignment.workspace_id=? AND assignment.execution_id=?`,
        )
        .get(FIX.workspace, execution.id),
      {
        run_id: run.run.id,
        task_id: task.id,
        project_id: FIX.projectA,
        requesting_human_id: FIX.member,
        assignment_generation: 1,
        state: "queued",
      },
    );
    const principal = await loadPrincipal(db, FIX.workspace, humanId);
    const clock = (await db
      .prepare(
        `SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS observed_at,
        strftime('%Y-%m-%dT%H:%M:%fZ','now',?) AS expires_at`,
      )
      .get(expiryModifier)) as { observed_at: string; expires_at: string };
    const delegationId = randomUlid(),
      grantId = randomUlid();
    // Dormant private policy is synthetic; no private creation or sharing API is enabled.
    await db
      .prepare(
        "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
      )
      .run(FIX.workspace, task.id, FIX.member, clock.observed_at);
    await db
      .prepare(
        `INSERT INTO task_human_grants
      (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at)
      VALUES (?,?,?,?,?,'contribute',?)`,
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
      VALUES (?,?,?,?,'https://bfb.delegated-attention.test/mcp',?,?,?,?,?,?)`,
      )
      .run(
        FIX.workspace,
        delegationId,
        humanId,
        FIX.client,
        FIX.projectA,
        task.id,
        JSON.stringify(["bfb:task:write"]),
        principal.authorizationEpoch,
        clock.expires_at,
        clock.observed_at,
      );
    return {
      taskId: task.id,
      runId: run.run.id,
      executionId: execution.id,
      humanId,
      epoch: principal.authorizationEpoch,
      role: principal.role,
      delegationId,
      grantId,
      ...clock,
    };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  function operation(f: Fixture, kind: "clarification" | "review" = "clarification") {
    const input: RequestDelegatedAttentionInput = {
      runId: f.runId,
      kind,
      question,
      blocking: true,
    };
    return {
      workspaceId: FIX.workspace,
      actorHumanId: f.humanId,
      actorDelegationId: f.delegationId,
      authorizationEpoch: f.epoch,
      idempotencyKey: randomUlid(),
      now: historicalRequestTime,
      input,
    };
  }

  const readCredential = (f: Fixture) =>
    db
      .prepare("SELECT * FROM oauth_delegations WHERE workspace_id=? AND id=?")
      .get(FIX.workspace, f.delegationId);
  const readCursor = () =>
    db.prepare("SELECT cursor FROM workspace_cursors WHERE workspace_id=?").get(FIX.workspace);
  async function clockWitness(f: Fixture) {
    return (await db
      .prepare(
        `SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS database_now,
        julianday(expires_at)>julianday('now') AS live
      FROM oauth_delegations WHERE workspace_id=? AND id=?`,
      )
      .get(FIX.workspace, f.delegationId)) as { database_now: string; live: number };
  }

  async function metadataOnly() {
    for (const [table, column] of [
      ["semantic_events", "kind"],
      ["audit_events", "action"],
      ["outbox_records", "kind"],
    ] as const) {
      const rows = (await db
        .prepare(`SELECT payload_json FROM ${table} WHERE workspace_id=? AND ${column}=?`)
        .all(FIX.workspace, requestDelegatedAttentionCommand.name)) as Array<{
        payload_json: string;
      }>;
      const json = JSON.stringify(rows);
      assert(!json.includes(question));
      assert(!json.includes(taskCanary));
      for (const row of rows) {
        const payload = JSON.parse(row.payload_json) as {
          input: { questionChars: number };
          result: Record<string, unknown>;
        };
        assert.equal(payload.input.questionChars, [...question].length);
        assert(!("question" in payload.input));
        assert(!("question" in payload.result));
        assert(!("answer" in payload.result));
      }
    }
  }

  async function committed(f: Fixture, outcome: CommandOutcome<AttentionRecord>, before: Effects) {
    const record = success(outcome),
      after = await effects();
    assert.equal(outcome.ok && outcome.replayed, false);
    assert.equal(record.task_id, f.taskId);
    assert.equal(record.project_id, FIX.projectA);
    assert.equal(record.run_id, f.runId);
    assert.equal(record.run_execution_id, f.executionId);
    assert.equal(record.assignment_generation, 1);
    assert.equal(record.question, question);
    for (const table of [
      "attention_requests",
      "attention_observations",
      "semantic_events",
      "audit_events",
      "outbox_records",
      "idempotency_records",
    ])
      assert.equal(after[table]!.length, before[table]!.length + 1);
    assert.deepEqual(after.workspace_cursors, [
      {
        workspace_id: FIX.workspace,
        cursor: (before.workspace_cursors![0] as { cursor: number }).cursor + 1,
      },
    ]);
    for (const table of Object.keys(before)) {
      if (
        ![
          "attention_requests",
          "attention_observations",
          "semantic_events",
          "audit_events",
          "outbox_records",
          "idempotency_records",
          "workspace_cursors",
        ].includes(table)
      )
        assert.deepEqual(after[table], before[table]);
    }
    assert.deepEqual(
      await db
        .prepare(
          `SELECT observed_kind,actor_type,actor_id,occurred_at FROM attention_observations
      WHERE workspace_id=? AND attention_id=?`,
        )
        .get(FIX.workspace, record.id),
      {
        observed_kind: "requested",
        actor_type: "human",
        actor_id: f.humanId,
        occurred_at: record.requested_at,
      },
    );
    await metadataOnly();
    return record;
  }

  for (const [role, humanId] of [
    ["owner", FIX.owner],
    ["member", FIX.member],
    ["reviewer", FIX.reviewer],
  ] as const) {
    await check(`real_d1_delayed_${role}_write_only_attention_control`, async () => {
      const f = await fixture(humanId),
        request = operation(f),
        original = await readCredential(f),
        before = await effects();
      assert.equal(f.role, role);
      const guarded = atBatch(binding, async () => {
        assert.equal((await clockWitness(f)).live, 1);
        await delay(250);
        assert.equal((await clockWitness(f)).live, 1);
        assert.deepEqual(await readCredential(f), original);
      });
      const started = Date.now();
      const outcome = await new WorkspaceHub(guarded.db).execute(
        requestDelegatedAttentionCommand,
        request,
      );
      assert(guarded.reached());
      const record = await committed(f, outcome, before);
      assert(Date.parse(guarded.observedAt()) >= started);
      assert.equal(record.requested_at, guarded.observedAt());
      assert.equal(guarded.observationAt(), guarded.observedAt());
      if (role === "owner") {
        const after = await effects();
        const retry = await execute<AttentionRecord>(
          requestDelegatedAttentionCommand.name,
          request,
          "b",
        );
        assert(retry.ok);
        assert.equal(retry.replayed, true);
        assert.deepEqual(retry.result, record);
        assert.deepEqual(await effects(), after);
        const changed = await execute(requestDelegatedAttentionCommand.name, {
          ...request,
          input: { ...request.input, blocking: false },
        });
        assert.equal(changed.ok, false);
        assert.equal(!changed.ok && changed.error.code, "request_rejected");
        assert.deepEqual(await effects(), after);
      }
    });
  }

  await check("real_d1_submitted_run_accepts_delegated_review_question", async () => {
    const f = await fixture();
    success(
      await execute(
        "result.submit",
        await human({
          runId: f.runId,
          summary: "Synthetic submitted review fixture",
          evidenceRefs: [],
        }),
      ),
    );
    assert.deepEqual(
      await db
        .prepare("SELECT result_state FROM runs WHERE workspace_id=? AND id=?")
        .get(FIX.workspace, f.runId),
      { result_state: "submitted" },
    );
    const before = await effects();
    const outcome = await execute<AttentionRecord>(
      requestDelegatedAttentionCommand.name,
      operation(f, "review"),
    );
    const record = await committed(f, outcome, before);
    assert.equal(record.kind, "review");
    assert.equal(record.required_role, "reviewer");
  });

  await check(
    "real_d1_ended_immutable_assignment_remains_waiter_context_without_lease",
    async () => {
      const f = await fixture();
      success(
        await execute(
          "execution.transition",
          await human({
            runId: f.runId,
            executionId: f.executionId,
            expectedVersion: 1,
            state: "ended",
            endReason: "process_exit",
          }),
        ),
      );
      assert.deepEqual(
        await db
          .prepare("SELECT state FROM run_executions WHERE workspace_id=? AND id=?")
          .get(FIX.workspace, f.executionId),
        { state: "ended" },
      );
      assert.deepEqual(
        await db
          .prepare(
            "SELECT COUNT(*) AS n FROM checkout_leases WHERE workspace_id=? AND execution_id=?",
          )
          .get(FIX.workspace, f.executionId),
        { n: 0 },
      );
      const before = await effects();
      const outcome = await execute<AttentionRecord>(
        requestDelegatedAttentionCommand.name,
        operation(f),
      );
      await committed(f, outcome, before);
    },
  );

  async function replaceContribution(f: Fixture, permission: "read" | "contribute", oldId: string) {
    const now = new Date().toISOString(),
      id = randomUlid();
    await independent
      .prepare("UPDATE task_human_grants SET revoked_at=? WHERE workspace_id=? AND id=?")
      .run(now, FIX.workspace, oldId);
    await independent
      .prepare(
        `INSERT INTO task_human_grants
      (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at)
      VALUES (?,?,?,?,?,?,?)`,
      )
      .run(FIX.workspace, id, f.taskId, f.humanId, f.epoch, permission, now);
    assert.deepEqual(
      await independent
        .prepare(
          "SELECT permission,authorization_epoch,revoked_at FROM task_human_grants WHERE workspace_id=? AND id=?",
        )
        .get(FIX.workspace, id),
      { permission, authorization_epoch: f.epoch, revoked_at: null },
    );
    assert.deepEqual(
      await independent
        .prepare("SELECT revoked_at FROM task_human_grants WHERE workspace_id=? AND id=?")
        .get(FIX.workspace, oldId),
      { revoked_at: now },
    );
    return id;
  }

  const losses = [
    "revocation",
    "epoch",
    "contribution",
    "write_scope",
    "project",
    "boundary",
  ] as const;
  type Loss = (typeof losses)[number];
  async function loseAuthority(f: Fixture, loss: Loss, unrelatedTaskId?: string) {
    const now = new Date().toISOString();
    if (loss === "revocation") {
      await revokeDelegation(independent, FIX.workspace, f.delegationId, now);
      assert.deepEqual(
        await independent
          .prepare("SELECT revoked_at FROM oauth_delegations WHERE workspace_id=? AND id=?")
          .get(FIX.workspace, f.delegationId),
        { revoked_at: now },
      );
    }
    if (loss === "epoch") {
      assert.equal(await bumpMemberEpoch(independent, FIX.workspace, f.humanId), f.epoch + 1);
      assert.equal(
        (await loadPrincipal(independent, FIX.workspace, f.humanId)).authorizationEpoch,
        f.epoch + 1,
      );
    }
    if (loss === "contribution") await replaceContribution(f, "read", f.grantId);
    if (loss === "write_scope") {
      const scopes = JSON.stringify(["bfb:read"]);
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
        .prepare("DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?")
        .run(FIX.workspace, FIX.projectA, f.humanId);
      assert(
        !(await loadPrincipal(independent, FIX.workspace, f.humanId)).projectIds.includes(
          FIX.projectA,
        ),
      );
    }
    if (loss === "boundary") {
      assert(unrelatedTaskId && unrelatedTaskId !== f.taskId);
      assert.deepEqual(
        await independent
          .prepare("SELECT project_id,parent_task_id FROM tasks WHERE workspace_id=? AND id=?")
          .get(FIX.workspace, unrelatedTaskId),
        { project_id: FIX.projectA, parent_task_id: null },
      );
      await independent
        .prepare("UPDATE oauth_delegations SET task_id=? WHERE workspace_id=? AND id=?")
        .run(unrelatedTaskId, FIX.workspace, f.delegationId);
      assert.deepEqual(
        await independent
          .prepare("SELECT task_id FROM oauth_delegations WHERE workspace_id=? AND id=?")
          .get(FIX.workspace, f.delegationId),
        { task_id: unrelatedTaskId },
      );
    }
  }

  for (const loss of losses) {
    await check(`real_d1_attention_${loss}_before_batch_rolls_back_all_effects`, async () => {
      const f = await fixture();
      const unrelated =
        loss === "boundary"
          ? success(
              await execute<TaskRecord>(
                "task.create",
                await human({
                  projectId: FIX.projectA,
                  title: "Synthetic unrelated attention boundary",
                  priority: "P2",
                }),
              ),
            )
          : undefined;
      let before: Effects | undefined,
        mutationApplied = false;
      const cursor = await readCursor();
      const guarded = atBatch(binding, async () => {
        await loseAuthority(f, loss, unrelated?.id);
        assert.deepEqual(await readCursor(), cursor);
        mutationApplied = true;
        before = await effects();
      });
      try {
        const outcome = await new WorkspaceHub(guarded.db).execute(
          requestDelegatedAttentionCommand,
          operation(f),
        );
        assert(guarded.reached());
        assert(mutationApplied, "independent valid authority mutation must complete");
        assert.deepEqual(outcome, rejectedCommit);
        assert.deepEqual(await effects(), before);
      } finally {
        if (loss === "project")
          await independent
            .prepare("UPDATE projects SET access_mode='workspace' WHERE workspace_id=? AND id=?")
            .run(FIX.workspace, FIX.projectA);
      }
    });
  }

  await check(
    "real_d1_failed_attention_key_recovers_with_new_valid_contribution_grant",
    async () => {
      const f = await fixture(),
        request = operation(f),
        cursor = await readCursor();
      let readGrant = "",
        before: Effects | undefined,
        mutationApplied = false;
      const guarded = atBatch(binding, async () => {
        readGrant = await replaceContribution(f, "read", f.grantId);
        assert.deepEqual(await readCursor(), cursor);
        mutationApplied = true;
        before = await effects();
      });
      const failed = await new WorkspaceHub(guarded.db).execute(
        requestDelegatedAttentionCommand,
        request,
      );
      assert(guarded.reached());
      assert(mutationApplied);
      assert.deepEqual(failed, rejectedCommit);
      assert.deepEqual(await effects(), before);
      await replaceContribution(f, "contribute", readGrant);
      const restored = await effects();
      const retried = await execute<AttentionRecord>(
        requestDelegatedAttentionCommand.name,
        request,
      );
      const record = await committed(f, retried, restored);
      const after = await effects();
      const exact = await execute<AttentionRecord>(
        requestDelegatedAttentionCommand.name,
        request,
        "b",
      );
      assert(exact.ok);
      assert.equal(exact.replayed, true);
      assert.deepEqual(exact.result, record);
      assert.deepEqual(await effects(), after);
    },
  );

  for (const mode of ["unexpired", "natural_expiry"] as const) {
    await check(`real_d1_unchanged_delegation_${mode}_at_attention_batch`, async () => {
      const f = await fixture(FIX.owner, mode === "natural_expiry" ? "+15 seconds" : "+1 hour"),
        request = operation(f),
        original = await readCredential(f),
        before = await effects();
      let arrivalLive = false,
        flushLive = false,
        flushAt = "";
      const guarded = atBatch(binding, async () => {
        arrivalLive = (await clockWitness(f)).live === 1;
        assert(arrivalLive, "unchanged credential must reach the batch while valid");
        assert(Date.parse(guarded.observedAt()) < Date.parse(f.expires_at));
        if (mode === "natural_expiry") {
          const deadline = performance.now() + 20_000;
          while ((await clockWitness(f)).live === 1) {
            assert(
              performance.now() < deadline,
              "unchanged credential must expire in bounded time",
            );
            await delay(100);
          }
        } else await delay(250);
        const flush = await clockWitness(f);
        flushLive = flush.live === 1;
        flushAt = flush.database_now;
        assert.equal(flushLive, mode === "unexpired");
        assert.deepEqual(await readCredential(f), original);
      });
      const started = Date.now();
      const outcome = await new WorkspaceHub(guarded.db).execute(
        requestDelegatedAttentionCommand,
        request,
      );
      assert(guarded.reached());
      assert(arrivalLive);
      assert(Date.parse(guarded.observedAt()) >= started);
      assert.equal(guarded.observationAt(), guarded.observedAt());
      assert.deepEqual(await readCredential(f), original);
      if (mode === "natural_expiry") {
        assert(Date.parse(flushAt) >= Date.parse(f.expires_at));
        assert.deepEqual(outcome, rejectedCommit);
        assert.deepEqual(await effects(), before);
      } else {
        const record = await committed(f, outcome, before);
        assert.equal(record.requested_at, guarded.observedAt());
        assert(Date.parse(flushAt) - Date.parse(guarded.observedAt()) >= 200);
        assert.deepEqual(
          await db
            .prepare("SELECT requested_at FROM attention_requests WHERE workspace_id=? AND id=?")
            .get(FIX.workspace, record.id),
          { requested_at: guarded.observedAt() },
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
              .get(FIX.workspace, requestDelegatedAttentionCommand.name),
            { created_at: guarded.observedAt() },
          );
        assert.deepEqual(
          await db
            .prepare(
              "SELECT created_at FROM idempotency_records WHERE workspace_id=? AND idempotency_key=?",
            )
            .get(FIX.workspace, request.idempotencyKey),
          { created_at: guarded.observedAt() },
        );
      }
    });
  }

  console.log(
    JSON.stringify({
      schema_version: 1,
      stage: "delegated_attention_commit_authority",
      migration_head: manifest.migration_head,
      checks,
      failures,
      ...bounds,
      outcome: failures.length ? "failed" : "passed",
      limits: [
        "synthetic dormant privacy and immutable assignment fixtures only",
        "real D1/domain/Hub proof, not authenticated HTTP OAuth or provider operation",
        "command-local guards, not every later statement or cached/read response delivery",
        "no active/latest assignment, requester equality, runner/lease or private activation claim",
      ],
    }),
  );
  assert.equal(failures.length, 0, "delegated attention D1 checks failed");
  console.log("C11_DELEGATED_ATTENTION_D1_OK");
} finally {
  await server.close();
}
