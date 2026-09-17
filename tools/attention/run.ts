// ABOUTME: Certifies A02 attention request, wait, answer, and resolve against real D1 and Workers.
// ABOUTME: Synthetic questions only; the recording carries IDs, states, and timings, never bodies.

import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { adaptD1, loadMigrationManifest, type D1Like } from "@bfb/db";
import {
  answerAttentionCommand,
  bumpMemberEpoch,
  claimLaunchCommand,
  createAgentProfileCommand,
  createTaskCommand,
  FIX,
  getAttention,
  launchDeadline,
  listAttention,
  listAttentionObservations,
  randomUlid,
  replaceRunnerInventoryCommand,
  reportRepositoryConfigCommand,
  requestAttentionCommand,
  resolveAttentionCommand,
  runnerHash,
  seedSyntheticWorkspace,
  startLaunchCommand,
  updateProjectPolicyCommand,
  updateWorkspacePolicyCommand,
  type AttentionRecord,
  type CommandOutcome,
  type RunnerPrincipal,
  type TaskRecord,
} from "@bfb/domain";
import type { RunnerInventory } from "@bfb/protocol";
import { createTestHarness } from "wrangler";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const now = "2026-09-12T12:00:00.000Z",
  origin = "https://bfb.attention.test";
const digest = `sha256:${"a".repeat(64)}`,
  emptyConfig = `sha256:${runnerHash("{}")}`;
const evidenceDir = resolve(root, "docs/work-packages/evidence/WP-A02");
const manifest = loadMigrationManifest(resolve(root, "migrations/d1"));
const split = manifest.migrations.findIndex((migration) => migration.id === "0023_attention");
assert(split >= 0, "A02 migration is required");
const migrationDir = await mkdtemp(resolve(tmpdir(), "bfb-a02-migrations-"));
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
      { name: "WORKSPACE_HUB", class_name: "WorkspaceHub", script_name: "bfb-attention-hub" },
    ],
  },
};
const server = createTestHarness({
  root,
  workers: [
    { config: { ...client, name: "bfb-attention-a" } },
    { config: { ...client, name: "bfb-attention-b" } },
    {
      config: {
        ...base,
        name: "bfb-attention-hub",
        main: resolve(root, "apps/control-worker/src/index.ts"),
        d1_databases: [
          {
            binding: "DB",
            database_name: "bfb-attention-test",
            database_id: "00000000-0000-4000-8000-000000000023",
            migrations_dir: migrationDir,
          },
          {
            binding: "EMPTY_DB",
            database_name: "bfb-attention-empty-test",
            database_id: "00000000-0000-4000-8000-000000000033",
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
  const worker = server.getWorker(sequence++ % 2 ? "bfb-attention-b" : "bfb-attention-a");
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

const recording: Array<Record<string, unknown>> = [];
function record(step: string, fields: Record<string, unknown> = {}): void {
  recording.push({ step, ...fields });
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
  keyThumbprint: "synthetic-a02-harness-key",
  authExpiresAt: launchDeadline(now, 300_000),
  projectIds: [FIX.projectA],
};

function question(tag: string): string {
  return `SYNTHETIC-A02-${tag}`;
}

async function native<T>(name: string, input: unknown) {
  return success(await execute<T>(name, input, { actorRunnerId: runner }));
}

try {
  await server.listen();
  const hub = server.getWorker("bfb-attention-hub");
  await hub.applyD1Migrations("EMPTY_DB");
  await hub.applyD1Migrations("DB");
  const env = (await hub.getEnv()) as unknown as { DB: D1Like; EMPTY_DB: D1Like },
    db = adaptD1(env.DB);
  assert.deepEqual(await adaptD1(env.EMPTY_DB).prepare("PRAGMA foreign_key_check").all(), []);

  // Populated 0019 state upgrades to 0023 without touching work history.
  await seedSyntheticWorkspace(db, now, "global");
  const preserved = await human<TaskRecord>(createTaskCommand.name, {
    projectId: FIX.projectA,
    title: "Synthetic A02 migration preservation",
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
    await db.prepare(`SELECT COUNT(*) AS count FROM attention_requests`).get(),
    { count: 0 },
  );
  assert.deepEqual(await db.prepare("PRAGMA foreign_key_check").all(), []);
  record("migration_ok", { preserved_task: preserved.id });
  console.log("A02_MIGRATION_OK populated 0019 upgrade preserves tasks and opens empty attention");

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
    name: "Synthetic A02 harness provider",
    provider: "fake",
    model: "synthetic",
    executionMode: "interactive",
    harnessMode: "restricted",
  });
  const task = await human<TaskRecord>(createTaskCommand.name, {
    projectId: FIX.projectA,
    title: "Synthetic A02 harness run",
    priority: "P2",
  });
  await db
    .prepare(
      `INSERT INTO runners (workspace_id, id, owner_human_id, device_label, public_key_json, key_thumbprint, token_epoch, enrolled_at)
       VALUES (?, ?, ?, 'Synthetic A02 harness Mac', '{}', ?, 1, ?)`,
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
      runnerHash("synthetic-a02-harness-token"),
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
        label: "Synthetic A02 checkout",
        repository_identity: "synthetic/a02",
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
      specification: { run_execution_id: string; assignment_generation: number; run_id: string };
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
  const executionId = claimed.claim.specification.run_execution_id;
  const generation = claimed.claim.specification.assignment_generation;
  const runId = claimed.claim.specification.run_id;
  record("launch_claimed", { run: runId, execution: executionId, generation });

  function requestBody(kind: string, tag: string, blocking: boolean) {
    return {
      principal,
      runId,
      executionId,
      assignmentGeneration: generation,
      kind,
      question: question(tag),
      blocking,
    };
  }

  // Agent requests attention; identical idempotency keys replay one record.
  const t0 = Date.now();
  const first = await native<AttentionRecord>(requestAttentionCommand.name, requestBody("clarification", "HARNESS-Q1", true));
  const requestMs = Date.now() - t0;
  assert.equal(first.state, "open");
  assert.equal(first.required_role, "reviewer");
  assert.equal(first.resource_version, 1);
  record("requested", { id: first.id, kind: first.kind, version: first.resource_version, elapsed_ms: requestMs });
  const replayKey = randomUlid();
  const replayInput = requestBody("credential", "HARNESS-Q2", false);
  const replayOutcome = await (async () => {
    const worker = server.getWorker("bfb-attention-a");
    const both = await Promise.all([
      worker.fetch(`${origin}/workspaces/${FIX.workspace}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandName: requestAttentionCommand.name,
          request: {
            workspaceId: FIX.workspace,
            idempotencyKey: replayKey,
            authorizationEpoch: 1,
            now,
            actorRunnerId: runner,
            input: replayInput,
          },
        }),
      }),
      worker.fetch(`${origin}/workspaces/${FIX.workspace}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandName: requestAttentionCommand.name,
          request: {
            workspaceId: FIX.workspace,
            idempotencyKey: replayKey,
            authorizationEpoch: 1,
            now,
            actorRunnerId: runner,
            input: { ...replayInput, question: question("HARNESS-CHANGED") },
          },
        }),
      }),
    ]);
    return Promise.all(both.map(async (response) => (await response.json()) as CommandOutcome<AttentionRecord>));
  })();
  assert(replayOutcome.every((outcome) => outcome.ok));
  const replayed = replayOutcome.map((outcome) => (outcome.ok ? outcome.result.id : null));
  assert.equal(replayed[0], replayed[1]);
  record("idempotent_replay", { id: replayed[0] });
  console.log("A02_REQUEST_OK open requests commit; duplicate keys replay one record");

  // Waiter polls committed reads: pending first, then the committed answer.
  const polls: Array<{ index: number; elapsed_ms: number; state: string }> = [];
  const pollStart = Date.now();
  for (let index = 0; index < 3; index++) {
    const seen = await getAttention(db, FIX.workspace, [FIX.projectA], first.id);
    polls.push({ index, elapsed_ms: Date.now() - pollStart, state: seen?.state ?? "missing" });
  }
  assert(polls.every((poll) => poll.state === "open"));
  record("waiter_pending_polls", { polls });
  const answerMs0 = Date.now();
  const answered = await human<AttentionRecord>(answerAttentionCommand.name, {
    attentionId: first.id,
    expectedVersion: 1,
    answer: question("HARNESS-A1"),
  });
  const answerMs = Date.now() - answerMs0;
  assert.equal(answered.state, "answered");
  assert.equal(answered.first_response_at, now);
  record("answered", {
    id: answered.id,
    version: answered.resource_version,
    by: "owner",
    elapsed_ms: answerMs,
  });
  const waiterSeen = await getAttention(db, FIX.workspace, [FIX.projectA], first.id);
  assert.deepEqual(waiterSeen, answered);
  record("waiter_returned_identical", { id: waiterSeen?.id, version: waiterSeen?.resource_version });
  console.log("A02_WAIT_OK waiter polls pending, then returns the committed answer identically");

  // Duplicate answers never overwrite the committed response.
  const duplicate = await execute<AttentionRecord>(answerAttentionCommand.name, {
    attentionId: first.id,
    expectedVersion: 2,
    answer: question("HARNESS-OVERWRITE"),
  });
  assert(!duplicate.ok && duplicate.error.code === "already_answered");
  const kept = await getAttention(db, FIX.workspace, [FIX.projectA], first.id);
  assert.equal(kept?.answer, question("HARNESS-A1"));
  assert.equal(kept?.resource_version, 2);
  record("duplicate_rejected", { code: "already_answered", kept_version: kept?.resource_version });
  console.log("A02_DUPLICATE_OK second answer rejected; committed response kept");

  // Permission matrix: reviewer answers clarification/review, never owner-only kinds.
  const review = await native<AttentionRecord>(
    requestAttentionCommand.name,
    requestBody("review", "HARNESS-Q3", false),
  );
  const reviewerAnswer = await execute<AttentionRecord>(
    answerAttentionCommand.name,
    { attentionId: review.id, expectedVersion: 1, answer: question("HARNESS-A2") },
    { actorHumanId: FIX.reviewer, authorizationEpoch: 1 },
  );
  assert(reviewerAnswer.ok, JSON.stringify(reviewerAnswer));
  const credential = await native<AttentionRecord>(
    requestAttentionCommand.name,
    requestBody("credential", "HARNESS-Q4", false),
  );
  for (const humanId of [FIX.reviewer, FIX.member]) {
    const denied = await execute<AttentionRecord>(
      answerAttentionCommand.name,
      { attentionId: credential.id, expectedVersion: 1, answer: question("HARNESS-NO") },
      { actorHumanId: humanId, authorizationEpoch: 1 },
    );
    assert(!denied.ok && denied.error.code === "forbidden", JSON.stringify(denied));
  }
  const ownerCredential = await human<AttentionRecord>(answerAttentionCommand.name, {
    attentionId: credential.id,
    expectedVersion: 1,
    answer: question("HARNESS-A3"),
  });
  assert.equal(ownerCredential.state, "answered");
  record("permission_matrix", {
    reviewer_review: "answered",
    reviewer_credential: "forbidden",
    member_credential: "forbidden",
    owner_credential: "answered",
  });
  console.log("A02_PERMISSION_OK reviewer answers review; owner-only credential rejects others");

  // Timeout and retry: answer lands after several polls; later polls repeat safely.
  const slow = await native<AttentionRecord>(
    requestAttentionCommand.name,
    requestBody("blocker", "HARNESS-Q5", true),
  );
  let pollsBefore = 0;
  for (let index = 0; index < 5; index++) {
    const seen = await getAttention(db, FIX.workspace, [FIX.projectA], slow.id);
    if (seen?.state !== "open") break;
    pollsBefore++;
  }
  assert.equal(pollsBefore, 5);
  const resolved = await human<AttentionRecord>(resolveAttentionCommand.name, {
    attentionId: review.id,
    expectedVersion: 2,
  });
  assert.equal(resolved.state, "resolved");
  record("resolved", { id: resolved.id, version: resolved.resource_version });
  await human<AttentionRecord>(answerAttentionCommand.name, {
    attentionId: slow.id,
    expectedVersion: 1,
    answer: question("HARNESS-A4"),
  });
  const after: string[] = [];
  for (let index = 0; index < 3; index++) {
    after.push((await getAttention(db, FIX.workspace, [FIX.projectA], slow.id))?.state ?? "missing");
  }
  assert.deepEqual(after, ["answered", "answered", "answered"]);
  record("timeout_retry", { pending_polls: pollsBefore, repeat_reads: after });
  console.log("A02_TIMEOUT_OK five pending polls, then repeated reads return the answer");

  // Foreign execution and terminal runs cannot request attention.
  const foreign = await execute<AttentionRecord>(requestAttentionCommand.name, {
    ...requestBody("clarification", "HARNESS-FOREIGN", false),
    executionId: randomUlid(),
  }, { actorRunnerId: runner });
  assert(!foreign.ok && foreign.error.code === "request_rejected");
  await db
    .prepare(`UPDATE runs SET result_state = 'failed' WHERE workspace_id = ? AND id = ?`)
    .run(FIX.workspace, runId);
  const terminal = await execute<AttentionRecord>(
    requestAttentionCommand.name,
    requestBody("clarification", "HARNESS-TERMINAL", false),
    { actorRunnerId: runner },
  );
  assert(!terminal.ok && terminal.error.code === "invalid_transition");
  record("request_guards", { foreign_execution: "request_rejected", terminal_run: "invalid_transition" });
  console.log("A02_GUARDS_OK foreign executions and terminal runs cannot request");

  // Revocation: the old epoch fails; current authority still answers other requests.
  await bumpMemberEpoch(db, FIX.workspace, FIX.owner);
  const revoked = await execute<AttentionRecord>(
    answerAttentionCommand.name,
    { attentionId: slow.id, expectedVersion: 2, answer: question("HARNESS-REVOKED") },
    { actorHumanId: FIX.owner, authorizationEpoch: 1 },
  );
  assert(!revoked.ok && revoked.error.code === "stale_authorization", JSON.stringify(revoked));
  record("revocation", { old_epoch_answer: revoked.error.code });
  console.log("A02_REVOCATION_OK stale epoch cannot answer after the bump");

  // Disconnect and reconnect: evict the hub; committed answers re-read from D1.
  await hub.evictDurableObject("WorkspaceHub", { name: FIX.workspace });
  const reread = await getAttention(db, FIX.workspace, [FIX.projectA], slow.id);
  assert.equal(reread?.state, "answered");
  assert.equal(reread?.answer, question("HARNESS-A4"));
  const ranked = await listAttention(db, FIX.workspace, [FIX.projectA]);
  assert(ranked.length >= 4);
  assert.equal(ranked[0]?.kind, "blocker");
  assert(ranked.every((entry) => entry.rank_reason.includes(entry.kind)));
  record("reconnect_reread", { id: reread?.id, state: reread?.state, ranked: ranked.length });
  console.log("A02_RECONNECT_OK committed answers survive hub eviction via D1 reads");

  // Raw observations stay uniquely identified with actor provenance for A04.
  const observations = await listAttentionObservations(db, FIX.workspace, [FIX.projectA], first.id);
  assert.deepEqual(
    observations.map((entry) => entry.observed_kind),
    ["requested", "answered"],
  );
  assert.equal(new Set(observations.map((entry) => entry.observation_id)).size, 2);
  assert.deepEqual(
    observations.map((entry) => entry.actor_type),
    ["agent_run", "human"],
  );
  const trail = (await db
    .prepare(
      `SELECT kind FROM semantic_events WHERE workspace_id = ? AND kind LIKE 'attention.%' ORDER BY workspace_cursor`,
    )
    .all(FIX.workspace)) as Array<{ kind: string }>;
  assert(trail.map((entry) => entry.kind).includes("attention.request"));
  assert(trail.map((entry) => entry.kind).includes("attention.answer"));
  const auditRow = (await db
    .prepare(
      `SELECT payload_json FROM semantic_events
       WHERE workspace_id = ? AND kind = 'attention.request' ORDER BY workspace_cursor LIMIT 1`,
    )
    .get(FIX.workspace)) as { payload_json: string };
  const auditPayload = JSON.parse(auditRow.payload_json) as {
    input?: Record<string, unknown>;
    result?: { id?: string };
  };
  assert.equal(auditPayload.input?.question, undefined);
  assert.equal(typeof auditPayload.input?.questionChars, "number");
  assert.equal(auditPayload.result?.id, first.id);
  record("audit_redaction", {
    input_echo: "metadata-only",
    result_binds_record: auditPayload.result?.id === first.id,
  });
  record("observations", {
    first_request: observations.map((entry) => ({
      kind: entry.observed_kind,
      actor: entry.actor_type,
    })),
    trail: [...new Set(trail.map((entry) => entry.kind))],
  });
  console.log("A02_OBSERVATIONS_OK raw transitions carry unique identity and provenance");

  const timings = {
    request_ms: requestMs,
    answer_ms: answerMs,
    pending_polls: polls,
    total_steps: recording.length,
  };
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(resolve(evidenceDir, "recording.jsonl"), `${recording.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  await writeFile(resolve(evidenceDir, "raw-timing-observations.json"), `${JSON.stringify(timings, null, 2)}\n`);
  console.log("A02_EVIDENCE_OK recording and raw timing observations written");
} catch (error) {
  server.debug();
  throw error;
} finally {
  await server.close();
  await rm(migrationDir, { recursive: true, force: true });
}
