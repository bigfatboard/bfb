// ABOUTME: Creates and changes human-sponsored discussions through the serialized workspace command lane.
// ABOUTME: Freezes read-only participant intent and records human decisions without advancing ordinary task work.

import {
  encodeWireDocument,
  type DiscussionChangeRequest,
  type DiscussionCreateRequest,
  type DiscussionReceipt,
  type RunnerInventory,
} from "@bfb/protocol";

import { assertProjectAccess } from "./authorization.js";
import { DomainError, type HubCommand, type HubContext } from "./hub.js";
import { randomUlid } from "./ids.js";
import { assertRunnerLaunchAuthority } from "./runners.js";
import { getTask } from "./work-commands.js";
import { persistRunCreation, prepareDiscussionRunCreation } from "./work-records.js";
import {
  advanceDiscussion,
  assertDiscussionActive,
  discussionContext,
  discussionHash,
  discussionHuman,
  discussionMessages,
  discussionParticipant,
  discussionSponsor,
  discussionWire,
  guardDiscussionMutation,
  readDiscussion,
  readDiscussionReceipt,
  saveDiscussionReceipt,
  type DiscussionBrief,
  type DiscussionRow,
  type DiscussionTurn,
} from "./discussion-records.js";

export const createDiscussionCommand: HubCommand<DiscussionCreateRequest, DiscussionReceipt> = {
  name: "discussion.create",
  replay: "reject",
  auditInput: (input) => ({ taskId: input.task_id }),
  async run(raw, ctx) {
    const input = discussionWire<DiscussionCreateRequest>("discussion-create-request", raw);
    const principal = await discussionHuman(ctx);
    const task = await getTask(ctx.db, ctx.workspaceId, input.task_id);
    if (!task) throw new DomainError("not_found", "discussion task not found");
    assertProjectAccess(principal, task.project_id);
    if (new Set(input.participants.map((participant) => participant.agent_profile_id)).size !== 2)
      throw new DomainError("invalid_argument", "discussion requires two distinct profiles");
    for (const participant of input.participants)
      await assertRunnerLaunchAuthority(ctx.db, principal, participant.runner_id, task.project_id);
    const replay = await readDiscussionReceipt(ctx, createDiscussionCommand.name, input);
    if (replay) return replay;

    const prepared = [];
    const checkouts = [];
    for (const participant of input.participants) {
      const run = await prepareDiscussionRunCreation(
        {
          taskId: input.task_id,
          expectedTaskVersion: input.expected_task_version,
          agentProfileId: participant.agent_profile_id,
          agentProfileVersion: participant.agent_profile_version,
          workspacePolicyVersion: input.workspace_policy_version,
          projectPolicyVersion: input.project_policy_version,
          repositoryConfigVersion: input.repository_config_version,
        },
        ctx,
      );
      const configuration = JSON.parse(run.result.snapshot.canonicalJson) as {
        agent_profile: { provider: string; execution_mode: string; harness_mode: string };
      };
      if (
        !["claude", "codex"].includes(configuration.agent_profile.provider) ||
        configuration.agent_profile.execution_mode !== "headless" ||
        configuration.agent_profile.harness_mode !== "restricted"
      )
        throw new DomainError(
          "provider_forbidden",
          "discussion requires a restricted headless Claude or Codex profile",
        );
      const inventoryRow = (await ctx.db
        .prepare(
          `SELECT inventory_json FROM runner_inventories WHERE workspace_id = ? AND runner_id = ?`,
        )
        .get(ctx.workspaceId, participant.runner_id)) as { inventory_json: string } | undefined;
      if (!inventoryRow)
        throw new DomainError("not_found", "registered discussion checkout not found");
      const inventory = discussionWire<RunnerInventory>(
        "runner-inventory",
        JSON.parse(inventoryRow.inventory_json),
      );
      const checkout = inventory.checkouts.find(
        (checkout) => checkout.checkout_id === participant.checkout_id,
      );
      if (
        inventory.workspace_id !== ctx.workspaceId ||
        inventory.runner_id !== participant.runner_id ||
        !checkout ||
        checkout.workspace_id !== ctx.workspaceId ||
        checkout.runner_id !== participant.runner_id ||
        checkout.project_id !== task.project_id ||
        checkout.status !== "validated" ||
        checkout.block_reason
      )
        throw new DomainError("forbidden", "discussion checkout is not permitted");
      prepared.push(run);
      checkouts.push(checkout);
    }
    const context = await discussionContext(ctx.db, ctx.workspaceId, task.id);
    const brief: DiscussionBrief = {
      schema_version: 1,
      ...context,
      question: input.question,
      git_revision: input.git_revision,
    };
    const briefJson = encodeWireDocument(brief);
    if (Buffer.byteLength(briefJson) > 65_536)
      throw new DomainError("bound_exceeded", "discussion brief exceeds its shared-context bound");
    const id = randomUlid(),
      briefHash = discussionHash(brief),
      rounds = input.rounds ?? 3;
    const deadline = new Date(
      Date.parse(ctx.now) + (input.duration_seconds ?? 900) * 1000,
    ).toISOString();
    await guardDiscussionMutation(
      ctx,
      `EXISTS (SELECT 1 FROM tasks WHERE workspace_id = ? AND id = ? AND resource_version = ?)`,
      [ctx.workspaceId, task.id, input.expected_task_version],
    );
    await ctx.db
      .prepare(
        `INSERT INTO discussions (workspace_id, id, project_id, task_id, sponsor_human_id, sponsor_authorization_epoch,
       task_version, brief_json, brief_hash, context_hash, git_revision, rounds, deadline, state, resource_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?)`,
      )
      .run(
        ctx.workspaceId,
        id,
        task.project_id,
        task.id,
        principal.humanId,
        principal.authorizationEpoch,
        task.resource_version,
        briefJson,
        briefHash,
        discussionHash(context),
        input.git_revision,
        rounds,
        deadline,
        ctx.now,
      );
    for (const [slot, run] of prepared.entries()) {
      const participant = input.participants[slot]!,
        checkout = checkouts[slot]!,
        participantId = randomUlid();
      await persistRunCreation(run, ctx);
      await ctx.db
        .prepare(
          `INSERT INTO discussion_participants (workspace_id, id, discussion_id, task_id, slot, run_id, agent_profile_id,
         snapshot_id, runner_id, checkout_id, physical_worktree_hash, repository_config_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ctx.workspaceId,
          participantId,
          id,
          task.id,
          slot,
          run.result.run.id,
          participant.agent_profile_id,
          run.result.snapshot.id,
          participant.runner_id,
          participant.checkout_id,
          checkout.physical_worktree_hash,
          checkout.repository_config_hash,
        );
      for (let round = 0; round < rounds; round++)
        await ctx.db
          .prepare(
            `INSERT INTO discussion_turns (workspace_id, id, discussion_id, participant_id, ordinal, state, resource_version)
           VALUES (?, ?, ?, ?, ?, 'planned', 1)`,
          )
          .run(ctx.workspaceId, randomUlid(), id, participantId, round * 2 + slot + 1);
    }
    return saveDiscussionReceipt(ctx, createDiscussionCommand.name, input, {
      schema_version: 1,
      discussion_id: id,
      version: 1,
      state: "active",
      brief_hash: briefHash,
      run_ids: prepared.map((run) => run.result.run.id),
    });
  },
};

/** Terminal discussion commands never mark work accepted or release native execution guards. */
export async function stopDiscussionRuns(
  ctx: HubContext,
  row: DiscussionRow,
  state: "failed" | "cancelled",
) {
  await ctx.db
    .prepare(
      `UPDATE discussion_turns SET state = ?, resource_version = resource_version + 1
     WHERE workspace_id = ? AND discussion_id = ? AND state IN ('planned', 'active')`,
    )
    .run(state, ctx.workspaceId, row.id);
  await ctx.db
    .prepare(
      `UPDATE runs SET result_state = ?, resource_version = resource_version + 1
     WHERE workspace_id = ? AND purpose = 'discussion' AND result_state = 'open'
       AND id IN (SELECT run_id FROM discussion_participants WHERE workspace_id = ? AND discussion_id = ?)`,
    )
    .run(state, ctx.workspaceId, ctx.workspaceId, row.id);
}

async function concludeDiscussion(ctx: HubContext, row: DiscussionRow, expected: number) {
  await assertDiscussionActive(row, ctx);
  const turns = (await ctx.db
    .prepare(
      `SELECT * FROM discussion_turns WHERE workspace_id = ? AND discussion_id = ? ORDER BY ordinal`,
    )
    .all(ctx.workspaceId, row.id)) as DiscussionTurn[];
  const messages = await discussionMessages(ctx.db, ctx.workspaceId, row.id);
  if (turns.length !== row.rounds * 2 || turns.some((turn) => turn.state !== "completed"))
    throw new DomainError("invalid_transition", "discussion has unfinished bounded turns");
  const final = turns
    .slice(-2)
    .map((turn) => messages.find((message) => message.turn_id === turn.id));
  if (final.some((message) => !message))
    throw new DomainError("invalid_transition", "discussion final recommendations are missing");
  const receipt = await advanceDiscussion(row, expected, ctx, "concluded");
  await ctx.db
    .prepare(
      `INSERT INTO discussion_conclusions (workspace_id, discussion_id, recommendation_ids_json, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run(ctx.workspaceId, row.id, encodeWireDocument(final.map((message) => message!.id)), ctx.now);
  return receipt;
}

export const concludeDiscussionCommand: HubCommand<DiscussionChangeRequest, DiscussionReceipt> = {
  name: "discussion.conclude",
  replay: "reject",
  auditInput: (input) => ({ discussionId: input.discussion_id }),
  async run(raw, ctx) {
    const input = discussionWire<DiscussionChangeRequest>("discussion-change-request", raw);
    if (input.action !== "conclude")
      throw new DomainError("invalid_argument", "discussion conclusion action required");
    const row = await readDiscussion(ctx.db, ctx.workspaceId, input.discussion_id);
    if (ctx.actorHumanId) {
      const human = await discussionHuman(ctx);
      assertProjectAccess(human, row.project_id);
      await discussionSponsor(row, ctx);
    } else await discussionParticipant(row, ctx);
    const replay = await readDiscussionReceipt(ctx, concludeDiscussionCommand.name, input);
    if (replay) return replay;
    return saveDiscussionReceipt(
      ctx,
      concludeDiscussionCommand.name,
      input,
      await concludeDiscussion(ctx, row, input.expected_version),
    );
  },
};

export const changeDiscussionCommand: HubCommand<DiscussionChangeRequest, DiscussionReceipt> = {
  name: "discussion.change",
  replay: "reject",
  auditInput: (input) => ({ discussionId: input.discussion_id, action: input.action }),
  async run(raw, ctx) {
    const input = discussionWire<DiscussionChangeRequest>("discussion-change-request", raw);
    const principal = await discussionHuman(ctx);
    const row = await readDiscussion(ctx.db, ctx.workspaceId, input.discussion_id);
    assertProjectAccess(principal, row.project_id);
    if (input.action === "intervene" || input.action === "conclude")
      await discussionSponsor(row, ctx);
    const replay = await readDiscussionReceipt(ctx, changeDiscussionCommand.name, input);
    if (replay) return replay;
    if (row.resource_version !== input.expected_version)
      throw new DomainError("stale_version", "discussion version conflict");
    let receipt: DiscussionReceipt;
    switch (input.action) {
      case "intervene": {
        await assertDiscussionActive(row, ctx);
        const count = (await ctx.db
          .prepare(
            `SELECT COUNT(*) AS count FROM discussion_messages WHERE workspace_id = ? AND discussion_id = ? AND kind = 'intervention'`,
          )
          .get(ctx.workspaceId, row.id)) as { count: number };
        if (count.count >= 12)
          throw new DomainError("bound_exceeded", "discussion intervention limit reached");
        const body = encodeWireDocument({ text: input.text });
        if (Buffer.byteLength(body) > 8192)
          throw new DomainError("bound_exceeded", "discussion intervention exceeds its byte bound");
        const message = randomUlid();
        receipt = await advanceDiscussion(row, input.expected_version, ctx);
        await ctx.db
          .prepare(
            `INSERT INTO discussion_messages (workspace_id, id, discussion_id, kind, author_human_id, body_json, created_at)
           VALUES (?, ?, ?, 'intervention', ?, ?, ?)`,
          )
          .run(ctx.workspaceId, message, row.id, principal.humanId, body, ctx.now);
        receipt.message_id = message;
        break;
      }
      case "cancel": {
        if (row.state !== "active")
          throw new DomainError("invalid_transition", "discussion is already stopped");
        receipt = await advanceDiscussion(
          row,
          input.expected_version,
          ctx,
          "cancelled",
          "human_cancelled",
        );
        await stopDiscussionRuns(ctx, row, "cancelled");
        break;
      }
      case "conclude": {
        receipt = await concludeDiscussion(ctx, row, input.expected_version);
        break;
      }
      case "decide": {
        if (row.state === "active")
          throw new DomainError(
            "invalid_transition",
            "human decision requires a stopped discussion",
          );
        const existing = await ctx.db
          .prepare(
            `SELECT id FROM discussion_decisions WHERE workspace_id = ? AND discussion_id = ?`,
          )
          .get(ctx.workspaceId, row.id);
        if (existing)
          throw new DomainError(
            "invalid_transition",
            "discussion already has an immutable human decision",
          );
        const ids = input.decision.recommendation_ids;
        const messages = await discussionMessages(ctx.db, ctx.workspaceId, row.id);
        if (
          new Set(ids).size !== ids.length ||
          ids.some(
            (id) =>
              !messages.some((message) => message.id === id && message.kind === "recommendation"),
          ) ||
          (input.decision.kind === "record_recommendation" && ids.length === 0)
        )
          throw new DomainError(
            "invalid_argument",
            "human decision recommendation references are invalid",
          );
        const body = encodeWireDocument(input.decision);
        if (Buffer.byteLength(body) > 8192)
          throw new DomainError("bound_exceeded", "human decision exceeds its byte bound");
        const decision = randomUlid();
        receipt = await advanceDiscussion(row, input.expected_version, ctx);
        await ctx.db
          .prepare(
            `INSERT INTO discussion_decisions (workspace_id, id, discussion_id, human_id, authorization_epoch, body_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            ctx.workspaceId,
            decision,
            row.id,
            principal.humanId,
            principal.authorizationEpoch,
            body,
            ctx.now,
          );
        receipt.decision_id = decision;
        break;
      }
    }
    return saveDiscussionReceipt(ctx, changeDiscussionCommand.name, input, receipt);
  },
};
