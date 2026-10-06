// ABOUTME: Builds one current-membership/project/creator-grant predicate for task and child reads.
// ABOUTME: Private authority is dormant until the complete delivery gate enables task creation.

import type { SqlDatabase } from "@bfb/db";
import { DomainError } from "./hub.js";
import { isUlid } from "./ids.js";

export const TASK_ACCESS_ACTIONS = ["read", "contribute", "edit", "manage_sharing"] as const;
export type TaskAccessAction = (typeof TASK_ACCESS_ACTIONS)[number];

/** These IDs/epoch must come from authenticated transport authority, never request JSON. */
export interface TaskAccessContext {
  workspaceId: string;
  humanId: string;
  authorizationEpoch: number;
}

export interface TaskAccessMetadata {
  taskId: string;
  projectId: string;
  privateOwnerHumanId: string | null;
  accessVersion: number | null;
}

/** Uncertified internal consumers must not treat absent human authority as private access. */
export function sharedTaskPredicate(taskAlias = "task"): string {
  const task = checkedTaskAlias(taskAlias);
  return `NOT EXISTS (SELECT 1 FROM task_privacy AS task_policy
    WHERE task_policy.workspace_id = ${task}.workspace_id AND task_policy.task_id = ${task}.id)`;
}

function checkedTaskAlias(taskAlias: string): string {
  if (
    typeof taskAlias !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(taskAlias) ||
    [
      "task_member",
      "task_epoch",
      "task_project",
      "task_project_grant",
      "task_policy",
      "task_grant",
    ].includes(taskAlias.toLowerCase())
  ) {
    throw new DomainError("invalid_argument", "invalid task access query");
  }
  return `"${taskAlias}"`;
}

/** Apply before pagination/aggregation; join every child to this exact parent task alias. */
export function taskAccessPredicate(
  context: TaskAccessContext,
  action: TaskAccessAction,
  taskAlias = "task",
): { sql: string; parameters: Array<string | number> } {
  if (
    !context ||
    !isUlid(context.workspaceId) ||
    !isUlid(context.humanId) ||
    !Number.isSafeInteger(context.authorizationEpoch) ||
    context.authorizationEpoch < 1 ||
    !TASK_ACCESS_ACTIONS.includes(action)
  ) {
    throw new DomainError("invalid_argument", "invalid task access query");
  }
  const task = checkedTaskAlias(taskAlias);
  const roles =
    action === "edit" || action === "manage_sharing"
      ? "'owner', 'member'"
      : "'owner', 'member', 'reviewer'";
  const permissions =
    action === "edit"
      ? "'edit'"
      : action === "contribute"
        ? "'contribute', 'edit'"
        : "'read', 'contribute', 'edit'";
  const shared =
    action === "manage_sharing"
      ? "0"
      : `NOT EXISTS (
    SELECT 1 FROM task_privacy AS task_policy
    WHERE task_policy.workspace_id = ${task}.workspace_id AND task_policy.task_id = ${task}.id
  )`;
  const grant =
    action === "manage_sharing"
      ? "0"
      : `EXISTS (
    SELECT 1 FROM task_human_grants AS task_grant
    WHERE task_grant.workspace_id = task_policy.workspace_id
      AND task_grant.task_id = task_policy.task_id
      AND task_grant.human_id = task_member.human_id
      AND task_grant.authorization_epoch = task_epoch.authorization_epoch
      AND task_grant.revoked_at IS NULL AND task_grant.permission IN (${permissions})
  )`;
  return {
    sql: `(${task}.workspace_id = ? AND EXISTS (
      SELECT 1 FROM workspace_members AS task_member
      JOIN workspace_authorization_epochs AS task_epoch
        ON task_epoch.workspace_id = task_member.workspace_id
       AND task_epoch.human_id = task_member.human_id
       AND task_epoch.authorization_epoch = task_member.authorization_epoch
       AND task_epoch.revoked_at IS NULL
      JOIN projects AS task_project
        ON task_project.workspace_id = task_member.workspace_id
       AND task_project.id = ${task}.project_id
      WHERE task_member.workspace_id = ${task}.workspace_id
        AND task_member.human_id = ? AND task_epoch.authorization_epoch = ?
        AND task_member.role IN (${roles})
        AND (task_project.access_mode = 'workspace' OR EXISTS (
          SELECT 1 FROM project_access AS task_project_grant
          WHERE task_project_grant.workspace_id = task_project.workspace_id
            AND task_project_grant.project_id = task_project.id
            AND task_project_grant.human_id = task_member.human_id
        ))
        AND (${shared} OR EXISTS (
          SELECT 1 FROM task_privacy AS task_policy
          WHERE task_policy.workspace_id = ${task}.workspace_id AND task_policy.task_id = ${task}.id
            AND (task_policy.owner_human_id = task_member.human_id OR ${grant})
        ))
    ))`,
    parameters: [context.workspaceId, context.humanId, context.authorizationEpoch],
  };
}

/** Fresh query; uniform denial hides task existence and does not return private body data. */
export async function assertTaskAccess(
  db: SqlDatabase,
  context: TaskAccessContext,
  taskId: string,
  action: TaskAccessAction = "read",
): Promise<TaskAccessMetadata> {
  const predicate = taskAccessPredicate(context, action);
  if (!isUlid(taskId)) throw new DomainError("invalid_argument", "invalid task access query");
  const row = (await db
    .prepare(
      `
    SELECT task.id AS taskId, task.project_id AS projectId,
           policy.owner_human_id AS privateOwnerHumanId, policy.access_version AS accessVersion
    FROM tasks AS task LEFT JOIN task_privacy AS policy
      ON policy.workspace_id = task.workspace_id AND policy.task_id = task.id
    WHERE ${predicate.sql} AND task.id = ?
  `,
    )
    .get(...predicate.parameters, taskId)) as TaskAccessMetadata | undefined;
  if (!row) throw new DomainError("not_found", "task not found");
  return row;
}
