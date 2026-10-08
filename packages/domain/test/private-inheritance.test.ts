// ABOUTME: Proves retained private-root authority without replacing descendants' actual creation authors.
// ABOUTME: Checks finite kernel, metadata, sharing and checkpoint boundaries using dormant synthetic inheritance.

import { adaptBetterSqlite3, applyMigrationsForVerification, type SqlDatabase } from "@bfb/db";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { bumpMemberEpoch, loadPrincipal } from "../src/authorization.js";
import { resolveCommand } from "../src/command-catalog.js";
import { FIX, seedSyntheticWorkspace } from "../src/fixtures.js";
import { WorkspaceHub, type CommandOutcome, type HubContext } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import { readPrivateProgress, reportPrivateProgressCommand } from "../src/private-checkpoints.js";
import { buildNeedsNowDeck, buildProjectLanes, readWorkBoard } from "../src/projections.js";
import {
  capturePublicBusinessAuthority,
  withPublicBusinessAuthority,
  type PublicBusinessAuthority,
} from "../src/public-business.js";
import {
  assertTaskAccess,
  TASK_ACCESS_ACTIONS,
  type TaskAccessAction,
  type TaskAccessContext,
} from "../src/task-access.js";
import {
  assertTaskSharingReceipt,
  grantTaskSharingCommand,
  readTaskSharing,
  revokeTaskSharingCommand,
} from "../src/task-sharing.js";
import {
  createTaskCommand,
  getTask,
  listTasksPage,
  listTaskSubtreePage,
  persistTaskCreation,
  prepareTaskCreation,
  type TaskRecord,
} from "../src/work-commands.js";
import { issueSyntheticMcpAccess, openDomainDb } from "./helpers.js";
import { seedHistoricalTask } from "./historical-task-fixture.js";

const directory = fileURLToPath(new URL("../../../migrations/d1", import.meta.url));
const NOW = "2026-10-08T12:00:00.000Z";
const DENIED = { code: "not_found", message: "task not found" };
let db: SqlDatabase, root: TaskRecord, child: TaskRecord, grandchild: TaskRecord;
let shared: TaskRecord[];

function access(humanId = FIX.owner, authorizationEpoch = 1): TaskAccessContext {
  return { workspaceId: FIX.workspace, humanId, authorizationEpoch };
}
function committed<T>(outcome: CommandOutcome<T>): T {
  expect(outcome.ok, outcome.ok ? "committed" : outcome.error.code).toBe(true);
  if (!outcome.ok) throw new Error(outcome.error.code);
  return outcome.result;
}
function request(humanId: string, input: unknown, authorizationEpoch = 1) {
  return {
    workspaceId: FIX.workspace,
    actorHumanId: humanId,
    authorizationEpoch,
    idempotencyKey: randomUlid(),
    input,
  };
}
async function snapshot(database = db) {
  const tables = (await database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()) as Array<{ name: string }>;
  const result: Record<string, unknown> = {};
  for (const { name } of tables) {
    if (["sqlite_sequence", "d1_migrations", "_cf_METADATA"].includes(name)) continue;
    expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    expect(name.startsWith("sqlite_") || name.startsWith("_cf_")).toBe(false);
    result[name] = await database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
  }
  expect(await database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  return result;
}
async function grant(humanId: string, permission: "read" | "contribute" | "edit", epoch = 1) {
  const id = randomUlid();
  // Dormant named grants are fixture authority, not a private-create product endpoint.
  await db
    .prepare(
      `INSERT INTO task_human_grants
       (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(FIX.workspace, id, root.id, humanId, epoch, permission, NOW);
  return id;
}
async function descendant(
  parent: TaskRecord,
  author: { humanId: string | null; delegationId: string | null },
  id?: string,
) {
  const ctx: HubContext = {
    db,
    workspaceId: FIX.workspace,
    authorizationEpoch: 1,
    now: NOW,
    cursorBase: 0,
    ...(author.humanId ? { actorHumanId: author.humanId } : {}),
    ...(author.delegationId ? { actorDelegationId: author.delegationId } : {}),
  };
  // Synthetic retained creation uses the actual persistence primitive and author tuple.
  // It deliberately does not authorize ordinary creation under a private parent.
  const task = await prepareTaskCreation(
    {
      projectId: FIX.projectA,
      parentTaskId: parent.id,
      title: "Synthetic inherited task",
      priority: "P0",
      dueAt: "2020-01-01T00:00:00.000Z",
      nextOwnerType: "human",
      nextOwnerId: FIX.owner,
    },
    ctx,
    author.humanId === null || author.delegationId !== null,
    parent,
  );
  if (id) task.id = id;
  await persistTaskCreation(ctx, task, author);
  // Root policy already exists, and the immediate parent has the same retained root.
  await db
    .prepare(
      `INSERT INTO task_privacy_inheritance
       (workspace_id,project_id,task_id,root_task_id,created_at) VALUES (?,?,?,?,?)`,
    )
    .run(FIX.workspace, FIX.projectA, task.id, root.id, NOW);
  return task;
}
async function checkpoint(authority: PublicBusinessAuthority, task: TaskRecord, body: string) {
  return committed(
    await new WorkspaceHub(db).execute(reportPrivateProgressCommand, {
      ...request(authority.humanId, {}),
      ...(authority.credential?.kind === "delegation"
        ? { actorDelegationId: authority.credential.delegationId }
        : {}),
      authorizationEpoch: authority.authorizationEpoch,
      input: withPublicBusinessAuthority(
        reportPrivateProgressCommand,
        { taskId: task.id, body },
        authority,
      ),
    }),
  );
}

beforeEach(async () => {
  db = await openDomainDb();
  const create = async (title: string, priority: "P0" | "P1") =>
    committed(
      await new WorkspaceHub(db).execute(createTaskCommand, {
        ...request(FIX.member, {}),
        input: {
          projectId: FIX.projectA,
          title,
          priority,
          dueAt: "2020-01-01T00:00:00.000Z",
          nextOwnerType: "human",
          nextOwnerId: FIX.owner,
        },
      }),
    );
  root = await create("Synthetic dormant private root", "P0");
  await db
    .prepare(
      `INSERT INTO task_privacy
       (workspace_id,task_id,owner_human_id,access_version,created_at) VALUES (?,?,?,1,?)`,
    )
    .run(FIX.workspace, root.id, FIX.member, NOW);
  child = await descendant(
    root,
    { humanId: FIX.owner, delegationId: null },
    "00000000000000000000000001",
  );
  grandchild = await descendant(
    child,
    { humanId: null, delegationId: null },
    "00000000000000000000000002",
  );
  shared = [
    await create("Synthetic visible shared task one", "P1"),
    await create("Synthetic visible shared task two", "P1"),
  ].sort((a, b) => a.id.localeCompare(b.id));
});

describe("retained root authority and actual creation authors", () => {
  it("returns root policy metadata for depth-two children without granting their actual author access", async () => {
    const before = await snapshot();
    for (const task of [root, child, grandchild]) {
      for (const action of TASK_ACCESS_ACTIONS) {
        if (action === "manage_sharing" && task.id !== root.id) {
          await expect(
            assertTaskAccess(db, access(FIX.member), task.id, action),
          ).rejects.toMatchObject(DENIED);
        } else {
          expect(await assertTaskAccess(db, access(FIX.member), task.id, action)).toEqual({
            taskId: task.id,
            projectId: FIX.projectA,
            privateOwnerHumanId: FIX.member,
            accessVersion: 1,
          });
        }
      }
      await expect(assertTaskAccess(db, access(), task.id)).rejects.toMatchObject(DENIED);
    }
    expect(
      await db
        .prepare(
          "SELECT created_by_human_id,created_by_delegation_id FROM tasks WHERE workspace_id=? AND id=?",
        )
        .get(FIX.workspace, child.id),
    ).toEqual({ created_by_human_id: FIX.owner, created_by_delegation_id: null });
    expect(
      await db
        .prepare(
          "SELECT created_by_human_id,created_by_delegation_id FROM tasks WHERE workspace_id=? AND id=?",
        )
        .get(FIX.workspace, grandchild.id),
    ).toEqual({ created_by_human_id: null, created_by_delegation_id: null });
    expect(await snapshot()).toEqual(before);
  });

  for (const permission of ["read", "contribute", "edit"] as const) {
    it(`applies one root ${permission} grant to every descendant with action-specific ceilings`, async () => {
      await grant(FIX.owner, permission);
      const before = await snapshot();
      for (const task of [root, child, grandchild]) {
        for (const action of TASK_ACCESS_ACTIONS) {
          const allowed =
            action === "read" ||
            (action === "contribute" && permission !== "read") ||
            (action === "edit" && permission === "edit");
          const result = assertTaskAccess(db, access(), task.id, action);
          if (allowed)
            await expect(result).resolves.toMatchObject({
              taskId: task.id,
              privateOwnerHumanId: FIX.member,
              accessVersion: 1,
            });
          else await expect(result).rejects.toMatchObject(DENIED);
        }
      }
      expect(await snapshot()).toEqual(before);
    });
  }

  it("retains current role ceilings for grantees and a root creator who becomes Reviewer", async () => {
    await grant(FIX.reviewer, "edit");
    await db
      .prepare("UPDATE workspace_members SET role='reviewer' WHERE workspace_id=? AND human_id=?")
      .run(FIX.workspace, FIX.member);
    const before = await snapshot();
    for (const humanId of [FIX.reviewer, FIX.member]) {
      for (const task of [root, child, grandchild]) {
        await assertTaskAccess(db, access(humanId), task.id, "read");
        await assertTaskAccess(db, access(humanId), task.id, "contribute");
        for (const action of ["edit", "manage_sharing"] as TaskAccessAction[])
          await expect(
            assertTaskAccess(db, access(humanId), task.id, action),
          ).rejects.toMatchObject(DENIED);
      }
    }
    expect(await snapshot()).toEqual(before);
  });

  it("revocation and recipient epoch changes invalidate the whole family until an explicit fresh grant", async () => {
    const oldGrant = await grant(FIX.owner, "edit");
    await db
      .prepare("UPDATE task_human_grants SET revoked_at=? WHERE workspace_id=? AND id=?")
      .run(NOW, FIX.workspace, oldGrant);
    for (const task of [root, child, grandchild])
      await expect(assertTaskAccess(db, access(), task.id)).rejects.toMatchObject(DENIED);
    const restored = await grant(FIX.owner, "read");
    await assertTaskAccess(db, access(), grandchild.id);
    await bumpMemberEpoch(db, FIX.workspace, FIX.owner);
    for (const epoch of [1, 2])
      for (const task of [root, child, grandchild])
        await expect(assertTaskAccess(db, access(FIX.owner, epoch), task.id)).rejects.toMatchObject(
          DENIED,
        );
    await grant(FIX.owner, "read", 2);
    const before = await snapshot();
    for (const task of [root, child, grandchild])
      await expect(assertTaskAccess(db, access(FIX.owner, 2), task.id)).resolves.toMatchObject({
        taskId: task.id,
      });
    expect(
      await db
        .prepare(
          "SELECT revoked_at,authorization_epoch,permission FROM task_human_grants WHERE workspace_id=? AND id=?",
        )
        .get(FIX.workspace, restored),
    ).toEqual({ revoked_at: null, authorization_epoch: 1, permission: "read" });
    expect(await snapshot()).toEqual(before);
  });

  it("current project access remains a ceiling for root creator and named grantee", async () => {
    await grant(FIX.owner, "edit");
    await db
      .prepare("UPDATE projects SET access_mode='restricted' WHERE workspace_id=? AND id=?")
      .run(FIX.workspace, FIX.projectA);
    await db
      .prepare(
        "DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id IN (?,?)",
      )
      .run(FIX.workspace, FIX.projectA, FIX.owner, FIX.member);
    const before = await snapshot();
    for (const humanId of [FIX.owner, FIX.member])
      for (const task of [root, child, grandchild])
        await expect(assertTaskAccess(db, access(humanId), task.id)).rejects.toMatchObject(DENIED);
    expect(await snapshot()).toEqual(before);
  });
});

describe("inherited metadata delivery and exact-root boundaries", () => {
  it("excludes the whole family from unscoped reads and before human/shared-only list and deck limits", async () => {
    const before = await snapshot();
    for (const task of [root, child, grandchild]) {
      expect(await getTask(db, FIX.workspace, task.id)).toBeUndefined();
      expect(await getTask(db, FIX.workspace, task.id, access())).toBeUndefined();
    }
    for (const scoped of [undefined, access()]) {
      const page = await listTasksPage(db, FIX.workspace, [FIX.projectA], {
        limit: 1,
        ...(scoped ? { access: scoped } : {}),
      });
      expect(page).toEqual({
        tasks: [shared[0]],
        limit: 1,
        has_more: true,
        next_cursor: shared[0]!.id,
      });
      const terminal = await listTasksPage(db, FIX.workspace, [FIX.projectA], {
        limit: 2,
        ...(scoped ? { access: scoped } : {}),
      });
      expect(terminal).toEqual({ tasks: shared, limit: 2, has_more: false });
      const lanes = await buildProjectLanes(db, FIX.workspace, [FIX.projectA], scoped);
      expect(lanes.flatMap((lane) => lane.tasks.map((task) => task.taskId)).sort()).toEqual(
        shared.map((task) => task.id),
      );
      const deck = await buildNeedsNowDeck(
        db,
        FIX.workspace,
        FIX.owner,
        [FIX.projectA],
        NOW,
        scoped,
      );
      expect(deck.map((task) => task.taskId).sort()).toEqual(shared.map((task) => task.id));
    }
    const board = await readWorkBoard(db, FIX.workspace, [FIX.projectA], NOW, access());
    expect(board.lanes.flatMap((lane) => lane.tasks.map((task) => task.taskId)).sort()).toEqual(
      shared.map((task) => task.id),
    );
    expect(board.needsNow.map((task) => task.taskId).sort()).toEqual(shared.map((task) => task.id));
    expect(await listTaskSubtreePage(db, FIX.workspace, root.id, { access: access() })).toEqual({
      tasks: [],
      limit: 50,
      has_more: false,
    });
    expect(await snapshot()).toEqual(before);
  });

  it("projects each exact immediate parent in the same task selection without escaping a child boundary", async () => {
    await grant(FIX.owner, "read");
    const before = await snapshot();
    expect(await getTask(db, FIX.workspace, child.id, access())).toMatchObject({
      id: child.id,
      parent_task_id: root.id,
    });
    expect(await getTask(db, FIX.workspace, grandchild.id, access())).toMatchObject({
      id: grandchild.id,
      parent_task_id: child.id,
    });
    const scoped = { ...access(), taskBoundaryId: child.id };
    expect(await getTask(db, FIX.workspace, child.id, scoped)).toMatchObject({
      id: child.id,
      parent_task_id: null,
    });
    expect(await getTask(db, FIX.workspace, grandchild.id, scoped)).toMatchObject({
      id: grandchild.id,
      parent_task_id: child.id,
    });
    expect(await getTask(db, FIX.workspace, root.id, scoped)).toBeUndefined();
    const subtree = await listTaskSubtreePage(db, FIX.workspace, child.id, {
      limit: 1,
      access: scoped,
    });
    expect(subtree).toMatchObject({
      tasks: [{ id: child.id, parent_task_id: null }],
      has_more: true,
    });
    expect(await snapshot()).toEqual(before);
  });

  it("keeps sharing management and receipts on the exact root, not descendant IDs even for its creator", async () => {
    const receipt = committed(
      await new WorkspaceHub(db).execute(grantTaskSharingCommand, {
        ...request(FIX.member, {}),
        input: {
          taskId: root.id,
          humanId: FIX.owner,
          permission: "edit",
          expectedAccessVersion: 1,
        },
      }),
    );
    expect(await readTaskSharing(db, access(FIX.member), root.id)).toMatchObject({
      task_id: root.id,
      access_version: 2,
    });
    const before = await snapshot();
    for (const task of [child, grandchild]) {
      await expect(readTaskSharing(db, access(FIX.member), task.id)).rejects.toMatchObject({
        code: "not_found",
        message: "task sharing not found",
      });
      for (const operation of ["grant", "revoke"] as const) {
        const outcome =
          operation === "grant"
            ? await new WorkspaceHub(db).execute(grantTaskSharingCommand, {
                ...request(FIX.member, {}),
                input: {
                  taskId: task.id,
                  humanId: FIX.reviewer,
                  permission: "read",
                  expectedAccessVersion: 2,
                },
              })
            : await new WorkspaceHub(db).execute(revokeTaskSharingCommand, {
                ...request(FIX.member, {}),
                input: { taskId: task.id, grantId: receipt.grant_id, expectedAccessVersion: 2 },
              });
        expect(outcome).toMatchObject({
          ok: false,
          error: { code: "not_found", message: "task sharing not found" },
        });
      }
      await expect(
        assertTaskSharingReceipt(db, access(FIX.member), { ...receipt, task_id: task.id }),
      ).rejects.toMatchObject({ code: "not_found" });
      expect(await assertTaskAccess(db, access(), task.id, "edit")).toMatchObject({
        accessVersion: 2,
      });
    }
    expect(await snapshot()).toEqual(before);
  });

  it("retains delegated creation authorship and exact child checkpoint owner/origin instead of root ownership", async () => {
    await grant(FIX.owner, "contribute");
    const { delegationId } = await issueSyntheticMcpAccess(db, {
      humanId: FIX.owner,
      taskId: child.id,
    });
    const delegatedChild = await descendant(child, { humanId: FIX.owner, delegationId });
    expect(
      await db
        .prepare(
          "SELECT created_by_human_id,created_by_delegation_id FROM tasks WHERE workspace_id=? AND id=?",
        )
        .get(FIX.workspace, delegatedChild.id),
    ).toEqual({ created_by_human_id: FIX.owner, created_by_delegation_id: delegationId });
    expect(await assertTaskAccess(db, access(FIX.member), delegatedChild.id)).toMatchObject({
      privateOwnerHumanId: FIX.member,
    });
    const owner = await loadPrincipal(db, FIX.workspace, FIX.owner);
    const creator = await loadPrincipal(db, FIX.workspace, FIX.member);
    const delegated = await capturePublicBusinessAuthority(db, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.owner,
      actorDelegationId: delegationId,
      authorizationEpoch: 1,
    });
    const humanReceipt = await checkpoint(
      owner,
      delegatedChild,
      "Synthetic descendant author checkpoint",
    );
    const delegatedReceipt = await checkpoint(
      delegated,
      delegatedChild,
      "Synthetic exact-origin descendant checkpoint",
    );
    const rootReceipt = await checkpoint(
      creator,
      delegatedChild,
      "Synthetic root creator's own checkpoint",
    );
    const before = await snapshot();
    const authorView = await readPrivateProgress(db, owner, delegatedChild.id);
    expect(authorView.checkpoints.map((row) => row.id).sort()).toEqual(
      [humanReceipt.checkpoint_id, delegatedReceipt.checkpoint_id].sort(),
    );
    expect(
      (await readPrivateProgress(db, delegated, delegatedChild.id)).checkpoints.map(
        (row) => row.id,
      ),
    ).toEqual([delegatedReceipt.checkpoint_id]);
    expect(
      (await readPrivateProgress(db, creator, delegatedChild.id)).checkpoints.map((row) => row.id),
    ).toEqual([rootReceipt.checkpoint_id]);
    expect((await readPrivateProgress(db, creator, root.id)).checkpoints).toEqual([]);
    const stored = await db
      .prepare(
        "SELECT task_id,project_id,owner_human_id,origin_delegation_id FROM task_private_checkpoints WHERE workspace_id=? AND id=?",
      )
      .get(FIX.workspace, delegatedReceipt.checkpoint_id);
    expect(stored).toEqual({
      task_id: delegatedChild.id,
      project_id: FIX.projectA,
      owner_human_id: FIX.owner,
      origin_delegation_id: delegationId,
    });
    expect(await snapshot()).toEqual(before);
  });

  it("keeps ordinary private-parent creation held for the creator and edit grantee with no effects", async () => {
    await grant(FIX.owner, "edit");
    const before = await snapshot();
    for (const humanId of [FIX.member, FIX.owner]) {
      const outcome = await new WorkspaceHub(db).execute(createTaskCommand, {
        ...request(humanId, {}),
        input: {
          projectId: FIX.projectA,
          parentTaskId: child.id,
          title: "Synthetic held private-parent creation",
          priority: "P2",
        },
      });
      expect(outcome).toMatchObject({ ok: false, error: { code: "not_found" } });
    }
    expect(resolveCommand("task.private.create")).toBeUndefined();
    expect(await snapshot()).toEqual(before);
  });
});

describe("inheritance schema absence remains fail closed", () => {
  it("never treats an installed privacy schema without inheritance support as structurally shared", async () => {
    const raw = new Database(":memory:");
    raw.pragma("foreign_keys = ON");
    applyMigrationsForVerification(raw, directory, {
      stopBeforeId: "0050_task_privacy_inheritance",
    });
    const legacy = adaptBetterSqlite3(raw);
    try {
      await seedSyntheticWorkspace(legacy);
      expect(
        await legacy.prepare("SELECT 1 FROM sqlite_master WHERE name='task_privacy'").get(),
      ).toBeDefined();
      expect(
        await legacy
          .prepare("SELECT 1 FROM sqlite_master WHERE name='task_privacy_inheritance'")
          .get(),
      ).toBeUndefined();
      // A current retained task ID must not reach the narrow pre-0045 fallback merely because 0050 is absent.
      await expect(getTask(legacy, FIX.workspace, child.id)).rejects.toThrow(
        /no such table: task_privacy_inheritance/,
      );
      await expect(assertTaskAccess(legacy, access(FIX.member), child.id)).rejects.toThrow(
        /no such table: task_privacy_inheritance/,
      );
      expect(await legacy.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      raw.close();
    }
  });

  it("preserves only the existing unscoped pre-0045 shared historical reader", async () => {
    const raw = new Database(":memory:");
    raw.pragma("foreign_keys = ON");
    applyMigrationsForVerification(raw, directory, { stopBeforeId: "0045_private_task_authority" });
    const legacy = adaptBetterSqlite3(raw);
    try {
      await seedSyntheticWorkspace(legacy);
      const historical = await seedHistoricalTask(legacy, {
        workspaceId: FIX.workspace,
        projectId: FIX.projectA,
        humanId: FIX.member,
        title: "Synthetic pre-privacy shared history",
        now: NOW,
      });
      expect(await getTask(legacy, FIX.workspace, historical.id)).toEqual(historical);
      await expect(
        getTask(legacy, FIX.workspace, historical.id, access(FIX.member)),
      ).rejects.toThrow(/no such table/);
      expect(await legacy.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      raw.close();
    }
  });
});
