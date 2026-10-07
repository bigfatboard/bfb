// ABOUTME: Implements creator-only sharing reads and immutable named-human grant lifecycle commands.
// ABOUTME: Rechecks retained creator and recipient authority before replies and inside atomic Hub batches.

import { createHash } from "node:crypto";
import type { SqlDatabase } from "@bfb/db";
import { DomainError, type HubCommand, type HubContext } from "./hub.js";
import { isUlid, randomUlid } from "./ids.js";
import { taskAccessPredicate, type TaskAccessContext } from "./task-access.js";

export type TaskSharingPermission = "read" | "contribute" | "edit";
export interface TaskSharingGrant {
  id: string;
  human_id: string;
  authorization_epoch: number;
  permission: TaskSharingPermission;
  created_at: string;
}
export interface TaskSharingView {
  task_id: string;
  access_version: number;
  grants: TaskSharingGrant[];
  has_more: boolean;
}
export interface TaskSharingReceipt {
  task_id: string;
  grant_id: string;
  access_version: number;
}
export interface GrantTaskSharingInput {
  taskId: string;
  humanId: string;
  permission: TaskSharingPermission;
  expectedAccessVersion: number;
}
export interface RevokeTaskSharingInput {
  taskId: string;
  grantId: string;
  expectedAccessVersion: number;
}

function unavailable(): never {
  throw new DomainError("not_found", "task sharing not found");
}
function validId(value: unknown): value is string {
  return typeof value === "string" && value.length === 26 && isUlid(value);
}
function checkedInput<T>(input: T, fields: string[]): T {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== fields.length ||
    Object.keys(input).some((key) => !fields.includes(key))
  )
    throw new DomainError("invalid_argument", "invalid sharing input");
  const value = input as Record<string, unknown>;
  if (
    !validId(value.taskId) ||
    !Number.isSafeInteger(value.expectedAccessVersion) ||
    (value.expectedAccessVersion as number) < 1 ||
    (value.expectedAccessVersion as number) >= Number.MAX_SAFE_INTEGER
  )
    throw new DomainError("invalid_argument", "invalid sharing input");
  if (
    fields.includes("humanId") &&
    (!validId(value.humanId) ||
      !["read", "contribute", "edit"].includes(value.permission as string))
  )
    throw new DomainError("invalid_argument", "invalid sharing input");
  if (fields.includes("grantId") && !validId(value.grantId))
    throw new DomainError("invalid_argument", "invalid sharing input");
  return input;
}
const grantInput = (input: GrantTaskSharingInput) =>
  checkedInput(input, ["taskId", "humanId", "permission", "expectedAccessVersion"]);
const revokeInput = (input: RevokeTaskSharingInput) =>
  checkedInput(input, ["taskId", "grantId", "expectedAccessVersion"]);

function directAccess(ctx: HubContext): TaskAccessContext {
  if (
    !validId(ctx.actorHumanId) ||
    ctx.actorDelegationId !== undefined ||
    ctx.actorRunnerId !== undefined ||
    ctx.actorSystemId !== undefined
  )
    throw new DomainError("forbidden", "direct human sharing authority is required");
  return {
    workspaceId: ctx.workspaceId,
    humanId: ctx.actorHumanId,
    authorizationEpoch: ctx.authorizationEpoch,
  };
}
function creatorSelection(access: TaskAccessContext, taskId: string) {
  if (!validId(taskId)) throw new DomainError("invalid_argument", "invalid sharing task");
  const predicate = taskAccessPredicate(access, "manage_sharing");
  return {
    sql: `SELECT task.workspace_id, task.id, task.project_id, policy.access_version
      FROM tasks AS task JOIN task_privacy AS policy
        ON policy.workspace_id = task.workspace_id AND policy.task_id = task.id
      WHERE task.id = ? AND ${predicate.sql}`,
    parameters: [taskId, ...predicate.parameters],
  };
}
async function creator(db: SqlDatabase, access: TaskAccessContext, taskId: string) {
  const selection = creatorSelection(access, taskId);
  const row = (await db.prepare(selection.sql).get(...selection.parameters)) as
    { access_version: number; project_id: string } | undefined;
  if (!row) unavailable();
  return row;
}

/** The recorded epoch and current role/project are all necessary for effective sharing. */
const RECIPIENT_SQL = `SELECT member.human_id, epoch.authorization_epoch
  FROM workspace_members AS member
  JOIN workspace_authorization_epochs AS epoch ON epoch.workspace_id = member.workspace_id
    AND epoch.human_id = member.human_id AND epoch.authorization_epoch = member.authorization_epoch
    AND epoch.revoked_at IS NULL
  JOIN projects AS project ON project.workspace_id = member.workspace_id AND project.id = ?
  WHERE member.workspace_id = ? AND member.human_id = ?
    AND member.role IN ('owner','member','reviewer')
    AND (project.access_mode = 'workspace' OR EXISTS (SELECT 1 FROM project_access AS access
      WHERE access.workspace_id = project.workspace_id AND access.project_id = project.id
        AND access.human_id = member.human_id))`;

export async function readTaskSharing(
  db: SqlDatabase,
  access: TaskAccessContext,
  taskId: string,
): Promise<TaskSharingView> {
  const selection = creatorSelection(access, taskId);
  const row = (await db
    .prepare(
      `SELECT * FROM (
    WITH sharing_task AS MATERIALIZED (${selection.sql}), effective_grants AS MATERIALIZED (
      SELECT grant.id, grant.human_id, grant.authorization_epoch, grant.permission, grant.created_at
      FROM task_human_grants AS grant JOIN sharing_task AS task
        ON task.workspace_id = grant.workspace_id AND task.id = grant.task_id
      JOIN workspace_members AS member ON member.workspace_id = grant.workspace_id
        AND member.human_id = grant.human_id AND member.authorization_epoch = grant.authorization_epoch
      JOIN workspace_authorization_epochs AS epoch ON epoch.workspace_id = member.workspace_id
        AND epoch.human_id = member.human_id AND epoch.authorization_epoch = member.authorization_epoch
        AND epoch.revoked_at IS NULL
      JOIN projects AS project ON project.workspace_id = task.workspace_id AND project.id = task.project_id
      WHERE grant.revoked_at IS NULL AND member.role IN ('owner','member','reviewer')
        AND (project.access_mode = 'workspace' OR EXISTS (SELECT 1 FROM project_access AS access
          WHERE access.workspace_id = project.workspace_id AND access.project_id = project.id
            AND access.human_id = member.human_id))
      ORDER BY grant.id LIMIT 101
    ) SELECT id AS task_id, access_version,
      (SELECT json_group_array(json_object('id',id,'human_id',human_id,
        'authorization_epoch',authorization_epoch,'permission',permission,'created_at',created_at))
       FROM effective_grants) AS grants_json FROM sharing_task
  )`,
    )
    .get(...selection.parameters)) as
    { task_id: string; access_version: number; grants_json: string } | undefined;
  if (!row) unavailable();
  const grants = JSON.parse(row.grants_json) as TaskSharingGrant[];
  return {
    task_id: row.task_id,
    access_version: row.access_version,
    grants: grants.slice(0, 100),
    has_more: grants.length > 100,
  };
}

function version(actual: number, expected: number) {
  if (actual !== expected) throw new DomainError("stale_version", "task sharing version conflict");
}
async function guard(
  ctx: HubContext,
  access: TaskAccessContext,
  taskId: string,
  projectId: string,
  expected: number,
  witness: { sql: string; parameters: Array<string | number> },
) {
  const selection = creatorSelection(access, taskId);
  const id = randomUlid();
  // Materialize the creator predicate separately so D1 keeps a bounded expression tree.
  // VALUES must attempt a failing CHECK even when the authority selection is empty.
  await ctx.db
    .prepare(
      `WITH sharing_task AS MATERIALIZED (${selection.sql})
    INSERT INTO artifact_mutation_guards (id,valid) VALUES (?, CASE WHEN
      EXISTS (SELECT 1 FROM sharing_task WHERE project_id = ? AND access_version = ?)
      AND (${witness.sql}) THEN 1 ELSE 0 END)`,
    )
    .run(...selection.parameters, id, projectId, expected, ...witness.parameters);
  await ctx.db.prepare("DELETE FROM artifact_mutation_guards WHERE id = ?").run(id);
}
async function bumpVersion(ctx: HubContext, taskId: string, expected: number) {
  await ctx.db
    .prepare(
      `UPDATE task_privacy SET access_version = access_version + 1
    WHERE workspace_id = ? AND task_id = ? AND access_version = ?`,
    )
    .run(ctx.workspaceId, taskId, expected);
}

/** Historical receipts remain valid after grant revocation, but never after creator loss. */
export async function assertTaskSharingReceipt(
  db: SqlDatabase,
  access: TaskAccessContext,
  receipt: TaskSharingReceipt,
  requestedGrant?: Pick<GrantTaskSharingInput, "humanId" | "permission">,
): Promise<void> {
  if (
    !receipt ||
    typeof receipt !== "object" ||
    Array.isArray(receipt) ||
    Object.keys(receipt).length !== 3 ||
    Object.keys(receipt).some((key) => !["task_id", "grant_id", "access_version"].includes(key)) ||
    !validId(receipt.task_id) ||
    !validId(receipt.grant_id) ||
    !Number.isSafeInteger(receipt.access_version) ||
    receipt.access_version < 2
  )
    unavailable();
  const selection = creatorSelection(access, receipt.task_id);
  const row = await db
    .prepare(
      `SELECT 1 FROM (${selection.sql}) AS sharing_task
    JOIN task_human_grants AS grant ON grant.workspace_id = sharing_task.workspace_id
      AND grant.task_id = sharing_task.id WHERE grant.id = ?
      ${requestedGrant ? "AND grant.human_id = ? AND grant.permission = ?" : ""}`,
    )
    .get(
      ...selection.parameters,
      receipt.grant_id,
      ...(requestedGrant ? [requestedGrant.humanId, requestedGrant.permission] : []),
    );
  if (!row) unavailable();
}
async function replay(
  result: TaskSharingReceipt,
  ctx: HubContext,
  input: GrantTaskSharingInput | RevokeTaskSharingInput,
) {
  if (
    !result ||
    result.task_id !== input.taskId ||
    result.access_version !== input.expectedAccessVersion + 1 ||
    ("grantId" in input && result.grant_id !== input.grantId)
  )
    unavailable();
  await assertTaskSharingReceipt(
    ctx.db,
    directAccess(ctx),
    result,
    "humanId" in input ? input : undefined,
  );
  return result;
}
function fingerprint(input: GrantTaskSharingInput | RevokeTaskSharingInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        "humanId" in input
          ? [input.taskId, input.humanId, input.permission, input.expectedAccessVersion]
          : [input.taskId, input.grantId, input.expectedAccessVersion],
      ),
    )
    .digest("hex");
}

export const grantTaskSharingCommand: HubCommand<GrantTaskSharingInput, TaskSharingReceipt> = {
  name: "task.sharing.grant",
  inputFingerprint: (input) => fingerprint(grantInput(input)),
  auditInput: (input) => ({ taskId: input.taskId }),
  auditResult: (result) => result,
  async authorize(input, ctx) {
    grantInput(input);
    await creator(ctx.db, directAccess(ctx), input.taskId);
  },
  replayResult: replay,
  async run(input, ctx) {
    grantInput(input);
    const access = directAccess(ctx),
      task = await creator(ctx.db, access, input.taskId);
    version(task.access_version, input.expectedAccessVersion);
    if (input.humanId === access.humanId)
      throw new DomainError("invalid_argument", "the creator does not need a sharing grant");
    const recipient = (await ctx.db
      .prepare(RECIPIENT_SQL)
      .get(task.project_id, ctx.workspaceId, input.humanId)) as
      { authorization_epoch: number } | undefined;
    if (!recipient) throw new DomainError("not_found", "sharing recipient not found");
    const active = await ctx.db
      .prepare(
        `SELECT 1 FROM task_human_grants
      WHERE workspace_id = ? AND task_id = ? AND human_id = ?
        AND authorization_epoch = ? AND revoked_at IS NULL`,
      )
      .get(ctx.workspaceId, input.taskId, input.humanId, recipient.authorization_epoch);
    if (active) throw new DomainError("already_exists", "sharing grant already exists");
    await guard(ctx, access, input.taskId, task.project_id, input.expectedAccessVersion, {
      sql: `EXISTS (SELECT 1 FROM (${RECIPIENT_SQL}) AS recipient WHERE authorization_epoch = ?)
        AND NOT EXISTS (SELECT 1 FROM task_human_grants WHERE workspace_id = ? AND task_id = ?
          AND human_id = ? AND authorization_epoch = ? AND revoked_at IS NULL)`,
      parameters: [
        task.project_id,
        ctx.workspaceId,
        input.humanId,
        recipient.authorization_epoch,
        ctx.workspaceId,
        input.taskId,
        input.humanId,
        recipient.authorization_epoch,
      ],
    });
    const grantId = randomUlid();
    await ctx.db
      .prepare(
        `INSERT INTO task_human_grants
      (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at)
      VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        ctx.workspaceId,
        grantId,
        input.taskId,
        input.humanId,
        recipient.authorization_epoch,
        input.permission,
        ctx.now,
      );
    await bumpVersion(ctx, input.taskId, input.expectedAccessVersion);
    return {
      task_id: input.taskId,
      grant_id: grantId,
      access_version: input.expectedAccessVersion + 1,
    };
  },
};

export const revokeTaskSharingCommand: HubCommand<RevokeTaskSharingInput, TaskSharingReceipt> = {
  name: "task.sharing.revoke",
  inputFingerprint: (input) => fingerprint(revokeInput(input)),
  auditInput: (input) => ({ taskId: input.taskId, grantId: input.grantId }),
  auditResult: (result) => result,
  async authorize(input, ctx) {
    revokeInput(input);
    await creator(ctx.db, directAccess(ctx), input.taskId);
  },
  replayResult: replay,
  async run(input, ctx) {
    revokeInput(input);
    const access = directAccess(ctx),
      task = await creator(ctx.db, access, input.taskId);
    version(task.access_version, input.expectedAccessVersion);
    const witness = {
      sql: `EXISTS (SELECT 1 FROM task_human_grants WHERE workspace_id = ?
      AND task_id = ? AND id = ? AND revoked_at IS NULL)`,
      parameters: [ctx.workspaceId, input.taskId, input.grantId],
    };
    const grant = await ctx.db.prepare(`SELECT 1 WHERE ${witness.sql}`).get(...witness.parameters);
    if (!grant) throw new DomainError("not_found", "sharing grant not found");
    await guard(ctx, access, input.taskId, task.project_id, input.expectedAccessVersion, witness);
    await ctx.db
      .prepare(
        `UPDATE task_human_grants SET revoked_at = ?
      WHERE workspace_id = ? AND task_id = ? AND id = ? AND revoked_at IS NULL`,
      )
      .run(ctx.now, ctx.workspaceId, input.taskId, input.grantId);
    await bumpVersion(ctx, input.taskId, input.expectedAccessVersion);
    return {
      task_id: input.taskId,
      grant_id: input.grantId,
      access_version: input.expectedAccessVersion + 1,
    };
  },
};
