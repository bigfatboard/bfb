// ABOUTME: Selects delegated project and task pages with current authority in the same statement.
// ABOUTME: Captured project ceilings narrow canonical pages before lookahead and rooted traversal.

import type { SqlDatabase } from "@bfb/db";

import { DomainError } from "./hub.js";
import { isUlid } from "./ids.js";
import type { ProjectRecord } from "./projects.js";
import {
  delegatedReadCredentialPredicate,
  delegatedReadTaskPredicate,
  taskProjection,
  type DelegatedTaskReadAccess,
  type TaskPage,
  type TaskRecord,
} from "./work-commands.js";

interface ListOptions {
  limit?: number;
  cursor?: string;
}

type SelectedRow<T> = { authority_ok: number } & { [P in keyof T]: T[P] | null };

function selectedItems<T extends { id: string }>(rows: SelectedRow<T>[]): T[] {
  if (rows[0]?.authority_ok !== 1)
    throw new DomainError("not_found", "delegated list not available");
  return rows
    .filter((row) => row.id !== null)
    .map(({ authority_ok: _authority, ...item }) => item as unknown as T);
}

function listAuthority(access: DelegatedTaskReadAccess) {
  const credential = delegatedReadCredentialPredicate(access);
  return {
    sql: `authority AS (
      SELECT credential.workspace_id, credential.human_id, credential.project_id, credential.task_id
      FROM oauth_delegations AS credential
      JOIN workspace_members AS member ON member.workspace_id = credential.workspace_id
        AND member.human_id = credential.human_id
      JOIN workspace_authorization_epochs AS epoch ON epoch.workspace_id = member.workspace_id
        AND epoch.human_id = member.human_id AND epoch.authorization_epoch = member.authorization_epoch
        AND epoch.revoked_at IS NULL
      WHERE ${credential.sql} AND member.authorization_epoch = credential.authorization_epoch
        AND member.role IN ('owner', 'member', 'reviewer')
    )`,
    parameters: credential.parameters,
  };
}

export async function listDelegatedProjectsPage(
  db: SqlDatabase,
  access: DelegatedTaskReadAccess,
  projectIds: readonly string[],
  options: ListOptions = {},
): Promise<{ projects: ProjectRecord[]; hasMore: boolean; nextCursor?: string }> {
  const authority = listAuthority(access);
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const rows = (await db
    .prepare(
      `WITH ${authority.sql}, page AS (
        SELECT project.id, project.name, project.slug, project.tint, project.access_mode,
          project.repository_host, project.hosted_repository_id, project.repository_subpath,
          project.resource_version
        FROM projects AS project JOIN authority ON authority.workspace_id = project.workspace_id
        WHERE project.id IN (SELECT value FROM json_each(?) WHERE type = 'text')
          AND (authority.project_id IS NULL OR authority.project_id = project.id)
          AND (project.access_mode = 'workspace' OR EXISTS (
            SELECT 1 FROM project_access AS grant_access
            WHERE grant_access.workspace_id = project.workspace_id AND grant_access.project_id = project.id
              AND grant_access.human_id = authority.human_id
          )) ${options.cursor ? "AND project.id > ?" : ""}
        ORDER BY project.id ASC LIMIT ?
      )
      SELECT EXISTS(SELECT 1 FROM authority) AS authority_ok, page.*
      FROM (SELECT 1) LEFT JOIN page ON 1 ORDER BY page.id ASC`,
    )
    .all(
      ...authority.parameters,
      JSON.stringify(projectIds),
      ...(options.cursor ? [options.cursor] : []),
      limit + 1,
    )) as SelectedRow<ProjectRecord>[];
  const items = selectedItems(rows);
  const hasMore = items.length > limit;
  const projects = hasMore ? items.slice(0, limit) : items;
  return {
    projects,
    hasMore,
    ...(hasMore ? { nextCursor: projects[projects.length - 1]!.id } : {}),
  };
}

export async function listDelegatedTasksPage(
  db: SqlDatabase,
  access: DelegatedTaskReadAccess,
  projectIds: readonly string[],
  options: ListOptions = {},
): Promise<TaskPage> {
  if (options.cursor !== undefined && !isUlid(options.cursor))
    throw new DomainError("invalid_argument", "task cursor is invalid");
  const authority = listAuthority(access);
  const read = delegatedReadTaskPredicate(access);
  const projection = taskProjection(access);
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const root = access.taskBoundaryId;
  const rows = (await db
    .prepare(
      `WITH RECURSIVE ${authority.sql}, readable_tasks AS (
        SELECT task.* FROM tasks AS task JOIN authority ON authority.workspace_id = task.workspace_id
        WHERE ${read.sql}
          AND task.project_id IN (SELECT value FROM json_each(?) WHERE type = 'text')
          AND (authority.project_id IS NULL OR authority.project_id = task.project_id)
      ), list_authority AS (
        SELECT 1 FROM authority ${root ? "WHERE EXISTS (SELECT 1 FROM readable_tasks WHERE id = ?)" : ""}
      ), ${
        root
          ? `subtree(id) AS (
        SELECT id FROM readable_tasks WHERE id = ?
        UNION SELECT child.id FROM readable_tasks AS child JOIN subtree AS parent
          ON child.parent_task_id = parent.id
      ),`
          : ""
      } page AS (
        SELECT ${projection.sql} FROM readable_tasks AS task
        ${root ? "JOIN subtree ON subtree.id = task.id" : ""} CROSS JOIN list_authority
        ${options.cursor ? "WHERE task.id > ?" : ""} ORDER BY task.id ASC LIMIT ?
      )
      SELECT EXISTS(SELECT 1 FROM list_authority) AS authority_ok, page.*
      FROM (SELECT 1) LEFT JOIN page ON 1 ORDER BY page.id ASC`,
    )
    .all(
      ...authority.parameters,
      ...read.parameters,
      JSON.stringify(projectIds),
      ...(root ? [root, root] : []),
      ...projection.parameters,
      ...(options.cursor ? [options.cursor] : []),
      limit + 1,
    )) as SelectedRow<TaskRecord>[];
  const items = selectedItems(rows);
  const has_more = items.length > limit;
  const tasks = has_more ? items.slice(0, limit) : items;
  return {
    tasks,
    limit,
    has_more,
    ...(has_more ? { next_cursor: tasks[tasks.length - 1]!.id } : {}),
  };
}
