// ABOUTME: Reproduces runtime measurement errors with actual migrated persistence and reads.
// ABOUTME: Pins truthful process bounds, current offline gaps, immutable provenance and safe totals.

import { describe, expect, it } from "vitest";

import { FIX } from "../src/fixtures.js";
import { randomUlid } from "../src/ids.js";
import {
  aggregateMeasurements,
  CURRENT_PRICE_CATALOG_VERSION,
  getRunMeasurements,
  getTaskMeasurements,
  persistTokenObservation,
  summarizeTokens,
  sumTokenFields,
  type TokenObservation,
} from "../src/measurements.js";
import { launchFixture, LAUNCH_NOW } from "./launch-fixture.js";

const at = (seconds: number) => new Date(Date.parse(LAUNCH_NOW) + seconds * 1000).toISOString();

async function fixture() {
  const f = await launchFixture();
  const { claimed } = await f.claim();
  const spec = claimed.specification;
  let cursor = 1000;
  async function event(
    kind: string,
    seconds: number,
    execution = spec.run_execution_id,
    generation = spec.assignment_generation,
    session: string | null = null,
  ) {
    cursor += 1;
    const id = randomUlid();
    await f.db
      .prepare(
        `INSERT INTO event_ledger
      (workspace_id,event_id,workspace_cursor,source_stream_id,source_sequence,
       run_execution_id,assignment_generation,project_id,task_id,run_id,
       actor_type,actor_id,source_type,source_id,capture_origin,kind,
       occurred_at,received_at,payload_json,provider_session_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,'runner',?,'runner',?,'runner_observed',?,?,?,'{}',?)`,
      )
      .run(
        FIX.workspace,
        id,
        cursor,
        randomUlid(),
        cursor,
        execution,
        generation,
        FIX.projectA,
        spec.task_id,
        spec.run_id,
        f.runner,
        f.runner,
        kind,
        at(seconds),
        at(seconds),
        session,
      );
    return id;
  }
  async function activity(
    kind: string,
    seconds: number,
    identity: string,
    session: string | null = null,
  ) {
    const id = await event(
      kind,
      seconds,
      spec.run_execution_id,
      spec.assignment_generation,
      session,
    );
    await f.db
      .prepare(
        `INSERT INTO measurement_sources
      (workspace_id,source_key,event_id,run_id,run_execution_id,assignment_generation,
       runner_id,provider,provider_session_id,family,identity,phase,parent_turn_id,semantic_fingerprint)
      VALUES (?,?,?,?,?,?,?,'fake',?,'tool',?,?,NULL,?)`,
      )
      .run(
        FIX.workspace,
        String(cursor).padStart(64, "0"),
        id,
        spec.run_id,
        spec.run_execution_id,
        spec.assignment_generation,
        f.runner,
        session,
        identity,
        kind === "tool_started" ? "start" : "end",
        "a".repeat(64),
      );
    await f.db
      .prepare(
        `INSERT INTO measurement_event_sources
      (workspace_id,event_id,canonical_event_id,input_fingerprint) VALUES (?,?,?,?)`,
      )
      .run(FIX.workspace, id, id, "b".repeat(64));
    return id;
  }
  async function interval(kind: string, start: number, end: number) {
    await f.db
      .prepare(
        `INSERT INTO measurement_intervals
      (workspace_id,observation_id,run_id,run_execution_id,interval_kind,
       started_at,ended_at,provenance,occurred_at,committed_at)
      VALUES (?,?,?,?,?,?,?,'runner_observed',?,?)`,
      )
      .run(
        FIX.workspace,
        randomUlid(),
        spec.run_id,
        spec.run_execution_id,
        kind,
        at(start),
        at(end),
        at(0),
        at(0),
      );
  }
  async function state(value: string, end?: number) {
    await f.db
      .prepare(
        `UPDATE run_executions SET state=?,ended_at=?,end_reason=?
      WHERE workspace_id=? AND id=?`,
      )
      .run(
        value,
        end === undefined ? null : at(end),
        end === undefined ? null : "process_exit",
        FIX.workspace,
        spec.run_execution_id,
      );
  }
  const read = (seconds = 120) => getRunMeasurements(f.db, FIX.workspace, spec.run_id, at(seconds));
  return { ...f, spec, event, activity, interval, state, read };
}

describe("connected measurement derivation regressions", () => {
  it.each(["queued", "launching", "ended"])(
    "does not invent process time for unattached %s execution",
    async (state) => {
      const f = await fixture();
      await f.state(state, state === "ended" ? 90 : undefined);
      const measured = await f.read();
      expect(measured.times.process_elapsed_ms).toBeNull();
      expect(measured.times.process_alive_ms).toBe(0);
      expect(measured.times.live_execution).toBe(false);
      expect(measured.times.offline_ms).toBe(0);
    },
  );

  it.each([
    [55, 0],
    [56, 1000],
    [120, 65_000],
  ])("reports the live stale tail at %s seconds", async (now, expected) => {
    const f = await fixture();
    await f.event("execution_attached", 0);
    await f.event("heartbeat", 10);
    await f.state("attached");
    const measured = await f.read(now);
    expect(measured.times.process_elapsed_ms).toBe(now * 1000);
    expect(measured.times.offline_ms).toBe(expected);
    expect(measured.times.live_execution).toBe(true);
    expect(measured.result_state).toBe("open");
  });

  it("clips reported activity to attachment, verified end and read time", async () => {
    const f = await fixture();
    await f.event("execution_attached", 20);
    await f.state("ended", 100);
    await f.interval("active", 10, 200);
    await f.interval("external_wait", 1000, 1600);
    const measured = await f.read(80);
    expect(measured.times.active_ms).toBe(60_000);
    expect(measured.times.process_elapsed_ms).toBe(60_000);
    expect(measured.times.process_alive_ms).toBe(60_000);
    expect(measured.times.external_wait_ms).toBeNull();
  });

  it("does not pair ambiguous identity-free tools by FIFO", async () => {
    const f = await fixture();
    await f.event("execution_attached", 0);
    await f.event("tool_started", 10);
    await f.event("tool_started", 20);
    await f.event("tool_finished", 80);
    await f.state("ended", 100);
    const measured = await f.read();
    expect(measured.times.active_ms).toBe(0);
    expect(measured.times.open_intervals).toBeGreaterThan(0);
    expect(measured.times.active_quality).toBe("unavailable");
    expect(measured.times.ambiguous_legacy_events).toBe(1);
  });

  it("pairs concurrent typed tools by exact identity and does not count recaptured aliases", async () => {
    const f = await fixture();
    await f.event("execution_attached", 0);
    await f.activity("tool_started", 10, "one");
    await f.activity("tool_started", 20, "two");
    const end = await f.activity("tool_finished", 30, "two");
    await f.activity("tool_finished", 90, "one");
    const alias = await f.event("tool_finished", 110);
    await f.db
      .prepare(
        `INSERT INTO measurement_event_sources
      (workspace_id,event_id,canonical_event_id,input_fingerprint) VALUES (?,?,?,?)`,
      )
      .run(FIX.workspace, alias, end, "c".repeat(64));
    await f.state("ended", 120);
    const measured = await f.read();
    expect(measured.times).toMatchObject({
      active_ms: 80_000,
      active_quality: "observed",
      open_intervals: 0,
    });
    expect(measured.sources.sources).toHaveLength(4);
  });

  it("does not join activity identities across provider sessions", async () => {
    const f = await fixture();
    await f.event("execution_attached", 0);
    await f.activity("tool_started", 10, "same-id", "session-one");
    await f.activity("tool_finished", 90, "same-id", "session-two");
    expect((await f.read()).times).toMatchObject({
      active_ms: 0,
      active_quality: "unavailable",
      open_intervals: 2,
    });
  });

  it("retains observed zero for a complete typed activity at one timestamp", async () => {
    const f = await fixture();
    await f.event("execution_attached", 0);
    await f.activity("tool_started", 10, "zero-duration");
    await f.activity("tool_finished", 10, "zero-duration");
    expect((await f.read()).times).toMatchObject({
      active_ms: 0,
      active_quality: "observed",
      open_intervals: 0,
    });
    const task = await getTaskMeasurements(f.db, FIX.workspace, f.spec.task_id, at(120));
    expect(task.totals.unknown_run_counts.active).toBe(0);
    const aggregate = await aggregateMeasurements(f.db, FIX.workspace, {}, at(120));
    expect(aggregate.cells[0]?.active_unavailable_runs).toBe(0);
  });

  it("retains lower confidence for a complete zero-duration legacy activity", async () => {
    const f = await fixture();
    await f.event("execution_attached", 0);
    await f.event("turn_started", 10);
    await f.event("turn_stopped", 10);
    expect((await f.read()).times).toMatchObject({
      active_ms: 0,
      active_quality: "includes_legacy_estimates",
      open_intervals: 0,
    });
  });

  it("does not infer a process window from a zero-duration activity pair", async () => {
    const f = await fixture();
    await f.activity("tool_started", 10, "unattached-zero");
    await f.activity("tool_finished", 10, "unattached-zero");
    expect((await f.read()).times).toMatchObject({
      process_elapsed_ms: null,
      active_ms: 0,
      active_quality: "unavailable",
    });
  });

  it.each([
    ["before attachment", 5],
    ["after execution end", 95],
    ["after read time", 130],
  ])("does not treat a zero-duration pair %s as observed", async (_description, seconds) => {
    const f = await fixture();
    await f.event("execution_attached", 10);
    await f.state("ended", 90);
    await f.activity("tool_started", seconds, "outside-window");
    await f.activity("tool_finished", seconds, "outside-window");
    expect((await f.read()).times).toMatchObject({
      active_ms: 0,
      active_quality: "unavailable",
    });
  });

  it("marks identity-free unambiguous activity as a legacy estimate", async () => {
    const f = await fixture();
    await f.event("execution_attached", 0);
    await f.event("turn_started", 10);
    await f.event("turn_stopped", 40);
    expect((await f.read()).times).toMatchObject({
      active_ms: 30_000,
      active_quality: "includes_legacy_estimates",
    });
  });

  it("keeps identity-free legacy activity in its own provider session", async () => {
    const f = await fixture();
    await f.event("execution_attached", 0);
    await f.event("tool_started", 10, f.spec.run_execution_id, f.spec.assignment_generation, "one");
    await f.event(
      "tool_finished",
      90,
      f.spec.run_execution_id,
      f.spec.assignment_generation,
      "two",
    );
    expect((await f.read()).times).toMatchObject({
      active_ms: 0,
      active_quality: "unavailable",
      open_intervals: 1,
    });
  });

  it("uses only explicitly observed process windows when no attach was captured", async () => {
    const f = await fixture();
    await f.interval("process_alive", 10, 30);
    await f.interval("process_alive", 50, 70);
    await f.interval("active", 0, 100);
    expect((await f.read()).times).toMatchObject({
      process_elapsed_ms: 60_000,
      process_alive_ms: 40_000,
      active_ms: 40_000,
      live_execution: false,
      offline_ms: 0,
    });
  });

  it("does not observe a future attach early and preserves measured zero at attachment", async () => {
    const f = await fixture();
    await f.event("execution_attached", 20);
    await f.state("attached");
    expect((await f.read(10)).times).toMatchObject({
      process_elapsed_ms: null,
      launch_latency_ms: null,
      live_execution: false,
    });
    expect((await f.read(20)).times).toMatchObject({
      process_elapsed_ms: 0,
      process_alive_ms: 0,
      launch_latency_ms: 20_000,
      live_execution: true,
    });
  });

  it("keeps provider attribution pinned when a profile changes", async () => {
    const f = await fixture();
    await f.db
      .prepare("UPDATE agent_profiles SET provider='codex' WHERE workspace_id=? AND id=?")
      .run(FIX.workspace, f.spec.agent_profile_id);
    expect((await f.read()).provider).toBe("fake");
    const aggregate = await aggregateMeasurements(
      f.db,
      FIX.workspace,
      { provider: "fake" },
      at(120),
    );
    expect(aggregate.cells).toHaveLength(1);
    expect(aggregate.cells[0]?.provider).toBe("fake");
  });

  it("does not mask a resumed execution outage with historical heartbeat timestamps", async () => {
    const f = await fixture();
    await f.event("execution_attached", 0);
    await f.state("ended", 60);
    // Delayed evidence for the old execution cannot renew the resumed process.
    await f.event("heartbeat", 150);
    const resumed = randomUlid();
    await f.db
      .prepare(
        `INSERT INTO run_executions
      (workspace_id,id,run_id,state,created_at) VALUES (?,?,?,'attached',?)`,
      )
      .run(FIX.workspace, resumed, f.spec.run_id, at(100));
    await f.db
      .prepare(
        `INSERT INTO execution_assignments
      (workspace_id,execution_id,assignment_generation,run_id,task_id,project_id,runner_id,
       checkout_id,physical_worktree_hash,requesting_human_id,requesting_human_epoch,
       runner_authorization_epoch,runner_grant_epoch,runner_key_thumbprint,created_at)
      SELECT workspace_id,?,assignment_generation+1,run_id,task_id,project_id,runner_id,
        checkout_id,physical_worktree_hash,requesting_human_id,requesting_human_epoch,
        runner_authorization_epoch,runner_grant_epoch,runner_key_thumbprint,?
      FROM execution_assignments WHERE workspace_id=? AND execution_id=?`,
      )
      .run(resumed, at(100), FIX.workspace, f.spec.run_execution_id);
    await f.event("execution_attached", 100, resumed, f.spec.assignment_generation + 1);
    const measured = await f.read(180);
    expect(measured.times).toMatchObject({
      process_elapsed_ms: 180_000,
      process_alive_ms: 140_000,
      offline_ms: 50_000,
      live_execution: true,
    });
  });
});

function token(
  id: string,
  input: number,
  model: string | null = "codex-fixture-model",
): TokenObservation {
  return {
    observation_id: id,
    run_id: "synthetic-run",
    run_execution_id: "synthetic-execution",
    provider: "codex",
    model,
    tokens: { input, output: 0, cache_read: null, cache_write: null, reasoning: null },
    quality: "provider_reported",
    provenance: "runner_observed",
    occurred_at: LAUNCH_NOW,
    committed_at: LAUNCH_NOW,
  };
}

describe("measurement precision regressions", () => {
  it("preserves a run overflow as unavailable through task and aggregate reads", async () => {
    const f = await fixture();
    for (const input of [Number.MAX_SAFE_INTEGER, 1]) {
      await persistTokenObservation(f.db, FIX.workspace, {
        ...token(randomUlid(), input),
        run_id: f.spec.run_id,
        run_execution_id: f.spec.run_execution_id,
        provider: "fake",
      });
    }
    const task = await getTaskMeasurements(f.db, FIX.workspace, f.spec.task_id, at(120));
    expect(task.totals.exact_tokens.input).toBeNull();
    expect(task.totals.exact_overflow_fields).toEqual(["input"]);
    const aggregate = await aggregateMeasurements(f.db, FIX.workspace, {}, at(120));
    expect(aggregate.cells[0]?.exact_tokens.input).toBeNull();
    expect(aggregate.cells[0]?.exact_overflow_fields).toEqual(["input"]);
  });

  it("never returns a rounded unsafe token aggregate as exact", () => {
    const observations = [token("first", Number.MAX_SAFE_INTEGER), token("second", 1)];
    expect(sumTokenFields(observations.map((row) => row.tokens)).input).toBeNull();
    const summary = summarizeTokens(observations, CURRENT_PRICE_CATALOG_VERSION, LAUNCH_NOW);
    expect(summary.exact.input).toBeNull();
    expect(summary).toMatchObject({ exact_overflow_fields: ["input"], costs_total_usd: null });
    expect(summary.costs[0]?.reason).toBe("counter_overflow");
    expect(summary.exact_observation_ids).toEqual(["first", "second"]);
  });

  it("does not label a known-model subtotal as the full cost", () => {
    const summary = summarizeTokens(
      [token("known", 100), token("unknown", 100, "not-priced")],
      CURRENT_PRICE_CATALOG_VERSION,
      LAUNCH_NOW,
    );
    expect(summary.costs_total_usd).toBeNull();
    expect(summary.costs).toHaveLength(2);
  });
});
