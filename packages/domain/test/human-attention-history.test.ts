// ABOUTME: Proves human attention reads require exact retained execution and assignment lineage.
// ABOUTME: Same-project synthetic private history distinguishes malformed source delivery from canonical ended and empty history.

import { describe, expect, it } from "vitest";

import {
  getAttention,
  getHumanAttentionDetail,
  listAttention,
  listAttentionObservations,
  type AttentionKind,
  type AttentionObservation,
  type AttentionRecord,
} from "../src/attention.js";
import { FIX } from "../src/fixtures.js";
import { WorkspaceHub, type HubCommand } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import type { TaskAccessContext } from "../src/task-access.js";
import { createTaskCommand } from "../src/work-commands.js";
import {
  createExecutionCommand,
  createRunCommand,
  transitionExecutionCommand,
} from "../src/work-records.js";
import { openDomainDb } from "./helpers.js";
import { success } from "./launch-fixture.js";

const CREATED = "2026-09-12T12:00:00.000Z";
const REQUESTED = "2026-09-12T12:01:00.000Z";
const ANSWERED = "2026-09-12T12:01:30.000Z";
const RESOLVED = "2026-09-12T12:02:00.000Z";
const ENDED = "2026-09-12T12:04:00.000Z";
const PRIVATE_QUESTION = "SYNTHETIC-PRIVATE-HUMAN-ATTENTION-QUESTION";
const PRIVATE_ANSWER = "SYNTHETIC-PRIVATE-HUMAN-ATTENTION-ANSWER";
const viewer: TaskAccessContext = {
  workspaceId: FIX.workspace,
  humanId: FIX.member,
  authorizationEpoch: 1,
};

interface HistoricalWork {
  taskId: string;
  runId: string;
  executionId: string;
  generation: number;
}

async function fixture() {
  const db = await openDomainDb(),
    hub = new WorkspaceHub(db),
    runnerId = randomUlid(),
    keyThumbprint = "synthetic-human-attention-history-key";
  const execute = <I, R>(command: HubCommand<I, R>, input: I, now = CREATED) =>
    hub.execute(command, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      now,
      input,
    });
  // Immutable disposable assignment context only: no provider, lease or runner operation.
  await db
    .prepare(
      `INSERT INTO runners
       (workspace_id, id, owner_human_id, device_label, public_key_json, key_thumbprint,
        authorization_epoch, grant_epoch, token_epoch, enrolled_at)
       VALUES (?, ?, ?, 'Synthetic human attention history Mac', '{}', ?, 1, 1, 1, ?)`,
    )
    .run(FIX.workspace, runnerId, FIX.owner, keyThumbprint, CREATED);

  async function work(title: string): Promise<HistoricalWork> {
    const task = success(
      await execute(createTaskCommand, { projectId: FIX.projectA, title, priority: "P2" }),
    );
    const created = success(
      await execute(createRunCommand, {
        taskId: task.id,
        expectedTaskVersion: task.resource_version,
        agentProfileId: FIX.profileCodex,
        workspacePolicyVersion: 1,
        projectPolicyVersion: 1,
        repositoryConfigVersion: 1,
        agentProfileVersion: 1,
      }),
    );
    const execution = success(await execute(createExecutionCommand, { runId: created.run.id }));
    const generation = 7;
    await db
      .prepare(
        `INSERT INTO execution_assignments
         (workspace_id, execution_id, assignment_generation, run_id, task_id, project_id,
          runner_id, checkout_id, physical_worktree_hash, requesting_human_id,
          requesting_human_epoch, runner_authorization_epoch, runner_grant_epoch,
          runner_key_thumbprint, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, ?, ?)`,
      )
      .run(
        FIX.workspace,
        execution.id,
        generation,
        created.run.id,
        task.id,
        FIX.projectA,
        runnerId,
        randomUlid(),
        `sha256:${"b".repeat(64)}`,
        FIX.owner,
        keyThumbprint,
        execution.created_at,
      );
    success(
      await execute(
        transitionExecutionCommand,
        {
          runId: created.run.id,
          executionId: execution.id,
          expectedVersion: execution.resource_version,
          state: "ended",
          endReason: "process_exit",
        },
        ENDED,
      ),
    );
    return { taskId: task.id, runId: created.run.id, executionId: execution.id, generation };
  }

  const shared = await work("Synthetic shared attention history");
  const privateWork = await work("Synthetic private attention history");
  await db
    .prepare(
      `INSERT INTO task_privacy (workspace_id, task_id, owner_human_id, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(FIX.workspace, privateWork.taskId, FIX.owner, CREATED);

  async function attention(
    declared: Pick<HistoricalWork, "taskId" | "runId">,
    retained: HistoricalWork,
    options: {
      state?: "open" | "resolved";
      kind?: AttentionKind;
      question?: string;
      answer?: string;
      observations?: boolean;
    } = {},
  ): Promise<{ record: AttentionRecord; observations: AttentionObservation[] }> {
    const state = options.state ?? "resolved",
      kind = options.kind ?? "clarification";
    const record: AttentionRecord = {
      id: randomUlid(),
      project_id: FIX.projectA,
      task_id: declared.taskId,
      run_id: declared.runId,
      run_execution_id: retained.executionId,
      assignment_generation: retained.generation,
      kind,
      required_role: kind === "blocker" ? "member" : "reviewer",
      reference_kind: null,
      reference_id: null,
      question: options.question ?? "Synthetic canonical historical question",
      blocking: kind === "blocker",
      state,
      answer:
        state === "resolved" ? (options.answer ?? "Synthetic canonical historical answer") : null,
      answered_by_human_id: state === "resolved" ? FIX.owner : null,
      requested_at: REQUESTED,
      first_response_at: state === "resolved" ? ANSWERED : null,
      answered_at: state === "resolved" ? ANSWERED : null,
      resolved_at: state === "resolved" ? RESOLVED : null,
      resource_version: state === "resolved" ? 3 : 1,
    };
    // Explicit synthetic retained history. Misbound variants INSERT inconsistent
    // declared IDs; they never rewrite the valid immutable execution or assignment.
    await db
      .prepare(
        `INSERT INTO attention_requests
         (workspace_id, id, project_id, task_id, run_id, run_execution_id, assignment_generation,
          kind, required_role, reference_kind, reference_id, question, blocking, state, answer,
          answered_by_human_id, requested_at, first_response_at, answered_at, resolved_at, resource_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        FIX.workspace,
        record.id,
        record.project_id,
        record.task_id,
        record.run_id,
        record.run_execution_id,
        record.assignment_generation,
        record.kind,
        record.required_role,
        record.reference_kind,
        record.reference_id,
        record.question,
        Number(record.blocking),
        record.state,
        record.answer,
        record.answered_by_human_id,
        record.requested_at,
        record.first_response_at,
        record.answered_at,
        record.resolved_at,
        record.resource_version,
      );
    const observations: AttentionObservation[] =
      options.observations === false
        ? []
        : [
            { observed_kind: "requested" as const, occurred_at: REQUESTED },
            ...(state === "resolved"
              ? [
                  { observed_kind: "answered" as const, occurred_at: ANSWERED },
                  { observed_kind: "resolved" as const, occurred_at: RESOLVED },
                ]
              : []),
          ].map((observation) => ({
            ...observation,
            observation_id: randomUlid(),
            attention_id: record.id,
            actor_type: "human" as const,
            actor_id: FIX.owner,
          }));
    for (const observation of observations) {
      await db
        .prepare(
          `INSERT INTO attention_observations
           (workspace_id, observation_id, attention_id, observed_kind, actor_type, actor_id, occurred_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          FIX.workspace,
          observation.observation_id,
          observation.attention_id,
          observation.observed_kind,
          observation.actor_type,
          observation.actor_id,
          observation.occurred_at,
        );
    }
    return { record, observations };
  }

  const resolved = await attention(shared, shared);
  const empty = await attention(shared, shared, { state: "open", observations: false });
  const privateAttention = await attention(privateWork, privateWork, {
    kind: "blocker",
    question: PRIVATE_QUESTION,
    answer: PRIVATE_ANSWER,
  });
  async function laterEndedExecution(): Promise<string> {
    const createdAt = "2026-09-12T12:05:00.000Z";
    const execution = success(
      await execute(createExecutionCommand, { runId: shared.runId }, createdAt),
    );
    // A later distinct retained execution is a fixture, not a handoff/resume.
    // Copy the genuine canonical tuple; do not rewrite its earlier assignment.
    await db
      .prepare(
        `INSERT INTO execution_assignments
         (workspace_id, execution_id, assignment_generation, run_id, task_id, project_id,
          runner_id, checkout_id, physical_worktree_hash, requesting_human_id,
          requesting_human_epoch, runner_authorization_epoch, runner_grant_epoch,
          runner_key_thumbprint, created_at)
         SELECT workspace_id, ?, 8, run_id, task_id, project_id, runner_id, checkout_id,
                physical_worktree_hash, requesting_human_id, requesting_human_epoch,
                runner_authorization_epoch, runner_grant_epoch, runner_key_thumbprint, ?
         FROM execution_assignments
         WHERE workspace_id = ? AND execution_id = ? AND assignment_generation = ?`,
      )
      .run(execution.id, createdAt, FIX.workspace, shared.executionId, shared.generation);
    success(
      await execute(
        transitionExecutionCommand,
        {
          runId: shared.runId,
          executionId: execution.id,
          expectedVersion: execution.resource_version,
          state: "ended",
          endReason: "process_exit",
        },
        "2026-09-12T12:06:00.000Z",
      ),
    );
    return execution.id;
  }
  const get = (id: string) => getAttention(db, FIX.workspace, [FIX.projectA], id, viewer);
  const detail = (id: string) =>
    getHumanAttentionDetail(db, FIX.workspace, [FIX.projectA], id, viewer);
  const observations = (id: string) =>
    listAttentionObservations(db, FIX.workspace, [FIX.projectA], id, viewer);
  const list = (options: { state?: "open" | "resolved"; limit?: number } = {}) =>
    listAttention(db, FIX.workspace, [FIX.projectA], options, viewer);
  const validForeignKeys = async () =>
    expect(await db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  const snapshot = async () => {
    const tables = (await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()) as Array<{ name: string }>;
    const records: Record<string, unknown[]> = {};
    for (const { name } of tables) {
      if (
        name.startsWith("sqlite_") ||
        name.startsWith("_cf_") ||
        name === "d1_migrations" ||
        name === "rate_limit_buckets"
      )
        continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
        throw new Error("Unexpected canonical table name");
      records[name] = await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
    }
    return records;
  };
  await validForeignKeys();
  expect(await get(privateAttention.record.id)).toBeNull();
  expect(await detail(privateAttention.record.id)).toBeNull();
  expect(await observations(privateAttention.record.id)).toEqual([]);
  return {
    db,
    shared,
    privateWork,
    laterEndedExecution,
    resolved,
    empty,
    attention,
    get,
    detail,
    observations,
    list,
    snapshot,
    validForeignKeys,
  };
}

describe("human attention historical lineage", () => {
  it("preserves complete canonical resolved history on its earlier ended execution and generation", async () => {
    const f = await fixture(),
      laterExecutionId = await f.laterEndedExecution(),
      before = await f.snapshot();
    await f.validForeignKeys();
    expect(
      await f.db
        .prepare(
          `SELECT execution_id, assignment_generation FROM execution_assignments
           WHERE workspace_id = ? AND run_id = ? ORDER BY assignment_generation`,
        )
        .all(FIX.workspace, f.shared.runId),
    ).toEqual([
      { execution_id: f.shared.executionId, assignment_generation: 7 },
      { execution_id: laterExecutionId, assignment_generation: 8 },
    ]);
    expect(
      await f.db.prepare("SELECT state FROM run_executions WHERE id = ?").get(f.shared.executionId),
    ).toEqual({ state: "ended" });
    expect(await f.get(f.resolved.record.id)).toEqual(f.resolved.record);
    expect(await f.detail(f.resolved.record.id)).toEqual({
      attention: f.resolved.record,
      observations: f.resolved.observations,
    });
    expect(await f.observations(f.resolved.record.id)).toEqual(f.resolved.observations);
    const ranked = await f.list({ state: "resolved", limit: 1 });
    expect(ranked).toEqual([
      {
        ...f.resolved.record,
        task_title: "Synthetic shared attention history",
        project_name: "Alpha",
        run_result_state: "open",
        run_activity: "unknown",
        rank_reason: `non-blocking clarification requested ${REQUESTED}`,
      },
    ]);
    expect(await f.snapshot()).toEqual(before);
    await f.validForeignKeys();
  });

  it("keeps an authorized empty observation history distinct from a denied request", async () => {
    const f = await fixture(),
      before = await f.snapshot();
    expect(await f.get(f.empty.record.id)).toEqual(f.empty.record);
    expect(await f.detail(f.empty.record.id)).toEqual({
      attention: f.empty.record,
      observations: [],
    });
    expect(await f.observations(f.empty.record.id)).toEqual([]);
    expect((await f.list({ state: "open", limit: 1 })).map((record) => record.id)).toEqual([
      f.empty.record.id,
    ]);
    expect(await f.snapshot()).toEqual(before);
    await f.validForeignKeys();
  });

  it("withholds complete bodies, answers, origin and observations when a shared tuple retains private execution history", async () => {
    const f = await fixture(),
      baseline = await f.list();
    const corrupt = await f.attention(f.shared, f.privateWork, {
      kind: "blocker",
      question: PRIVATE_QUESTION,
      answer: PRIVATE_ANSWER,
    });
    await f.validForeignKeys();
    const before = await f.snapshot(),
      body = await f.get(corrupt.record.id),
      detail = await f.detail(corrupt.record.id),
      observations = await f.observations(corrupt.record.id),
      ranked = await f.list();
    expect(await f.snapshot()).toEqual(before);
    expect.soft(body).toBeNull();
    expect.soft(detail).toBeNull();
    expect.soft(observations).toEqual([]);
    expect.soft(ranked).toEqual(baseline);
    await f.validForeignKeys();
  });

  it("filters a misbound private blocker before ranked limit one instead of displacing healthy attention", async () => {
    const f = await fixture(),
      baseline = await f.list({ state: "open", limit: 1 });
    expect(baseline).toHaveLength(1);
    const corrupt = await f.attention(f.shared, f.privateWork, {
      state: "open",
      kind: "blocker",
      question: PRIVATE_QUESTION,
    });
    await f.validForeignKeys();
    const before = await f.snapshot(),
      actual = await f.list({ state: "open", limit: 1 });
    expect(await f.snapshot()).toEqual(before);
    expect(
      actual,
      `Misbound blocker ${corrupt.record.id} must not consume the visible page`,
    ).toEqual(baseline);
    await f.validForeignKeys();
  });

  it("retains the existing declared task/run mismatch fence without changing source history", async () => {
    const f = await fixture(),
      baseline = await f.list();
    const corrupt = await f.attention(
      { taskId: f.shared.taskId, runId: f.privateWork.runId },
      f.privateWork,
      { kind: "blocker", question: PRIVATE_QUESTION, answer: PRIVATE_ANSWER },
    );
    await f.validForeignKeys();
    const before = await f.snapshot();
    expect(await f.get(corrupt.record.id)).toBeNull();
    expect(await f.detail(corrupt.record.id)).toBeNull();
    expect(await f.observations(corrupt.record.id)).toEqual([]);
    expect(await f.list()).toEqual(baseline);
    expect(await f.snapshot()).toEqual(before);
    await f.validForeignKeys();
  });
});
