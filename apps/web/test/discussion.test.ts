// ABOUTME: Checks D03 request allowlists and discussion presentation rules.
// ABOUTME: Every blocking condition maps to an actionable state; prose never completes work.

import { describe, expect, it } from "vitest";
import { randomUlid } from "@bfb/domain";

import {
  buildChangeRequest,
  buildCreateRequest,
  type AgentProfileRecord,
  type DiscussionView,
} from "../src/discussion/api.js";
import {
  canStartDiscussion,
  completedTurns,
  currentSpeaker,
  decisionSummary,
  describeDeadline,
  describeDelivery,
  describeSlotEligibility,
  describeStop,
  humanQuestions,
  independentPositions,
  openDisagreements,
  totalRounds,
  type CheckoutInput,
  type EligibilityResult,
  type RunnerInput,
} from "../src/discussion/presentation.js";

const CREATE_REQUIRED_KEYS = [
  "expected_task_version",
  "git_revision",
  "idempotency_key",
  "participants",
  "project_policy_version",
  "question",
  "repository_config_version",
  "schema_version",
  "task_id",
  "workspace_policy_version",
].sort();

const CREATE_ALLOWED_KEYS = [...CREATE_REQUIRED_KEYS, "duration_seconds", "rounds"].sort();

function profile(overrides: Partial<AgentProfileRecord> = {}): AgentProfileRecord {
  return {
    id: randomUlid(),
    name: "Synthetic Claude discussion",
    provider: "claude",
    model: "synthetic",
    execution_mode: "headless",
    harness_mode: "restricted",
    resource_version: 1,
    ...overrides,
  };
}

function runner(overrides: Partial<RunnerInput> = {}): RunnerInput {
  return {
    runner_id: randomUlid(),
    device_label: "Synthetic Mac",
    status: "enrolled",
    launcher_human_ids: ["human-a"],
    owner_human_id: "human-a",
    ...overrides,
  };
}

function checkout(overrides: Partial<CheckoutInput> = {}): CheckoutInput {
  return {
    checkout_id: randomUlid(),
    runner_id: randomUlid(),
    project_id: randomUlid(),
    label: "Synthetic checkout",
    status: "validated",
    inventory_valid: true,
    ...overrides,
  };
}

function slot(
  overrides: Partial<Parameters<typeof describeSlotEligibility>[0]> = {},
): EligibilityResult {
  return describeSlotEligibility({
    profile: profile(),
    runner: runner(),
    checkout: checkout(),
    checkoutOccupied: false,
    humanId: "human-a",
    ...overrides,
  });
}

function discussionView(overrides: Partial<DiscussionView> = {}): DiscussionView {
  const firstParticipant = randomUlid();
  const secondParticipant = randomUlid();
  const firstTurn = randomUlid();
  const secondTurn = randomUlid();
  const firstMessage = randomUlid();
  const secondMessage = randomUlid();
  return {
    schema_version: 1,
    scope: "human",
    discussion_id: randomUlid(),
    task_id: randomUlid(),
    state: "active",
    version: 1,
    deadline: "2026-08-07T12:15:00.000Z",
    brief_hash: "sha256:brief",
    brief: {
      schema_version: 1,
      task_id: randomUlid(),
      title: "Synthetic issue",
      question: "Which synthetic alternative holds?",
      git_revision: "a".repeat(40),
      context: [],
    },
    participants: [
      {
        id: firstParticipant,
        run_id: randomUlid(),
        agent_profile_id: randomUlid(),
        name: "Synthetic Claude",
        provider: "claude",
        runner_id: randomUlid(),
        checkout_id: randomUlid(),
      },
      {
        id: secondParticipant,
        run_id: randomUlid(),
        agent_profile_id: randomUlid(),
        name: "Synthetic Codex",
        provider: "codex",
        runner_id: randomUlid(),
        checkout_id: randomUlid(),
      },
    ],
    turns: [
      {
        id: firstTurn,
        participant_id: firstParticipant,
        ordinal: 1,
        state: "completed",
        version: 2,
        delivery: { id: randomUlid(), version: 3, state: "completed", source_message_ids: [] },
      },
      {
        id: secondTurn,
        participant_id: secondParticipant,
        ordinal: 2,
        state: "active",
        version: 2,
        delivery: {
          id: randomUlid(),
          version: 2,
          state: "acknowledged",
          session_id: "session-b",
          source_message_ids: [firstMessage],
        },
      },
    ],
    messages: [
      {
        id: firstMessage,
        kind: "recommendation",
        created_at: "2026-08-07T12:01:00.000Z",
        participant_id: firstParticipant,
        run_id: randomUlid(),
        session_id: "session-a",
        turn_id: firstTurn,
        output: {
          schema_version: 1,
          recommendation: "Prefer the bounded alternative.",
          reasons: ["It preserves explicit human control."],
          evidence: [],
          agreement: [],
          disagreements: [],
          human_questions: ["Which tradeoff is acceptable?"],
        },
      },
      {
        id: secondMessage,
        kind: "recommendation",
        created_at: "2026-08-07T12:02:00.000Z",
        participant_id: secondParticipant,
        run_id: randomUlid(),
        session_id: "session-b",
        turn_id: secondTurn,
        output: {
          schema_version: 1,
          recommendation: "Prefer the simpler alternative.",
          reasons: ["It keeps the exchange inspectable."],
          evidence: [
            {
              kind: "repository",
              repository_path: "src/synthetic.ts",
              git_revision: "a".repeat(40),
              explanation: "Bounded reference at the frozen revision.",
            },
          ],
          agreement: [],
          disagreements: [{ message_id: firstMessage, reason: "The bound costs too much." }],
          human_questions: [],
        },
      },
    ],
    ...overrides,
  };
}

describe("d03 discussion request builders", () => {
  it("emits the exact D01 create fields and no execution authority", () => {
    const body = buildCreateRequest({
      taskId: randomUlid(),
      expectedTaskVersion: 3,
      question: "Which synthetic alternative holds?",
      gitRevision: "a".repeat(40),
      workspacePolicyVersion: 2,
      projectPolicyVersion: 2,
      repositoryConfigVersion: 2,
      participants: [
        {
          agentProfileId: randomUlid(),
          agentProfileVersion: 1,
          runnerId: randomUlid(),
          checkoutId: randomUlid(),
        },
        {
          agentProfileId: randomUlid(),
          agentProfileVersion: 1,
          runnerId: randomUlid(),
          checkoutId: randomUlid(),
        },
      ],
      rounds: 3,
      durationSeconds: 900,
      idempotencyKey: randomUlid(),
    });
    for (const key of CREATE_REQUIRED_KEYS) {
      expect(body).toHaveProperty(key);
    }
    for (const key of Object.keys(body)) {
      expect(CREATE_ALLOWED_KEYS).toContain(key);
    }
    expect(JSON.stringify(body)).not.toMatch(/command|argv|executable|lease|path|cwd/i);
    expect(body.participants).toHaveLength(2);
  });

  it("omits optional rounds and duration when unset", () => {
    const body = buildCreateRequest({
      taskId: randomUlid(),
      expectedTaskVersion: 1,
      question: "Which synthetic alternative holds?",
      gitRevision: "a".repeat(40),
      workspacePolicyVersion: 1,
      projectPolicyVersion: 1,
      repositoryConfigVersion: 1,
      participants: [
        {
          agentProfileId: randomUlid(),
          agentProfileVersion: 1,
          runnerId: randomUlid(),
          checkoutId: randomUlid(),
        },
        {
          agentProfileId: randomUlid(),
          agentProfileVersion: 1,
          runnerId: randomUlid(),
          checkoutId: randomUlid(),
        },
      ],
      idempotencyKey: randomUlid(),
    });
    expect(Object.keys(body).sort()).toEqual(CREATE_REQUIRED_KEYS);
  });

  it("builds exact change requests per human action", () => {
    const discussionId = randomUlid();
    const intervene = buildChangeRequest({
      discussionId,
      expectedVersion: 2,
      action: "intervene",
      text: "Consider the frozen brief.",
      idempotencyKey: randomUlid(),
    });
    expect(intervene).toMatchObject({ schema_version: 1, action: "intervene" });
    const cancel = buildChangeRequest({
      discussionId,
      expectedVersion: 2,
      action: "cancel",
      idempotencyKey: randomUlid(),
    });
    expect(Object.keys(cancel).sort()).toEqual(
      ["action", "discussion_id", "expected_version", "idempotency_key", "schema_version"].sort(),
    );
    const decide = buildChangeRequest({
      discussionId,
      expectedVersion: 4,
      action: "decide",
      decision: { kind: "record_recommendation", summary: "Take the bounded one.", recommendationIds: ["m1"] },
      idempotencyKey: randomUlid(),
    });
    expect(decide).toMatchObject({
      action: "decide",
      decision: { kind: "record_recommendation", recommendation_ids: ["m1"] },
    });
  });
});

describe("d03 participant eligibility", () => {
  it("marks a restricted headless slot eligible without promising delivery", () => {
    const result = slot();
    expect(result.status).toBe("eligible");
    expect(result.nextAction).toMatch(/reauthorizes/);
  });

  it("reports revoked runners and missing grants as revoked", () => {
    expect(slot({ runner: runner({ status: "revoked" }) }).status).toBe("revoked");
    expect(slot({ runner: undefined }).status).toBe("revoked");
    expect(
      slot({ runner: runner({ owner_human_id: "human-b", launcher_human_ids: [] }) }).status,
    ).toBe("revoked");
  });

  it("reports missing inventory as offline, never as idle activity", () => {
    const result = slot({ checkout: undefined });
    expect(result.status).toBe("offline");
    expect(`${result.headline} ${result.nextAction}`).not.toMatch(/idle|working/i);
  });

  it("reports unsupported providers and modes distinctly", () => {
    expect(slot({ profile: profile({ provider: "grok" }) }).status).toBe("unsupported");
    expect(slot({ profile: profile({ execution_mode: "interactive" }) }).status).toBe(
      "unsupported",
    );
    expect(slot({ profile: profile({ harness_mode: "standard" }) }).status).toBe("unsupported");
    expect(slot({ profile: profile({ provider: "grok" }) }).nextAction).toMatch(/Claude or Codex/);
  });

  it("reports stale, blocked, and busy checkouts as conflicts", () => {
    expect(slot({ checkout: checkout({ status: "stale" }) }).status).toBe("checkout_conflict");
    expect(
      slot({ checkout: checkout({ status: "validated", block_reason: "occupied" }) }).status,
    ).toBe("checkout_conflict");
    expect(slot({ checkoutOccupied: true }).status).toBe("busy");
  });

  it("requires two eligible slots before starting", () => {
    expect(canStartDiscussion(slot(), slot())).toBe(true);
    expect(canStartDiscussion(slot(), slot({ checkoutOccupied: true }))).toBe(false);
  });
});

describe("d03 discussion presentation", () => {
  it("names the current speaker, round, and turn bounds", () => {
    const view = discussionView();
    const speaker = currentSpeaker(view);
    expect(speaker).toMatchObject({ ordinal: 2, round: 1, provider: "codex" });
    expect(totalRounds(view)).toBe(1);
    expect(completedTurns(view)).toBe(1);
  });

  it("returns no speaker once every bounded turn settles", () => {
    const view = discussionView({
      turns: discussionView().turns.map((turn) => ({ ...turn, state: "completed" as const })),
    });
    expect(currentSpeaker(view)).toBeNull();
  });

  it("labels every delivery state without implying work", () => {
    expect(describeDelivery("accepted").headline).toBe("Queued");
    expect(describeDelivery("accepted").detail).toMatch(/Nothing has run/);
    expect(describeDelivery("dispatched").tone).toBe("active");
    expect(describeDelivery("acknowledged").tone).toBe("active");
    expect(describeDelivery("completed").tone).toBe("settled");
    expect(describeDelivery("ambiguous").detail).toMatch(/nothing was resent/i);
    expect(describeDelivery("failed").tone).toBe("blocked");
  });

  it("marks cancel, deadline, failure, and conclusion as stopped", () => {
    expect(describeStop(discussionView({ state: "cancelled" })).stopped).toBe(true);
    expect(
      describeStop(discussionView({ state: "failed", reason: "deadline_exceeded" })).headline,
    ).toBe("Deadline exceeded");
    expect(
      describeStop(discussionView({ state: "failed", reason: "delivery_ambiguous" })).detail,
    ).toMatch(/uncertainty remains visible/);
    expect(describeStop(discussionView({ state: "concluded" })).stopped).toBe(true);
    expect(describeStop(discussionView({ state: "paused" })).stopped).toBe(true);
    expect(describeStop(discussionView()).stopped).toBe(false);
    expect(
      describeStop(discussionView({ dispatch_block_reason: "deadline_exceeded" })).stopped,
    ).toBe(true);
  });

  it("renders the deadline against the supplied clock", () => {
    const view = discussionView();
    expect(describeDeadline(view.deadline, Date.parse("2026-08-07T12:00:00.000Z")).expired).toBe(
      false,
    );
    expect(describeDeadline(view.deadline, Date.parse("2026-08-07T12:15:00.000Z"))).toMatchObject({
      headline: "Deadline exceeded",
      expired: true,
    });
    expect(describeDeadline("not-a-time", 0).headline).toBe("Deadline unknown");
  });

  it("keeps independent initial positions and disagreements inspectable", () => {
    const view = discussionView();
    const positions = independentPositions(view);
    expect(positions).toHaveLength(2);
    expect(positions[0]).toMatchObject({ provider: "claude" });
    const disagreements = openDisagreements(view);
    expect(disagreements).toHaveLength(1);
    expect(disagreements[0]).toMatchObject({
      fromParticipantName: "Synthetic Codex",
      targetParticipantName: "Synthetic Claude",
    });
    expect(humanQuestions(view)).toEqual([
      { messageId: view.messages[0]!.id, question: "Which tradeoff is acceptable?" },
    ]);
  });

  it("attributes disagreements with unknown targets honestly", () => {
    const view = discussionView();
    const broken = {
      ...view.messages[1]!,
      output: {
        ...view.messages[1]!.output!,
        disagreements: [{ message_id: randomUlid(), reason: "Unknown target." }],
      },
    };
    const disagreements = openDisagreements({ ...view, messages: [broken] });
    expect(disagreements[0]?.targetParticipantName).toBe("Unknown message");
  });

  it("keeps the human decision distinct from agent recommendations", () => {
    const view = discussionView({
      state: "concluded",
      decision: {
        id: randomUlid(),
        human_id: "human-a",
        kind: "record_recommendation",
        summary: "Take the bounded alternative.",
        recommendation_ids: ["m1"],
        created_at: "2026-08-07T12:20:00.000Z",
      },
    });
    const summary = decisionSummary(view);
    expect(summary).toMatch(/Recorded recommendation/);
    expect(summary).not.toContain("completes the task");
    expect(decisionSummary(discussionView())).toBeNull();
  });
});
