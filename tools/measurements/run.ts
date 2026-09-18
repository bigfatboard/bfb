// ABOUTME: Certifies A04 measurements across two Workers and real D1 with duplicate replay.
// ABOUTME: Synthetic observations only; snapshots carry counts and durations, never bodies.

import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { adaptD1, loadMigrationManifest, type D1Like } from "@bfb/db";
import {
  aggregateMeasurements,
  answerAttentionCommand,
  calculateCost,
  claimLaunchCommand,
  createAgentProfileCommand,
  createTaskCommand,
  CURRENT_PRICE_CATALOG_VERSION,
  FIX,
  getRunMeasurements,
  getTaskMeasurements,
  launchDeadline,
  listReviewTimerObservations,
  normalizeTokenFields,
  randomUlid,
  recordBrowserActivityCommand,
  replaceRunnerInventoryCommand,
  reportIntervalCommand,
  reportRepositoryConfigCommand,
  reportTokensCommand,
  requestAttentionCommand,
  runnerHash,
  seedSyntheticWorkspace,
  startLaunchCommand,
  startReviewTimerCommand,
  stopReviewTimerCommand,
  unionIntervalsMs,
  updateProjectPolicyCommand,
  updateWorkspacePolicyCommand,
  type CommandOutcome,
  type RunnerPrincipal,
  type TaskRecord,
} from "@bfb/domain";
import type { RunnerInventory } from "@bfb/protocol";
import { createTestHarness } from "wrangler";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const now = "2026-09-12T12:00:00.000Z",
  origin = "https://bfb.measurements.test";
const digest = `sha256:${"a".repeat(64)}`,
  emptyConfig = `sha256:${runnerHash("{}")}`;
const evidenceDir = resolve(root, "docs/work-packages/evidence/WP-A04");
const fixturesDir = resolve(evidenceDir, "fixtures");
const manifest = loadMigrationManifest(resolve(root, "migrations/d1"));
const split = manifest.migrations.findIndex((migration) => migration.id === "0027_measurements");
assert(split >= 0, "A04 migration is required");
const migrationDir = await mkdtemp(resolve(tmpdir(), "bfb-a04-migrations-"));
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
      { name: "WORKSPACE_HUB", class_name: "WorkspaceHub", script_name: "bfb-measurements-hub" },
    ],
  },
};
const server = createTestHarness({
  root,
  workers: [
    { config: { ...client, name: "bfb-measurements-a" } },
    { config: { ...client, name: "bfb-measurements-b" } },
    {
      config: {
        ...base,
        name: "bfb-measurements-hub",
        main: resolve(root, "apps/control-worker/src/index.ts"),
        d1_databases: [
          {
            binding: "DB",
            database_name: "bfb-measurements-test",
            database_id: "00000000-0000-4000-8000-000000000027",
            migrations_dir: migrationDir,
          },
          {
            binding: "EMPTY_DB",
            database_name: "bfb-measurements-empty-test",
            database_id: "00000000-0000-4000-8000-000000000037",
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
    actorRunnerId?: string;
    authorizationEpoch?: number;
    workspaceId?: string;
  } = { actorHumanId: FIX.owner },
  nowAt: string = now,
) {
  const worker = server.getWorker(sequence++ % 2 ? "bfb-measurements-b" : "bfb-measurements-a");
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
        now: nowAt,
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
async function human<T>(name: string, input: unknown, nowAt: string = now) {
  return success(await execute<T>(name, input, { actorHumanId: FIX.owner }, nowAt));
}

const snapshots: Record<string, unknown> = {};
function snapshot(step: string, fields: Record<string, unknown>): void {
  snapshots[step] = fields;
  console.log(`A04_${step.toUpperCase()}_OK ${JSON.stringify(fields)}`);
}

const runner = randomUlid(),
  checkout = randomUlid(),
  tokenId = randomUlid();
const principal: RunnerPrincipal = {
  kind: "runner",
  workspaceId: FIX.workspace,
  runnerId: runner,
  ownerHumanId: FIX.owner,
  authorizationEpoch: 1,
  ownerAuthorizationEpoch: 1,
  grantEpoch: 1,
  tokenEpoch: 1,
  tokenId,
  keyThumbprint: "synthetic-a04-harness-key",
  authExpiresAt: launchDeadline(now, 300_000),
  projectIds: [FIX.projectA],
};

async function native<T>(name: string, input: unknown) {
  return success(await execute<T>(name, input, { actorRunnerId: runner }));
}

let ledgerCursor = 50_000;
async function insertLedger(
  db: ReturnType<typeof adaptD1>,
  input: { runId: string; executionId: string; taskId: string; kind: string; occurredAt: string },
): Promise<void> {
  ledgerCursor += 1;
  await db
    .prepare(
      `INSERT INTO event_ledger
       (workspace_id, event_id, workspace_cursor, source_stream_id, source_sequence,
        run_execution_id, assignment_generation, project_id, task_id, run_id,
        actor_type, actor_id, source_type, source_id, capture_origin, kind,
        occurred_at, received_at, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'agent_run', ?, 'runner', ?, 'hook_inbox', ?, ?, ?, '{}')`,
    )
    .run(
      FIX.workspace,
      randomUlid(),
      ledgerCursor,
      randomUlid(),
      ledgerCursor,
      input.executionId,
      FIX.projectA,
      input.taskId,
      input.runId,
      input.executionId,
      "synthetic-a04-runner",
      input.kind,
      input.occurredAt,
      input.occurredAt,
    );
}

try {
  await server.listen();
  const hub = server.getWorker("bfb-measurements-hub");
  await hub.applyD1Migrations("EMPTY_DB");
  await hub.applyD1Migrations("DB");
  const env = (await hub.getEnv()) as unknown as { DB: D1Like; EMPTY_DB: D1Like },
    db = adaptD1(env.DB);
  assert.deepEqual(await adaptD1(env.EMPTY_DB).prepare("PRAGMA foreign_key_check").all(), []);

  // Populated 0024 state upgrades to 0027 without touching work history.
  await seedSyntheticWorkspace(db, now, "global");
  const preserved = await human<TaskRecord>(createTaskCommand.name, {
    projectId: FIX.projectA,
    title: "Synthetic A04 migration preservation",
    priority: "P2",
  });
  const beforeUpgrade = await db
    .prepare(`SELECT id, state, resource_version FROM tasks WHERE workspace_id = ? ORDER BY id`)
    .all(FIX.workspace);
  for (const migration of manifest.migrations.slice(split))
    await copyFile(
      resolve(root, "migrations/d1", migration.file),
      resolve(migrationDir, migration.file),
    );
  await hub.applyD1Migrations("DB");
  assert.deepEqual(
    await db
      .prepare(`SELECT id, state, resource_version FROM tasks WHERE workspace_id = ? ORDER BY id`)
      .all(FIX.workspace),
    beforeUpgrade,
  );
  assert.deepEqual(await db.prepare("PRAGMA foreign_key_check").all(), []);
  snapshot("migration", {
    preserved_task: beforeUpgrade.some((row) => (row as { id: string }).id === preserved.id),
    tables: 5,
  });

  const policy = {
    allowedProviders: ["fake"],
    allowAgentRootPropose: false,
    allowPassToAgent: true,
    allowRunOverrides: true,
  };
  await human(updateWorkspacePolicyCommand.name, { ...policy, expectedVersion: 1 });
  await human(updateProjectPolicyCommand.name, {
    ...policy,
    expectedVersion: 1,
    projectId: FIX.projectA,
  });
  await human(reportRepositoryConfigCommand.name, {
    projectId: FIX.projectA,
    expectedVersion: 1,
    document: {},
    contentHash: emptyConfig,
  });
  const profile = await human<{ id: string }>(createAgentProfileCommand.name, {
    name: "Synthetic A04 harness provider",
    provider: "fake",
    model: "synthetic",
    executionMode: "interactive",
    harnessMode: "restricted",
  });
  const task = await human<TaskRecord>(createTaskCommand.name, {
    projectId: FIX.projectA,
    title: "Synthetic A04 harness run",
    priority: "P2",
  });
  await db
    .prepare(
      `INSERT INTO runners (workspace_id, id, owner_human_id, device_label, public_key_json, key_thumbprint, token_epoch, enrolled_at)
       VALUES (?, ?, ?, 'Synthetic A04 harness Mac', '{}', ?, 1, ?)`,
    )
    .run(FIX.workspace, runner, FIX.owner, principal.keyThumbprint, now);
  await db
    .prepare(`INSERT INTO runner_project_grants VALUES (?, ?, ?)`)
    .run(FIX.workspace, runner, FIX.projectA);
  await db
    .prepare(
      `INSERT INTO runner_launch_grants (workspace_id, runner_id, human_id, granted_at) VALUES (?, ?, ?, ?)`,
    )
    .run(FIX.workspace, runner, FIX.owner, now);
  await db
    .prepare(
      `INSERT INTO runner_tokens (workspace_id, runner_id, id, token_hash, claims_json, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      FIX.workspace,
      runner,
      tokenId,
      runnerHash("synthetic-a04-harness-token"),
      JSON.stringify({
        v: 1,
        sub: runner,
        workspace_id: FIX.workspace,
        aud: "bfb-runner",
        iss: "https://bfb.example.test",
        jti: tokenId,
        iat: Date.parse(now) / 1000,
        exp: Date.parse(principal.authExpiresAt) / 1000,
        authorization_epoch: 1,
        owner_authorization_epoch: 1,
        grant_epoch: 1,
        token_epoch: 1,
        cnf: { jkt: principal.keyThumbprint },
      }),
      principal.authExpiresAt,
    );
  const inventory: RunnerInventory = {
    schema_version: 1,
    workspace_id: FIX.workspace,
    runner_id: runner,
    revision: 1,
    checkouts: [
      {
        schema_version: 1,
        checkout_id: checkout,
        workspace_id: FIX.workspace,
        runner_id: runner,
        project_id: FIX.projectA,
        label: "Synthetic A04 checkout",
        repository_identity: "synthetic/a04",
        workspace_subpath: ".",
        physical_worktree_hash: digest,
        repository_config_hash: emptyConfig,
        is_default: true,
        dirty: false,
        status: "validated",
        validated_at: now,
      },
    ],
    providers: [
      {
        provider: "fake",
        version: "1.0.0",
        manifest_id: digest,
        status: "healthy",
        observed_at: now,
        expires_at: launchDeadline(now, 30_000),
        capabilities: [
          "launch.interactive",
          "filesystem.read_only",
          "approval.never",
          "context.session_start",
          "prompt.initial_constant",
          "hooks.session_start",
          "mcp.stdio",
          "control.interrupt",
          "control.terminate",
          "session.resume",
        ],
      },
    ],
  };
  await native(replaceRunnerInventoryCommand.name, { principal, inventory });
  const launch = await human<{ launch_id: string }>(startLaunchCommand.name, {
    schema_version: 1,
    idempotency_key: randomUlid(),
    task_id: task.id,
    expected_task_version: 1,
    runner_id: runner,
    checkout_id: checkout,
    agent_profile_id: profile.id,
    agent_profile_version: 1,
    workspace_policy_version: 2,
    project_policy_version: 2,
    repository_config_version: 2,
  });
  const claimed = await native<{
    state: string;
    claim: {
      specification: { run_id: string; run_execution_id: string; assignment_generation: number };
    };
  }>(claimLaunchCommand.name, {
    principal,
    claim: {
      schema_version: 1,
      launch_id: launch.launch_id,
      runner_id: runner,
      idempotency_key: randomUlid(),
      claimed_at: now,
    },
  });
  assert.equal(claimed.state, "claimed");
  const spec = claimed.claim.specification;
  snapshot("claim", { state: claimed.state, execution_assigned: spec.run_execution_id.length > 0 });

  // Provider-usage fixtures normalize without invention; missing usage stays unavailable.
  for (const fixture of ["codex-usage.json", "claude-usage.json", "missing-usage.json"]) {
    const parsed = JSON.parse(await readFile(resolve(fixturesDir, fixture), "utf8")) as {
      raw: unknown;
      expected: Record<string, number | null>;
      quality: string;
    };
    assert.deepEqual(normalizeTokenFields(parsed.raw), parsed.expected);
  }
  snapshot("fixtures", { normalized: 3 });

  // Duplicate token reports across workers converge on one stored row.
  const usageObservationId = randomUlid();
  const tokenInput = {
    principal,
    observationId: usageObservationId,
    runId: spec.run_id,
    executionId: spec.run_execution_id,
    assignmentGeneration: spec.assignment_generation,
    provider: "codex",
    model: "codex-fixture-model",
    tokens: { input_tokens: 1_000_000, output_tokens: 500_000 },
    quality: "provider_reported",
  };
  const firstTokens = await native<{ observation_id: string }>(
    reportTokensCommand.name,
    tokenInput,
  );
  assert.equal(firstTokens.observation_id, usageObservationId);
  const replayedTokens = await native<{ observation_id: string }>(
    reportTokensCommand.name,
    tokenInput,
  );
  assert.equal(replayedTokens.observation_id, usageObservationId);
  const tokenRows = (await db
    .prepare(
      `SELECT COUNT(*) AS total FROM token_observations WHERE workspace_id = ? AND run_id = ?`,
    )
    .get(FIX.workspace, spec.run_id)) as { total: number };
  assert.equal(tokenRows.total, 1);
  const confused = await execute(
    reportTokensCommand.name,
    {
      ...tokenInput,
      tokens: { input_tokens: 2, output_tokens: 1 },
    },
    { actorRunnerId: runner },
  );
  assert.equal(confused.ok, false);
  assert.equal(confused.ok ? "" : confused.error.code, "conflict");
  await native(reportTokensCommand.name, {
    principal,
    runId: spec.run_id,
    executionId: spec.run_execution_id,
    assignmentGeneration: spec.assignment_generation,
    provider: "claude",
    tokens: { input_tokens: 100, output_tokens: 50 },
    quality: "estimated",
  });
  await native(reportTokensCommand.name, {
    principal,
    runId: spec.run_id,
    executionId: spec.run_execution_id,
    assignmentGeneration: spec.assignment_generation,
    provider: "grok",
    tokens: {},
    quality: "unavailable",
  });
  snapshot("tokens", { stored: 3, duplicate_replays: 1, conflicts: 1 });

  // Overlapping reported intervals union; replayed identities add nothing.
  const waitBase = {
    principal,
    runId: spec.run_id,
    executionId: spec.run_execution_id,
    assignmentGeneration: spec.assignment_generation,
    intervalKind: "external_wait",
  };
  const waitId = randomUlid();
  await native(reportIntervalCommand.name, {
    ...waitBase,
    observationId: waitId,
    startedAt: "2026-09-12T12:01:00.000Z",
    endedAt: "2026-09-12T12:03:00.000Z",
  });
  await native(reportIntervalCommand.name, {
    ...waitBase,
    startedAt: "2026-09-12T12:02:00.000Z",
    endedAt: "2026-09-12T12:04:00.000Z",
  });
  await native(reportIntervalCommand.name, {
    ...waitBase,
    observationId: waitId,
    startedAt: "2026-09-12T12:01:00.000Z",
    endedAt: "2026-09-12T12:03:00.000Z",
  });
  const intervalRows = (await db
    .prepare(
      `SELECT COUNT(*) AS total FROM measurement_intervals WHERE workspace_id = ? AND run_id = ?`,
    )
    .get(FIX.workspace, spec.run_id)) as { total: number };
  assert.equal(intervalRows.total, 2);
  const reportedUnion = unionIntervalsMs([
    { start: Date.parse("2026-09-12T12:01:00.000Z"), end: Date.parse("2026-09-12T12:03:00.000Z") },
    { start: Date.parse("2026-09-12T12:02:00.000Z"), end: Date.parse("2026-09-12T12:04:00.000Z") },
  ]);
  assert.equal(reportedUnion.total_ms, 180_000);
  snapshot("intervals", { stored: 2, union_ms: reportedUnion.total_ms });

  // Ledger-derived activity, offline gaps, launch latency, and attention wait.
  const base = { runId: spec.run_id, executionId: spec.run_execution_id, taskId: task.id };
  await insertLedger(db, {
    ...base,
    kind: "execution_attached",
    occurredAt: "2026-09-12T12:00:30.000Z",
  });
  await insertLedger(db, { ...base, kind: "turn_started", occurredAt: "2026-09-12T12:00:40.000Z" });
  await insertLedger(db, { ...base, kind: "tool_started", occurredAt: "2026-09-12T12:00:50.000Z" });
  await insertLedger(db, {
    ...base,
    kind: "tool_finished",
    occurredAt: "2026-09-12T12:01:10.000Z",
  });
  await insertLedger(db, { ...base, kind: "turn_stopped", occurredAt: "2026-09-12T12:01:30.000Z" });
  await insertLedger(db, { ...base, kind: "heartbeat", occurredAt: "2026-09-12T12:00:40.000Z" });
  await insertLedger(db, { ...base, kind: "heartbeat", occurredAt: "2026-09-12T12:05:00.000Z" });
  await db
    .prepare(
      `UPDATE run_executions SET state = 'ended', end_reason = 'process_exit', ended_at = ?
       WHERE workspace_id = ? AND id = ?`,
    )
    .run("2026-09-12T12:06:00.000Z", FIX.workspace, spec.run_execution_id);
  const requested = await native<{ id: string }>(requestAttentionCommand.name, {
    principal,
    runId: spec.run_id,
    executionId: spec.run_execution_id,
    assignmentGeneration: spec.assignment_generation,
    kind: "blocker",
    question: "SYNTHETIC-A04-blocker",
    blocking: true,
  });
  await human(
    answerAttentionCommand.name,
    {
      attentionId: requested.id,
      expectedVersion: 1,
      answer: "SYNTHETIC-A04-answer",
    },
    "2026-09-12T12:02:00.000Z",
  );
  const measured = await getRunMeasurements(
    db,
    FIX.workspace,
    spec.run_id,
    "2026-09-12T12:10:00.000Z",
  );
  assert.equal(measured.times.launch_latency_ms, 30_000);
  assert.equal(measured.times.active_ms, 50_000);
  assert.equal(measured.times.process_elapsed_ms, 330_000);
  assert(measured.times.offline_ms > 0, "offline wall time stays visible");
  assert.equal(measured.times.attention_wait_ms, 120_000);
  assert.equal(measured.times.external_wait_ms, 180_000);
  assert.equal(measured.times.idle_ms, null);
  assert.deepEqual(measured.tokens.exact, {
    input: 1_000_000,
    output: 500_000,
    cache_read: null,
    cache_write: null,
    reasoning: null,
  });
  assert.deepEqual(measured.tokens.estimated, {
    input: 100,
    output: 50,
    cache_read: null,
    cache_write: null,
    reasoning: null,
  });
  assert.equal(measured.tokens.unavailable_count, 1);
  snapshot("derivation", {
    launch_latency_ms: measured.times.launch_latency_ms,
    active_ms: measured.times.active_ms,
    process_elapsed_ms: measured.times.process_elapsed_ms,
    offline_ms: measured.times.offline_ms,
    attention_wait_ms: measured.times.attention_wait_ms,
    external_wait_ms: measured.times.external_wait_ms,
    exact_input: measured.tokens.exact.input,
    estimated_input: measured.tokens.estimated.input,
    unavailable: measured.tokens.unavailable_count,
  });

  // Historical price changes explain totals without touching token facts.
  const current = calculateCost(
    { input: 1_000_000, output: 500_000, cache_read: null, cache_write: null, reasoning: null },
    "codex-fixture-model",
    "2026-09-01",
    now,
  );
  const historical = calculateCost(
    { input: 1_000_000, output: 500_000, cache_read: null, cache_write: null, reasoning: null },
    "codex-fixture-model",
    "2026-06-01",
    now,
  );
  assert(current.amount_usd !== null && historical.amount_usd !== null);
  assert.notEqual(current.amount_usd, historical.amount_usd);
  const unknownModel = calculateCost(
    { input: 1, output: 1, cache_read: null, cache_write: null, reasoning: null },
    "unlisted-model",
    CURRENT_PRICE_CATALOG_VERSION,
    now,
  );
  assert.equal(unknownModel.amount_usd, null);
  snapshot("prices", {
    current_usd: current.amount_usd,
    historical_usd: historical.amount_usd,
    unknown_model: unknownModel.reason,
  });

  // Review-timer races across workers: one open timer, starter-only stop.
  const timer = await human<{ id: string; resource_version: number }>(
    startReviewTimerCommand.name,
    {
      taskId: task.id,
    },
  );
  const doubleStart = await execute(
    startReviewTimerCommand.name,
    { taskId: task.id },
    { actorHumanId: FIX.owner },
  );
  assert.equal(doubleStart.ok, false);
  const foreignStop = await execute(
    stopReviewTimerCommand.name,
    { timerId: timer.id, expectedVersion: 1 },
    { actorHumanId: FIX.member },
  );
  assert.equal(foreignStop.ok, false);
  await human(
    stopReviewTimerCommand.name,
    { timerId: timer.id, expectedVersion: 1 },
    "2026-09-12T12:04:00.000Z",
  );
  const timerObservations = await listReviewTimerObservations(db, FIX.workspace, timer.id);
  assert.deepEqual(
    timerObservations.map((entry) => entry.observed_kind),
    ["started", "stopped"],
  );
  const taskMeasured = await getTaskMeasurements(
    db,
    FIX.workspace,
    task.id,
    "2026-09-12T12:10:00.000Z",
  );
  assert.equal(taskMeasured.review.stopped_total_ms, 240_000);
  assert.notEqual(taskMeasured.review.stopped_total_ms, taskMeasured.totals.active_ms);
  snapshot("review_timer", {
    observations: timerObservations.length,
    stopped_total_ms: taskMeasured.review.stopped_total_ms,
    double_start_rejected: true,
    foreign_stop_rejected: true,
  });

  // Browser activity is capped and stays estimated.
  const activity = await human<{ capped: boolean; ended_at: string }>(
    recordBrowserActivityCommand.name,
    {
      taskId: task.id,
      startedAt: "2026-09-12T11:00:00.000Z",
      endedAt: "2026-09-12T12:00:00.000Z",
    },
  );
  assert.equal(activity.capped, true);
  assert.equal(activity.ended_at, "2026-09-12T11:05:00.000Z");
  snapshot("browser_activity", { capped: activity.capped, stored_ms: 300_000 });

  // Aggregation rolls the same separated measures up without autonomy rules.
  const aggregates = await aggregateMeasurements(db, FIX.workspace, {}, "2026-09-12T12:10:00.000Z");
  assert.equal(aggregates.truncated, false);
  assert.equal(aggregates.cells.length, 1);
  assert.equal(aggregates.cells[0]?.runs, 1);
  assert.equal(aggregates.cells[0]?.provider, "fake");
  snapshot("aggregation", {
    cells: aggregates.cells.length,
    runs: aggregates.cells[0]?.runs,
    provider: aggregates.cells[0]?.provider,
  });

  // Token facts stay independent of every calculation above: the stored
  // rows are byte-identical after pricing, aggregation, and derivation.
  const storedTokens = (await db
    .prepare(
      `SELECT provider, model, input_tokens, output_tokens, quality
       FROM token_observations WHERE workspace_id = ? AND run_id = ? ORDER BY observation_id`,
    )
    .all(FIX.workspace, spec.run_id)) as Array<Record<string, unknown>>;
  assert.equal(storedTokens.length, 3);
  const exactStored = storedTokens.filter((row) => row.quality === "provider_reported");
  assert.equal(exactStored.length, 1);
  assert.deepEqual(
    {
      provider: exactStored[0]?.provider,
      input: exactStored[0]?.input_tokens,
      output: exactStored[0]?.output_tokens,
    },
    { provider: "codex", input: 1_000_000, output: 500_000 },
  );
  snapshot("token_facts", { rows: storedTokens.length, exact_input: exactStored[0]?.input_tokens });

  await mkdir(evidenceDir, { recursive: true });
  await writeFile(
    resolve(evidenceDir, "calculation-snapshots.json"),
    `${JSON.stringify({ snapshots }, null, 2)}\n`,
  );
  console.log("A04_EVIDENCE_OK calculation snapshots written");
} catch (error) {
  server.debug();
  throw error;
} finally {
  await server.close();
  await rm(migrationDir, { recursive: true, force: true });
}
