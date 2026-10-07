// ABOUTME: Exercises human detail and cached business delivery over disposable native D1.
// ABOUTME: Mounted pre-authenticated API reads retain current authority without running providers or runners.

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
  answerAttentionCommand,
  bumpMemberEpoch,
  createTaskCommand,
  loadPrincipal,
  mcpResource,
  randomUlid,
  requestDelegatedAttentionCommand,
  resolveAttentionCommand,
  revokeDelegation,
  seedSyntheticWorkspace,
  updateTaskCommand,
  type AttentionObservation,
  type AttentionRecord,
  type CommandOutcome,
  type CommandRequest,
  type TaskRecord,
} from "@bfb/domain";
import { createTestHarness } from "wrangler";
import { handleAttentionApi } from "../../apps/control-worker/dist/api/attention.js";
import type { BrowserPrincipal } from "../../apps/control-worker/dist/auth/session.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const origin = "https://bfb.example.test";
const canary = "SYNTHETIC-C11-HUMAN-DETAIL-CACHE";
const question = `${canary}-QUESTION`;
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
const bounds = { maximum_bindings: 0, maximum_statement_bytes: 0 };
const detailSeams: Array<{
  legacy_body_selected: boolean;
  observation_selection_prepared: boolean;
  observation_selection_executed: boolean;
  fused_selection: boolean;
}> = [];
const cacheSeams: Array<{
  saved_result_selected: boolean;
  final_selection_prepared: boolean;
  independent_change_applied: boolean;
}> = [];

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
        ? "synthetic content omitted"
        : (first ?? "assertion failed").slice(0, 160),
    });
    console.log(JSON.stringify({ check: name, outcome: "failed" }));
  }
}
async function execute<T>(name: string, request: CommandRequest<unknown>) {
  const response = await server
    .getWorker("bfb-work-records-a")
    .fetch(`${origin}/workspaces/${FIX.workspace}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandName: name, request }),
    });
  assert.equal(response.status, 200);
  return (await response.json()) as CommandOutcome<T>;
}
function checkedDatabase(
  binding: D1Like,
  afterFinalBinding?: (sql: string, parameters: unknown[]) => Promise<void>,
) {
  return adaptD1({
    prepare(sql) {
      const bytes = Buffer.byteLength(sql);
      bounds.maximum_statement_bytes = Math.max(bounds.maximum_statement_bytes, bytes);
      assert(bytes <= 100_000, "human detail SQL must retain its checked statement bound");
      const native = binding.prepare(sql);
      const statement: D1StatementLike = {
        bind(...parameters) {
          bounds.maximum_bindings = Math.max(bounds.maximum_bindings, parameters.length);
          assert(
            parameters.length <= 100,
            "human detail SQL must retain its checked binding bound",
          );
          const bound = native.bind(...parameters);
          if (afterFinalBinding && sql.includes("SELECT 1 AS authorized FROM attention_requests")) {
            return {
              bind: (...args) => bound.bind(...args),
              first: async (column) => {
                await afterFinalBinding(sql, parameters);
                return bound.first(column);
              },
              all: () => bound.all(),
              run: () => bound.run(),
            };
          }
          return bound;
        },
        first: (column) => native.first(column),
        all: () => native.all(),
        run: () => native.run(),
      };
      return statement;
    },
    batch: (statements) => binding.batch(statements),
  });
}
function beforeDetailObservations(
  binding: D1Like,
  before: () => Promise<void>,
  afterProjectCapture?: () => Promise<void>,
) {
  const state = {
    legacyBodySelected: false,
    observationSelectionPrepared: false,
    observationSelectionExecuted: false,
    fusedSelection: false,
  };
  const nativeDb = checkedDatabase(binding);
  let projectCaptureObserved = false;
  function wrap(db: SqlDatabase): SqlDatabase {
    return {
      prepare(sql) {
        const statement = db.prepare(sql);
        return {
          run: (...parameters) => statement.run(...parameters),
          async get(...parameters) {
            const row = await statement.get(...parameters);
            if (
              sql.includes("SELECT attention.*") &&
              sql.includes("attention_requests") &&
              row !== null &&
              row !== undefined
            )
              state.legacyBodySelected = true;
            return row;
          },
          async all(...parameters) {
            if (!state.observationSelectionPrepared && sql.includes("attention_observations")) {
              state.observationSelectionPrepared = true;
              state.fusedSelection = sql.includes("LEFT JOIN attention_observations");
              // OLD selected the body already; the fixed path prepares one body/history selection.
              assert(state.legacyBodySelected || state.fusedSelection);
              await before();
            }
            const rows = await statement.all(...parameters);
            if (
              !projectCaptureObserved &&
              afterProjectCapture &&
              sql.includes("SELECT projects.id") &&
              sql.includes("LEFT JOIN project_access")
            ) {
              projectCaptureObserved = true;
              await afterProjectCapture();
            }
            if (state.observationSelectionPrepared && sql.includes("attention_observations"))
              state.observationSelectionExecuted = true;
            return rows;
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
  const tables = (await db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table'
    AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'
    AND name NOT IN ('d1_migrations','rate_limit_buckets') ORDER BY name`,
    )
    .all()) as Array<{ name: string }>;
  for (const { name } of tables) assert(/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name));
  async function effects() {
    const rows: Record<string, unknown[]> = {};
    for (const { name } of tables)
      rows[name] = await db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all();
    // Canonical business, OAuth, guard and cursor tables remain; only engine/migration/HTTP abuse state is excluded.
    return rows;
  }
  type Effects = Awaited<ReturnType<typeof effects>>;
  async function cursor() {
    return db
      .prepare("SELECT cursor FROM workspace_cursors WHERE workspace_id=?")
      .get(FIX.workspace);
  }
  async function human<I>(input: I, humanId = FIX.member): Promise<CommandRequest<I>> {
    const principal = await loadPrincipal(db, FIX.workspace, humanId);
    return {
      workspaceId: FIX.workspace,
      actorHumanId: humanId,
      authorizationEpoch: principal.authorizationEpoch,
      idempotencyKey: randomUlid(),
      now: historicalRequestTime,
      input,
    };
  }
  async function fixture(
    humanId = FIX.owner,
    options: {
      permission?: "read" | "contribute" | "edit";
      writerHumanId?: string;
      writerProjectId?: string | null;
      writerTaskBoundary?: "target" | null;
    } = {},
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
    const requester = await loadPrincipal(db, FIX.workspace, FIX.member),
      runnerId = randomUlid(),
      assignedAt = new Date().toISOString(),
      thumbprint = `synthetic-human-detail-${runnerId}`;
    await db
      .prepare(
        `INSERT INTO runners
      (workspace_id,id,owner_human_id,device_label,public_key_json,key_thumbprint,authorization_epoch,grant_epoch,token_epoch,enrolled_at,revoked_at)
      VALUES (?,?,?,'Synthetic read fixture Mac','{}',?,1,1,1,?,NULL)`,
      )
      .run(FIX.workspace, runnerId, FIX.member, thumbprint, assignedAt);
    await db
      .prepare(
        "INSERT INTO runner_project_grants (workspace_id,runner_id,project_id) VALUES (?,?,?)",
      )
      .run(FIX.workspace, runnerId, FIX.projectA);
    // Synthetic immutable waiter assignment: no launch, lease, acknowledgement, process or provider.
    await db
      .prepare(
        `INSERT INTO execution_assignments
      (workspace_id,execution_id,assignment_generation,run_id,task_id,project_id,runner_id,checkout_id,physical_worktree_hash,requesting_human_id,requesting_human_epoch,runner_authorization_epoch,runner_grant_epoch,runner_key_thumbprint,created_at)
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
    const writerId = randomUlid(),
      writerHumanId = options.writerHumanId ?? FIX.member,
      writer = await loadPrincipal(db, FIX.workspace, writerHumanId),
      window = (await db
        .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes') AS expires_at")
        .get()) as { expires_at: string };
    // A synthetic valid delegated writer permits the genuine Hub attention command, not an OAuth ingress claim.
    await db
      .prepare(
        `INSERT INTO oauth_delegations
      (workspace_id,id,human_id,client_id,resource,project_id,task_id,scopes_json,authorization_epoch,expires_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        FIX.workspace,
        writerId,
        writerHumanId,
        FIX.client,
        mcpResource(origin),
        options.writerProjectId === undefined ? FIX.projectA : options.writerProjectId,
        options.writerTaskBoundary === null ? null : task.id,
        JSON.stringify(["bfb:task:write"]),
        writer.authorizationEpoch,
        window.expires_at,
        assignedAt,
      );
    const writerRequest: CommandRequest<{
      runId: string;
      kind: "clarification";
      question: string;
      blocking: boolean;
    }> = {
      workspaceId: FIX.workspace,
      actorHumanId: writerHumanId,
      actorDelegationId: writerId,
      authorizationEpoch: writer.authorizationEpoch,
      idempotencyKey: randomUlid(),
      now: historicalRequestTime,
      input: { runId: run.run.id, kind: "clarification", question, blocking: true },
    };
    const requested = await execute<AttentionRecord>("attention.request.delegation", writerRequest),
      attention = success(requested);
    const principal = await loadPrincipal(db, FIX.workspace, humanId),
      grantId = randomUlid();
    // Dormant task policy/read grant are synthetic; private creation remains disabled.
    await db
      .prepare(
        "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
      )
      .run(FIX.workspace, task.id, FIX.member, assignedAt);
    await db
      .prepare(
        `INSERT INTO task_human_grants
      (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at)
      VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        FIX.workspace,
        grantId,
        task.id,
        humanId,
        principal.authorizationEpoch,
        options.permission ?? "read",
        assignedAt,
      );
    if (writerHumanId !== FIX.member && writerHumanId !== humanId) {
      await db
        .prepare(
          `INSERT INTO task_human_grants
        (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at)
        VALUES (?,?,?,?,?,'contribute',?)`,
        )
        .run(
          FIX.workspace,
          randomUlid(),
          task.id,
          writerHumanId,
          writer.authorizationEpoch,
          assignedAt,
        );
    }
    const viewer: BrowserPrincipal = {
      type: "human",
      humanId,
      authUserId: `synthetic-preauthenticated-${humanId}`,
      email: `${humanId.toLowerCase()}@synthetic.test`,
      emailVerified: true,
      displayName: "Synthetic pre-authenticated viewer",
      sessionId: randomUlid(),
    };
    return {
      task,
      runId: run.run.id,
      executionId: execution.id,
      attention,
      grantId,
      viewer,
      writerId,
      writerRequest,
      requested,
    };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function call(f: Fixture, queryDb: SqlDatabase, attentionId = f.attention.id) {
    const response = await handleAttentionApi(
      new Request(`${origin}/api/v1/workspaces/${FIX.workspace}/attention/${attentionId}`),
      {
        db: queryDb,
        workspaceId: FIX.workspace,
        principal: f.viewer,
        now: historicalRequestTime,
        jurisdiction: "eu",
      },
    );
    return { status: response.status, body: await response.json(), text: "" };
  }
  function recordSeam(state: ReturnType<typeof beforeDetailObservations>["state"]) {
    detailSeams.push({
      legacy_body_selected: state.legacyBodySelected,
      observation_selection_prepared: state.observationSelectionPrepared,
      observation_selection_executed: state.observationSelectionExecuted,
      fused_selection: state.fusedSelection,
    });
    assert(state.observationSelectionPrepared);
    assert(state.observationSelectionExecuted);
    assert(state.legacyBodySelected || state.fusedSelection);
  }
  async function revokeGrant(id: string) {
    const beforeCursor = await cursor(),
      now = new Date().toISOString();
    await independent
      .prepare("UPDATE task_human_grants SET revoked_at=? WHERE workspace_id=? AND id=?")
      .run(now, FIX.workspace, id);
    assert.deepEqual(
      await independent
        .prepare("SELECT revoked_at FROM task_human_grants WHERE workspace_id=? AND id=?")
        .get(FIX.workspace, id),
      { revoked_at: now },
    );
    assert.deepEqual(await cursor(), beforeCursor);
  }
  async function privateGrant(
    taskId: string,
    humanId: string,
    permission: "read" | "contribute" | "edit",
  ) {
    const principal = await loadPrincipal(db, FIX.workspace, humanId),
      id = randomUlid(),
      now = new Date().toISOString();
    await independent
      .prepare(
        "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?) ON CONFLICT(workspace_id,task_id) DO NOTHING",
      )
      .run(FIX.workspace, taskId, FIX.member, now);
    await independent
      .prepare(
        "INSERT INTO task_human_grants (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(FIX.workspace, id, taskId, humanId, principal.authorizationEpoch, permission, now);
    return id;
  }
  async function removeProject(humanId: string) {
    const rows = (await independent
      .prepare("SELECT * FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?")
      .all(FIX.workspace, FIX.projectA, humanId)) as Array<{
      workspace_id: string;
      project_id: string;
      human_id: string;
    }>;
    assert.equal(rows.length, 1, "restricted project fixture begins with an actual grant");
    await independent
      .prepare("DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?")
      .run(FIX.workspace, FIX.projectA, humanId);
    assert.equal(
      (await loadPrincipal(independent, FIX.workspace, humanId)).projectIds.includes(FIX.projectA),
      false,
    );
    return async () => {
      await independent
        .prepare("INSERT INTO project_access (workspace_id,project_id,human_id) VALUES (?,?,?)")
        .run(FIX.workspace, FIX.projectA, humanId);
    };
  }
  function deniedOutcome(outcome: CommandOutcome<unknown>, message: string) {
    assert.equal(outcome.ok, false);
    if (outcome.ok) throw new Error("cached authority loss must withhold business result");
    assert.deepEqual(outcome.error, { code: "not_found", message });
    assert(
      !JSON.stringify(outcome).includes(canary),
      "denied cache contains no synthetic business body",
    );
  }
  function cachedDb(
    change: () => Promise<void>,
    options: {
      parentId?: string;
      afterFinalBinding?: (sql: string, parameters: unknown[]) => Promise<void>;
    } = {},
  ) {
    const state = {
      savedResultSelected: false,
      finalSelectionPrepared: false,
      changeApplied: false,
    };
    let baseline: Effects | undefined;
    async function apply() {
      assert(!state.changeApplied, "cache cut executes exactly once");
      await change();
      state.changeApplied = true;
      baseline = await effects();
    }
    const native = checkedDatabase(
      binding,
      options.afterFinalBinding
        ? async (sql, parameters) => {
            assert(state.savedResultSelected);
            assert(state.finalSelectionPrepared);
            await options.afterFinalBinding!(sql, parameters);
            await apply();
          }
        : undefined,
    );
    function wrap(source: SqlDatabase): SqlDatabase {
      return {
        // WorkspaceHub executes inside a transaction; wrapping only the outer database misses its cache seam.
        withTransaction: (callback) => source.withTransaction((tx) => callback(wrap(tx))),
        prepare(sql) {
          const statement = source.prepare(sql);
          return {
            run: (...args) => statement.run(...args),
            all: (...args) => statement.all(...args),
            async get(...args) {
              const final =
                state.savedResultSelected &&
                (sql.includes("SELECT 1 AS authorized FROM attention_requests") ||
                  (sql.includes("FROM tasks AS task") && sql.includes("AS parent_task_id")));
              if (final) state.finalSelectionPrepared = true;
              const parentCut =
                state.savedResultSelected &&
                options.parentId &&
                sql.includes("FROM tasks AS task") &&
                args.includes(options.parentId);
              if (parentCut && !state.changeApplied) await apply();
              const row = await statement.get(...args);
              if (sql.includes("FROM idempotency_records") && row != null) {
                assert(!state.savedResultSelected);
                state.savedResultSelected = true;
                if (!options.parentId && !options.afterFinalBinding) await apply();
              }
              return row;
            },
          };
        },
      };
    }
    return { hub: new WorkspaceHub(wrap(native)), state, baseline: () => baseline };
  }
  async function noCacheEffects(guarded: ReturnType<typeof cachedDb>) {
    cacheSeams.push({
      saved_result_selected: guarded.state.savedResultSelected,
      final_selection_prepared: guarded.state.finalSelectionPrepared,
      independent_change_applied: guarded.state.changeApplied,
    });
    assert(guarded.state.savedResultSelected);
    assert(
      guarded.state.finalSelectionPrepared,
      "cached delivery executes its command-owned final selection",
    );
    assert(guarded.state.changeApplied);
    assert(guarded.baseline());
    assert.deepEqual(await effects(), guarded.baseline());
  }
  async function endExecution(f: Fixture) {
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
        .prepare("SELECT state,end_reason FROM run_executions WHERE workspace_id=? AND id=?")
        .get(FIX.workspace, f.executionId),
      { state: "ended", end_reason: "process_exit" },
    );
  }
  async function databaseClock() {
    return (await independent
      .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now")
      .get()) as { now: string };
  }
  async function waitUntilExpired(expiresAt: string) {
    const deadline = Date.now() + 4_000;
    while (Date.parse((await databaseClock()).now) < Date.parse(expiresAt)) {
      assert(Date.now() < deadline, "natural SQL expiry witness retains a bounded delay");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  await check(
    "real_d1_mounted_healthy_human_attention_detail_preserves_body_observations_and_effects",
    async () => {
      const f = await fixture(FIX.reviewer),
        before = await effects(),
        expected = (await db
          .prepare(
            `SELECT observation_id,attention_id,observed_kind,actor_type,actor_id,occurred_at
        FROM attention_observations WHERE workspace_id=? AND attention_id=? ORDER BY occurred_at,rowid`,
          )
          .all(FIX.workspace, f.attention.id)) as AttentionObservation[];
      assert.equal(expected.length, 1);
      assert.equal(expected[0]?.observed_kind, "requested");
      const guarded = beforeDetailObservations(binding, async () => {}),
        reply = await call(f, guarded.db);
      recordSeam(guarded.state);
      assert.equal(reply.status, 200);
      assert.deepEqual(reply.body, { attention: f.attention, observations: expected });
      assert.deepEqual(await effects(), before);
    },
  );

  await check(
    "real_d1_mounted_read_grant_loss_between_legacy_body_and_observations_withholds_detail",
    async () => {
      const f = await fixture(),
        originalCursor = await cursor();
      let before: Effects | undefined,
        mutationApplied = false;
      const guarded = beforeDetailObservations(binding, async () => {
        const now = new Date().toISOString();
        await independent
          .prepare("UPDATE task_human_grants SET revoked_at=? WHERE workspace_id=? AND id=?")
          .run(now, FIX.workspace, f.grantId);
        assert.deepEqual(
          await independent
            .prepare("SELECT revoked_at FROM task_human_grants WHERE workspace_id=? AND id=?")
            .get(FIX.workspace, f.grantId),
          { revoked_at: now },
        );
        assert.deepEqual(await cursor(), originalCursor);
        mutationApplied = true;
        before = await effects();
      });
      const reply = await call(f, guarded.db);
      recordSeam(guarded.state);
      assert(mutationApplied);
      assert.deepEqual(await effects(), before);
      assert.equal(reply.status, 404);
      assert.deepEqual(reply.body, { error: "not_found" });
      assert.deepEqual(reply, await call(f, db, randomUlid()));
      const serialized = JSON.stringify(reply.body);
      for (const prohibited of [canary, f.task.id, f.attention.id, f.runId, f.executionId])
        assert(
          !serialized.includes(prohibited),
          "denied detail contains no body or related identity",
        );
      assert.deepEqual(await effects(), before);
    },
  );

  await check(
    "real_d1_detail_project_loss_at_body_history_selection_withholds_detail",
    async () => {
      const f = await fixture(FIX.reviewer),
        beforeCursor = await cursor();
      let restore: (() => Promise<void>) | undefined, baseline: Effects | undefined;
      const guarded = beforeDetailObservations(binding, async () => {
        restore = await removeProject(FIX.reviewer);
        assert.deepEqual(await cursor(), beforeCursor);
        baseline = await effects();
      });
      try {
        const reply = await call(f, guarded.db);
        recordSeam(guarded.state);
        assert.deepEqual(await effects(), baseline);
        assert.equal(reply.status, 404);
        assert.deepEqual(reply.body, { error: "not_found" });
      } finally {
        await restore?.();
      }
    },
  );

  await check(
    "real_d1_detail_retained_epoch_loss_at_body_history_selection_withholds_detail",
    async () => {
      const f = await fixture(FIX.reviewer),
        beforeCursor = await cursor(),
        prior = await loadPrincipal(db, FIX.workspace, FIX.reviewer);
      let baseline: Effects | undefined;
      const guarded = beforeDetailObservations(binding, async () => {
        assert.equal(
          await bumpMemberEpoch(independent, FIX.workspace, FIX.reviewer),
          prior.authorizationEpoch + 1,
        );
        assert.equal(
          (await loadPrincipal(independent, FIX.workspace, FIX.reviewer)).authorizationEpoch,
          prior.authorizationEpoch + 1,
        );
        assert.deepEqual(await cursor(), beforeCursor);
        baseline = await effects();
      });
      const reply = await call(f, guarded.db);
      recordSeam(guarded.state);
      assert.deepEqual(await effects(), baseline);
      assert.equal(reply.status, 404);
      assert.deepEqual(reply.body, { error: "not_found" });
    },
  );

  await check(
    "real_d1_detail_returns_canonical_answer_and_ordered_history_from_final_selection",
    async () => {
      const f = await fixture();
      let answered: AttentionRecord | undefined, baseline: Effects | undefined;
      const guarded = beforeDetailObservations(binding, async () => {
        answered = success(
          await execute<AttentionRecord>(
            "attention.answer",
            await human({
              attentionId: f.attention.id,
              expectedVersion: 1,
              answer: `${canary}-ANSWER`,
            }),
          ),
        );
        baseline = await effects();
      });
      const reply = await call(f, guarded.db);
      recordSeam(guarded.state);
      assert.deepEqual(await effects(), baseline);
      assert.equal(reply.status, 200);
      const observations = await db
        .prepare(
          `SELECT observation_id,attention_id,observed_kind,actor_type,actor_id,occurred_at
      FROM attention_observations WHERE workspace_id=? AND attention_id=? ORDER BY occurred_at,rowid`,
        )
        .all(FIX.workspace, f.attention.id);
      assert.equal(observations.length, 2);
      assert.deepEqual(reply.body, { attention: answered, observations });
    },
  );

  await check("real_d1_detail_read_only_roles_keep_empty_and_resolved_ended_history", async () => {
    for (const humanId of [FIX.owner, FIX.member, FIX.reviewer]) {
      const f = await fixture(humanId);
      await endExecution(f);
      const answered = success(
        await execute<AttentionRecord>(
          "attention.answer",
          await human({
            attentionId: f.attention.id,
            expectedVersion: 1,
            answer: `${canary}-HISTORICAL-ANSWER`,
          }),
        ),
      );
      const resolved = success(
        await execute<AttentionRecord>(
          "attention.resolve",
          await human({
            attentionId: f.attention.id,
            expectedVersion: answered.resource_version,
          }),
        ),
      );
      // Explicit synthetic historical zero-observation control: preserve the genuine source and all its observations.
      const emptyId = randomUlid(),
        columns = (await db.prepare("PRAGMA table_info(attention_requests)").all()) as Array<{
          name: string;
        }>;
      for (const column of columns) assert(/^[a-z_]+$/.test(column.name));
      const names = columns.map((column) => column.name);
      await independent
        .prepare(
          `INSERT INTO attention_requests (${names.join(",")})
        SELECT ${names.map((name) => (name === "id" ? "?" : name)).join(",")} FROM attention_requests WHERE workspace_id=? AND id=?`,
        )
        .run(emptyId, FIX.workspace, f.attention.id);
      assert.equal(
        (
          await db
            .prepare(
              "SELECT observation_id FROM attention_observations WHERE workspace_id=? AND attention_id=?",
            )
            .all(FIX.workspace, emptyId)
        ).length,
        0,
      );
      const baseline = await effects(),
        original = await call(f, checkedDatabase(binding)),
        empty = await call(f, checkedDatabase(binding), emptyId);
      assert.equal(original.status, 200);
      assert.deepEqual((original.body as { attention: AttentionRecord }).attention, resolved);
      assert.equal((original.body as { observations: unknown[] }).observations.length, 3);
      assert.equal(empty.status, 200);
      assert.deepEqual((empty.body as { observations: unknown[] }).observations, []);
      assert.equal((empty.body as { attention: AttentionRecord }).attention.state, "resolved");
      assert.deepEqual(await effects(), baseline);
    }
  });

  await check(
    "real_d1_detail_does_not_adopt_new_project_grant_outside_captured_viewer_subset",
    async () => {
      const f = await fixture(FIX.reviewer),
        restore = await removeProject(FIX.reviewer);
      let restored = false,
        baseline: Effects | undefined;
      const guarded = beforeDetailObservations(
        binding,
        async () => {},
        async () => {
          await restore();
          restored = true;
          assert(
            (await loadPrincipal(independent, FIX.workspace, FIX.reviewer)).projectIds.includes(
              FIX.projectA,
            ),
          );
          baseline = await effects();
        },
      );
      try {
        const reply = await call(f, guarded.db);
        assert(
          restored,
          "current project grant was restored after the original subset was selected",
        );
        assert.deepEqual(await effects(), baseline);
        assert.equal(reply.status, 404);
        assert.deepEqual(reply.body, { error: "not_found" });
      } finally {
        if (!restored) await restore();
      }
    },
  );

  async function cachedTaskFixture() {
    const parentRequest = await human({
        projectId: FIX.projectA,
        title: `${canary}-PARENT`,
        priority: "P2",
      }),
      parent = success(await execute<TaskRecord>("task.create", parentRequest)),
      childRequest = await human({
        projectId: FIX.projectA,
        parentTaskId: parent.id,
        title: `${canary}-CHILD`,
        priority: "P2",
      }),
      child = success(await execute<TaskRecord>("task.create", childRequest)),
      parentGrant = await privateGrant(parent.id, FIX.owner, "read"),
      targetGrant = await privateGrant(child.id, FIX.owner, "edit"),
      request = await human(
        { taskId: child.id, expectedVersion: 1, title: `${canary}-CACHED-TITLE` },
        FIX.owner,
      ),
      original = await execute<TaskRecord>("task.update", request),
      result = success(original);
    return { parent, child, parentGrant, targetGrant, request, original, result };
  }

  await check(
    "real_d1_cached_task_keeps_historical_result_cursor_and_masks_lost_parent",
    async () => {
      const f = await cachedTaskFixture();
      success(
        await execute(
          "task.update",
          await human({ taskId: f.child.id, expectedVersion: 2, title: `${canary}-LATER-TITLE` }),
        ),
      );
      const guarded = cachedDb(() => revokeGrant(f.parentGrant), { parentId: f.parent.id }),
        reply = await guarded.hub.execute(updateTaskCommand, f.request);
      await noCacheEffects(guarded);
      assert(reply.ok && f.original.ok);
      assert.equal(reply.replayed, true);
      assert.equal(reply.cursor, f.original.cursor);
      assert.deepEqual(reply.result, { ...f.result, parent_task_id: null });
      assert.equal(reply.result.resource_version, 2);
      assert.equal(
        (
          (await db
            .prepare("SELECT resource_version FROM tasks WHERE workspace_id=? AND id=?")
            .get(FIX.workspace, f.child.id)) as { resource_version: number }
        ).resource_version,
        3,
      );
    },
  );

  await check(
    "real_d1_cached_task_target_loss_before_old_second_parent_read_withholds_historical_body",
    async () => {
      const f = await cachedTaskFixture(),
        guarded = cachedDb(() => revokeGrant(f.targetGrant), { parentId: f.parent.id }),
        reply = await guarded.hub.execute(updateTaskCommand, f.request);
      await noCacheEffects(guarded);
      deniedOutcome(reply, "task not found");
    },
  );

  await check(
    "real_d1_cached_task_preserves_original_mutation_role_after_saved_result_lookup",
    async () => {
      const request = await human({
        projectId: FIX.projectA,
        title: `${canary}-ROLE-CREATE`,
        priority: "P2" as const,
      });
      success(await execute("task.create", request));
      const guarded = cachedDb(async () => {
        await independent
          .prepare(
            "UPDATE workspace_members SET role='reviewer' WHERE workspace_id=? AND human_id=?",
          )
          .run(FIX.workspace, FIX.member);
        assert.equal(
          (await loadPrincipal(independent, FIX.workspace, FIX.member)).role,
          "reviewer",
        );
      });
      try {
        const reply = await guarded.hub.execute(createTaskCommand, request);
        await noCacheEffects(guarded);
        deniedOutcome(reply, "task not found");
      } finally {
        await independent
          .prepare("UPDATE workspace_members SET role='member' WHERE workspace_id=? AND human_id=?")
          .run(FIX.workspace, FIX.member);
      }
    },
  );

  await check(
    "real_d1_cached_task_create_project_loss_after_saved_result_lookup_withholds_body",
    async () => {
      const request = await human({
        projectId: FIX.projectA,
        title: `${canary}-PROJECT-CREATE`,
        priority: "P2" as const,
      });
      success(await execute("task.create", request));
      let restore: (() => Promise<void>) | undefined;
      const guarded = cachedDb(async () => {
        restore = await removeProject(FIX.member);
      });
      try {
        const reply = await guarded.hub.execute(createTaskCommand, request);
        await noCacheEffects(guarded);
        deniedOutcome(reply, "task not found");
      } finally {
        await restore?.();
      }
    },
  );

  for (const kind of ["answer", "resolve"] as const) {
    await check(
      `real_d1_cached_human_attention_${kind}_needs_current_contribution_not_read_only_grant`,
      async () => {
        const f = await fixture(FIX.owner, { permission: "contribute" }),
          answerRequest = await human(
            { attentionId: f.attention.id, expectedVersion: 1, answer: `${canary}-CACHED-ANSWER` },
            FIX.owner,
          ),
          answered = success(await execute<AttentionRecord>("attention.answer", answerRequest));
        const resolveRequest = await human(
          { attentionId: f.attention.id, expectedVersion: answered.resource_version },
          FIX.owner,
        );
        if (kind === "resolve") success(await execute("attention.resolve", resolveRequest));
        const guarded = cachedDb(async () => {
          await revokeGrant(f.grantId);
          await privateGrant(f.task.id, FIX.owner, "read");
        });
        const reply =
          kind === "answer"
            ? await guarded.hub.execute(answerAttentionCommand, answerRequest)
            : await guarded.hub.execute(resolveAttentionCommand, resolveRequest);
        await noCacheEffects(guarded);
        deniedOutcome(reply, "attention request not found");
        assert.equal(
          (await call(f, db)).status,
          200,
          "read grant remains sufficient for current detail but not cached contribution",
        );
        assert.deepEqual(await effects(), guarded.baseline());
      },
    );
  }

  await check(
    "real_d1_cached_delegated_attention_independent_production_revocation_withholds_request",
    async () => {
      const f = await fixture(),
        beforeCursor = await cursor(),
        guarded = cachedDb(async () => {
          await revokeDelegation(independent, FIX.workspace, f.writerId, new Date().toISOString());
          assert(
            (
              (await independent
                .prepare("SELECT revoked_at FROM oauth_delegations WHERE workspace_id=? AND id=?")
                .get(FIX.workspace, f.writerId)) as { revoked_at: string }
            ).revoked_at,
          );
          assert.deepEqual(await cursor(), beforeCursor);
        });
      const reply = await guarded.hub.execute(requestDelegatedAttentionCommand, f.writerRequest);
      await noCacheEffects(guarded);
      deniedOutcome(reply, "attention request not found");
    },
  );

  await check(
    "real_d1_cached_delegated_attention_grant_loss_keeps_read_but_withholds_contribution",
    async () => {
      const f = await fixture(FIX.reviewer, {
          permission: "contribute",
          writerHumanId: FIX.reviewer,
        }),
        guarded = cachedDb(async () => {
          await revokeGrant(f.grantId);
          await privateGrant(f.task.id, FIX.reviewer, "read");
        }),
        reply = await guarded.hub.execute(requestDelegatedAttentionCommand, f.writerRequest);
      await noCacheEffects(guarded);
      deniedOutcome(reply, "attention request not found");
      assert.equal((await call(f, db)).status, 200);
      assert.deepEqual(await effects(), guarded.baseline());
    },
  );

  await check(
    "real_d1_cached_delegated_attention_rechecks_captured_write_scope_and_client",
    async () => {
      for (const field of ["scopes_json", "client_id"] as const) {
        const f = await fixture(),
          replacement =
            field === "scopes_json" ? JSON.stringify(["bfb:read"]) : `${FIX.client}-replacement`,
          beforeCursor = await cursor(),
          guarded = cachedDb(async () => {
            await independent
              .prepare(`UPDATE oauth_delegations SET ${field}=? WHERE workspace_id=? AND id=?`)
              .run(replacement, FIX.workspace, f.writerId);
            assert.deepEqual(
              await independent
                .prepare(`SELECT ${field} FROM oauth_delegations WHERE workspace_id=? AND id=?`)
                .get(FIX.workspace, f.writerId),
              { [field]: replacement },
            );
            assert.deepEqual(await cursor(), beforeCursor);
          }),
          reply = await guarded.hub.execute(requestDelegatedAttentionCommand, f.writerRequest);
        await noCacheEffects(guarded);
        deniedOutcome(reply, "attention request not found");
      }
    },
  );

  await check(
    "real_d1_cached_delegated_attention_preserves_original_nullable_ceilings",
    async () => {
      for (const wide of [true, false]) {
        const f = await fixture(
            FIX.owner,
            wide ? { writerProjectId: null, writerTaskBoundary: null } : {},
          ),
          projectId = wide ? FIX.projectA : null,
          taskId = wide ? f.task.id : null,
          guarded = cachedDb(async () => {
            await independent
              .prepare(
                "UPDATE oauth_delegations SET project_id=?,task_id=? WHERE workspace_id=? AND id=?",
              )
              .run(projectId, taskId, FIX.workspace, f.writerId);
            assert.deepEqual(
              await independent
                .prepare(
                  "SELECT project_id,task_id FROM oauth_delegations WHERE workspace_id=? AND id=?",
                )
                .get(FIX.workspace, f.writerId),
              { project_id: projectId, task_id: taskId },
            );
          }),
          reply = await guarded.hub.execute(requestDelegatedAttentionCommand, f.writerRequest);
        await noCacheEffects(guarded);
        deniedOutcome(reply, "attention request not found");
      }
    },
  );

  await check(
    "real_d1_cached_delegated_attention_unchanged_natural_expiry_after_final_native_binding_denies",
    async () => {
      const f = await fixture(),
        window = (await independent
          .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now','+2 seconds') AS expires_at")
          .get()) as { expires_at: string };
      // Expiry setup precedes arrival; no credential row is changed during the witnessed read.
      await independent
        .prepare("UPDATE oauth_delegations SET expires_at=? WHERE workspace_id=? AND id=?")
        .run(window.expires_at, FIX.workspace, f.writerId);
      const original = await independent
          .prepare("SELECT * FROM oauth_delegations WHERE workspace_id=? AND id=?")
          .get(FIX.workspace, f.writerId),
        arrival = await databaseClock();
      assert(Date.parse(arrival.now) < Date.parse(window.expires_at));
      let bound = false;
      const guarded = cachedDb(
          async () => {
            assert.deepEqual(
              await independent
                .prepare("SELECT * FROM oauth_delegations WHERE workspace_id=? AND id=?")
                .get(FIX.workspace, f.writerId),
              original,
            );
          },
          {
            afterFinalBinding: async (sql, parameters) => {
              assert(sql.includes("julianday('now')"));
              assert(parameters.includes(f.writerId));
              bound = true;
              await waitUntilExpired(window.expires_at);
              assert(Date.parse((await databaseClock()).now) >= Date.parse(window.expires_at));
            },
          },
        ),
        reply = await guarded.hub.execute(requestDelegatedAttentionCommand, f.writerRequest);
      assert(bound, "SQL and native bound arguments preceded the unchanged natural expiry delay");
      await noCacheEffects(guarded);
      deniedOutcome(reply, "attention request not found");
      assert.equal(f.writerRequest.now, historicalRequestTime);
    },
  );

  await check(
    "real_d1_cached_delegated_reviewer_write_only_ended_history_survives_delayed_live_final_selection",
    async () => {
      const f = await fixture(FIX.reviewer, {
        permission: "contribute",
        writerHumanId: FIX.reviewer,
      });
      await endExecution(f);
      const answered = success(
        await execute<AttentionRecord>(
          "attention.answer",
          await human({
            attentionId: f.attention.id,
            expectedVersion: 1,
            answer: `${canary}-LATER-HUMAN-ANSWER`,
          }),
        ),
      );
      success(
        await execute(
          "attention.resolve",
          await human({ attentionId: f.attention.id, expectedVersion: answered.resource_version }),
        ),
      );
      const original = await independent
          .prepare("SELECT * FROM oauth_delegations WHERE workspace_id=? AND id=?")
          .get(FIX.workspace, f.writerId),
        guarded = cachedDb(
          async () => {
            assert.deepEqual(
              await independent
                .prepare("SELECT * FROM oauth_delegations WHERE workspace_id=? AND id=?")
                .get(FIX.workspace, f.writerId),
              original,
            );
          },
          {
            afterFinalBinding: async (sql, parameters) => {
              assert(sql.includes("julianday('now')"));
              assert(parameters.includes(f.writerId));
              await new Promise((resolve) => setTimeout(resolve, 75));
              const credential = (await independent
                .prepare(
                  "SELECT expires_at,scopes_json FROM oauth_delegations WHERE workspace_id=? AND id=?",
                )
                .get(FIX.workspace, f.writerId)) as { expires_at: string; scopes_json: string };
              assert(Date.parse((await databaseClock()).now) < Date.parse(credential.expires_at));
              assert.deepEqual(JSON.parse(credential.scopes_json), ["bfb:task:write"]);
            },
          },
        ),
        reply = await guarded.hub.execute(requestDelegatedAttentionCommand, f.writerRequest);
      await noCacheEffects(guarded);
      assert(reply.ok && f.requested.ok);
      assert.equal(reply.replayed, true);
      assert.equal(reply.cursor, f.requested.cursor);
      assert.deepEqual(reply.result, f.attention);
      assert.equal(reply.result.state, "open");
      assert.equal(reply.result.answer, null);
      assert.equal(f.writerRequest.now, historicalRequestTime);
    },
  );

  console.log(
    JSON.stringify({
      schema_version: 1,
      stage: "human_detail_cached_business_delivery",
      migration_head: manifest.migration_head,
      checks,
      failures,
      detail_seams: detailSeams,
      cache_seams: cacheSeams,
      ...bounds,
      outcome: failures.length ? "failed" : "passed",
      limits: [
        "compiled existing attention API mounted with synthetic pre-authenticated BrowserPrincipal; not real cookie or CLI ingress",
        "disposable native D1 and genuine Hub task/run/attention setup; dormant private ACL and immutable waiter fixtures",
        "cache proof mounts production WorkspaceHub and commands over native D1 after authorization; not HTTP credential ingress or fresh post-Hub delivery",
        "no runner/provider operation, later delivery, private activation or complete C11 claim",
      ],
    }),
  );
  assert.equal(failures.length, 0, "human detail/cache D1 checks failed");
  console.log("C11_HUMAN_DETAIL_CACHE_D1_OK");
} finally {
  await server.close();
}
