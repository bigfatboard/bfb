// ABOUTME: Records bounded author-private progress for humans and authenticated OAuth sponsors.
// ABOUTME: Selects only current authorized owner/origin history and fences command receipts through the Hub.

import { createHash } from "node:crypto";
import type { SqlDatabase } from "@bfb/db";
import { DomainError, type HubCommand, type HubContext } from "./hub.js";
import { isUlid, randomUlid } from "./ids.js";
import { canonicalLaunchJson } from "./launch-state.js";
import {
  capturePublicBusinessAuthority,
  publicBusinessCommand,
  publicBusinessSelection,
  publicTaskRowAuthorityPredicate,
  type PublicBusinessAuthority,
  type PublicBusinessSelection,
} from "./public-business.js";
import { checkedCommentBody } from "./work-commands.js";

export interface ReportPrivateProgressInput {
  taskId: string;
  body: string;
}
export interface PrivateProgressReceipt {
  task_id: string;
  checkpoint_id: string;
  content_hash: string;
}
export interface PrivateProgressCheckpoint {
  id: string;
  body: string;
  content_hash: string;
  created_at: string;
  origin: "human" | "delegation";
}
export interface PrivateProgressView {
  task_id: string;
  checkpoints: PrivateProgressCheckpoint[];
  has_more: boolean;
}

function unavailable(): never {
  throw new DomainError("not_found", "private progress not found");
}
function validId(value: unknown): value is string {
  return typeof value === "string" && value.length === 26 && isUlid(value);
}
function checkedInput(input: ReportPrivateProgressInput): ReportPrivateProgressInput {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== 2 ||
    Object.keys(input).some((key) => !["taskId", "body"].includes(key)) ||
    !validId(input.taskId)
  )
    throw new DomainError("invalid_argument", "invalid private progress input");
  return { taskId: input.taskId, body: checkedCommentBody(input.body) };
}
function contentHash(body: string): string {
  return `sha256:${createHash("sha256").update(canonicalLaunchJson({ body }), "utf8").digest("hex")}`;
}
function checkedAuthority(authority: PublicBusinessAuthority): void {
  if (
    !authority ||
    !validId(authority.workspaceId) ||
    !validId(authority.humanId) ||
    !Number.isSafeInteger(authority.authorizationEpoch) ||
    authority.authorizationEpoch < 1 ||
    !["owner", "member", "reviewer"].includes(authority.role) ||
    !Array.isArray(authority.projectIds) ||
    authority.projectIds.some((id) => !validId(id))
  )
    unavailable();
  const credential = authority.credential;
  if (
    credential &&
    (credential.kind !== "delegation" ||
      !validId(credential.delegationId) ||
      typeof credential.clientId !== "string" ||
      !credential.clientId ||
      !(credential.projectId === null || validId(credential.projectId)) ||
      !(credential.taskId === null || validId(credential.taskId)) ||
      !Array.isArray(credential.scopes) ||
      credential.scopes.some((scope) => typeof scope !== "string"))
  )
    unavailable();
}
function taskSelection(
  authority: PublicBusinessAuthority,
  taskId: string,
  action: "read" | "contribute",
) {
  checkedAuthority(authority);
  if (!validId(taskId)) throw new DomainError("invalid_argument", "invalid private progress task");
  const task = publicTaskRowAuthorityPredicate(
    authority,
    action,
    "task",
    undefined,
    action === "read" ? "bfb:read" : "bfb:task:write",
  );
  return {
    sql: `private_checkpoint_task AS MATERIALIZED (
      SELECT task.workspace_id,task.id,task.project_id FROM tasks AS task
      WHERE task.workspace_id = ? AND task.id = ? AND ${task.sql}
    )`,
    parameters: [authority.workspaceId, taskId, ...task.parameters],
  };
}
function origin(authority: PublicBusinessAuthority) {
  return authority.credential?.kind === "delegation"
    ? { delegationId: authority.credential.delegationId, clientId: authority.credential.clientId }
    : { delegationId: null, clientId: null };
}

export async function readPrivateProgress(
  db: SqlDatabase,
  authority: PublicBusinessAuthority,
  taskId: string,
): Promise<PrivateProgressView> {
  const task = taskSelection(authority, taskId, "read");
  const agent = authority.credential?.kind === "delegation" ? origin(authority) : undefined;
  const row = (await db
    .prepare(
      `SELECT * FROM (WITH ${task.sql},
    private_checkpoint_page AS MATERIALIZED (
      SELECT checkpoint.* FROM task_private_checkpoints AS checkpoint
      JOIN private_checkpoint_task AS task ON task.workspace_id = checkpoint.workspace_id
        AND task.id = checkpoint.task_id AND task.project_id = checkpoint.project_id
      WHERE checkpoint.owner_human_id = ?
        ${agent ? "AND checkpoint.origin_delegation_id = ? AND checkpoint.origin_client_id = ?" : ""}
      ORDER BY checkpoint.created_at DESC,checkpoint.rowid DESC LIMIT 101
    ) SELECT (SELECT id FROM private_checkpoint_task) AS task_id,
      (SELECT json_group_array(json_object('id',id,'body',body,'content_hash',content_hash,
        'created_at',created_at,'origin',CASE WHEN origin_delegation_id IS NULL THEN 'human' ELSE 'delegation' END))
        FROM private_checkpoint_page) AS checkpoints_json
    )`,
    )
    .get(
      ...task.parameters,
      authority.humanId,
      ...(agent ? [agent.delegationId, agent.clientId] : []),
    )) as { task_id: string | null; checkpoints_json: string } | undefined;
  if (!row?.task_id) unavailable();
  const checkpoints = JSON.parse(row.checkpoints_json) as PrivateProgressCheckpoint[];
  return {
    task_id: row.task_id,
    checkpoints: checkpoints.slice(0, 100),
    has_more: checkpoints.length > 100,
  };
}

function receiptSelection(
  authority: PublicBusinessAuthority,
  receipt: PrivateProgressReceipt,
  input: ReportPrivateProgressInput,
): PublicBusinessSelection<PrivateProgressReceipt> {
  const value = checkedInput(input);
  const task = taskSelection(authority, value.taskId, "contribute");
  if (
    !receipt ||
    typeof receipt !== "object" ||
    Array.isArray(receipt) ||
    Object.keys(receipt).length !== 3 ||
    Object.keys(receipt).some(
      (key) => !["task_id", "checkpoint_id", "content_hash"].includes(key),
    ) ||
    receipt.task_id !== value.taskId ||
    !validId(receipt.checkpoint_id) ||
    receipt.content_hash !== contentHash(value.body)
  )
    return publicBusinessSelection({ sql: "0", parameters: [] });
  const author = origin(authority);
  return {
    sql: `SELECT * FROM (WITH ${task.sql}
      SELECT checkpoint.id FROM task_private_checkpoints AS checkpoint
      JOIN private_checkpoint_task AS task ON task.workspace_id = checkpoint.workspace_id
        AND task.id = checkpoint.task_id AND task.project_id = checkpoint.project_id
      WHERE checkpoint.id = ? AND checkpoint.owner_human_id = ?
        AND checkpoint.origin_delegation_id IS ? AND checkpoint.origin_client_id IS ?
        AND checkpoint.content_hash = ? AND checkpoint.body = ?)`,
    parameters: [
      ...task.parameters,
      receipt.checkpoint_id,
      authority.humanId,
      author.delegationId,
      author.clientId,
      receipt.content_hash,
      value.body,
    ],
  };
}

export async function assertPrivateProgressReceipt(
  db: SqlDatabase,
  authority: PublicBusinessAuthority,
  receipt: PrivateProgressReceipt,
  input: ReportPrivateProgressInput,
): Promise<void> {
  const selection = receiptSelection(authority, receipt, input);
  if (!(await db.prepare(selection.sql).get(...selection.parameters))) unavailable();
}

async function commandAuthority(ctx: HubContext): Promise<PublicBusinessAuthority> {
  if (
    !validId(ctx.actorHumanId) ||
    ctx.actorRunnerId !== undefined ||
    ctx.actorSystemId !== undefined ||
    (ctx.actorDelegationId !== undefined && !validId(ctx.actorDelegationId))
  )
    unavailable();
  return capturePublicBusinessAuthority(ctx.db, ctx);
}

export const reportPrivateProgressCommand: HubCommand<
  ReportPrivateProgressInput,
  PrivateProgressReceipt
> = publicBusinessCommand<ReportPrivateProgressInput, PrivateProgressReceipt>(
  {
    name: "progress.private.report",
    inputFingerprint: (input) =>
      createHash("sha256")
        .update(canonicalLaunchJson(checkedInput(input)))
        .digest("hex"),
    auditInput: (input) => ({ task_id: checkedInput(input).taskId }),
    auditResult: (receipt) => ({
      task_id: receipt.task_id,
      checkpoint_id: receipt.checkpoint_id,
      content_hash: receipt.content_hash,
    }),
    async authorize(input, ctx) {
      const value = checkedInput(input);
      const authority = await commandAuthority(ctx);
      const task = taskSelection(authority, value.taskId, "contribute");
      if (
        !(await ctx.db
          .prepare(`SELECT * FROM (WITH ${task.sql} SELECT id FROM private_checkpoint_task)`)
          .get(...task.parameters))
      )
        unavailable();
    },
    async run(input, ctx) {
      const value = checkedInput(input);
      const authority = await commandAuthority(ctx);
      const task = taskSelection(authority, value.taskId, "contribute");
      const parent = (await ctx.db
        .prepare(`SELECT * FROM (WITH ${task.sql} SELECT project_id FROM private_checkpoint_task)`)
        .get(...task.parameters)) as { project_id: string } | undefined;
      if (!parent) unavailable();
      const author = origin(authority);
      const receipt = {
        task_id: value.taskId,
        checkpoint_id: randomUlid(),
        content_hash: contentHash(value.body),
      };
      await ctx.db
        .prepare(
          `INSERT INTO task_private_checkpoints
        (workspace_id,id,task_id,project_id,owner_human_id,origin_delegation_id,origin_client_id,body,content_hash,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          ctx.workspaceId,
          receipt.checkpoint_id,
          value.taskId,
          parent.project_id,
          authority.humanId,
          author.delegationId,
          author.clientId,
          value.body,
          receipt.content_hash,
          ctx.now,
        );
      return receipt;
    },
  },
  {
    admissionIsSelection: true,
    admission: (input, authority) => {
      const value = checkedInput(input);
      const task = taskSelection(authority, value.taskId, "contribute");
      return {
        sql: `SELECT * FROM (WITH ${task.sql} SELECT id FROM private_checkpoint_task)`,
        parameters: task.parameters,
      };
    },
    delivery: (input, receipt, authority) => receiptSelection(authority, receipt, input),
    denial: { code: "not_found", message: "private progress not found" },
  },
);
