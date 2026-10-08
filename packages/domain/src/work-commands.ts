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
import { canonicalLaunchJson } from "./launch-state.js";
import {
  allPublicAuthority,
  publicBusinessCommand,
  publicBusinessSelection,
  publicProjectAuthorityPredicate,
  publicTaskAuthorityPredicate,
  type PublicAuthoritySql,
  type PublicBusinessAuthority,
  type PublicBusinessSelection,
} from "./public-business.js";
import {
  assertTaskAccess,
  sharedTaskPredicate,
  taskAccessPredicate,
  taskPrivacyRootExpression,
  type TaskAccessAction,
  type TaskAccessContext,
} from "./task-access.js";

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

function workInputFingerprint(input: unknown): string {
  return createHash("sha256")
    .update(canonicalLaunchJson(JSON.parse(JSON.stringify(input))))
    .digest("hex");
}

async function authorizeWorkTask(
  ctx: HubContext,
  taskId: string,
  action: TaskAccessAction,
  allowDelegation = true,
): Promise<WorkAuthority> {
  const authority = await requireAuthority(ctx);
  assertRole(
    authority.principal,
    action === "edit" ? ["owner", "member"] : ["owner", "member", "reviewer"],
  );
  if (!allowDelegation && authority.delegation) {
    throw new DomainError("forbidden", "delegated agents cannot change this task resource");
  }
  assertDelegationScope(authority.delegation, action === "read" ? "bfb:read" : "bfb:task:write");
  const task = await assertTaskAccess(ctx.db, authority.principal, taskId, action);
  await assertDelegationBoundary(
    ctx.db,
    ctx.workspaceId,
    authority.delegation,
    task.projectId,
    taskId,
  );
  return authority;
}

function taskReceipt(task: TaskRecord) {
  return {
    id: task.id,
    project_id: task.project_id,
    parent_task_id: task.parent_task_id,
    resource_version: task.resource_version,
  };
}

const PUBLIC_EDIT_ROLES = ["owner", "member"] as const;

function publicId(value: unknown): value is string {
  return typeof value === "string" && value.length === 26 && isUlid(value);
}

function publicCreationAuthority(input: CreateTaskInput, authority: PublicBusinessAuthority) {
  const project = publicProjectAuthorityPredicate(authority, input.projectId, PUBLIC_EDIT_ROLES);
  if (!input.parentTaskId) return project;
  return allPublicAuthority(
    project,
    publicTaskAuthorityPredicate(authority, input.parentTaskId, "edit", PUBLIC_EDIT_ROLES),
    {
      sql: `EXISTS (SELECT 1 FROM tasks AS public_parent_source
        WHERE public_parent_source.workspace_id = ? AND public_parent_source.id = ?
          AND public_parent_source.project_id = ? AND ${sharedTaskPredicate("public_parent_source")})`,
      parameters: [authority.workspaceId, input.parentTaskId, input.projectId],
    },
  );
}

function publicTaskResultSelection(
  result: TaskRecord,
  authority: PublicBusinessAuthority,
  action: "read" | "edit",
  additional: PublicAuthoritySql = { sql: "1", parameters: [] },
): PublicBusinessSelection<TaskRecord> {
  if (
    !result ||
    !publicId(result.id) ||
    !publicId(result.project_id) ||
    !(result.parent_task_id === null || publicId(result.parent_task_id))
  )
    return publicBusinessSelection({ sql: "0", parameters: [] });
  const target = publicTaskAuthorityPredicate(authority, result.id, action, PUBLIC_EDIT_ROLES);
  const parent =
    result.parent_task_id === null
      ? { sql: "0", parameters: [] }
      : publicTaskAuthorityPredicate(authority, result.parent_task_id, "read", PUBLIC_EDIT_ROLES);
  return {
    sql: `SELECT CASE WHEN ${parent.sql} THEN ? ELSE NULL END AS parent_task_id
      FROM tasks AS public_result_task
      WHERE public_result_task.workspace_id = ? AND public_result_task.id = ?
        AND public_result_task.project_id = ? AND ${target.sql}
        AND ${additional.sql}`,
    parameters: [
      ...parent.parameters,
      result.parent_task_id,
      authority.workspaceId,
      result.id,
      result.project_id,
      ...target.parameters,
      ...additional.parameters,
    ],
    project: (historical, row) => ({
      ...historical,
      parent_task_id: row.parent_task_id as string | null,
    }),
  };
}

function publicDirectTaskAuthority(authority: PublicBusinessAuthority, taskId: string) {
  return authority.credential?.kind === "delegation"
    ? { sql: "0", parameters: [] }
    : publicTaskAuthorityPredicate(authority, taskId, "edit", PUBLIC_EDIT_ROLES);
}

function publicTaskChildSelection<TResult>(
  authority: PublicBusinessAuthority,
  taskId: string,
  table: "comments" | "task_context_items" | "task_links",
  exact: PublicAuthoritySql,
  action: "edit" | "contribute",
  direct = false,
): PublicBusinessSelection<TResult> {
  const access = direct
    ? publicDirectTaskAuthority(authority, taskId)
    : publicTaskAuthorityPredicate(authority, taskId, action);
  return {
    sql: `SELECT 1 AS permitted FROM ${table} AS public_source
      JOIN tasks AS public_source_task ON public_source_task.workspace_id = public_source.workspace_id
        AND public_source_task.id = public_source.task_id
      WHERE public_source.workspace_id = ? AND public_source.task_id = ?
        AND ${exact.sql} AND ${access.sql}`,
    parameters: [authority.workspaceId, taskId, ...exact.parameters, ...access.parameters],
  };
}

function publicDependencyAuthority(
  input: AddTaskDependencyInput,
  authority: PublicBusinessAuthority,
) {
  return allPublicAuthority(
    publicDirectTaskAuthority(authority, input.taskId),
    publicTaskAuthorityPredicate(authority, input.dependsOnTaskId, "read", PUBLIC_EDIT_ROLES),
    {
      sql: `EXISTS (SELECT 1 FROM tasks AS public_target JOIN tasks AS public_dependency
        ON public_dependency.workspace_id = public_target.workspace_id
          AND public_dependency.project_id = public_target.project_id
        WHERE public_target.workspace_id = ? AND public_target.id = ? AND public_dependency.id = ?
          AND ${sharedTaskPredicate("public_target")} AND ${sharedTaskPredicate("public_dependency")})`,
      parameters: [authority.workspaceId, input.taskId, input.dependsOnTaskId],
    },
  );
}

export interface TaskReadAccess extends TaskAccessContext {
  /** Additional authenticated delegation boundary, never supplied by the tool caller. */
  taskBoundaryId?: string;
  /** Authenticated credential identity rechecked at the task selection query. */
  delegationId?: string;
}

function workReadAccess(authority: WorkAuthority): TaskReadAccess {
  return {
    ...authority.principal,
    ...(authority.delegation ? { delegationId: authority.delegation.id } : {}),
    ...(authority.delegation?.task_id ? { taskBoundaryId: authority.delegation.task_id } : {}),
  };
}

const taskReplayAuthorities = new WeakMap<HubContext, WorkAuthority>();

async function replayTaskResult(
  result: TaskRecord,
  ctx: HubContext,
  action: "read" | "edit",
): Promise<TaskRecord> {
  const authority = taskReplayAuthorities.get(ctx);
  if (!authority) throw new DomainError("not_found", "task not found");
  const access = workReadAccess(authority);
  const target = taskAccessPredicate(authority.principal, action);
  const read = readTaskPredicate(access);
  const parent = readTaskPredicate(access, "task_parent");
  const credential = authority.delegation
    ? delegatedCredentialPredicate(
        {
          ...access,
          delegationId: authority.delegation.id,
          clientId: authority.delegation.client_id,
          projectBoundaryId: authority.delegation.project_id,
        },
        "bfb:task:write",
      )
    : undefined;
  const row = (await ctx.db
    .prepare(
      `SELECT CASE WHEN EXISTS (
         SELECT 1 FROM tasks AS task_parent
         WHERE task_parent.workspace_id = task.workspace_id AND task_parent.id = ?
           AND ${parent.sql}
       ) THEN ? ELSE NULL END AS parent_task_id
       FROM tasks AS task
       JOIN workspace_members AS sponsor
         ON sponsor.workspace_id = task.workspace_id AND sponsor.human_id = ?
       WHERE task.workspace_id = ? AND task.id = ? AND task.project_id = ?
         AND task.project_id IN (SELECT value FROM json_each(?))
         AND sponsor.role IN ('owner', 'member') AND ${target.sql} AND ${read.sql}
         ${credential ? `AND EXISTS (SELECT 1 FROM oauth_delegations AS credential WHERE ${credential.sql})` : ""}`,
    )
    .get(
      result.parent_task_id,
      ...parent.parameters,
      result.parent_task_id,
      authority.principal.humanId,
      ctx.workspaceId,
      result.id,
      result.project_id,
      JSON.stringify(authority.principal.projectIds),
      ...target.parameters,
      ...read.parameters,
      ...(credential?.parameters ?? []),
    )) as { parent_task_id: string | null } | undefined;
  if (!row) throw new DomainError("not_found", "task not found");
  return { ...result, parent_task_id: row.parent_task_id };
}

export function readTaskPredicate(access: TaskReadAccess | undefined, alias = "task") {
  let predicate: { sql: string; parameters: Array<string | number | null> } = access
    ? taskAccessPredicate(access, "read", alias)
    : { sql: sharedTaskPredicate(alias), parameters: [] };
  if (access?.delegationId) {
    if (!isUlid(access.delegationId))
      throw new DomainError("invalid_argument", "invalid task access query");
    predicate = {
      sql: `(${predicate.sql} AND EXISTS (
        SELECT 1 FROM oauth_delegations AS task_delegation
        WHERE task_delegation.workspace_id = "${alias}".workspace_id
          AND task_delegation.id = ? AND task_delegation.human_id = ?
          AND task_delegation.authorization_epoch = ? AND task_delegation.revoked_at IS NULL
          AND julianday(task_delegation.expires_at) > julianday(?)
          AND (task_delegation.project_id IS NULL OR task_delegation.project_id = "${alias}".project_id)
          AND task_delegation.task_id IS ?
      ))`,
      parameters: [
        ...predicate.parameters,
        access.delegationId,
        access.humanId,
        access.authorizationEpoch,
        new Date().toISOString(),
        access.taskBoundaryId ?? null,
      ],
    };
  }
  if (!access?.taskBoundaryId) return predicate;
  if (!isUlid(access.taskBoundaryId))
    throw new DomainError("invalid_argument", "invalid task access query");
  return {
    sql: `(${predicate.sql} AND EXISTS (
    WITH RECURSIVE scoped_tasks(id) AS (
      SELECT id FROM tasks WHERE workspace_id = ? AND id = ?
      UNION SELECT scoped_child.id FROM tasks AS scoped_child JOIN scoped_tasks
        ON scoped_child.parent_task_id = scoped_tasks.id WHERE scoped_child.workspace_id = ?
    ) SELECT 1 FROM scoped_tasks WHERE scoped_tasks.id = "${alias}".id
  ))`,
    parameters: [
      ...predicate.parameters,
      access.workspaceId,
      access.taskBoundaryId,
      access.workspaceId,
    ],
  };
}

export function taskProjection(access?: TaskReadAccess) {
  const parent = readTaskPredicate(access, "task_parent");
  return {
    sql: `task.id, task.project_id,
      CASE WHEN EXISTS (SELECT 1 FROM tasks AS task_parent
        WHERE task_parent.workspace_id = task.workspace_id AND task_parent.id = task.parent_task_id
          AND ${parent.sql}) THEN task.parent_task_id ELSE NULL END AS parent_task_id,
      task.title, task.state, task.priority, task.due_at, task.next_owner_type,
      task.next_owner_id, task.next_action_reason, task.punchline, task.resource_version`,
    parameters: parent.parameters,
  };
}

export interface TaskReadOptions {
  limit?: number;
  cursor?: string;
  access?: TaskReadAccess;
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

export async function assertAgentRootProposalAllowed(
  db: SqlDatabase,
  workspaceId: string,
  projectId: string,
): Promise<void> {
  const policy = (await db
    .prepare(
      `SELECT workspace.allow_agent_root_propose AS workspace_allowed,
    project.allow_agent_root_propose AS project_allowed,
    repository.allow_agent_root_propose AS repository_allowed
    FROM workspace_policies workspace
    JOIN project_policies project ON project.workspace_id = workspace.workspace_id
    JOIN repository_configs repository ON repository.workspace_id = project.workspace_id
      AND repository.project_id = project.project_id
    WHERE workspace.workspace_id = ? AND project.project_id = ?`,
    )
    .get(workspaceId, projectId)) as
    { workspace_allowed: number; project_allowed: number; repository_allowed: number } | undefined;
  if (
    !policy ||
    policy.workspace_allowed !== 1 ||
    policy.project_allowed !== 1 ||
    policy.repository_allowed !== 1
  )
    throw new DomainError("forbidden", "effective policy forbids agent root proposals");
}

export async function assertAgentChildLimit(
  db: SqlDatabase,
  workspaceId: string,
  parentTaskId: string,
): Promise<void> {
  const children = (await db
    .prepare(
      `SELECT COUNT(*) AS count FROM tasks
    AS quota_child JOIN tasks AS quota_parent
      ON quota_parent.workspace_id = quota_child.workspace_id AND quota_parent.id = quota_child.parent_task_id
    WHERE quota_parent.workspace_id = ? AND quota_parent.id = ?
      AND quota_child.state NOT IN ('done', 'cancelled')
      AND ((${sharedTaskPredicate("quota_parent")} AND ${sharedTaskPredicate("quota_child")})
        OR ${taskPrivacyRootExpression("quota_parent")} = ${taskPrivacyRootExpression("quota_child")})`,
    )
    .get(workspaceId, parentTaskId)) as { count: number };
  if (children.count >= MAX_AGENT_READY_CHILDREN_PER_PARENT)
    throw new DomainError("child_limit_reached", "agent child task limit reached");
}

// Callers establish authority and resolve the parent before this shared effect preparation.
export async function prepareTaskCreation(
  input: CreateTaskInput,
  ctx: HubContext,
  isAgent: boolean,
  parent: TaskRecord | undefined,
): Promise<TaskRecord> {
  const title = boundedText(input.title, "task title", 512);
  const priority = taskPriority(input.priority);
  const nextOwnerType = input.nextOwnerType ?? "unassigned";
  if (!["human", "agent_profile", "unassigned"].includes(nextOwnerType))
    throw new DomainError("invalid_argument", "next owner type is invalid");
  const nextOwnerId = input.nextOwnerId ?? null;
  await assertOwnerTarget(ctx.db, ctx.workspaceId, input.projectId, nextOwnerType, nextOwnerId);
  const dueAt = input.dueAt === undefined ? null : utc(input.dueAt, "dueAt");
  const state: TaskState = isAgent ? (parent ? "ready" : "proposed") : (input.state ?? "ready");
  if (input.state !== undefined && input.state !== "proposed" && input.state !== "ready")
    throw new DomainError("invalid_argument", "new task state is invalid");
  const nextActionReason = optionalBoundedText(input.nextActionReason, "next action reason", 512);
  const punchline =
    input.punchline === undefined
      ? state === "proposed"
        ? "Proposed agent work awaiting promotion"
        : "Ready for next action"
      : boundedText(input.punchline, "task punchline", 512);
  return {
    id: randomUlid(),
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
}

export async function persistTaskCreation(
  ctx: HubContext,
  task: TaskRecord,
  author: { humanId: string | null; delegationId: string | null },
): Promise<void> {
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
      task.id,
      task.project_id,
      task.parent_task_id,
      task.title,
      task.state,
      task.priority,
      task.due_at,
      task.next_owner_type,
      task.next_owner_id,
      task.next_action_reason,
      task.punchline,
      author.humanId,
      author.delegationId,
      ctx.now,
    );
}

export const createTaskCommand: HubCommand<CreateTaskInput, TaskRecord> = publicBusinessCommand<
  CreateTaskInput,
  TaskRecord
>(
  {
    name: "task.create",
    replayResult: (result, ctx) => replayTaskResult(result, ctx, "read"),
    inputFingerprint: workInputFingerprint,
    auditInput: (input) => ({ projectId: input.projectId, parentTaskId: input.parentTaskId }),
    auditResult: taskReceipt,
    async authorize(input, ctx) {
      const authority = await requireAuthority(ctx);
      assertRole(authority.principal, ["owner", "member"]);
      assertProjectAccess(authority.principal, input.projectId);
      assertDelegationScope(authority.delegation, "bfb:task:write");
      if (input.parentTaskId) {
        // Inherited agent/human children are not certified; never create a shared child of private work.
        const parent = await getTask(ctx.db, ctx.workspaceId, input.parentTaskId);
        if (!parent || parent.project_id !== input.projectId)
          throw new DomainError("not_found", "task not found");
        await authorizeWorkTask(ctx, parent.id, "edit");
      }
      await assertDelegationBoundary(
        ctx.db,
        ctx.workspaceId,
        authority.delegation,
        input.projectId,
        input.parentTaskId,
      );
      taskReplayAuthorities.set(ctx, authority);
    },
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
        await assertAgentRootProposalAllowed(ctx.db, ctx.workspaceId, input.projectId);
      } else if (isAgent && parent) {
        await assertAgentChildLimit(ctx.db, ctx.workspaceId, parent.id);
      }
      const task = await prepareTaskCreation(input, ctx, isAgent, parent);
      await persistTaskCreation(ctx, task, {
        humanId: ctx.actorHumanId ?? null,
        delegationId: ctx.actorDelegationId ?? null,
      });
      return task;
    },
  },
  {
    admission: publicCreationAuthority,
    delivery: (input, result, authority) =>
      publicTaskResultSelection(
        result,
        authority,
        "read",
        allPublicAuthority(publicCreationAuthority(input, authority), {
          sql: "public_result_task.project_id = ?",
          parameters: [input.projectId],
        }),
      ),
  },
);

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

export function assertTaskVersion(task: TaskRecord, expectedVersion: number): void {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
    throw new DomainError("invalid_argument", "expected task version is invalid");
  if (task.resource_version !== expectedVersion)
    throw new DomainError("stale_version", "task version conflict");
}

export async function prepareTaskUpdate(
  input: UpdateTaskInput,
  ctx: HubContext,
  task: TaskRecord,
): Promise<TaskRecord> {
  assertTaskVersion(task, input.expectedVersion);
  const requestedState = input.promote ? "ready" : input.state;
  if (input.promote && task.state !== "proposed")
    throw new DomainError("invalid_transition", "only proposed tasks can be promoted");
  const state = requestedState === undefined ? task.state : taskState(requestedState);
  assertTaskTransition(task.state, state);
  const title =
    input.title === undefined ? task.title : boundedText(input.title, "task title", 512);
  const priority = input.priority === undefined ? task.priority : taskPriority(input.priority);
  const dueAt =
    input.dueAt === undefined
      ? task.due_at
      : input.dueAt === null
        ? null
        : utc(input.dueAt, "dueAt");
  const ownerType = input.nextOwnerType ?? task.next_owner_type;
  const ownerId = input.nextOwnerId === undefined ? task.next_owner_id : input.nextOwnerId;
  await assertOwnerTarget(ctx.db, ctx.workspaceId, task.project_id, ownerType, ownerId);
  const reason =
    input.nextActionReason === undefined
      ? task.next_action_reason
      : (optionalBoundedText(input.nextActionReason, "next action reason", 512) ?? null);
  const punchline =
    input.punchline === undefined
      ? task.punchline
      : boundedText(input.punchline, "task punchline", 512);
  return {
    ...task,
    title,
    state,
    priority,
    due_at: dueAt,
    next_owner_type: ownerType,
    next_owner_id: ownerId,
    next_action_reason: reason,
    punchline,
    resource_version: task.resource_version + 1,
  };
}

export async function persistTaskUpdate(
  ctx: HubContext,
  task: TaskRecord,
  expectedVersion: number,
): Promise<void> {
  await ctx.db
    .prepare(
      `UPDATE tasks SET title = ?, state = ?, priority = ?, due_at = ?,
    next_owner_type = ?, next_owner_id = ?, next_action_reason = ?, punchline = ?, resource_version = ?
    WHERE workspace_id = ? AND id = ? AND resource_version = ?`,
    )
    .run(
      task.title,
      task.state,
      task.priority,
      task.due_at,
      task.next_owner_type,
      task.next_owner_id,
      task.next_action_reason,
      task.punchline,
      task.resource_version,
      ctx.workspaceId,
      task.id,
      expectedVersion,
    );
}

export const updateTaskCommand: HubCommand<UpdateTaskInput, TaskRecord> = publicBusinessCommand<
  UpdateTaskInput,
  TaskRecord
>(
  {
    name: "task.update",
    replayResult: (result, ctx) => replayTaskResult(result, ctx, "edit"),
    inputFingerprint: workInputFingerprint,
    auditInput: (input) => ({ taskId: input.taskId, expectedVersion: input.expectedVersion }),
    auditResult: taskReceipt,
    async authorize(input, ctx) {
      taskReplayAuthorities.set(ctx, await authorizeWorkTask(ctx, input.taskId, "edit"));
    },
    async run(input, ctx) {
      const authority = await authorizeWorkTask(ctx, input.taskId, "edit");
      const task = await getTask(ctx.db, ctx.workspaceId, input.taskId, workReadAccess(authority));
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
      assertTaskVersion(task, input.expectedVersion);
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
      const updated = await prepareTaskUpdate(input, ctx, task);
      await persistTaskUpdate(ctx, updated, input.expectedVersion);
      return updated;
    },
  },
  {
    admission: (input, authority) => publicTaskAuthorityPredicate(authority, input.taskId, "edit"),
    delivery: (input, result, authority) =>
      publicTaskResultSelection(result, authority, "edit", {
        sql: "public_result_task.id = ?",
        parameters: [input.taskId],
      }),
  },
);

export interface AddCommentInput {
  taskId: string;
  body: string;
  kind: "discussion" | "progress";
}

function commentCommand(
  name: "comment.add" | "progress.report",
): HubCommand<AddCommentInput, { id: string }> {
  return publicBusinessCommand<AddCommentInput, { id: string }>(
    {
      name,
      inputFingerprint: workInputFingerprint,
      auditInput: (input) => ({ taskId: input.taskId, kind: input.kind }),
      async authorize(input, ctx) {
        await authorizeWorkTask(ctx, input.taskId, "contribute");
      },
      async run(input, ctx) {
        const authority = await authorizeWorkTask(ctx, input.taskId, "contribute");
        const task = await getTask(
          ctx.db,
          ctx.workspaceId,
          input.taskId,
          workReadAccess(authority),
        );
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
        const body = checkedCommentBody(input.body);
        const id = await persistComment(ctx, input.taskId, body, input.kind, {
          humanId: ctx.actorHumanId ?? null,
          delegationId: ctx.actorDelegationId ?? null,
        });
        return { id };
      },
    },
    {
      admission: (input, authority) =>
        publicTaskAuthorityPredicate(authority, input.taskId, "contribute"),
      delivery: (input, result, authority) =>
        !result || !publicId(result.id)
          ? publicBusinessSelection({ sql: "0", parameters: [] })
          : publicTaskChildSelection(
              authority,
              input.taskId,
              "comments",
              {
                sql: `public_source.id = ? AND public_source.kind = ?
          AND public_source.author_human_id = ? AND public_source.author_delegation_id IS ?`,
                parameters: [
                  result.id,
                  input.kind,
                  authority.humanId,
                  authority.credential?.kind === "delegation"
                    ? authority.credential.delegationId
                    : null,
                ],
              },
              "contribute",
            ),
    },
  );
}

export const addCommentCommand = commentCommand("comment.add");
export const reportProgressCommand = commentCommand("progress.report");

export function checkedCommentBody(body: unknown): string {
  return boundedText(body, "comment body", 2048);
}

// Authority and all preflight reads belong to the calling domain command.
// This shared effect stages only the existing C08 comment row.
export async function persistComment(
  ctx: HubContext,
  taskId: string,
  body: string,
  kind: "discussion" | "progress",
  author: { humanId: string | null; delegationId: string | null },
): Promise<string> {
  const id = randomUlid();
  await ctx.db
    .prepare(
      `INSERT INTO comments (
    workspace_id, id, task_id, author_human_id, author_delegation_id, body, kind, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ctx.workspaceId, id, taskId, author.humanId, author.delegationId, body, kind, ctx.now);
  return id;
}

export interface AddContextInput {
  taskId: string;
  kind: ContextKind;
  audience: "human" | "agent" | "both";
  body: string;
}

export const addContextCommand: HubCommand<
  AddContextInput,
  { id: string; version: number; contentHash: string }
> = publicBusinessCommand<AddContextInput, { id: string; version: number; contentHash: string }>(
  {
    name: "context.add",
    inputFingerprint: workInputFingerprint,
    auditInput: (input) => ({ taskId: input.taskId, kind: input.kind, audience: input.audience }),
    async authorize(input, ctx) {
      await authorizeWorkTask(ctx, input.taskId, "edit", false);
    },
    async run(input, ctx) {
      const authority = await authorizeWorkTask(ctx, input.taskId, "edit", false);
      if (authority.delegation) {
        throw new DomainError("forbidden", "delegated agents cannot edit task context");
      }
      assertRole(authority.principal, ["owner", "member"]);
      const task = await getTask(ctx.db, ctx.workspaceId, input.taskId, workReadAccess(authority));
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
  },
  {
    admission: (input, authority) => publicDirectTaskAuthority(authority, input.taskId),
    delivery: (input, result, authority) =>
      !result ||
      !publicId(result.id) ||
      !Number.isSafeInteger(result.version) ||
      result.version < 1 ||
      typeof result.contentHash !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(result.contentHash)
        ? publicBusinessSelection({ sql: "0", parameters: [] })
        : publicTaskChildSelection(
            authority,
            input.taskId,
            "task_context_items",
            {
              sql: `public_source.id = ? AND public_source.version = ? AND public_source.content_hash = ?
        AND public_source.kind = ? AND public_source.audience = ?`,
              parameters: [
                result.id,
                result.version,
                result.contentHash,
                input.kind,
                input.audience,
              ],
            },
            "edit",
            true,
          ),
  },
);

export interface AddTaskDependencyInput {
  taskId: string;
  dependsOnTaskId: string;
}

export const addTaskDependencyCommand: HubCommand<AddTaskDependencyInput, AddTaskDependencyInput> =
  publicBusinessCommand<AddTaskDependencyInput, AddTaskDependencyInput>(
    {
      name: "task.dependency.add",
      inputFingerprint: workInputFingerprint,
      async authorize(input, ctx) {
        await authorizeWorkTask(ctx, input.taskId, "edit", false);
        await authorizeWorkTask(ctx, input.dependsOnTaskId, "read", false);
        // Cross-visibility dependency graphs remain unavailable until their complete delivery proof.
        if (
          !(await getTask(ctx.db, ctx.workspaceId, input.taskId)) ||
          !(await getTask(ctx.db, ctx.workspaceId, input.dependsOnTaskId))
        ) {
          throw new DomainError("not_found", "task not found");
        }
      },
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
            throw new DomainError(
              "dependency_graph_too_large",
              "task dependency graph is too large",
            );
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
    },
    {
      admission: publicDependencyAuthority,
      delivery: (input, result, authority) =>
        !result ||
        result.taskId !== input.taskId ||
        result.dependsOnTaskId !== input.dependsOnTaskId
          ? publicBusinessSelection({ sql: "0", parameters: [] })
          : {
              sql: `SELECT 1 AS permitted FROM task_dependencies AS public_source
          JOIN tasks AS public_source_task ON public_source_task.workspace_id = public_source.workspace_id
            AND public_source_task.id = public_source.task_id AND public_source_task.project_id = public_source.project_id
          WHERE public_source.workspace_id = ? AND public_source.task_id = ?
            AND public_source.depends_on_task_id = ? AND public_source.kind = 'blocks'
            AND ${publicDependencyAuthority(input, authority).sql}`,
              parameters: [
                authority.workspaceId,
                result.taskId,
                result.dependsOnTaskId,
                ...publicDependencyAuthority(input, authority).parameters,
              ],
            },
    },
  );

export interface AddTaskLinkInput {
  taskId: string;
  kind: "github" | "artifact" | "external";
  url: string;
  label: string;
}

export const addTaskLinkCommand: HubCommand<AddTaskLinkInput, { id: string }> =
  publicBusinessCommand<AddTaskLinkInput, { id: string }>(
    {
      name: "task.link.add",
      inputFingerprint: workInputFingerprint,
      auditInput: (input) => ({ taskId: input.taskId, kind: input.kind }),
      async authorize(input, ctx) {
        await authorizeWorkTask(ctx, input.taskId, "edit");
      },
      async run(input, ctx) {
        const authority = await authorizeWorkTask(ctx, input.taskId, "edit");
        const task = await getTask(
          ctx.db,
          ctx.workspaceId,
          input.taskId,
          workReadAccess(authority),
        );
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
    },
    {
      admission: (input, authority) =>
        publicTaskAuthorityPredicate(authority, input.taskId, "edit"),
      delivery: (input, result, authority) =>
        !result || !publicId(result.id)
          ? publicBusinessSelection({ sql: "0", parameters: [] })
          : publicTaskChildSelection(
              authority,
              input.taskId,
              "task_links",
              {
                sql: "public_source.id = ? AND public_source.kind = ?",
                parameters: [result.id, input.kind],
              },
              "edit",
            ),
    },
  );

export async function getTask(
  db: SqlDatabase,
  workspaceId: string,
  taskId: string,
  access?: TaskReadAccess,
): Promise<TaskRecord | undefined> {
  if (!isUlid(taskId)) {
    return undefined;
  }
  // Pre-0045 schemas contain only shared tasks. Recheck after the legacy read so
  // a concurrent migration cannot deliver a row that acquired a privacy policy.
  const privacySchemaExists = async () =>
    Boolean(
      await db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_privacy'")
        .get(),
    );
  if (!access && !(await privacySchemaExists())) {
    const legacy = (await db
      .prepare(
        `SELECT task.id, task.project_id, task.parent_task_id, task.title, task.state,
          task.priority, task.due_at, task.next_owner_type, task.next_owner_id,
          task.next_action_reason, task.punchline, task.resource_version
         FROM tasks AS task WHERE task.workspace_id = ? AND task.id = ?`,
      )
      .get(workspaceId, taskId)) as TaskRecord | null | undefined;
    if (!(await privacySchemaExists())) return legacy ?? undefined;
  }
  const predicate = readTaskPredicate(access);
  const projection = taskProjection(access);
  const row = (await db
    .prepare(
      `SELECT ${projection.sql}
       FROM tasks AS task WHERE task.workspace_id = ? AND task.id = ? AND ${predicate.sql}`,
    )
    .get(...projection.parameters, workspaceId, taskId, ...predicate.parameters)) as
    TaskRecord | null | undefined;
  return row ?? undefined;
}

/** Final canonical task read retaining its identity and original OAuth ceilings. */
export async function getDelegatedTask(
  db: SqlDatabase,
  workspaceId: string,
  retained: Pick<TaskRecord, "id" | "project_id">,
  access: DelegatedTaskReadAccess,
): Promise<TaskRecord | undefined> {
  if (
    [retained.id, retained.project_id].some(
      (id) => typeof id !== "string" || id.length !== 26 || !isUlid(id),
    )
  )
    return undefined;
  const predicate = delegatedReadTaskPredicate(access);
  const projection = taskProjection(access);
  const row = (await db
    .prepare(
      `SELECT ${projection.sql}
       FROM tasks AS task WHERE task.workspace_id = ? AND task.id = ?
         AND task.project_id = ? AND ${predicate.sql}`,
    )
    .get(
      ...projection.parameters,
      workspaceId,
      retained.id,
      retained.project_id,
      ...predicate.parameters,
    )) as TaskRecord | null | undefined;
  return row ?? undefined;
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
  options: TaskReadOptions = {},
): Promise<TaskRecord[]> {
  return (await listTasksPage(db, workspaceId, projectIds, options)).tasks;
}

export async function listTasksPage(
  db: SqlDatabase,
  workspaceId: string,
  projectIds: string[],
  options: TaskReadOptions = {},
): Promise<TaskPage> {
  if (projectIds.length === 0) {
    return { tasks: [], limit: options.limit ?? 50, has_more: false };
  }
  if (options.cursor !== undefined && !isUlid(options.cursor)) {
    throw new DomainError("invalid_argument", "task cursor is invalid");
  }
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const placeholders = projectIds.map(() => "?").join(", ");
  const predicate = readTaskPredicate(options.access);
  const projection = taskProjection(options.access);
  const params: unknown[] = [
    ...projection.parameters,
    workspaceId,
    ...projectIds,
    ...predicate.parameters,
  ];
  const cursorClause = options.cursor ? " AND task.id > ?" : "";
  if (options.cursor) {
    params.push(options.cursor);
  }
  params.push(limit + 1);
  const rows = (await db
    .prepare(
      `SELECT ${projection.sql}
       FROM tasks AS task
       WHERE task.workspace_id = ? AND task.project_id IN (${placeholders}) AND ${predicate.sql}${cursorClause}
       ORDER BY task.id ASC
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
  options: TaskReadOptions = {},
): Promise<TaskPage> {
  if (!isUlid(rootTaskId)) {
    return { tasks: [], limit: options.limit ?? 50, has_more: false };
  }
  if (options.cursor !== undefined && !isUlid(options.cursor)) {
    throw new DomainError("invalid_argument", "task cursor is invalid");
  }
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const cursorClause = options.cursor ? "AND task.id > ?" : "";
  const predicate = readTaskPredicate(options.access);
  const root = readTaskPredicate(options.access, "subtree_root");
  const child = readTaskPredicate(options.access, "subtree_child");
  const projection = taskProjection(options.access);
  const rows = (await db
    .prepare(
      `WITH RECURSIVE subtree(id) AS (
         SELECT subtree_root.id FROM tasks AS subtree_root
         WHERE subtree_root.workspace_id = ? AND subtree_root.id = ? AND ${root.sql}
         UNION
         SELECT subtree_child.id FROM tasks AS subtree_child
         JOIN subtree AS parent ON subtree_child.parent_task_id = parent.id
         WHERE subtree_child.workspace_id = ? AND ${child.sql}
       )
       SELECT ${projection.sql}
       FROM tasks AS task
       JOIN subtree ON subtree.id = task.id
       WHERE task.workspace_id = ? AND ${predicate.sql} ${cursorClause}
       ORDER BY task.id ASC LIMIT ?`,
    )
    .all(
      workspaceId,
      rootTaskId,
      ...root.parameters,
      workspaceId,
      ...child.parameters,
      ...projection.parameters,
      workspaceId,
      ...predicate.parameters,
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
  access?: TaskReadAccess,
): Promise<AgentContextItem[]> {
  const predicate = readTaskPredicate(access);
  return (await db
    .prepare(
      `SELECT item.id, item.kind, item.body, item.version, item.audience, item.content_hash, item.created_at
       FROM task_context_items AS item JOIN tasks AS task
         ON task.workspace_id = item.workspace_id AND task.id = item.task_id
       WHERE item.workspace_id = ? AND item.task_id = ? AND item.audience IN ('agent', 'both')
         AND ${predicate.sql}
       ORDER BY item.version ASC`,
    )
    .all(workspaceId, taskId, ...predicate.parameters)) as AgentContextItem[];
}

export interface DelegatedTaskReadAccess extends TaskReadAccess {
  delegationId: string;
  clientId: string;
  /** Nullable original credential boundary, separate from the selected task's project. */
  projectBoundaryId: string | null;
}

export type DelegatedContextAccess = DelegatedTaskReadAccess;

interface DelegatedContextBoundary {
  clientId: string;
  projectId: string | null;
  taskId: string | null;
}

function delegatedContextPredicate(
  workspaceId: string,
  taskId: string,
  projectId: string,
  access: DelegatedContextAccess,
) {
  const read = delegatedReadTaskPredicate(access);
  return {
    sql: `task.workspace_id = ? AND task.id = ? AND task.project_id = ?
      AND ${read.sql}`,
    parameters: [workspaceId, taskId, projectId, ...read.parameters],
  };
}

/** Retain original OAuth ceilings while checking current read authority at selection. */
export function delegatedReadTaskPredicate(access: DelegatedTaskReadAccess) {
  const read = readTaskPredicate(access);
  const credential = delegatedReadCredentialPredicate(access);
  return {
    sql: `${read.sql} AND EXISTS (
        SELECT 1 FROM oauth_delegations AS credential
        WHERE credential.workspace_id = task.workspace_id AND ${credential.sql}
      )`,
    parameters: [...read.parameters, ...credential.parameters],
  };
}

/** Match the authenticated credential's original ceilings and current read authority. */
export function delegatedReadCredentialPredicate(access: DelegatedTaskReadAccess) {
  return delegatedCredentialPredicate(access, "bfb:read");
}

/** Match retained OAuth ceilings and current scope at a command-owned final selection. */
export function delegatedCredentialPredicate(
  access: DelegatedTaskReadAccess,
  scope: "bfb:read" | "bfb:task:write",
) {
  const scopes = `CASE WHEN json_valid(credential.scopes_json) THEN
    CASE WHEN json_type(credential.scopes_json) = 'array' THEN credential.scopes_json ELSE '[]' END
    ELSE '[]' END`;
  return {
    sql: `credential.workspace_id = ? AND credential.id = ?
          AND credential.human_id = ? AND credential.client_id = ?
          AND credential.authorization_epoch = ? AND credential.revoked_at IS NULL
          AND credential.project_id IS ? AND credential.task_id IS ?
          AND julianday(credential.expires_at) > julianday('now')
          AND EXISTS (SELECT 1 FROM json_each(${scopes}) AS scope
            WHERE scope.type = 'text' AND scope.value = ?)
          AND NOT EXISTS (SELECT 1 FROM json_each(${scopes}) AS scope WHERE scope.type <> 'text')`,
    parameters: [
      access.workspaceId,
      access.delegationId,
      access.humanId,
      access.clientId,
      access.authorizationEpoch,
      access.projectBoundaryId,
      access.taskBoundaryId ?? null,
      scope,
    ],
  };
}

function contextIdentities(items: AgentContextItem[]): string | undefined {
  if (!Array.isArray(items) || items.length > MAX_CONTEXT_ITEMS_PER_TASK) return undefined;
  const ids = new Set<string>(),
    versions = new Set<number>();
  const identities = [];
  for (const item of items) {
    if (
      !item ||
      typeof item.id !== "string" ||
      item.id.length !== 26 ||
      !isUlid(item.id) ||
      !Number.isSafeInteger(item.version) ||
      item.version < 1 ||
      typeof item.content_hash !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(item.content_hash) ||
      !["agent", "both"].includes(item.audience) ||
      ids.has(item.id) ||
      versions.has(item.version)
    )
      return undefined;
    ids.add(item.id);
    versions.add(item.version);
    identities.push({
      id: item.id,
      version: item.version,
      content_hash: item.content_hash,
      audience: item.audience,
    });
  }
  return JSON.stringify(identities);
}

function retainedContextPredicate(identities: string, access?: DelegatedContextAccess) {
  return {
    sql: `NOT EXISTS (
      SELECT 1 FROM json_each(?) AS retained WHERE NOT EXISTS (
        SELECT 1 FROM task_context_items AS item
        WHERE item.workspace_id = task.workspace_id AND item.task_id = task.id
          AND item.id = json_extract(retained.value, '$.id')
          AND item.version = json_extract(retained.value, '$.version')
          AND item.content_hash = json_extract(retained.value, '$.content_hash')
          AND item.audience = json_extract(retained.value, '$.audience')
          ${
            access
              ? `AND EXISTS (
            SELECT 1 FROM task_context_deliveries AS delivery
            WHERE delivery.workspace_id = item.workspace_id AND delivery.task_id = item.task_id
              AND delivery.context_version = item.version AND delivery.content_hash = item.content_hash
              AND delivery.delegation_id = ? AND delivery.client_id = ?
          )`
              : ""
          }
      )
    )`,
    parameters: [identities, ...(access ? [access.delegationId, access.clientId] : [])],
  };
}

/** Select canonical fresh or previously delivered context with one current-authority sentinel. */
export async function selectDelegatedAgentContext(
  db: SqlDatabase,
  workspaceId: string,
  taskId: string,
  projectId: string,
  access: DelegatedContextAccess,
  retained?: AgentContextItem[],
): Promise<AgentContextItem[] | undefined> {
  const identities = retained === undefined ? undefined : contextIdentities(retained);
  if (retained !== undefined && identities === undefined) return undefined;
  const authority = delegatedContextPredicate(workspaceId, taskId, projectId, access);
  const exact = identities === undefined ? undefined : retainedContextPredicate(identities, access);
  const source =
    identities === undefined
      ? `SELECT item.* FROM task_context_items AS item
       WHERE item.workspace_id = task.workspace_id AND item.task_id = task.id
         AND item.audience IN ('agent', 'both') ORDER BY item.version ASC`
      : `SELECT item.* FROM json_each(?) AS retained JOIN task_context_items AS item
         ON item.id = json_extract(retained.value, '$.id')
       WHERE item.workspace_id = task.workspace_id AND item.task_id = task.id
       ORDER BY CAST(retained.key AS INTEGER) ASC`;
  const row = (await db
    .prepare(
      `SELECT (SELECT json_group_array(json_object(
      'id', item.id, 'kind', item.kind, 'body', item.body, 'version', item.version,
      'audience', item.audience, 'content_hash', item.content_hash, 'created_at', item.created_at
    )) FROM (${source}) AS item) AS items_json
     FROM tasks AS task WHERE ${authority.sql} ${exact ? `AND ${exact.sql}` : ""}`,
    )
    .get(
      ...(identities === undefined ? [] : [identities]),
      ...authority.parameters,
      ...(exact?.parameters ?? []),
    )) as { items_json: string } | undefined;
  if (!row) return undefined;
  const items = JSON.parse(row.items_json) as AgentContextItem[];
  if (
    items.length > MAX_CONTEXT_ITEMS_PER_TASK ||
    items.reduce((bytes, item) => bytes + Buffer.byteLength(item.body), 0) >
      MAX_CONTEXT_BYTES_PER_TASK
  ) {
    throw new DomainError("request_rejected", "context exceeds response bound");
  }
  return items;
}

async function guardDelegatedContextDelivery(
  db: SqlDatabase,
  workspaceId: string,
  taskId: string,
  projectId: string,
  access: DelegatedContextAccess,
  items: AgentContextItem[],
) {
  const identities = contextIdentities(items);
  if (identities === undefined) throw new DomainError("not_found", "task not found");
  const authority = delegatedContextPredicate(workspaceId, taskId, projectId, access);
  const exact = retainedContextPredicate(identities);
  const id = randomUlid();
  // Keep database expiry independent of preparation and receipt timestamps, including empty delivery.
  await db
    .prepare(
      `INSERT INTO artifact_mutation_guards (id,valid)
    SELECT ?, CASE WHEN EXISTS (SELECT 1 FROM oauth_delegations
      WHERE workspace_id = ? AND id = ? AND julianday(expires_at) > julianday('now'))
      THEN 1 ELSE 0 END`,
    )
    .run(id, workspaceId, access.delegationId);
  await db.prepare("DELETE FROM artifact_mutation_guards WHERE id = ?").run(id);
  await db
    .prepare(
      `INSERT INTO artifact_mutation_guards (id,valid)
    SELECT ?, CASE WHEN EXISTS (SELECT 1 FROM tasks AS task
      WHERE ${authority.sql} AND ${exact.sql}) THEN 1 ELSE 0 END`,
    )
    .run(id, ...authority.parameters, ...exact.parameters);
  await db.prepare("DELETE FROM artifact_mutation_guards WHERE id = ?").run(id);
}

type AgentContextAuthority =
  | { kind: "run"; runId: string; access?: TaskReadAccess }
  | {
      kind: "delegation";
      delegationId: string;
      clientId: string;
      humanId: string;
      authorizationEpoch: number;
      boundary?: DelegatedContextBoundary;
    };

export interface AgentContextDelivery {
  id: string;
  context_version: number;
  content_hash: string;
  delivered_at: string;
  run_id: string;
}

export interface RunContextResult {
  context: AgentContextItem[];
  deliveries: AgentContextDelivery[];
}

export async function deliverAgentContext(
  db: SqlDatabase,
  workspaceId: string,
  taskId: string,
  authority: AgentContextAuthority,
  now: string,
  maximumResultBytes?: number,
): Promise<RunContextResult> {
  const access =
    authority.kind === "delegation"
      ? {
          workspaceId,
          humanId: authority.humanId,
          authorizationEpoch: authority.authorizationEpoch,
        }
      : authority.access;
  const task = await getTask(db, workspaceId, taskId, access);
  if (!task) {
    throw new DomainError("not_found", "task not found");
  }
  let delegatedAccess: DelegatedContextAccess | undefined;
  if (authority.kind === "run") {
    const run = await db
      .prepare(
        `SELECT 1 AS found FROM runs
         WHERE workspace_id = ? AND id = ? AND task_id = ? AND purpose = 'work'
           AND result_state IN ('open', 'changes_requested')
           ${
             access
               ? `AND EXISTS (
             SELECT 1 FROM execution_assignments AS context_assignment
             WHERE context_assignment.workspace_id = runs.workspace_id
               AND context_assignment.run_id = runs.id AND context_assignment.task_id = runs.task_id
               AND context_assignment.requesting_human_id = ?
               AND context_assignment.requesting_human_epoch = ?
           )`
               : ""
           }`,
      )
      .get(
        workspaceId,
        authority.runId,
        taskId,
        ...(access ? [access.humanId, access.authorizationEpoch] : []),
      );
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
    const boundary = authority.boundary ?? {
      clientId: delegation.client_id,
      projectId: delegation.project_id,
      taskId: delegation.task_id,
    };
    delegatedAccess = {
      workspaceId,
      humanId: authority.humanId,
      authorizationEpoch: authority.authorizationEpoch,
      delegationId: authority.delegationId,
      clientId: boundary.clientId,
      projectBoundaryId: boundary.projectId,
      ...(boundary.taskId ? { taskBoundaryId: boundary.taskId } : {}),
    };
  }
  const items = delegatedAccess
    ? await selectDelegatedAgentContext(db, workspaceId, taskId, task.project_id, delegatedAccess)
    : await getAgentContext(db, workspaceId, taskId, access);
  if (!items) throw new DomainError("not_found", "task not found");
  const rows = items.map((item) => ({
    id: randomUlid(),
    context_version: item.version,
    content_hash: item.content_hash,
    delivered_at: now,
    run_id: authority.kind === "run" ? authority.runId : "",
  }));
  const result = { context: items, deliveries: authority.kind === "run" ? rows : [] };
  if (maximumResultBytes !== undefined) {
    // Go's RPC encoder escapes these characters; bound its actual byte shape
    // before any delivery writes are staged, leaving room for the envelope.
    const encoded = JSON.stringify(result).replace(
      /[<>&\u2028\u2029]/gu,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
    if (Buffer.byteLength(encoded) > maximumResultBytes) {
      throw new DomainError("request_rejected", "context exceeds local response bound");
    }
  }
  if (delegatedAccess) {
    await guardDelegatedContextDelivery(
      db,
      workspaceId,
      taskId,
      task.project_id,
      delegatedAccess,
      items,
    );
  }
  for (const row of rows) {
    await db
      .prepare(
        `INSERT INTO task_context_deliveries
         (workspace_id, id, task_id, context_version, content_hash,
          run_id, delegation_id, client_id, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        workspaceId,
        row.id,
        taskId,
        row.context_version,
        row.content_hash,
        authority.kind === "run" ? authority.runId : null,
        authority.kind === "delegation" ? authority.delegationId : null,
        authority.kind === "delegation" ? authority.clientId : null,
        now,
      );
  }
  return result;
}

function publicDelegatedContextAuthority(taskId: string, authority: PublicBusinessAuthority) {
  return authority.credential?.kind !== "delegation"
    ? { sql: "0", parameters: [] }
    : publicTaskAuthorityPredicate(
        authority,
        taskId,
        "read",
        ["owner", "member", "reviewer"],
        "bfb:read",
      );
}

export const deliverDelegatedAgentContextCommand: HubCommand<
  { taskId: string; delegationBoundary?: DelegatedContextBoundary },
  AgentContextItem[]
> = publicBusinessCommand<
  { taskId: string; delegationBoundary?: DelegatedContextBoundary },
  AgentContextItem[]
>(
  {
    name: "context.deliver.delegation",
    inputFingerprint: (input) => workInputFingerprint({ ...input, delegationBoundary: undefined }),
    auditInput: (input) => ({ taskId: input.taskId }),
    auditResult: (items) =>
      items.map((item) => ({
        id: item.id,
        version: item.version,
        content_hash: item.content_hash,
      })),
    async authorize(input, ctx) {
      const authority = await authorizeWorkTask(ctx, input.taskId, "read");
      if (!authority.delegation) throw new DomainError("forbidden", "delegated authority required");
    },
    async replayResult(result, ctx, input) {
      if (!Array.isArray(result)) throw new DomainError("not_found", "task not found");
      if (!ctx.actorHumanId || !ctx.actorDelegationId)
        throw new DomainError("not_found", "task not found");
      // Admission already ran before cache hydration; current authority belongs to the final selector.
      const delegation = (await ctx.db
        .prepare(
          `SELECT client_id,project_id,task_id FROM oauth_delegations
      WHERE workspace_id = ? AND id = ?`,
        )
        .get(ctx.workspaceId, ctx.actorDelegationId)) as
        Pick<DelegationRow, "client_id" | "project_id" | "task_id"> | undefined;
      if (!delegation) throw new DomainError("not_found", "task not found");
      const task = await getTask(ctx.db, ctx.workspaceId, input.taskId, {
        workspaceId: ctx.workspaceId,
        humanId: ctx.actorHumanId,
        authorizationEpoch: ctx.authorizationEpoch,
      });
      if (!task) throw new DomainError("not_found", "task not found");
      const boundary = input.delegationBoundary ?? {
        clientId: delegation.client_id,
        projectId: delegation.project_id,
        taskId: delegation.task_id,
      };
      const items = await selectDelegatedAgentContext(
        ctx.db,
        ctx.workspaceId,
        input.taskId,
        task.project_id,
        {
          workspaceId: ctx.workspaceId,
          humanId: ctx.actorHumanId,
          authorizationEpoch: ctx.authorizationEpoch,
          delegationId: ctx.actorDelegationId,
          clientId: boundary.clientId,
          projectBoundaryId: boundary.projectId,
          ...(boundary.taskId ? { taskBoundaryId: boundary.taskId } : {}),
        },
        result,
      );
      if (!items) throw new DomainError("not_found", "task not found");
      return items;
    },
    async run(input, ctx) {
      const authority = await authorizeWorkTask(ctx, input.taskId, "read");
      if (!authority.delegation) {
        throw new DomainError("forbidden", "delegated authority required");
      }
      assertDelegationScope(authority.delegation, "bfb:read");
      const task = await getTask(ctx.db, ctx.workspaceId, input.taskId, authority.principal);
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
      return (
        await deliverAgentContext(
          ctx.db,
          ctx.workspaceId,
          task.id,
          {
            kind: "delegation",
            delegationId: authority.delegation.id,
            clientId: authority.delegation.client_id,
            humanId: authority.delegation.human_id,
            authorizationEpoch: authority.delegation.authorization_epoch,
            ...(input.delegationBoundary ? { boundary: input.delegationBoundary } : {}),
          },
          ctx.now,
        )
      ).context;
    },
  },
  {
    denial: { code: "not_found", message: "task not found" },
    finalSelectionByTransport: true,
    admission: (input, authority) => publicDelegatedContextAuthority(input.taskId, authority),
    delivery: (input, items, authority) => {
      const identities = contextIdentities(items);
      if (identities === undefined || authority.credential?.kind !== "delegation")
        return publicBusinessSelection({ sql: "0", parameters: [] });
      const access = publicDelegatedContextAuthority(input.taskId, authority);
      return {
        sql: `SELECT 1 AS permitted WHERE ${access.sql} AND NOT EXISTS (
        SELECT 1 FROM json_each(?) AS retained WHERE NOT EXISTS (
          SELECT 1 FROM task_context_items AS public_item
          JOIN task_context_deliveries AS public_delivery
            ON public_delivery.workspace_id = public_item.workspace_id
              AND public_delivery.task_id = public_item.task_id
              AND public_delivery.context_version = public_item.version
              AND public_delivery.content_hash = public_item.content_hash
          WHERE public_item.workspace_id = ? AND public_item.task_id = ?
            AND public_item.id = json_extract(retained.value, '$.id')
            AND public_item.version = json_extract(retained.value, '$.version')
            AND public_item.content_hash = json_extract(retained.value, '$.content_hash')
            AND public_item.audience = json_extract(retained.value, '$.audience')
            AND public_delivery.delegation_id = ? AND public_delivery.client_id = ?
        ))`,
        parameters: [
          ...access.parameters,
          identities,
          authority.workspaceId,
          input.taskId,
          authority.credential.delegationId,
          authority.credential.clientId,
        ],
      };
    },
  },
);

export const deliverRunAgentContextCommand: HubCommand<{ taskId: string }, AgentContextItem[]> = {
  name: "context.deliver.run",
  async run(input, ctx) {
    if (!ctx.actorSystemId || ctx.actorHumanId || ctx.actorDelegationId) {
      throw new DomainError("forbidden", "run-scoped authority required");
    }
    return (
      await deliverAgentContext(
        ctx.db,
        ctx.workspaceId,
        input.taskId,
        { kind: "run", runId: ctx.actorSystemId },
        ctx.now,
      )
    ).context;
  },
};
