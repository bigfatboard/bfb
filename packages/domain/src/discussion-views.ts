// ABOUTME: Projects immutable discussion context and attributed history under current human or exact-run authority.
// ABOUTME: Withholds same-round peer output and keeps accepted delivery input frozen across later human intervention.

import type { SqlDatabase } from "@bfb/db";
import type { DiscussionView } from "@bfb/protocol";

import type { AuthzPrincipal } from "./authorization.js";
import { DomainError, type HubContext } from "./hub.js";
import { isUlid } from "./ids.js";
import { sharedTaskPredicate, taskAccessPredicate } from "./task-access.js";
import {
  discussionDispatchBlock,
  discussionHash,
  discussionMessages,
  discussionParticipant,
  discussionSponsor,
  discussionWire,
  readDiscussion,
  type DiscussionDelivery,
  type DiscussionParticipant,
  type DiscussionRow,
  type DiscussionTurn,
} from "./discussion-records.js";

async function view(
  row: DiscussionRow,
  ctx: HubContext,
  participant?: DiscussionParticipant,
): Promise<DiscussionView> {
  const roster = (await ctx.db
    .prepare(
      `SELECT participant.*, snapshot.canonical_json FROM discussion_participants AS participant
     JOIN run_configuration_snapshots AS snapshot ON snapshot.workspace_id = participant.workspace_id AND snapshot.id = participant.snapshot_id
     WHERE participant.workspace_id = ? AND participant.discussion_id = ? ORDER BY participant.slot`,
    )
    .all(ctx.workspaceId, row.id)) as Array<DiscussionParticipant & { canonical_json: string }>;
  const turns = (await ctx.db
    .prepare(
      `SELECT * FROM discussion_turns WHERE workspace_id = ? AND discussion_id = ? ORDER BY ordinal`,
    )
    .all(ctx.workspaceId, row.id)) as DiscussionTurn[];
  const deliveries = (await ctx.db
    .prepare(`SELECT * FROM discussion_deliveries WHERE workspace_id = ? AND discussion_id = ?`)
    .all(ctx.workspaceId, row.id)) as DiscussionDelivery[];
  const messages = await discussionMessages(ctx.db, ctx.workspaceId, row.id);
  if (messages.length > 18 || roster.length !== 2 || turns.length !== row.rounds * 2)
    throw new DomainError("invalid_transition", "discussion history is inconsistent");
  let selectedMessages = messages;
  if (participant) {
    const owned = turns.filter((turn) => turn.participant_id === participant.id);
    const active = deliveries.find(
      (delivery) =>
        delivery.participant_id === participant.id &&
        ["accepted", "dispatched", "acknowledged", "ambiguous"].includes(delivery.state),
    );
    if (active) {
      const sources = JSON.parse(active.source_message_ids_json) as string[];
      selectedMessages = messages.filter(
        (message) => sources.includes(message.id) || message.participant_id === participant.id,
      );
    } else {
      const next = owned.find((turn) => turn.state === "planned" || turn.state === "active");
      let through = 0;
      if (next) through = Math.floor((next.ordinal - 1) / 2) * 2;
      else
        for (let round = 1; round <= row.rounds; round++) {
          if (
            turns
              .filter((turn) => turn.ordinal > (round - 1) * 2 && turn.ordinal <= round * 2)
              .every((turn) => turn.state === "completed")
          )
            through = round * 2;
          else break;
        }
      selectedMessages = messages.filter(
        (message) =>
          message.kind === "intervention" ||
          message.participant_id === participant.id ||
          (message.ordinal !== null && message.ordinal <= through),
      );
    }
  }
  const conclusion = (await ctx.db
    .prepare(
      `SELECT recommendation_ids_json, created_at FROM discussion_conclusions WHERE workspace_id = ? AND discussion_id = ?`,
    )
    .get(ctx.workspaceId, row.id)) as
    { recommendation_ids_json: string; created_at: string } | undefined;
  const decision = participant
    ? undefined
    : ((await ctx.db
        .prepare(
          `SELECT id, human_id, body_json, created_at FROM discussion_decisions WHERE workspace_id = ? AND discussion_id = ?`,
        )
        .get(ctx.workspaceId, row.id)) as
        { id: string; human_id: string; body_json: string; created_at: string } | undefined);
  let block: string | null;
  try {
    await discussionSponsor(row, ctx);
    block = await discussionDispatchBlock(row, ctx);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    block = "sponsor_revoked";
  }
  const brief = JSON.parse(row.brief_json) as unknown;
  if (discussionHash(brief) !== row.brief_hash)
    throw new DomainError("invalid_transition", "discussion frozen brief is inconsistent");
  return discussionWire<DiscussionView>("discussion-view", {
    schema_version: 1,
    scope: participant ? "participant" : "human",
    discussion_id: row.id,
    task_id: row.task_id,
    state: row.state,
    ...(row.reason ? { reason: row.reason } : {}),
    version: row.resource_version,
    deadline: row.deadline,
    brief_hash: row.brief_hash,
    brief,
    ...(block ? { dispatch_block_reason: block } : {}),
    ...(participant ? { viewer_run_id: participant.run_id } : {}),
    participants: roster.map((entry) => {
      const snapshot = JSON.parse(entry.canonical_json) as {
        agent_profile: { name: string; provider: string };
      };
      return {
        id: entry.id,
        run_id: entry.run_id,
        agent_profile_id: entry.agent_profile_id,
        name: snapshot.agent_profile.name,
        provider: snapshot.agent_profile.provider,
        runner_id: entry.runner_id,
        checkout_id: entry.checkout_id,
      };
    }),
    turns: turns
      .filter((turn) => !participant || turn.participant_id === participant.id)
      .map((turn) => {
        const delivery = deliveries.find((delivery) => delivery.turn_id === turn.id);
        return {
          id: turn.id,
          participant_id: turn.participant_id,
          ordinal: turn.ordinal,
          state: turn.state,
          version: turn.resource_version,
          ...(delivery
            ? {
                delivery: {
                  id: delivery.id,
                  state: delivery.state,
                  version: delivery.resource_version,
                  ...(delivery.session_id ? { session_id: delivery.session_id } : {}),
                  source_message_ids: JSON.parse(delivery.source_message_ids_json) as string[],
                },
              }
            : {}),
        };
      }),
    messages: selectedMessages.map((message) => ({
      id: message.id,
      kind: message.kind,
      created_at: message.created_at,
      ...(message.kind === "intervention"
        ? {
            author_human_id: message.author_human_id,
            text: (JSON.parse(message.body_json) as { text: string }).text,
          }
        : {
            participant_id: message.participant_id,
            run_id: message.run_id,
            session_id: message.session_id,
            turn_id: message.turn_id,
            output: JSON.parse(message.body_json) as unknown,
          }),
    })),
    ...(conclusion
      ? {
          conclusion: {
            recommendation_ids: JSON.parse(conclusion.recommendation_ids_json) as string[],
            created_at: conclusion.created_at,
          },
        }
      : {}),
    ...(decision
      ? {
          decision: {
            id: decision.id,
            human_id: decision.human_id,
            created_at: decision.created_at,
            ...(JSON.parse(decision.body_json) as object),
          },
        }
      : {}),
  });
}

/** Human history is shared-only; sponsor advice cannot replace current viewer authority. */
async function humanDiscussionRow(
  db: SqlDatabase,
  principal: AuthzPrincipal,
  id: string,
  expected?: DiscussionRow,
): Promise<DiscussionRow> {
  if (!isUlid(id)) throw new DomainError("invalid_argument", "discussion id is invalid");
  const access = taskAccessPredicate(principal, "read", "view_task");
  const row = (await db
    .prepare(
      `SELECT discussion.* FROM discussions AS discussion
       JOIN tasks AS view_task ON view_task.workspace_id=discussion.workspace_id
         AND view_task.id=discussion.task_id AND view_task.project_id=discussion.project_id
       WHERE discussion.workspace_id=? AND discussion.id=?
         AND ${sharedTaskPredicate("view_task")} AND ${access.sql}
         ${expected ? "AND discussion.task_id=? AND discussion.project_id=?" : ""}`,
    )
    .get(
      principal.workspaceId,
      id,
      ...access.parameters,
      ...(expected ? [expected.task_id, expected.project_id] : []),
    )) as DiscussionRow | undefined;
  if (!row) throw new DomainError("not_found", "discussion not found");
  return row;
}

export async function readHumanDiscussion(
  db: SqlDatabase,
  principal: AuthzPrincipal,
  id: string,
  now: string,
): Promise<DiscussionView> {
  const row = await humanDiscussionRow(db, principal, id);
  const result = await view(row, {
    db,
    workspaceId: principal.workspaceId,
    now,
    actorHumanId: principal.humanId,
    authorizationEpoch: principal.authorizationEpoch,
    cursorBase: 0,
  });
  // All hydration/advisory awaits finish before this exact current-parent delivery guard.
  await humanDiscussionRow(db, principal, id, row);
  return result;
}

/** A01/D02 must supply authenticated run authority; this is not a public ID-based login. */
export async function readParticipantDiscussion(
  ctx: HubContext,
  id: string,
): Promise<DiscussionView> {
  const row = await readDiscussion(ctx.db, ctx.workspaceId, id);
  const participant = await discussionParticipant(row, ctx);
  return view(row, ctx, participant);
}

export async function listTaskDiscussions(
  db: SqlDatabase,
  principal: AuthzPrincipal,
  taskId: string,
  options: { cursor?: string; limit?: number } = {},
) {
  const limit = options.limit ?? 20;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    (options.cursor !== undefined && !isUlid(options.cursor))
  )
    throw new DomainError("invalid_argument", "discussion pagination is invalid");
  const access = taskAccessPredicate(principal, "read", "view_task");
  const current = (await db
    .prepare(
      `WITH readable_parent AS MATERIALIZED (
         SELECT view_task.workspace_id,view_task.id,view_task.project_id FROM tasks AS view_task
         WHERE view_task.id=? AND ${sharedTaskPredicate("view_task")} AND ${access.sql}
       ), page AS MATERIALIZED (
         SELECT discussion.id,discussion.state,discussion.resource_version AS version,
           discussion.deadline,discussion.created_at FROM discussions AS discussion
         JOIN readable_parent AS parent ON parent.workspace_id=discussion.workspace_id
           AND parent.id=discussion.task_id AND parent.project_id=discussion.project_id
         ${options.cursor ? "WHERE discussion.id > ?" : ""} ORDER BY discussion.id LIMIT ?
       ) SELECT EXISTS (SELECT 1 FROM readable_parent) AS authorized,
         (SELECT json_group_array(json_object('id',id,'state',state,'version',version,
           'deadline',deadline,'created_at',created_at)) FROM page) AS rows_json`,
    )
    .get(taskId, ...access.parameters, ...(options.cursor ? [options.cursor] : []), limit + 1)) as {
    authorized: number;
    rows_json: string;
  };
  if (!current.authorized) throw new DomainError("not_found", "discussion task not found");
  const rows = JSON.parse(current.rows_json) as Array<{
    id: string;
    state: DiscussionRow["state"];
    version: number;
    deadline: string;
    created_at: string;
  }>;
  return {
    schema_version: 1 as const,
    discussions: rows.slice(0, limit),
    has_more: rows.length > limit,
    ...(rows.length > limit ? { next_cursor: rows[limit - 1]!.id } : {}),
  };
}
