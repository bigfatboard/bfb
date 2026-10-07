// ABOUTME: Selects human CLI records and credential authority together from canonical persistence.
// ABOUTME: Empty pages and multi-source artifact details retain the original binding and project ceilings.

import type { SqlDatabase } from "@bfb/db";

import { rowToRecord, rankReason, type AttentionState } from "./attention.js";
import type { CliPrincipal } from "./cli-credentials.js";
import { DomainError } from "./hub.js";
import {
  publicMemberAuthorityPredicate,
  publicProjectRowAuthorityPredicate,
  publicTaskRowAuthorityPredicate,
  type PublicAuthoritySql,
  type PublicBusinessAuthority,
} from "./public-business.js";

export function cliPublicAuthority(principal: CliPrincipal): PublicBusinessAuthority {
  return {
    humanId: principal.humanId,
    workspaceId: principal.workspaceId,
    role: principal.role,
    authorizationEpoch: principal.authorizationEpoch,
    projectIds: [...principal.projectIds],
    credential: { kind: "cli", bindingId: principal.bindingId, scopes: [...principal.scopes] },
  };
}

function denied(): never {
  throw new DomainError("not_found", "resource not available");
}

function authorityPredicate(authority: PublicBusinessAuthority): PublicAuthoritySql {
  const project = publicProjectRowAuthorityPredicate(
    authority,
    "cli_project",
    ["owner", "member"],
    "bfb:read",
  );
  return {
    sql: `EXISTS (SELECT 1 FROM projects AS cli_project WHERE ${project.sql})`,
    parameters: project.parameters,
  };
}

interface PageOptions {
  limit?: number;
  cursor?: string;
  state?: AttentionState;
}
type Row = Record<string, unknown>;

async function pageRows(
  db: SqlDatabase,
  authority: PublicBusinessAuthority,
  pageSql: PublicAuthoritySql,
  order: string,
): Promise<Row[]> {
  const predicate = authorityPredicate(authority);
  const rows = (await db
    .prepare(
      `WITH authority AS (SELECT 1 WHERE ${predicate.sql}),
    page AS (${pageSql.sql}) SELECT EXISTS(SELECT 1 FROM authority) AS authority_ok, page.*
    FROM (SELECT 1) LEFT JOIN page ON EXISTS(SELECT 1 FROM authority) ${order}`,
    )
    .all(...predicate.parameters, ...pageSql.parameters)) as Row[];
  if (rows[0]?.authority_ok !== 1) denied();
  return rows.filter((row) => row.id !== null).map(({ authority_ok: _sentinel, ...row }) => row);
}

const projectColumns = `project.id, project.name, project.slug, project.tint, project.access_mode,
  project.repository_host, project.hosted_repository_id, project.repository_subpath, project.resource_version`;
const runColumns = `run.id, run.project_id, run.task_id, run.requested_by_human_id, run.agent_profile_id,
  run.result_state, run.activity, run.resource_version, run.created_at`;
const artifactColumns = `artifact.id, artifact.run_id, artifact.format, artifact.role, artifact.created_at`;
const versionColumns = `version.id, version.artifact_id, version.state, version.format, version.declared_size,
  version.content_hash, version.created_at, version.available_at`;

function taskSelection(authority: PublicBusinessAuthority) {
  const parent = publicTaskRowAuthorityPredicate(
    authority,
    "read",
    "parent",
    ["owner", "member"],
    "bfb:read",
  );
  return {
    sql: `task.id,task.project_id,CASE WHEN EXISTS (SELECT 1 FROM tasks AS parent
      WHERE parent.workspace_id = task.workspace_id AND parent.id = task.parent_task_id AND ${parent.sql})
      THEN task.parent_task_id ELSE NULL END AS parent_task_id,
      task.title,task.state,task.priority,task.due_at,task.next_owner_type,
      task.next_owner_id,task.next_action_reason,task.punchline,task.resource_version`,
    parameters: parent.parameters,
  };
}

function paged(rows: Row[], limit: number, field: "projects" | "tasks" | "runs") {
  const more = rows.length > limit,
    items = more ? rows.slice(0, limit) : rows;
  if (field === "projects")
    return {
      projects: items,
      hasMore: more,
      ...(more ? { nextCursor: items.at(-1)!.id } : {}),
    };
  return {
    [field]: items,
    limit,
    has_more: more,
    ...(more ? { next_cursor: items.at(-1)!.id } : {}),
  };
}

export async function readCliProjects(
  db: SqlDatabase,
  authority: PublicBusinessAuthority,
  options: PageOptions = {},
) {
  const predicate = publicProjectRowAuthorityPredicate(
    authority,
    "project",
    ["owner", "member"],
    "bfb:read",
  );
  const limit = options.limit ?? 50;
  const rows = await pageRows(
    db,
    authority,
    {
      sql: `SELECT ${projectColumns} FROM projects AS project WHERE ${predicate.sql}
      ${options.cursor ? "AND project.id > ?" : ""} ORDER BY project.id ASC LIMIT ?`,
      parameters: [...predicate.parameters, ...(options.cursor ? [options.cursor] : []), limit + 1],
    },
    "ORDER BY page.id ASC",
  );
  return paged(rows, limit, "projects");
}

export async function readCliProject(
  db: SqlDatabase,
  authority: PublicBusinessAuthority,
  id: string,
) {
  const predicate = publicProjectRowAuthorityPredicate(
    authority,
    "project",
    ["owner", "member"],
    "bfb:read",
  );
  const project = await db
    .prepare(
      `SELECT ${projectColumns} FROM projects AS project
    WHERE project.id = ? AND ${predicate.sql}`,
    )
    .get(id, ...predicate.parameters);
  if (!project) denied();
  return { project };
}

export async function readCliTasks(
  db: SqlDatabase,
  authority: PublicBusinessAuthority,
  options: PageOptions = {},
) {
  const predicate = publicTaskRowAuthorityPredicate(
    authority,
    "read",
    "task",
    ["owner", "member"],
    "bfb:read",
  );
  const projection = taskSelection(authority),
    limit = options.limit ?? 50;
  const rows = await pageRows(
    db,
    authority,
    {
      sql: `SELECT ${projection.sql} FROM tasks AS task WHERE ${predicate.sql}
      ${options.cursor ? "AND task.id > ?" : ""} ORDER BY task.id ASC LIMIT ?`,
      parameters: [
        ...projection.parameters,
        ...predicate.parameters,
        ...(options.cursor ? [options.cursor] : []),
        limit + 1,
      ],
    },
    "ORDER BY page.id ASC",
  );
  return paged(rows, limit, "tasks");
}

export async function readCliTask(db: SqlDatabase, authority: PublicBusinessAuthority, id: string) {
  const predicate = publicTaskRowAuthorityPredicate(
    authority,
    "read",
    "task",
    ["owner", "member"],
    "bfb:read",
  );
  const projection = taskSelection(authority);
  const task = await db
    .prepare(`SELECT ${projection.sql} FROM tasks AS task WHERE task.id = ? AND ${predicate.sql}`)
    .get(...projection.parameters, id, ...predicate.parameters);
  if (!task) denied();
  return { task };
}

export async function readCliRuns(
  db: SqlDatabase,
  authority: PublicBusinessAuthority,
  taskId: string,
  options: PageOptions = {},
) {
  const predicate = publicTaskRowAuthorityPredicate(
    authority,
    "read",
    "task",
    ["owner", "member"],
    "bfb:read",
  );
  const limit = options.limit ?? 50;
  const rows = (await db
    .prepare(
      `WITH parent AS (SELECT task.id,task.project_id FROM tasks AS task
    WHERE task.id = ? AND ${predicate.sql}), page AS (
      SELECT ${runColumns} FROM runs AS run JOIN parent ON parent.id = run.task_id AND parent.project_id = run.project_id
      WHERE run.workspace_id = ? AND run.purpose = 'work' ${options.cursor ? "AND run.id > ?" : ""}
      ORDER BY run.id ASC LIMIT ?)
    SELECT EXISTS(SELECT 1 FROM parent) AS authority_ok,page.* FROM (SELECT 1) LEFT JOIN page ON 1 ORDER BY page.id ASC`,
    )
    .all(
      taskId,
      ...predicate.parameters,
      authority.workspaceId,
      ...(options.cursor ? [options.cursor] : []),
      limit + 1,
    )) as Row[];
  if (rows[0]?.authority_ok !== 1) denied();
  return paged(
    rows.filter((row) => row.id !== null).map(({ authority_ok: _sentinel, ...row }) => row),
    limit,
    "runs",
  );
}

export async function readCliRun(db: SqlDatabase, authority: PublicBusinessAuthority, id: string) {
  const predicate = publicTaskRowAuthorityPredicate(
    authority,
    "read",
    "task",
    ["owner", "member"],
    "bfb:read",
  );
  const run = await db
    .prepare(
      `SELECT ${runColumns} FROM runs AS run JOIN tasks AS task
    ON task.workspace_id = run.workspace_id AND task.id = run.task_id AND task.project_id = run.project_id
    WHERE run.workspace_id = ? AND run.id = ? AND run.purpose = 'work' AND ${predicate.sql}`,
    )
    .get(authority.workspaceId, id, ...predicate.parameters);
  if (!run) denied();
  return { run: run as Row };
}

export async function readCliAttention(
  db: SqlDatabase,
  authority: PublicBusinessAuthority,
  options: PageOptions = {},
) {
  const predicate = publicTaskRowAuthorityPredicate(
    authority,
    "read",
    "task",
    ["owner", "member"],
    "bfb:read",
  );
  const rows = await pageRows(
    db,
    authority,
    {
      sql: `SELECT attention.*,task.title AS task_title,project.name AS project_name,
      run.result_state AS run_result_state,run.activity AS run_activity,
      CASE attention.kind WHEN 'blocker' THEN 0 WHEN 'destructive_action' THEN 1 WHEN 'credential' THEN 2
        WHEN 'capability' THEN 3 WHEN 'review' THEN 4 ELSE 5 END AS kind_rank
      FROM attention_requests AS attention
      JOIN tasks AS task ON task.workspace_id = attention.workspace_id AND task.id = attention.task_id AND task.project_id = attention.project_id
      JOIN runs AS run ON run.workspace_id = attention.workspace_id AND run.id = attention.run_id AND run.task_id = task.id AND run.project_id = task.project_id
      JOIN projects AS project ON project.workspace_id = task.workspace_id AND project.id = task.project_id
      WHERE ${predicate.sql} ${options.state === undefined ? "" : "AND attention.state = ?"}
      ORDER BY attention.blocking DESC,kind_rank ASC,attention.requested_at ASC,attention.id ASC LIMIT ?`,
      parameters: [
        ...predicate.parameters,
        ...(options.state === undefined ? [] : [options.state]),
        options.limit ?? 50,
      ],
    },
    "ORDER BY page.blocking DESC,page.kind_rank ASC,page.requested_at ASC,page.id ASC",
  );
  return {
    attention: rows.map((row) => {
      const record = rowToRecord(row);
      return {
        ...record,
        task_title: String(row.task_title),
        project_name: String(row.project_name),
        run_result_state: String(row.run_result_state),
        run_activity: String(row.run_activity),
        rank_reason: rankReason(record),
      };
    }),
  };
}

export async function readCliAttentionDetail(
  db: SqlDatabase,
  authority: PublicBusinessAuthority,
  id: string,
) {
  const predicate = publicTaskRowAuthorityPredicate(
    authority,
    "read",
    "task",
    ["owner", "member"],
    "bfb:read",
  );
  const rows = (await db
    .prepare(
      `SELECT attention.*,observation.observation_id,
    observation.attention_id AS observation_attention_id,observation.observed_kind,observation.actor_type,
    observation.actor_id,observation.occurred_at
    FROM attention_requests AS attention JOIN tasks AS task
      ON task.workspace_id = attention.workspace_id AND task.id = attention.task_id AND task.project_id = attention.project_id
    JOIN runs AS run ON run.workspace_id = attention.workspace_id AND run.id = attention.run_id AND run.task_id = task.id AND run.project_id = task.project_id
    LEFT JOIN attention_observations AS observation ON observation.workspace_id = attention.workspace_id AND observation.attention_id = attention.id
    WHERE attention.id = ? AND ${predicate.sql} ORDER BY observation.occurred_at ASC,observation.rowid ASC`,
    )
    .all(id, ...predicate.parameters)) as Row[];
  if (!rows[0]) denied();
  return {
    attention: rowToRecord(rows[0]),
    observations: rows.flatMap((row) =>
      row.observation_id === null
        ? []
        : [
            {
              observation_id: row.observation_id,
              attention_id: row.observation_attention_id,
              observed_kind: row.observed_kind,
              actor_type: row.actor_type,
              actor_id: row.actor_id,
              occurred_at: row.occurred_at,
            },
          ],
    ),
  };
}

function jsonColumns(columns: string) {
  return `json_object(${columns
    .split(",")
    .flatMap((field) => {
      const key = field.trim().split(".").at(-1)!;
      return [`'${key}'`, field.trim()];
    })
    .join(",")})`;
}

/** Both arrays are selected in one statement from the same authorized canonical run. */
export async function readCliArtifacts(
  db: SqlDatabase,
  authority: PublicBusinessAuthority,
  runId: string,
) {
  const predicate = publicTaskRowAuthorityPredicate(
    authority,
    "read",
    "task",
    ["owner", "member"],
    "bfb:read",
  );
  const row = (await db
    .prepare(
      `SELECT
    (SELECT json_group_array(json(artifact_json)) FROM (
      SELECT ${jsonColumns(artifactColumns)} AS artifact_json FROM artifacts AS artifact
      WHERE artifact.workspace_id = run.workspace_id AND artifact.run_id = run.id
      ORDER BY artifact.created_at DESC,artifact.id DESC LIMIT 50)) AS artifacts_json,
    (SELECT json_group_array(json(version_json)) FROM (
      SELECT ${jsonColumns(versionColumns)} AS version_json FROM artifact_versions AS version
      JOIN artifacts AS artifact ON artifact.workspace_id = version.workspace_id AND artifact.id = version.artifact_id
      WHERE artifact.workspace_id = run.workspace_id AND artifact.run_id = run.id
      ORDER BY version.created_at DESC,version.id DESC LIMIT 100)) AS versions_json
    FROM runs AS run JOIN tasks AS task ON task.workspace_id = run.workspace_id AND task.id = run.task_id AND task.project_id = run.project_id
    WHERE run.workspace_id = ? AND run.id = ? AND ${predicate.sql}`,
    )
    .get(authority.workspaceId, runId, ...predicate.parameters)) as
    { artifacts_json: string; versions_json: string } | undefined;
  if (!row) denied();
  return { artifacts: JSON.parse(row.artifacts_json), versions: JSON.parse(row.versions_json) };
}

export async function readCliArtifact(
  db: SqlDatabase,
  authority: PublicBusinessAuthority,
  id: string,
) {
  const predicate = publicTaskRowAuthorityPredicate(
    authority,
    "read",
    "task",
    ["owner", "member"],
    "bfb:read",
  );
  const row = (await db
    .prepare(
      `SELECT ${artifactColumns},
    (SELECT json_group_array(json(version_json)) FROM (
      SELECT ${jsonColumns(versionColumns)} AS version_json FROM artifact_versions AS version
      WHERE version.workspace_id = artifact.workspace_id AND version.artifact_id = artifact.id
      ORDER BY version.created_at DESC,version.id DESC)) AS versions_json
    FROM artifacts AS artifact JOIN runs AS run ON run.workspace_id = artifact.workspace_id AND run.id = artifact.run_id
    JOIN tasks AS task ON task.workspace_id = run.workspace_id AND task.id = run.task_id AND task.project_id = run.project_id
    WHERE artifact.workspace_id = ? AND artifact.id = ? AND ${predicate.sql}`,
    )
    .get(authority.workspaceId, id, ...predicate.parameters)) as Row | undefined;
  if (!row) denied();
  const { versions_json, ...artifact } = row;
  return { artifact, versions: JSON.parse(String(versions_json)) };
}

/** Session metadata is binding/project scoped, without a fabricated task ACL. */
export async function readCliSession(db: SqlDatabase, principal: CliPrincipal) {
  const authority = cliPublicAuthority(principal),
    member = publicMemberAuthorityPredicate(authority, ["owner", "member"], "bfb:read");
  const project = publicProjectRowAuthorityPredicate(
    authority,
    "project",
    ["owner", "member"],
    "bfb:read",
  );
  const row = (await db
    .prepare(
      `SELECT binding.id,binding.key_prefix,binding.scopes_json,binding.expires_at,
    (SELECT json_group_array(id) FROM (SELECT project.id FROM projects AS project WHERE ${project.sql} ORDER BY project.id)) AS project_ids_json
    FROM api_key_bindings AS binding WHERE binding.workspace_id = ? AND binding.id = ? AND ${member.sql}`,
    )
    .get(
      ...project.parameters,
      principal.workspaceId,
      principal.bindingId,
      ...member.parameters,
    )) as Row | undefined;
  if (!row) denied();
  const projectIds = JSON.parse(String(row.project_ids_json)) as string[];
  if (projectIds.length === 0) denied();
  return {
    human_id: principal.humanId,
    workspace_id: principal.workspaceId,
    binding_id: row.id,
    key_prefix: row.key_prefix,
    scopes: JSON.parse(String(row.scopes_json)),
    project_ids: projectIds,
    authorization_epoch: principal.authorizationEpoch,
    expires_at: row.expires_at,
  };
}
