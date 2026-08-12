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
      `SELECT membership.role, epoch.authorization_epoch
       FROM workspace_members AS membership
       JOIN workspace_authorization_epochs AS epoch
         ON epoch.workspace_id = membership.workspace_id
        AND epoch.human_id = membership.human_id
       WHERE membership.workspace_id = ?
         AND membership.human_id = ?
         AND membership.authorization_epoch = epoch.authorization_epoch
         AND epoch.revoked_at IS NULL`,
    )
    .get(workspaceId, humanId)) as { role: WorkspaceRole; authorization_epoch: number } | undefined;
  if (!member) {
    throw new DomainError("forbidden", "not a workspace member");
  }
  const projectIds = (
    (await db
      .prepare(
        `SELECT projects.id
         FROM projects
         LEFT JOIN project_access AS access
           ON access.workspace_id = projects.workspace_id
          AND access.project_id = projects.id
          AND access.human_id = ?
         WHERE projects.workspace_id = ?
           AND (projects.access_mode = 'workspace' OR access.human_id IS NOT NULL)
         ORDER BY projects.id`,
      )
      .all(humanId, workspaceId)) as Array<{ id: string }>
  ).map((row) => row.id);
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
      `SELECT membership.authorization_epoch
       FROM workspace_members AS membership
       JOIN workspace_authorization_epochs AS epoch
         ON epoch.workspace_id = membership.workspace_id
        AND epoch.human_id = membership.human_id
       WHERE membership.workspace_id = ?
         AND membership.human_id = ?
         AND membership.authorization_epoch = epoch.authorization_epoch
         AND epoch.revoked_at IS NULL`,
    )
    .get(workspaceId, humanId)) as { authorization_epoch: number } | undefined;
  if (!current) {
    throw new DomainError("not_found", "member not found");
  }
  const next = current.authorization_epoch + 1;
  const updatedAt = new Date().toISOString();
  await db.withTransaction(async (tx) => {
    await tx
      .prepare(
        `UPDATE workspace_members
         SET authorization_epoch = ?
         WHERE workspace_id = ? AND human_id = ? AND authorization_epoch = ?`,
      )
      .run(next, workspaceId, humanId, current.authorization_epoch);
    await tx
      .prepare(
        `UPDATE workspace_authorization_epochs
         SET authorization_epoch = ?, updated_at = ?
         WHERE workspace_id = ? AND human_id = ?
           AND authorization_epoch = ? AND revoked_at IS NULL`,
      )
      .run(next, updatedAt, workspaceId, humanId, current.authorization_epoch);
  });
  const after = (await db
    .prepare(
      `SELECT epoch.authorization_epoch
       FROM workspace_authorization_epochs AS epoch
       JOIN workspace_members AS membership
         ON membership.workspace_id = epoch.workspace_id
        AND membership.human_id = epoch.human_id
        AND membership.authorization_epoch = epoch.authorization_epoch
       WHERE epoch.workspace_id = ? AND epoch.human_id = ? AND epoch.revoked_at IS NULL`,
    )
    .get(workspaceId, humanId)) as { authorization_epoch: number } | undefined;
  if (after?.authorization_epoch !== next) {
    throw new DomainError("stale_authorization", "authorization epoch changed concurrently");
  }
  return next;
}

export async function assertPasskeyRemovalAllowed(
  db: SqlDatabase,
  humanId: string,
  authUserId: string,
): Promise<void> {
  const ownership = (await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM workspace_members
       WHERE human_id = ? AND role = 'owner'`,
    )
    .get(humanId)) as { count: number };
  if (ownership.count === 0) {
    return;
  }
  const passkeys = (await db
    .prepare(`SELECT COUNT(*) AS count FROM better_auth_passkeys WHERE user_id = ?`)
    .get(authUserId)) as { count: number };
  if (passkeys.count <= 1) {
    throw new DomainError(
      "final_authenticator",
      "workspace owner cannot remove final user-verifying authenticator",
    );
  }
}
