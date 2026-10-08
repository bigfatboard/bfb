// ABOUTME: Proves canonical board and attention-deck access on disposable real D1.
// ABOUTME: Synthetic grant revocation never activates private creation or operates providers.

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adaptD1, type D1Like, type SqlDatabase } from "@bfb/db";
import {
  FIX,
  buildProjectLanes,
  loadPrincipal,
  randomUlid,
  readWorkBoard,
  seedSyntheticWorkspace,
  type CommandOutcome,
  type TaskRecord,
} from "@bfb/domain";
import { createTestHarness } from "wrangler";

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

async function createTask(title: string): Promise<TaskRecord> {
  const response = await server
    .getWorker("bfb-work-records-a")
    .fetch(`https://bfb.board.test/workspaces/${FIX.workspace}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandName: "task.create",
        request: {
          workspaceId: FIX.workspace,
          actorHumanId: FIX.member,
          authorizationEpoch: 1,
          idempotencyKey: randomUlid(),
          now,
          input: {
            projectId: FIX.projectA,
            title,
            priority: "P0",
            nextOwnerType: "human",
            nextOwnerId: FIX.owner,
            nextActionReason: "Synthetic current decision",
            dueAt: new Date(Date.parse(now) - 60_000).toISOString(),
          },
        },
      }),
    });
  assert.equal(response.status, 200);
  const outcome = (await response.json()) as CommandOutcome<TaskRecord>;
  assert(outcome.ok, outcome.ok ? undefined : outcome.error.code);
  return outcome.result;
}

function revokeBeforeBoardSelection(
  db: SqlDatabase,
  revoke: () => Promise<void>,
): { db: SqlDatabase; changed: () => boolean } {
  let changed = false;
  async function change(sql: string, method: "get" | "all") {
    // The old reader hydrates names after loading task bodies. The canonical
    // reader performs one get, so its change occurs before the final selection.
    if (!changed && (method === "get" || sql.includes("FROM workspace_members AS member"))) {
      changed = true;
      await revoke();
    }
  }
  return {
    changed: () => changed,
    db: {
      ...db,
      prepare(sql) {
        const statement = db.prepare(sql);
        return {
          ...statement,
          async get(...parameters: unknown[]) {
            await change(sql, "get");
            return statement.get(...parameters);
          },
          async all(...parameters: unknown[]) {
            await change(sql, "all");
            return statement.all(...parameters);
          },
        };
      },
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
  await seedSyntheticWorkspace(db, now);
  const privateTask = await createTask("SYNTHETIC_PRIVATE_BOARD_CANARY");
  const sharedTask = await createTask("Synthetic shared board work");
  await db
    .prepare(
      "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
    )
    .run(FIX.workspace, privateTask.id, FIX.member, now);
  const grantId = randomUlid();
  await db
    .prepare(
      `INSERT INTO task_human_grants
      (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at)
      VALUES (?,?,?,?,1,'read',?)`,
    )
    .run(FIX.workspace, grantId, privateTask.id, FIX.owner, now);
  const principal = await loadPrincipal(db, FIX.workspace, FIX.owner);
  const guarded = revokeBeforeBoardSelection(db, async () => {
    await independent
      .prepare("UPDATE task_human_grants SET revoked_at=? WHERE workspace_id=? AND id=?")
      .run(now, FIX.workspace, grantId);
  });
  const lanes = await buildProjectLanes(guarded.db, FIX.workspace, principal.projectIds, principal);
  assert.equal(guarded.changed(), true);
  assert(lanes.flatMap((lane) => lane.tasks).some((card) => card.taskId === sharedTask.id));
  assert.doesNotMatch(JSON.stringify(lanes), /SYNTHETIC_PRIVATE_BOARD_CANARY/);
  checks.push("real_d1_board_revoked_grant_cannot_survive_late_hydration_or_final_selection");

  // Historical rows stay intact; this synthetic scope supplies only two urgent tasks.
  await db
    .prepare(
      "UPDATE tasks SET next_owner_type='unassigned',next_owner_id=NULL WHERE workspace_id=?",
    )
    .run(FIX.workspace);
  const second = `${now.slice(0, 19)}Z`;
  const fractional = `${now.slice(0, 19)}.000001Z`;
  const laterTask = await createTask("Synthetic fractional due work");
  await db
    .prepare("UPDATE tasks SET next_owner_type='human',next_owner_id=?,due_at=? WHERE id=?")
    .run(FIX.owner, second, sharedTask.id);
  await db.prepare("UPDATE tasks SET due_at=? WHERE id=?").run(fractional, laterTask.id);
  let selects = 0;
  const current = revokeBeforeBoardSelection(db, async () => {
    await independent
      .prepare("UPDATE workspace_members SET role='owner' WHERE workspace_id=? AND human_id=?")
      .run(FIX.workspace, FIX.member);
    await independent
      .prepare("UPDATE workspace_members SET role='reviewer' WHERE workspace_id=? AND human_id=?")
      .run(FIX.workspace, FIX.owner);
    await independent
      .prepare(
        "UPDATE tasks SET title='Synthetic current board title' WHERE workspace_id=? AND id=?",
      )
      .run(FIX.workspace, sharedTask.id);
    await independent
      .prepare("UPDATE workspace_policies SET allow_pass_to_agent=0 WHERE workspace_id=?")
      .run(FIX.workspace);
  });
  const counted: SqlDatabase = {
    ...current.db,
    prepare(sql) {
      selects++;
      assert.match(sql, /board_scope AS MATERIALIZED/);
      assert.doesNotMatch(sql, /semantic_events/);
      return current.db.prepare(sql);
    },
  };
  const snapshot = await readWorkBoard(
    counted,
    FIX.workspace,
    principal.projectIds,
    second,
    principal,
  );
  assert.equal(selects, 1);
  assert.equal(current.changed(), true);
  assert.equal(snapshot.role, "reviewer");
  assert.equal(snapshot.authorizationEpoch, 1);
  assert.equal(snapshot.recentEventsAvailable, false);
  assert.equal(
    snapshot.lanes.flatMap((lane) => lane.tasks).find((card) => card.taskId === sharedTask.id)
      ?.title,
    "Synthetic current board title",
  );
  assert(snapshot.lanes.flatMap((lane) => lane.tasks).every((card) => !("latestEvent" in card)));
  assert.deepEqual(
    snapshot.needsNow.map((item) => item.taskId),
    [sharedTask.id],
  );
  const precise = await readWorkBoard(
    db,
    FIX.workspace,
    principal.projectIds,
    `${now.slice(0, 19)}.200000Z`,
    principal,
  );
  assert.deepEqual(
    precise.needsNow.map((item) => item.taskId),
    [sharedTask.id, laterTask.id],
  );
  checks.push(
    "real_d1_one_current_board_statement_preserves_role_body_and_precise_deck_chronology",
  );

  const insertRun = db.prepare(`INSERT INTO runs
    (workspace_id,id,project_id,task_id,requested_by_human_id,agent_profile_id,
     result_state,activity,resource_version,created_at,purpose)
    VALUES (?,?,?,?,?,? ,?,'unknown',1,?,?)`);
  for (const [id, result, timestamp, purpose] of [
    [randomUlid(), "open", second, "work"],
    [randomUlid(), "accepted", `${now.slice(0, 19)}.1Z`, "work"],
    [randomUlid(), "failed", `${now.slice(0, 19)}.2Z`, "discussion"],
    [randomUlid() + "\u0000SYNTHETIC_RUN_CANARY", "failed", `${now.slice(0, 19)}.3Z`, "work"],
  ]) {
    await insertRun.run(
      FIX.workspace,
      id,
      FIX.projectA,
      sharedTask.id,
      FIX.member,
      FIX.profileCodex,
      result,
      timestamp,
      purpose,
    );
  }
  const recorded = await readWorkBoard(db, FIX.workspace, principal.projectIds, now, principal);
  assert.deepEqual(
    recorded.lanes.flatMap((lane) => lane.tasks).find((card) => card.taskId === sharedTask.id)
      ?.runSummary,
    { resultState: "accepted", activity: "unknown" },
  );
  checks.push("real_d1_recorded_terminal_work_is_not_overridden_by_discussion_or_nul_run_identity");

  const narrowed = revokeBeforeBoardSelection(db, async () => {
    await independent
      .prepare("UPDATE projects SET access_mode='restricted' WHERE workspace_id=? AND id=?")
      .run(FIX.workspace, FIX.projectA);
    await independent
      .prepare("DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?")
      .run(FIX.workspace, FIX.projectA, FIX.owner);
  });
  const withoutProject = await readWorkBoard(
    narrowed.db,
    FIX.workspace,
    [FIX.projectA],
    now,
    principal,
  );
  assert.equal(narrowed.changed(), true);
  assert.deepEqual(withoutProject.lanes, []);
  assert.deepEqual(withoutProject.needsNow, []);
  await db
    .prepare("UPDATE projects SET access_mode='workspace' WHERE workspace_id=? AND id=?")
    .run(FIX.workspace, FIX.projectA);
  checks.push("real_d1_captured_project_ids_do_not_override_current_project_loss");

  const insertFiller = db.prepare(`INSERT INTO tasks
    (workspace_id,id,project_id,title,state,priority,next_owner_type,punchline,
     resource_version,created_by_human_id,created_at)
    VALUES (?,?,?,'Synthetic bounded filler','ready','P3','unassigned','Later',1,?,?)`);
  for (let index = 0; index < 50; index++) {
    await insertFiller.run(
      FIX.workspace,
      `0000000000000000000000${String(index).padStart(4, "0")}`,
      FIX.projectA,
      FIX.member,
      now,
    );
  }
  // Creating business records still uses the production Hub's Member authority.
  await createTask("Synthetic third urgent work");
  await createTask("Synthetic fourth urgent work");
  const bounded = await readWorkBoard(
    db,
    FIX.workspace,
    [FIX.projectA, ...Array.from({ length: 150 }, () => randomUlid())],
    `${now.slice(0, 19)}.200000Z`,
    principal,
  );
  assert.equal(bounded.lanes[0]?.tasks.length, 50);
  assert(bounded.lanes[0]?.tasks.every((card) => card.priority === "P3"));
  assert.equal(bounded.needsNow.length, 3);
  assert(bounded.needsNow.every((item) => item.priority === "P0"));
  checks.push(
    "real_d1_fixed_bind_project_set_keeps_global_fifty_cards_independent_of_three_deck_items",
  );

  const empty = revokeBeforeBoardSelection(db, async () => {
    await independent
      .prepare(
        "UPDATE workspace_authorization_epochs SET authorization_epoch=2 WHERE workspace_id=? AND human_id=?",
      )
      .run(FIX.workspace, FIX.owner);
    await independent
      .prepare(
        "UPDATE workspace_members SET authorization_epoch=2 WHERE workspace_id=? AND human_id=?",
      )
      .run(FIX.workspace, FIX.owner);
  });
  await assert.rejects(readWorkBoard(empty.db, FIX.workspace, [], "invalid", principal), {
    code: "not_found",
    message: "board scope not found",
  });
  assert.equal(empty.changed(), true);
  await assert.rejects(readWorkBoard(db, FIX.workspace, [], now, undefined as never), {
    code: "invalid_argument",
  });
  checks.push(
    "real_d1_empty_board_invalid_clock_still_fences_retained_epoch_and_requires_human_context",
  );
  console.log(JSON.stringify({ schema_version: 1, checks, outcome: "passed" }));
  console.log("C11_BOARD_D1_OK");
} finally {
  await server.close();
}
