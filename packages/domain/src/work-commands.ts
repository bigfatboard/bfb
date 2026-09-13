// ABOUTME: Implements transport-neutral task, context, comment, link, and proposal commands.
// ABOUTME: Human roles and delegated project/task boundaries are rechecked at every command.

import { createHash } from "node:crypto";

import { assertUtcTimestamp, type SqlDatabase } from "@bfb/db";

import {
  assertEpoch,
  assertProjectAccess,
  assertRole,
  loadPrincipal,
  type AuthzPrincipal,
} from "./authorization.js";
import { DomainError, type HubCommand, type HubContext } from "./hub.js";
import { isUlid, randomUlid } from "./ids.js";

export const TASK_STATES = [
  "proposed",
  "ready",
  "active",
  "review",
  "blocked",
  "done",
  "cancelled",
] as const;
export type TaskState = (typeof TASK_STATES)[number];
export const TASK_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export const CONTEXT_KINDS = [
  "brief",
  "acceptance",
  "constraint",
  "plan",
  "decision",
  "link",
  "note",
] as const;
export type ContextKind = (typeof CONTEXT_KINDS)[number];
export const MAX_AGENT_READY_CHILDREN_PER_PARENT = 20;
export const MAX_CONTEXT_ITEMS_PER_TASK = 64;
export const MAX_CONTEXT_BYTES_PER_TASK = 131_072;

interface DelegationRow {
  id: string;
  human_id: string;
  client_id: string;
  project_id: string | null;
  task_id: string | null;
  scopes_json: string;
  authorization_epoch: number;
  expires_at: string;
  revoked_at: string | null;
}

interface WorkAuthority {
  principal: AuthzPrincipal;
  delegation?: DelegationRow;
}

function boundedText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") {
    throw new DomainError("invalid_argument", `${field} must be a string`);
  }
  const normalized = value.trim();
  if (
    !normalized ||
    [...normalized].length > maximum ||
    [...normalized].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new DomainError("invalid_argument", `${field} is invalid`);
  }
  return normalized;
}

function optionalBoundedText(
  value: unknown,
  field: string,
  maximum: number,
): string | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  return boundedText(value, field, maximum);
}

function utc(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new DomainError("invalid_argument", `${field} must be a UTC timestamp`);
  }
  try {
    return assertUtcTimestamp(value, field);
  } catch {
    throw new DomainError("invalid_argument", `${field} must be a UTC timestamp`);
  }
}

async function requireAuthority(ctx: HubContext): Promise<WorkAuthority> {
  if (!ctx.actorHumanId) {
    throw new DomainError("unauthenticated", "human sponsor required");
  }
  const principal = await loadPrincipal(ctx.db, ctx.workspaceId, ctx.actorHumanId);
  assertEpoch(principal, ctx.authorizationEpoch);
  if (!ctx.actorDelegationId) {
    return { principal };
  }
  const delegation = (await ctx.db
    .prepare(
      `SELECT id, human_id, client_id, project_id, task_id, scopes_json,
              authorization_epoch, expires_at, revoked_at
       FROM oauth_delegations
       WHERE workspace_id = ? AND id = ?`,
    )
    .get(ctx.workspaceId, ctx.actorDelegationId)) as DelegationRow | undefined;
  if (
    !delegation ||
    delegation.human_id !== principal.humanId ||
    delegation.authorization_epoch !== principal.authorizationEpoch ||
    delegation.revoked_at !== null ||
    Date.parse(delegation.expires_at) <= Date.parse(ctx.now)
  ) {
    throw new DomainError("forbidden", "delegation is not active for this authority");
  }
  return { principal, delegation };
}

function assertDelegationScope(
  delegation: DelegationRow | undefined,
  scope: "bfb:read" | "bfb:task:write",
): void {
  if (!delegation) {
    return;
  }
  let scopes: unknown;
  try {
    scopes = JSON.parse(delegation.scopes_json);
  } catch {
    throw new DomainError("forbidden", "delegation scopes are invalid");
  }
  if (
    !Array.isArray(scopes) ||
    scopes.some((value) => typeof value !== "string") ||
    !scopes.includes(scope)
  ) {
    throw new DomainError("insufficient_scope", `delegation is missing ${scope}`);
  }
}

async function assertDelegationBoundary(
  db: SqlDatabase,
  workspaceId: string,
  delegation: DelegationRow | undefined,
  projectId: string,
  taskId?: string,
): Promise<void> {
  if (!delegation) {
    return;
  }
  if (delegation.project_id && delegation.project_id !== projectId) {
    throw new DomainError("forbidden", "delegation project boundary exceeded");
  }
  if (!delegation.task_id) {
    return;
  }
  if (!taskId) {
    throw new DomainError("forbidden", "delegation task boundary exceeded");
  }
  let currentTaskId: string | null = taskId;
  for (let depth = 0; currentTaskId && depth <= 64; depth++) {
    if (currentTaskId === delegation.task_id) {
      return;
    }
    const row = (await db
      .prepare(
        `SELECT parent_task_id FROM tasks
         WHERE workspace_id = ? AND project_id = ? AND id = ?`,
      )
      .get(workspaceId, projectId, currentTaskId)) as { parent_task_id: string | null } | undefined;
    currentTaskId = row?.parent_task_id ?? null;
  }
  throw new DomainError("forbidden", "delegation task boundary exceeded");
}

function taskState(value: unknown): TaskState {
  if (typeof value !== "string" || !TASK_STATES.includes(value as TaskState)) {
    throw new DomainError("invalid_argument", "task state is invalid");
  }
  return value as TaskState;
}

function taskPriority(value: unknown): TaskPriority {
  if (typeof value !== "string" || !TASK_PRIORITIES.includes(value as TaskPriority)) {
    throw new DomainError("invalid_argument", "task priority is invalid");
  }
  return value as TaskPriority;
}

const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  proposed: ["ready", "cancelled"],
  ready: ["active", "cancelled"],
  active: ["review", "blocked", "cancelled"],
  review: ["active", "done"],
  blocked: ["active", "cancelled"],
  done: [],
  cancelled: [],
};

export function assertTaskTransition(from: TaskState, to: TaskState): void {
  if (from !== to && !TASK_TRANSITIONS[from].includes(to)) {
    throw new DomainError("invalid_transition", `task cannot move from ${from} to ${to}`);
  }
}

async function assertOwnerTarget(
  db: SqlDatabase,
  workspaceId: string,
  projectId: string,
  ownerType: "human" | "agent_profile" | "unassigned",
  ownerId: string | null,
): Promise<void> {
  if (ownerType === "unassigned") {
    if (ownerId !== null) {
      throw new DomainError("invalid_argument", "unassigned task cannot have an owner id");
    }
    return;
  }
  if (!ownerId || !isUlid(ownerId)) {
    throw new DomainError("invalid_argument", "next owner id is invalid");
  }
  if (ownerType === "human") {
    const found = await db
      .prepare(
        `SELECT 1 AS found
         FROM workspace_members AS member
         JOIN workspace_authorization_epochs AS epoch
           ON epoch.workspace_id = member.workspace_id
          AND epoch.human_id = member.human_id
          AND epoch.authorization_epoch = member.authorization_epoch
         JOIN projects AS project
           ON project.workspace_id = member.workspace_id AND project.id = ?
         LEFT JOIN project_access AS access
           ON access.workspace_id = project.workspace_id
          AND access.project_id = project.id
          AND access.human_id = member.human_id
         WHERE member.workspace_id = ? AND member.human_id = ?
           AND epoch.revoked_at IS NULL
           AND (project.access_mode = 'workspace' OR access.human_id IS NOT NULL)`,
      )
      .get(projectId, workspaceId, ownerId);
    if (!found) {
      throw new DomainError("invalid_argument", "next human owner cannot access the project");
    }
    return;
  }
  const policy = (await db
    .prepare(
      `SELECT profile.provider,
              workspace.allowed_providers_json AS workspace_providers,
              project.allowed_providers_json AS project_providers,
              repository.allowed_providers_json AS repository_providers,
              workspace.allow_pass_to_agent AS workspace_allowed,
              project.allow_pass_to_agent AS project_allowed,
              repository.allow_pass_to_agent AS repository_allowed
       FROM agent_profiles AS profile
       JOIN workspace_policies AS workspace ON workspace.workspace_id = profile.workspace_id
       JOIN project_policies AS project
         ON project.workspace_id = profile.workspace_id AND project.project_id = ?
       JOIN repository_configs AS repository
         ON repository.workspace_id = project.workspace_id
        AND repository.project_id = project.project_id
       WHERE profile.workspace_id = ? AND profile.id = ?`,
    )
    .get(projectId, workspaceId, ownerId)) as
    | {
        provider: string;
        workspace_providers: string;
        project_providers: string;
        repository_providers: string;
        workspace_allowed: number;
        project_allowed: number;
        repository_allowed: number;
      }
    | undefined;
  if (!policy) {
    throw new DomainError("invalid_argument", "next agent profile does not exist");
  }
  const permitsProvider = (value: string) => {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) && parsed.includes(policy.provider);
    } catch {
      return false;
    }
  };
  if (
    policy.workspace_allowed !== 1 ||
    policy.project_allowed !== 1 ||
    policy.repository_allowed !== 1 ||
    !permitsProvider(policy.workspace_providers) ||
    !permitsProvider(policy.project_providers) ||
    !permitsProvider(policy.repository_providers)
  ) {
    throw new DomainError("pass_to_agent_forbidden", "effective policy forbids the next agent");
  }
}

export interface CreateTaskInput {
  projectId: string;
  parentTaskId?: string;
  title: string;
  priority: TaskPriority;
  state?: "proposed" | "ready";
  dueAt?: string;
  nextOwnerType?: "human" | "agent_profile" | "unassigned";
  nextOwnerId?: string;
  nextActionReason?: string;
  punchline?: string;
}

export interface TaskRecord {
  id: string;
  project_id: string;
  parent_task_id: string | null;
  title: string;
  state: TaskState;
  priority: TaskPriority;
  due_at: string | null;
  next_owner_type: "human" | "agent_profile" | "unassigned";
  next_owner_id: string | null;
  next_action_reason: string | null;
  punchline: string;
  resource_version: number;
}

export const createTaskCommand: HubCommand<CreateTaskInput, TaskRecord> = {
  name: "task.create",
  async run(input, ctx) {
    const authority = await requireAuthority(ctx);
    assertRole(authority.principal, ["owner", "member"]);
    assertProjectAccess(authority.principal, input.projectId);
    const isAgent = authority.delegation !== undefined;
    assertDelegationScope(authority.delegation, "bfb:task:write");
    let parent: TaskRecord | undefined;
    if (input.parentTaskId !== undefined) {
      parent = await getTask(ctx.db, ctx.workspaceId, input.parentTaskId);
      if (!parent || parent.project_id !== input.projectId) {
        throw new DomainError("not_found", "parent task not found in project");
      }
    }
    await assertDelegationBoundary(
      ctx.db,
      ctx.workspaceId,
      authority.delegation,
      input.projectId,
      parent?.id,
    );
    if (isAgent && !parent) {
      const policy = (await ctx.db
        .prepare(
          `SELECT workspace.allow_agent_root_propose AS workspace_allowed,
                  project.allow_agent_root_propose AS project_allowed,
                  repository.allow_agent_root_propose AS repository_allowed
           FROM workspace_policies AS workspace
           JOIN project_policies AS project
             ON project.workspace_id = workspace.workspace_id
           JOIN repository_configs AS repository
             ON repository.workspace_id = project.workspace_id
            AND repository.project_id = project.project_id
           WHERE workspace.workspace_id = ? AND project.project_id = ?`,
        )
        .get(ctx.workspaceId, input.projectId)) as
        | { workspace_allowed: number; project_allowed: number; repository_allowed: number }
        | undefined;
      if (
        !policy ||
        policy.workspace_allowed !== 1 ||
        policy.project_allowed !== 1 ||
        policy.repository_allowed !== 1
      ) {
        throw new DomainError("forbidden", "effective policy forbids agent root proposals");
      }
    } else if (isAgent && parent) {
      const activeChildren = (await ctx.db
        .prepare(
          `SELECT COUNT(*) AS count FROM tasks
           WHERE workspace_id = ? AND parent_task_id = ?
             AND state NOT IN ('done', 'cancelled')`,
        )
        .get(ctx.workspaceId, parent.id)) as { count: number };
      if (activeChildren.count >= MAX_AGENT_READY_CHILDREN_PER_PARENT) {
        throw new DomainError("child_limit_reached", "agent child task limit reached");
      }
    }
    const title = boundedText(input.title, "task title", 512);
    const priority = taskPriority(input.priority);
    const nextOwnerType = input.nextOwnerType ?? "unassigned";
    if (!["human", "agent_profile", "unassigned"].includes(nextOwnerType)) {
      throw new DomainError("invalid_argument", "next owner type is invalid");
    }
    const nextOwnerId = input.nextOwnerId ?? null;
    await assertOwnerTarget(ctx.db, ctx.workspaceId, input.projectId, nextOwnerType, nextOwnerId);
    const dueAt = input.dueAt === undefined ? null : utc(input.dueAt, "dueAt");
    const state: TaskState = isAgent ? (parent ? "ready" : "proposed") : (input.state ?? "ready");
    if (input.state !== undefined && input.state !== "proposed" && input.state !== "ready") {
      throw new DomainError("invalid_argument", "new task state is invalid");
    }
    const nextActionReason = optionalBoundedText(input.nextActionReason, "next action reason", 512);
    const punchline =
      input.punchline === undefined
        ? state === "proposed"
          ? "Proposed agent work awaiting promotion"
          : "Ready for next action"
        : boundedText(input.punchline, "task punchline", 512);
    const id = randomUlid();
    await ctx.db
      .prepare(
        `INSERT INTO tasks (
          workspace_id, id, project_id, parent_task_id, title, state, priority, due_at,
          next_owner_type, next_owner_id, next_action_reason, punchline,
          resource_version, created_by_human_id, created_by_delegation_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        ctx.workspaceId,
        id,
        input.projectId,
        parent?.id ?? null,
        title,
        state,
        priority,
        dueAt,
        nextOwnerType,
        nextOwnerId,
        nextActionReason ?? null,
        punchline,
        ctx.actorHumanId ?? null,
        ctx.actorDelegationId ?? null,
        ctx.now,
      );
    return {
      id,
      project_id: input.projectId,
      parent_task_id: parent?.id ?? null,
      title,
      state,
      priority,
      due_at: dueAt,
      next_owner_type: nextOwnerType,
      next_owner_id: nextOwnerId,
      next_action_reason: nextActionReason ?? null,
      punchline,
      resource_version: 1,
    };
  },
};

export interface UpdateTaskInput {
  taskId: string;
  expectedVersion: number;
  title?: string;
  state?: TaskState;
  priority?: TaskPriority;
  dueAt?: string | null;
  nextOwnerType?: "human" | "agent_profile" | "unassigned";
  nextOwnerId?: string | null;
  nextActionReason?: string | null;
  punchline?: string;
  promote?: boolean;
}

export const updateTaskCommand: HubCommand<UpdateTaskInput, TaskRecord> = {
  name: "task.update",
  async run(input, ctx) {
    const authority = await requireAuthority(ctx);
    const task = await getTask(ctx.db, ctx.workspaceId, input.taskId);
    if (!task) {
      throw new DomainError("not_found", "task not found");
    }
    assertRole(authority.principal, ["owner", "member"]);
    assertProjectAccess(authority.principal, task.project_id);
    assertDelegationScope(authority.delegation, "bfb:task:write");
    await assertDelegationBoundary(
      ctx.db,
      ctx.workspaceId,
      authority.delegation,
      task.project_id,
      task.id,
    );
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new DomainError("invalid_argument", "expected task version is invalid");
    }
    if (task.resource_version !== input.expectedVersion) {
      throw new DomainError("stale_version", "task version conflict");
    }
    if (authority.delegation) {
      if (
        input.promote ||
        input.state !== undefined ||
        input.priority !== undefined ||
        input.dueAt !== undefined ||
        input.nextOwnerType !== undefined ||
        input.nextOwnerId !== undefined ||
        input.nextActionReason !== undefined
      ) {
        throw new DomainError(
          "forbidden",
          "delegated agents cannot change task workflow or routing",
        );
      }
    }
    const requestedState = input.promote ? "ready" : input.state;
    if (input.promote && task.state !== "proposed") {
      throw new DomainError("invalid_transition", "only proposed tasks can be promoted");
    }
    const nextState = requestedState === undefined ? task.state : taskState(requestedState);
    assertTaskTransition(task.state, nextState);
    const nextTitle =
      input.title === undefined ? task.title : boundedText(input.title, "task title", 512);
    const nextPriority =
      input.priority === undefined ? task.priority : taskPriority(input.priority);
    const nextDue =
      input.dueAt === undefined
        ? task.due_at
        : input.dueAt === null
          ? null
          : utc(input.dueAt, "dueAt");
    const nextOwnerType = input.nextOwnerType ?? task.next_owner_type;
    const nextOwnerId = input.nextOwnerId === undefined ? task.next_owner_id : input.nextOwnerId;
    await assertOwnerTarget(ctx.db, ctx.workspaceId, task.project_id, nextOwnerType, nextOwnerId);
    const nextActionReason =
      input.nextActionReason === undefined
        ? task.next_action_reason
        : (optionalBoundedText(input.nextActionReason, "next action reason", 512) ?? null);
    const nextPunchline =
      input.punchline === undefined
        ? task.punchline
        : boundedText(input.punchline, "task punchline", 512);
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
        nextTitle,
        nextState,
        nextPriority,
        nextDue,
        nextOwnerType,
        nextOwnerId,
        nextActionReason,
        nextPunchline,
        nextVersion,
        ctx.workspaceId,
        input.taskId,
        input.expectedVersion,
      );
    return {
      ...task,
      title: nextTitle,
      state: nextState,
      priority: nextPriority,
      due_at: nextDue,
      next_owner_type: nextOwnerType,
      next_owner_id: nextOwnerId,
      next_action_reason: nextActionReason,
      punchline: nextPunchline,
      resource_version: nextVersion,
    };
  },
};

export interface AddCommentInput {
  taskId: string;
  body: string;
  kind: "discussion" | "progress";
}

function commentCommand(
  name: "comment.add" | "progress.report",
): HubCommand<AddCommentInput, { id: string }> {
  return {
    name,
    async run(input, ctx) {
      const authority = await requireAuthority(ctx);
      const task = await getTask(ctx.db, ctx.workspaceId, input.taskId);
      if (!task) {
        throw new DomainError("not_found", "task not found");
      }
      assertRole(authority.principal, ["owner", "member", "reviewer"]);
      assertProjectAccess(authority.principal, task.project_id);
      assertDelegationScope(authority.delegation, "bfb:task:write");
      await assertDelegationBoundary(
        ctx.db,
        ctx.workspaceId,
        authority.delegation,
        task.project_id,
        task.id,
      );
      if (input.kind !== "discussion" && input.kind !== "progress") {
        throw new DomainError("invalid_argument", "comment kind is invalid");
      }
      if (name === "progress.report" && input.kind !== "progress") {
        throw new DomainError("invalid_argument", "progress report must use progress kind");
      }
      const body = boundedText(input.body, "comment body", 2048);
      const id = randomUlid();
      await ctx.db
        .prepare(
          `INSERT INTO comments (
            workspace_id, id, task_id, author_human_id, author_delegation_id,
            body, kind, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ctx.workspaceId,
          id,
          input.taskId,
          ctx.actorHumanId ?? null,
          ctx.actorDelegationId ?? null,
          body,
          input.kind,
          ctx.now,
        );
      return { id };
    },
  };
}

export const addCommentCommand = commentCommand("comment.add");
export const reportProgressCommand = commentCommand("progress.report");

export interface AddContextInput {
  taskId: string;
  kind: ContextKind;
  audience: "human" | "agent" | "both";
  body: string;
}

export const addContextCommand: HubCommand<
  AddContextInput,
  { id: string; version: number; contentHash: string }
> = {
  name: "context.add",
  async run(input, ctx) {
    const authority = await requireAuthority(ctx);
    if (authority.delegation) {
      throw new DomainError("forbidden", "delegated agents cannot edit task context");
    }
    assertRole(authority.principal, ["owner", "member"]);
    const task = await getTask(ctx.db, ctx.workspaceId, input.taskId);
    if (!task) {
      throw new DomainError("not_found", "task not found");
    }
    assertProjectAccess(authority.principal, task.project_id);
    if (!CONTEXT_KINDS.includes(input.kind)) {
      throw new DomainError("invalid_argument", "context kind is invalid");
    }
    if (input.audience !== "human" && input.audience !== "agent" && input.audience !== "both") {
      throw new DomainError("invalid_argument", "context audience is invalid");
    }
    const body = boundedText(input.body, "context body", 16_384);
    const previous = (await ctx.db
      .prepare(
        `SELECT COALESCE(MAX(version), 0) AS version,
                COUNT(*) AS item_count,
                COALESCE(SUM(length(CAST(body AS BLOB))), 0) AS byte_count
         FROM task_context_items
         WHERE workspace_id = ? AND task_id = ?`,
      )
      .get(ctx.workspaceId, input.taskId)) as {
      version: number;
      item_count: number;
      byte_count: number;
    };
    if (
      previous.item_count >= MAX_CONTEXT_ITEMS_PER_TASK ||
      previous.byte_count + new TextEncoder().encode(body).byteLength > MAX_CONTEXT_BYTES_PER_TASK
    ) {
      throw new DomainError("context_limit_reached", "task context limit reached");
    }
    const version = previous.version + 1;
    const id = randomUlid();
    const canonical = JSON.stringify({ audience: input.audience, body, kind: input.kind });
    const contentHash = `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
    await ctx.db
      .prepare(
        `INSERT INTO task_context_items (
          workspace_id, id, task_id, kind, audience, body, version, content_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ctx.workspaceId,
        id,
        input.taskId,
        input.kind,
        input.audience,
        body,
        version,
        contentHash,
        ctx.now,
      );
    return { id, version, contentHash };
  },
};

export interface AddTaskDependencyInput {
  taskId: string;
  dependsOnTaskId: string;
}

export const addTaskDependencyCommand: HubCommand<AddTaskDependencyInput, AddTaskDependencyInput> =
  {
    name: "task.dependency.add",
    async run(input, ctx) {
      const authority = await requireAuthority(ctx);
      if (authority.delegation) {
        throw new DomainError("forbidden", "delegated agents cannot change task dependencies");
      }
      assertRole(authority.principal, ["owner", "member"]);
      const task = await getTask(ctx.db, ctx.workspaceId, input.taskId);
      const dependency = await getTask(ctx.db, ctx.workspaceId, input.dependsOnTaskId);
      if (!task || !dependency || task.project_id !== dependency.project_id) {
        throw new DomainError("not_found", "task dependency must be in the same project");
      }
      assertProjectAccess(authority.principal, task.project_id);
      if (task.id === dependency.id) {
        throw new DomainError("invalid_argument", "task cannot depend on itself");
      }
      const reachable = new Set<string>();
      const pending = [dependency.id];
      while (pending.length > 0) {
        const current = pending.shift()!;
        if (current === task.id) {
          throw new DomainError("invalid_argument", "task dependency cycle is not allowed");
        }
        if (reachable.has(current)) {
          continue;
        }
        if (reachable.size >= 1_000) {
          throw new DomainError("dependency_graph_too_large", "task dependency graph is too large");
        }
        reachable.add(current);
        const children = (await ctx.db
          .prepare(
            `SELECT depends_on_task_id FROM task_dependencies
             WHERE workspace_id = ? AND task_id = ?`,
          )
          .all(ctx.workspaceId, current)) as Array<{ depends_on_task_id: string }>;
        pending.push(...children.map((child) => child.depends_on_task_id));
      }
      await ctx.db
        .prepare(
          `INSERT INTO task_dependencies
         (workspace_id, project_id, task_id, depends_on_task_id, kind, created_at)
         VALUES (?, ?, ?, ?, 'blocks', ?)`,
        )
        .run(ctx.workspaceId, task.project_id, task.id, dependency.id, ctx.now);
      return input;
    },
  };

export interface AddTaskLinkInput {
  taskId: string;
  kind: "github" | "artifact" | "external";
  url: string;
  label: string;
}

export const addTaskLinkCommand: HubCommand<AddTaskLinkInput, { id: string }> = {
  name: "task.link.add",
  async run(input, ctx) {
    const authority = await requireAuthority(ctx);
    const task = await getTask(ctx.db, ctx.workspaceId, input.taskId);
    if (!task) {
      throw new DomainError("not_found", "task not found");
    }
    assertRole(authority.principal, ["owner", "member"]);
    assertProjectAccess(authority.principal, task.project_id);
    assertDelegationScope(authority.delegation, "bfb:task:write");
    await assertDelegationBoundary(
      ctx.db,
      ctx.workspaceId,
      authority.delegation,
      task.project_id,
      task.id,
    );
    if (input.kind !== "github" && input.kind !== "artifact" && input.kind !== "external") {
      throw new DomainError("invalid_argument", "task link kind is invalid");
    }
    const url = boundedText(input.url, "task link URL", 2048);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new DomainError("invalid_argument", "task link URL is invalid");
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new DomainError("invalid_argument", "task link must use credential-free HTTPS");
    }
    const id = randomUlid();
    await ctx.db
      .prepare(
        `INSERT INTO task_links
         (workspace_id, id, task_id, kind, url, label, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ctx.workspaceId,
        id,
        task.id,
        input.kind,
        parsed.toString(),
        boundedText(input.label, "task link label", 256),
        ctx.now,
      );
    return { id };
  },
};

export async function getTask(
  db: SqlDatabase,
  workspaceId: string,
  taskId: string,
): Promise<TaskRecord | undefined> {
  if (!isUlid(taskId)) {
    return undefined;
  }
  return (await db
    .prepare(
      `SELECT id, project_id, parent_task_id, title, state, priority, due_at,
              next_owner_type, next_owner_id, next_action_reason, punchline, resource_version
       FROM tasks WHERE workspace_id = ? AND id = ?`,
    )
    .get(workspaceId, taskId)) as TaskRecord | undefined;
}

export interface TaskPage {
  tasks: TaskRecord[];
  limit: number;
  has_more: boolean;
  next_cursor?: string;
}

export async function listTasks(
  db: SqlDatabase,
  workspaceId: string,
  projectIds: string[],
  options: { limit?: number; cursor?: string } = {},
): Promise<TaskRecord[]> {
  return (await listTasksPage(db, workspaceId, projectIds, options)).tasks;
}

export async function listTasksPage(
  db: SqlDatabase,
  workspaceId: string,
  projectIds: string[],
  options: { limit?: number; cursor?: string } = {},
): Promise<TaskPage> {
  if (projectIds.length === 0) {
    return { tasks: [], limit: options.limit ?? 50, has_more: false };
  }
  if (options.cursor !== undefined && !isUlid(options.cursor)) {
    throw new DomainError("invalid_argument", "task cursor is invalid");
  }
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const placeholders = projectIds.map(() => "?").join(", ");
  const params: unknown[] = [workspaceId, ...projectIds];
  const cursorClause = options.cursor ? " AND id > ?" : "";
  if (options.cursor) {
    params.push(options.cursor);
  }
  params.push(limit + 1);
  const rows = (await db
    .prepare(
      `SELECT id, project_id, parent_task_id, title, state, priority, due_at,
              next_owner_type, next_owner_id, next_action_reason, punchline, resource_version
       FROM tasks
       WHERE workspace_id = ? AND project_id IN (${placeholders})${cursorClause}
       ORDER BY id ASC
       LIMIT ?`,
    )
    .all(...params)) as TaskRecord[];
  const has_more = rows.length > limit;
  const tasks = has_more ? rows.slice(0, limit) : rows;
  const result: TaskPage = { tasks, limit, has_more };
  if (has_more && tasks.length > 0) {
    result.next_cursor = tasks[tasks.length - 1]!.id;
  }
  return result;
}

export async function listTaskSubtreePage(
  db: SqlDatabase,
  workspaceId: string,
  rootTaskId: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<TaskPage> {
  if (!isUlid(rootTaskId)) {
    return { tasks: [], limit: options.limit ?? 50, has_more: false };
  }
  if (options.cursor !== undefined && !isUlid(options.cursor)) {
    throw new DomainError("invalid_argument", "task cursor is invalid");
  }
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const cursorClause = options.cursor ? "AND task.id > ?" : "";
  const rows = (await db
    .prepare(
      `WITH RECURSIVE subtree(id) AS (
         SELECT id FROM tasks WHERE workspace_id = ? AND id = ?
         UNION
         SELECT child.id FROM tasks AS child
         JOIN subtree AS parent ON child.parent_task_id = parent.id
         WHERE child.workspace_id = ?
       )
       SELECT task.id, task.project_id, task.parent_task_id, task.title, task.state,
              task.priority, task.due_at, task.next_owner_type, task.next_owner_id,
              task.next_action_reason, task.punchline, task.resource_version
       FROM tasks AS task
       JOIN subtree ON subtree.id = task.id
       WHERE task.workspace_id = ? ${cursorClause}
       ORDER BY task.id ASC LIMIT ?`,
    )
    .all(
      workspaceId,
      rootTaskId,
      workspaceId,
      workspaceId,
      ...(options.cursor ? [options.cursor] : []),
      limit + 1,
    )) as TaskRecord[];
  const has_more = rows.length > limit;
  const tasks = has_more ? rows.slice(0, limit) : rows;
  return {
    tasks,
    limit,
    has_more,
    ...(has_more ? { next_cursor: tasks[tasks.length - 1]!.id } : {}),
  };
}

export interface AgentContextItem {
  id: string;
  kind: ContextKind;
  body: string;
  version: number;
  audience: "agent" | "both";
  content_hash: string;
  created_at: string;
}

export async function getAgentContext(
  db: SqlDatabase,
  workspaceId: string,
  taskId: string,
): Promise<AgentContextItem[]> {
  return (await db
    .prepare(
      `SELECT id, kind, body, version, audience, content_hash, created_at
       FROM task_context_items
       WHERE workspace_id = ? AND task_id = ? AND audience IN ('agent', 'both')
       ORDER BY version ASC`,
    )
    .all(workspaceId, taskId)) as AgentContextItem[];
}

type AgentContextAuthority =
  | { kind: "run"; runId: string }
  | {
      kind: "delegation";
      delegationId: string;
      clientId: string;
      humanId: string;
      authorizationEpoch: number;
    };

async function deliverAgentContext(
  db: SqlDatabase,
  workspaceId: string,
  taskId: string,
  authority: AgentContextAuthority,
  now: string,
): Promise<AgentContextItem[]> {
  const task = await getTask(db, workspaceId, taskId);
  if (!task) {
    throw new DomainError("not_found", "task not found");
  }
  if (authority.kind === "run") {
    const run = await db
      .prepare(
        `SELECT 1 AS found FROM runs
         WHERE workspace_id = ? AND id = ? AND task_id = ? AND purpose = 'work'
           AND result_state IN ('open', 'changes_requested')`,
      )
      .get(workspaceId, authority.runId, taskId);
    if (!run) {
      throw new DomainError("forbidden", "run cannot access current task context");
    }
  } else {
    const principal = await loadPrincipal(db, workspaceId, authority.humanId);
    assertEpoch(principal, authority.authorizationEpoch);
    assertProjectAccess(principal, task.project_id);
    const delegation = (await db
      .prepare(
        `SELECT id, human_id, client_id, project_id, task_id, scopes_json,
                authorization_epoch, expires_at, revoked_at
         FROM oauth_delegations WHERE workspace_id = ? AND id = ?`,
      )
      .get(workspaceId, authority.delegationId)) as DelegationRow | undefined;
    if (
      !delegation ||
      delegation.human_id !== authority.humanId ||
      delegation.client_id !== authority.clientId ||
      delegation.authorization_epoch !== authority.authorizationEpoch ||
      delegation.revoked_at !== null ||
      Date.parse(delegation.expires_at) <= Date.parse(now)
    ) {
      throw new DomainError("forbidden", "delegation cannot access current task context");
    }
    await assertDelegationBoundary(db, workspaceId, delegation, task.project_id, task.id);
  }
  const items = await getAgentContext(db, workspaceId, taskId);
  for (const item of items) {
    await db
      .prepare(
        `INSERT INTO task_context_deliveries
         (workspace_id, id, task_id, context_version, content_hash,
          run_id, delegation_id, client_id, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        workspaceId,
        randomUlid(),
        taskId,
        item.version,
        item.content_hash,
        authority.kind === "run" ? authority.runId : null,
        authority.kind === "delegation" ? authority.delegationId : null,
        authority.kind === "delegation" ? authority.clientId : null,
        now,
      );
  }
  return items;
}

export const deliverDelegatedAgentContextCommand: HubCommand<
  { taskId: string },
  AgentContextItem[]
> = {
  name: "context.deliver.delegation",
  async run(input, ctx) {
    const authority = await requireAuthority(ctx);
    if (!authority.delegation) {
      throw new DomainError("forbidden", "delegated authority required");
    }
    assertDelegationScope(authority.delegation, "bfb:read");
    const task = await getTask(ctx.db, ctx.workspaceId, input.taskId);
    if (!task) {
      throw new DomainError("not_found", "task not found");
    }
    assertProjectAccess(authority.principal, task.project_id);
    await assertDelegationBoundary(
      ctx.db,
      ctx.workspaceId,
      authority.delegation,
      task.project_id,
      task.id,
    );
    return deliverAgentContext(
      ctx.db,
      ctx.workspaceId,
      task.id,
      {
        kind: "delegation",
        delegationId: authority.delegation.id,
        clientId: authority.delegation.client_id,
        humanId: authority.delegation.human_id,
        authorizationEpoch: authority.delegation.authorization_epoch,
      },
      ctx.now,
    );
  },
};

export const deliverRunAgentContextCommand: HubCommand<{ taskId: string }, AgentContextItem[]> = {
  name: "context.deliver.run",
  async run(input, ctx) {
    if (!ctx.actorSystemId || ctx.actorHumanId || ctx.actorDelegationId) {
      throw new DomainError("forbidden", "run-scoped authority required");
    }
    return deliverAgentContext(
      ctx.db,
      ctx.workspaceId,
      input.taskId,
      { kind: "run", runId: ctx.actorSystemId },
      ctx.now,
    );
  },
};
