// ABOUTME: Evaluates workspace roles, project grants, and revocation epochs for domain commands.
// ABOUTME: Caller-supplied IDs may only narrow authority; they never widen membership or grants.

import type { SqlDatabase } from "@bfb/db";

import { DomainError } from "./hub.js";

export type WorkspaceRole = "owner" | "member" | "reviewer";

export interface AuthzPrincipal {
  humanId: string;
  workspaceId: string;
  role: WorkspaceRole;
  authorizationEpoch: number;
  projectIds: string[];
}

export async function loadPrincipal(
  db: SqlDatabase,
  workspaceId: string,
  humanId: string,
): Promise<AuthzPrincipal> {
  const member = (await db
    .prepare(
      `SELECT role, authorization_epoch FROM workspace_members
       WHERE workspace_id = ? AND human_id = ?`,
    )
    .get(workspaceId, humanId)) as { role: WorkspaceRole; authorization_epoch: number } | undefined;
  if (!member) {
    throw new DomainError("forbidden", "not a workspace member");
  }
  let projectIds: string[] = [];
  // Project grants are orthogonal: reviewers (and future restricted grants) use
  // explicit project_access rows; owners and members see all workspace projects.
  if (member.role === "reviewer") {
    projectIds = (
      (await db
        .prepare(`SELECT project_id FROM project_access WHERE workspace_id = ? AND human_id = ?`)
        .all(workspaceId, humanId)) as Array<{ project_id: string }>
    ).map((row) => row.project_id);
  } else {
    projectIds = (
      (await db
        .prepare(`SELECT id FROM projects WHERE workspace_id = ?`)
        .all(workspaceId)) as Array<{ id: string }>
    ).map((row) => row.id);
  }
  return {
    humanId,
    workspaceId,
    role: member.role,
    authorizationEpoch: member.authorization_epoch,
    projectIds,
  };
}

/** Authorize a task-child read (comment/context/etc.) using parent task project grants. */
export async function assertTaskChildAccess(
  db: SqlDatabase,
  principal: AuthzPrincipal,
  taskId: string,
): Promise<void> {
  const task = (await db
    .prepare(`SELECT project_id FROM tasks WHERE workspace_id = ? AND id = ?`)
    .get(principal.workspaceId, taskId)) as { project_id: string } | undefined;
  if (!task) {
    throw new DomainError("not_found", "task not found");
  }
  assertProjectAccess(principal, task.project_id);
}

export function assertProjectAccess(principal: AuthzPrincipal, projectId: string): void {
  if (!principal.projectIds.includes(projectId)) {
    throw new DomainError("forbidden", "project not permitted");
  }
}

export function assertRole(principal: AuthzPrincipal, allowed: WorkspaceRole[]): void {
  if (!allowed.includes(principal.role)) {
    throw new DomainError("forbidden", "role not permitted");
  }
}

export function assertEpoch(principal: AuthzPrincipal, expectedEpoch: number): void {
  if (principal.authorizationEpoch !== expectedEpoch) {
    throw new DomainError("stale_authorization", "authorization epoch mismatch");
  }
}

export async function bumpMemberEpoch(
  db: SqlDatabase,
  workspaceId: string,
  humanId: string,
): Promise<number> {
  const current = (await db
    .prepare(
      `SELECT authorization_epoch FROM workspace_members WHERE workspace_id = ? AND human_id = ?`,
    )
    .get(workspaceId, humanId)) as { authorization_epoch: number } | undefined;
  if (!current) {
    throw new DomainError("not_found", "member not found");
  }
  const next = current.authorization_epoch + 1;
  await db
    .prepare(
      `UPDATE workspace_members SET authorization_epoch = ? WHERE workspace_id = ? AND human_id = ?`,
    )
    .run(next, workspaceId, humanId);
  return next;
}
