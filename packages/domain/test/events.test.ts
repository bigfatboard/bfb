// ABOUTME: Proves E01 ingest attribution, dispositions, idempotency, and projection absolutes.
// ABOUTME: All fixtures are synthetic; fault rows never touch real runner or provider state.

import type { SqlDatabase } from "@bfb/db";
import type { RunnerEventSubmission } from "@bfb/protocol";
import { describe, expect, it } from "vitest";

import {
  EVENT_BATCH_LIMIT,
  ingestRunnerEventsCommand,
  listLedgerEvents,
  readLedgerHighWater,
  type IngestRunnerEventsResult,
} from "../src/events.js";
import { FIX } from "../src/fixtures.js";
import { randomUlid } from "../src/ids.js";
import { createAuthorizationContext } from "@bfb/db";
import type { RunnerPrincipal } from "../src/runners.js";
import { createTaskCommand } from "../src/work-commands.js";
import { createExecutionCommand, createRunCommand } from "../src/work-records.js";
import { claimLaunchCommand, startLaunchCommand } from "../src/launches.js";
import { runnerHash } from "../src/runner-crypto.js";
import { LAUNCH_NOW, launchFixture, success } from "./launch-fixture.js";

type Fixture = Awaited<ReturnType<typeof launchFixture>>;

interface BoundExecution {
  executionId: string;
  generation: number;
  runId: string;
  taskId: string;
}

async function claimedExecution(f: Fixture): Promise<BoundExecution> {
  const { claimed } = await f.claim();
  return {
    executionId: claimed.specification.run_execution_id,
    generation: claimed.specification.assignment_generation,
    runId: claimed.specification.run_id,
    taskId: claimed.specification.task_id,
  };
}

async function secondExecution(f: Fixture): Promise<BoundExecution> {
  const task = success(
    await f.human(createTaskCommand, {
      projectId: FIX.projectA,
      title: "Synthetic E01 second task",
      priority: "P2",
    }),
  );
  // C09 forbids parallel reservations on one physical worktree, so the second
  // execution gets its own checkout identity.
  const checkout2 = randomUlid();
  const current = f.inventory();
  await f.refresh(LAUNCH_NOW, {
    checkouts: [
      ...current.checkouts,
      {
        ...current.checkouts[0]!,
        checkout_id: checkout2,
        physical_worktree_hash: `sha256:${"b".repeat(64)}`,
        label: "Synthetic E01 second checkout",
        is_default: false,
      },
    ],
  });
  const launch = success(
    await f.human(startLaunchCommand, {
      ...f.start,
      idempotency_key: randomUlid(),
      task_id: task.id,
      checkout_id: checkout2,
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
    executionId: claimed.claim.specification.run_execution_id,
    generation: claimed.claim.specification.assignment_generation,
    runId: claimed.claim.specification.run_id,
    taskId: task.id,
  };
}

let streamCounter = 0;
function freshStream(): string {
  streamCounter += 1;
  return randomUlid();
}

function submission(
  bound: BoundExecution,
  stream: string,
  sequence: number,
  overrides: Partial<RunnerEventSubmission> = {},
): RunnerEventSubmission {
  return {
    schema_version: 1,
    event_id: randomUlid(),
    source_stream_id: stream,
    source_sequence: sequence,
    run_execution_id: bound.executionId,
    assignment_generation: bound.generation,
    kind: "heartbeat",
    occurred_at: LAUNCH_NOW,
    capture_origin: "runner_observed",
    payload: {},
    ...overrides,
  };
}

async function ingest(
  f: Fixture,
  events: unknown[],
  now = LAUNCH_NOW,
  principal: RunnerPrincipal = f.principal,
) {
  return success(
    await f.hub.execute(ingestRunnerEventsCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorRunnerId: principal.runnerId,
      authorizationEpoch: principal.authorizationEpoch,
      now,
      input: { principal, events },
    }),
  );
}

function dispositionsOf(result: IngestRunnerEventsResult): string[] {
  return result.dispositions.map((entry) => entry.disposition);
}

function readAuthorization() {
  return createAuthorizationContext({
    workspaceId: FIX.workspace,
    principalId: FIX.owner,
    authorizationEpoch: 1,
    jurisdiction: "eu",
  });
}

/**
 * Shared workspace cursor before an ingest. The ledger shares the workspace
 * cursor sequence with hub command audit rows, so fixture commands already
 * consumed the first cursors; ledger rows continue that monotonic space.
 */
async function highWater(f: Fixture): Promise<number> {
  const row = (await f.db
    .prepare(`SELECT cursor FROM workspace_cursors WHERE workspace_id = ?`)
    .get(FIX.workspace)) as { cursor: number } | undefined;
  return row?.cursor ?? 0;
}

async function ledgerRows(db: SqlDatabase, workspaceId: string) {
  return (await db
    .prepare(
      `SELECT event_id, workspace_cursor, source_stream_id, source_sequence,
              project_id, task_id, run_id, run_execution_id, assignment_generation,
              actor_type, actor_id, source_type, source_id, kind, occurred_at
       FROM event_ledger WHERE workspace_id = ? ORDER BY workspace_cursor ASC`,
    )
    .all(workspaceId)) as Array<Record<string, unknown>>;
}

async function secondRunner(f: Fixture): Promise<RunnerPrincipal> {
  const runner = randomUlid(),
    tokenId = randomUlid(),
    thumbprint = "synthetic-e01-second-key";
  const principal: RunnerPrincipal = {
    ...f.principal,
    runnerId: runner,
    tokenId,
    keyThumbprint: thumbprint,
  };
  await f.db
    .prepare(
      `INSERT INTO runners (workspace_id, id, owner_human_id, device_label, public_key_json, key_thumbprint, token_epoch, enrolled_at)
       VALUES (?, ?, ?, 'Synthetic E01 second Mac', '{}', ?, 1, ?)`,
    )
    .run(FIX.workspace, runner, FIX.owner, thumbprint, LAUNCH_NOW);
  await f.db
    .prepare(`INSERT INTO runner_project_grants VALUES (?, ?, ?)`)
    .run(FIX.workspace, runner, FIX.projectA);
  await f.db
    .prepare(
      `INSERT INTO runner_launch_grants (workspace_id, runner_id, human_id, granted_at) VALUES (?, ?, ?, ?)`,
    )
    .run(FIX.workspace, runner, FIX.owner, LAUNCH_NOW);
  await f.db
    .prepare(
      `INSERT INTO runner_tokens (workspace_id, runner_id, id, token_hash, claims_json, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      FIX.workspace,
      runner,
      tokenId,
      runnerHash("synthetic-e01-second-token"),
      JSON.stringify({
        v: 1,
        sub: runner,
        workspace_id: FIX.workspace,
        aud: "bfb-runner",
        iss: "https://bfb.example.test",
        jti: tokenId,
        iat: Date.parse(LAUNCH_NOW) / 1000,
        exp: Date.parse(principal.authExpiresAt) / 1000,
        authorization_epoch: 1,
        owner_authorization_epoch: 1,
        grant_epoch: 1,
        token_epoch: 1,
        cnf: { jkt: thumbprint },
      }),
      principal.authExpiresAt,
    );
  return principal;
}

describe("event ingest", () => {
  it("commits heartbeats with server-derived attribution and absolute projections", async () => {
    const f = await launchFixture();
    const bound = await claimedExecution(f);
    const before = await highWater(f);
    const stream = freshStream();
    const result = await ingest(f, [
      submission(bound, stream, 1),
      submission(bound, stream, 2, { kind: "turn_started", capture_origin: "hook_inbox" }),
    ]);
    expect(dispositionsOf(result)).toEqual(["accepted", "accepted"]);
    expect(result.high_water_cursor).toBe(before + 2);

    const rows = await ledgerRows(f.db, FIX.workspace);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      workspace_cursor: before + 1,
      project_id: FIX.projectA,
      task_id: bound.taskId,
      run_id: bound.runId,
      run_execution_id: bound.executionId,
      assignment_generation: bound.generation,
      actor_type: "runner",
      actor_id: f.runner,
      source_type: "runner",
      source_id: f.runner,
      kind: "heartbeat",
    });
    expect(rows[1]).toMatchObject({ actor_type: "agent_run", actor_id: bound.executionId });

    const observations = (await f.db
      .prepare(
        `SELECT observation_id, measure_kind, actor_type FROM measurement_observations WHERE workspace_id = ?`,
      )
      .all(FIX.workspace)) as Array<Record<string, unknown>>;
    expect(observations).toHaveLength(2);

    const runProjection = (await f.db
      .prepare(
        `SELECT event_count, last_cursor, last_kind FROM run_event_projections WHERE workspace_id = ? AND run_id = ?`,
      )
      .get(FIX.workspace, bound.runId)) as Record<string, unknown>;
    expect(runProjection).toMatchObject({
      event_count: 2,
      last_cursor: before + 2,
      last_kind: "turn_started",
    });
    const executionProjection = (await f.db
      .prepare(
        `SELECT event_count, heartbeat_count, last_heartbeat_cursor FROM execution_event_projections WHERE workspace_id = ? AND run_execution_id = ?`,
      )
      .get(FIX.workspace, bound.executionId)) as Record<string, unknown>;
    expect(executionProjection).toMatchObject({
      event_count: 2,
      heartbeat_count: 1,
      last_heartbeat_cursor: before + 1,
    });
    const turnCounter = (await f.db
      .prepare(
        `SELECT event_count FROM event_kind_counters WHERE workspace_id = ? AND run_execution_id = ? AND kind = 'turn_started'`,
      )
      .get(FIX.workspace, bound.executionId)) as { event_count: number };
    expect(turnCounter.event_count).toBe(1);

    const run = (await f.db
      .prepare(`SELECT result_state, activity FROM runs WHERE workspace_id = ? AND id = ?`)
      .get(FIX.workspace, bound.runId)) as Record<string, unknown>;
    expect(run).toMatchObject({ result_state: "open" });
  });

  it("ignores claimed workspace hints and derives attribution server-side", async () => {
    const f = await launchFixture();
    const bound = await claimedExecution(f);
    const result = await ingest(f, [
      submission(bound, freshStream(), 1, {
        claimed_workspace_id: randomUlid(),
        claimed_project_id: randomUlid(),
        claimed_task_id: randomUlid(),
        claimed_run_id: randomUlid(),
      }),
    ]);
    expect(dispositionsOf(result)).toEqual(["accepted"]);
    const rows = await ledgerRows(f.db, FIX.workspace);
    expect(rows[0]).toMatchObject({
      project_id: FIX.projectA,
      task_id: bound.taskId,
      run_id: bound.runId,
    });
  });

  it("deduplicates transport retries with one ledger and projection effect", async () => {
    const f = await launchFixture();
    const bound = await claimedExecution(f);
    const stream = freshStream();
    const batch = [
      submission(bound, stream, 1),
      submission(bound, stream, 2, { kind: "tool_started", capture_origin: "hook_inbox" }),
    ];
    const base = await highWater(f);
    const first = await ingest(f, batch);
    expect(dispositionsOf(first)).toEqual(["accepted", "accepted"]);
    expect(first.high_water_cursor).toBe(base + 2);
    // Acknowledgement loss: the daemon resends the whole batch.
    const second = await ingest(f, batch);
    expect(dispositionsOf(second)).toEqual(["already_committed", "already_committed"]);

    expect(await ledgerRows(f.db, FIX.workspace)).toHaveLength(2);
    const runProjection = (await f.db
      .prepare(
        `SELECT event_count, last_cursor FROM run_event_projections WHERE workspace_id = ? AND run_id = ?`,
      )
      .get(FIX.workspace, bound.runId)) as Record<string, unknown>;
    expect(runProjection).toMatchObject({ event_count: 2, last_cursor: base + 2 });
    const toolCounter = (await f.db
      .prepare(
        `SELECT event_count FROM event_kind_counters WHERE workspace_id = ? AND run_execution_id = ? AND kind = 'tool_started'`,
      )
      .get(FIX.workspace, bound.executionId)) as { event_count: number };
    expect(toolCounter.event_count).toBe(1);
    expect(
      (
        (await f.db
          .prepare(`SELECT COUNT(*) AS total FROM measurement_observations WHERE workspace_id = ?`)
          .get(FIX.workspace)) as { total: number }
      ).total,
    ).toBe(2);
  });

  it("accepts out-of-order and concurrent batches with ordered cursors", async () => {
    const f = await launchFixture();
    const bound = await claimedExecution(f);
    const base = await highWater(f);
    const stream = freshStream();
    const first = await ingest(f, [submission(bound, stream, 2), submission(bound, stream, 1)]);
    expect(dispositionsOf(first)).toEqual(["accepted", "accepted"]);
    const rows = await ledgerRows(f.db, FIX.workspace);
    expect(rows.map((row) => row.source_sequence)).toEqual([2, 1]);
    expect(rows.map((row) => row.workspace_cursor)).toEqual([base + 1, base + 2]);

    const other = freshStream();
    const [left, right] = await Promise.all([
      ingest(f, [submission(bound, other, 1), submission(bound, other, 2)]),
      ingest(f, [submission(bound, other, 3), submission(bound, other, 4)]),
    ]);
    expect([...dispositionsOf(left), ...dispositionsOf(right)].sort()).toEqual([
      "accepted",
      "accepted",
      "accepted",
      "accepted",
    ]);
    // Each batch keeps consecutive cursors in submission order; ranges stay
    // disjoint (the hub audit row consumes the top of each reservation).
    const leftCursors = [left.high_water_cursor - 1, left.high_water_cursor];
    const rightCursors = [right.high_water_cursor - 1, right.high_water_cursor];
    const cursors = (await ledgerRows(f.db, FIX.workspace)).map(
      (row) => row.workspace_cursor as number,
    );
    expect(new Set(cursors).size).toBe(6);
    for (const pair of [leftCursors, rightCursors]) {
      expect(cursors).toContain(pair[0]);
      expect(cursors).toContain(pair[1]);
    }
    expect(new Set([...leftCursors, ...rightCursors]).size).toBe(4);
  });

  it("attaches delayed offline rows to their original run, never the active run", async () => {
    const f = await launchFixture();
    const first = await claimedExecution(f);
    const second = await secondExecution(f);
    expect(second.runId).not.toBe(first.runId);
    const result = await ingest(f, [
      submission(first, freshStream(), 9, {
        kind: "progress_reported",
        occurred_at: "2026-09-10T12:00:00.000Z",
      }),
    ]);
    expect(dispositionsOf(result)).toEqual(["accepted"]);
    const rows = await ledgerRows(f.db, FIX.workspace);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ run_id: first.runId, task_id: first.taskId });
  });

  it("rejects poison rows per event without blocking later rows", async () => {
    const f = await launchFixture();
    const bound = await claimedExecution(f);
    const stream = freshStream();
    const unknownExecution = submission(bound, stream, 2, { run_execution_id: randomUlid() });
    const wrongGeneration = submission(bound, stream, 3, { assignment_generation: 99 });
    const shellPayload = submission(bound, stream, 4, {
      payload: { command: "rm -rf /" } as unknown as Record<string, never>,
    });
    const unknownKind = {
      ...submission(bound, stream, 5),
      kind: "result_accepted",
    };
    const result = await ingest(f, [
      submission(bound, stream, 1),
      unknownExecution,
      wrongGeneration,
      shellPayload,
      unknownKind,
      submission(bound, stream, 6),
    ]);
    expect(dispositionsOf(result)).toEqual([
      "accepted",
      "permanently_rejected",
      "permanently_rejected",
      "permanently_rejected",
      "permanently_rejected",
      "accepted",
    ]);
    const diagnostics = result.dispositions
      .filter((entry) => entry.disposition === "permanently_rejected")
      .map((entry) => ("diagnostic" in entry ? entry.diagnostic?.code : undefined));
    expect(diagnostics).toEqual([
      "unknown_execution",
      "assignment_generation_confusion",
      expect.anything(),
      expect.anything(),
    ]);
    const rows = await ledgerRows(f.db, FIX.workspace);
    expect(rows.map((row) => row.source_sequence)).toEqual([1, 6]);
  });

  it("returns retryable when the execution has no committed assignment yet", async () => {
    const f = await launchFixture();
    const task = success(
      await f.human(createTaskCommand, {
        projectId: FIX.projectA,
        title: "Synthetic E01 bare run",
        priority: "P2",
      }),
    );
    const run = success(
      await f.human(createRunCommand, {
        taskId: task.id,
        expectedTaskVersion: 1,
        agentProfileId: f.profile.id,
        workspacePolicyVersion: 2,
        projectPolicyVersion: 2,
        repositoryConfigVersion: 2,
        agentProfileVersion: 1,
      }),
    );
    const execution = success(await f.human(createExecutionCommand, { runId: run.run.id }));
    const result = await ingest(f, [
      submission(
        { executionId: execution.id, generation: 1, runId: run.run.id, taskId: task.id },
        freshStream(),
        1,
      ),
    ]);
    expect(dispositionsOf(result)).toEqual(["retryable"]);
    const entry = result.dispositions[0];
    expect(entry.disposition).toBe("retryable");
    if (entry.disposition === "retryable") {
      expect(entry.diagnostic.code).toBe("assignment_not_committed");
    }
    expect(await ledgerRows(f.db, FIX.workspace)).toHaveLength(0);
  });

  it("rejects rows for another runner and for revoked project grants", async () => {
    const f = await launchFixture();
    const bound = await claimedExecution(f);
    const other = await secondRunner(f);
    const wrong = await ingest(f, [submission(bound, freshStream(), 1)], LAUNCH_NOW, other);
    expect(dispositionsOf(wrong)).toEqual(["permanently_rejected"]);
    expect(wrong.dispositions[0]).toMatchObject({
      disposition: "permanently_rejected",
      diagnostic: { code: "wrong_runner" },
    });
    await f.db
      .prepare(
        `DELETE FROM runner_project_grants WHERE workspace_id = ? AND runner_id = ? AND project_id = ?`,
      )
      .run(FIX.workspace, f.runner, FIX.projectA);
    const revoked = await ingest(f, [submission(bound, freshStream(), 1)]);
    expect(revoked.dispositions[0]).toMatchObject({
      disposition: "permanently_rejected",
      diagnostic: { code: "project_grant_revoked" },
    });
    expect(await ledgerRows(f.db, FIX.workspace)).toHaveLength(0);
  });

  it("rejects stream-sequence reuse and event-id confusion without touching the original", async () => {
    const f = await launchFixture();
    const bound = await claimedExecution(f);
    const stream = freshStream();
    const original = submission(bound, stream, 1);
    expect(dispositionsOf(await ingest(f, [original]))).toEqual(["accepted"]);

    const reuse = await ingest(f, [{ ...submission(bound, stream, 1), event_id: randomUlid() }]);
    expect(reuse.dispositions[0]).toMatchObject({
      disposition: "permanently_rejected",
      diagnostic: { code: "stream_sequence_conflict" },
    });
    const confused = await ingest(f, [
      { ...submission(bound, stream, 2), event_id: original.event_id },
    ]);
    expect(confused.dispositions[0]).toMatchObject({
      disposition: "permanently_rejected",
      diagnostic: { code: "event_id_confusion" },
    });
    const rows = await ledgerRows(f.db, FIX.workspace);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_id: original.event_id, source_sequence: 1 });
  });

  it("rejects future timestamps and records no observation for non-measurement rows", async () => {
    const f = await launchFixture();
    const bound = await claimedExecution(f);
    const future = await ingest(f, [
      submission(bound, freshStream(), 1, { occurred_at: "2026-09-12T12:06:00.000Z" }),
    ]);
    expect(future.dispositions[0]).toMatchObject({
      disposition: "permanently_rejected",
      diagnostic: { code: "future_timestamp" },
    });
    const attached = await ingest(f, [
      submission(bound, freshStream(), 1, { kind: "execution_attached" }),
    ]);
    expect(dispositionsOf(attached)).toEqual(["accepted"]);
    const observations = (await f.db
      .prepare(`SELECT measure_kind FROM measurement_observations WHERE workspace_id = ?`)
      .all(FIX.workspace)) as Array<{ measure_kind: string }>;
    expect(observations).toHaveLength(0);
    const execution = (await f.db
      .prepare(`SELECT state, end_reason FROM run_executions WHERE workspace_id = ? AND id = ?`)
      .get(FIX.workspace, bound.executionId)) as Record<string, unknown>;
    expect(execution).toMatchObject({ state: "launching", end_reason: null });
  });

  it("never infers results, attention, or completion from runner rows", async () => {
    const f = await launchFixture();
    const bound = await claimedExecution(f);
    const stream = freshStream();
    const result = await ingest(f, [
      submission(bound, stream, 1, {
        kind: "session_started",
        provider_session_id: "sess-synthetic-1",
      }),
      submission(bound, stream, 2, { kind: "attention_requested" }),
      submission(bound, stream, 3, { kind: "result_submitted", capture_origin: "agent_reported" }),
      submission(bound, stream, 4, {
        kind: "session_ended",
        provider_session_id: "sess-synthetic-1",
      }),
      submission(bound, stream, 5, { kind: "execution_ended" }),
      submission(bound, stream, 6, { kind: "heartbeat" }),
    ]);
    expect(dispositionsOf(result)).toEqual([
      "accepted",
      "accepted",
      "accepted",
      "accepted",
      "accepted",
      "accepted",
    ]);
    const run = (await f.db
      .prepare(`SELECT result_state, activity FROM runs WHERE workspace_id = ? AND id = ?`)
      .get(FIX.workspace, bound.runId)) as Record<string, unknown>;
    expect(run).toMatchObject({ result_state: "open" });
    const execution = (await f.db
      .prepare(`SELECT state FROM run_executions WHERE workspace_id = ? AND id = ?`)
      .get(FIX.workspace, bound.executionId)) as Record<string, unknown>;
    expect(execution).toMatchObject({ state: "launching" });
    const session = (await f.db
      .prepare(
        `SELECT event_count, last_kind FROM session_event_projections WHERE workspace_id = ? AND run_execution_id = ? AND provider_session_id = ?`,
      )
      .get(FIX.workspace, bound.executionId, "sess-synthetic-1")) as Record<string, unknown>;
    expect(session).toMatchObject({ event_count: 2, last_kind: "session_ended" });
  });

  it("replays committed envelopes with pagination and high-water reads", async () => {
    const f = await launchFixture();
    const bound = await claimedExecution(f);
    const stream = freshStream();
    const base = await highWater(f);
    await ingest(f, [
      submission(bound, stream, 1),
      submission(bound, stream, 2, { kind: "turn_started", capture_origin: "hook_inbox" }),
      submission(bound, stream, 3, { kind: "heartbeat" }),
    ]);
    const authorization = readAuthorization();
    expect(await readLedgerHighWater(f.db, authorization)).toBe(base + 3);
    const page = await listLedgerEvents(f.db, authorization, {
      afterCursor: base + 1,
      throughCursor: base + 3,
      limit: 1,
    });
    expect(page).toHaveLength(1);
    expect(page[0]).toMatchObject({
      schema_version: 1,
      workspace_cursor: base + 2,
      workspace_id: FIX.workspace,
      run_execution_id: bound.executionId,
      actor: { type: "agent_run", id: bound.executionId },
      source: { type: "runner", id: f.runner, provider: "fake" },
      kind: "turn_started",
      payload: {},
    });
    const tail = await listLedgerEvents(f.db, authorization, {
      afterCursor: base + 2,
      throughCursor: base + 3,
    });
    expect(tail.map((entry) => entry.workspace_cursor)).toEqual([base + 3]);
    const empty = await listLedgerEvents(f.db, authorization, {
      afterCursor: base + 3,
      throughCursor: base + 3,
    });
    expect(empty).toEqual([]);
    await expect(
      listLedgerEvents(f.db, authorization, { afterCursor: base + 3, throughCursor: base + 2 }),
    ).rejects.toMatchObject({ code: "invalid_event_range" });
    await expect(
      listLedgerEvents(f.db, authorization, {
        afterCursor: 0,
        throughCursor: base + 3,
        limit: 101,
      }),
    ).rejects.toMatchObject({ code: "invalid_event_range" });
  });

  it("rejects oversized batches and unidentifiable rows without committing", async () => {
    const f = await launchFixture();
    const bound = await claimedExecution(f);
    const oversized = await f.hub.execute(ingestRunnerEventsCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorRunnerId: f.runner,
      authorizationEpoch: 1,
      now: LAUNCH_NOW,
      input: {
        principal: f.principal,
        events: Array.from({ length: EVENT_BATCH_LIMIT + 1 }, (_, index) =>
          submission(bound, freshStream(), index + 1),
        ),
      },
    });
    expect(oversized.ok).toBe(false);
    const poison = await f.hub.execute(ingestRunnerEventsCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorRunnerId: f.runner,
      authorizationEpoch: 1,
      now: LAUNCH_NOW,
      input: {
        principal: f.principal,
        events: [submission(bound, freshStream(), 1), "not-an-object"],
      },
    });
    expect(poison.ok).toBe(false);
    expect(await ledgerRows(f.db, FIX.workspace)).toHaveLength(0);
    expect(
      await readLedgerHighWater(
        f.db,
        createAuthorizationContext({
          workspaceId: FIX.workspace,
          principalId: FIX.owner,
          authorizationEpoch: 1,
          jurisdiction: "eu",
        }),
      ),
    ).toBe(0);
  });

  it("keeps cursor ranges disjoint across batches with rejected rows", async () => {
    const f = await launchFixture();
    const bound = await claimedExecution(f);
    const base = await highWater(f);
    const first = await ingest(f, [
      submission(bound, freshStream(), 1),
      submission(bound, freshStream(), 2, { run_execution_id: randomUlid() }),
    ]);
    expect(dispositionsOf(first)).toEqual(["accepted", "permanently_rejected"]);
    // One cursor is reserved for the rejected row; the next batch starts after the gap.
    expect(first.high_water_cursor).toBe(base + 1);
    const second = await ingest(f, [submission(bound, freshStream(), 1)]);
    expect(dispositionsOf(second)).toEqual(["accepted"]);
    // The first batch reserved two cursors plus its audit row; the next range starts after.
    expect(second.high_water_cursor).toBe(base + 4);
    const rows = await ledgerRows(f.db, FIX.workspace);
    expect(rows.map((row) => row.workspace_cursor)).toEqual([base + 1, base + 4]);
  });
});
