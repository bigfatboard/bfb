// ABOUTME: Proves scoped operations totals and final source authority on disposable real D1.
// ABOUTME: Production Hub fixture creation and synthetic retained history never execute queues or providers.

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adaptD1, loadMigrationManifest, type D1Like, type SqlDatabase } from "@bfb/db";
import {
  FIX,
  randomUlid,
  readOperationsProjection,
  readQueueState,
  recoveryActionId,
  seedSyntheticWorkspace,
  listStuckUploads,
  listRetentionEligibleChunks,
  type CommandOutcome,
  type TaskRecord,
  type TaskAccessContext,
} from "@bfb/domain";
import { createTestHarness } from "wrangler";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const now = new Date().toISOString();
const old = new Date(Date.parse(now) - 40 * 24 * 60 * 60_000).toISOString();
const server = createTestHarness({
  root,
  workers: [
    { configPath: "tools/work-records/wrangler-a.toml" },
    { configPath: "tools/work-records/wrangler-b.toml" },
    { configPath: "tools/work-records/wrangler-hub.toml" },
  ],
});
const checks: string[] = [];
const emptyQueues = {
  notifications: { pending: 0, dead_lettered: 0, failed: 0 },
  github_outbox: { pending: 0, dispatched_stale: 0, dlq: 0 },
  ops_recovery: { applied: 0, failed: 0 },
};
function access(epoch: number): TaskAccessContext {
  return { workspaceId: FIX.workspace, humanId: FIX.owner, authorizationEpoch: epoch };
}
async function execute<T>(name: string, input: unknown): Promise<T> {
  const response = await server
    .getWorker("bfb-work-records-a")
    .fetch(`https://bfb.aggregates.test/workspaces/${FIX.workspace}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandName: name,
        request: {
          workspaceId: FIX.workspace,
          actorHumanId: FIX.owner,
          authorizationEpoch: 2,
          idempotencyKey: randomUlid(),
          now,
          input,
        },
      }),
    });
  assert.equal(response.status, 200);
  const outcome = (await response.json()) as CommandOutcome<T>;
  assert(outcome.ok, outcome.ok ? undefined : outcome.error.code);
  return outcome.result;
}
function beforeSelection(db: SqlDatabase, change: () => Promise<void>): SqlDatabase {
  let changed = false;
  return {
    ...db,
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        ...statement,
        async get(...parameters: unknown[]) {
          if (!changed) {
            changed = true;
            await change();
          }
          return statement.get(...parameters);
        },
      };
    },
  };
}

try {
  await server.listen();
  const worker = server.getWorker("bfb-work-records-hub");
  await worker.applyD1Migrations("DB");
  const binding = ((await worker.getEnv()) as unknown as { DB: D1Like }).DB;
  const db = adaptD1(binding);
  const independent = adaptD1(binding);
  const manifest = loadMigrationManifest(resolve(root, "migrations/d1"));
  await seedSyntheticWorkspace(db, now);

  async function advanceEpoch(epoch: number) {
    await independent
      .prepare(
        "UPDATE workspace_authorization_epochs SET authorization_epoch=? WHERE workspace_id=? AND human_id=?",
      )
      .run(epoch, FIX.workspace, FIX.owner);
    await independent
      .prepare(
        "UPDATE workspace_members SET authorization_epoch=? WHERE workspace_id=? AND human_id=?",
      )
      .run(epoch, FIX.workspace, FIX.owner);
  }
  assert.deepEqual(await readQueueState(db, FIX.workspace, now, access(1)), emptyQueues);
  await assert.rejects(
    readOperationsProjection(
      beforeSelection(db, () => advanceEpoch(2)),
      FIX.workspace,
      now,
      { uploads: [], launches: [] },
      access(1),
    ),
    { code: "not_found", message: "operations scope not found" },
  );
  await assert.rejects(readQueueState(db, FIX.workspace, now, undefined as never), {
    code: "invalid_argument",
  });
  checks.push("real_d1_empty_aggregate_scope_rechecks_epoch_and_requires_context");

  const records: Array<{ taskId: string; runId: string }> = [];
  for (const title of ["Synthetic aggregate shared work", "Synthetic aggregate private fixture"]) {
    const task = await execute<TaskRecord>("task.create", {
      projectId: FIX.projectA,
      title,
      priority: "P1",
      nextOwnerType: "human",
      nextOwnerId: FIX.owner,
    });
    const created = await execute<{ run: { id: string } }>("run.create", {
      taskId: task.id,
      expectedTaskVersion: 1,
      agentProfileId: FIX.profileCodex,
      workspacePolicyVersion: 1,
      projectPolicyVersion: 1,
      repositoryConfigVersion: 1,
      agentProfileVersion: 1,
    });
    records.push({ taskId: task.id, runId: created.run.id });
  }
  const [shared, privateWork] = records as [(typeof records)[number], (typeof records)[number]];
  await db
    .prepare(
      "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
    )
    .run(FIX.workspace, privateWork.taskId, FIX.owner, now);

  let cursor = 1000;
  async function semantic(runId: string, payload?: string, kind = "result.fail") {
    const value =
      payload ??
      JSON.stringify({
        actor: {},
        input: { runId },
        result: { runResultState: "failed" },
      });
    const eventCursor = ++cursor;
    await db
      .prepare(
        "INSERT INTO semantic_events (workspace_id,event_id,workspace_cursor,kind,payload_json,created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(FIX.workspace, randomUlid(), eventCursor, kind, value, old);
    return eventCursor;
  }
  async function notification(
    eventCursor: number,
    state: string,
    eventKind = "result.fail",
    category = "run_failed",
  ) {
    await db
      .prepare(
        `INSERT INTO notification_deliveries
      (workspace_id,delivery_id,channel,human_id,event_cursor,event_kind,category,state,created_at,updated_at)
      VALUES (?,?,'macos',?,?,?,?,?,?,?)`,
      )
      .run(
        FIX.workspace,
        randomUlid(),
        FIX.reviewer,
        eventCursor,
        eventKind,
        category,
        state,
        old,
        old,
      );
  }
  const sharedCursor = await semantic(shared.runId);
  const privateCursor = await semantic(privateWork.runId);
  for (const state of ["pending", "dead_lettered", "failed"]) {
    await notification(sharedCursor, state);
    await notification(privateCursor, state);
  }
  await notification(sharedCursor, "pending", "result.fail", "result_submitted");
  const unknownCursor = await semantic(shared.runId, undefined, "task.update");
  await notification(unknownCursor, "pending", "task.update");
  const stringCursor = await semantic(
    shared.runId,
    JSON.stringify(
      JSON.stringify({
        actor: {},
        input: { runId: shared.runId },
        result: { runResultState: "failed" },
      }),
    ),
  );
  await notification(stringCursor, "pending");
  assert.deepEqual((await readQueueState(db, FIX.workspace, now, access(2))).notifications, {
    pending: 1,
    dead_lettered: 1,
    failed: 1,
  });
  await db
    .prepare(
      "UPDATE workspace_authorization_epochs SET revoked_at=? WHERE workspace_id=? AND human_id=?",
    )
    .run(now, FIX.workspace, FIX.reviewer);
  assert.deepEqual((await readQueueState(db, FIX.workspace, now, access(2))).notifications, {
    pending: 1,
    dead_lettered: 1,
    failed: 1,
  });
  checks.push("real_d1_notification_operator_counts_bind_exact_shared_source_not_recipient");

  for (const [installationId, status] of [
    ["123", "active"],
    ["124", "revoked"],
  ]) {
    await db
      .prepare(
        `INSERT INTO github_app_installations
      (workspace_id,installation_id,app_id,app_slug,account_id,account_login,account_type,status,
       permissions_json,events_json,created_at,updated_at,resource_version)
      VALUES (?,?, '234','synthetic','345','synthetic','Organization',?,'{}','[]',?,?,1)`,
      )
      .run(FIX.workspace, installationId, status, old, old);
  }
  await db
    .prepare(
      `INSERT INTO github_repository_links
    (workspace_id,id,repository_id,installation_id,project_id,full_name,default_branch,link_state,created_at,resource_version)
    VALUES (?,?,'456','123',?,'synthetic/repository','main','active',?,1)`,
    )
    .run(FIX.workspace, randomUlid(), FIX.projectA, old);
  async function github(
    options: {
      ref?: string;
      state?: string;
      event?: string;
      action?: string | null;
      effect?: unknown;
      installation?: string;
    } = {},
  ) {
    const outboxId = randomUlid(),
      deliveryId = randomUlid();
    const event = options.event ?? "push",
      action = options.action ?? null;
    const installationId = options.installation ?? "123";
    const lifecycle = event === "installation";
    const effect = options.effect ?? {
      event,
      action,
      installationId,
      repositoryId: lifecycle ? null : "456",
      occurredAt: old,
      ref: lifecycle ? null : (options.ref ?? "safe"),
      version: lifecycle ? null : "c".repeat(40),
      detail: {},
    };
    await db
      .prepare(
        `INSERT INTO github_webhook_deliveries
      (workspace_id,delivery_id,event,action,installation_id,repository_id,effect_json,state,received_at)
      VALUES (?,?,?,?,?,?,?,'received',?)`,
      )
      .run(
        FIX.workspace,
        deliveryId,
        event,
        action,
        installationId,
        lifecycle ? null : "456",
        JSON.stringify(effect),
        old,
      );
    await db
      .prepare(
        `INSERT INTO github_integration_outbox
      (workspace_id,outbox_id,delivery_id,kind,state,attempts,next_attempt_at,created_at,updated_at)
      VALUES (?,?,?,'github.reconcile',?,0,?,?,?)`,
      )
      .run(FIX.workspace, outboxId, deliveryId, options.state ?? "pending", old, old, old);
    return { outboxId, deliveryId };
  }
  async function evidence(kind: string, ref: string, taskId: string) {
    await db
      .prepare(
        `INSERT INTO github_evidence
      (workspace_id,id,project_id,task_id,repository_id,kind,ref,version_token,state_json,observed_by,observed_at,resource_version)
      VALUES (?,?,?,?,'456',?,?,'later-version','{}','github',?,1)`,
      )
      .run(FIX.workspace, randomUlid(), FIX.projectA, taskId, kind, ref, old);
  }
  const safe = await github();
  await github({ state: "dispatched" });
  const dead = await github({ state: "dlq" });
  await db
    .prepare(
      `INSERT INTO github_dlq (workspace_id,outbox_id,delivery_id,kind,error,attempts,created_at)
    VALUES (?,?,?,'github.reconcile','synthetic',1,?)`,
    )
    .run(FIX.workspace, dead.outboxId, dead.deliveryId, old);
  await db
    .prepare(
      `INSERT INTO github_dlq (workspace_id,outbox_id,delivery_id,kind,error,attempts,created_at)
    VALUES (?,?,?,'github.reconcile','synthetic',1,?)`,
    )
    .run(FIX.workspace, randomUlid(), randomUlid(), old);
  const hiddenGitHub = await github({ ref: "blocked" });
  await evidence("branch", "safe", shared.taskId);
  await evidence("branch", "blocked", privateWork.taskId);
  const lifecycle = await github({ event: "installation", action: "deleted", installation: "124" });
  await github({ event: "installation_repositories", action: "added" });
  await github({
    event: "installation",
    action: "deleted",
    installation: "124",
    effect: {
      event: "push",
      action: "deleted",
      installationId: "124",
      repositoryId: null,
      occurredAt: old,
      ref: null,
      version: null,
      detail: {},
    },
  });
  assert.deepEqual((await readQueueState(db, FIX.workspace, now, access(2))).github_outbox, {
    pending: 2,
    dispatched_stale: 1,
    dlq: 1,
  });
  checks.push("real_d1_github_aggregate_exact_outbox_dlq_evidence_and_lifecycle_branches");

  async function version(runId: string | null, state = "failed") {
    const artifactId = randomUlid(),
      versionId = randomUlid();
    const key =
      runId === null
        ? null
        : `workspaces/${FIX.workspace}/runs/${runId}/logs/${versionId}.jsonl.zst`;
    await db
      .prepare(
        `INSERT INTO artifacts
      (workspace_id,id,run_id,format,role,created_by_human_id,created_at) VALUES (?,?,?,'log','log',?,?)`,
      )
      .run(FIX.workspace, artifactId, runId, FIX.owner, old);
    await db
      .prepare(
        `INSERT INTO artifact_versions
      (workspace_id,id,artifact_id,state,format,declared_size,expected_digest,content_hash,r2_key,created_at,available_at)
      VALUES (?,?,?,?,'log',64,?,?,?,?,?)`,
      )
      .run(
        FIX.workspace,
        versionId,
        artifactId,
        state,
        "a".repeat(64),
        state === "available" ? "a".repeat(64) : null,
        state === "available" ? key : null,
        old,
        state === "available" ? old : null,
      );
    return { artifactId, versionId };
  }
  async function recovery(
    kind: string,
    target: Record<string, unknown>,
    result: Record<string, unknown>,
    state = "applied",
  ) {
    const id = recoveryActionId(kind as Parameters<typeof recoveryActionId>[0], target);
    await db
      .prepare(
        `INSERT INTO ops_recovery_ledger
      (workspace_id,action_id,kind,target_json,state,attempt_count,result_json,created_by_human_id,created_at,updated_at)
      VALUES (?,?,?,?,?,1,?,?,?,?)`,
      )
      .run(
        FIX.workspace,
        id,
        kind,
        JSON.stringify(target),
        state,
        JSON.stringify(result),
        FIX.owner,
        old,
        old,
      );
    return id;
  }
  const sharedVersion = await version(shared.runId),
    privateVersion = await version(privateWork.runId),
    freeVersion = await version(null);
  await recovery(
    "resolve_stuck_upload",
    { version_ids: [sharedVersion.versionId, freeVersion.versionId] },
    { resolved: 2 },
  );
  await recovery(
    "resolve_stuck_upload",
    { version_ids: [sharedVersion.versionId, privateVersion.versionId] },
    { resolved: 2 },
  );
  await recovery("resolve_stuck_upload", { version_ids: [freeVersion.versionId] }, { resolved: 1 });
  await recovery(
    "retry_notification_dispatch",
    { cursors: [sharedCursor, sharedCursor] },
    { redispatched_from: sharedCursor - 1, cursors: 2 },
  );
  await recovery(
    "retry_notification_dispatch",
    { cursors: [sharedCursor, privateCursor] },
    { redispatched_from: sharedCursor - 1, cursors: 2 },
  );
  await recovery(
    "requeue_github_outbox",
    { outbox_ids: [safe.outboxId, safe.outboxId] },
    { requeued: 2 },
  );
  await recovery(
    "requeue_github_outbox",
    { outbox_ids: [safe.outboxId, hiddenGitHub.outboxId] },
    { requeued: 2 },
  );
  await recovery("requeue_github_outbox", { outbox_ids: [lifecycle.outboxId] }, { requeued: 1 });
  await recovery(
    "resolve_stuck_upload",
    { version_ids: [privateVersion.versionId] },
    { resolved: 1 },
    "failed",
  );
  await recovery("clear_recovery_state", { action_ids: [randomUlid()] }, { cleared: 1 });
  const expectedQueues = {
    notifications: { pending: 1, dead_lettered: 1, failed: 1 },
    github_outbox: { pending: 2, dispatched_stale: 1, dlq: 1 },
    ops_recovery: { applied: 5, failed: 0 },
  };
  assert.deepEqual(await readQueueState(db, FIX.workspace, now, access(2)), expectedQueues);
  checks.push("real_d1_applied_recovery_counts_all_targets_and_preserves_legitimate_duplicates");

  const largeTargets: string[] = [];
  for (let index = 0; index < 50; index++) largeTargets.push((await version(null)).versionId);
  await recovery("resolve_stuck_upload", { version_ids: largeTargets }, { resolved: 50 });
  assert.equal((await readQueueState(db, FIX.workspace, now, access(2))).ops_recovery.applied, 6);
  checks.push("real_d1_fifty_target_aggregate_stays_within_binding_and_expression_limits");

  const sharedUpload = await version(shared.runId, "uploading"),
    freeUpload = await version(null, "uploading");
  const malformedRunId = `${randomUlid()}\u0000synthetic`;
  await db
    .prepare(
      `INSERT INTO runs
      (workspace_id,id,project_id,task_id,requested_by_human_id,agent_profile_id,result_state,activity,resource_version,created_at)
      SELECT workspace_id,?,project_id,task_id,requested_by_human_id,agent_profile_id,result_state,activity,resource_version,created_at
      FROM runs WHERE workspace_id=? AND id=?`,
    )
    .run(malformedRunId, FIX.workspace, shared.runId);
  const malformedUpload = await version(malformedRunId, "uploading");
  await version(shared.runId, "available");
  const malformedRetention = await version(malformedRunId, "available");
  const hydratedUploads = await listStuckUploads(db, FIX.workspace, now, access(2));
  const retention = await listRetentionEligibleChunks(db, FIX.workspace, now, access(2));
  assert.equal(hydratedUploads.length, 3);
  assert.equal(retention.eligible.length, 2);
  const typed = await readOperationsProjection(
    db,
    FIX.workspace,
    now,
    { uploads: hydratedUploads, launches: [], retention: retention.eligible },
    access(2),
  );
  assert.equal(typed.work.uploads.length, 2);
  assert(!typed.work.uploads.some((row) => row.version_id === malformedUpload.versionId));
  assert.equal(typed.work.retention?.length, 1);
  assert(!typed.work.retention?.some((row) => row.version_id === malformedRetention.versionId));
  checks.push("real_d1_final_hydrated_upload_retention_projection_rejects_nul_suffixed_run_parent");
  const remasked = await readOperationsProjection(
    beforeSelection(db, async () => {
      await independent
        .prepare(
          "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
        )
        .run(FIX.workspace, shared.taskId, FIX.owner, now);
    }),
    FIX.workspace,
    now,
    { uploads: hydratedUploads, launches: [], retention: retention.eligible },
    access(2),
  );
  assert.deepEqual(remasked.queues, {
    notifications: { pending: 0, dead_lettered: 0, failed: 0 },
    github_outbox: { pending: 1, dispatched_stale: 0, dlq: 0 },
    ops_recovery: { applied: 3, failed: 0 },
  });
  assert.deepEqual(
    remasked.work.uploads.map((row) => row.version_id),
    [freeUpload.versionId],
  );
  assert(!remasked.work.uploads.some((row) => row.version_id === sharedUpload.versionId));
  assert.deepEqual(remasked.work.retention, []);
  checks.push("real_d1_final_aggregate_selection_remasks_counts_and_hydrated_refs_together");

  await assert.rejects(
    readOperationsProjection(
      beforeSelection(db, () => advanceEpoch(3)),
      FIX.workspace,
      now,
      { uploads: [], launches: [] },
      access(2),
    ),
    {
      code: "not_found",
      message: "operations scope not found",
    },
  );
  checks.push("real_d1_final_aggregate_scope_loss_hides_all_totals_even_without_refs");
  console.log(
    JSON.stringify({
      schema_version: 1,
      stage: "scoped_operations_aggregate_read",
      migration_head: manifest.migration_head,
      checks,
      outcome: "passed",
      limits: [
        "synthetic policies and retained history only",
        "no C11 activation or physical queue-drained claim",
        "no frozen diagnostic, unsupported recovery, opaque position or provider freshness certificate",
        "no queue execution, provider operation, live pilot, private R2 byte delivery or deployment",
      ],
    }),
  );
  console.log("C11_OPERATIONS_AGGREGATES_D1_OK");
} finally {
  await server.close();
}
