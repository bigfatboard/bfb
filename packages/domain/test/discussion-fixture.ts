// ABOUTME: Builds synthetic human, runner, frozen-context and headless-profile fixtures for discussion acceptance.
// ABOUTME: Seeds observed sessions only at an explicit trusted-runtime test boundary, never through public human commands.

import type {
  DiscussionCreateRequest,
  DiscussionReceipt,
  DiscussionTurnRequest,
} from "@bfb/protocol";
import type { SqlDatabase } from "@bfb/db";

import { FIX } from "../src/fixtures.js";
import { randomUlid } from "../src/ids.js";
import type { HubCommand } from "../src/hub.js";
import { createAgentProfileCommand } from "../src/projects.js";
import { addContextCommand } from "../src/work-commands.js";
import { createDiscussionCommand } from "../src/discussions.js";
import { changeDiscussionTurnCommand } from "../src/discussion-turns.js";
import type {
  DiscussionDelivery,
  DiscussionParticipant,
  DiscussionRow,
  DiscussionTurn,
} from "../src/discussion-records.js";
import { LAUNCH_NOW, launchFixture, success } from "./launch-fixture.js";

export const SYNTHETIC_QUESTION =
  "Compare the two synthetic alternatives without implementing either.";
export const HUMAN_ONLY_CANARY = "SYNTHETIC-HUMAN-ONLY-DISCUSSION-CANARY";
export const SYNTHETIC_OUTPUT = {
  schema_version: 1 as const,
  recommendation: "Prefer the bounded synthetic alternative.",
  reasons: ["It preserves explicit human control."],
  evidence: [],
  agreement: [],
  disagreements: [],
  human_questions: ["Which tradeoff is acceptable?"],
};

export async function discussionFixture(database?: SqlDatabase) {
  const fixture = await launchFixture(database);
  const profiles = [];
  for (const provider of ["claude", "codex"] as const)
    profiles.push(
      success(
        await fixture.human(createAgentProfileCommand, {
          name: `Synthetic ${provider} discussion`,
          provider,
          model: "synthetic",
          executionMode: "headless",
          harnessMode: "restricted",
        }),
      ),
    );
  const context = success(
    await fixture.human(addContextCommand, {
      taskId: fixture.task.id,
      kind: "constraint",
      audience: "agent",
      body: "Synthetic shared read-only boundary.",
    }),
  );
  success(
    await fixture.human(addContextCommand, {
      taskId: fixture.task.id,
      kind: "note",
      audience: "human",
      body: HUMAN_ONLY_CANARY,
    }),
  );
  const input: DiscussionCreateRequest = {
    schema_version: 1,
    idempotency_key: randomUlid(),
    task_id: fixture.task.id,
    expected_task_version: 1,
    question: SYNTHETIC_QUESTION,
    git_revision: "a".repeat(40),
    workspace_policy_version: 2,
    project_policy_version: 2,
    repository_config_version: 2,
    participants: profiles.map((profile) => ({
      agent_profile_id: profile.id,
      agent_profile_version: 1,
      runner_id: fixture.runner,
      checkout_id: fixture.checkout,
    })),
  };
  function run<I, R>(command: HubCommand<I, R>, runId: string, input: I, now = LAUNCH_NOW) {
    return fixture.hub.execute(command, {
      workspaceId: FIX.workspace,
      actorSystemId: runId,
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      now,
      input,
    });
  }
  async function row(id: string) {
    return (await fixture.db
      .prepare(`SELECT * FROM discussions WHERE workspace_id = ? AND id = ?`)
      .get(FIX.workspace, id)) as DiscussionRow;
  }
  async function participants(id: string) {
    return (await fixture.db
      .prepare(
        `SELECT * FROM discussion_participants WHERE workspace_id = ? AND discussion_id = ? ORDER BY slot`,
      )
      .all(FIX.workspace, id)) as DiscussionParticipant[];
  }
  async function turns(id: string) {
    return (await fixture.db
      .prepare(
        `SELECT * FROM discussion_turns WHERE workspace_id = ? AND discussion_id = ? ORDER BY ordinal`,
      )
      .all(FIX.workspace, id)) as DiscussionTurn[];
  }
  async function session(participant: DiscussionParticipant, observedId?: string) {
    const existing = (await fixture.db
      .prepare(`SELECT id FROM provider_sessions WHERE workspace_id = ? AND run_id = ?`)
      .get(FIX.workspace, participant.run_id)) as { id: string } | undefined;
    if (existing) return existing.id;
    const execution = randomUlid(),
      id = randomUlid();
    await fixture.db
      .prepare(
        `INSERT INTO run_executions (workspace_id, id, run_id, state, resource_version, created_at) VALUES (?, ?, ?, 'attached', 1, ?)`,
      )
      .run(FIX.workspace, execution, participant.run_id, LAUNCH_NOW);
    await fixture.db
      .prepare(
        `INSERT INTO provider_sessions (workspace_id, id, run_id, execution_id, provider, observed_session_id, state, resource_version, started_at) VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?)`,
      )
      .run(
        FIX.workspace,
        id,
        participant.run_id,
        execution,
        participant.slot === 0 ? "claude" : "codex",
        observedId ?? `synthetic-discussion-session-${id}`,
        LAUNCH_NOW,
      );
    return id;
  }
  async function turnInput(
    id: string,
    ordinal: number,
    action: DiscussionTurnRequest["action"],
    extra: Record<string, unknown> = {},
  ) {
    const discussion = await row(id),
      turn = (await turns(id))[ordinal - 1]!;
    const delivery = (await fixture.db
      .prepare(`SELECT * FROM discussion_deliveries WHERE workspace_id = ? AND turn_id = ?`)
      .get(FIX.workspace, turn.id)) as DiscussionDelivery | undefined;
    return {
      schema_version: 1,
      idempotency_key: randomUlid(),
      discussion_id: id,
      expected_version: discussion.resource_version,
      turn_id: turn.id,
      expected_turn_version: turn.resource_version,
      action,
      ...(action === "accept"
        ? {}
        : { delivery_id: delivery?.id, expected_delivery_version: delivery?.resource_version }),
      ...extra,
    } as DiscussionTurnRequest;
  }
  async function phase(
    id: string,
    ordinal: number,
    action: DiscussionTurnRequest["action"],
    extra: Record<string, unknown> = {},
  ): Promise<DiscussionReceipt> {
    const participant = (await participants(id))[(ordinal - 1) % 2]!;
    const input = await turnInput(id, ordinal, action, extra);
    return success(await run(changeDiscussionTurnCommand, participant.run_id, input));
  }
  async function complete(id: string, ordinal: number) {
    await phase(id, ordinal, "accept");
    await phase(id, ordinal, "dispatch");
    const participant = (await participants(id))[(ordinal - 1) % 2]!;
    const sessionId = await session(participant);
    await phase(id, ordinal, "acknowledge", { session_id: sessionId });
    return phase(id, ordinal, "complete", { session_id: sessionId, output: SYNTHETIC_OUTPUT });
  }
  async function create(changes: Partial<DiscussionCreateRequest> = {}) {
    return success(await fixture.human(createDiscussionCommand, { ...input, ...changes }));
  }
  return {
    ...fixture,
    input,
    profiles,
    context,
    row,
    participants,
    turns,
    run,
    create,
    session,
    turnInput,
    phase,
    complete,
  };
}
