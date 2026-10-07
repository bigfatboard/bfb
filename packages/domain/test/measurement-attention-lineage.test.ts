// ABOUTME: Proves measurement projections exclude attention with inconsistent retained historical lineage.
// ABOUTME: Canonical ended executions and foreign-key-valid synthetic corrupt requests distinguish source privacy from liveness.

import { describe, expect, it } from "vitest";

import { getAttention } from "../src/attention.js";
import { FIX } from "../src/fixtures.js";
import { WorkspaceHub, type HubCommand } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import {
  aggregateMeasurements,
  getRunMeasurements,
  getTaskMeasurements,
} from "../src/measurements.js";
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
const ENDED = "2026-09-12T12:04:00.000Z";
const NOW = "2026-09-12T12:10:00.000Z";
const PRIVATE_QUESTION = "SYNTHETIC-PRIVATE-HISTORICAL-ATTENTION-QUESTION";
const viewer: TaskAccessContext = {
  workspaceId: FIX.workspace,
  humanId: FIX.member,
  authorizationEpoch: 1,
};

interface HistoricalWork {
  taskId: string;
  projectId: string;
  runId: string;
  executionId: string;
}

async function fixture() {
  const db = await openDomainDb(),
    hub = new WorkspaceHub(db),
    runnerId = randomUlid(),
    keyThumbprint = "synthetic-measurement-attention-lineage-key";
  const execute = <I, R>(command: HubCommand<I, R>, input: I, now = CREATED) =>
    hub.execute(command, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      now,
      input,
    });

  // Disposable immutable historical assignment context, never a provider start or live lease.
  await db
    .prepare(
      `INSERT INTO runners
       (workspace_id, id, owner_human_id, device_label, public_key_json, key_thumbprint,
        authorization_epoch, grant_epoch, token_epoch, enrolled_at)
       VALUES (?, ?, ?, 'Synthetic measurement history Mac', '{}', ?, 1, 1, 1, ?)`,
    )
    .run(FIX.workspace, runnerId, FIX.owner, keyThumbprint, CREATED);

  async function work(projectId: string, title: string): Promise<HistoricalWork> {
    const task = success(await execute(createTaskCommand, { projectId, title, priority: "P2" }));
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
    await db
      .prepare(
        `INSERT INTO execution_assignments
         (workspace_id, execution_id, assignment_generation, run_id, task_id, project_id,
          runner_id, checkout_id, physical_worktree_hash, requesting_human_id,
          requesting_human_epoch, runner_authorization_epoch, runner_grant_epoch,
          runner_key_thumbprint, created_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, ?, ?)`,
      )
      .run(
        FIX.workspace,
        execution.id,
        created.run.id,
        task.id,
        projectId,
        runnerId,
        randomUlid(),
        `sha256:${"c".repeat(64)}`,
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
    return { taskId: task.id, projectId, runId: created.run.id, executionId: execution.id };
  }

  const shared = await work(FIX.projectA, "Synthetic readable measurement history");
  const privateWork = await work(FIX.projectA, "Synthetic private measurement history");
  await db
    .prepare(
      `INSERT INTO task_privacy (workspace_id, task_id, owner_human_id, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(FIX.workspace, privateWork.taskId, FIX.owner, CREATED);

  async function attention(
    declared: Pick<HistoricalWork, "projectId" | "taskId" | "runId">,
    retained: HistoricalWork,
    state: "open" | "resolved",
    question: string,
  ): Promise<string> {
    const id = randomUlid(),
      requestedAt = state === "resolved" ? "2026-09-12T12:01:00.000Z" : "2026-09-12T12:03:00.000Z",
      answeredAt = state === "resolved" ? "2026-09-12T12:01:30.000Z" : null,
      resolvedAt = state === "resolved" ? "2026-09-12T12:02:00.000Z" : null;
    // Synthetic retained attention history. Corrupt variants change only the INSERT's
    // declared tuple; the genuine execution/assignment and observations stay immutable.
    await db
      .prepare(
        `INSERT INTO attention_requests
         (workspace_id, id, project_id, task_id, run_id, run_execution_id,
          assignment_generation, kind, required_role, reference_kind, reference_id,
          question, blocking, state, answer, answered_by_human_id, requested_at,
          first_response_at, answered_at, resolved_at, resource_version)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'reviewer', NULL, NULL, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        FIX.workspace,
        id,
        declared.projectId,
        declared.taskId,
        declared.runId,
        retained.executionId,
        state === "resolved" ? "clarification" : "blocker",
        question,
        state,
        state === "resolved" ? "Synthetic canonical historical answer" : null,
        state === "resolved" ? FIX.owner : null,
        requestedAt,
        answeredAt,
        answeredAt,
        resolvedAt,
        state === "resolved" ? 3 : 1,
      );
    const observations = [
      { kind: "requested", at: requestedAt },
      ...(answeredAt ? [{ kind: "answered", at: answeredAt }] : []),
      ...(resolvedAt ? [{ kind: "resolved", at: resolvedAt }] : []),
    ];
    for (const observation of observations) {
      await db
        .prepare(
          `INSERT INTO attention_observations
           (workspace_id, observation_id, attention_id, observed_kind, actor_type, actor_id, occurred_at)
           VALUES (?, ?, ?, ?, 'human', ?, ?)`,
        )
        .run(FIX.workspace, randomUlid(), id, observation.kind, FIX.owner, observation.at);
    }
    return id;
  }

  const sharedAttentionId = await attention(
    shared,
    shared,
    "resolved",
    "Synthetic canonical shared historical question",
  );
  const privateAttentionId = await attention(privateWork, privateWork, "open", PRIVATE_QUESTION);
  const projections = async () => ({
    run: await getRunMeasurements(db, FIX.workspace, shared.runId, NOW, viewer),
    task: await getTaskMeasurements(db, FIX.workspace, shared.taskId, NOW, viewer),
  });
  const aggregate = () =>
    aggregateMeasurements(db, FIX.workspace, { projectId: shared.projectId }, NOW, viewer);
  const retainedSources = async () => ({
    assignments: await db.prepare("SELECT * FROM execution_assignments ORDER BY rowid").all(),
    requests: await db.prepare("SELECT * FROM attention_requests ORDER BY rowid").all(),
    observations: await db.prepare("SELECT * FROM attention_observations ORDER BY rowid").all(),
  });
  const validForeignKeys = async () =>
    expect(await db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  await validForeignKeys();
  expect(
    await getAttention(db, FIX.workspace, [privateWork.projectId], privateAttentionId, viewer),
  ).toBeNull();
  await expect(
    getRunMeasurements(db, FIX.workspace, privateWork.runId, NOW, viewer),
  ).rejects.toMatchObject({
    code: "not_found",
  });
  return {
    db,
    shared,
    privateWork,
    sharedAttentionId,
    privateAttentionId,
    attention,
    projections,
    aggregate,
    retainedSources,
    validForeignKeys,
  };
}

describe("measurement attention historical lineage", () => {
  it("keeps canonical resolved attention on a genuine ended historical execution", async () => {
    const f = await fixture(),
      before = await f.retainedSources(),
      measured = await f.projections(),
      aggregate = await f.aggregate();
    expect(
      await f.db.prepare("SELECT state FROM run_executions WHERE id = ?").get(f.shared.executionId),
    ).toEqual({
      state: "ended",
    });
    const canonical = await getAttention(
      f.db,
      FIX.workspace,
      [FIX.projectA],
      f.sharedAttentionId,
      viewer,
    );
    expect(canonical).toMatchObject({
      task_id: f.shared.taskId,
      run_id: f.shared.runId,
      run_execution_id: f.shared.executionId,
      state: "resolved",
    });
    expect(measured.run.attention).toEqual([
      {
        request_id: f.sharedAttentionId,
        kind: "clarification",
        blocking: true,
        state: "resolved",
        first_response_ms: 30_000,
        resolution_ms: 60_000,
        open: false,
      },
    ]);
    expect(measured.run.times).toMatchObject({
      attention_wait_ms: 30_000,
      attention_open: false,
      live_execution: false,
    });
    expect(measured.run.provenance.attention_observations).toBe(3);
    expect(measured.run.sources).toBeNull();
    expect(measured.task.attention).toEqual(measured.run.attention);
    expect(measured.task.interventions.attention_by_kind).toEqual({
      clarification: { open: 0, answered: 0, resolved: 1 },
    });
    expect(aggregate).toMatchObject({
      cells: [{ runs: 1, attention_requests: 1, attention_wait_ms: 30_000 }],
      truncated: false,
    });
    expect(await f.projections()).toEqual(measured);
    expect(await f.aggregate()).toEqual(aggregate);
    expect(await f.retainedSources()).toEqual(before);
    await f.validForeignKeys();
  });

  it("does not change readable run or task projections when private history falsely declares the shared run", async () => {
    const f = await fixture(),
      baseline = await f.projections();
    const corruptId = await f.attention(
      { ...f.privateWork, runId: f.shared.runId },
      f.privateWork,
      "open",
      PRIVATE_QUESTION,
    );
    await f.validForeignKeys();
    const before = await f.retainedSources();
    expect(
      await getAttention(f.db, FIX.workspace, [FIX.projectA, FIX.projectB], corruptId, viewer),
    ).toBeNull();
    const actual = await f.projections();
    expect(await f.retainedSources()).toEqual(before);
    expect.soft(actual.run).toEqual(baseline.run);
    expect.soft(actual.task).toEqual(baseline.task);
    expect
      .soft(actual.run.provenance.attention_observations)
      .toBe(baseline.run.provenance.attention_observations);
    expect.soft(actual.run.times).toEqual(baseline.run.times);
    await f.validForeignKeys();
  });

  it("does not change readable task projection or kind counts when a private run falsely declares the shared task", async () => {
    const f = await fixture(),
      baseline = await f.projections();
    const corruptId = await f.attention(
      { ...f.shared, runId: f.privateWork.runId },
      f.privateWork,
      "open",
      PRIVATE_QUESTION,
    );
    await f.validForeignKeys();
    const before = await f.retainedSources();
    expect(
      await getAttention(f.db, FIX.workspace, [FIX.projectA, FIX.projectB], corruptId, viewer),
    ).toBeNull();
    const actual = await f.projections();
    expect(await f.retainedSources()).toEqual(before);
    expect.soft(actual.run).toEqual(baseline.run);
    expect.soft(actual.task).toEqual(baseline.task);
    expect
      .soft(actual.task.interventions.attention_by_kind)
      .toEqual(baseline.task.interventions.attention_by_kind);
    await f.validForeignKeys();
  });

  it("does not change the full aggregate cell or attention count for a falsely declared shared run", async () => {
    const f = await fixture(),
      baseline = await f.aggregate();
    await f.attention(
      { ...f.privateWork, runId: f.shared.runId },
      f.privateWork,
      "open",
      PRIVATE_QUESTION,
    );
    await f.validForeignKeys();
    const before = await f.retainedSources(),
      actual = await f.aggregate();
    expect(await f.retainedSources()).toEqual(before);
    expect.soft(actual).toEqual(baseline);
    expect
      .soft(actual.cells.map((cell) => cell.attention_requests))
      .toEqual(baseline.cells.map((cell) => cell.attention_requests));
    await f.validForeignKeys();
  });

  it("does not change shared projections when its exact declared tuple retains a private execution and assignment", async () => {
    const f = await fixture(),
      baseline = await f.projections(),
      aggregateBaseline = await f.aggregate();
    await f.attention(f.shared, f.privateWork, "open", PRIVATE_QUESTION);
    await f.validForeignKeys();
    const before = await f.retainedSources(),
      actual = await f.projections(),
      aggregate = await f.aggregate();
    expect(await f.retainedSources()).toEqual(before);
    expect.soft(actual.run).toEqual(baseline.run);
    expect.soft(actual.task).toEqual(baseline.task);
    expect.soft(aggregate).toEqual(aggregateBaseline);
    await f.validForeignKeys();
  });
});
