// ABOUTME: Proves human discussion-list and launch-status parent fences on disposable real D1.
// ABOUTME: Canonical synthetic retained history never claims provider execution or private coordination support.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adaptD1, type D1Like, type SqlDatabase } from "@bfb/db";
import {
  FIX,
  listTaskDiscussions,
  loadPrincipal,
  randomUlid,
  seedSyntheticWorkspace,
  type CommandOutcome,
  type CreateRunResult,
  type ExecutionRecord,
  type TaskRecord,
} from "@bfb/domain";
import { encodeWireDocument } from "@bfb/protocol";
import { createTestHarness } from "wrangler";
import {
  launchStatusById,
  launchStatusForTask,
} from "../../apps/control-worker/src/api/launch-status.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
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
const fixtureHash = (value: unknown) =>
  `sha256:${createHash("sha256").update(encodeWireDocument(value), "utf8").digest("hex")}`;

async function command<T>(commandName: string, input: unknown): Promise<T> {
  const response = await server
    .getWorker("bfb-work-records-a")
    .fetch(`https://bfb.coordination.test/workspaces/${FIX.workspace}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandName,
        request: {
          workspaceId: FIX.workspace,
          actorHumanId: FIX.member,
          authorizationEpoch: 1,
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

function beforeSelection(db: SqlDatabase, needle: string, change: () => Promise<void>) {
  let changed = false;
  async function maybeChange(sql: string) {
    if (!changed && sql.includes(needle)) {
      changed = true;
      await change();
    }
  }
  return {
    changed: () => changed,
    db: {
      ...db,
      prepare(sql: string) {
        const statement = db.prepare(sql);
        return {
          ...statement,
          async get(...parameters: unknown[]) {
            await maybeChange(sql);
            return statement.get(...parameters);
          },
          async all(...parameters: unknown[]) {
            await maybeChange(sql);
            return statement.all(...parameters);
          },
        };
      },
    } satisfies SqlDatabase,
  };
}

try {
  await server.listen();
  const worker = server.getWorker("bfb-work-records-hub");
  await worker.applyD1Migrations("DB");
  const binding = ((await worker.getEnv()) as unknown as { DB: D1Like }).DB;
  const db = adaptD1(binding),
    independent = adaptD1(binding);
  await seedSyntheticWorkspace(db, now);
  const task = await command<TaskRecord>("task.create", {
    projectId: FIX.projectA,
    title: "Synthetic retained coordination history",
    priority: "P1",
    nextOwnerType: "human",
    nextOwnerId: FIX.member,
  });
  const emptyTask = await command<TaskRecord>("task.create", {
    projectId: FIX.projectA,
    title: "Synthetic empty coordination history",
    priority: "P2",
    nextOwnerType: "human",
    nextOwnerId: FIX.member,
  });
  const discussionIds = [randomUlid(), randomUlid()].sort();
  const brief = {
    schema_version: 1,
    task_id: task.id,
    title: "Synthetic retained coordination history",
    question: "Synthetic history only",
    git_revision: "a".repeat(40),
    context: [],
  };
  for (const id of discussionIds) {
    await db
      .prepare(
        `INSERT INTO discussions
        (workspace_id,id,project_id,task_id,sponsor_human_id,sponsor_authorization_epoch,
         task_version,brief_json,brief_hash,context_hash,git_revision,rounds,deadline,
         state,resource_version,created_at)
        VALUES (?,?,?,?,?,1,1,?,?,?,?,1,?,'active',1,?)`,
      )
      .run(
        FIX.workspace,
        id,
        FIX.projectA,
        task.id,
        FIX.member,
        JSON.stringify(brief),
        fixtureHash(brief),
        fixtureHash({ task_id: task.id, title: task.title, context: [] }),
        brief.git_revision,
        new Date(Date.parse(now) + 600_000).toISOString(),
        now,
      );
  }
  const owner = await loadPrincipal(db, FIX.workspace, FIX.owner);
  const first = await listTaskDiscussions(db, owner, task.id, { limit: 1 });
  assert.deepEqual(
    first.discussions.map((item) => item.id),
    [discussionIds[0]],
  );
  assert.equal(first.has_more, true);
  assert.equal(first.next_cursor, discussionIds[0]);
  assert(first.next_cursor);
  const second = await listTaskDiscussions(db, owner, task.id, {
    limit: 1,
    cursor: first.next_cursor,
  });
  assert.deepEqual(
    second.discussions.map((item) => item.id),
    [discussionIds[1]],
  );
  assert.equal(second.has_more, false);
  assert.deepEqual(await listTaskDiscussions(db, owner, emptyTask.id), {
    schema_version: 1,
    discussions: [],
    has_more: false,
  });
  checks.push("real_d1_shared_discussion_lists_preserve_pagination_and_empty_parent_scope");

  const run = await command<CreateRunResult>("run.create", {
    taskId: task.id,
    expectedTaskVersion: 1,
    agentProfileId: FIX.profileCodex,
    workspacePolicyVersion: 1,
    projectPolicyVersion: 1,
    repositoryConfigVersion: 1,
    agentProfileVersion: 1,
  });
  const execution = await command<ExecutionRecord>("execution.create", { runId: run.run.id });
  const runnerId = randomUlid(),
    checkoutId = randomUlid(),
    launchId = randomUlid(),
    digest = `sha256:${"a".repeat(64)}`;
  await db
    .prepare(
      `INSERT INTO runners
       (workspace_id,id,owner_human_id,device_label,public_key_json,key_thumbprint,token_epoch,enrolled_at)
       VALUES (?,?,?,'Synthetic retained runner','{}','synthetic-history-key',1,?)`,
    )
    .run(FIX.workspace, runnerId, FIX.member, now);
  await db
    .prepare(
      `INSERT INTO execution_assignments
       (workspace_id,execution_id,assignment_generation,run_id,task_id,project_id,
        runner_id,checkout_id,physical_worktree_hash,requesting_human_id,
        requesting_human_epoch,runner_authorization_epoch,runner_grant_epoch,
        runner_key_thumbprint,created_at)
       VALUES (?,?,1,?,?,?,?,?,?,?,1,1,1,'synthetic-history-key',?)`,
    )
    .run(
      FIX.workspace,
      execution.id,
      run.run.id,
      task.id,
      FIX.projectA,
      runnerId,
      checkoutId,
      digest,
      FIX.member,
      now,
    );
  await db
    .prepare(
      `INSERT INTO launch_commands
       (workspace_id,id,execution_id,assignment_generation,run_id,requesting_human_id,
        idempotency_key_hash,request_hash,state,snapshot_id,created_at,expires_at)
       VALUES (?,?,?,1,?,?,?,?,'pending',?,?,?)`,
    )
    .run(
      FIX.workspace,
      launchId,
      execution.id,
      run.run.id,
      FIX.member,
      "b".repeat(64),
      "c".repeat(64),
      run.snapshot.id,
      now,
      new Date(Date.parse(now) + 120_000).toISOString(),
    );
  assert.deepEqual(
    (await launchStatusForTask(db, owner, task.id, 1)).launches.map((item) => item.launch_id),
    [launchId],
  );
  assert.equal((await launchStatusById(db, owner, launchId)).launch.run_id, run.run.id);
  assert.deepEqual(await launchStatusForTask(db, owner, emptyTask.id), { launches: [] });
  checks.push("real_d1_canonical_launch_status_preserves_exact_history_and_empty_list");

  const rows = await db
    .prepare("SELECT * FROM launch_commands WHERE workspace_id=?")
    .all(FIX.workspace);
  await db
    .prepare(
      "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
    )
    .run(FIX.workspace, task.id, FIX.member, now);
  await db
    .prepare(
      `INSERT INTO task_human_grants
       (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at)
       VALUES (?,?,?,?,1,'read',?)`,
    )
    .run(FIX.workspace, randomUlid(), task.id, FIX.owner, now);
  for (const viewer of [owner, await loadPrincipal(db, FIX.workspace, FIX.member)]) {
    await assert.rejects(launchStatusForTask(db, viewer, task.id), { code: "not_found" });
    await assert.rejects(launchStatusById(db, viewer, launchId), { code: "not_found" });
    await assert.rejects(listTaskDiscussions(db, viewer, task.id), { code: "not_found" });
  }
  assert.deepEqual(
    await db.prepare("SELECT * FROM launch_commands WHERE workspace_id=?").all(FIX.workspace),
    rows,
  );
  checks.push(
    "real_d1_private_parent_holds_status_and_discussion_lists_for_creator_and_grantee_without_rewrite",
  );

  const guarded = beforeSelection(db, "discussions", async () => {
    await independent
      .prepare(
        "UPDATE workspace_authorization_epochs SET revoked_at=? WHERE workspace_id=? AND human_id=?",
      )
      .run(now, FIX.workspace, FIX.owner);
  });
  await assert.rejects(listTaskDiscussions(guarded.db, owner, emptyTask.id), { code: "not_found" });
  assert.equal(guarded.changed(), true);
  checks.push("real_d1_empty_discussion_page_rechecks_epoch_in_final_selection");
  await assert.rejects(launchStatusForTask(db, owner, emptyTask.id), { code: "not_found" });
  await assert.rejects(launchStatusById(db, owner, randomUlid()), { code: "not_found" });
  checks.push("real_d1_empty_and_missing_launch_status_require_retained_current_epoch");

  console.log(
    JSON.stringify({
      schema_version: 1,
      checks,
      outcome: "passed",
      limits: [
        "Synthetic retained list/status history, not complete discussion hydration or browser authentication",
        "No provider operation, participant authority, runner cleanup, private activation or opaque positions",
      ],
    }),
  );
  console.log("C11_HUMAN_COORDINATION_D1_OK");
} finally {
  await server.close();
}
