// ABOUTME: Fault-injects duplicate, out-of-order, concurrent, delayed and poison events across Workers and D1.
// ABOUTME: All identities are synthetic; the harness asserts exactly-once ledger effects and absolute projections.

import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { adaptD1, createAuthorizationContext, loadMigrationManifest, type D1Like } from "@bfb/db";
import {
  claimLaunchCommand,
  createAgentProfileCommand,
  createTaskCommand,
  FIX,
  ingestRunnerEventsCommand,
  launchDeadline,
  listLedgerEvents,
  randomUlid,
  readLedgerHighWater,
  replaceRunnerInventoryCommand,
  reportRepositoryConfigCommand,
  runnerHash,
  seedSyntheticWorkspace,
  startLaunchCommand,
  updateProjectPolicyCommand,
  updateWorkspacePolicyCommand,
  type CommandOutcome,
  type IngestRunnerEventsResult,
  type RunnerPrincipal,
  type TaskRecord,
} from "@bfb/domain";
import type { RunnerInventory } from "@bfb/protocol";
import { createTestHarness } from "wrangler";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const now = "2026-09-12T12:00:00.000Z",
  origin = "https://bfb.events.test";
const digest = `sha256:${"a".repeat(64)}`,
  emptyConfig = `sha256:${runnerHash("{}")}`;
const manifest = loadMigrationManifest(resolve(root, "migrations/d1"));
const split = manifest.migrations.findIndex((migration) => migration.id === "0019_event_ledger");
assert(split >= 0, "E01 migration is required");
const migrationDir = await mkdtemp(resolve(tmpdir(), "bfb-e01-migrations-"));
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
    bindings: [{ name: "WORKSPACE_HUB", class_name: "WorkspaceHub", script_name: "bfb-events-hub" }],
  },
};
const server = createTestHarness({
  root,
  workers: [
    { config: { ...client, name: "bfb-events-a" } },
    { config: { ...client, name: "bfb-events-b" } },
    {
      config: {
        ...base,
        name: "bfb-events-hub",
        main: resolve(root, "apps/control-worker/src/index.ts"),
        d1_databases: [
          {
            binding: "DB",
            database_name: "bfb-events-test",
            database_id: "00000000-0000-4000-8000-000000000019",
            migrations_dir: migrationDir,
          },
          {
            binding: "EMPTY_DB",
            database_name: "bfb-events-empty-test",
            database_id: "00000000-0000-4000-8000-000000000029",
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
) {
  const worker = server.getWorker(sequence++ % 2 ? "bfb-events-b" : "bfb-events-a");
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

const runner = randomUlid(),
  checkout = randomUlid(),
  tokenId = randomUlid(),
  streamA = randomUlid(),
  streamB = randomUlid();
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
  keyThumbprint: "synthetic-e01-harness-key",
  authExpiresAt: launchDeadline(now, 300_000),
  projectIds: [FIX.projectA],
};

function item(
  executionId: string,
  generation: number,
  stream: string,
  order: number,
  kind = "heartbeat",
  extra: Record<string, unknown> = {},
) {
  return {
    schema_version: 1,
    event_id: randomUlid(),
    source_stream_id: stream,
    source_sequence: order,
    run_execution_id: executionId,
    assignment_generation: generation,
    kind,
    occurred_at: now,
    capture_origin: "runner_observed",
    payload: {},
    ...extra,
  };
}

async function nativeIngest(events: unknown[]) {
  return success(
    await execute<IngestRunnerEventsResult>(
      ingestRunnerEventsCommand.name,
      { principal, events },
      { actorRunnerId: runner },
    ),
  );
}

try {
  await server.listen();
  const hub = server.getWorker("bfb-events-hub");
  await hub.applyD1Migrations("EMPTY_DB");
  await hub.applyD1Migrations("DB");
  const env = (await hub.getEnv()) as unknown as { DB: D1Like; EMPTY_DB: D1Like },
    db = adaptD1(env.DB);
  assert.deepEqual(await adaptD1(env.EMPTY_DB).prepare("PRAGMA foreign_key_check").all(), []);

  // Populated 0018 state upgrades to 0019 without touching launch history.
  await seedSyntheticWorkspace(db, now, "global");
  const preserved = await human<TaskRecord>(createTaskCommand.name, {
    projectId: FIX.projectA,
    title: "Synthetic E01 migration preservation",
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
  assert.deepEqual(
    await db.prepare(`SELECT COUNT(*) AS count FROM event_ledger`).get(),
    { count: 0 },
  );
  console.log("E01_MIGRATION_OK populated 0018 upgrade preserves tasks and opens an empty ledger");

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
    name: "Synthetic E01 harness provider",
    provider: "fake",
    model: "synthetic",
    executionMode: "interactive",
    harnessMode: "restricted",
  });
  const task = await human<TaskRecord>(createTaskCommand.name, {
    projectId: FIX.projectA,
    title: "Synthetic E01 harness run",
    priority: "P2",
  });
  assert.notEqual(task.id, preserved.id);
  await db
    .prepare(
      `INSERT INTO runners (workspace_id, id, owner_human_id, device_label, public_key_json, key_thumbprint, token_epoch, enrolled_at)
       VALUES (?, ?, ?, 'Synthetic E01 harness Mac', '{}', ?, 1, ?)`,
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
      runnerHash("synthetic-e01-harness-token"),
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
        label: "Synthetic E01 checkout",
        repository_identity: "synthetic/e01",
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
  await success(
    await execute(replaceRunnerInventoryCommand.name, { principal, inventory }, { actorRunnerId: runner }),
  );
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
  const claimed = success(
    await execute<{ state: string; claim: { specification: { run_execution_id: string; assignment_generation: number; run_id: string } } }>(
      claimLaunchCommand.name,
      {
        principal,
        claim: {
          schema_version: 1,
          launch_id: launch.launch_id,
          runner_id: runner,
          idempotency_key: randomUlid(),
          claimed_at: now,
        },
      },
      { actorRunnerId: runner },
    ),
  );
  assert.equal(claimed.state, "claimed");
  const executionId = claimed.claim.specification.run_execution_id;
  const generation = claimed.claim.specification.assignment_generation;
  const runId = claimed.claim.specification.run_id;

  // F1 duplicate transport plus acknowledgement loss: one effect, absolute totals.
  const duplicate = [item(executionId, generation, streamA, 1), item(executionId, generation, streamA, 2, "turn_started")];
  const first = await nativeIngest(duplicate);
  assert.deepEqual(
    first.dispositions.map((entry) => entry.disposition),
    ["accepted", "accepted"],
  );
  const lost = await nativeIngest(duplicate);
  assert.deepEqual(
    lost.dispositions.map((entry) => entry.disposition),
    ["already_committed", "already_committed"],
  );

  // F2 out-of-order delivery commits in batch order with ordered cursors.
  const shuffled = await nativeIngest([
    item(executionId, generation, streamA, 4),
    item(executionId, generation, streamA, 3),
  ]);
  assert.deepEqual(
    shuffled.dispositions.map((entry) => entry.disposition),
    ["accepted", "accepted"],
  );

  // F3 concurrent batches across both Workers: disjoint ranges, single effects.
  const concurrent = await Promise.all([
    nativeIngest([item(executionId, generation, streamB, 1), item(executionId, generation, streamB, 2)]),
    nativeIngest([item(executionId, generation, streamB, 3), item(executionId, generation, streamB, 4, "tool_finished")]),
  ]);
  for (const outcome of concurrent) {
    assert.deepEqual(
      outcome.dispositions.map((entry) => entry.disposition),
      ["accepted", "accepted"],
    );
  }
  const ledger = (await db
    .prepare(`SELECT event_id, workspace_cursor FROM event_ledger WHERE workspace_id = ? ORDER BY workspace_cursor`)
    .all(FIX.workspace)) as Array<{ event_id: string; workspace_cursor: number }>;
  assert.equal(ledger.length, 8);
  assert.equal(new Set(ledger.map((row) => row.event_id)).size, 8);
  assert.equal(new Set(ledger.map((row) => row.workspace_cursor)).size, 8);

  // F4 delayed offline rows attach to their original run after a second run exists.
  // C09 forbids parallel reservations on one physical worktree, so the second
  // run gets its own checkout identity.
  const checkout2 = randomUlid();
  await success(
    await execute(
      replaceRunnerInventoryCommand.name,
      {
        principal,
        inventory: {
          ...inventory,
          revision: 2,
          checkouts: [
            ...inventory.checkouts,
            {
              ...inventory.checkouts[0]!,
              checkout_id: checkout2,
              physical_worktree_hash: `sha256:${"b".repeat(64)}`,
              label: "Synthetic E01 second checkout",
              is_default: false,
            },
          ],
        },
      },
      { actorRunnerId: runner },
    ),
  );
  const task2 = await human<TaskRecord>(createTaskCommand.name, {
    projectId: FIX.projectA,
    title: "Synthetic E01 second run",
    priority: "P2",
  });
  const launch2 = await human<{ launch_id: string }>(startLaunchCommand.name, {
    schema_version: 1,
    idempotency_key: randomUlid(),
    task_id: task2.id,
    expected_task_version: 1,
    runner_id: runner,
    checkout_id: checkout2,
    agent_profile_id: profile.id,
    agent_profile_version: 1,
    workspace_policy_version: 2,
    project_policy_version: 2,
    repository_config_version: 2,
  });
  void launch2;
  const delayed = await nativeIngest([
    { ...item(executionId, generation, streamA, 9, "progress_reported"), occurred_at: "2026-09-10T12:00:00.000Z" },
  ]);
  assert.deepEqual(
    delayed.dispositions.map((entry) => entry.disposition),
    ["accepted"],
  );
  assert.deepEqual(
    await db
      .prepare(`SELECT run_id FROM event_ledger WHERE workspace_id = ? AND source_sequence = 9`)
      .get(FIX.workspace),
    { run_id: runId },
  );

  // F5 poison rows: per-event terminal dispositions, later rows still commit.
  const poisoned = await nativeIngest([
    { ...item(executionId, generation, streamA, 10, "heartbeat"), payload: { intruder: 1 } },
    { ...item(executionId, generation, streamA, 11), run_execution_id: randomUlid() },
    { ...item(executionId, generation, streamA, 12), assignment_generation: 99 },
    { ...item(executionId, generation, streamA, 13), occurred_at: "2026-09-12T12:06:00.000Z" },
    item(executionId, generation, streamA, 14),
  ]);
  assert.deepEqual(
    poisoned.dispositions.map((entry) => entry.disposition),
    [
      "permanently_rejected",
      "permanently_rejected",
      "permanently_rejected",
      "permanently_rejected",
      "accepted",
    ],
  );
  const poisonDiagnostics = poisoned.dispositions
    .filter((entry) => entry.disposition === "permanently_rejected")
    .map((entry) => ("diagnostic" in entry ? entry.diagnostic : undefined));
  assert.equal(poisonDiagnostics.length, 4);
  assert.ok(
    poisonDiagnostics.every(
      (diagnostic) => diagnostic && diagnostic.code.length > 0 && diagnostic.message.length > 0,
    ),
  );
  assert.deepEqual(
    poisonDiagnostics.slice(1).map((diagnostic) => diagnostic?.code),
    ["unknown_execution", "assignment_generation_confusion", "future_timestamp"],
  );

  // F6 acknowledgement loss after poison: committed rows report already_committed,
  // absolute totals never double increment.
  const totals = async () => ({
    ledger: ((await db.prepare(`SELECT COUNT(*) AS total FROM event_ledger WHERE workspace_id = ?`).get(FIX.workspace)) as { total: number }).total,
    observations: ((await db.prepare(`SELECT COUNT(*) AS total FROM measurement_observations WHERE workspace_id = ?`).get(FIX.workspace)) as { total: number }).total,
    runCount: ((await db.prepare(`SELECT event_count FROM run_event_projections WHERE workspace_id = ? AND run_id = ?`).get(FIX.workspace, runId)) as { event_count: number }).event_count,
    heartbeats: ((await db.prepare(`SELECT heartbeat_count FROM execution_event_projections WHERE workspace_id = ? AND run_execution_id = ?`).get(FIX.workspace, executionId)) as { heartbeat_count: number }).heartbeat_count,
  });
  const settled = await totals();
  const replay = await nativeIngest(duplicate);
  assert.deepEqual(
    replay.dispositions.map((entry) => entry.disposition),
    ["already_committed", "already_committed"],
  );
  assert.deepEqual(await totals(), settled);

  // F7 rows for another runner and F8 non-result rows.
  const foreign = await nativeIngest([
    { ...item(executionId, generation, streamB, 9), run_execution_id: randomUlid() },
  ]);
  assert.equal(foreign.dispositions[0]?.disposition, "permanently_rejected");
  const telemetry = await nativeIngest([
    item(executionId, generation, streamB, 10, "result_submitted"),
    item(executionId, generation, streamB, 11, "execution_ended"),
    item(executionId, generation, streamB, 12),
  ]);
  assert.deepEqual(
    telemetry.dispositions.map((entry) => entry.disposition),
    ["accepted", "accepted", "accepted"],
  );
  assert.deepEqual(
    await db.prepare(`SELECT result_state FROM runs WHERE workspace_id = ? AND id = ?`).get(FIX.workspace, runId),
    { result_state: "open" },
  );

  // F9 replay and high-water reads over committed D1 state.
  const authorization = createAuthorizationContext({
    workspaceId: FIX.workspace,
    principalId: FIX.owner,
    authorizationEpoch: 1,
    jurisdiction: "global",
  });
  const highWater = await readLedgerHighWater(db, authorization);
  const maxCursor = (
    (await db
      .prepare(`SELECT MAX(workspace_cursor) AS max_cursor FROM event_ledger WHERE workspace_id = ?`)
      .get(FIX.workspace)) as { max_cursor: number }
  ).max_cursor;
  assert.equal(highWater, maxCursor);
  const replayed = await listLedgerEvents(db, authorization, { afterCursor: 0, throughCursor: highWater });
  assert.equal(replayed.length, (await totals()).ledger);
  assert.deepEqual(
    replayed.map((entry) => entry.workspace_cursor),
    [...replayed.map((entry) => entry.workspace_cursor)].sort((a, b) => a - b),
  );
  for (const envelope of replayed) {
    assert.equal(envelope.workspace_id, FIX.workspace);
    assert.equal(envelope.run_execution_id, executionId);
    assert.ok(envelope.actor.id.length > 0 && envelope.source.id === runner);
  }

  // Actor/provenance matrix, raw-observation boundary, projection invariants.
  assert.deepEqual(await db
    .prepare(
      `SELECT actor_type, COUNT(*) AS total FROM event_ledger WHERE workspace_id = ? GROUP BY actor_type ORDER BY actor_type`,
    )
    .all(FIX.workspace), [
    { actor_type: "runner", total: (await totals()).ledger },
  ]);
  const provenance = (await db
    .prepare(
      `SELECT DISTINCT capture_origin, actor_type FROM event_ledger WHERE workspace_id = ? ORDER BY 1, 2`,
    )
    .all(FIX.workspace)) as Array<{ capture_origin: string; actor_type: string }>;
  assert.ok(provenance.length > 0);
  assert.ok(
    provenance.every((row) =>
      row.capture_origin === "runner_observed" ? row.actor_type === "runner" : true,
    ),
  );
  assert.deepEqual(await db.prepare("PRAGMA foreign_key_check").all(), []);
  const finalTotals = await totals();
  console.log(
    JSON.stringify({
      workers: 2,
      migration: manifest.migration_head,
      committedEvents: finalTotals.ledger,
      observations: finalTotals.observations,
      runProjectionCount: finalTotals.runCount,
      heartbeatCount: finalTotals.heartbeats,
      duplicateAckLoss: true,
      outOfOrder: true,
      concurrentBatches: 2,
      delayedAttach: true,
      poisonDispositions: 4,
      foreignRunnerRejected: true,
      noResultInference: true,
      replayEnvelopes: replayed.length,
    }),
  );
  console.log("E01_D1_OK");
} catch (error) {
  server.debug();
  throw error;
} finally {
  await server.close();
  await rm(migrationDir, { recursive: true, force: true });
}
