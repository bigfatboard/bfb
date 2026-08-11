// ABOUTME: Exercises C08 task/context/comment/proposal commands through WorkspaceHub.
// ABOUTME: Asserts proposed roots, stale versions, and context audience isolation.

import { describe, expect, it } from "vitest";

import { WorkspaceHub } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import {
  addCommentCommand,
  addContextCommand,
  createTaskCommand,
  getAgentContext,
  updateTaskCommand,
} from "../src/work-commands.js";
// pagination helper imported below if needed;
import { FIX } from "../src/fixtures.js";
import { openDomainDb } from "./helpers.js";

describe("work records", () => {
  it("creates tasks, comments, context, and enforces stale versions", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const created = await hub.execute(createTaskCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "task-key-1",
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
      input: {
        projectId: FIX.projectA,
        title: "Ship board",
        priority: "P0",
        nextOwnerType: "human",
        nextOwnerId: FIX.owner,
        nextActionReason: "Review board copy",
        dueAt: "2026-08-07T11:00:00Z",
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    const comment = await hub.execute(addCommentCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "comment-key-1",
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
      input: { taskId: created.result.id, body: "synthetic progress", kind: "progress" },
    });
    expect(comment.ok).toBe(true);

    await hub.execute(addContextCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "context-key-1",
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
      input: { taskId: created.result.id, audience: "human", body: "human only secret" },
    });
    await hub.execute(addContextCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "context-key-2",
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
      input: { taskId: created.result.id, audience: "agent", body: "agent visible" },
    });
    const agentView = await getAgentContext(db, FIX.workspace, created.result.id);
    expect(agentView.map((item) => item.body)).toEqual(["agent visible"]);

    const stale = await hub.execute(updateTaskCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "upd-stale",
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
      input: {
        taskId: created.result.id,
        expectedVersion: 1,
        title: "stale",
      },
    });
    // version still 1 first update path
    expect(stale.ok).toBe(true);

    const conflict = await hub.execute(updateTaskCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "upd-conflict",
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
      input: {
        taskId: created.result.id,
        expectedVersion: 1,
        title: "conflict",
      },
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.error.code).toBe("stale_version");
    }
  });

  it("keeps agent-created roots proposed and blocks remote promotion", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const delegationId = randomUlid();
    await db
      .prepare(
        `INSERT INTO oauth_delegations
         (workspace_id, id, human_id, client_id, resource, project_id, task_id,
          scopes_json, authorization_epoch, expires_at, created_at)
         VALUES (?, ?, ?, ?, 'https://bfb.example.test/mcp', ?, NULL,
                 '["bfb:write"]', 1, '2026-08-07T13:00:00Z', '2026-08-07T12:00:00Z')`,
      )
      .run(FIX.workspace, delegationId, FIX.owner, FIX.client, FIX.projectA);
    const proposed = await hub.execute(createTaskCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "agent-root",
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
      actorDelegationId: delegationId,
      input: {
        projectId: FIX.projectA,
        title: "Agent proposal",
        priority: "P2",
        actorIsAgent: true,
      },
    });
    expect(proposed.ok && proposed.result.state).toBe("proposed");
    if (!proposed.ok) {
      return;
    }
    const promote = await hub.execute(updateTaskCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "promote-remote",
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
      actorDelegationId: delegationId,
      input: {
        taskId: proposed.result.id,
        expectedVersion: 1,
        promote: true,
      },
    });
    expect(promote.ok).toBe(false);
    if (!promote.ok) {
      expect(promote.error.message).toMatch(/cannot promote/);
    }
  });

  it("denies restricted member cross-project writes", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const denied = await hub.execute(createTaskCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "deny-project",
      authorizationEpoch: 1,
      actorHumanId: FIX.restricted,
      input: {
        projectId: FIX.projectB,
        title: "Nope",
        priority: "P3",
      },
    });
    expect(denied.ok).toBe(false);
  });

  it("hashes context bodies with real SHA-256 and paginates task lists", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    for (let i = 0; i < 3; i++) {
      const created = await hub.execute(createTaskCommand, {
        workspaceId: FIX.workspace,
        idempotencyKey: "page-key-" + i,
        authorizationEpoch: 1,
        actorHumanId: FIX.owner,
        now: "2026-08-07T12:00:00Z",
        input: { projectId: FIX.projectA, title: "Task " + i, priority: "P2" },
      });
      expect(created.ok).toBe(true);
    }
    const { listTasksPage, addContextCommand } = await import("../src/work-commands.js");
    const page1 = await listTasksPage(db, FIX.workspace, [FIX.projectA], { limit: 2 });
    expect(page1.tasks).toHaveLength(2);
    expect(page1.has_more).toBe(true);
    expect(page1.next_cursor).toBeTruthy();
    const page2 = await listTasksPage(db, FIX.workspace, [FIX.projectA], {
      limit: 2,
      cursor: page1.next_cursor,
    });
    expect(page2.tasks.length).toBeGreaterThan(0);

    const taskId = page1.tasks[0]!.id;
    const ctx = await hub.execute(addContextCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "ctx-hash",
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
      now: "2026-08-07T12:00:00Z",
      input: { taskId, audience: "agent", body: "hello-context" },
    });
    expect(ctx.ok).toBe(true);
    const row = (await db
      .prepare(`SELECT content_hash FROM task_context_items WHERE task_id = ?`)
      .get(taskId)) as { content_hash: string };
    const { createHash } = await import("node:crypto");
    const expected = "sha256:" + createHash("sha256").update("hello-context", "utf8").digest("hex");
    expect(row.content_hash).toBe(expected);
  });
});
