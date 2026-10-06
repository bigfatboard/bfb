// ABOUTME: Proves staged human task reads and current-authority work-command retries on disposable real D1.
// ABOUTME: Two independent Workers dispatch the production Hub; synthetic policies do not activate private creation.

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { adaptD1, loadMigrationManifest, type D1Like } from "@bfb/db";
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
          authorizationEpoch: 1,
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
  const db = adaptD1(((await worker.getEnv()) as unknown as { DB: D1Like }).DB);
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
  console.log(
    JSON.stringify({
      schema_version: 1,
      stage: "human_task_surfaces",
      migration_head: manifest.migration_head,
      checks,
      outcome: "passed",
      limits: [
        "synthetic policies only",
        "no full C11 delivery certificate",
        "real D1/domain/Hub proof, not real HTTP OAuth or provider execution",
      ],
    }),
  );
  console.log("C11_TASK_D1_OK");
} finally {
  await server.close();
}
