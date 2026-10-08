// ABOUTME: Proves discussion authority, frozen context and purpose isolation before provider execution exists.
// ABOUTME: Exercises duplicate, concurrent, out-of-order and terminal transitions against the migrated tenant database.

import { describe, expect, it } from "vitest";
import type { DiscussionChangeRequest, DiscussionCreateRequest } from "@bfb/protocol";

import { FIX } from "../src/fixtures.js";
import { randomUlid } from "../src/ids.js";
import { createDiscussionCommand, changeDiscussionCommand } from "../src/discussions.js";
import { changeDiscussionTurnCommand } from "../src/discussion-turns.js";
import {
  createExecutionCommand,
  createProviderSessionCommand,
  createRunCommand,
  transitionExecutionCommand,
  updateRunActivityCommand,
} from "../src/work-records.js";
import { addContextCommand, deliverRunAgentContextCommand } from "../src/work-commands.js";
import {
  discussionFixture,
  HUMAN_ONLY_CANARY,
  SYNTHETIC_OUTPUT,
  SYNTHETIC_QUESTION,
} from "./discussion-fixture.js";
import { LAUNCH_NOW, success } from "./launch-fixture.js";

function change(
  id: string,
  version: number,
  action: DiscussionChangeRequest["action"],
  extra: Record<string, unknown> = {},
): DiscussionChangeRequest {
  return {
    schema_version: 1,
    idempotency_key: randomUlid(),
    discussion_id: id,
    expected_version: version,
    action,
    ...extra,
  } as DiscussionChangeRequest;
}

describe("discussion records and authority", () => {
  it("creates two frozen discussion runs without changing ordinary task work or exposing human-only context", async () => {
    const f = await discussionFixture();
    const before = await f.db
      .prepare(`SELECT * FROM tasks WHERE workspace_id = ? AND id = ?`)
      .get(FIX.workspace, f.task.id);
    const created = await f.create();
    expect(created.run_ids).toHaveLength(2);
    expect(
      await f.db
        .prepare(`SELECT * FROM tasks WHERE workspace_id = ? AND id = ?`)
        .get(FIX.workspace, f.task.id),
    ).toEqual(before);
    const row = await f.row(created.discussion_id);
    expect(row.state).toBe("active");
    expect(row.brief_json).toContain(SYNTHETIC_QUESTION);
    expect(row.brief_json).not.toContain(HUMAN_ONLY_CANARY);
    expect(await f.turns(row.id)).toHaveLength(6);
    expect(
      await f.db
        .prepare(`SELECT purpose, result_state FROM runs WHERE workspace_id = ? AND id IN (?, ?)`)
        .all(FIX.workspace, ...created.run_ids!),
    ).toEqual([
      { purpose: "discussion", result_state: "open" },
      { purpose: "discussion", result_state: "open" },
    ]);
    expect(await f.db.prepare(`SELECT COUNT(*) AS count FROM launch_commands`).get()).toEqual({
      count: 0,
    });
    expect(await f.db.prepare(`SELECT COUNT(*) AS count FROM run_executions`).get()).toEqual({
      count: 0,
    });
    const events = await f.db
      .prepare(`SELECT payload_json FROM semantic_events WHERE kind = 'discussion.create'`)
      .all();
    expect(JSON.stringify(events)).not.toContain(SYNTHETIC_QUESTION);
    expect(JSON.stringify(events)).not.toContain(HUMAN_ONLY_CANARY);
  });

  it.each(["proposed", "active", "review", "blocked", "done", "cancelled"])(
    "preserves a %s task and all existing work-run results",
    async (state) => {
      const f = await discussionFixture();
      const work = success(
        await f.human(createRunCommand, {
          taskId: f.task.id,
          expectedTaskVersion: 1,
          agentProfileId: f.profile.id,
          workspacePolicyVersion: 2,
          projectPolicyVersion: 2,
          repositoryConfigVersion: 2,
          agentProfileVersion: 1,
        }),
      );
      await f.db
        .prepare(`UPDATE tasks SET state = ? WHERE workspace_id = ? AND id = ?`)
        .run(state, FIX.workspace, f.task.id);
      const before = await f.db
        .prepare(`SELECT * FROM tasks WHERE workspace_id = ? AND id = ?`)
        .get(FIX.workspace, f.task.id);
      const original = await f.db
        .prepare(`SELECT * FROM runs WHERE workspace_id = ? AND id = ?`)
        .get(FIX.workspace, work.run.id);
      const created = await f.create({ expected_task_version: 2 });
      success(await f.human(changeDiscussionCommand, change(created.discussion_id, 1, "cancel")));
      expect(
        await f.db
          .prepare(`SELECT * FROM tasks WHERE workspace_id = ? AND id = ?`)
          .get(FIX.workspace, f.task.id),
      ).toEqual(before);
      expect(
        await f.db
          .prepare(`SELECT * FROM runs WHERE workspace_id = ? AND id = ?`)
          .get(FIX.workspace, work.run.id),
      ).toEqual(original);
    },
  );

  it("deduplicates creation and intervention while rejecting changed keys and concurrent stale edits", async () => {
    const f = await discussionFixture();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => f.human(createDiscussionCommand, f.input)),
    );
    const ids = results.map((result) => success(result).discussion_id);
    expect(new Set(ids).size).toBe(1);
    expect(
      await f.db.prepare(`SELECT COUNT(*) AS count FROM discussion_participants`).get(),
    ).toEqual({ count: 2 });
    expect(
      await f.human(createDiscussionCommand, {
        ...f.input,
        question: "Changed synthetic question",
      }),
    ).toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });
    const input = change(ids[0]!, 1, "intervene", { text: "Synthetic human clarification" });
    const first = success(await f.human(changeDiscussionCommand, input));
    expect(success(await f.human(changeDiscussionCommand, input))).toEqual(first);
    const raced = await Promise.all(
      ["First", "Second"].map((text) =>
        f.human(changeDiscussionCommand, change(ids[0]!, 2, "intervene", { text })),
      ),
    );
    expect(raced.filter((result) => result.ok)).toHaveLength(1);
    expect(
      raced.filter((result) => !result.ok && result.error.code === "stale_version"),
    ).toHaveLength(1);
    expect(await f.db.prepare(`SELECT COUNT(*) AS count FROM discussion_messages`).get()).toEqual({
      count: 2,
    });
  });

  it("blocks ordinary work commands and live-context reads for discussion-purpose runs", async () => {
    const f = await discussionFixture(),
      created = await f.create(),
      run = created.run_ids![0]!;
    expect(await f.human(createExecutionCommand, { runId: run })).toMatchObject({ ok: false });
    expect(
      await f.human(updateRunActivityCommand, {
        runId: run,
        expectedVersion: 1,
        activity: "working",
      }),
    ).toMatchObject({ ok: false });
    expect(await f.run(deliverRunAgentContextCommand, run, { taskId: f.task.id })).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    const participant = (await f.participants(created.discussion_id))[0]!;
    const session = await f.session(participant);
    const execution = (await f.db
      .prepare("SELECT execution_id FROM provider_sessions WHERE id = ?")
      .get(session)) as { execution_id: string };
    expect(
      await f.human(createProviderSessionCommand, {
        runId: run,
        executionId: execution.execution_id,
        provider: "claude",
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(
      await f.human(transitionExecutionCommand, {
        runId: run,
        executionId: execution.execution_id,
        expectedVersion: 1,
        state: "ended",
        endReason: "process_exit",
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    await expect(
      f.db
        .prepare(`UPDATE runs SET purpose = 'work' WHERE workspace_id = ? AND id = ?`)
        .run(FIX.workspace, run),
    ).rejects.toThrow(/immutable/);
    for (const state of ["submitted", "accepted", "changes_requested"])
      await expect(
        f.db
          .prepare(`UPDATE runs SET result_state = ? WHERE workspace_id = ? AND id = ?`)
          .run(state, FIX.workspace, run),
      ).rejects.toThrow(/cannot submit or accept/);
  });

  it("rejects delegated, reviewer, foreign, inaccessible and forged participant authority without discussion state", async () => {
    const f = await discussionFixture();
    expect(await f.human(createDiscussionCommand, f.input, LAUNCH_NOW, FIX.reviewer)).toMatchObject(
      { ok: false },
    );
    expect(
      await f.hub.execute(createDiscussionCommand, {
        workspaceId: FIX.workspace,
        actorHumanId: FIX.owner,
        actorDelegationId: randomUlid(),
        authorizationEpoch: 1,
        idempotencyKey: randomUlid(),
        now: LAUNCH_NOW,
        input: f.input,
      }),
    ).toMatchObject({ ok: false });
    expect(
      await f.hub.execute(createDiscussionCommand, {
        workspaceId: randomUlid(),
        actorHumanId: FIX.owner,
        authorizationEpoch: 1,
        idempotencyKey: randomUlid(),
        now: LAUNCH_NOW,
        input: f.input,
      }),
    ).toMatchObject({ ok: false });
    await f.db
      .prepare(
        `DELETE FROM project_access WHERE workspace_id = ? AND project_id = ? AND human_id = ?`,
      )
      .run(FIX.workspace, FIX.projectA, FIX.owner);
    expect(await f.human(createDiscussionCommand, f.input)).toMatchObject({ ok: false });
    expect(await f.db.prepare(`SELECT COUNT(*) AS count FROM discussions`).get()).toEqual({
      count: 0,
    });
  });

  it("rechecks revoked human and named runner grants before returning prior creation receipts", async () => {
    const f = await discussionFixture();
    await f.create();
    await f.db
      .prepare(
        `UPDATE runner_launch_grants SET revoked_at = ? WHERE workspace_id = ? AND runner_id = ? AND human_id = ?`,
      )
      .run(LAUNCH_NOW, FIX.workspace, f.runner, FIX.owner);
    expect(await f.human(createDiscussionCommand, f.input)).toMatchObject({ ok: false });
    expect(await f.db.prepare(`SELECT COUNT(*) AS count FROM discussions`).get()).toEqual({
      count: 1,
    });
  });

  it("rejects an unbounded or malformed roster and shared brief atomically", async () => {
    const f = await discussionFixture();
    const cases: unknown[] = [
      { ...f.input, participants: [f.input.participants[0]] },
      { ...f.input, participants: [f.input.participants[0], f.input.participants[0]] },
      { ...f.input, rounds: 4 },
      { ...f.input, duration_seconds: 3601 },
      { ...f.input, prompt: "forbidden" },
      {
        ...f.input,
        participants: [
          { ...f.input.participants[0], checkout_id: randomUlid() },
          f.input.participants[1],
        ],
      },
    ];
    for (const input of cases)
      expect(
        await f.human(createDiscussionCommand, input as DiscussionCreateRequest),
      ).toMatchObject({ ok: false });
    for (let index = 0; index < 5; index++)
      success(
        await f.human(addContextCommand, {
          taskId: f.task.id,
          kind: "constraint",
          audience: "agent",
          body: "x".repeat(16_384),
        }),
      );
    expect(await f.human(createDiscussionCommand, f.input)).toMatchObject({
      ok: false,
      error: { code: "bound_exceeded" },
    });
    expect(
      await f.db.prepare(`SELECT COUNT(*) AS count FROM discussion_participants`).get(),
    ).toEqual({ count: 0 });
  });

  it("binds independent initial positions, exact sessions and intentional output before concluding and deciding", async () => {
    const f = await discussionFixture(),
      created = await f.create({ rounds: 1 }),
      id = created.discussion_id;
    const participants = await f.participants(id);
    const before = await f.db
      .prepare(`SELECT * FROM tasks WHERE workspace_id = ? AND id = ?`)
      .get(FIX.workspace, f.task.id);
    const first = await f.complete(id, 1);
    await f.phase(id, 2, "accept");
    const secondTurn = (await f.turns(id))[1]!;
    expect(
      await f.db
        .prepare(
          `SELECT source_message_ids_json FROM discussion_deliveries WHERE workspace_id = ? AND turn_id = ?`,
        )
        .get(FIX.workspace, secondTurn.id),
    ).toEqual({ source_message_ids_json: "[]" });
    await f.phase(id, 2, "dispatch");
    const session = await f.session(participants[1]!);
    await f.phase(id, 2, "acknowledge", { session_id: session });
    const bad = await f.turnInput(id, 2, "complete", {
      session_id: session,
      output: {
        ...SYNTHETIC_OUTPUT,
        agreement: [{ message_id: first.message_id, reason: "I must not see this yet" }],
      },
    });
    expect(await f.run(changeDiscussionTurnCommand, participants[1]!.run_id, bad)).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    const completion = await f.turnInput(id, 2, "complete", {
      session_id: session,
      output: SYNTHETIC_OUTPUT,
    });
    const completed = success(
      await f.run(changeDiscussionTurnCommand, participants[1]!.run_id, completion),
    );
    expect(
      success(await f.run(changeDiscussionTurnCommand, participants[1]!.run_id, completion)),
    ).toEqual(completed);
    const conclusion = success(
      await f.human(changeDiscussionCommand, change(id, completed.version, "conclude")),
    );
    const decisionInput = change(id, conclusion.version, "decide", {
      decision: {
        kind: "record_recommendation",
        summary: "Synthetic human decision, not implementation authority",
        recommendation_ids: [first.message_id],
      },
    });
    expect(
      await f.run(changeDiscussionCommand, participants[0]!.run_id, decisionInput),
    ).toMatchObject({ ok: false, error: { code: "forbidden" } });
    const decision = success(await f.human(changeDiscussionCommand, decisionInput));
    expect(success(await f.human(changeDiscussionCommand, decisionInput))).toEqual(decision);
    expect(await f.db.prepare(`SELECT COUNT(*) AS count FROM discussion_messages`).get()).toEqual({
      count: 2,
    });
    expect(await f.db.prepare(`SELECT COUNT(*) AS count FROM discussion_decisions`).get()).toEqual({
      count: 1,
    });
    expect(
      await f.db
        .prepare(`SELECT * FROM tasks WHERE workspace_id = ? AND id = ?`)
        .get(FIX.workspace, f.task.id),
    ).toEqual(before);
  });
});
