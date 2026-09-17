// ABOUTME: Proves A04 interval unions, token quality separation, and price-catalog independence.
// ABOUTME: All fixtures are synthetic; seeded property tests stay deterministic without new dependencies.

import { describe, expect, it } from "vitest";

import type { SqlDatabase } from "@bfb/db";

import { FIX } from "../src/fixtures.js";
import { randomUlid } from "../src/ids.js";
import {
  aggregateMeasurements,
  BROWSER_ACTIVITY_CAP_MS,
  calculateCost,
  CURRENT_PRICE_CATALOG_VERSION,
  getRunMeasurements,
  getTaskMeasurements,
  HEARTBEAT_STALE_MS,
  listBrowserActivity,
  listMeasurementIntervals,
  listReviewTimerObservations,
  listReviewTimers,
  listTokenObservations,
  normalizeTokenFields,
  PRICE_CATALOGS,
  recordBrowserActivityCommand,
  reportIntervalCommand,
  reportTokensCommand,
  startReviewTimerCommand,
  stopReviewTimerCommand,
  sumTokenFields,
  summarizeTokens,
  tokenFieldsPresent,
  unionIntervalsMs,
  type IntervalMs,
  type TokenFields,
} from "../src/measurements.js";
import { createTaskCommand } from "../src/work-commands.js";
import { launchFixture, LAUNCH_NOW, success } from "./launch-fixture.js";

type Fixture = Awaited<ReturnType<typeof launchFixture>>;

let ledgerCursor = 1000;

async function insertLedger(
  db: SqlDatabase,
  input: {
    runId: string;
    executionId: string;
    taskId: string;
    kind: string;
    occurredAt: string;
    streamId?: string;
  },
): Promise<void> {
  ledgerCursor += 1;
  await db
    .prepare(
      `INSERT INTO event_ledger
       (workspace_id, event_id, workspace_cursor, source_stream_id, source_sequence,
        run_execution_id, assignment_generation, project_id, task_id, run_id,
        actor_type, actor_id, source_type, source_id, capture_origin, kind,
        occurred_at, received_at, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'agent_run', ?, 'runner', ?, 'hook_inbox', ?, ?, ?, '{}')`,
    )
    .run(
      FIX.workspace,
      randomUlid(),
      ledgerCursor,
      input.streamId ?? randomUlid(),
      ledgerCursor,
      input.executionId,
      FIX.projectA,
      input.taskId,
      input.runId,
      input.executionId,
      "synthetic-runner",
      input.kind,
      input.occurredAt,
      input.occurredAt,
    );
}

async function endExecution(db: SqlDatabase, executionId: string, endedAt: string): Promise<void> {
  await db
    .prepare(
      `UPDATE run_executions SET state = 'ended', end_reason = 'process_exit', ended_at = ?
       WHERE workspace_id = ? AND id = ?`,
    )
    .run(endedAt, FIX.workspace, executionId);
}

/** Deterministic PRNG so the property suite reproduces exactly on every run. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

describe("unionIntervalsMs", () => {
  it("merges overlapping intervals without double counting", () => {
    expect(
      unionIntervalsMs([
        { start: 0, end: 100 },
        { start: 50, end: 150 },
      ]),
    ).toEqual({
      total_ms: 150,
      observation_count: 1,
    });
  });

  it("merges adjacent intervals and keeps disjoint ones separate", () => {
    expect(
      unionIntervalsMs([
        { start: 0, end: 100 },
        { start: 100, end: 200 },
        { start: 500, end: 600 },
      ]),
    ).toEqual({ total_ms: 300, observation_count: 2 });
  });

  it("ignores zero-length intervals and reports empty input honestly", () => {
    expect(unionIntervalsMs([])).toEqual({ total_ms: 0, observation_count: 0 });
    expect(unionIntervalsMs([{ start: 42, end: 42 }])).toEqual({
      total_ms: 0,
      observation_count: 1,
    });
  });

  it("collapses exact duplicate replays to one contribution", () => {
    const replay = [
      { start: 0, end: 100 },
      { start: 0, end: 100 },
      { start: 0, end: 100 },
    ];
    expect(unionIntervalsMs(replay)).toEqual({ total_ms: 100, observation_count: 1 });
  });

  it("matches brute-force coverage on a seeded property sweep", () => {
    const random = mulberry32(20260917);
    for (let trial = 0; trial < 300; trial += 1) {
      const count = 1 + Math.floor(random() * 6);
      const intervals: IntervalMs[] = [];
      for (let index = 0; index < count; index += 1) {
        const start = Math.floor(random() * 40);
        const end = start + Math.floor(random() * 20);
        intervals.push({ start, end });
      }
      const union = unionIntervalsMs(intervals);
      const covered = new Set<number>();
      for (const interval of intervals) {
        for (let ms = interval.start; ms < interval.end; ms += 1) {
          covered.add(ms);
        }
      }
      expect(union.total_ms, `trial ${trial}: ${JSON.stringify(intervals)}`).toBe(covered.size);
      const sum = intervals.reduce((total, interval) => total + (interval.end - interval.start), 0);
      expect(union.total_ms).toBeLessThanOrEqual(sum);
      const longest = Math.max(...intervals.map((interval) => interval.end - interval.start));
      expect(union.total_ms).toBeGreaterThanOrEqual(longest);
      // Replaying every observation changes nothing.
      expect(unionIntervalsMs([...intervals, ...intervals]).total_ms).toBe(union.total_ms);
    }
  });
});

describe("normalizeTokenFields", () => {
  it("maps the Codex usage shape without invention", () => {
    expect(
      normalizeTokenFields({
        input_tokens: 120,
        output_tokens: 34,
        cached_input_tokens: 100,
        reasoning_output_tokens: 5,
      }),
    ).toEqual({ input: 120, output: 34, cache_read: 100, cache_write: null, reasoning: 5 });
  });

  it("maps the Claude hook usage shape without invention", () => {
    expect(
      normalizeTokenFields({
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 6,
      }),
    ).toEqual({ input: 10, output: 20, cache_read: 4, cache_write: 6, reasoning: null });
  });

  it("keeps absent fields absent instead of zeroing them", () => {
    const fields = normalizeTokenFields({ input_tokens: 7, output_tokens: 8 });
    expect(fields).toEqual({
      input: 7,
      output: 8,
      cache_read: null,
      cache_write: null,
      reasoning: null,
    });
    expect(tokenFieldsPresent(fields)).toBe(true);
    expect(
      tokenFieldsPresent({
        input: null,
        output: null,
        cache_read: null,
        cache_write: null,
        reasoning: null,
      }),
    ).toBe(false);
  });

  it("rejects negative, fractional, and unsafe counts", () => {
    for (const bad of [
      { input_tokens: -1, output_tokens: 2 },
      { input_tokens: 1.5, output_tokens: 2 },
      { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 2 },
      "usage",
      null,
    ]) {
      expect(() => normalizeTokenFields(bad)).toThrow();
    }
  });

  it("sums only present fields and never fills gaps with zero", () => {
    const rows: TokenFields[] = [
      { input: 10, output: null, cache_read: 3, cache_write: null, reasoning: null },
      { input: 5, output: 7, cache_read: null, cache_write: null, reasoning: 1 },
    ];
    expect(sumTokenFields(rows)).toEqual({
      input: 15,
      output: 7,
      cache_read: 3,
      cache_write: null,
      reasoning: 1,
    });
    expect(sumTokenFields([])).toEqual({
      input: null,
      output: null,
      cache_read: null,
      cache_write: null,
      reasoning: null,
    });
  });
});

describe("calculateCost", () => {
  const tokens: TokenFields = {
    input: 1_000_000,
    output: 500_000,
    cache_read: null,
    cache_write: null,
    reasoning: null,
  };

  it("prices exact token facts under the current catalog", () => {
    const cost = calculateCost(
      tokens,
      "codex-fixture-model",
      CURRENT_PRICE_CATALOG_VERSION,
      "2026-09-12T12:00:00.000Z",
    );
    expect(cost).toMatchObject({ catalog_version: CURRENT_PRICE_CATALOG_VERSION, reason: null });
    expect(cost.amount_usd).toBeCloseTo(1.5 + 3.0, 9);
  });

  it("recomputes historical totals under a superseded catalog without touching token facts", () => {
    const current = calculateCost(
      tokens,
      "codex-fixture-model",
      "2026-09-01",
      "2026-09-12T12:00:00.000Z",
    );
    const historical = calculateCost(
      tokens,
      "codex-fixture-model",
      "2026-06-01",
      "2026-09-12T12:00:00.000Z",
    );
    expect(historical.amount_usd).toBeCloseTo(2.0 + 4.0, 9);
    expect(historical.amount_usd).not.toBe(current.amount_usd);
    expect(Object.keys(PRICE_CATALOGS)).toEqual(["2026-06-01", "2026-09-01"]);
  });

  it("returns null instead of another model's price for unknown models", () => {
    const cost = calculateCost(
      tokens,
      "unlisted-model",
      CURRENT_PRICE_CATALOG_VERSION,
      "2026-09-12T12:00:00.000Z",
    );
    expect(cost).toEqual({
      amount_usd: null,
      catalog_version: CURRENT_PRICE_CATALOG_VERSION,
      calculated_at: "2026-09-12T12:00:00.000Z",
      reason: "unknown_model",
    });
  });

  it("rejects unknown catalog versions", () => {
    expect(() =>
      calculateCost(tokens, "codex-fixture-model", "2020-01-01", "2026-09-12T12:00:00.000Z"),
    ).toThrow();
  });

  it("exposes the heartbeat and browser-activity constants the derivations rely on", () => {
    expect(HEARTBEAT_STALE_MS).toBe(45_000);
    expect(BROWSER_ACTIVITY_CAP_MS).toBe(300_000);
  });
});

describe("token.report and interval.report", () => {
  it("stores uniquely identified observations and replays them without a second effect", async () => {
    const f = await launchFixture();
    const { claimed } = await f.claim();
    const spec = claimed.specification;
    const observationId = randomUlid();
    const input = {
      principal: f.principal,
      observationId,
      runId: spec.run_id,
      executionId: spec.run_execution_id,
      assignmentGeneration: spec.assignment_generation,
      provider: "codex" as const,
      model: "codex-fixture-model",
      tokens: { input_tokens: 120, output_tokens: 34, cached_input_tokens: 100 },
      quality: "provider_reported" as const,
    };
    const first = success(await f.native(reportTokensCommand, input));
    expect(first.observation_id).toBe(observationId);
    expect(first.tokens).toEqual({
      input: 120,
      output: 34,
      cache_read: 100,
      cache_write: null,
      reasoning: null,
    });
    const replay = success(await f.native(reportTokensCommand, input));
    expect(replay).toEqual(first);
    expect(await listTokenObservations(f.db, FIX.workspace, spec.run_id)).toHaveLength(1);

    const intervalId = randomUlid();
    const interval = success(
      await f.native(reportIntervalCommand, {
        principal: f.principal,
        observationId: intervalId,
        runId: spec.run_id,
        executionId: spec.run_execution_id,
        assignmentGeneration: spec.assignment_generation,
        intervalKind: "external_wait",
        startedAt: "2026-09-12T12:01:00.000Z",
        endedAt: "2026-09-12T12:03:00.000Z",
      }),
    );
    expect(interval.observation_id).toBe(intervalId);
    const intervalReplay = success(
      await f.native(reportIntervalCommand, {
        principal: f.principal,
        observationId: intervalId,
        runId: spec.run_id,
        executionId: spec.run_execution_id,
        assignmentGeneration: spec.assignment_generation,
        intervalKind: "external_wait",
        startedAt: "2026-09-12T12:01:00.000Z",
        endedAt: "2026-09-12T12:03:00.000Z",
      }),
    );
    expect(intervalReplay).toEqual(interval);
    expect(await listMeasurementIntervals(f.db, FIX.workspace, spec.run_id)).toHaveLength(1);
  });

  it("rejects observation-id reuse across different reports", async () => {
    const f = await launchFixture();
    const { claimed } = await f.claim();
    const spec = claimed.specification;
    const observationId = randomUlid();
    const base = {
      principal: f.principal,
      observationId,
      runId: spec.run_id,
      executionId: spec.run_execution_id,
      assignmentGeneration: spec.assignment_generation,
      provider: "codex" as const,
      quality: "provider_reported" as const,
    };
    success(
      await f.native(reportTokensCommand, {
        ...base,
        tokens: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    const confused = await f.native(reportTokensCommand, {
      ...base,
      tokens: { input_tokens: 2, output_tokens: 1 },
    });
    expect(confused).toMatchObject({ ok: false });
    if (!confused.ok) {
      expect(confused.error.code).toBe("conflict");
    }
  });

  it("rejects foreign executions, unavailable rows with counters, and inverted intervals", async () => {
    const f = await launchFixture();
    const { claimed } = await f.claim();
    const spec = claimed.specification;
    const foreign = await f.native(reportTokensCommand, {
      principal: f.principal,
      runId: spec.run_id,
      executionId: randomUlid(),
      assignmentGeneration: spec.assignment_generation,
      provider: "codex" as const,
      tokens: { input_tokens: 1, output_tokens: 1 },
      quality: "provider_reported" as const,
    });
    expect(foreign).toMatchObject({ ok: false });

    const unavailable = await f.native(reportTokensCommand, {
      principal: f.principal,
      runId: spec.run_id,
      executionId: spec.run_execution_id,
      assignmentGeneration: spec.assignment_generation,
      provider: "claude" as const,
      tokens: { input_tokens: 1 },
      quality: "unavailable" as const,
    });
    expect(unavailable).toMatchObject({ ok: false });

    const empty = await f.native(reportTokensCommand, {
      principal: f.principal,
      runId: spec.run_id,
      executionId: spec.run_execution_id,
      assignmentGeneration: spec.assignment_generation,
      provider: "claude" as const,
      tokens: {},
      quality: "estimated" as const,
    });
    expect(empty).toMatchObject({ ok: false });

    const inverted = await f.native(reportIntervalCommand, {
      principal: f.principal,
      runId: spec.run_id,
      executionId: spec.run_execution_id,
      assignmentGeneration: spec.assignment_generation,
      intervalKind: "idle",
      startedAt: "2026-09-12T12:03:00.000Z",
      endedAt: "2026-09-12T12:01:00.000Z",
    });
    expect(inverted).toMatchObject({ ok: false });

    const controlModel = await f.native(reportTokensCommand, {
      principal: f.principal,
      runId: spec.run_id,
      executionId: spec.run_execution_id,
      assignmentGeneration: spec.assignment_generation,
      provider: "codex" as const,
      model: "bad\nmodel",
      tokens: { input_tokens: 1, output_tokens: 1 },
      quality: "provider_reported" as const,
    });
    expect(controlModel).toMatchObject({ ok: false });
  });

  it("stores unavailable usage honestly instead of inventing zeros", async () => {
    const f = await launchFixture();
    const { claimed } = await f.claim();
    const spec = claimed.specification;
    const stored = success(
      await f.native(reportTokensCommand, {
        principal: f.principal,
        runId: spec.run_id,
        executionId: spec.run_execution_id,
        assignmentGeneration: spec.assignment_generation,
        provider: "grok" as const,
        tokens: {},
        quality: "unavailable" as const,
      }),
    );
    expect(stored.tokens).toEqual({
      input: null,
      output: null,
      cache_read: null,
      cache_write: null,
      reasoning: null,
    });
    const measured = await getRunMeasurements(f.db, FIX.workspace, spec.run_id, LAUNCH_NOW);
    expect(measured.tokens.unavailable_count).toBe(1);
    expect(measured.tokens.exact).toEqual({
      input: null,
      output: null,
      cache_read: null,
      cache_write: null,
      reasoning: null,
    });
    expect(measured.tokens.costs_total_usd).toBeNull();
  });
});

describe("run derivations", () => {
  async function attachedRun(f: Fixture) {
    const { claimed } = await f.claim();
    return { spec: claimed.specification };
  }

  it("deduplicates overlapping turn and tool intervals while keeping elapsed wall time", async () => {
    const f = await launchFixture();
    const { spec } = await attachedRun(f);
    const base = { runId: spec.run_id, executionId: spec.run_execution_id, taskId: spec.task_id };
    await insertLedger(f.db, {
      ...base,
      kind: "execution_attached",
      occurredAt: "2026-09-12T12:00:00.000Z",
    });
    await insertLedger(f.db, {
      ...base,
      kind: "turn_started",
      occurredAt: "2026-09-12T12:00:10.000Z",
    });
    await insertLedger(f.db, {
      ...base,
      kind: "tool_started",
      occurredAt: "2026-09-12T12:00:20.000Z",
    });
    await insertLedger(f.db, {
      ...base,
      kind: "tool_finished",
      occurredAt: "2026-09-12T12:00:40.000Z",
    });
    await insertLedger(f.db, {
      ...base,
      kind: "turn_stopped",
      occurredAt: "2026-09-12T12:01:00.000Z",
    });
    for (const stamp of [
      "12:00:15",
      "12:00:30",
      "12:00:45",
      "12:01:00",
      "12:01:15",
      "12:01:30",
      "12:01:45",
    ]) {
      await insertLedger(f.db, {
        ...base,
        kind: "heartbeat",
        occurredAt: `2026-09-12T${stamp}.000Z`,
      });
    }
    await endExecution(f.db, spec.run_execution_id, "2026-09-12T12:02:00.000Z");

    const measured = await getRunMeasurements(
      f.db,
      FIX.workspace,
      spec.run_id,
      "2026-09-12T12:05:00.000Z",
    );
    expect(measured.times.active_ms).toBe(50_000);
    expect(measured.times.process_elapsed_ms).toBe(120_000);
    expect(measured.times.process_alive_ms).toBe(120_000);
    expect(measured.times.offline_ms).toBe(0);
    expect(measured.times.open_intervals).toBe(0);
    expect(measured.times.live_execution).toBe(false);
    expect(measured.provenance.ledger_events).toBe(12);
  });

  it("keeps runner-offline wall time visible instead of silently removing it", async () => {
    const f = await launchFixture();
    const { spec } = await attachedRun(f);
    const base = { runId: spec.run_id, executionId: spec.run_execution_id, taskId: spec.task_id };
    await insertLedger(f.db, {
      ...base,
      kind: "execution_attached",
      occurredAt: "2026-09-12T12:00:00.000Z",
    });
    await insertLedger(f.db, {
      ...base,
      kind: "heartbeat",
      occurredAt: "2026-09-12T12:00:10.000Z",
    });
    await insertLedger(f.db, {
      ...base,
      kind: "heartbeat",
      occurredAt: "2026-09-12T12:05:00.000Z",
    });
    await endExecution(f.db, spec.run_execution_id, "2026-09-12T12:06:00.000Z");

    const measured = await getRunMeasurements(
      f.db,
      FIX.workspace,
      spec.run_id,
      "2026-09-12T12:10:00.000Z",
    );
    expect(measured.times.process_elapsed_ms).toBe(360_000);
    // The 12:00:10 to 12:05:00 gap contributes 245s beyond the 45s
    // threshold, and the silent minute before verified end contributes 15s.
    // Elapsed time keeps the full span; offline stays visible beside it.
    expect(measured.times.offline_ms).toBe(260_000);
    expect(measured.times.process_elapsed_ms).toBeGreaterThan(measured.times.offline_ms);
  });

  it("reports unpaired starts as open intervals contributing nothing", async () => {
    const f = await launchFixture();
    const { spec } = await attachedRun(f);
    const base = { runId: spec.run_id, executionId: spec.run_execution_id, taskId: spec.task_id };
    await insertLedger(f.db, {
      ...base,
      kind: "execution_attached",
      occurredAt: "2026-09-12T12:00:00.000Z",
    });
    await insertLedger(f.db, {
      ...base,
      kind: "turn_started",
      occurredAt: "2026-09-12T12:00:10.000Z",
    });
    await endExecution(f.db, spec.run_execution_id, "2026-09-12T12:02:00.000Z");

    const measured = await getRunMeasurements(
      f.db,
      FIX.workspace,
      spec.run_id,
      "2026-09-12T12:05:00.000Z",
    );
    expect(measured.times.open_intervals).toBe(1);
    expect(measured.times.active_ms).toBe(0);
  });

  it("unions blocking attention waits and excludes non-blocking requests", async () => {
    const f = await launchFixture();
    const { spec } = await attachedRun(f);
    const base = { runId: spec.run_id, executionId: spec.run_execution_id, taskId: spec.task_id };
    await insertLedger(f.db, {
      ...base,
      kind: "execution_attached",
      occurredAt: "2026-09-12T12:00:00.000Z",
    });
    await endExecution(f.db, spec.run_execution_id, "2026-09-12T12:10:00.000Z");
    const blockingOne = randomUlid();
    const blockingTwo = randomUlid();
    const casual = randomUlid();
    const insertAttention = f.db.prepare(
      `INSERT INTO attention_requests
       (workspace_id, id, project_id, task_id, run_id, run_execution_id, assignment_generation,
        kind, required_role, reference_kind, reference_id, question, blocking, state,
        answer, answered_by_human_id, requested_at, first_response_at, answered_at, resolved_at, resource_version)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, NULL, 'Synthetic blocker', ?, ?, NULL, NULL, ?, ?, ?, ?, 1)`,
    );
    await insertAttention.run(
      FIX.workspace,
      blockingOne,
      FIX.projectA,
      spec.task_id,
      spec.run_id,
      spec.run_execution_id,
      "blocker",
      "member",
      1,
      "open",
      "2026-09-12T12:01:00.000Z",
      null,
      null,
      null,
    );
    await insertAttention.run(
      FIX.workspace,
      blockingTwo,
      FIX.projectA,
      spec.task_id,
      spec.run_id,
      spec.run_execution_id,
      "blocker",
      "member",
      1,
      "answered",
      "2026-09-12T12:02:00.000Z",
      "2026-09-12T12:02:30.000Z",
      "2026-09-12T12:04:00.000Z",
      null,
    );
    await insertAttention.run(
      FIX.workspace,
      casual,
      FIX.projectA,
      spec.task_id,
      spec.run_id,
      spec.run_execution_id,
      "clarification",
      "reviewer",
      0,
      "open",
      "2026-09-12T12:00:00.000Z",
      null,
      null,
      null,
    );

    const measured = await getRunMeasurements(
      f.db,
      FIX.workspace,
      spec.run_id,
      "2026-09-12T12:10:00.000Z",
    );
    // Blocking spans [12:01, 12:10] and [12:02, 12:04] union to 9 minutes.
    expect(measured.times.attention_wait_ms).toBe(540_000);
    expect(measured.times.attention_open).toBe(true);
    const latencies = new Map(measured.attention.map((entry) => [entry.request_id, entry]));
    expect(latencies.get(blockingTwo)).toMatchObject({
      first_response_ms: 30_000,
      resolution_ms: 120_000,
      open: false,
    });
    expect(latencies.get(blockingOne)).toMatchObject({ resolution_ms: null, open: true });
  });

  it("measures launch latency to attach and to expiry", async () => {
    const f = await launchFixture();
    const { spec } = await attachedRun(f);
    await insertLedger(f.db, {
      runId: spec.run_id,
      executionId: spec.run_execution_id,
      taskId: spec.task_id,
      kind: "execution_attached",
      occurredAt: "2026-09-12T12:00:30.000Z",
    });
    const measured = await getRunMeasurements(f.db, FIX.workspace, spec.run_id, LAUNCH_NOW);
    expect(measured.times.launch_latency_ms).toBe(30_000);
    expect(measured.times.launch_latency_reason).toBeNull();
  });

  it("separates estimated tokens from exact totals and prices exact tokens", async () => {
    const f = await launchFixture();
    const { spec } = await attachedRun(f);
    const report = {
      principal: f.principal,
      runId: spec.run_id,
      executionId: spec.run_execution_id,
      assignmentGeneration: spec.assignment_generation,
      provider: "codex" as const,
      model: "codex-fixture-model",
    };
    success(
      await f.native(reportTokensCommand, {
        ...report,
        tokens: { input_tokens: 1_000_000, output_tokens: 500_000 },
        quality: "provider_reported" as const,
      }),
    );
    success(
      await f.native(reportTokensCommand, {
        ...report,
        tokens: { input_tokens: 100, output_tokens: 50 },
        quality: "estimated" as const,
      }),
    );
    const measured = await getRunMeasurements(f.db, FIX.workspace, spec.run_id, LAUNCH_NOW);
    expect(measured.tokens.exact).toMatchObject({ input: 1_000_000, output: 500_000 });
    expect(measured.tokens.estimated).toMatchObject({ input: 100, output: 50 });
    expect(measured.tokens.costs_total_usd).toBeCloseTo(4.5, 9);
    expect(measured.tokens.catalog_version).toBe(CURRENT_PRICE_CATALOG_VERSION);
  });

  it("summarizes mixed qualities without merging them", () => {
    const summary = summarizeTokens(
      [
        {
          observation_id: randomUlid(),
          run_id: randomUlid(),
          run_execution_id: randomUlid(),
          provider: "codex",
          model: "codex-fixture-model",
          tokens: { input: 10, output: 5, cache_read: null, cache_write: null, reasoning: null },
          quality: "stream_derived",
          provenance: "hook_inbox",
          occurred_at: LAUNCH_NOW,
          committed_at: LAUNCH_NOW,
        },
        {
          observation_id: randomUlid(),
          run_id: randomUlid(),
          run_execution_id: randomUlid(),
          provider: "codex",
          model: "unlisted-model",
          tokens: { input: 7, output: 1, cache_read: null, cache_write: null, reasoning: null },
          quality: "estimated",
          provenance: "agent_reported",
          occurred_at: LAUNCH_NOW,
          committed_at: LAUNCH_NOW,
        },
      ],
      CURRENT_PRICE_CATALOG_VERSION,
      LAUNCH_NOW,
    );
    expect(summary.exact).toMatchObject({ input: 10, output: 5 });
    expect(summary.estimated).toMatchObject({ input: 7, output: 1 });
    expect(summary.unavailable_count).toBe(0);
    expect(summary.costs).toHaveLength(1);
  });
});

describe("review timers", () => {
  it("accumulates explicit reviewer time with observations", async () => {
    const f = await launchFixture();
    const timer = success(await f.human(startReviewTimerCommand, { taskId: f.task.id }));
    expect(timer.state).toBe("open");
    const stopped = success(
      await f.human(
        stopReviewTimerCommand,
        { timerId: timer.id, expectedVersion: 1 },
        "2026-09-12T12:04:00.000Z",
      ),
    );
    expect(stopped.state).toBe("stopped");
    expect(await listReviewTimers(f.db, FIX.workspace, f.task.id)).toHaveLength(1);
    expect(await listReviewTimerObservations(f.db, FIX.workspace, timer.id)).toHaveLength(2);
    const measured = await getTaskMeasurements(
      f.db,
      FIX.workspace,
      f.task.id,
      "2026-09-12T12:10:00.000Z",
    );
    expect(measured.review.stopped_total_ms).toBe(240_000);
    expect(measured.review.open_ms).toBe(0);
  });

  it("rejects double start, foreign stop, stale versions, and double stop", async () => {
    const f = await launchFixture();
    const timer = success(await f.human(startReviewTimerCommand, { taskId: f.task.id }));
    const duplicate = await f.human(startReviewTimerCommand, { taskId: f.task.id });
    expect(duplicate).toMatchObject({ ok: false });
    if (!duplicate.ok) {
      expect(duplicate.error.code).toBe("timer_open");
    }
    const foreign = await f.human(
      stopReviewTimerCommand,
      { timerId: timer.id, expectedVersion: 1 },
      LAUNCH_NOW,
      FIX.member,
    );
    expect(foreign).toMatchObject({ ok: false });
    if (!foreign.ok) {
      expect(foreign.error.code).toBe("forbidden");
    }
    const stale = await f.human(stopReviewTimerCommand, { timerId: timer.id, expectedVersion: 7 });
    expect(stale).toMatchObject({ ok: false });
    success(await f.human(stopReviewTimerCommand, { timerId: timer.id, expectedVersion: 1 }));
    const repeated = await f.human(stopReviewTimerCommand, {
      timerId: timer.id,
      expectedVersion: 2,
    });
    expect(repeated).toMatchObject({ ok: false });
    if (!repeated.ok) {
      expect(repeated.error.code).toBe("invalid_transition");
    }
  });

  it("keeps one open timer per task per human but allows a second task", async () => {
    const f = await launchFixture();
    success(await f.human(startReviewTimerCommand, { taskId: f.task.id }));
    const otherTask = success(
      await f.human(createTaskCommand, {
        projectId: FIX.projectA,
        title: "Synthetic second review task",
        priority: "P2",
      }),
    );
    const other = success(await f.human(startReviewTimerCommand, { taskId: otherTask.id }));
    expect(other.state).toBe("open");
  });
});

describe("browser activity", () => {
  it("caps stored intervals and always labels them estimated", async () => {
    const f = await launchFixture();
    const recorded = success(
      await f.human(recordBrowserActivityCommand, {
        taskId: f.task.id,
        startedAt: "2026-09-12T12:00:00.000Z",
        endedAt: "2026-09-12T13:00:00.000Z",
      }),
    );
    expect(recorded.capped).toBe(true);
    expect(recorded.ended_at).toBe("2026-09-12T12:05:00.000Z");
    const rows = await listBrowserActivity(f.db, FIX.workspace, FIX.owner);
    expect(rows).toHaveLength(1);
    const measured = await getTaskMeasurements(f.db, FIX.workspace, f.task.id, LAUNCH_NOW);
    expect(measured.browser_activity).toEqual([
      { human_id: FIX.owner, observed_ms: 300_000, capped_observations: 1, quality: "estimated" },
    ]);
  });

  it("rejects inverted and future intervals", async () => {
    const f = await launchFixture();
    const inverted = await f.human(recordBrowserActivityCommand, {
      startedAt: "2026-09-12T12:05:00.000Z",
      endedAt: "2026-09-12T12:00:00.000Z",
    });
    expect(inverted).toMatchObject({ ok: false });
    const future = await f.human(recordBrowserActivityCommand, {
      startedAt: "2026-09-12T12:30:00.000Z",
      endedAt: "2026-09-12T12:31:00.000Z",
    });
    expect(future).toMatchObject({ ok: false });
  });
});

describe("task measurements and aggregation", () => {
  it("rolls runs up without inventing cross-run unions and counts interventions", async () => {
    const f = await launchFixture();
    const { claimed } = await f.claim();
    const spec = claimed.specification;
    const base = { runId: spec.run_id, executionId: spec.run_execution_id, taskId: spec.task_id };
    await insertLedger(f.db, {
      ...base,
      kind: "execution_attached",
      occurredAt: "2026-09-12T12:00:00.000Z",
    });
    await insertLedger(f.db, {
      ...base,
      kind: "turn_started",
      occurredAt: "2026-09-12T12:00:10.000Z",
    });
    await insertLedger(f.db, {
      ...base,
      kind: "turn_stopped",
      occurredAt: "2026-09-12T12:01:10.000Z",
    });
    await endExecution(f.db, spec.run_execution_id, "2026-09-12T12:02:00.000Z");
    success(
      await f.native(reportTokensCommand, {
        principal: f.principal,
        runId: spec.run_id,
        executionId: spec.run_execution_id,
        assignmentGeneration: spec.assignment_generation,
        provider: "codex" as const,
        tokens: { input_tokens: 100, output_tokens: 20 },
        quality: "provider_reported" as const,
      }),
    );

    const measured = await getTaskMeasurements(
      f.db,
      FIX.workspace,
      spec.task_id,
      "2026-09-12T12:10:00.000Z",
    );
    expect(measured.runs).toHaveLength(1);
    expect(measured.totals.active_ms).toBe(60_000);
    expect(measured.totals.process_elapsed_ms).toBe(120_000);
    expect(measured.totals.exact_tokens).toMatchObject({ input: 100, output: 20 });
    expect(measured.interventions.runs).toBe(1);
    expect(measured.interventions.restarts).toBe(0);
    expect(measured.review.stopped_total_ms).toBe(0);
    // Human review time and attention latency stay distinct from agent time.
    expect(measured.review.stopped_total_ms).not.toBe(measured.totals.active_ms);
  });

  it("aggregates by project, provider, and priority with filters", async () => {
    const f = await launchFixture();
    const { claimed } = await f.claim();
    const spec = claimed.specification;
    await insertLedger(f.db, {
      runId: spec.run_id,
      executionId: spec.run_execution_id,
      taskId: spec.task_id,
      kind: "execution_attached",
      occurredAt: "2026-09-12T12:00:00.000Z",
    });
    await endExecution(f.db, spec.run_execution_id, "2026-09-12T12:01:00.000Z");

    const all = await aggregateMeasurements(f.db, FIX.workspace, {}, "2026-09-12T12:10:00.000Z");
    expect(all.truncated).toBe(false);
    expect(all.cells).toHaveLength(1);
    expect(all.cells[0]).toMatchObject({
      project_id: FIX.projectA,
      provider: "fake",
      priority: "P2",
      runs: 1,
      process_elapsed_ms: 60_000,
    });
    const filtered = await aggregateMeasurements(
      f.db,
      FIX.workspace,
      { projectId: FIX.projectB },
      "2026-09-12T12:10:00.000Z",
    );
    expect(filtered.cells).toHaveLength(0);
  });

  it("reports unknown runs and tasks as not_found", async () => {
    const f = await launchFixture();
    await expect(
      getRunMeasurements(f.db, FIX.workspace, randomUlid(), LAUNCH_NOW),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      getTaskMeasurements(f.db, FIX.workspace, randomUlid(), LAUNCH_NOW),
    ).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
