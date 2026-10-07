// ABOUTME: Selects browser task child collections and their current readable parent in one statement.
// ABOUTME: Distinguishes denied parents from empty pages while retaining the captured human and project ceiling.

import type { SqlDatabase } from "@bfb/db";

import type { AuthzPrincipal } from "./authorization.js";
import { DomainError } from "./hub.js";
import { isUlid } from "./ids.js";
import { taskAccessPredicate } from "./task-access.js";

export type HumanTaskCollection =
  "comments" | "context" | "agent_context" | "dependencies" | "links" | "runs";

interface CollectionOptions {
  limit?: number;
  cursor?: string;
}
type Row = Record<string, unknown>;

/** A final parent sentinel remains present even when the selected child page has no rows. */
export async function readHumanTaskCollection(
  db: SqlDatabase,
  principal: AuthzPrincipal,
  taskId: string,
  collection: HumanTaskCollection,
  options: CollectionOptions = {},
): Promise<Row[] | null> {
  if (!isUlid(taskId)) return null;
  const limit = options.limit ?? 50;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (options.cursor !== undefined && !isUlid(options.cursor))
  )
    throw new DomainError("invalid_argument", "task collection pagination is invalid");

  const parent = taskAccessPredicate(principal, "read", "collection_parent");
  const parameters: Array<string | number> = [
    taskId,
    JSON.stringify(principal.projectIds),
    ...parent.parameters,
  ];
  let selection: string;
  let identity = "id";
  let order = "page.id ASC";
  const cursor = (column: string) => (options.cursor ? `AND ${column} > ?` : "");

  switch (collection) {
    case "comments":
      selection = `SELECT comment.id, comment.author_human_id, comment.author_delegation_id,
          comment.body, comment.kind, comment.created_at,
          CASE WHEN effect.operation_key IS NOT NULL THEN 'agent_run'
               WHEN comment.author_delegation_id IS NOT NULL THEN 'delegated_human'
               WHEN comment.author_human_id IS NOT NULL THEN 'human' ELSE 'unknown' END AS author_kind,
          effect.run_id AS author_run_id, effect.execution_id AS author_execution_id,
          effect.provider_session_id AS author_provider_session_id, effect.percent, effect.confidence
        FROM comments AS comment JOIN readable_parent AS parent
          ON parent.workspace_id = comment.workspace_id AND parent.id = comment.task_id
        LEFT JOIN agent_work_effects AS effect
          ON effect.workspace_id = comment.workspace_id AND effect.comment_id = comment.id
          AND effect.target_task_id = comment.task_id AND effect.kind IN ('comment.add', 'progress.report')
        WHERE 1 ${cursor("comment.id")} ORDER BY comment.id ASC LIMIT ?`;
      break;
    case "context":
    case "agent_context":
      selection = `SELECT item.id, item.kind, item.body, item.version, item.audience,
          item.content_hash, item.created_at
        FROM task_context_items AS item JOIN readable_parent AS parent
          ON parent.workspace_id = item.workspace_id AND parent.id = item.task_id
        ${collection === "agent_context" ? "WHERE item.audience IN ('agent', 'both')" : ""}
        ORDER BY item.version ASC`;
      order = "page.version ASC";
      break;
    case "dependencies": {
      const target = taskAccessPredicate(principal, "read", "task");
      selection = `SELECT dependency.depends_on_task_id, dependency.kind, dependency.created_at,
          task.title, task.state, task.priority
        FROM task_dependencies AS dependency JOIN readable_parent AS parent
          ON parent.workspace_id = dependency.workspace_id AND parent.id = dependency.task_id
          AND parent.project_id = dependency.project_id
        JOIN tasks AS task ON task.workspace_id = dependency.workspace_id
          AND task.id = dependency.depends_on_task_id AND task.project_id = parent.project_id
        WHERE ${target.sql} ${cursor("dependency.depends_on_task_id")}
        ORDER BY dependency.depends_on_task_id ASC LIMIT ?`;
      parameters.push(...target.parameters);
      identity = "depends_on_task_id";
      order = "page.depends_on_task_id ASC";
      break;
    }
    case "links":
      selection = `SELECT link.id, link.kind, link.url, link.label, link.created_at
        FROM task_links AS link JOIN readable_parent AS parent
          ON parent.workspace_id = link.workspace_id AND parent.id = link.task_id
        WHERE 1 ${cursor("link.id")} ORDER BY link.id ASC LIMIT ?`;
      break;
    case "runs":
      selection = `SELECT run.id, run.project_id, run.task_id, run.requested_by_human_id,
          run.agent_profile_id, run.result_state, run.activity, run.resource_version, run.created_at
        FROM runs AS run JOIN readable_parent AS parent
          ON parent.workspace_id = run.workspace_id AND parent.id = run.task_id
          AND parent.project_id = run.project_id
        WHERE run.purpose = 'work' ${cursor("run.id")} ORDER BY run.id ASC LIMIT ?`;
      break;
    default:
      throw new DomainError("invalid_argument", "task collection is invalid");
  }
  if (collection !== "context" && collection !== "agent_context")
    parameters.push(...(options.cursor ? [options.cursor] : []), limit + 1);

  const rows = (await db
    .prepare(
      `WITH readable_parent AS MATERIALIZED (
         SELECT collection_parent.workspace_id, collection_parent.id, collection_parent.project_id
         FROM tasks AS collection_parent WHERE collection_parent.id = ?
           AND collection_parent.project_id IN (SELECT value FROM json_each(?) WHERE type = 'text')
           AND ${parent.sql}
       ), page AS MATERIALIZED (${selection})
       SELECT EXISTS(SELECT 1 FROM readable_parent) AS parent_authorized, page.*
       FROM (SELECT 1) LEFT JOIN page ON 1 ORDER BY ${order}`,
    )
    .all(...parameters)) as Row[];
  if (rows[0]?.parent_authorized !== 1) return null;
  return rows
    .filter((row) => row[identity] !== null)
    .map(({ parent_authorized: _sentinel, ...row }) => row);
}
