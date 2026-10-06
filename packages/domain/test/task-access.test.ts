// ABOUTME: Exercises creator-private task query authority with explicit grants and current role/epoch fences.
// ABOUTME: Checks pagination, child reads and uniform denial without enabling private task creation.

import type { SqlDatabase } from "@bfb/db";
import { beforeEach, describe, expect, it } from "vitest";
import { bumpMemberEpoch } from "../src/authorization.js";
import { resolveCommand } from "../src/command-catalog.js";
import { FIX } from "../src/fixtures.js";
import { WorkspaceHub } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import {
  assertTaskAccess,
  taskAccessPredicate,
  type TaskAccessAction,
} from "../src/task-access.js";
import { createTaskCommand } from "../src/work-commands.js";
import { openDomainDb } from "./helpers.js";

const now = "2026-10-06T12:00:00.000Z";
const actions: TaskAccessAction[] = ["read", "contribute", "edit", "manage_sharing"];
let db: SqlDatabase;
let privateId: string;
let sharedIds: string[];
function context(humanId = FIX.owner, authorizationEpoch = 1) {
  return { workspaceId: FIX.workspace, humanId, authorizationEpoch };
}
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

beforeEach(async () => {
  db = await openDomainDb();
  const hub = new WorkspaceHub(db);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const task = await hub.execute(createTaskCommand, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.member,
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      now,
      input: { projectId: FIX.projectA, title: `Synthetic task access ${i}`, priority: "P2" },
    });
    if (!task.ok) throw new Error(task.error.code);
    ids.push(task.result.id);
  }
  privateId = ids[0]!;
  sharedIds = ids.slice(1);
  await db
    .prepare(
      `INSERT INTO task_privacy
    (workspace_id, task_id, owner_human_id, access_version, created_at)
    VALUES (?, ?, ?, 1, ?)`,
    )
    .run(FIX.workspace, privateId, FIX.member, now);
});

describe("current task access matrix", () => {
  for (const humanId of [FIX.owner, FIX.reviewer]) {
    for (const permission of [null, "read", "contribute", "edit"]) {
      for (const action of actions) {
        it(`${humanId === FIX.owner ? "unshared owner" : "reviewer"}: ${permission ?? "no grant"} / ${action}`, async () => {
          if (permission) await grant(humanId, permission);
          const allowed =
            action !== "manage_sharing" &&
            permission !== null &&
            (action === "read" ||
              (action === "contribute" && ["contribute", "edit"].includes(permission)) ||
              (action === "edit" && permission === "edit" && humanId !== FIX.reviewer));
          const result = assertTaskAccess(db, context(humanId), privateId, action);
          if (allowed)
            await expect(result).resolves.toEqual({
              taskId: privateId,
              projectId: FIX.projectA,
              privateOwnerHumanId: FIX.member,
              accessVersion: 1,
            });
          else
            await expect(result).rejects.toMatchObject({
              code: "not_found",
              message: "task not found",
            });
        });
      }
    }
  }
  for (const action of actions) {
    it(`creator: ${action}`, async () => {
      await expect(
        assertTaskAccess(db, context(FIX.member), privateId, action),
      ).resolves.toMatchObject({ taskId: privateId });
    });
  }
  for (const humanId of [FIX.owner, FIX.member, FIX.reviewer]) {
    for (const action of actions) {
      it(`shared role ${humanId}: ${action}`, async () => {
        const allowed =
          action !== "manage_sharing" && !(action === "edit" && humanId === FIX.reviewer);
        const result = assertTaskAccess(db, context(humanId), sharedIds[0]!, action);
        if (allowed)
          await expect(result).resolves.toMatchObject({
            privateOwnerHumanId: null,
            accessVersion: null,
          });
        else await expect(result).rejects.toMatchObject({ code: "not_found" });
      });
    }
  }
});

describe("task access freshness and query boundaries", () => {
  it("rechecks explicit grant revocation and only an explicit new grant restores access", async () => {
    const id = await grant(FIX.owner, "edit");
    const stale = context();
    await assertTaskAccess(db, stale, privateId);
    await db.prepare("UPDATE task_human_grants SET revoked_at = ? WHERE id = ?").run(now, id);
    await expect(assertTaskAccess(db, stale, privateId)).rejects.toMatchObject({
      code: "not_found",
    });
    await grant(FIX.owner, "read");
    await expect(assertTaskAccess(db, stale, privateId)).resolves.toMatchObject({
      taskId: privateId,
    });
  });

  it("old grants do not survive membership epoch rotation, including a fresh caller context", async () => {
    await grant(FIX.owner, "edit");
    await bumpMemberEpoch(db, FIX.workspace, FIX.owner);
    for (const epoch of [1, 2]) {
      await expect(
        assertTaskAccess(db, context(FIX.owner, epoch), privateId),
      ).rejects.toMatchObject({ code: "not_found" });
    }
    await grant(FIX.owner, "read", 2);
    await expect(assertTaskAccess(db, context(FIX.owner, 2), privateId)).resolves.toMatchObject({
      taskId: privateId,
    });
    await expect(assertTaskAccess(db, context(), privateId)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("removed/rejoined membership cannot resurrect an epoch-bound grant", async () => {
    await grant(FIX.reviewer, "edit");
    await db
      .prepare("DELETE FROM project_access WHERE workspace_id = ? AND human_id = ?")
      .run(FIX.workspace, FIX.reviewer);
    await db
      .prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND human_id = ?")
      .run(FIX.workspace, FIX.reviewer);
    await expect(assertTaskAccess(db, context(FIX.reviewer), privateId)).rejects.toMatchObject({
      code: "not_found",
    });
    await db
      .prepare(
        "UPDATE workspace_authorization_epochs SET authorization_epoch = 2 WHERE workspace_id = ? AND human_id = ?",
      )
      .run(FIX.workspace, FIX.reviewer);
    await db
      .prepare(
        `INSERT INTO workspace_members
      (workspace_id, human_id, role, authorization_epoch, created_at) VALUES (?, ?, 'reviewer', 2, ?)`,
      )
      .run(FIX.workspace, FIX.reviewer, now);
    await db
      .prepare("INSERT INTO project_access (workspace_id, project_id, human_id) VALUES (?, ?, ?)")
      .run(FIX.workspace, FIX.projectA, FIX.reviewer);
    await assertTaskAccess(db, context(FIX.reviewer, 2), sharedIds[0]!);
    await expect(assertTaskAccess(db, context(FIX.reviewer, 2), privateId)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("task grants cannot bypass a newly restricted project or stale project access", async () => {
    await grant(FIX.reviewer, "edit");
    const stale = context(FIX.reviewer);
    await db
      .prepare("UPDATE projects SET access_mode = 'restricted' WHERE id = ?")
      .run(FIX.projectA);
    await db
      .prepare("DELETE FROM project_access WHERE project_id = ? AND human_id = ?")
      .run(FIX.projectA, FIX.reviewer);
    await expect(assertTaskAccess(db, stale, privateId)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(assertTaskAccess(db, stale, sharedIds[0]!)).rejects.toMatchObject({
      code: "not_found",
    });
    await db
      .prepare("DELETE FROM project_access WHERE project_id = ? AND human_id = ?")
      .run(FIX.projectA, FIX.member);
    await expect(assertTaskAccess(db, context(FIX.member), privateId)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("current role loss removes edit/sharing without silently removing read", async () => {
    await db
      .prepare("UPDATE workspace_members SET role = 'reviewer' WHERE human_id = ?")
      .run(FIX.member);
    await assertTaskAccess(db, context(FIX.member), privateId, "read");
    for (const action of ["edit", "manage_sharing"] as const) {
      await expect(
        assertTaskAccess(db, context(FIX.member), privateId, action),
      ).rejects.toMatchObject({ code: "not_found" });
    }
  });

  it("revoked or mismatched current membership epochs deny creator and grantee", async () => {
    await grant(FIX.owner, "read");
    await db
      .prepare("UPDATE workspace_authorization_epochs SET revoked_at = ? WHERE human_id = ?")
      .run(now, FIX.member);
    await expect(assertTaskAccess(db, context(FIX.member), privateId)).rejects.toMatchObject({
      code: "not_found",
    });
    await db
      .prepare(
        "UPDATE workspace_authorization_epochs SET authorization_epoch = 2 WHERE human_id = ?",
      )
      .run(FIX.owner);
    await expect(assertTaskAccess(db, context(FIX.owner, 2), privateId)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("private, missing and cross-workspace denial is indistinguishable", async () => {
    const calls = await Promise.allSettled([
      assertTaskAccess(db, context(), privateId),
      assertTaskAccess(db, context(), randomUlid()),
      assertTaskAccess(db, { ...context(FIX.member), workspaceId: randomUlid() }, privateId),
    ]);
    for (const call of calls) {
      expect(call).toMatchObject({
        status: "rejected",
        reason: { code: "not_found", message: "task not found" },
      });
    }
  });

  it("filters task lists/counts and joined child records before LIMIT/aggregation", async () => {
    const predicate = taskAccessPredicate(context(), "read", "parent");
    const ids = [privateId, ...sharedIds];
    const list = (await db
      .prepare(
        `SELECT parent.id FROM tasks AS parent
      WHERE parent.id IN (?, ?, ?) AND ${predicate.sql}
      ORDER BY CASE WHEN parent.id = ? THEN 0 ELSE 1 END, parent.id LIMIT 1`,
      )
      .all(...ids, ...predicate.parameters, privateId)) as { id: string }[];
    expect(list.length).toBe(1);
    expect(sharedIds).toContain(list[0]!.id);
    expect(
      await db
        .prepare(
          `SELECT COUNT(*) AS n FROM tasks AS parent
      WHERE parent.id IN (?, ?, ?) AND ${predicate.sql}`,
        )
        .get(...ids, ...predicate.parameters),
    ).toEqual({ n: 2 });
    for (const id of ids) {
      await db
        .prepare(
          `INSERT INTO comments
        (workspace_id, id, task_id, author_human_id, body, kind, created_at)
        VALUES (?, ?, ?, ?, 'Synthetic child', 'discussion', ?)`,
        )
        .run(FIX.workspace, randomUlid(), id, FIX.member, now);
    }
    const children = await db
      .prepare(
        `SELECT child.task_id FROM comments AS child
      JOIN tasks AS parent ON parent.workspace_id = child.workspace_id AND parent.id = child.task_id
      WHERE child.task_id IN (?, ?, ?) AND ${predicate.sql}`,
      )
      .all(...ids, ...predicate.parameters);
    expect(children).toHaveLength(2);
    expect(children).not.toContainEqual({ task_id: privateId });
  });

  it("rejects invalid actions, aliases and caller-shaped authority values", () => {
    for (const alias of [
      "task; SELECT 1",
      "task.id",
      "x".repeat(65),
      "",
      "task_member",
      "task_policy",
      "task_grant",
      "TASK_POLICY",
    ]) {
      expect(() => taskAccessPredicate(context(), "read", alias)).toThrow(
        "invalid task access query",
      );
    }
    for (const invalid of [
      { ...context(), humanId: "' OR 1=1 --" },
      { ...context(), workspaceId: "other" },
      { ...context(), authorizationEpoch: 0 },
      { ...context(), authorizationEpoch: 1.5 },
    ]) {
      expect(() => taskAccessPredicate(invalid, "read")).toThrow("invalid task access query");
    }
    expect(() => taskAccessPredicate(context(), "admin" as TaskAccessAction)).toThrow(
      "invalid task access query",
    );
  });

  it("keeps activation commands absent and returns no task content from the kernel", async () => {
    for (const command of ["task.create_private", "task.share", "task.privacy.update"]) {
      expect(resolveCommand(command)).toBeUndefined();
    }
    expect(Object.keys(await assertTaskAccess(db, context(FIX.member), privateId)).sort()).toEqual([
      "accessVersion",
      "privateOwnerHumanId",
      "projectId",
      "taskId",
    ]);
  });
});
