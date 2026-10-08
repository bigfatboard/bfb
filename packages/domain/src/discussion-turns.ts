// ABOUTME: Correlates a bounded discussion turn with accepted input, dispatch, observed-session acknowledgement and intentional output.
// ABOUTME: Derives the speaker from authenticated run authority and never treats peer text or process presence as permission.

import {
  encodeWireDocument,
  type DiscussionReceipt,
  type DiscussionTurnRequest,
} from "@bfb/protocol";

import { DomainError, type HubCommand, type HubContext } from "./hub.js";
import { randomUlid } from "./ids.js";
import {
  advanceDiscussion,
  assertDiscussionActive,
  discussionDispatchBlock,
  discussionMessages,
  discussionParticipant,
  discussionWire,
  readDiscussion,
  readDiscussionReceipt,
  saveDiscussionReceipt,
  type DiscussionBrief,
  type DiscussionDelivery,
  type DiscussionParticipant,
  type DiscussionRow,
  type DiscussionTurn,
} from "./discussion-records.js";
import { stopDiscussionRuns } from "./discussions.js";

interface ObservedSession {
  id: string;
  run_id: string;
  observed_session_id: string;
  provider: string;
}

async function observedSession(
  ctx: HubContext,
  participant: DiscussionParticipant,
  sessionId: string,
) {
  const session = (await ctx.db
    .prepare(
      `SELECT session.id, session.run_id, session.observed_session_id, session.provider
     FROM provider_sessions AS session
     JOIN run_configuration_snapshots AS snapshot ON snapshot.workspace_id = session.workspace_id AND snapshot.run_id = session.run_id
     JOIN agent_profile_versions AS profile ON profile.workspace_id = snapshot.workspace_id AND profile.profile_id = snapshot.agent_profile_id AND profile.version = snapshot.agent_profile_version
     WHERE session.workspace_id = ? AND session.run_id = ? AND session.id = ? AND snapshot.id = ?
       AND session.provider = profile.provider AND session.observed_session_id IS NOT NULL`,
    )
    .get(ctx.workspaceId, participant.run_id, sessionId, participant.snapshot_id)) as
    ObservedSession | undefined;
  if (
    !session ||
    !session.observed_session_id ||
    [...session.observed_session_id].length > 256 ||
    [...session.observed_session_id].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  )
    throw new DomainError(
      "session_mismatch",
      "discussion requires a trusted observed participant session",
    );
  const binding = (await ctx.db
    .prepare(
      `SELECT session_id AS id, run_id, observed_session_id, provider FROM discussion_session_bindings
     WHERE workspace_id = ? AND participant_id = ?`,
    )
    .get(ctx.workspaceId, participant.id)) as ObservedSession | undefined;
  if (
    binding &&
    (binding.id !== session.id ||
      binding.run_id !== session.run_id ||
      binding.observed_session_id !== session.observed_session_id ||
      binding.provider !== session.provider)
  )
    throw new DomainError("session_mismatch", "discussion cannot switch its owned session");
  return { session, binding };
}

async function acceptTurn(
  ctx: HubContext,
  row: DiscussionRow,
  turn: DiscussionTurn,
  participant: DiscussionParticipant,
  input: DiscussionTurnRequest,
) {
  if (turn.state !== "planned")
    throw new DomainError("invalid_transition", "discussion turn is already accepted");
  const earlier = await ctx.db
    .prepare(
      `SELECT id FROM discussion_turns WHERE workspace_id = ? AND discussion_id = ? AND ordinal < ? AND state != 'completed' LIMIT 1`,
    )
    .get(ctx.workspaceId, row.id, turn.ordinal);
  if (earlier) throw new DomainError("invalid_transition", "earlier discussion turn is unfinished");
  const messages = await discussionMessages(ctx.db, ctx.workspaceId, row.id);
  const precedingRound = Math.floor((turn.ordinal - 1) / 2) * 2;
  const sources = messages
    .filter(
      (message) =>
        message.kind === "intervention" ||
        (message.ordinal !== null && message.ordinal <= precedingRound),
    )
    .map((message) => message.id);
  const delivery = randomUlid();
  const receipt = await advanceDiscussion(row, input.expected_version, ctx);
  await ctx.db
    .prepare(
      `INSERT INTO discussion_deliveries (workspace_id, id, discussion_id, turn_id, participant_id, run_id, source_message_ids_json, state, resource_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'accepted', 1, ?)`,
    )
    .run(
      ctx.workspaceId,
      delivery,
      row.id,
      turn.id,
      participant.id,
      participant.run_id,
      encodeWireDocument(sources),
      ctx.now,
    );
  await ctx.db
    .prepare(
      `UPDATE discussion_turns SET state = 'active', resource_version = resource_version + 1
     WHERE workspace_id = ? AND id = ? AND state = 'planned' AND resource_version = ?`,
    )
    .run(ctx.workspaceId, turn.id, turn.resource_version);
  return {
    ...receipt,
    turn_id: turn.id,
    turn_version: turn.resource_version + 1,
    delivery_id: delivery,
    delivery_version: 1,
  };
}

export const changeDiscussionTurnCommand: HubCommand<DiscussionTurnRequest, DiscussionReceipt> = {
  name: "discussion.turn",
  replay: "reject",
  auditInput: (input) => ({
    discussionId: input.discussion_id,
    turnId: input.turn_id,
    action: input.action,
  }),
  async run(raw, ctx) {
    const input = discussionWire<DiscussionTurnRequest>("discussion-turn-request", raw);
    const row = await readDiscussion(ctx.db, ctx.workspaceId, input.discussion_id);
    const participant = await discussionParticipant(row, ctx);
    const turn = (await ctx.db
      .prepare(
        `SELECT * FROM discussion_turns WHERE workspace_id = ? AND discussion_id = ? AND id = ? AND participant_id = ?`,
      )
      .get(ctx.workspaceId, row.id, input.turn_id, participant.id)) as DiscussionTurn | undefined;
    if (!turn) throw new DomainError("forbidden", "discussion turn belongs to another participant");
    const replay = await readDiscussionReceipt(ctx, changeDiscussionTurnCommand.name, input);
    if (replay) return replay;
    if (
      row.resource_version !== input.expected_version ||
      turn.resource_version !== input.expected_turn_version
    )
      throw new DomainError("stale_version", "discussion turn version conflict");
    if (input.action === "fail") {
      if (row.state !== "active")
        throw new DomainError("invalid_transition", "discussion is stopped");
      if (
        input.reason !== "provider_failed" &&
        (await discussionDispatchBlock(row, ctx)) !== input.reason
      )
        throw new DomainError("invalid_argument", "discussion failure reason is not established");
    } else if (input.action === "ambiguous") {
      if (row.state !== "active")
        throw new DomainError("invalid_transition", "discussion is stopped");
    } else await assertDiscussionActive(row, ctx);
    if (input.action === "accept")
      return saveDiscussionReceipt(
        ctx,
        changeDiscussionTurnCommand.name,
        input,
        await acceptTurn(ctx, row, turn, participant, input),
      );

    const delivery = (await ctx.db
      .prepare(
        `SELECT * FROM discussion_deliveries WHERE workspace_id = ? AND discussion_id = ? AND turn_id = ? AND id = ? AND participant_id = ?`,
      )
      .get(ctx.workspaceId, row.id, turn.id, input.delivery_id, participant.id)) as
      DiscussionDelivery | undefined;
    if (!delivery || delivery.run_id !== participant.run_id)
      throw new DomainError("forbidden", "discussion delivery binding is invalid");
    if (delivery.resource_version !== input.expected_delivery_version)
      throw new DomainError("stale_version", "discussion delivery version conflict");
    if (turn.state !== "active")
      throw new DomainError("invalid_transition", "discussion turn is not active");
    let next: DiscussionDelivery["state"],
      session: ObservedSession | undefined,
      newBinding = false;
    let message: string | undefined, body: string | undefined;
    switch (input.action) {
      case "dispatch":
        if (delivery.state !== "accepted")
          throw new DomainError("invalid_transition", "discussion delivery was already dispatched");
        next = "dispatched";
        break;
      case "acknowledge": {
        if (delivery.state !== "dispatched")
          throw new DomainError(
            "invalid_transition",
            "discussion acknowledgement requires a dispatch",
          );
        const observed = await observedSession(ctx, participant, input.session_id);
        session = observed.session;
        newBinding = !observed.binding;
        if (newBinding && turn.ordinal > 2)
          throw new DomainError(
            "session_mismatch",
            "discussion continuation lacks its initial session binding",
          );
        next = "acknowledged";
        break;
      }
      case "complete": {
        if (delivery.state !== "acknowledged" || delivery.session_id !== input.session_id)
          throw new DomainError(
            "invalid_transition",
            "discussion completion requires its exact acknowledged session",
          );
        const observed = await observedSession(ctx, participant, input.session_id);
        if (!observed.binding)
          throw new DomainError("session_mismatch", "discussion session binding is missing");
        session = observed.session;
        const brief = JSON.parse(row.brief_json) as DiscussionBrief;
        const sources = JSON.parse(delivery.source_message_ids_json) as string[];
        const messages = await discussionMessages(ctx.db, ctx.workspaceId, row.id);
        if (
          input.output.evidence.some((evidence) =>
            evidence.kind === "context"
              ? !brief.context.some((item) => item.id === evidence.context_id)
              : evidence.git_revision !== row.git_revision ||
                !evidence.repository_path ||
                evidence.repository_path
                  .split("/")
                  .some((part) => !part || part === "." || part === ".."),
          )
        )
          throw new DomainError(
            "forbidden",
            "discussion evidence must reference frozen context or a relative file at the frozen revision",
          );
        const references = [...input.output.agreement, ...input.output.disagreements];
        if (
          references.some(
            (reference) =>
              !sources.includes(reference.message_id) ||
              !messages.some(
                (message) =>
                  message.id === reference.message_id && message.kind === "recommendation",
              ),
          )
        )
          throw new DomainError(
            "forbidden",
            "discussion recommendation refers to unavailable peer content",
          );
        body = encodeWireDocument(input.output);
        if (Buffer.byteLength(body) > 8192)
          throw new DomainError("bound_exceeded", "discussion output exceeds its byte bound");
        message = randomUlid();
        next = "completed";
        break;
      }
      case "ambiguous":
        if (delivery.state !== "dispatched" && delivery.state !== "acknowledged")
          throw new DomainError(
            "invalid_transition",
            "discussion ambiguity requires a possible provider effect",
          );
        next = "ambiguous";
        break;
      case "fail":
        if (
          delivery.state !== "accepted" &&
          delivery.state !== "dispatched" &&
          delivery.state !== "acknowledged"
        )
          throw new DomainError("invalid_transition", "discussion delivery is already settled");
        next = "failed";
        break;
    }
    const receipt = await advanceDiscussion(
      row,
      input.expected_version,
      ctx,
      next === "ambiguous" ? "paused" : next === "failed" ? "failed" : "active",
      next === "ambiguous"
        ? "delivery_ambiguous"
        : next === "failed" && input.action === "fail"
          ? input.reason
          : null,
    );
    if (newBinding && session)
      await ctx.db
        .prepare(
          `INSERT INTO discussion_session_bindings (workspace_id, discussion_id, participant_id, run_id, runner_id, session_id, observed_session_id, provider, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ctx.workspaceId,
          row.id,
          participant.id,
          participant.run_id,
          participant.runner_id,
          session.id,
          session.observed_session_id,
          session.provider,
          ctx.now,
        );
    await ctx.db
      .prepare(
        `UPDATE discussion_deliveries SET state = ?, session_id = ?, resource_version = resource_version + 1
       WHERE workspace_id = ? AND id = ? AND resource_version = ?`,
      )
      .run(
        next,
        session?.id ?? delivery.session_id,
        ctx.workspaceId,
        delivery.id,
        delivery.resource_version,
      );
    receipt.turn_id = turn.id;
    receipt.turn_version = turn.resource_version;
    receipt.delivery_id = delivery.id;
    receipt.delivery_version = delivery.resource_version + 1;
    if (next === "completed" && message && body && session) {
      await ctx.db
        .prepare(
          `INSERT INTO discussion_messages (workspace_id, id, discussion_id, kind, participant_id, run_id, session_id, turn_id, body_json, created_at)
         VALUES (?, ?, ?, 'recommendation', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ctx.workspaceId,
          message,
          row.id,
          participant.id,
          participant.run_id,
          session.id,
          turn.id,
          body,
          ctx.now,
        );
      await ctx.db
        .prepare(
          `UPDATE discussion_turns SET state = 'completed', resource_version = resource_version + 1 WHERE workspace_id = ? AND id = ? AND state = 'active' AND resource_version = ?`,
        )
        .run(ctx.workspaceId, turn.id, turn.resource_version);
      receipt.turn_version++;
      receipt.message_id = message;
    } else if (next === "failed") {
      await stopDiscussionRuns(ctx, row, "failed");
      receipt.turn_version++;
    }
    return saveDiscussionReceipt(ctx, changeDiscussionTurnCommand.name, input, receipt);
  },
};
