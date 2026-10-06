// ABOUTME: Proves the dormant task-access kernel against disposable real workerd D1 and production Hub task creation.
// ABOUTME: Uses synthetic policy inserts only; no private command, pilot, provider or transport certificate is implied.

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { adaptD1, loadMigrationManifest, type D1Like } from "@bfb/db";
import {
  assertTaskAccess,
  taskAccessPredicate,
  bumpMemberEpoch,
  FIX,
  randomUlid,
  seedSyntheticWorkspace,
  type CommandOutcome,
  type TaskRecord,
} from "@bfb/domain";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const origin = "https://bfb.work-records.test";
const now = "2026-10-06T12:00:00.000Z";
const server = createTestHarness({
  root,
  workers: [
    { configPath: "tools/work-records/wrangler-a.toml" },
    { configPath: "tools/work-records/wrangler-b.toml" },
    { configPath: "tools/work-records/wrangler-hub.toml" },
  ],
});

const checked: string[] = [];
function check(name: string) {
  checked.push(name);
}
function context(humanId = FIX.owner, epoch = 1) {
  return { workspaceId: FIX.workspace, humanId, authorizationEpoch: epoch };
}

try {
  await server.listen();
  const hub = server.getWorker("bfb-work-records-hub");
  await hub.applyD1Migrations("DB");
  const db = adaptD1(((await hub.getEnv()) as unknown as { DB: D1Like }).DB);
  const manifest = loadMigrationManifest(resolve(root, "migrations/d1"));
  const migrations = (await db.prepare("SELECT name FROM d1_migrations ORDER BY name").all()) as {
    name: string;
  }[];
  assert.deepEqual(
    migrations.map((row) => row.name),
    manifest.migrations.map((row) => row.file),
  );
  check("ordered_empty_d1_migrations");
  await seedSyntheticWorkspace(db);

  const ids: string[] = [];
  for (const name of ["bfb-work-records-a", "bfb-work-records-b"]) {
    const response = await server
      .getWorker(name)
      .fetch(`${origin}/workspaces/${FIX.workspace}/execute`, {
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
            input: { projectId: FIX.projectA, title: "Synthetic C10 task", priority: "P2" },
          },
        }),
      });
    assert.equal(response.status, 200);
    const outcome = (await response.json()) as CommandOutcome<TaskRecord>;
    if (!outcome.ok) throw new Error(outcome.error.code);
    ids.push(outcome.result.id);
  }
  assert.deepEqual(await db.prepare("SELECT COUNT(*) AS n FROM task_privacy").get(), { n: 0 });
  check("production_hub_creation_remains_shared");
  const [privateId, sharedId] = ids as [string, string];
  await assert.rejects(
    db
      .prepare(
        `INSERT INTO task_privacy
    (workspace_id, task_id, owner_human_id, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(FIX.workspace, privateId, FIX.owner, now),
    /creator/,
  );
  await db
    .prepare(
      `INSERT INTO task_privacy
    (workspace_id, task_id, owner_human_id, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run(FIX.workspace, privateId, FIX.member, now);
  await assert.rejects(db.prepare("DELETE FROM task_privacy").run(), /retained/);
  await assert.rejects(
    db.prepare("UPDATE task_privacy SET owner_human_id = ?").run(FIX.owner),
    /immutable/,
  );
  check("creator_binding_policy_retention");
  await assert.rejects(assertTaskAccess(db, context(), privateId), {
    code: "not_found",
    message: "task not found",
  });
  await assert.rejects(assertTaskAccess(db, context(FIX.reviewer), privateId), {
    code: "not_found",
  });
  await assertTaskAccess(db, context(FIX.member), privateId, "manage_sharing");
  check("creator_only_no_owner_bypass");

  async function grant(humanId: string, permission: string, epoch = 1) {
    const id = randomUlid();
    await db
      .prepare(
        `INSERT INTO task_human_grants
      (workspace_id, id, task_id, human_id, authorization_epoch, permission, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(FIX.workspace, id, privateId, humanId, epoch, permission, now);
    return id;
  }
  const grantId = await grant(FIX.owner, "read");
  await assert.rejects(grant(FIX.owner, "read", 2), /epoch/);
  await assertTaskAccess(db, context(), privateId);
  await assert.rejects(assertTaskAccess(db, context(), privateId, "contribute"), {
    code: "not_found",
  });
  await assert.rejects(assertTaskAccess(db, context(), privateId, "manage_sharing"), {
    code: "not_found",
  });
  await grant(FIX.reviewer, "edit");
  await assertTaskAccess(db, context(FIX.reviewer), privateId, "contribute");
  await assert.rejects(assertTaskAccess(db, context(FIX.reviewer), privateId, "edit"), {
    code: "not_found",
  });
  check("grant_permissions_intersect_current_roles");
  await db.prepare("UPDATE task_human_grants SET revoked_at = ? WHERE id = ?").run(now, grantId);
  await assert.rejects(assertTaskAccess(db, context(), privateId), { code: "not_found" });
  await assert.rejects(
    db.prepare("UPDATE task_human_grants SET revoked_at = NULL WHERE id = ?").run(grantId),
    /revocation/,
  );
  await grant(FIX.owner, "edit");
  await bumpMemberEpoch(db, FIX.workspace, FIX.owner);
  for (const epoch of [1, 2])
    await assert.rejects(assertTaskAccess(db, context(FIX.owner, epoch), privateId), {
      code: "not_found",
    });
  await assertTaskAccess(db, context(FIX.owner, 2), sharedId);
  check("revocation_and_epoch_rotation_fence_stale_grants");

  const predicate = taskAccessPredicate(context(FIX.owner, 2), "read", "parent");
  assert.deepEqual(
    await db
      .prepare(
        `SELECT parent.id FROM tasks AS parent
    WHERE parent.id IN (?, ?) AND ${predicate.sql} ORDER BY parent.id LIMIT 1`,
      )
      .all(privateId, sharedId, ...predicate.parameters),
    [{ id: sharedId }],
  );
  assert.deepEqual(
    await db
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks AS parent
    WHERE parent.id IN (?, ?) AND ${predicate.sql}`,
      )
      .get(privateId, sharedId, ...predicate.parameters),
    { n: 1 },
  );
  check("list_and_count_filter_before_pagination");
  const restored = await grant(FIX.owner, "read", 2);
  await assertTaskAccess(db, context(FIX.owner, 2), privateId);
  await assert.rejects(
    db.prepare("UPDATE task_human_grants SET authorization_epoch = 3 WHERE id = ?").run(restored),
    /immutable/,
  );
  await db.prepare("UPDATE projects SET access_mode = 'restricted' WHERE id = ?").run(FIX.projectA);
  await db
    .prepare("DELETE FROM project_access WHERE project_id = ? AND human_id = ?")
    .run(FIX.projectA, FIX.owner);
  await assert.rejects(assertTaskAccess(db, context(FIX.owner, 2), privateId), {
    code: "not_found",
  });
  check("task_grant_never_grants_project_access");

  const partialId = randomUlid();
  await assert.rejects(
    db.withTransaction(async (tx) => {
      await tx
        .prepare(
          `INSERT INTO task_human_grants
      (workspace_id, id, task_id, human_id, authorization_epoch, permission, created_at)
      VALUES (?, ?, ?, ?, 1, 'read', ?)`,
        )
        .run(FIX.workspace, partialId, privateId, FIX.member, now);
      await tx
        .prepare(
          `INSERT INTO task_privacy
      (workspace_id, task_id, owner_human_id, created_at) VALUES (?, ?, ?, ?)`,
        )
        .run(FIX.workspace, sharedId, FIX.owner, now);
    }),
  );
  assert.equal(
    await db.prepare("SELECT id FROM task_human_grants WHERE id = ?").get(partialId),
    null,
  );
  check("failed_d1_batch_has_no_partial_grant");

  assert.deepEqual(await db.prepare("PRAGMA foreign_key_check").all(), []);
  process.stdout.write(
    `${JSON.stringify({
      schema_version: 1,
      migration_head: manifest.migration_head,
      checks: checked,
      outcome: "passed",
      limits: ["dormant kernel only", "synthetic policies", "no delivery or provider certificate"],
    })}\nC10_D1_OK\n`,
  );
} finally {
  await server.close();
}
