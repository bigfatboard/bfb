// ABOUTME: Proves A02 attention request, answer, resolve, ranking, and permission boundaries.
// ABOUTME: All fixtures are synthetic; runner authority comes from the shared launch fixture.

import { describe, expect, it } from "vitest";

import {
  answerAttentionCommand,
  ATTENTION_KIND_ROLES,
  attentionRoleSatisfies,
  getAttention,
  listAttention,
  listAttentionObservations,
  requestAttentionCommand,
  resolveAttentionCommand,
  type AttentionKind,
  type AttentionRecord,
} from "../src/attention.js";
import { bumpMemberEpoch } from "../src/authorization.js";
import { FIX } from "../src/fixtures.js";
import type { HubCommand } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import { claimLaunchCommand, startLaunchCommand } from "../src/launches.js";
import { createTaskCommand } from "../src/work-commands.js";
import { launchFixture, LAUNCH_NOW, success } from "./launch-fixture.js";

type Fixture = Awaited<ReturnType<typeof launchFixture>>;

interface BoundRun {
  runId: string;
  executionId: string;
  generation: number;
  taskId: string;
}

async function boundRun(f: Fixture): Promise<BoundRun> {
  const { claimed } = await f.claim();
  return {
    runId: claimed.specification.run_id,
    executionId: claimed.specification.run_execution_id,
    generation: claimed.specification.assignment_generation,
    taskId: f.task.id,
  };
}

let taskCounter = 0;

/**
 * One claim consumes its task and leases its checkout, so each independent
 * request gets a fresh task, checkout identity, and run on the same runner.
 */
async function freshBound(f: Fixture): Promise<BoundRun> {
  taskCounter += 1;
  const task = success(
    await f.human(createTaskCommand, {
      projectId: FIX.projectA,
      title: `Synthetic attention task ${taskCounter}`,
      priority: "P2",
    }),
  );
  const checkoutId = randomUlid();
  const current = f.inventory();
  await f.refresh(LAUNCH_NOW, {
    checkouts: [
      ...current.checkouts,
      {
        ...current.checkouts[0]!,
        checkout_id: checkoutId,
        physical_worktree_hash: `sha256:${String(taskCounter).padStart(64, "0")}`,
        label: `Synthetic attention checkout ${taskCounter}`,
        is_default: false,
      },
    ],
  });
  const launch = success(
    await f.human(startLaunchCommand, {
      ...f.start,
      idempotency_key: randomUlid(),
      task_id: task.id,
      expected_task_version: 1,
      checkout_id: checkoutId,
    }),
  );
  const claimed = success(
    await f.native(claimLaunchCommand, {
      principal: f.principal,
      claim: {
        schema_version: 1,
        launch_id: launch.launch_id,
        runner_id: f.runner,
        idempotency_key: randomUlid(),
        claimed_at: LAUNCH_NOW,
      },
    }),
  );
  if (claimed.state !== "claimed") throw new Error(claimed.state);
  return {
    runId: claimed.claim.specification.run_id,
    executionId: claimed.claim.specification.run_execution_id,
    generation: claimed.claim.specification.assignment_generation,
    taskId: task.id,
  };
}

function requestInput(
  f: Fixture,
  bound: BoundRun,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    principal: f.principal,
    runId: bound.runId,
    executionId: bound.executionId,
    assignmentGeneration: bound.generation,
    kind: "clarification",
    question: "Synthetic clarification question",
    blocking: true,
    ...overrides,
  };
}

async function requestAs<I, R>(f: Fixture, command: HubCommand<I, R>, input: I): Promise<R> {
  return success(
    await f.hub.execute(command, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      now: LAUNCH_NOW,
      input,
    }),
  );
}

async function answerAs(
  f: Fixture,
  humanId: string,
  input: { attentionId: string; expectedVersion: number; answer: string },
) {
  return f.hub.execute(answerAttentionCommand, {
    workspaceId: FIX.workspace,
    idempotencyKey: randomUlid(),
    actorHumanId: humanId,
    authorizationEpoch: 1,
    now: LAUNCH_NOW,
    input,
  });
}

describe("attention request", () => {
  it("commits an open request with derived permission and a requested observation", async () => {
    const f = await launchFixture();
    const bound = await boundRun(f);
    const record = success(await f.native(requestAttentionCommand, requestInput(f, bound)));
    expect(record.state).toBe("open");
    expect(record.kind).toBe("clarification");
    expect(record.required_role).toBe("reviewer");
    expect(record.blocking).toBe(true);
    expect(record.resource_version).toBe(1);
    expect(record.answer).toBeNull();
    expect(record.first_response_at).toBeNull();
    expect(record.requested_at).toBe(LAUNCH_NOW);
    expect(record.run_execution_id).toBe(bound.executionId);
    const observations = await listAttentionObservations(
      f.db,
      FIX.workspace,
      [FIX.projectA],
      record.id,
    );
    expect(observations.map((entry) => entry.observed_kind)).toEqual(["requested"]);
    expect(observations[0]?.actor_type).toBe("agent_run");
  });

  it("derives the required role from the kind", () => {
    expect(ATTENTION_KIND_ROLES.clarification).toBe("reviewer");
    expect(ATTENTION_KIND_ROLES.review).toBe("reviewer");
    expect(ATTENTION_KIND_ROLES.blocker).toBe("member");
    expect(ATTENTION_KIND_ROLES.credential).toBe("owner");
    expect(ATTENTION_KIND_ROLES.capability).toBe("owner");
    expect(ATTENTION_KIND_ROLES.destructive_action).toBe("owner");
    expect(attentionRoleSatisfies("reviewer", "reviewer")).toBe(true);
    expect(attentionRoleSatisfies("reviewer", "owner")).toBe(false);
    expect(attentionRoleSatisfies("member", "owner")).toBe(false);
    expect(attentionRoleSatisfies("owner", "owner")).toBe(true);
    expect(attentionRoleSatisfies("owner", "reviewer")).toBe(true);
  });

  it("replays the same idempotency key to the identical record", async () => {
    const f = await launchFixture();
    const bound = await boundRun(f);
    const key = randomUlid();
    const first = success(
      await f.hub.execute(requestAttentionCommand, {
        workspaceId: FIX.workspace,
        idempotencyKey: key,
        actorRunnerId: f.runner,
        authorizationEpoch: 1,
        now: LAUNCH_NOW,
        input: requestInput(f, bound),
      }),
    );
    const second = success(
      await f.hub.execute(requestAttentionCommand, {
        workspaceId: FIX.workspace,
        idempotencyKey: key,
        actorRunnerId: f.runner,
        authorizationEpoch: 1,
        now: LAUNCH_NOW,
        input: requestInput(f, bound, { question: "Synthetic changed retry" }),
      }),
    );
    expect(second).toEqual({ ...first, question: first.question });
    expect(second.id).toBe(first.id);
  });

  it("rejects unknown executions, foreign runs, and dangling references uniformly", async () => {
    const f = await launchFixture();
    const bound = await boundRun(f);
    const unknown = await f.native(
      requestAttentionCommand,
      requestInput(f, bound, { executionId: randomUlid() }),
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe("request_rejected");
    const foreign = await f.native(
      requestAttentionCommand,
      requestInput(f, bound, { runId: randomUlid() }),
    );
    expect(foreign.ok).toBe(false);
    const dangling = await f.native(
      requestAttentionCommand,
      requestInput(f, bound, { referenceKind: "artifact_version" }),
    );
    expect(dangling.ok).toBe(false);
    const oversized = await f.native(
      requestAttentionCommand,
      requestInput(f, bound, { question: "x".repeat(2049) }),
    );
    expect(oversized.ok).toBe(false);
  });

  it("refuses new requests once the run result is terminal", async () => {
    const f = await launchFixture();
    const bound = await boundRun(f);
    await f.db
      .prepare(`UPDATE runs SET result_state = 'accepted' WHERE workspace_id = ? AND id = ?`)
      .run(FIX.workspace, bound.runId);
    const outcome = await f.native(requestAttentionCommand, requestInput(f, bound));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("invalid_transition");
  });
});

describe("attention answer and resolve", () => {
  async function openRequest(
    f: Fixture,
    kind: AttentionKind = "clarification",
  ): Promise<AttentionRecord> {
    const bound = await freshBound(f);
    return success(await f.native(requestAttentionCommand, requestInput(f, bound, { kind })));
  }

  it("answers, keeps the waiter-visible metadata stable, and resolves", async () => {
    const f = await launchFixture();
    const record = await openRequest(f);
    const answered = success(
      await answerAs(f, FIX.owner, {
        attentionId: record.id,
        expectedVersion: 1,
        answer: "Synthetic committed answer",
      }),
    );
    expect(answered.state).toBe("answered");
    expect(answered.answer).toBe("Synthetic committed answer");
    expect(answered.answered_by_human_id).toBe(FIX.owner);
    expect(answered.first_response_at).toBe(LAUNCH_NOW);
    expect(answered.answered_at).toBe(LAUNCH_NOW);
    expect(answered.resource_version).toBe(2);
    const reread = await getAttention(f.db, FIX.workspace, [FIX.projectA], record.id);
    expect(reread).toEqual(answered);
    const resolved = success(
      await f.hub.execute(resolveAttentionCommand, {
        workspaceId: FIX.workspace,
        idempotencyKey: randomUlid(),
        actorHumanId: FIX.owner,
        authorizationEpoch: 1,
        now: LAUNCH_NOW,
        input: { attentionId: record.id, expectedVersion: 2 },
      }),
    );
    expect(resolved.state).toBe("resolved");
    expect(resolved.answer).toBe("Synthetic committed answer");
    expect(resolved.resolved_at).toBe(LAUNCH_NOW);
    expect(resolved.resource_version).toBe(3);
    const observations = await listAttentionObservations(
      f.db,
      FIX.workspace,
      [FIX.projectA],
      record.id,
    );
    expect(observations.map((entry) => entry.observed_kind)).toEqual([
      "requested",
      "answered",
      "resolved",
    ]);
    expect(new Set(observations.map((entry) => entry.observation_id)).size).toBe(3);
  });

  it("rejects duplicate answers without overwriting the committed response", async () => {
    const f = await launchFixture();
    const record = await openRequest(f);
    success(
      await answerAs(f, FIX.owner, {
        attentionId: record.id,
        expectedVersion: 1,
        answer: "Synthetic first answer",
      }),
    );
    const duplicate = await answerAs(f, FIX.member, {
      attentionId: record.id,
      expectedVersion: 2,
      answer: "Synthetic second answer",
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.code).toBe("already_answered");
    const reread = await getAttention(f.db, FIX.workspace, [FIX.projectA], record.id);
    expect(reread?.answer).toBe("Synthetic first answer");
    expect(reread?.answered_by_human_id).toBe(FIX.owner);
    expect(reread?.resource_version).toBe(2);
  });

  it("lets a reviewer answer clarification but never an owner-only credential request", async () => {
    const f = await launchFixture();
    const clarification = await openRequest(f, "clarification");
    const reviewerAnswer = await answerAs(f, FIX.reviewer, {
      attentionId: clarification.id,
      expectedVersion: 1,
      answer: "Synthetic reviewer answer",
    });
    expect(reviewerAnswer.ok).toBe(true);
    const credential = await openRequest(f, "credential");
    for (const humanId of [FIX.reviewer, FIX.member]) {
      const denied = await answerAs(f, humanId, {
        attentionId: credential.id,
        expectedVersion: 1,
        answer: "Synthetic unprivileged answer",
      });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe("forbidden");
    }
    const ownerAnswer = await answerAs(f, FIX.owner, {
      attentionId: credential.id,
      expectedVersion: 1,
      answer: "Synthetic owner answer",
    });
    expect(ownerAnswer.ok).toBe(true);
  });

  it("enforces versions and state order on answer and resolve", async () => {
    const f = await launchFixture();
    const record = await openRequest(f);
    const stale = await answerAs(f, FIX.owner, {
      attentionId: record.id,
      expectedVersion: 7,
      answer: "Synthetic stale answer",
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("stale_version");
    const earlyResolve = await f.hub.execute(resolveAttentionCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      now: LAUNCH_NOW,
      input: { attentionId: record.id, expectedVersion: 1 },
    });
    expect(earlyResolve.ok).toBe(false);
    if (!earlyResolve.ok) expect(earlyResolve.error.code).toBe("invalid_transition");
  });

  it("fails closed after membership epoch revocation", async () => {
    const f = await launchFixture();
    const record = await openRequest(f);
    await bumpMemberEpoch(f.db, FIX.workspace, FIX.owner);
    const revoked = await answerAs(f, FIX.owner, {
      attentionId: record.id,
      expectedVersion: 1,
      answer: "Synthetic revoked answer",
    });
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.error.code).toBe("stale_authorization");
  });

  it("grants no authority beyond the recorded decision", async () => {
    const f = await launchFixture();
    const record = await openRequest(f, "review");
    success(
      await answerAs(f, FIX.reviewer, {
        attentionId: record.id,
        expectedVersion: 1,
        answer: "Synthetic review answer",
      }),
    );
    const member = (await f.db
      .prepare(`SELECT role FROM workspace_members WHERE workspace_id = ? AND human_id = ?`)
      .get(FIX.workspace, FIX.reviewer)) as { role: string };
    expect(member.role).toBe("reviewer");
    const run = (await f.db
      .prepare(`SELECT result_state FROM runs WHERE workspace_id = ? AND id = ?`)
      .get(FIX.workspace, record.run_id)) as { result_state: string };
    expect(run.result_state).toBe("open");
  });
});

describe("attention reads and ranking", () => {
  it("ranks blocking severity, then kind, then oldest request deterministically", async () => {
    const f = await launchFixture();
    const bound = await boundRun(f);
    const late = success(
      await f.native(
        requestAttentionCommand,
        requestInput(f, bound, {
          kind: "blocker",
          blocking: true,
          question: "Synthetic late blocker",
        }),
      ),
    );
    await f.db
      .prepare(`UPDATE attention_requests SET requested_at = ? WHERE workspace_id = ? AND id = ?`)
      .run("2026-09-12T11:00:00.000Z", FIX.workspace, late.id);
    const items: Array<{ kind: AttentionKind; blocking: boolean; question: string }> = [
      { kind: "clarification", blocking: false, question: "Synthetic calm question" },
      { kind: "review", blocking: true, question: "Synthetic blocking review" },
      { kind: "credential", blocking: false, question: "Synthetic credential need" },
    ];
    for (const item of items) {
      success(await f.native(requestAttentionCommand, requestInput(f, bound, item)));
    }
    const ranked = await listAttention(f.db, FIX.workspace, [FIX.projectA]);
    expect(ranked.map((entry) => entry.question)).toEqual([
      "Synthetic late blocker",
      "Synthetic blocking review",
      "Synthetic credential need",
      "Synthetic calm question",
    ]);
    for (const entry of ranked) {
      expect(entry.rank_reason).toContain(entry.kind);
      expect(entry.task_title).toBe("Synthetic C09 task");
      expect(entry.project_name).toBe("Alpha");
      expect(entry.run_result_state).toBe("open");
    }
  });

  it("keeps cross-project requests hidden from ungranted readers", async () => {
    const f = await launchFixture();
    const bound = await boundRun(f);
    const record = success(await f.native(requestAttentionCommand, requestInput(f, bound)));
    expect(await getAttention(f.db, FIX.workspace, [FIX.projectB], record.id)).toBeNull();
    expect(await listAttention(f.db, FIX.workspace, [FIX.projectB])).toEqual([]);
    expect(await listAttention(f.db, FIX.workspace, [])).toEqual([]);
    const filtered = await listAttention(f.db, FIX.workspace, [FIX.projectA], { state: "open" });
    expect(filtered.map((entry) => entry.id)).toEqual([record.id]);
    const answered = await listAttention(f.db, FIX.workspace, [FIX.projectA], {
      state: "answered",
    });
    expect(answered).toEqual([]);
  });

  it("validates read bounds", async () => {
    const f = await launchFixture();
    await expect(listAttention(f.db, FIX.workspace, [FIX.projectA], { limit: 0 })).rejects.toThrow();
    await expect(
      listAttention(f.db, FIX.workspace, [FIX.projectA], { state: "bogus" as never }),
    ).rejects.toThrow();
    expect(await getAttention(f.db, FIX.workspace, [FIX.projectA], "not-a-ulid")).toBeNull();
  });
});
