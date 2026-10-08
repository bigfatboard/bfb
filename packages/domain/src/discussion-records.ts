// ABOUTME: Loads tenant-scoped discussion identity, current authority and immutable causal records.
// ABOUTME: Keeps bounded content separate from safe mutation receipts and rejects live-context substitution.

import { createHash } from "node:crypto";
import { assertUlid, type SqlDatabase } from "@bfb/db";
import {
  decodeWireDocument,
  encodeWireDocument,
  type DiscussionReceipt,
  type WireDocumentName,
} from "@bfb/protocol";

import { assertEpoch, assertProjectAccess, assertRole, loadPrincipal } from "./authorization.js";
import { DomainError, type HubContext } from "./hub.js";
import { randomUlid } from "./ids.js";
import { assertRunnerLaunchAuthority } from "./runners.js";
import { getAgentContext, getTask, type AgentContextItem } from "./work-commands.js";

export interface DiscussionRow {
  workspace_id: string;
  id: string;
  project_id: string;
  task_id: string;
  sponsor_human_id: string;
  sponsor_authorization_epoch: number;
  task_version: number;
  brief_json: string;
  brief_hash: string;
  context_hash: string;
  git_revision: string;
  rounds: number;
  deadline: string;
  state: DiscussionReceipt["state"];
  reason: string | null;
  resource_version: number;
  created_at: string;
  ended_at: string | null;
}

export interface DiscussionParticipant {
  id: string;
  discussion_id: string;
  task_id: string;
  slot: number;
  run_id: string;
  agent_profile_id: string;
  snapshot_id: string;
  runner_id: string;
  checkout_id: string;
  physical_worktree_hash: string;
  repository_config_hash: string;
}

export interface DiscussionTurn {
  id: string;
  discussion_id: string;
  participant_id: string;
  ordinal: number;
  state: "planned" | "active" | "completed" | "failed" | "cancelled";
  resource_version: number;
}

export interface DiscussionDelivery {
  id: string;
  discussion_id: string;
  turn_id: string;
  participant_id: string;
  run_id: string;
  source_message_ids_json: string;
  state: "accepted" | "dispatched" | "acknowledged" | "completed" | "ambiguous" | "failed";
  session_id: string | null;
  resource_version: number;
  created_at: string;
}

export interface DiscussionMessage {
  id: string;
  discussion_id: string;
  kind: "intervention" | "recommendation";
  author_human_id: string | null;
  participant_id: string | null;
  run_id: string | null;
  session_id: string | null;
  turn_id: string | null;
  body_json: string;
  created_at: string;
  ordinal: number | null;
}

export interface DiscussionBrief {
  schema_version: 1;
  task_id: string;
  title: string;
  question: string;
  git_revision: string;
  context: AgentContextItem[];
}

export function discussionWire<T>(name: WireDocumentName, value: unknown): T {
  try {
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length <= (name === "discussion-view" ? 262_144 : 65_536)) {
      const decoded = decodeWireDocument(name, bytes);
      if (decoded.ok) return decoded.value as T;
    }
  } catch {
    // Invalid values remain a bounded domain rejection, not parser diagnostics.
  }
  throw new DomainError("invalid_argument", "discussion request is invalid");
}

export function discussionHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(encodeWireDocument(value), "utf8").digest("hex")}`;
}

export async function discussionHuman(ctx: HubContext) {
  if (!ctx.actorHumanId || ctx.actorDelegationId || ctx.actorSystemId || ctx.actorRunnerId)
    throw new DomainError("forbidden", "direct authorized human required");
  const principal = await loadPrincipal(ctx.db, ctx.workspaceId, ctx.actorHumanId);
  assertEpoch(principal, ctx.authorizationEpoch);
  assertRole(principal, ["owner", "member"]);
  return principal;
}

export async function readDiscussion(db: SqlDatabase, workspace: string, id: string) {
  try {
    assertUlid(id, "discussion id");
  } catch {
    throw new DomainError("invalid_argument", "discussion id is invalid");
  }
  const row = (await db
    .prepare(`SELECT * FROM discussions WHERE workspace_id = ? AND id = ?`)
    .get(workspace, id)) as DiscussionRow | undefined;
  if (!row) throw new DomainError("not_found", "discussion not found");
  return row;
}

export async function discussionSponsor(row: DiscussionRow, ctx: HubContext) {
  const principal = await loadPrincipal(ctx.db, ctx.workspaceId, row.sponsor_human_id);
  assertEpoch(principal, row.sponsor_authorization_epoch);
  assertProjectAccess(principal, row.project_id);
  assertRole(principal, ["owner", "member"]);
  return principal;
}

export async function discussionParticipant(row: DiscussionRow, ctx: HubContext) {
  if (!ctx.actorSystemId || ctx.actorHumanId || ctx.actorDelegationId || ctx.actorRunnerId)
    throw new DomainError("forbidden", "authenticated discussion run required");
  const participant = (await ctx.db
    .prepare(
      `SELECT participant.* FROM discussion_participants AS participant
       JOIN runs AS run ON run.workspace_id = participant.workspace_id AND run.id = participant.run_id
       WHERE participant.workspace_id = ? AND participant.discussion_id = ? AND participant.run_id = ?
         AND run.purpose = 'discussion' AND run.result_state IN ('open', 'failed', 'cancelled')`,
    )
    .get(ctx.workspaceId, row.id, ctx.actorSystemId)) as DiscussionParticipant | undefined;
  if (!participant) throw new DomainError("forbidden", "discussion participant is not authorized");
  const sponsor = await discussionSponsor(row, ctx);
  assertEpoch(sponsor, ctx.authorizationEpoch);
  await assertRunnerLaunchAuthority(ctx.db, sponsor, participant.runner_id, row.project_id);
  return participant;
}

export async function discussionContext(db: SqlDatabase, workspace: string, taskId: string) {
  const task = await getTask(db, workspace, taskId);
  if (!task) throw new DomainError("not_found", "discussion task not found");
  return {
    task_id: task.id,
    title: task.title,
    context: await getAgentContext(db, workspace, taskId),
  };
}

export async function discussionDispatchBlock(row: DiscussionRow, ctx: HubContext) {
  if (Date.parse(ctx.now) >= Date.parse(row.deadline)) return "deadline_exceeded" as const;
  const context = await discussionContext(ctx.db, ctx.workspaceId, row.task_id);
  if (discussionHash(context) !== row.context_hash) return "context_changed" as const;
  return null;
}

export async function assertDiscussionActive(row: DiscussionRow, ctx: HubContext): Promise<void> {
  if (row.state !== "active") throw new DomainError("invalid_transition", "discussion is stopped");
  const block = await discussionDispatchBlock(row, ctx);
  if (block) throw new DomainError(block, "discussion cannot accept another provider effect");
}

export async function discussionMessages(db: SqlDatabase, workspace: string, id: string) {
  return (await db
    .prepare(
      `SELECT message.*, turn.ordinal FROM discussion_messages AS message
       LEFT JOIN discussion_turns AS turn ON turn.workspace_id = message.workspace_id AND turn.id = message.turn_id
       WHERE message.workspace_id = ? AND message.discussion_id = ? ORDER BY message.created_at, message.id LIMIT 19`,
    )
    .all(workspace, id)) as DiscussionMessage[];
}

export async function guardDiscussionMutation(
  ctx: HubContext,
  predicate: string,
  params: unknown[],
) {
  const id = randomUlid();
  await ctx.db
    .prepare(
      `INSERT INTO runner_mutation_guards (id, valid) SELECT ?, CASE WHEN (${predicate}) THEN 1 ELSE 0 END`,
    )
    .run(id, ...params);
  await ctx.db.prepare(`DELETE FROM runner_mutation_guards WHERE id = ?`).run(id);
}

export async function advanceDiscussion(
  row: DiscussionRow,
  expected: number,
  ctx: HubContext,
  state: DiscussionRow["state"] = row.state,
  reason: string | null = row.reason,
): Promise<DiscussionReceipt> {
  if (row.resource_version !== expected)
    throw new DomainError("stale_version", "discussion version conflict");
  await guardDiscussionMutation(
    ctx,
    `EXISTS (SELECT 1 FROM discussions WHERE workspace_id = ? AND id = ? AND resource_version = ?)`,
    [ctx.workspaceId, row.id, expected],
  );
  await ctx.db
    .prepare(
      `UPDATE discussions SET state = ?, reason = ?, resource_version = ?, ended_at = ?
     WHERE workspace_id = ? AND id = ? AND resource_version = ?`,
    )
    .run(
      state,
      reason,
      expected + 1,
      state === "active" ? null : (row.ended_at ?? ctx.now),
      ctx.workspaceId,
      row.id,
      expected,
    );
  return { schema_version: 1, discussion_id: row.id, version: expected + 1, state };
}

function receiptActor(ctx: HubContext) {
  if (ctx.actorHumanId && !ctx.actorDelegationId && !ctx.actorSystemId && !ctx.actorRunnerId)
    return { type: "human", id: ctx.actorHumanId };
  if (ctx.actorSystemId && !ctx.actorHumanId && !ctx.actorDelegationId && !ctx.actorRunnerId)
    return { type: "run", id: ctx.actorSystemId };
  throw new DomainError("forbidden", "discussion receipt authority is invalid");
}

/** Call only after current authority checks; the receipt never grants retained authority. */
export async function readDiscussionReceipt(
  ctx: HubContext,
  command: string,
  input: { idempotency_key: string },
) {
  const actor = receiptActor(ctx);
  const row = (await ctx.db
    .prepare(
      `SELECT authorization_epoch, request_hash, result_json FROM discussion_command_receipts
     WHERE workspace_id = ? AND actor_type = ? AND actor_id = ? AND command_name = ? AND key_hash = ?`,
    )
    .get(ctx.workspaceId, actor.type, actor.id, command, discussionHash(input.idempotency_key))) as
    { authorization_epoch: number; request_hash: string; result_json: string } | undefined;
  if (!row) return undefined;
  if (
    row.authorization_epoch !== ctx.authorizationEpoch ||
    row.request_hash !== discussionHash(input)
  )
    throw new DomainError("idempotency_conflict", "discussion request key is already bound");
  return discussionWire<DiscussionReceipt>("discussion-receipt", JSON.parse(row.result_json));
}

export async function saveDiscussionReceipt(
  ctx: HubContext,
  command: string,
  input: { idempotency_key: string },
  receipt: DiscussionReceipt,
) {
  const safe = discussionWire<DiscussionReceipt>("discussion-receipt", receipt);
  const actor = receiptActor(ctx);
  await ctx.db
    .prepare(
      `INSERT INTO discussion_command_receipts (workspace_id, actor_type, actor_id, authorization_epoch, command_name, key_hash, request_hash, result_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ctx.workspaceId,
      actor.type,
      actor.id,
      ctx.authorizationEpoch,
      command,
      discussionHash(input.idempotency_key),
      discussionHash(input),
      encodeWireDocument(safe),
    );
  return safe;
}
