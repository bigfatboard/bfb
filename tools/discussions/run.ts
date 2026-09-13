// ABOUTME: Certifies discussion migrations, atomic receipts and ordered turns against real D1 and independent Workers.
// ABOUTME: Synthetic runtime session seeding tests record binding only and makes no provider-execution claim.

import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adaptD1, loadMigrationManifest, type D1Like } from "@bfb/db";
import {
  FIX,
  randomUlid,
  runnerHash,
  seedSyntheticWorkspace,
  type CommandOutcome,
  type AgentProfileRecord,
  type TaskRecord,
} from "@bfb/domain";
import type {
  DiscussionCreateRequest,
  DiscussionReceipt,
  DiscussionTurnRequest,
  RunnerInventory,
} from "@bfb/protocol";
import { createTestHarness } from "wrangler";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const now = "2026-09-12T12:00:00.000Z",
  origin = "https://bfb.discussions.test";
const digest = `sha256:${"a".repeat(64)}`,
  emptyConfig = `sha256:${runnerHash("{}")}`;
const manifest = loadMigrationManifest(resolve(root, "migrations/d1"));
const split = manifest.migrations.findIndex((migration) => migration.id === "0017_discussions");
assert(split >= 0);
const migrationDir = await mkdtemp(resolve(tmpdir(), "bfb-d01-migrations-"));
for (const migration of manifest.migrations.slice(0, split))
  await copyFile(
    resolve(root, "migrations/d1", migration.file),
    resolve(migrationDir, migration.file),
  );
const base = { compatibility_date: "2026-08-08", compatibility_flags: ["nodejs_compat"] };
const client = {
  ...base,
  main: resolve(root, "tools/work-records/worker.ts"),
  durable_objects: {
    bindings: [
      { name: "WORKSPACE_HUB", class_name: "WorkspaceHub", script_name: "bfb-discussions-hub" },
    ],
  },
};
const server = createTestHarness({
  root,
  workers: [
    { config: { ...client, name: "bfb-discussions-a" } },
    { config: { ...client, name: "bfb-discussions-b" } },
    {
      config: {
        ...base,
        name: "bfb-discussions-hub",
        main: resolve(root, "apps/control-worker/src/index.ts"),
        d1_databases: [
          {
            binding: "DB",
            database_name: "bfb-discussions-test",
            database_id: "00000000-0000-4000-8000-000000000017",
            migrations_dir: migrationDir,
          },
          {
            binding: "EMPTY_DB",
            database_name: "bfb-discussions-empty-test",
            database_id: "00000000-0000-4000-8000-000000000027",
            migrations_dir: resolve(root, "migrations/d1"),
          },
        ],
        durable_objects: { bindings: [{ name: "WORKSPACE_HUB", class_name: "WorkspaceHub" }] },
        exports: { WorkspaceHub: { type: "durable-object", storage: "sqlite" } },
      },
    },
  ],
});
let sequence = 0;
async function execute<T>(
  name: string,
  input: unknown,
  actor: {
    actorHumanId?: string;
    actorSystemId?: string;
    authorizationEpoch?: number;
    workspaceId?: string;
  } = { actorHumanId: FIX.owner },
) {
  const worker = server.getWorker(sequence++ % 2 ? "bfb-discussions-b" : "bfb-discussions-a");
  const workspaceId = actor.workspaceId ?? FIX.workspace;
  const response = await worker.fetch(`${origin}/workspaces/${workspaceId}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      commandName: name,
      request: {
        workspaceId,
        idempotencyKey: randomUlid(),
        authorizationEpoch: 1,
        now,
        ...actor,
        input,
      },
    }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as CommandOutcome<T>;
}
function success<T>(outcome: CommandOutcome<T>): T {
  assert(outcome.ok, JSON.stringify(outcome));
  return outcome.result;
}
async function human<T>(name: string, input: unknown) {
  return success(await execute<T>(name, input));
}
const countsQuery = `SELECT (SELECT COUNT(*) FROM discussions) AS discussions, (SELECT COUNT(*) FROM discussion_participants) AS participants,
  (SELECT COUNT(*) FROM runs) AS runs, (SELECT COUNT(*) FROM run_configuration_snapshots) AS snapshots,
  (SELECT COUNT(*) FROM discussion_turns) AS turns, (SELECT COUNT(*) FROM discussion_deliveries) AS deliveries,
  (SELECT COUNT(*) FROM discussion_messages) AS messages, (SELECT COUNT(*) FROM discussion_command_receipts) AS receipts,
  (SELECT COUNT(*) FROM semantic_events) AS events, (SELECT cursor FROM workspace_cursors WHERE workspace_id = '${FIX.workspace}') AS cursor`;

try {
  await server.listen();
  const hub = server.getWorker("bfb-discussions-hub");
  await hub.applyD1Migrations("EMPTY_DB");
  await hub.applyD1Migrations("DB");
  const env = (await hub.getEnv()) as unknown as { DB: D1Like; EMPTY_DB: D1Like },
    db = adaptD1(env.DB);
  assert.deepEqual(await adaptD1(env.EMPTY_DB).prepare("PRAGMA foreign_key_check").all(), []);
  assert.deepEqual(
    await adaptD1(env.EMPTY_DB).prepare("SELECT COUNT(*) AS count FROM discussions").get(),
    { count: 0 },
  );
  await seedSyntheticWorkspace(db, now, "global");
  const oldTask = await human<TaskRecord>("task.create", {
    projectId: FIX.projectA,
    title: "Synthetic migration preservation",
    priority: "P2",
  });
  const oldRun = randomUlid(),
    oldSnapshot = randomUlid(),
    oldExecution = randomUlid(),
    oldSession = randomUlid();
  await db
    .prepare(
      `INSERT INTO runs (workspace_id, id, project_id, task_id, requested_by_human_id, agent_profile_id, result_state, activity, created_at) VALUES (?, ?, ?, ?, ?, ?, 'open', 'unknown', ?)`,
    )
    .run(FIX.workspace, oldRun, FIX.projectA, oldTask.id, FIX.owner, FIX.profileCodex, now);
  await db
    .prepare(
      `INSERT INTO run_configuration_snapshots (workspace_id, id, project_id, run_id, workspace_policy_version, project_policy_version, repository_config_version, agent_profile_id, agent_profile_version, canonical_json, content_hash, created_at) VALUES (?, ?, ?, ?, 1, 1, 1, ?, 1, '{"synthetic":"migration-preservation"}', ?, ?)`,
    )
    .run(FIX.workspace, oldSnapshot, FIX.projectA, oldRun, FIX.profileCodex, digest, now);
  await db
    .prepare(
      `INSERT INTO run_executions (workspace_id, id, run_id, state, created_at) VALUES (?, ?, ?, 'attached', ?)`,
    )
    .run(FIX.workspace, oldExecution, oldRun, now);
  await db
    .prepare(
      `INSERT INTO provider_sessions (workspace_id, id, run_id, execution_id, provider, observed_session_id, state, started_at) VALUES (?, ?, ?, ?, 'codex', 'synthetic-d01-preserved-session', 'active', ?)`,
    )
    .run(FIX.workspace, oldSession, oldRun, oldExecution, now);
  const tables = [
    "tasks",
    "runs",
    "run_configuration_snapshots",
    "run_executions",
    "provider_sessions",
    "semantic_events",
    "workspace_cursors",
  ];
  const before = await Promise.all(
    tables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all()),
  );
  for (const migration of manifest.migrations.slice(split))
    await copyFile(
      resolve(root, "migrations/d1", migration.file),
      resolve(migrationDir, migration.file),
    );
  await hub.applyD1Migrations("DB");
  for (const [index, table] of tables.entries()) {
    const rows = (await db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all()) as Record<
      string,
      unknown
    >[];
    if (table === "runs")
      for (const row of rows) {
        assert.equal(row.purpose, "work");
        delete row.purpose;
      }
    assert.deepEqual(rows, before[index], `${table} history changed during populated upgrade`);
  }
  console.log(
    "D01_MIGRATION_OK empty and populated 0016 upgrade preserve work, sessions, snapshots and event cursor",
  );

  const policy = {
    allowedProviders: ["claude", "codex"],
    allowAgentRootPropose: false,
    allowPassToAgent: true,
    allowRunOverrides: true,
  };
  await human("workspace.policy.update", { ...policy, expectedVersion: 1 });
  await human("project.policy.update", { ...policy, projectId: FIX.projectA, expectedVersion: 1 });
  await human("repository.config.report", {
    projectId: FIX.projectA,
    expectedVersion: 1,
    document: {},
    contentHash: emptyConfig,
  });
  const profiles: AgentProfileRecord[] = [];
  for (const provider of ["claude", "codex"])
    profiles.push(
      await human<AgentProfileRecord>("agent_profile.create", {
        name: `Synthetic discussion ${provider}`,
        provider,
        model: "synthetic",
        executionMode: "headless",
        harnessMode: "restricted",
      }),
    );
  const task = await human<TaskRecord>("task.create", {
    projectId: FIX.projectA,
    title: "Synthetic bounded D1 discussion",
    priority: "P2",
  });
  await human("context.add", {
    taskId: task.id,
    kind: "constraint",
    audience: "agent",
    body: "SYNTHETIC-D01-AGENT-CONTEXT",
  });
  await human("context.add", {
    taskId: task.id,
    kind: "note",
    audience: "human",
    body: "SYNTHETIC-D01-HUMAN-ONLY-CANARY",
  });
  const runner = randomUlid(),
    checkout = randomUlid();
  await db
    .prepare(
      `INSERT INTO runners (workspace_id, id, owner_human_id, device_label, public_key_json, key_thumbprint, token_epoch, enrolled_at) VALUES (?, ?, ?, 'Synthetic discussion Mac', '{}', 'synthetic-d01-key-thumbprint', 1, ?)`,
    )
    .run(FIX.workspace, runner, FIX.owner, now);
  await db
    .prepare("INSERT INTO runner_project_grants VALUES (?, ?, ?)")
    .run(FIX.workspace, runner, FIX.projectA);
  await db
    .prepare(
      "INSERT INTO runner_launch_grants (workspace_id, runner_id, human_id, granted_at) VALUES (?, ?, ?, ?)",
    )
    .run(FIX.workspace, runner, FIX.owner, now);
  const inventory: RunnerInventory = {
    schema_version: 1,
    workspace_id: FIX.workspace,
    runner_id: runner,
    revision: 1,
    providers: [],
    checkouts: [
      {
        schema_version: 1,
        checkout_id: checkout,
        workspace_id: FIX.workspace,
        runner_id: runner,
        project_id: FIX.projectA,
        label: "Synthetic checkout",
        repository_identity: "synthetic/d01",
        workspace_subpath: ".",
        physical_worktree_hash: digest,
        repository_config_hash: emptyConfig,
        is_default: true,
        dirty: false,
        status: "validated",
        validated_at: now,
      },
    ],
  };
  await db
    .prepare("INSERT INTO runner_inventories VALUES (?, ?, 1, ?, ?)")
    .run(FIX.workspace, runner, JSON.stringify(inventory), now);
  const input: DiscussionCreateRequest = {
    schema_version: 1,
    idempotency_key: "d01-synthetic-real-d1-create",
    task_id: task.id,
    expected_task_version: 1,
    question: "SYNTHETIC-D01-PRIVATE-QUESTION",
    git_revision: "a".repeat(40),
    workspace_policy_version: 2,
    project_policy_version: 2,
    repository_config_version: 2,
    participants: profiles.map((profile) => ({
      agent_profile_id: profile.id,
      agent_profile_version: 1,
      runner_id: runner,
      checkout_id: checkout,
    })),
  };
  const baseline = await db.prepare(countsQuery).get();
  await db
    .prepare(
      "CREATE TRIGGER synthetic_d01_receipt_failure BEFORE INSERT ON discussion_command_receipts BEGIN SELECT RAISE(ABORT, 'synthetic d01 rollback'); END",
    )
    .run();
  assert.equal((await execute("discussion.create", input)).ok, false);
  assert.deepEqual(
    await db.prepare(countsQuery).get(),
    baseline,
    "late receipt failure must roll back the whole batch and event cursor",
  );
  await db.prepare("DROP TRIGGER synthetic_d01_receipt_failure").run();
  const duplicates = await Promise.all(
    Array.from({ length: 12 }, () => execute<DiscussionReceipt>("discussion.create", input)),
  );
  const receipts = duplicates.map(success),
    created = receipts[0]!;
  assert(receipts.every((receipt) => receipt.discussion_id === created.discussion_id));
  await hub.evictDurableObject("WorkspaceHub", { name: FIX.workspace });
  assert.deepEqual(await human<DiscussionReceipt>("discussion.create", input), created);
  const changedRetry = await execute("discussion.create", {
    ...input,
    question: "Synthetic changed retry",
  });
  assert(!changedRetry.ok && changedRetry.error.code === "idempotency_conflict");
  assert.deepEqual(await db.prepare("SELECT COUNT(*) AS count FROM discussions").get(), {
    count: 1,
  });
  assert.deepEqual(
    await db.prepare("SELECT COUNT(*) AS count FROM discussion_participants").get(),
    { count: 2 },
  );
  const row = () =>
    db.prepare("SELECT * FROM discussions WHERE id = ?").get(created.discussion_id) as Promise<{
      resource_version: number;
      state: string;
      brief_json: string;
    }>;
  const change = (action: string, version: number, extra: object = {}) => ({
    schema_version: 1,
    idempotency_key: randomUlid(),
    discussion_id: created.discussion_id,
    expected_version: version,
    action,
    ...extra,
  });
  const raced = await Promise.all(
    ["one", "two"].map((suffix) =>
      execute<DiscussionReceipt>(
        "discussion.change",
        change("intervene", 1, { text: `Synthetic contender ${suffix}` }),
      ),
    ),
  );
  assert.equal(raced.filter((outcome) => outcome.ok).length, 1);
  assert.equal(
    raced.filter((outcome) => !outcome.ok && outcome.error.code === "stale_version").length,
    1,
  );
  assert(!(await row()).brief_json.includes("SYNTHETIC-D01-HUMAN-ONLY-CANARY"));
  const participants = (await db
    .prepare(
      "SELECT id, run_id, slot FROM discussion_participants WHERE discussion_id = ? ORDER BY slot",
    )
    .all(created.discussion_id)) as Array<{ id: string; run_id: string; slot: number }>;
  const sessions = new Map<string, string>();
  const turnInput = async (
    ordinal: number,
    action: DiscussionTurnRequest["action"],
    extra: object = {},
  ) => {
    const current = await row();
    const turn = (await db
      .prepare("SELECT * FROM discussion_turns WHERE discussion_id = ? AND ordinal = ?")
      .get(created.discussion_id, ordinal)) as { id: string; resource_version: number };
    const delivery = (await db
      .prepare("SELECT * FROM discussion_deliveries WHERE turn_id = ?")
      .get(turn.id)) as
      { id: string; resource_version: number; source_message_ids_json: string } | undefined;
    return {
      schema_version: 1,
      idempotency_key: randomUlid(),
      discussion_id: created.discussion_id,
      expected_version: current.resource_version,
      turn_id: turn.id,
      expected_turn_version: turn.resource_version,
      action,
      ...(action === "accept"
        ? {}
        : { delivery_id: delivery!.id, expected_delivery_version: delivery!.resource_version }),
      ...extra,
    };
  };
  for (let ordinal = 1; ordinal <= 6; ordinal++) {
    if (ordinal === 3) await hub.evictDurableObject("WorkspaceHub", { name: FIX.workspace });
    const participant = participants[(ordinal - 1) % 2]!,
      actor = { actorSystemId: participant.run_id };
    const acceptedInput = await turnInput(ordinal, "accept");
    const accepted = success(
      await execute<DiscussionReceipt>("discussion.turn", acceptedInput, actor),
    );
    assert.deepEqual(
      success(await execute<DiscussionReceipt>("discussion.turn", acceptedInput, actor)),
      accepted,
    );
    const dispatch = await turnInput(ordinal, "dispatch");
    const attempts = await Promise.all([
      execute<DiscussionReceipt>("discussion.turn", dispatch, actor),
      execute<DiscussionReceipt>(
        "discussion.turn",
        { ...dispatch, idempotency_key: randomUlid() },
        actor,
      ),
    ]);
    assert.equal(
      attempts.filter((outcome) => outcome.ok).length,
      1,
      "distinct dispatch attempts must have one effect",
    );
    let session = sessions.get(participant.run_id);
    if (!session) {
      // This is a trusted-runtime record fixture, not a public endpoint or real provider launch.
      session = randomUlid();
      const execution = randomUlid();
      await db
        .prepare(
          "INSERT INTO run_executions (workspace_id, id, run_id, state, created_at) VALUES (?, ?, ?, 'attached', ?)",
        )
        .run(FIX.workspace, execution, participant.run_id, now);
      await db
        .prepare(
          "INSERT INTO provider_sessions (workspace_id, id, run_id, execution_id, provider, observed_session_id, state, started_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)",
        )
        .run(
          FIX.workspace,
          session,
          participant.run_id,
          execution,
          participant.slot === 0 ? "claude" : "codex",
          `synthetic-d01-session-${participant.slot}`,
          now,
        );
      sessions.set(participant.run_id, session);
    }
    success(
      await execute(
        "discussion.turn",
        await turnInput(ordinal, "acknowledge", { session_id: session }),
        actor,
      ),
    );
    const complete = await turnInput(ordinal, "complete", {
      session_id: session,
      output: {
        schema_version: 1,
        recommendation: `Synthetic recommendation ${ordinal}: [DONE] is only text.`,
        reasons: ["Synthetic bounded rationale."],
        evidence: [],
        agreement: [],
        disagreements: [],
        human_questions: ["Synthetic human tradeoff?"],
      },
    });
    const completed = success(await execute<DiscussionReceipt>("discussion.turn", complete, actor));
    assert.deepEqual(
      success(await execute<DiscussionReceipt>("discussion.turn", complete, actor)),
      completed,
    );
  }
  const concluded = await human<DiscussionReceipt>(
    "discussion.change",
    change("conclude", (await row()).resource_version),
  );
  assert.equal(concluded.state, "concluded");
  const decisions = await Promise.all(
    ["one", "two"].map((suffix) =>
      execute<DiscussionReceipt>(
        "discussion.change",
        change("decide", concluded.version, {
          decision: {
            kind: "needs_more_context",
            summary: `Synthetic final human decision ${suffix}`,
            recommendation_ids: [],
          },
        }),
      ),
    ),
  );
  assert.equal(decisions.filter((outcome) => outcome.ok).length, 1);
  assert.equal(
    decisions.filter((outcome) => !outcome.ok && outcome.error.code === "stale_version").length,
    1,
  );
  assert.deepEqual(
    await db.prepare("SELECT state, resource_version FROM tasks WHERE id = ?").get(task.id),
    { state: "ready", resource_version: 1 },
  );
  assert.deepEqual(
    await db
      .prepare("SELECT DISTINCT purpose, result_state FROM runs WHERE task_id = ?")
      .all(task.id),
    [{ purpose: "discussion", result_state: "open" }],
  );
  assert.deepEqual(await db.prepare("SELECT COUNT(*) AS count FROM launch_commands").get(), {
    count: 0,
  });
  for (const table of [
    "discussion_messages",
    "discussion_participants",
    "discussion_session_bindings",
    "discussion_conclusions",
    "discussion_decisions",
    "discussion_command_receipts",
  ])
    await assert.rejects(db.prepare(`DELETE FROM ${table}`).run(), /immutable/);
  await assert.rejects(
    db.prepare("UPDATE discussions SET brief_json = '{}' WHERE id = ?").run(created.discussion_id),
    /immutable/,
  );
  await assert.rejects(
    db.prepare("UPDATE runs SET result_state = 'accepted' WHERE task_id = ?").run(task.id),
  );
  const audit = await db
    .prepare("SELECT payload_json FROM semantic_events WHERE kind LIKE 'discussion.%'")
    .all();
  assert(!JSON.stringify(audit).includes("SYNTHETIC-D01-PRIVATE-QUESTION"));
  assert(!JSON.stringify(audit).includes("Synthetic recommendation"));
  assert(!JSON.stringify(audit).includes("Synthetic final human decision"));
  await db
    .prepare(
      "UPDATE workspace_members SET authorization_epoch = 2 WHERE workspace_id = ? AND human_id = ?",
    )
    .run(FIX.workspace, FIX.owner);
  await db
    .prepare(
      "UPDATE workspace_authorization_epochs SET authorization_epoch = 2 WHERE workspace_id = ? AND human_id = ?",
    )
    .run(FIX.workspace, FIX.owner);
  assert.equal((await execute("discussion.create", input, { actorHumanId: FIX.owner })).ok, false);
  assert.equal(
    (await execute("discussion.create", input, { actorHumanId: FIX.owner, authorizationEpoch: 2 }))
      .ok,
    false,
  );
  assert.deepEqual(await db.prepare("PRAGMA foreign_key_check").all(), []);
  console.log(
    JSON.stringify({
      workers: 2,
      migration: manifest.migration_head,
      duplicateCreates: 12,
      committedDiscussions: 1,
      completedTurns: 6,
      sessionBindings: sessions.size,
      lateBatchRollback: true,
      staleInterventionRace: true,
      dispatchRaces: 6,
      humanDecisionRace: true,
      privateContentAbsentFromAudit: true,
      taskUnchanged: true,
    }),
  );
  console.log("D01_D1_OK");
} catch (error) {
  server.debug();
  throw error;
} finally {
  await server.close();
  await rm(migrationDir, { recursive: true, force: true });
}
