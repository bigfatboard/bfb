// ABOUTME: Proves the human task-read and shared work-command portion of private delivery.
// ABOUTME: Synthetic policies test filtering, grant actions, revocation, cached replies and safe receipts without activation.

import type { SqlDatabase } from "@bfb/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertTaskChildAccess, bumpMemberEpoch, loadPrincipal } from "../src/authorization.js";
import { FIX } from "../src/fixtures.js";
import { WorkspaceHub } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import { buildNeedsNowDeck, buildProjectLanes } from "../src/projections.js";
import {
  addCommentCommand,
  addContextCommand,
  addTaskLinkCommand,
  createTaskCommand,
  deliverDelegatedAgentContextCommand,
  getAgentContext,
  getTask,
  listTasksPage,
  listTaskSubtreePage,
  reportProgressCommand,
  updateTaskCommand,
} from "../src/work-commands.js";
import { openDomainDb } from "./helpers.js";

const now = "2026-10-06T12:00:00.000Z";
let db: SqlDatabase;
let hub: WorkspaceHub;
let privateId: string;
let sharedId: string;
function access(humanId = FIX.owner, authorizationEpoch = 1) {
  return { workspaceId: FIX.workspace, humanId, authorizationEpoch };
}
function request<T>(input: T, humanId = FIX.owner, key = randomUlid()) {
  return {
    workspaceId: FIX.workspace,
    actorHumanId: humanId,
    authorizationEpoch: 1,
    idempotencyKey: key,
    now,
    input,
  };
}
async function grant(permission: "read" | "contribute" | "edit", humanId = FIX.owner) {
  const id = randomUlid();
  await db
    .prepare(
      `INSERT INTO task_human_grants
    (workspace_id, id, task_id, human_id, authorization_epoch, permission, created_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(FIX.workspace, id, privateId, humanId, permission, now);
  return id;
}
async function revoke(id: string) {
  await db.prepare("UPDATE task_human_grants SET revoked_at = ? WHERE id = ?").run(now, id);
}
async function delegation() {
  const id = randomUlid();
  await db
    .prepare(
      `INSERT INTO oauth_delegations
    (workspace_id, id, human_id, client_id, resource, project_id, scopes_json,
     authorization_epoch, expires_at, created_at)
    VALUES (?, ?, ?, ?, 'https://bfb.example.test/mcp', ?, ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes'), ?)`,
    )
    .run(
      FIX.workspace,
      id,
      FIX.owner,
      FIX.client,
      FIX.projectA,
      JSON.stringify(["bfb:read", "bfb:task:write"]),
      now,
    );
  return id;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(now));
  db = await openDomainDb();
  hub = new WorkspaceHub(db);
  const ids: string[] = [];
  for (const title of ["PRIVATE_TITLE_CANARY", "Shared task"]) {
    const created = await hub.execute(
      createTaskCommand,
      request(
        {
          projectId: FIX.projectA,
          title,
          priority: "P0",
          nextOwnerType: "human",
          nextOwnerId: FIX.owner,
          nextActionReason: "Explicit synthetic review",
          dueAt: "2026-10-05T00:00:00Z",
        },
        FIX.member,
      ),
    );
    if (!created.ok) throw new Error(created.error.code);
    ids.push(created.result.id);
  }
  [privateId, sharedId] = ids as [string, string];
  await db
    .prepare(
      `INSERT INTO task_privacy
    (workspace_id, task_id, owner_human_id, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run(FIX.workspace, privateId, FIX.member, now);
});
afterEach(() => vi.useRealTimers());

describe("private human task read boundary", () => {
  it("unscoped internal task/context readers fail closed for private rows", async () => {
    await hub.execute(
      addContextCommand,
      request(
        { taskId: privateId, kind: "brief", audience: "both", body: "PRIVATE_CONTEXT_CANARY" },
        FIX.member,
      ),
    );
    expect(await getTask(db, FIX.workspace, privateId)).toBeUndefined();
    expect(await getAgentContext(db, FIX.workspace, privateId)).toEqual([]);
    expect(await getTask(db, FIX.workspace, sharedId)).toMatchObject({ id: sharedId });
  });
  it("creator and named grantee read, but unshared owner is indistinguishable from missing", async () => {
    expect(await getTask(db, FIX.workspace, privateId, access())).toBeUndefined();
    expect(await getTask(db, FIX.workspace, randomUlid(), access())).toBeUndefined();
    expect(await getTask(db, FIX.workspace, privateId, access(FIX.member))).toMatchObject({
      id: privateId,
    });
    await grant("read");
    expect(await getTask(db, FIX.workspace, privateId, access())).toMatchObject({ id: privateId });
  });
  it("a fresh task grant cannot widen a transport's narrower project boundary", async () => {
    await grant("read");
    const principal = await loadPrincipal(db, FIX.workspace, FIX.owner);
    await expect(
      assertTaskChildAccess(db, { ...principal, projectIds: [] }, privateId),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
  it("filters before pagination and does not create a hidden next page", async () => {
    const page = await listTasksPage(db, FIX.workspace, [FIX.projectA], {
      limit: 1,
      access: access(),
    });
    expect(page).toMatchObject({ tasks: [{ id: sharedId }], has_more: false });
    expect(page.next_cursor).toBeUndefined();
    expect(await listTasksPage(db, FIX.workspace, [FIX.projectA], { limit: 1 })).toMatchObject({
      tasks: [{ id: sharedId }],
      has_more: false,
    });
    await grant("read");
    expect(
      (await listTasksPage(db, FIX.workspace, [FIX.projectA], { access: access() })).tasks,
    ).toHaveLength(2);
  });
  it("rechecks stale principal, project loss and epoch at the selection query", async () => {
    await grant("read");
    const stale = access();
    await db
      .prepare("UPDATE projects SET access_mode = 'restricted' WHERE id = ?")
      .run(FIX.projectA);
    await db
      .prepare("DELETE FROM project_access WHERE project_id = ? AND human_id = ?")
      .run(FIX.projectA, FIX.owner);
    expect(
      (await listTasksPage(db, FIX.workspace, [FIX.projectA], { access: stale })).tasks,
    ).toEqual([]);
    await bumpMemberEpoch(db, FIX.workspace, FIX.owner);
    expect(await getTask(db, FIX.workspace, privateId, stale)).toBeUndefined();
  });
  it("board and ranked human deck do not expose or spend slots on an unshared task", async () => {
    const principal = await loadPrincipal(db, FIX.workspace, FIX.owner);
    const lanes = await buildProjectLanes(db, FIX.workspace, principal.projectIds, access());
    expect(lanes.flatMap((lane) => lane.tasks).map((task) => task.taskId)).toEqual([sharedId]);
    expect(
      await buildNeedsNowDeck(db, FIX.workspace, FIX.owner, principal.projectIds, now, access()),
    ).toMatchObject([{ taskId: sharedId }]);
    expect(JSON.stringify(lanes)).not.toContain("PRIVATE_TITLE_CANARY");
  });
  it("subtree selection hides inaccessible root and private descendants before pagination", async () => {
    const child = await hub.execute(
      createTaskCommand,
      request(
        {
          projectId: FIX.projectA,
          parentTaskId: sharedId,
          title: "Synthetic private descendant",
          priority: "P2",
        },
        FIX.member,
      ),
    );
    if (!child.ok) throw new Error(child.error.code);
    await db
      .prepare(
        `INSERT INTO task_privacy
      (workspace_id, task_id, owner_human_id, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(FIX.workspace, child.result.id, FIX.member, now);
    expect(
      await listTaskSubtreePage(db, FIX.workspace, sharedId, { limit: 1, access: access() }),
    ).toMatchObject({ tasks: [{ id: sharedId }], has_more: false });
    expect(
      (await listTaskSubtreePage(db, FIX.workspace, privateId, { access: access() })).tasks,
    ).toEqual([]);
  });
  it("a readable child does not reveal its inaccessible parent identifier", async () => {
    await db
      .prepare("UPDATE tasks SET parent_task_id = ? WHERE workspace_id = ? AND id = ?")
      .run(privateId, FIX.workspace, sharedId);
    expect(await getTask(db, FIX.workspace, sharedId, access())).toMatchObject({
      parent_task_id: null,
    });
    expect(
      (await listTasksPage(db, FIX.workspace, [FIX.projectA], { access: access() })).tasks,
    ).toMatchObject([{ parent_task_id: null }]);
  });
});

describe("private work command action and cache boundary", () => {
  it("reprojects cached parent references after access loss without changing the stored historical outcome", async () => {
    const child = await hub.execute(
      createTaskCommand,
      request(
        {
          projectId: FIX.projectA,
          parentTaskId: sharedId,
          title: "Synthetic child",
          priority: "P2",
        },
        FIX.member,
      ),
    );
    if (!child.ok) throw new Error(child.error.code);
    await db
      .prepare(
        `INSERT INTO task_privacy
      (workspace_id, task_id, owner_human_id, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(FIX.workspace, sharedId, FIX.member, now);
    const id = randomUlid();
    await db
      .prepare(
        `INSERT INTO task_human_grants
      (workspace_id, id, task_id, human_id, authorization_epoch, permission, created_at)
      VALUES (?, ?, ?, ?, 1, 'read', ?)`,
      )
      .run(FIX.workspace, id, sharedId, FIX.owner, now);
    const key = randomUlid();
    const call = () =>
      hub.execute(
        updateTaskCommand,
        request(
          { taskId: child.result.id, expectedVersion: 1, title: "Synthetic child updated" },
          FIX.owner,
          key,
        ),
      );
    expect(await call()).toMatchObject({ ok: true, result: { parent_task_id: sharedId } });
    await revoke(id);
    expect(await call()).toMatchObject({
      ok: true,
      replayed: true,
      result: { parent_task_id: null },
    });
    const stored = await db
      .prepare("SELECT result_json FROM idempotency_records WHERE idempotency_key = ?")
      .get(key);
    expect(JSON.stringify(stored)).toContain(sharedId);
  });
  it("legacy cached work without a fingerprint rejects instead of treating missing proof as a wildcard", async () => {
    const key = randomUlid();
    const input = {
      projectId: FIX.projectA,
      title: "Synthetic legacy task",
      priority: "P2" as const,
    };
    const legacy = { name: createTaskCommand.name, run: createTaskCommand.run };
    expect(await hub.execute(legacy, request(input, FIX.owner, key))).toMatchObject({ ok: true });
    expect(await hub.execute(createTaskCommand, request(input, FIX.owner, key))).toMatchObject({
      ok: false,
      error: { code: "request_rejected" },
    });
  });
  it("read grant cannot write and contribute grant cannot edit", async () => {
    const read = await grant("read");
    for (const command of [addCommentCommand, reportProgressCommand]) {
      expect(
        await hub.execute(
          command,
          request({ taskId: privateId, body: "Denied", kind: "progress" }),
        ),
      ).toMatchObject({ ok: false, error: { code: "not_found" } });
    }
    await revoke(read);
    await grant("contribute");
    expect(
      await hub.execute(
        addCommentCommand,
        request({ taskId: privateId, body: "Allowed", kind: "discussion" }),
      ),
    ).toMatchObject({ ok: true });
    expect(
      await hub.execute(
        updateTaskCommand,
        request({ taskId: privateId, expectedVersion: 1, title: "Denied" }),
      ),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
  it("edit grant does not elevate a reviewer role", async () => {
    await grant("edit", FIX.reviewer);
    expect(
      await hub.execute(
        updateTaskCommand,
        request({ taskId: privateId, expectedVersion: 1, title: "Denied" }, FIX.reviewer),
      ),
    ).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(
      await hub.execute(
        addCommentCommand,
        request({ taskId: privateId, body: "Reviewer comment", kind: "discussion" }, FIX.reviewer),
      ),
    ).toMatchObject({ ok: true });
  });
  for (const kind of ["update", "comment", "progress", "context", "link", "delivery"] as const) {
    it(`${kind} rechecks private grant before saved outcome`, async () => {
      const id = await grant("edit");
      const key = randomUlid();
      const delegationId = kind === "delivery" ? await delegation() : undefined;
      const call = () => {
        switch (kind) {
          case "update":
            return hub.execute(
              updateTaskCommand,
              request(
                { taskId: privateId, expectedVersion: 1, title: "PRIVATE_UPDATE_CANARY" },
                FIX.owner,
                key,
              ),
            );
          case "comment":
            return hub.execute(
              addCommentCommand,
              request(
                { taskId: privateId, kind: "discussion", body: "PRIVATE_COMMENT_CANARY" },
                FIX.owner,
                key,
              ),
            );
          case "progress":
            return hub.execute(
              reportProgressCommand,
              request(
                { taskId: privateId, kind: "progress", body: "PRIVATE_PROGRESS_CANARY" },
                FIX.owner,
                key,
              ),
            );
          case "context":
            return hub.execute(
              addContextCommand,
              request(
                {
                  taskId: privateId,
                  kind: "brief",
                  audience: "both",
                  body: "PRIVATE_CONTEXT_CANARY",
                },
                FIX.owner,
                key,
              ),
            );
          case "link":
            return hub.execute(
              addTaskLinkCommand,
              request(
                {
                  taskId: privateId,
                  kind: "external",
                  url: "https://synthetic.test",
                  label: "PRIVATE_LINK_CANARY",
                },
                FIX.owner,
                key,
              ),
            );
          case "delivery":
            return hub.execute(deliverDelegatedAgentContextCommand, {
              ...request({ taskId: privateId }, FIX.owner, key),
              actorDelegationId: delegationId!,
            });
        }
      };
      expect(await call()).toMatchObject({ ok: true, replayed: false });
      expect(await call()).toMatchObject({ ok: true, replayed: true });
      await revoke(id);
      expect(await call()).toMatchObject({ ok: false, error: { code: "not_found" } });
    });
  }
  it("changed retries never return a saved private body", async () => {
    await grant("edit");
    const key = randomUlid();
    expect(
      await hub.execute(
        updateTaskCommand,
        request(
          { taskId: privateId, expectedVersion: 1, title: "PRIVATE_ORIGINAL_CANARY" },
          FIX.owner,
          key,
        ),
      ),
    ).toMatchObject({ ok: true });
    const retry = await hub.execute(
      updateTaskCommand,
      request({ taskId: privateId, expectedVersion: 1, title: "Changed" }, FIX.owner, key),
    );
    expect(retry).toMatchObject({ ok: false, error: { code: "request_rejected" } });
    expect(JSON.stringify(retry)).not.toContain("PRIVATE_ORIGINAL_CANARY");
  });
  it("work receipts omit task titles, prose, context and link labels", async () => {
    await grant("edit");
    await hub.execute(
      addCommentCommand,
      request({ taskId: privateId, kind: "discussion", body: "PRIVATE_COMMENT_CANARY" }),
    );
    await hub.execute(
      addContextCommand,
      request({
        taskId: privateId,
        kind: "brief",
        audience: "both",
        body: "PRIVATE_CONTEXT_CANARY",
      }),
    );
    const delivered = await hub.execute(deliverDelegatedAgentContextCommand, {
      ...request({ taskId: privateId }),
      actorDelegationId: await delegation(),
    });
    expect(delivered.ok).toBe(true);
    for (const table of ["audit_events", "semantic_events", "outbox_records"]) {
      const rows = await db
        .prepare(`SELECT payload_json FROM ${table} WHERE workspace_id = ?`)
        .all(FIX.workspace);
      expect(JSON.stringify(rows)).not.toMatch(/PRIVATE_(TITLE|COMMENT|CONTEXT)_CANARY/);
    }
  });
  it("rejects private parent creation even by creator until inheritance is certified", async () => {
    expect(
      await hub.execute(
        createTaskCommand,
        request(
          {
            projectId: FIX.projectA,
            parentTaskId: privateId,
            title: "Must not become shared",
            priority: "P2",
          },
          FIX.member,
        ),
      ),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});
