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

/** Shared canonical child projection; position metadata never changes business fields or audiences. */
export function humanTaskCollectionSource(
  principal: AuthzPrincipal,
  taskId: string,
  collection: HumanTaskCollection,
) {
  const parent = taskAccessPredicate(principal, "read", "collection_parent");
  let selection: string;
  const parameters: Array<string | number> = [];
  let columns: string[];
  let identity = "id";
  let order = "collection_anchor_id ASC";
  let table: string;
  let exactProject = "";
  let purpose = "";

  switch (collection) {
    case "comments":
      table = "comments";
      columns = [
        "id",
        "author_human_id",
        "author_delegation_id",
        "body",
        "kind",
        "created_at",
        "author_kind",
        "author_run_id",
        "author_execution_id",
        "author_provider_session_id",
        "percent",
        "confidence",
      ];
      selection = `SELECT comment.id AS collection_anchor_id, comment.rowid AS collection_anchor_rowid,
          comment.id, comment.author_human_id, comment.author_delegation_id,
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
        `;
      break;
    case "context":
    case "agent_context":
      table = "task_context_items";
      columns = ["id", "kind", "body", "version", "audience", "content_hash", "created_at"];
      selection = `SELECT item.id AS collection_anchor_id, item.rowid AS collection_anchor_rowid,
          item.id, item.kind, item.body, item.version, item.audience,
          item.content_hash, item.created_at
        FROM task_context_items AS item JOIN readable_parent AS parent
          ON parent.workspace_id = item.workspace_id AND parent.id = item.task_id
        ${collection === "agent_context" ? "WHERE item.audience IN ('agent', 'both')" : ""}`;
      order = "version ASC";
      break;
    case "dependencies": {
      table = "task_dependencies";
      exactProject = "AND parent.project_id=child.project_id";
      columns = ["depends_on_task_id", "kind", "created_at", "title", "state", "priority"];
      const target = taskAccessPredicate(principal, "read", "task");
      selection = `SELECT dependency.depends_on_task_id AS collection_anchor_id, dependency.rowid AS collection_anchor_rowid,
          dependency.depends_on_task_id, dependency.kind, dependency.created_at,
          task.title, task.state, task.priority
        FROM task_dependencies AS dependency JOIN readable_parent AS parent
          ON parent.workspace_id = dependency.workspace_id AND parent.id = dependency.task_id
          AND parent.project_id = dependency.project_id
        JOIN tasks AS task ON task.workspace_id = dependency.workspace_id
          AND task.id = dependency.depends_on_task_id AND task.project_id = parent.project_id
        WHERE ${target.sql}`;
      parameters.push(...target.parameters);
      identity = "depends_on_task_id";
      break;
    }
    case "links":
      table = "task_links";
      columns = ["id", "kind", "url", "label", "created_at"];
      selection = `SELECT link.id AS collection_anchor_id, link.rowid AS collection_anchor_rowid,
          link.id, link.kind, link.url, link.label, link.created_at
        FROM task_links AS link JOIN readable_parent AS parent
          ON parent.workspace_id = link.workspace_id AND parent.id = link.task_id
        `;
      break;
    case "runs":
      table = "runs";
      exactProject = "AND parent.project_id=child.project_id";
      purpose = "WHERE child.purpose='work'";
      columns = [
        "id",
        "project_id",
        "task_id",
        "requested_by_human_id",
        "agent_profile_id",
        "result_state",
        "activity",
        "resource_version",
        "created_at",
      ];
      selection = `SELECT run.id AS collection_anchor_id, run.rowid AS collection_anchor_rowid,
          run.id, run.project_id, run.task_id, run.requested_by_human_id,
          run.agent_profile_id, run.result_state, run.activity, run.resource_version, run.created_at
        FROM runs AS run JOIN readable_parent AS parent
          ON parent.workspace_id = run.workspace_id AND parent.id = run.task_id
          AND parent.project_id = run.project_id
        WHERE run.purpose = 'work'`;
      break;
    default:
      throw new DomainError("invalid_argument", "task collection is invalid");
  }
  return {
    parentSql: `SELECT collection_parent.workspace_id, collection_parent.id, collection_parent.project_id
      FROM tasks AS collection_parent WHERE collection_parent.id = ?
        AND collection_parent.project_id IN (SELECT value FROM json_each(?) WHERE type = 'text')
        AND ${parent.sql}`,
    parentParameters: [taskId, JSON.stringify(principal.projectIds), ...parent.parameters],
    rowsSql: selection,
    parameters,
    columns,
    identity,
    order,
    ceilingSql: `SELECT COALESCE(MAX(child.rowid),0) FROM ${table} AS child
      JOIN readable_parent AS parent ON parent.workspace_id=child.workspace_id AND parent.id=child.task_id
        ${exactProject} ${purpose}`,
  };
}

/** Internal raw anchors remain distinct from browser position handles. */
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
  const source = humanTaskCollectionSource(principal, taskId, collection);
  const paged = collection !== "context" && collection !== "agent_context";
  const parameters = [...source.parentParameters, ...source.parameters];
  if (paged) parameters.push(...(options.cursor ? [options.cursor] : []), limit + 1);

  const rows = (await db
    .prepare(
      `WITH readable_parent AS MATERIALIZED (
         ${source.parentSql}
       ), source_rows AS (${source.rowsSql}), page AS MATERIALIZED (
         SELECT * FROM source_rows ${paged && options.cursor ? "WHERE collection_anchor_id > ?" : ""}
         ORDER BY ${source.order} ${paged ? "LIMIT ?" : ""}
       )
       SELECT EXISTS(SELECT 1 FROM readable_parent) AS parent_authorized, page.*
       FROM (SELECT 1) LEFT JOIN page ON 1 ORDER BY ${source.order}`,
    )
    .all(...parameters)) as Row[];
  if (rows[0]?.parent_authorized !== 1) return null;
  return rows
    .filter((row) => row[source.identity] !== null)
    .map(
      ({
        parent_authorized: _sentinel,
        collection_anchor_id: _anchor,
        collection_anchor_rowid: _rowid,
        ...row
      }) => row,
    );
}
