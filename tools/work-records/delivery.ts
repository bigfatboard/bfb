// ABOUTME: Proves staged human task reads and current-authority work-command retries on disposable real D1.
// ABOUTME: Two independent Workers dispatch the production Hub; synthetic policies do not activate private creation.

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { adaptD1, loadMigrationManifest, type D1Like, type SqlDatabase } from "@bfb/db";
import {
  FIX,
  randomUlid,
  seedSyntheticWorkspace,
  loadPrincipal,
  getTask,
  getAgentContext,
  listTasksPage,
  buildProjectLanes,
  buildNeedsNowDeck,
  artifactHash,
  mintUploadGrantSecret,
  mintViewGrantSecret,
  mintViewNonce,
  redeemUploadGrant,
  recordVerifiedUpload,
  redeemViewGrant,
  listArtifactsWithReviewState,
  getRunMeasurements,
  listReviewTimers,
  listStuckUploads,
  filterOperationsStuckWork,
  listRetentionEligibleChunks,
  listSystemRetentionEligibleChunks,
  resolveStuckUploadCommand,
  issueStepUpProof,
  recoveryActionId,
  OPS_STEP_UP_ACTIONS,
  ARTIFACT_AUDIT_ACTIONS,
  ARTIFACT_RECOVERY_SYSTEM_ID,
  readSecurityAudit,
  authorizeResultEvidence,
  listResultSubmissions,
  fanoutNotificationEvent,
  deriveDeliveryId,
  listDeliveries,
  loadPushAttempt,
  WorkspaceHub,
  submitResultCommand,
  type CreateArtifactResult,
  type ViewGrant,
  type CommandOutcome,
  type TaskRecord,
} from "@bfb/domain";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const origin = "https://bfb.work-records.test";
const now = new Date().toISOString();
const server = createTestHarness({
  root,
  workers: [
    { configPath: "tools/work-records/wrangler-a.toml" },
    { configPath: "tools/work-records/wrangler-b.toml" },
    { configPath: "tools/work-records/wrangler-hub.toml" },
  ],
});
const checks: string[] = [];
function check(name: string) {
  checks.push(name);
}
function access(humanId = FIX.owner) {
  return { workspaceId: FIX.workspace, humanId, authorizationEpoch: 1 };
}
async function execute<T>(
  worker: "a" | "b",
  name: string,
  input: unknown,
  humanId = FIX.owner,
  key = randomUlid(),
  delegationId?: string,
  authorizationEpoch = 1,
): Promise<CommandOutcome<T>> {
  const response = await server
    .getWorker(`bfb-work-records-${worker}`)
    .fetch(`${origin}/workspaces/${FIX.workspace}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandName: name,
        request: {
          workspaceId: FIX.workspace,
          actorHumanId: humanId,
          actorDelegationId: delegationId,
          authorizationEpoch,
          idempotencyKey: key,
          now,
          input,
        },
      }),
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
  await seedSyntheticWorkspace(db, now);
  const ids: string[] = [];
  for (const title of ["PRIVATE_TITLE_CANARY", "Synthetic shared task"]) {
    const outcome = await execute<TaskRecord>(
      "a",
      "task.create",
      {
        projectId: FIX.projectA,
        title,
        priority: "P0",
        nextOwnerType: "human",
        nextOwnerId: FIX.owner,
        nextActionReason: "Explicit synthetic review",
        dueAt: now,
      },
      FIX.member,
    );
    if (!outcome.ok) throw new Error(outcome.error.code);
    ids.push(outcome.result.id);
  }
  const [privateId, sharedId] = ids as [string, string];
  // Create historical shared child records before the fixture-only privacy
  // policy. Production private creation and launch remain unavailable here.
  const run = await execute<{ run: { id: string } }>(
    "a",
    "run.create",
    {
      taskId: privateId,
      expectedTaskVersion: 1,
      agentProfileId: FIX.profileCodex,
      workspacePolicyVersion: 1,
      projectPolicyVersion: 1,
      repositoryConfigVersion: 1,
      agentProfileVersion: 1,
    },
    FIX.member,
  );
  assert(run.ok);
  const runId = run.result.run.id;
  const upload = mintUploadGrantSecret();
  const digest = "a".repeat(64);
  const artifact = await execute<CreateArtifactResult>(
    "a",
    "artifact.create_version",
    {
      runId,
      format: "markdown",
      role: "review",
      declaredSize: 12,
      expectedDigest: digest,
      grantSecretHash: upload.secretHash,
    },
    FIX.member,
  );
  assert(artifact.ok);
  const consumed = await db.withTransaction((tx) =>
    redeemUploadGrant(tx, {
      grantId: artifact.result.upload_grant.grant_id,
      secret: upload.secret,
      now,
    }),
  );
  await db.withTransaction((tx) =>
    recordVerifiedUpload(tx, {
      grantId: consumed.grantId,
      consumeAttemptId: consumed.consumeAttemptId,
      contentHash: digest,
      size: 12,
      now,
    }),
  );
  assert(
    (
      await execute(
        "a",
        "artifact.finalize_version",
        { versionId: artifact.result.version_id, contentHash: digest, size: 12 },
        FIX.member,
      )
    ).ok,
  );
  assert.deepEqual(await db.prepare("SELECT COUNT(*) AS n FROM task_privacy").get(), { n: 0 });
  await db
    .prepare(
      `INSERT INTO task_privacy
    (workspace_id, task_id, owner_human_id, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run(FIX.workspace, privateId, FIX.member, now);
  check("creation_stays_shared_private_policy_is_fixture_only");
  assert.equal(await getTask(db, FIX.workspace, privateId), undefined);
  assert.deepEqual(await getAgentContext(db, FIX.workspace, privateId), []);
  assert.equal(await getTask(db, FIX.workspace, privateId, access()), undefined);
  assert.equal((await getTask(db, FIX.workspace, privateId, access(FIX.member)))?.id, privateId);
  check("read_query_creator_only_no_owner_or_unscoped_bypass");
  assert.deepEqual(
    await listTasksPage(db, FIX.workspace, [FIX.projectA], {
      limit: 1,
      access: access(),
    }),
    { tasks: [await getTask(db, FIX.workspace, sharedId, access())], limit: 1, has_more: false },
  );
  const principal = await loadPrincipal(db, FIX.workspace, FIX.owner);
  assert.deepEqual(
    (await buildProjectLanes(db, FIX.workspace, principal.projectIds, principal)).flatMap((lane) =>
      lane.tasks.map((task) => task.taskId),
    ),
    [sharedId],
  );
  assert.deepEqual(
    (
      await buildNeedsNowDeck(db, FIX.workspace, FIX.owner, principal.projectIds, now, principal)
    ).map((task) => task.taskId),
    [sharedId],
  );
  check("task_board_and_deck_filter_before_pagination");
  const grantId = randomUlid();
  await db
    .prepare(
      `INSERT INTO task_human_grants
    (workspace_id, id, task_id, human_id, authorization_epoch, permission, created_at)
    VALUES (?, ?, ?, ?, 1, 'read', ?)`,
    )
    .run(FIX.workspace, grantId, privateId, FIX.owner, now);
  assert.equal((await getTask(db, FIX.workspace, privateId, access()))?.id, privateId);
  assert.deepEqual(
    await execute("b", "comment.add", {
      taskId: privateId,
      kind: "discussion",
      body: "DENIED_PRIVATE_BODY",
    }),
    {
      ok: false,
      error: { code: "not_found", message: "task not found" },
    },
  );
  check("read_grant_does_not_authorize_contribution");
  await db.prepare("UPDATE task_human_grants SET revoked_at = ? WHERE id = ?").run(now, grantId);
  const editGrant = randomUlid();
  await db
    .prepare(
      `INSERT INTO task_human_grants
    (workspace_id, id, task_id, human_id, authorization_epoch, permission, created_at)
    VALUES (?, ?, ?, ?, 1, 'edit', ?)`,
    )
    .run(FIX.workspace, editGrant, privateId, FIX.owner, now);
  const operation = { taskId: privateId, kind: "discussion", body: "PRIVATE_COMMENT_CANARY" };
  const key = randomUlid();
  const simultaneous = await Promise.all([
    execute("a", "comment.add", operation, FIX.owner, key),
    execute("b", "comment.add", operation, FIX.owner, key),
  ]);
  assert(simultaneous.every((result) => result.ok));
  assert.equal(simultaneous.filter((result) => result.ok && result.replayed).length, 1);
  assert.deepEqual(
    await db.prepare("SELECT COUNT(*) AS n FROM comments WHERE task_id = ?").get(privateId),
    { n: 1 },
  );
  const changed = await execute(
    "b",
    "comment.add",
    { ...operation, body: "Changed" },
    FIX.owner,
    key,
  );
  assert(!changed.ok && changed.error.code === "request_rejected");
  check("cross_isolate_idempotency_binds_exact_input_and_one_effect");
  const context = await execute("a", "context.add", {
    taskId: privateId,
    kind: "brief",
    audience: "agent",
    body: "PRIVATE_CONTEXT_CANARY",
  });
  assert(context.ok);
  const delegationId = randomUlid();
  await db
    .prepare(
      `INSERT INTO oauth_delegations
    (workspace_id, id, human_id, client_id, resource, project_id, scopes_json,
     authorization_epoch, expires_at, created_at)
    VALUES (?, ?, ?, 'c11-client', 'https://bfb.example.test/mcp', ?, '["bfb:read"]', 1, ?, ?)`,
    )
    .run(
      FIX.workspace,
      delegationId,
      FIX.owner,
      FIX.projectA,
      new Date(Date.now() + 600_000).toISOString(),
      now,
    );
  const contextKey = randomUlid();
  const delivered = await execute<{ body: string }[]>(
    "a",
    "context.deliver.delegation",
    { taskId: privateId },
    FIX.owner,
    contextKey,
    delegationId,
  );
  assert(delivered.ok);
  assert.deepEqual(
    delivered.result.map((item) => item.body),
    ["PRIVATE_CONTEXT_CANARY"],
  );
  for (const table of ["audit_events", "semantic_events", "outbox_records"]) {
    const rows = await db
      .prepare(`SELECT payload_json FROM ${table} WHERE workspace_id = ?`)
      .all(FIX.workspace);
    assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_(TITLE|COMMENT|CONTEXT)_CANARY/);
  }
  check("work_receipts_exclude_private_titles_prose_and_context");
  await db.prepare("UPDATE task_human_grants SET revoked_at = ? WHERE id = ?").run(now, editGrant);
  for (const outcome of [
    await execute("b", "comment.add", operation, FIX.owner, key),
    await execute(
      "b",
      "context.deliver.delegation",
      { taskId: privateId },
      FIX.owner,
      contextKey,
      delegationId,
    ),
  ])
    assert.deepEqual(outcome, {
      ok: false,
      error: { code: "not_found", message: "task not found" },
    });
  assert.equal(await getTask(db, FIX.workspace, privateId, access()), undefined);
  check("revocation_fences_cross_isolate_cached_comment_and_context");
  const child = await execute(
    "a",
    "task.create",
    {
      projectId: FIX.projectA,
      parentTaskId: privateId,
      title: "Must not become shared",
      priority: "P2",
    },
    FIX.member,
  );
  assert(!child.ok && child.error.code === "not_found");
  check("private_parent_children_remain_unavailable");
  for (let index = 0; index < 48; index++) {
    const task = await execute<TaskRecord>("a", "task.create", {
      projectId: FIX.projectA,
      title: `Synthetic board capacity ${index}`,
      priority: "P2",
    });
    assert(task.ok);
  }
  const fullBoard = await buildProjectLanes(db, FIX.workspace, principal.projectIds, principal);
  const fullCards = fullBoard.flatMap((lane) => lane.tasks);
  assert.equal(fullCards.length, 49);
  assert(fullCards.every((card) => card.latestEvent?.kind === "task.create"));
  assert.doesNotMatch(JSON.stringify(fullBoard), /PRIVATE_TITLE_CANARY/);
  check("full_board_page_stays_within_d1_parameter_limit");
  assert.deepEqual(
    await listArtifactsWithReviewState(db, FIX.workspace, principal.projectIds, runId, principal),
    [],
  );
  await assert.rejects(getRunMeasurements(db, FIX.workspace, runId, now, principal));
  assert.deepEqual(await listReviewTimers(db, FIX.workspace, privateId, principal), []);
  check("private_artifact_measurement_and_timer_children_hide_unshared_owner");

  const readGrant = randomUlid();
  await db
    .prepare(
      `INSERT INTO task_human_grants
      (workspace_id, id, task_id, human_id, authorization_epoch, permission, created_at)
      VALUES (?, ?, ?, ?, 1, 'read', ?)`,
    )
    .run(FIX.workspace, readGrant, privateId, FIX.owner, now);
  const visibleArtifacts = await listArtifactsWithReviewState(
    db,
    FIX.workspace,
    principal.projectIds,
    runId,
    principal,
  );
  assert.equal(visibleArtifacts.length, 1);
  await getRunMeasurements(db, FIX.workspace, runId, now, principal);
  const deniedTimer = await execute("b", "review_timer.start", { taskId: privateId, runId });
  assert(!deniedTimer.ok && deniedTimer.error.code === "not_found");
  const viewSecret = mintViewGrantSecret();
  const viewNonce = mintViewNonce();
  const view = await execute<ViewGrant>("a", "artifact.create_view_grant", {
    versionId: artifact.result.version_id,
    grantSecretHash: artifactHash(viewSecret.secret),
    viewNonce,
    sessionHash: artifactHash("synthetic-private-child-session"),
  });
  assert(view.ok);
  check("read_grant_allows_preview_and_measurements_but_not_timer_mutation");
  await db.prepare("UPDATE task_human_grants SET revoked_at = ? WHERE id = ?").run(now, readGrant);
  await assert.rejects(
    db.withTransaction((tx) =>
      redeemViewGrant(tx, {
        viewId: view.result.view_id,
        secret: viewSecret.secret,
        nonce: viewNonce,
        now,
      }),
    ),
  );
  assert.deepEqual(
    await db
      .prepare("SELECT consumed_at FROM artifact_view_grants WHERE id = ?")
      .get(view.result.view_id),
    { consumed_at: null },
  );
  check("real_d1_view_consumption_rechecks_current_private_parent_grant");

  const contributionGrant = randomUlid();
  await db
    .prepare(
      `INSERT INTO task_human_grants
    (workspace_id, id, task_id, human_id, authorization_epoch, permission, created_at)
    VALUES (?, ?, ?, ?, 1, 'contribute', ?)`,
    )
    .run(FIX.workspace, contributionGrant, privateId, FIX.owner, now);
  const timerKey = randomUlid();
  const timerInput = { taskId: privateId, runId };
  assert((await execute("a", "review_timer.start", timerInput, FIX.owner, timerKey)).ok);
  assert.equal((await listReviewTimers(db, FIX.workspace, privateId, principal)).length, 1);
  await db
    .prepare("UPDATE task_human_grants SET revoked_at = ? WHERE id = ?")
    .run(now, contributionGrant);
  const replayedTimer = await execute("b", "review_timer.start", timerInput, FIX.owner, timerKey);
  assert(!replayedTimer.ok && replayedTimer.error.code === "not_found");
  assert.deepEqual(await listReviewTimers(db, FIX.workspace, privateId, principal), []);
  check("real_hub_timer_cache_and_read_delivery_recheck_private_grant");

  const receiptGrant = randomUlid();
  await db
    .prepare(
      `INSERT INTO task_human_grants
    (workspace_id, id, task_id, human_id, authorization_epoch, permission, created_at)
    VALUES (?, ?, ?, ?, 1, 'contribute', ?)`,
    )
    .run(FIX.workspace, receiptGrant, privateId, FIX.owner, now);
  const receiptSecret = mintUploadGrantSecret();
  const receiptVersion = await execute<CreateArtifactResult>("a", "artifact.create_version", {
    artifactId: artifact.result.artifact_id,
    runId,
    format: "markdown",
    role: "review",
    declaredSize: 12,
    expectedDigest: digest,
    grantSecretHash: receiptSecret.secretHash,
  });
  assert(receiptVersion.ok);
  const receiptConsumption = await db.withTransaction((tx) =>
    redeemUploadGrant(tx, {
      grantId: receiptVersion.result.upload_grant.grant_id,
      secret: receiptSecret.secret,
      now,
    }),
  );
  const objectsBefore = await db.prepare("SELECT COUNT(*) AS n FROM artifact_objects").get();
  const receiptTables = [
    "artifact_upload_receipts",
    "artifact_upload_receipt_sources",
    "artifact_audit_outbox",
  ];
  const receiptsBefore = await Promise.all(
    receiptTables.map((table) =>
      db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE version_id = ?`)
        .get(receiptVersion.result.version_id),
    ),
  );
  let batchRevoked = false;
  const racingDb = adaptD1({
    prepare: (query) => binding.prepare(query),
    async batch(statements) {
      // An independent D1 write revokes the fixture grant after preflight, before
      // the real D1 batch evaluates both physical and current-authority guards.
      await db
        .prepare("UPDATE task_human_grants SET revoked_at = ? WHERE id = ?")
        .run(now, receiptGrant);
      batchRevoked = true;
      return binding.batch(statements);
    },
  });
  await assert.rejects(
    racingDb.withTransaction((tx) =>
      recordVerifiedUpload(tx, {
        grantId: receiptConsumption.grantId,
        consumeAttemptId: receiptConsumption.consumeAttemptId,
        contentHash: digest,
        size: 12,
        now,
      }),
    ),
    /constraint failed/i,
  );
  assert(batchRevoked);
  for (const [index, table] of receiptTables.entries())
    assert.deepEqual(
      await db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE version_id = ?`)
        .get(receiptVersion.result.version_id),
      receiptsBefore[index],
    );
  assert.deepEqual(
    await db.prepare("SELECT COUNT(*) AS n FROM artifact_objects").get(),
    objectsBefore,
  );
  assert.deepEqual(await db.prepare("SELECT COUNT(*) AS n FROM artifact_mutation_guards").get(), {
    n: 0,
  });
  check("real_d1_receipt_batch_revocation_rolls_back_registry_receipt_source_and_audit");
  const runFreeSecret = mintUploadGrantSecret();
  const runFreeVersion = await execute<CreateArtifactResult>("a", "artifact.create_version", {
    format: "markdown",
    role: "review",
    declaredSize: 12,
    expectedDigest: digest,
    grantSecretHash: runFreeSecret.secretHash,
  });
  assert(runFreeVersion.ok);
  const operationsNow = new Date(Date.parse(now) + 30 * 60_000).toISOString();
  // Both synthetic versions are physically stuck. The private task-bound one
  // cannot enter the operations projection even for a creator or read grantee.
  assert.deepEqual(
    await db
      .prepare(
        "SELECT COUNT(*) AS n FROM artifact_versions WHERE workspace_id = ? AND state = 'uploading'",
      )
      .get(FIX.workspace),
    { n: 2 },
  );
  const stuck = await listStuckUploads(db, FIX.workspace, operationsNow, access());
  assert.deepEqual(
    stuck.map((row) => row.version_id),
    [runFreeVersion.result.version_id],
  );
  assert.deepEqual(await listStuckUploads(db, FIX.workspace, operationsNow), stuck);
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
  assert.deepEqual(await listStuckUploads(db, FIX.workspace, operationsNow, access()), []);
  await assert.rejects(
    filterOperationsStuckWork(
      db,
      FIX.workspace,
      operationsNow,
      {
        uploads: stuck,
        launches: [],
      },
      access(),
    ),
    { code: "not_found", message: "operations scope not found" },
  );
  assert.deepEqual(
    (
      await listStuckUploads(db, FIX.workspace, operationsNow, {
        ...access(),
        authorizationEpoch: 2,
      })
    ).map((row) => row.version_id),
    [runFreeVersion.result.version_id],
  );
  assert.deepEqual(
    await filterOperationsStuckWork(
      db,
      FIX.workspace,
      operationsNow,
      {
        uploads: stuck,
        launches: [],
      },
      { ...access(), authorizationEpoch: 2 },
    ),
    { uploads: stuck, launches: [] },
  );
  check("real_d1_operations_stuck_upload_projection_hides_private_and_rechecks_epoch");
  const sourceRef = {
    kind: "artifact_version",
    ref: artifact.result.artifact_id,
    version: artifact.result.version_id,
  };
  const aliasRef = { kind: sourceRef.kind, ref: sourceRef.version };
  const sourceAccess = access(FIX.member);
  await authorizeResultEvidence(db, FIX.workspace, privateId, [sourceRef, aliasRef], sourceAccess);
  await authorizeResultEvidence(db, FIX.workspace, privateId, [sourceRef], sourceAccess, runId);
  const deniedSources = [
    { ...sourceRef, ref: randomUlid() },
    { ...sourceRef, version: randomUlid() },
    { kind: sourceRef.kind, ref: randomUlid() },
  ];
  for (const ref of deniedSources)
    await assert.rejects(
      authorizeResultEvidence(db, FIX.workspace, privateId, [ref], sourceAccess),
      { code: "not_found", message: "evidence artifact not found" },
    );
  await assert.rejects(
    authorizeResultEvidence(db, FIX.workspace, sharedId, [sourceRef], sourceAccess),
    { code: "not_found", message: "evidence artifact not found" },
  );
  await assert.rejects(
    authorizeResultEvidence(db, FIX.workspace, privateId, [sourceRef], sourceAccess, randomUlid()),
    { code: "not_found", message: "evidence artifact not found" },
  );
  const runFreeRef = {
    kind: sourceRef.kind,
    ref: runFreeVersion.result.artifact_id,
    version: runFreeVersion.result.version_id,
  };
  await authorizeResultEvidence(db, FIX.workspace, privateId, [runFreeRef], sourceAccess);
  await assert.rejects(
    authorizeResultEvidence(db, FIX.workspace, privateId, [runFreeRef], sourceAccess, runId),
    { code: "not_found", message: "evidence artifact not found" },
  );
  check("real_d1_exact_artifact_evidence_binding_and_local_run_ceiling");
  const evidenceDelegationId = randomUlid();
  await db
    .prepare(
      `INSERT INTO oauth_delegations
       (workspace_id, id, human_id, client_id, resource, project_id, task_id,
        scopes_json, authorization_epoch, expires_at, created_at)
       VALUES (?, ?, ?, ?, 'https://bfb.work-records.test/mcp', ?, ?, ?, 1, ?, ?)`,
    )
    .run(
      FIX.workspace,
      evidenceDelegationId,
      FIX.member,
      FIX.client,
      FIX.projectA,
      privateId,
      JSON.stringify(["bfb:read", "bfb:task:write"]),
      new Date(Date.parse(now) + 60 * 60_000).toISOString(),
      now,
    );
  const delegatedAccess = {
    ...sourceAccess,
    delegationId: evidenceDelegationId,
    taskBoundaryId: privateId,
  };
  await authorizeResultEvidence(
    db,
    FIX.workspace,
    privateId,
    [sourceRef, aliasRef],
    delegatedAccess,
  );
  await assert.rejects(
    authorizeResultEvidence(db, FIX.workspace, privateId, [runFreeRef], delegatedAccess),
    { code: "not_found", message: "evidence artifact not found" },
  );
  await db
    .prepare("UPDATE oauth_delegations SET scopes_json = ? WHERE workspace_id = ? AND id = ?")
    .run(JSON.stringify(["bfb:read"]), FIX.workspace, evidenceDelegationId);
  await assert.rejects(
    authorizeResultEvidence(db, FIX.workspace, privateId, [sourceRef], delegatedAccess),
    { code: "not_found", message: "evidence artifact not found" },
  );
  check("real_d1_exact_evidence_retains_delegation_boundary_and_current_scope");
  const snapshot = (await db
    .prepare(
      `SELECT id, content_hash FROM run_configuration_snapshots
       WHERE workspace_id = ? AND run_id = ? ORDER BY snapshot_generation DESC LIMIT 1`,
    )
    .get(FIX.workspace, runId)) as { id: string; content_hash: string } | undefined;
  assert(snapshot);
  const opaqueRef = { kind: "external", ref: "synthetic-opaque-proof" };
  const historyJson = `[${JSON.stringify(sourceRef)},${JSON.stringify(aliasRef)},${JSON.stringify(opaqueRef)},"synthetic scalar",null,[],{"kind":"external","kind":"artifact_version","ref":${JSON.stringify(sourceRef.ref)},"version":${JSON.stringify(sourceRef.version)}},${JSON.stringify({ ...sourceRef, unexpected: true })}]`;
  for (const [index, refsJson] of [historyJson, '{"invalid":"synthetic non-array"}'].entries())
    await db
      .prepare(
        `INSERT INTO result_submissions
         (workspace_id, id, run_id, version, summary, limitations, evidence_refs_json,
          config_snapshot_id, config_hash, submitted_by_kind, submitted_by_id, submitted_at)
         VALUES (?, ?, ?, ?, 'Synthetic historical result', '', ?, ?, ?, 'human', ?, ?)`,
      )
      .run(
        FIX.workspace,
        randomUlid(),
        runId,
        index + 1,
        refsJson,
        snapshot.id,
        snapshot.content_hash,
        FIX.member,
        now,
      );
  const history = await listResultSubmissions(db, FIX.workspace, runId, new Map(), sourceAccess);
  assert.equal(history.length, 2);
  assert.deepEqual(history[0]!.evidence_refs, []);
  assert.deepEqual(history[1]!.evidence_refs, [sourceRef, aliasRef, opaqueRef]);
  assert.deepEqual(
    await db
      .prepare(
        "SELECT evidence_refs_json FROM result_submissions WHERE workspace_id = ? AND run_id = ? AND version = 1",
      )
      .get(FIX.workspace, runId),
    { evidence_refs_json: historyJson },
  );
  check("real_d1_historical_evidence_normalization_omits_corruption_without_row_rewrite");
  const privateSubmission = await execute(
    "a",
    "result.submit",
    {
      runId,
      summary: "Synthetic private notification source",
    },
    FIX.member,
  );
  assert(privateSubmission.ok);
  assert.deepEqual(
    await fanoutNotificationEvent(db, {
      workspaceId: FIX.workspace,
      eventCursor: privateSubmission.cursor,
      eventKind: "result.submit",
      now,
    }),
    { status: "subject_gone" },
  );
  const sharedRun = await execute<{ run: { id: string } }>(
    "a",
    "run.create",
    {
      taskId: sharedId,
      expectedTaskVersion: 1,
      agentProfileId: FIX.profileCodex,
      workspacePolicyVersion: 1,
      projectPolicyVersion: 1,
      repositoryConfigVersion: 1,
      agentProfileVersion: 1,
    },
    FIX.member,
  );
  assert(sharedRun.ok);
  assert(
    (
      await execute(
        "a",
        "notification.push_endpoint.register",
        {
          endpoint: "https://push.synthetic.test/d1-notification-fence",
          p256dh: "B".repeat(87),
          auth: "A".repeat(22),
        },
        FIX.member,
      )
    ).ok,
  );
  const sharedSubmission = await execute(
    "a",
    "result.submit",
    {
      runId: sharedRun.result.run.id,
      summary: "Synthetic shared notification source",
    },
    FIX.member,
  );
  assert(sharedSubmission.ok);
  assert.deepEqual(
    await fanoutNotificationEvent(db, {
      workspaceId: FIX.workspace,
      eventCursor: sharedSubmission.cursor,
      eventKind: "result.submit",
      now,
    }),
    { status: "notified", category: "result_submitted", push: 1, macos: 0 },
  );
  const deliveryId = deriveDeliveryId(
    FIX.workspace,
    sharedSubmission.cursor,
    "browser_push",
    FIX.member,
  );
  assert(
    (await loadPushAttempt(db, { workspaceId: FIX.workspace, deliveryId, access: sourceAccess }))
      .ok,
  );
  assert.equal((await listDeliveries(db, FIX.workspace, FIX.member, 1, sourceAccess)).length, 1);
  await db
    .prepare(
      `INSERT INTO notification_preferences
    (workspace_id, human_id, project_id, channel, category, enabled, updated_at)
    VALUES (?, ?, ?, 'browser_push', 'result_submitted', 0, ?)`,
    )
    .run(FIX.workspace, FIX.member, FIX.projectA, now);
  assert(
    !(await loadPushAttempt(db, { workspaceId: FIX.workspace, deliveryId, access: sourceAccess }))
      .ok,
  );
  await db
    .prepare(
      "UPDATE notification_preferences SET enabled = 1 WHERE workspace_id = ? AND human_id = ?",
    )
    .run(FIX.workspace, FIX.member);
  const evidenceTarget = await execute<TaskRecord>(
    "a",
    "task.create",
    {
      projectId: FIX.projectA,
      title: "Synthetic reference batch destination",
      priority: "P2",
    },
    FIX.member,
  );
  assert(evidenceTarget.ok);
  const evidenceTargetRun = await execute<{ run: { id: string } }>(
    "a",
    "run.create",
    {
      taskId: evidenceTarget.result.id,
      expectedTaskVersion: 1,
      agentProfileId: FIX.profileCodex,
      workspacePolicyVersion: 1,
      projectPolicyVersion: 1,
      repositoryConfigVersion: 1,
      agentProfileVersion: 1,
    },
    FIX.member,
  );
  assert(evidenceTargetRun.ok);
  const sharedEvidenceSecret = mintUploadGrantSecret();
  const sharedEvidence = await execute<CreateArtifactResult>(
    "a",
    "artifact.create_version",
    {
      runId: sharedRun.result.run.id,
      format: "markdown",
      role: "review",
      declaredSize: 12,
      expectedDigest: digest,
      grantSecretHash: sharedEvidenceSecret.secretHash,
    },
    FIX.member,
  );
  assert(sharedEvidence.ok);
  const effectTables = ["semantic_events", "audit_events", "outbox_records", "idempotency_records"];
  const effectsBefore = await Promise.all(
    effectTables.map((table) =>
      db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(FIX.workspace),
    ),
  );
  let sourcePrivatizedBeforeBatch = false;
  const sourceRacingDb = adaptD1({
    prepare: (query) => binding.prepare(query),
    async batch(statements) {
      await db
        .prepare(
          `INSERT INTO task_privacy
        (workspace_id, task_id, owner_human_id, created_at) VALUES (?, ?, ?, ?)`,
        )
        .run(FIX.workspace, sharedId, FIX.member, now);
      sourcePrivatizedBeforeBatch = true;
      return binding.batch(statements);
    },
  });
  const rejectedSourceBatch = await new WorkspaceHub(sourceRacingDb).execute(submitResultCommand, {
    workspaceId: FIX.workspace,
    actorHumanId: FIX.member,
    authorizationEpoch: 1,
    idempotencyKey: randomUlid(),
    now,
    input: {
      runId: evidenceTargetRun.result.run.id,
      summary: "Synthetic rejected cross-task reference",
      evidenceRefs: [
        {
          kind: "artifact_version",
          ref: sharedEvidence.result.artifact_id,
          version: sharedEvidence.result.version_id,
        },
      ],
    },
  });
  assert(sourcePrivatizedBeforeBatch);
  assert(!rejectedSourceBatch.ok && rejectedSourceBatch.error.code === "command_failed");
  assert.deepEqual(
    await db
      .prepare("SELECT COUNT(*) AS n FROM result_submissions WHERE workspace_id = ? AND run_id = ?")
      .get(FIX.workspace, evidenceTargetRun.result.run.id),
    { n: 0 },
  );
  for (const [index, table] of effectTables.entries())
    assert.deepEqual(
      await db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`)
        .get(FIX.workspace),
      effectsBefore[index],
    );
  assert.deepEqual(await db.prepare("SELECT COUNT(*) AS n FROM artifact_mutation_guards").get(), {
    n: 0,
  });
  assert.deepEqual(
    await db
      .prepare("SELECT result_state FROM runs WHERE workspace_id = ? AND id = ?")
      .get(FIX.workspace, evidenceTargetRun.result.run.id),
    { result_state: "open" },
  );
  assert.deepEqual(
    await db
      .prepare("SELECT state FROM tasks WHERE workspace_id = ? AND id = ?")
      .get(FIX.workspace, evidenceTarget.result.id),
    { state: "active" },
  );
  check(
    "real_d1_result_source_private_before_batch_rolls_back_submission_state_receipts_and_audit",
  );
  assert(
    !(await loadPushAttempt(db, { workspaceId: FIX.workspace, deliveryId, access: sourceAccess }))
      .ok,
  );
  assert.deepEqual(await listDeliveries(db, FIX.workspace, FIX.member, 1, sourceAccess), []);
  check(
    "real_d1_notification_fanout_contact_and_history_keep_current_shared_parent_and_preference",
  );
  // Operations proof uses genuine synthetic task/run parents, not provider
  // execution. Artifact byte state is fixture-only and no R2 is contacted.
  const ownerAccess = { ...access(), authorizationEpoch: 2 };
  const oldLogAt = new Date(Date.parse(now) - 40 * 24 * 60 * 60_000).toISOString();
  const oldUploadAt = new Date(Date.parse(now) - 60 * 60_000).toISOString();
  const operationsRun = evidenceTargetRun.result.run.id;
  async function seedOperationsVersion(
    parentRun: string | null,
    state: "available" | "uploading",
    wrongKey = false,
  ) {
    const artifactId = randomUlid();
    const versionId = randomUlid();
    const createdAt = state === "available" ? oldLogAt : oldUploadAt;
    const key = `workspaces/${FIX.workspace}/runs/${wrongKey ? randomUlid() : (parentRun ?? randomUlid())}/logs/${versionId}.jsonl.zst`;
    await db
      .prepare(
        `INSERT INTO artifacts
         (workspace_id, id, run_id, format, role, created_by_human_id, created_at)
         VALUES (?, ?, ?, 'log', 'log', ?, ?)`,
      )
      .run(FIX.workspace, artifactId, parentRun, FIX.owner, createdAt);
    await db
      .prepare(
        `INSERT INTO artifact_versions
         (workspace_id, id, artifact_id, state, format, declared_size, expected_digest,
          content_hash, r2_key, created_at, available_at)
         VALUES (?, ?, ?, ?, 'log', 64, ?, ?, ?, ?, ?)`,
      )
      .run(
        FIX.workspace,
        versionId,
        artifactId,
        state,
        digest,
        state === "available" ? digest : null,
        state === "available" ? key : null,
        createdAt,
        state === "available" ? createdAt : null,
      );
    return versionId;
  }
  const canonicalLog = await seedOperationsVersion(operationsRun, "available");
  const privateLog = await seedOperationsVersion(runId, "available");
  await seedOperationsVersion(operationsRun, "available", true);
  await seedOperationsVersion(null, "available");
  const humanRetention = await listRetentionEligibleChunks(db, FIX.workspace, now, ownerAccess);
  assert.equal(humanRetention.examined, 1);
  assert.deepEqual(
    humanRetention.eligible.map((row) => row.version_id),
    [canonicalLog],
  );
  assert.deepEqual((await listSystemRetentionEligibleChunks(db, FIX.workspace, now)).eligible, []);
  await db
    .prepare(
      `INSERT INTO retention_policies
       (workspace_id, raw_log_retention_days, version, updated_by_human_id, updated_at)
       VALUES (?, 30, 1, ?, ?)`,
    )
    .run(FIX.workspace, FIX.owner, now);
  // Internal configured policy and human authority remain separate. This is
  // selector proof only, not private destructive-retention certification.
  const systemRetention = await listSystemRetentionEligibleChunks(db, FIX.workspace, now);
  assert.equal(systemRetention.examined, 2);
  assert.deepEqual(
    systemRetention.eligible.map((row) => row.version_id).sort(),
    [canonicalLog, privateLog].sort(),
  );
  check(
    "real_d1_human_retention_uses_visible_canonical_parents_and_separate_configured_system_scope",
  );
  const sharedRecovery = await seedOperationsVersion(operationsRun, "uploading");
  const runFreeRecovery = await seedOperationsVersion(null, "uploading");
  const recoveryVersions = [sharedRecovery, runFreeRecovery];
  const recoveryTarget = `ops-recover:resolve_stuck_upload:${FIX.workspace}`;
  const makeRecoveryProof = () =>
    issueStepUpProof(
      db,
      FIX.owner,
      {
        action: OPS_STEP_UP_ACTIONS.recover,
        workspaceId: FIX.workspace,
        targetId: recoveryTarget,
        scopes: [],
        authorizationEpoch: 2,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      },
      new Date().toISOString(),
    );
  const firstRecoveryProof = await makeRecoveryProof();
  const firstRecovery = await execute<{ replayed: boolean; detail: { resolved: number } }>(
    "a",
    resolveStuckUploadCommand.name,
    { versionIds: recoveryVersions, stepUpProofId: firstRecoveryProof },
    FIX.owner,
    randomUlid(),
    undefined,
    2,
  );
  assert(firstRecovery.ok && !firstRecovery.result.replayed);
  assert.deepEqual(firstRecovery.result.detail, { resolved: 2 });
  const secondRecovery = await execute<{ replayed: boolean; detail: { resolved: number } }>(
    "b",
    resolveStuckUploadCommand.name,
    { versionIds: recoveryVersions, stepUpProofId: await makeRecoveryProof() },
    FIX.owner,
    randomUlid(),
    undefined,
    2,
  );
  assert(secondRecovery.ok && secondRecovery.result.replayed);
  assert.deepEqual(secondRecovery.result.detail, { resolved: 2 });
  for (const id of recoveryVersions) {
    assert.deepEqual(
      await db
        .prepare("SELECT state FROM artifact_versions WHERE workspace_id = ? AND id = ?")
        .get(FIX.workspace, id),
      { state: "failed" },
    );
    assert.deepEqual(
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM artifact_audit_outbox WHERE workspace_id = ? AND version_id = ? AND action = 'artifact.abandoned'",
        )
        .get(FIX.workspace, id),
      { n: 1 },
    );
  }
  check("real_production_hub_upload_recovery_and_fresh_proof_ledger_retry_converge_once");
  const raceRecovery = await seedOperationsVersion(operationsRun, "uploading");
  const racingRecoveryProof = await makeRecoveryProof();
  const recoveryTables = [...effectTables, "ops_recovery_ledger", "artifact_audit_outbox"];
  const recoveryEffectsBefore = await Promise.all(
    recoveryTables.map((table) =>
      db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(FIX.workspace),
    ),
  );
  let liveGrantInserted = false;
  const recoveryRacingDb = adaptD1({
    prepare: (query) => binding.prepare(query),
    async batch(statements) {
      // Even a consumed grant is protected until its owning V01 grace elapses.
      await db
        .prepare(
          `INSERT INTO artifact_upload_grants
           (workspace_id, id, version_id, grant_hash, human_id, authorization_epoch,
            run_id, format, declared_size, expected_digest, expires_at, consumed_at, created_at)
           VALUES (?, ?, ?, ?, ?, 2, ?, 'log', 64, ?, ?, ?, ?)`,
        )
        .run(
          FIX.workspace,
          randomUlid(),
          raceRecovery,
          artifactHash(randomUlid()),
          FIX.owner,
          operationsRun,
          digest,
          new Date(Date.now() + 60_000).toISOString(),
          now,
          oldUploadAt,
        );
      liveGrantInserted = true;
      return binding.batch(statements);
    },
  });
  const recoveryRaceOutcome = await new WorkspaceHub(recoveryRacingDb).execute(
    resolveStuckUploadCommand,
    {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.owner,
      authorizationEpoch: 2,
      idempotencyKey: randomUlid(),
      input: { versionIds: [raceRecovery], stepUpProofId: racingRecoveryProof },
    },
  );
  assert(liveGrantInserted);
  assert(!recoveryRaceOutcome.ok && recoveryRaceOutcome.error.code === "command_failed");
  assert.deepEqual(
    await db
      .prepare("SELECT state FROM artifact_versions WHERE workspace_id = ? AND id = ?")
      .get(FIX.workspace, raceRecovery),
    { state: "uploading" },
  );
  assert.deepEqual(
    await db
      .prepare("SELECT consumed_at FROM passkey_step_up_proofs WHERE proof_id = ?")
      .get(racingRecoveryProof),
    { consumed_at: null },
  );
  for (const [index, table] of recoveryTables.entries())
    assert.deepEqual(
      await db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`)
        .get(FIX.workspace),
      recoveryEffectsBefore[index],
    );
  assert.deepEqual(
    await db
      .prepare(
        "SELECT COUNT(*) AS n FROM ops_recovery_ledger WHERE workspace_id = ? AND action_id = ?",
      )
      .get(
        FIX.workspace,
        recoveryActionId("resolve_stuck_upload", { version_ids: [raceRecovery] }),
      ),
    { n: 0 },
  );
  check(
    "real_d1_recovery_consumed_live_grant_before_batch_rolls_back_proof_effects_ledger_and_audit",
  );
  await db
    .prepare(
      "UPDATE workspace_members SET authorization_epoch = 3 WHERE workspace_id = ? AND human_id = ?",
    )
    .run(FIX.workspace, FIX.owner);
  await db
    .prepare(
      "UPDATE workspace_authorization_epochs SET authorization_epoch = 3 WHERE workspace_id = ? AND human_id = ?",
    )
    .run(FIX.workspace, FIX.owner);
  await assert.rejects(listRetentionEligibleChunks(db, FIX.workspace, now, ownerAccess), {
    code: "not_found",
    message: "operations scope not found",
  });
  await assert.rejects(
    filterOperationsStuckWork(
      db,
      FIX.workspace,
      now,
      { uploads: [], launches: [], retention: [] },
      ownerAccess,
    ),
    {
      code: "not_found",
      message: "operations scope not found",
    },
  );
  check("real_d1_empty_composite_scope_rechecks_epoch_before_hydrated_workspace_metadata");
  const auditAccess = { ...access(), authorizationEpoch: 3 };
  // The observed anchor separates this synthetic history from prior probes.
  // Hub authorization owns dispatch time; request.now cannot override its clock.
  const auditAnchorAt = new Date().toISOString();
  const auditAnchorId = randomUlid();
  await db
    .prepare(
      `INSERT INTO audit_events
     (workspace_id,audit_id,actor_principal_id,action,payload_json,created_at)
     VALUES (?,?,?,'ops.audit.synthetic_anchor','{"action":"synthetic"}',?)`,
    )
    .run(FIX.workspace, auditAnchorId, FIX.owner, auditAnchorAt);

  async function seedAuditSource(
    action: string,
    versionId: string,
    grantId: string | null,
    at = auditAnchorAt,
  ) {
    const id = randomUlid();
    await db
      .prepare(
        `INSERT INTO artifact_audit_outbox
       (workspace_id,id,version_id,grant_id,action,payload_json,created_at)
       VALUES (?,?,?,?,?,'{"synthetic":true}',?)`,
      )
      .run(FIX.workspace, id, versionId, grantId, action, at);
    const response = await server
      .getWorker("bfb-work-records-a")
      .fetch(origin + "/workspaces/" + FIX.workspace + "/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandName: "artifact.dispatch_audit",
          request: {
            workspaceId: FIX.workspace,
            actorSystemId: ARTIFACT_RECOVERY_SYSTEM_ID,
            authorizationEpoch: 1,
            idempotencyKey: "c11-audit." + id,
            now: at,
            input: { outboxId: id },
          },
        }),
      });
    assert.equal(response.status, 200, await response.clone().text());
    const outcome = (await response.json()) as CommandOutcome<unknown>;
    assert(outcome.ok, JSON.stringify(outcome));
    return id;
  }
  async function seedAuditUploadGrant(versionId: string) {
    const id = randomUlid();
    await db
      .prepare(
        `INSERT INTO artifact_upload_grants
       (workspace_id,id,version_id,grant_hash,human_id,authorization_epoch,run_id,format,
        declared_size,expected_digest,expires_at,consumed_at,created_at)
       VALUES (?,?,?,?,?,3,?,'log',64,?,?,?,?)`,
      )
      .run(
        FIX.workspace,
        id,
        versionId,
        artifactHash(id),
        FIX.owner,
        operationsRun,
        digest,
        oldUploadAt,
        oldUploadAt,
        oldUploadAt,
      );
    return id;
  }
  async function seedAuditViewGrant(versionId: string) {
    const id = randomUlid();
    await db
      .prepare(
        `INSERT INTO artifact_view_grants
       (workspace_id,id,version_id,grant_hash,view_nonce_hash,human_id,session_hash,
        authorization_epoch,content_hash,expires_at,consumed_at,created_at)
       VALUES (?,?,?,?,?,?,?,3,?,?,?,?)`,
      )
      .run(
        FIX.workspace,
        id,
        versionId,
        artifactHash(id),
        artifactHash("nonce." + id),
        FIX.owner,
        artifactHash("session." + id),
        digest,
        oldUploadAt,
        oldUploadAt,
        oldUploadAt,
      );
    return id;
  }
  const sourceByAction = new Map<string, string>();
  let auditUploadGrant = "";
  for (const action of ARTIFACT_AUDIT_ACTIONS) {
    let grantId: string | null = null;
    if (
      [
        "artifact.grant_issued",
        "artifact.grant_reissued",
        "artifact.grant_consumed",
        "artifact.upload_verified",
      ].includes(action)
    ) {
      grantId = await seedAuditUploadGrant(canonicalLog);
      auditUploadGrant = grantId;
    } else if (["artifact.view_issued", "artifact.view_redeemed"].includes(action)) {
      grantId = await seedAuditViewGrant(canonicalLog);
    }
    sourceByAction.set(action, await seedAuditSource(action, canonicalLog, grantId));
  }
  const runFreeAuditVersion = await seedOperationsVersion(null, "available");
  const runFreeAuditSource = await seedAuditSource("artifact.finalized", runFreeAuditVersion, null);
  const runFreeAuditTimes = (await db
    .prepare(
      "SELECT created_at,dispatched_at FROM artifact_audit_outbox WHERE workspace_id=? AND id=?",
    )
    .get(FIX.workspace, runFreeAuditSource)) as { created_at: string; dispatched_at: string };
  const auditOptions = { access: auditAccess, after: auditAnchorId, limit: 100 };
  const canonicalAudit = await readSecurityAudit(db, FIX.workspace, auditOptions);
  assert.equal(canonicalAudit.entries.length, 20);
  assert.equal(canonicalAudit.has_more, false);
  for (const [action, id] of sourceByAction) {
    assert(canonicalAudit.entries.some((row) => row.audit_id === id && row.action === action));
    assert(
      canonicalAudit.entries.some(
        (row) =>
          row.action === "artifact.dispatch_audit" && JSON.stringify(row.payload).includes(id),
      ),
    );
  }
  assert(canonicalAudit.entries.some((row) => row.audit_id === runFreeAuditSource));
  // Historical direct payloads are not provenance and cannot replace typed
  // canonical fields with a private identity or arbitrary identifier prose.
  await db
    .prepare("UPDATE audit_events SET payload_json=? WHERE workspace_id=? AND audit_id=?")
    .run(
      JSON.stringify({ version_id: privateLog, canary_id: "SYNTHETIC-PRIVATE-AUDIT-CANARY" }),
      FIX.workspace,
      sourceByAction.get("artifact.finalized"),
    );
  assert.deepEqual(await readSecurityAudit(db, FIX.workspace, auditOptions), canonicalAudit);
  check("real_d1_canonical_artifact_audit_reconstructs_nine_sources_and_runfree_history");

  // SQLite text length and GLOB stop at NUL, but JSON retains the suffix.
  // Genuine canonical parents do not authorize malformed typed receipt fields.
  const nulAuditIds: string[] = [];
  for (const field of ["source_time", "outbox_id"]) {
    const suffix = "\0SYNTHETIC-NUL-AUDIT-CANARY";
    const id = randomUlid() + (field === "outbox_id" ? suffix : "");
    const sourceTime = auditAnchorAt + (field === "source_time" ? suffix : "");
    await db
      .prepare(
        `INSERT INTO artifact_audit_outbox
       (workspace_id,id,version_id,grant_id,action,payload_json,created_at,dispatched_at)
       VALUES (?,?,?,NULL,'artifact.finalized','{"synthetic":true}',?,?)`,
      )
      .run(FIX.workspace, id, runFreeAuditVersion, sourceTime, auditAnchorAt);
    await db
      .prepare(
        `INSERT INTO audit_events
       (workspace_id,audit_id,actor_principal_id,action,payload_json,created_at)
       VALUES (?,?,?,'artifact.finalized','{"synthetic":true}',?)`,
      )
      .run(FIX.workspace, id, ARTIFACT_RECOVERY_SYSTEM_ID, auditAnchorAt);
    nulAuditIds.push(id);
  }
  assert.deepEqual(await readSecurityAudit(db, FIX.workspace, auditOptions), canonicalAudit);
  const nulAuditPage = await readSecurityAudit(db, FIX.workspace, { ...auditOptions, limit: 1 });
  assert.equal(nulAuditPage.entries[0]?.audit_id, sourceByAction.get(ARTIFACT_AUDIT_ACTIONS[0]));
  assert.equal(nulAuditPage.has_more, true);
  for (const after of nulAuditIds) {
    await assert.rejects(readSecurityAudit(db, FIX.workspace, { ...auditOptions, after }), {
      code: "invalid_argument",
      message: "unknown audit cursor",
    });
  }
  check("real_d1_artifact_audit_nul_suffixed_typed_fields_are_omitted_before_page_and_anchor");

  const privateAuditSource = await seedAuditSource("artifact.finalized", privateLog, null);
  await seedAuditSource("artifact.view_issued", canonicalLog, auditUploadGrant);
  await seedAuditSource("artifact.grant_issued", runFreeAuditVersion, auditUploadGrant);
  async function insertHistoricalAudit(action: string, payload: string) {
    await db
      .prepare(
        `INSERT INTO audit_events
       (workspace_id,audit_id,actor_principal_id,action,payload_json,created_at)
       VALUES (?,?,?,?,?,?)`,
      )
      .run(
        FIX.workspace,
        randomUlid(),
        ARTIFACT_RECOVERY_SYSTEM_ID,
        action,
        payload,
        runFreeAuditTimes.dispatched_at,
      );
  }
  const projection = {
    schema_version: 1,
    outbox_id: runFreeAuditSource,
    version_id: runFreeAuditVersion,
    grant_id: null,
    source_action: "artifact.finalized",
    occurred_at: runFreeAuditTimes.created_at,
  };
  const wrapperActor = { systemId: ARTIFACT_RECOVERY_SYSTEM_ID, authorizationEpoch: 1 };
  await insertHistoricalAudit("Artifact.Finalized", JSON.stringify({ version_id: privateLog }));
  await insertHistoricalAudit("artifact.dispatch_audit", "not-json");
  await insertHistoricalAudit(
    "artifact.dispatch_audit",
    JSON.stringify({
      actor: wrapperActor,
      input: JSON.stringify({ outbox_id: runFreeAuditSource }),
      result: projection,
    }),
  );
  await insertHistoricalAudit(
    "artifact.dispatch_audit",
    JSON.stringify({
      actor: wrapperActor,
      input: { outbox_id: runFreeAuditSource },
      result: { ...projection, extra_id: privateLog },
    }),
  );
  const duplicateInput =
    '{"outbox_id":"' + runFreeAuditSource + '","outbox_id":"' + privateAuditSource + '"}';
  await insertHistoricalAudit(
    "artifact.dispatch_audit",
    '{"actor":' +
      JSON.stringify(wrapperActor) +
      ',"input":' +
      duplicateInput +
      ',"result":' +
      JSON.stringify(projection) +
      "}",
  );
  // An orphan historical wrapper cannot invent the paired direct receipt
  // which real production dispatch writes atomically.
  const orphanSource = randomUlid();
  await db
    .prepare(
      `INSERT INTO artifact_audit_outbox
     (workspace_id,id,version_id,grant_id,action,payload_json,created_at,dispatched_at)
     VALUES (?,?,?,NULL,'artifact.finalized','{"synthetic":true}',?,?)`,
    )
    .run(
      FIX.workspace,
      orphanSource,
      runFreeAuditVersion,
      runFreeAuditTimes.created_at,
      runFreeAuditTimes.dispatched_at,
    );
  await insertHistoricalAudit(
    "artifact.dispatch_audit",
    JSON.stringify({
      actor: wrapperActor,
      input: { outbox_id: orphanSource },
      result: { ...projection, outbox_id: orphanSource },
    }),
  );
  assert.deepEqual(await readSecurityAudit(db, FIX.workspace, auditOptions), canonicalAudit);
  const firstAuditPage = await readSecurityAudit(db, FIX.workspace, { ...auditOptions, limit: 1 });
  assert.equal(firstAuditPage.entries[0]?.audit_id, sourceByAction.get(ARTIFACT_AUDIT_ACTIONS[0]));
  assert.equal(firstAuditPage.has_more, true);
  check("real_d1_artifact_audit_hidden_misbound_and_malformed_rows_do_not_consume_page_or_count");
  for (const after of [privateAuditSource, randomUlid()]) {
    await assert.rejects(readSecurityAudit(db, FIX.workspace, { ...auditOptions, after }), {
      code: "invalid_argument",
      message: "unknown audit cursor",
    });
  }
  check("real_d1_artifact_audit_hidden_and_unknown_anchor_denial_parity");

  const auditTask = (await db
    .prepare(
      `SELECT run.task_id,task.created_by_human_id FROM runs AS run
       JOIN tasks AS task ON task.workspace_id=run.workspace_id AND task.id=run.task_id
       WHERE run.workspace_id=? AND run.id=?`,
    )
    .get(FIX.workspace, operationsRun)) as { task_id: string; created_by_human_id: string };
  function beforeAuditSelection(change: () => Promise<void>): SqlDatabase {
    let changed = false;
    async function applyChange() {
      if (!changed) {
        changed = true;
        await change();
      }
    }
    return {
      ...db,
      prepare(sql) {
        const statement = db.prepare(sql);
        return {
          ...statement,
          async get(...parameters: unknown[]) {
            await applyChange();
            return statement.get(...parameters);
          },
          async all(...parameters: unknown[]) {
            await applyChange();
            return statement.all(...parameters);
          },
        };
      },
    };
  }
  const parentChangedAudit = await readSecurityAudit(
    beforeAuditSelection(async () => {
      await db
        .prepare(
          "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
        )
        .run(FIX.workspace, auditTask.task_id, auditTask.created_by_human_id, now);
    }),
    FIX.workspace,
    auditOptions,
  );
  assert.equal(parentChangedAudit.entries.length, 2);
  assert(
    parentChangedAudit.entries.every((row) =>
      JSON.stringify(row.payload).includes(runFreeAuditVersion),
    ),
  );
  assert.equal(parentChangedAudit.has_more, false);
  check("real_d1_artifact_audit_final_selection_drops_parent_privatized_before_delivery");
  const lastRunFreeAudit = parentChangedAudit.entries.at(-1)!.audit_id;
  assert.deepEqual(
    await readSecurityAudit(db, FIX.workspace, { ...auditOptions, after: lastRunFreeAudit }),
    { entries: [], has_more: false },
  );
  await assert.rejects(
    readSecurityAudit(
      beforeAuditSelection(async () => {
        await db
          .prepare(
            "UPDATE workspace_members SET authorization_epoch=4 WHERE workspace_id=? AND human_id=?",
          )
          .run(FIX.workspace, FIX.owner);
        await db
          .prepare(
            "UPDATE workspace_authorization_epochs SET authorization_epoch=4 WHERE workspace_id=? AND human_id=?",
          )
          .run(FIX.workspace, FIX.owner);
      }),
      FIX.workspace,
      { ...auditOptions, after: lastRunFreeAudit },
    ),
    { code: "not_found", message: "operations scope not found" },
  );
  check("real_d1_empty_artifact_audit_scope_denial_after_epoch_loss");
  console.log(
    JSON.stringify({
      schema_version: 1,
      stage: "human_task_child_and_partial_metadata_surfaces",
      migration_head: manifest.migration_head,
      checks,
      outcome: "passed",
      limits: [
        "synthetic policies only",
        "no full C11 delivery certificate",
        "partial metadata/retention/upload-recovery/canonical artifact audit fences, not opaque positions or complete operations privacy",
        "natural credential expiry in flight remains uncertified",
        "real D1/domain/Hub proof, not real HTTP OAuth or provider execution",
        "grant-consumption proof, not live R2 or private browser-byte delivery",
      ],
    }),
  );
  console.log("C11_TASK_D1_OK");
} finally {
  await server.close();
}
