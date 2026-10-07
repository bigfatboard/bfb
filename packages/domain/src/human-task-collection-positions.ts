// ABOUTME: Issues hashed recipient-bound browser task collection positions through the workspace command lane.
// ABOUTME: Repeats canonical page authority and fixed capture cuts before committing and returning continuations.

import { createHash, randomBytes } from "node:crypto";
import type { SqlDatabase } from "@bfb/db";

import type { AuthzPrincipal } from "./authorization.js";
import { DomainError, type HubCommand, type HubContext } from "./hub.js";
import { humanTaskCollectionSource } from "./human-task-collections.js";
import { isUlid, randomUlid } from "./ids.js";

export type PagedHumanTaskCollection = "comments" | "dependencies" | "links" | "runs";
const collections: readonly PagedHumanTaskCollection[] = [
  "comments",
  "dependencies",
  "links",
  "runs",
];

export interface IssueHumanTaskCollectionPositionInput {
  positionHash: string;
  afterHash: string | null;
  taskId: string;
  collection: PagedHumanTaskCollection;
  limit: number;
  capturedProjectIds: string[];
}
export type IssueHumanTaskCollectionPosition = (
  input: IssueHumanTaskCollectionPositionInput,
) => Promise<void>;

export function createHumanTaskCollectionPosition(): string {
  return randomBytes(32).toString("base64url");
}
export function isHumanTaskCollectionPosition(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 43 || !/^[A-Za-z0-9_-]+$/.test(value))
    return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === value;
}
export function hashHumanTaskCollectionPosition(handle: string): string {
  if (!isHumanTaskCollectionPosition(handle))
    throw new TypeError("invalid task collection position");
  return createHash("sha256")
    .update("bfb/task-collection-position/v1\0")
    .update(handle)
    .digest("hex");
}

interface SelectedRow {
  anchor_id: string;
  anchor_rowid: number;
  row: Record<string, unknown>;
}
interface CollectionSelection {
  parent_authorized: number;
  project_id: string | null;
  audience_json: string;
  audience_valid: number;
  position_valid: number;
  anchor_valid: number;
  issued_valid: number;
  capture_ceiling: number;
  expires_at: string;
  database_now: string;
  issued_anchor_id: string | null;
  issued_anchor_rowid: number | null;
  rows_json: string;
}

function unknownCursor(): never {
  throw new DomainError("invalid_argument", "unknown task collection cursor");
}
function unavailable(): never {
  throw new DomainError("request_rejected", "task collection positions are unavailable");
}
function exactUlid(value: unknown): value is string {
  return typeof value === "string" && value.length === 26 && isUlid(value);
}
function validPage(collection: PagedHumanTaskCollection, limit: number): void {
  if (!collections.includes(collection) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new DomainError("invalid_argument", "task collection pagination is invalid");
}
function assertSelection(selection: CollectionSelection): boolean {
  // Denied parents remain indistinguishable from absent parents, even with malformed cursors.
  if (selection.parent_authorized !== 1) return false;
  if (selection.audience_valid !== 1) unavailable();
  if (
    selection.position_valid !== 1 ||
    selection.anchor_valid !== 1 ||
    selection.issued_valid !== 1
  )
    unknownCursor();
  return true;
}
function assertFresh(selection: CollectionSelection): void {
  if (
    !Number.isFinite(Date.parse(selection.expires_at)) ||
    Date.parse(selection.expires_at) <= Date.now()
  )
    unknownCursor();
}

/** One statement owns the sentinel, exact current audience, readable anchor and complete visible page. */
function collectionSelection(
  principal: AuthzPrincipal,
  taskId: string,
  collection: PagedHumanTaskCollection,
  options: {
    limit: number;
    afterHash: string | null;
    issuedHash?: string;
    captureCeiling?: number;
    expiresAt?: string;
  },
) {
  const source = humanTaskCollectionSource(principal, taskId, collection);
  const tuple = (alias: string) => `${alias}.workspace_id=request.workspace_id
    AND ${alias}.human_id=request.human_id AND ${alias}.authorization_epoch=request.authorization_epoch
    AND ${alias}.projection_version=1 AND ${alias}.page_limit=request.page_limit
    AND ${alias}.task_id=parent.id AND ${alias}.project_id=parent.project_id
    AND ${alias}.collection=request.collection AND ${alias}.audience_json=audience.audience_json`;
  const rowJson = source.columns.map((column) => `'${column}',page.${column}`).join(",");
  return {
    parameters: [
      principal.workspaceId,
      principal.humanId,
      principal.authorizationEpoch,
      collection,
      options.limit,
      options.afterHash,
      options.issuedHash ?? null,
      options.captureCeiling ?? null,
      options.expiresAt ?? null,
      ...source.parentParameters,
      ...source.parameters,
    ],
    sql: `SELECT * FROM (WITH request AS MATERIALIZED (
      SELECT ? AS workspace_id, ? AS human_id, ? AS authorization_epoch, ? AS collection,
        ? AS page_limit, ? AS after_hash, ? AS issued_hash, ? AS capture_ceiling, ? AS expires_at
    ), readable_parent AS MATERIALIZED (${source.parentSql}),
    clock AS MATERIALIZED (
      SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS database_now,
        strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes') AS root_expiry
    ), current_projects AS MATERIALIZED (
      SELECT project.id FROM projects AS project JOIN request ON project.workspace_id=request.workspace_id
      WHERE project.access_mode='workspace' OR EXISTS (
        SELECT 1 FROM project_access AS access WHERE access.workspace_id=project.workspace_id
          AND access.project_id=project.id AND access.human_id=request.human_id
      ) ORDER BY project.id
    ), audience AS MATERIALIZED (
      SELECT json_group_array(id) AS audience_json FROM (SELECT id FROM current_projects ORDER BY id)
    ), supplied_position AS MATERIALIZED (
      SELECT position.* FROM task_collection_positions AS position JOIN request
        ON position.workspace_id=request.workspace_id AND position.position_hash=request.after_hash
    ), issued_position AS MATERIALIZED (
      SELECT position.* FROM task_collection_positions AS position JOIN request
        ON position.workspace_id=request.workspace_id AND position.position_hash=request.issued_hash
    ), source_rows AS MATERIALIZED (${source.rowsSql}),
    boundary AS MATERIALIZED (
      SELECT COALESCE(request.capture_ceiling,
        CASE WHEN request.issued_hash IS NOT NULL THEN (SELECT capture_ceiling FROM issued_position)
          WHEN request.after_hash IS NOT NULL THEN (SELECT capture_ceiling FROM supplied_position)
          ELSE (${source.ceilingSql}) END) AS capture_ceiling,
        COALESCE(request.expires_at,
        CASE WHEN request.issued_hash IS NOT NULL THEN (SELECT expires_at FROM issued_position)
          WHEN request.after_hash IS NOT NULL THEN (SELECT expires_at FROM supplied_position)
          ELSE clock.root_expiry END) AS expires_at
      FROM request CROSS JOIN clock
    ), page AS MATERIALIZED (
      SELECT source_rows.* FROM source_rows CROSS JOIN boundary CROSS JOIN request
      WHERE source_rows.collection_anchor_rowid<=boundary.capture_ceiling
        AND (request.after_hash IS NULL OR source_rows.collection_anchor_id>(SELECT anchor_id FROM supplied_position))
      ORDER BY source_rows.collection_anchor_id ASC LIMIT (SELECT page_limit+1 FROM request)
    )
    SELECT EXISTS(SELECT 1 FROM readable_parent) AS parent_authorized,
      (SELECT project_id FROM readable_parent) AS project_id, audience.audience_json,
      length(CAST(audience.audience_json AS BLOB))<=32768 AS audience_valid,
      (boundary.expires_at>clock.database_now AND (request.after_hash IS NULL OR EXISTS (
        SELECT 1 FROM supplied_position AS position CROSS JOIN readable_parent AS parent
        WHERE ${tuple("position")} AND position.capture_ceiling=boundary.capture_ceiling
          AND position.expires_at=boundary.expires_at
      ))) AS position_valid,
      (request.after_hash IS NULL OR EXISTS (
        SELECT 1 FROM source_rows JOIN supplied_position AS position
          ON source_rows.collection_anchor_id=position.anchor_id AND source_rows.collection_anchor_rowid=position.anchor_rowid
        WHERE source_rows.collection_anchor_rowid<=boundary.capture_ceiling
      )) AS anchor_valid,
      (request.issued_hash IS NULL OR EXISTS (
        SELECT 1 FROM issued_position AS position CROSS JOIN readable_parent AS parent
        WHERE ${tuple("position")} AND position.after_hash IS request.after_hash
          AND position.capture_ceiling=boundary.capture_ceiling AND position.expires_at=boundary.expires_at
      )) AS issued_valid,
      boundary.capture_ceiling, boundary.expires_at, clock.database_now,
      (SELECT anchor_id FROM issued_position) AS issued_anchor_id,
      (SELECT anchor_rowid FROM issued_position) AS issued_anchor_rowid,
      (SELECT json_group_array(json_object('anchor_id',page.collection_anchor_id,
        'anchor_rowid',page.collection_anchor_rowid,'row',json_object(${rowJson})))
        FROM (SELECT * FROM page ORDER BY collection_anchor_id ASC) AS page) AS rows_json
    FROM request CROSS JOIN clock CROSS JOIN audience CROSS JOIN boundary)`,
  };
}

/** Plaintext handles exist only outside the Hub and follow a final canonical delivered-cut check. */
export async function readHumanTaskCollectionPage(
  db: SqlDatabase,
  principal: AuthzPrincipal,
  taskId: string,
  collection: PagedHumanTaskCollection,
  options: { limit?: number; cursor?: string } = {},
  issue?: IssueHumanTaskCollectionPosition,
): Promise<{
  rows: Record<string, unknown>[];
  limit: number;
  has_more: boolean;
  next_cursor: string | null;
} | null> {
  if (!exactUlid(taskId)) return null;
  const limit = options.limit ?? 50;
  validPage(collection, limit);
  const afterHash =
    options.cursor === undefined
      ? null
      : isHumanTaskCollectionPosition(options.cursor)
        ? hashHumanTaskCollectionPosition(options.cursor)
        : "invalid";
  const selection = collectionSelection(principal, taskId, collection, { limit, afterHash });
  let current = (await db
    .prepare(selection.sql)
    .get(...selection.parameters)) as CollectionSelection;
  if (!assertSelection(current)) return null;
  let rows = JSON.parse(current.rows_json) as SelectedRow[];
  if (rows.length <= limit) {
    if (afterHash !== null) assertFresh(current);
    return { rows: rows.map((entry) => entry.row), limit, has_more: false, next_cursor: null };
  }
  if (!issue) unavailable();
  const handle = createHumanTaskCollectionPosition();
  const positionHash = hashHumanTaskCollectionPosition(handle);
  let issueFailed = false;
  let issueError: unknown;
  try {
    await issue({
      positionHash,
      afterHash,
      taskId,
      collection,
      limit,
      capturedProjectIds: [...principal.projectIds],
    });
  } catch (error) {
    issueFailed = true;
    issueError = error;
  }
  const final = collectionSelection(principal, taskId, collection, {
    limit,
    afterHash,
    issuedHash: positionHash,
  });
  current = (await db.prepare(final.sql).get(...final.parameters)) as CollectionSelection;
  // A failed issuance can still coincide with parent loss; preserve the uniform missing-parent response.
  if (current.parent_authorized !== 1) return null;
  if (issueFailed) throw issueError;
  if (!assertSelection(current)) return null;
  rows = JSON.parse(current.rows_json) as SelectedRow[];
  const cut = rows[limit - 1];
  if (
    !cut ||
    cut.anchor_id !== current.issued_anchor_id ||
    cut.anchor_rowid !== current.issued_anchor_rowid
  )
    unknownCursor();
  assertFresh(current);
  return {
    rows: rows.slice(0, limit).map((entry) => entry.row),
    limit,
    has_more: rows.length > limit,
    next_cursor: rows.length > limit ? handle : null,
  };
}

function positionPrincipal(
  input: IssueHumanTaskCollectionPositionInput,
  ctx: HubContext,
): AuthzPrincipal {
  if (!ctx.actorHumanId || ctx.actorRunnerId || ctx.actorSystemId || ctx.actorDelegationId)
    throw new DomainError("not_found", "task not found");
  const validHash = (value: unknown) =>
    typeof value === "string" && value.length === 64 && /^[0-9a-f]+$/.test(value);
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== 6 ||
    Object.keys(input).some(
      (key) =>
        ![
          "positionHash",
          "afterHash",
          "taskId",
          "collection",
          "limit",
          "capturedProjectIds",
        ].includes(key),
    ) ||
    !validHash(input.positionHash) ||
    !(input.afterHash === null || validHash(input.afterHash)) ||
    !exactUlid(input.taskId) ||
    !Array.isArray(input.capturedProjectIds) ||
    input.capturedProjectIds.some((id) => !exactUlid(id))
  )
    throw new DomainError("invalid_argument", "invalid task collection position request");
  validPage(input.collection, input.limit);
  if (Buffer.byteLength(JSON.stringify(input.capturedProjectIds), "utf8") > 32768) unavailable();
  // Role permission is checked canonically by the read kernel, not inferred from this captured vector.
  return {
    workspaceId: ctx.workspaceId,
    humanId: ctx.actorHumanId,
    authorizationEpoch: ctx.authorizationEpoch,
    role: "reviewer",
    projectIds: [...input.capturedProjectIds],
  };
}

export const issueHumanTaskCollectionPositionCommand: HubCommand<
  IssueHumanTaskCollectionPositionInput,
  { issued: true }
> = {
  name: "task.collection_position.issue",
  replay: "reject",
  async authorize(input, ctx) {
    const principal = positionPrincipal(input, ctx);
    const source = humanTaskCollectionSource(principal, input.taskId, input.collection);
    if (!(await ctx.db.prepare(source.parentSql).get(...source.parentParameters)))
      throw new DomainError("not_found", "task not found");
  },
  inputFingerprint: (input) => createHash("sha256").update(JSON.stringify(input)).digest("hex"),
  auditInput: () => ({}),
  auditResult: () => ({ issued: true }),
  async run(input, ctx) {
    const principal = positionPrincipal(input, ctx);
    const selection = collectionSelection(principal, input.taskId, input.collection, {
      limit: input.limit,
      afterHash: input.afterHash,
    });
    const current = (await ctx.db
      .prepare(selection.sql)
      .get(...selection.parameters)) as CollectionSelection;
    if (!assertSelection(current)) throw new DomainError("not_found", "task not found");
    const rows = JSON.parse(current.rows_json) as SelectedRow[];
    if (rows.length <= input.limit) unavailable();
    const cut = rows[input.limit - 1]!;
    const guard = collectionSelection(principal, input.taskId, input.collection, {
      limit: input.limit,
      afterHash: input.afterHash,
      captureCeiling: current.capture_ceiling,
      expiresAt: current.expires_at,
    });
    const guardId = randomUlid();
    // All source reads finish before writes; D1 evaluates the complete selection again inside the atomic batch.
    await ctx.db
      .prepare(
        `INSERT INTO task_collection_position_guards(workspace_id,id,valid)
      SELECT ?, ?, (selection.parent_authorized AND selection.audience_valid AND selection.position_valid
        AND selection.anchor_valid AND selection.issued_valid AND selection.audience_json=?
        AND selection.project_id=? AND selection.capture_ceiling=? AND selection.expires_at=? AND selection.rows_json=?)
      FROM (${guard.sql}) AS selection`,
      )
      .run(
        ctx.workspaceId,
        guardId,
        current.audience_json,
        current.project_id,
        current.capture_ceiling,
        current.expires_at,
        current.rows_json,
        ...guard.parameters,
      );
    await ctx.db
      .prepare(
        `INSERT INTO task_collection_positions
      (position_hash,workspace_id,human_id,authorization_epoch,projection_version,page_limit,audience_json,after_hash,
        task_id,project_id,collection,capture_ceiling,expires_at,anchor_id,anchor_rowid,created_at)
      VALUES (?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.positionHash,
        ctx.workspaceId,
        principal.humanId,
        principal.authorizationEpoch,
        input.limit,
        current.audience_json,
        input.afterHash,
        input.taskId,
        current.project_id,
        input.collection,
        current.capture_ceiling,
        current.expires_at,
        cut.anchor_id,
        cut.anchor_rowid,
        current.database_now,
      );
    await ctx.db
      .prepare("DELETE FROM task_collection_position_guards WHERE workspace_id=? AND id=?")
      .run(ctx.workspaceId, guardId);
    return { issued: true };
  },
};
