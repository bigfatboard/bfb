// ABOUTME: Implements transport-neutral task, context, comment, and proposal domain commands.
// ABOUTME: Web, MCP, and future local agents share these handlers through WorkspaceHub.

import type { SqlDatabase } from "@bfb/db";

import {
  assertEpoch,
  assertProjectAccess,
  assertRole,
  loadPrincipal,
  type AuthzPrincipal,
} from "./authorization.js";
import { DomainError, type HubCommand, type HubContext } from "./hub.js";
import { isUlid, randomUlid } from "./ids.js";

export interface CreateTaskInput {
  projectId: string;
  title: string;
  priority: "P0" | "P1" | "P2" | "P3";
  state?: "proposed" | "ready";
  dueAt?: string;
  nextOwnerType?: "human" | "agent_profile" | "unassigned";
  nextOwnerId?: string;
  nextActionReason?: string;
  punchline?: string;
  actorIsAgent?: boolean;
}

export interface TaskRecord {
  id: string;
  project_id: string;
  title: string;
  state: string;
  priority: string;
  due_at: string | null;
  next_owner_type: string | null;
  next_owner_id: string | null;
  next_action_reason: string | null;
  punchline: string;
  resource_version: number;
}

async function requirePrincipal(ctx: HubContext): Promise<AuthzPrincipal> {
  if (!ctx.actorHumanId) {
    throw new DomainError("unauthenticated", "human actor required");
  }
  const principal = await loadPrincipal(ctx.db, ctx.workspaceId, ctx.actorHumanId);
  assertEpoch(principal, ctx.authorizationEpoch);
  return principal;
}

export const createTaskCommand: HubCommand<CreateTaskInput, TaskRecord> = {
  name: "task.create",
  async run(input, ctx) {
    const principal = await requirePrincipal(ctx);
    assertProjectAccess(principal, input.projectId);
    if (input.actorIsAgent) {
      if (input.state && input.state !== "proposed") {
        throw new DomainError("forbidden", "agent root tasks must remain proposed");
      }
    } else {
      assertRole(principal, ["owner", "member"]);
    }
    if (!input.title || input.title.length > 512) {
      throw new DomainError("invalid_argument", "title bounds exceeded");
    }
    const id = randomUlid();
    const state = input.actorIsAgent ? "proposed" : (input.state ?? "ready");
    const punchline =
      input.punchline ??
      (state === "proposed" ? "Proposed agent work awaiting promotion" : "Ready for next action");
    await ctx.db
      .prepare(
        `INSERT INTO tasks (
          workspace_id, id, project_id, title, state, priority, due_at,
          next_owner_type, next_owner_id, next_action_reason, punchline,
          resource_version, created_by_human_id, created_by_delegation_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        ctx.workspaceId,
        id,
        input.projectId,
        input.title,
        state,
        input.priority,
        input.dueAt ?? null,
        input.nextOwnerType ?? "unassigned",
        input.nextOwnerId ?? null,
        input.nextActionReason ?? null,
        punchline,
        ctx.actorHumanId ?? null,
        ctx.actorDelegationId ?? null,
        ctx.now,
      );
    return (await getTask(ctx.db, ctx.workspaceId, id))!;
  },
};

export interface UpdateTaskInput {
  taskId: string;
  expectedVersion: number;
  title?: string | undefined;
  state?: string | undefined;
  priority?: "P0" | "P1" | "P2" | "P3" | undefined;
  dueAt?: string | null | undefined;
  nextOwnerType?: "human" | "agent_profile" | "unassigned" | undefined;
  nextOwnerId?: string | null | undefined;
  nextActionReason?: string | null | undefined;
  punchline?: string | undefined;
  promote?: boolean | undefined;
}

export const updateTaskCommand: HubCommand<UpdateTaskInput, TaskRecord> = {
  name: "task.update",
  async run(input, ctx) {
    const principal = await requirePrincipal(ctx);
    const task = await getTask(ctx.db, ctx.workspaceId, input.taskId);
    if (!task) {
      throw new DomainError("not_found", "task not found");
    }
    assertProjectAccess(principal, task.project_id);
    if (task.resource_version !== input.expectedVersion) {
      throw new DomainError("stale_version", "task version conflict");
    }
    if (input.promote) {
      assertRole(principal, ["owner", "member"]);
      if (task.state !== "proposed") {
        throw new DomainError("invalid_transition", "only proposed tasks can be promoted");
      }
      if (ctx.actorDelegationId) {
        throw new DomainError("forbidden", "remote clients cannot promote proposed tasks");
      }
    }
    const nextState = input.promote ? "ready" : (input.state ?? task.state);
    const nextVersion = task.resource_version + 1;
    await ctx.db
      .prepare(
        `UPDATE tasks SET
          title = ?, state = ?, priority = ?, due_at = ?,
          next_owner_type = ?, next_owner_id = ?, next_action_reason = ?,
          punchline = ?, resource_version = ?
         WHERE workspace_id = ? AND id = ? AND resource_version = ?`,
      )
      .run(
        input.title ?? task.title,
        nextState,
        input.priority ?? task.priority,
        input.dueAt === undefined ? task.due_at : input.dueAt,
        input.nextOwnerType ?? task.next_owner_type,
        input.nextOwnerId === undefined ? task.next_owner_id : input.nextOwnerId,
        input.nextActionReason === undefined ? task.next_action_reason : input.nextActionReason,
        input.punchline ?? task.punchline,
        nextVersion,
        ctx.workspaceId,
        input.taskId,
        input.expectedVersion,
      );
    return (await getTask(ctx.db, ctx.workspaceId, input.taskId))!;
  },
};

export interface AddCommentInput {
  taskId: string;
  body: string;
  kind: "discussion" | "progress";
}

export const addCommentCommand: HubCommand<AddCommentInput, { id: string }> = {
  name: "comment.add",
  async run(input, ctx) {
    const principal = await requirePrincipal(ctx);
    const task = await getTask(ctx.db, ctx.workspaceId, input.taskId);
    if (!task) {
      throw new DomainError("not_found", "task not found");
    }
    assertProjectAccess(principal, task.project_id);
    if (!input.body || input.body.length > 2048) {
      throw new DomainError("invalid_argument", "comment body bounds exceeded");
    }
    const id = randomUlid();
    await ctx.db
      .prepare(
        `INSERT INTO comments (
          workspace_id, id, task_id, author_human_id, author_delegation_id, body, kind, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ctx.workspaceId,
        id,
        input.taskId,
        ctx.actorHumanId ?? null,
        ctx.actorDelegationId ?? null,
        input.body,
        input.kind,
        ctx.now,
      );
    return { id };
  },
};

export interface AddContextInput {
  taskId: string;
  audience: "human" | "agent" | "both";
  body: string;
}

export const addContextCommand: HubCommand<AddContextInput, { id: string; version: number }> = {
  name: "context.add",
  async run(input, ctx) {
    const principal = await requirePrincipal(ctx);
    assertRole(principal, ["owner", "member"]);
    const task = await getTask(ctx.db, ctx.workspaceId, input.taskId);
    if (!task) {
      throw new DomainError("not_found", "task not found");
    }
    assertProjectAccess(principal, task.project_id);
    const previous = (await ctx.db
      .prepare(
        `SELECT COALESCE(MAX(version), 0) AS version FROM task_context_items
         WHERE workspace_id = ? AND task_id = ?`,
      )
      .get(ctx.workspaceId, input.taskId)) as { version: number };
    const version = previous.version + 1;
    const id = randomUlid();
    const contentHash =
      "sha256:" + Buffer.from(input.body).toString("hex").slice(0, 64).padEnd(64, "0");
    await ctx.db
      .prepare(
        `INSERT INTO task_context_items (
          workspace_id, id, task_id, audience, body, version, content_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ctx.workspaceId,
        id,
        input.taskId,
        input.audience,
        input.body,
        version,
        contentHash,
        ctx.now,
      );
    return { id, version };
  },
};

export async function getTask(
  db: SqlDatabase,
  workspaceId: string,
  taskId: string,
): Promise<TaskRecord | undefined> {
  if (!isUlid(taskId) && !taskId.startsWith("01")) {
    return undefined;
  }
  return (await db
    .prepare(
      `SELECT id, project_id, title, state, priority, due_at, next_owner_type, next_owner_id,
              next_action_reason, punchline, resource_version
       FROM tasks WHERE workspace_id = ? AND id = ?`,
    )
    .get(workspaceId, taskId)) as TaskRecord | undefined;
}

export async function listTasks(
  db: SqlDatabase,
  workspaceId: string,
  projectIds: string[],
): Promise<TaskRecord[]> {
  if (projectIds.length === 0) {
    return [];
  }
  const placeholders = projectIds.map(() => "?").join(", ");
  return (await db
    .prepare(
      `SELECT id, project_id, title, state, priority, due_at, next_owner_type, next_owner_id,
              next_action_reason, punchline, resource_version
       FROM tasks
       WHERE workspace_id = ? AND project_id IN (${placeholders})
       ORDER BY priority ASC, due_at IS NOT NULL DESC, due_at ASC, id ASC`,
    )
    .all(workspaceId, ...projectIds)) as TaskRecord[];
}

export async function getAgentContext(
  db: SqlDatabase,
  workspaceId: string,
  taskId: string,
): Promise<Array<{ id: string; body: string; version: number; audience: string }>> {
  return (await db
    .prepare(
      `SELECT id, body, version, audience FROM task_context_items
       WHERE workspace_id = ? AND task_id = ? AND audience IN ('agent', 'both')
       ORDER BY version ASC`,
    )
    .all(workspaceId, taskId)) as Array<{
    id: string;
    body: string;
    version: number;
    audience: string;
  }>;
}
