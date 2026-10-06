// ABOUTME: Proves typed telemetry ledger, source and token effects commit atomically with historical attribution.
// ABOUTME: Exercises semantic replay conflicts, private-safe projections and the real staged D1 adapter.

import {
  adaptD1,
  createAuthorizationContext,
  type D1Like,
  type D1StatementLike,
  type SqlDatabase,
} from "@bfb/db";
import type { RunnerTelemetrySubmission } from "@bfb/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ingestRunnerEventsCommand, listLedgerEvents } from "../src/events.js";
import { FIX } from "../src/fixtures.js";
import { WorkspaceHub } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import {
  listRunMeasurementActivitySources,
  listRunMeasurementSources,
} from "../src/measurement-sources.js";
import { listTokenObservations } from "../src/measurements.js";
import { LAUNCH_NOW, launchFixture, success } from "./launch-fixture.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(LAUNCH_NOW));
});
afterEach(() => vi.useRealTimers());

async function fixture(database?: SqlDatabase) {
  const f = await launchFixture(database),
    { claimed } = await f.claim(),
    spec = claimed.specification;
  let sequence = 0;
  const stream = randomUlid();
  const tokens = (changes: Record<string, unknown> = {}): RunnerTelemetrySubmission =>
    ({
      schema_version: 2,
      event_id: randomUlid(),
      source_stream_id: stream,
      source_sequence: ++sequence,
      run_execution_id: spec.run_execution_id,
      assignment_generation: spec.assignment_generation,
      provider_session_id: "synthetic-session",
      kind: "progress_reported",
      occurred_at: LAUNCH_NOW,
      capture_origin: "hook_inbox",
      payload: {
        measurement: "tokens",
        usage_id: "usage-1",
        basis: "turn_delta",
        model: "synthetic-model",
        quality: "provider_reported",
        tokens: { input: 7, output: 3, cache_read: 2, cache_write: 1, reasoning: 4 },
      },
      ...changes,
    }) as RunnerTelemetrySubmission;
  const activity = (
    kind: RunnerTelemetrySubmission["kind"],
    id = "activity-1",
    extra: Record<string, unknown> = {},
  ): RunnerTelemetrySubmission => tokens({ kind, payload: { activity_id: id, ...extra } });
  const ingest = (events: unknown[]) =>
    f.native(ingestRunnerEventsCommand, { principal: f.principal, events });
  return { ...f, spec, tokens, activity, ingest };
}

async function counts(db: SqlDatabase) {
  return db
    .prepare(
      `SELECT
    (SELECT COUNT(*) FROM event_ledger) AS ledger,
    (SELECT COUNT(*) FROM measurement_observations) AS observations,
    (SELECT COUNT(*) FROM measurement_sources) AS sources,
    (SELECT COUNT(*) FROM measurement_event_sources) AS aliases,
    (SELECT COUNT(*) FROM token_observations) AS tokens,
    (SELECT COUNT(*) FROM audit_events) AS audit,
    (SELECT COUNT(*) FROM semantic_events) AS semantic,
    (SELECT COUNT(*) FROM outbox_records) AS outbox,
    (SELECT COUNT(*) FROM idempotency_records) AS idempotency,
    (SELECT cursor FROM workspace_cursors WHERE workspace_id = ?) AS cursor`,
    )
    .get(FIX.workspace);
}

function stagedD1(db: SqlDatabase) {
  const statements = new Map<D1StatementLike, { sql: string; params: unknown[] }>();
  let failure: RegExp | undefined;
  const binding: D1Like = {
    prepare(sql) {
      const entry = { sql, params: [] as unknown[] };
      const statement: D1StatementLike = {
        bind(...params) {
          entry.params = params;
          return statement;
        },
        first: async () => (await db.prepare(sql).get(...entry.params)) ?? null,
        all: async () => ({ results: (await db.prepare(sql).all(...entry.params)) as unknown[] }),
        run: async () => ({
          meta: (await db.prepare(sql).run(...entry.params)) as { changes: number },
        }),
      };
      statements.set(statement, entry);
      return statement;
    },
    async batch(pending) {
      return db.withTransaction(async (tx) => {
        const results = [];
        for (const statement of pending) {
          const entry = statements.get(statement)!;
          const result = await tx.prepare(entry.sql).run(...entry.params);
          if (failure?.test(entry.sql)) throw new Error("synthetic-private-final-batch-failure");
          results.push({ meta: result as { changes: number } });
        }
        return results;
      });
    },
  };
  return {
    db: adaptD1(binding),
    fail: (pattern: RegExp) => {
      failure = pattern;
    },
  };
}

describe("connected typed measurement ingest", () => {
  it("co-commits the full token fact and immutable snapshot provider, not the current profile", async () => {
    const f = await fixture(),
      event = f.tokens();
    await f.db
      .prepare("UPDATE agent_profiles SET provider = 'codex' WHERE workspace_id = ?")
      .run(FIX.workspace);
    expect(success(await f.ingest([event])).dispositions).toMatchObject([
      { disposition: "accepted" },
    ]);
    expect(await listTokenObservations(f.db, FIX.workspace, f.spec.run_id)).toMatchObject([
      {
        observation_id: event.event_id,
        provider: "fake",
        tokens: { input: 7, output: 3, cache_read: 2, cache_write: 1, reasoning: 4 },
        quality: "provider_reported",
        provenance: "hook_inbox",
      },
    ]);
    expect(await counts(f.db)).toMatchObject({
      ledger: 1,
      observations: 1,
      sources: 1,
      aliases: 1,
      tokens: 1,
    });
    const page = await listRunMeasurementSources(f.db, FIX.workspace, f.spec.run_id);
    expect(page).toMatchObject({
      sources: [{ event_id: event.event_id, family: "tokens", usage_id: "usage-1" }],
      has_more: false,
    });
    expect(JSON.stringify(page)).not.toContain('"tokens"' + ":");
  });

  it("accepts captured telemetry for ended executions without a live lease or result eligibility", async () => {
    const f = await fixture();
    await f.db
      .prepare(
        "UPDATE run_executions SET state='ended', end_reason='process_exit', ended_at=? WHERE workspace_id=? AND id=?",
      )
      .run(LAUNCH_NOW, FIX.workspace, f.spec.run_execution_id);
    await f.db
      .prepare("UPDATE checkout_leases SET expires_at=? WHERE workspace_id=?")
      .run("2026-09-12T11:59:00.000Z", FIX.workspace);
    await f.db
      .prepare("UPDATE runs SET result_state='submitted' WHERE workspace_id=? AND id=?")
      .run(FIX.workspace, f.spec.run_id);
    expect(success(await f.ingest([f.tokens()])).dispositions).toMatchObject([
      { disposition: "accepted" },
    ]);
  });

  it("keeps current runner grant authority even for already committed telemetry", async () => {
    const f = await fixture(),
      event = f.tokens();
    success(await f.ingest([event]));
    await f.db
      .prepare("UPDATE runners SET grant_epoch=2 WHERE workspace_id=? AND id=?")
      .run(FIX.workspace, f.runner);
    const before = await counts(f.db);
    expect(await f.ingest([event])).toMatchObject({ ok: false });
    expect(await counts(f.db)).toEqual(before);
  });

  it("binds an original event ID to the complete v2 payload and occurrence, including within a batch", async () => {
    const f = await fixture(),
      event = f.tokens();
    success(await f.ingest([event]));
    expect(success(await f.ingest([event])).dispositions).toMatchObject([
      { disposition: "already_committed" },
    ]);
    for (const changed of [
      { ...event, occurred_at: "2026-09-12T12:00:01.000Z" },
      { ...event, payload: { ...event.payload, quality: "estimated" } },
    ]) {
      expect(success(await f.ingest([changed])).dispositions).toMatchObject([
        { disposition: "permanently_rejected", diagnostic: { code: "event_id_confusion" } },
      ]);
    }
    const next = f.tokens({ payload: { ...event.payload, usage_id: "usage-2" } });
    expect(
      success(await f.ingest([next, { ...next, occurred_at: "2026-09-12T12:00:01.000Z" }]))
        .dispositions,
    ).toMatchObject([{ disposition: "accepted" }, { disposition: "permanently_rejected" }]);
  });

  it("cannot hide a changed unsafe raw lexeme behind an unchanged parsed Hub-cache input", async () => {
    const f = await fixture(),
      event = f.tokens(),
      encoded = JSON.stringify(event),
      key = randomUlid();
    const execute = (bytes: string) =>
      f.hub.execute(ingestRunnerEventsCommand, {
        workspaceId: FIX.workspace,
        actorRunnerId: f.runner,
        authorizationEpoch: 1,
        now: LAUNCH_NOW,
        idempotencyKey: key,
        input: { principal: f.principal, events: [event], encodedEvents: [bytes] },
      });
    success(await execute(encoded));
    expect(await execute(encoded)).toMatchObject({ ok: true, replayed: true });
    expect(
      await execute(encoded.replace('"input":7', '"input":7.00000000000000001')),
    ).toMatchObject({ ok: false, error: { code: "request_rejected" } });
  });

  it("deduplicates stable usage across capture streams and rejects changed counters or quality", async () => {
    const f = await fixture(),
      event = f.tokens();
    success(await f.ingest([event]));
    const alias = {
      ...event,
      event_id: randomUlid(),
      source_stream_id: randomUlid(),
      source_sequence: 1,
      occurred_at: "2026-09-12T12:00:01.000Z",
      capture_origin: "runner_observed",
    };
    expect(success(await f.ingest([alias])).dispositions).toMatchObject([
      { disposition: "accepted" },
    ]);
    expect(await counts(f.db)).toMatchObject({
      ledger: 2,
      observations: 1,
      sources: 1,
      aliases: 2,
      tokens: 1,
    });
    for (const payload of [
      { ...event.payload, quality: "estimated" },
      {
        ...event.payload,
        tokens: { input: 8, output: 3, cache_read: 2, cache_write: 1, reasoning: 4 },
      },
    ]) {
      expect(success(await f.ingest([{ ...f.tokens(), payload }])).dispositions).toMatchObject([
        {
          disposition: "permanently_rejected",
          diagnostic: { code: "measurement_source_conflict" },
        },
      ]);
    }
    expect(await listTokenObservations(f.db, FIX.workspace, f.spec.run_id)).toHaveLength(1);
  });

  it("shares end-phase identity between completed and failed tools while preserving the start", async () => {
    const f = await fixture(),
      start = f.activity("tool_started", "tool-1", { parent_turn_id: "turn-1" }),
      end = f.activity("tool_finished", "tool-1", { parent_turn_id: "turn-1" });
    expect(
      success(
        await f.ingest([
          start,
          end,
          f.activity("tool_failed", "tool-1", { parent_turn_id: "turn-1" }),
        ]),
      ).dispositions,
    ).toMatchObject([
      { disposition: "accepted" },
      { disposition: "accepted" },
      { disposition: "permanently_rejected" },
    ]);
    expect(
      await listRunMeasurementActivitySources(f.db, FIX.workspace, f.spec.run_id),
    ).toMatchObject([
      { event_id: start.event_id, activity_id: "tool-1", phase: "start", parent_turn_id: "turn-1" },
      { event_id: end.event_id, activity_id: "tool-1", phase: "end", parent_turn_id: "turn-1" },
    ]);
  });

  it("keeps v1 replay bytes private-safe while canonical typed payload remains in the ledger", async () => {
    const f = await fixture(),
      event = f.tokens();
    const accepted = success(await f.ingest([event]));
    const authorization = createAuthorizationContext({
      workspaceId: FIX.workspace,
      principalId: FIX.owner,
      authorizationEpoch: 1,
      jurisdiction: "eu",
    });
    expect(
      await listLedgerEvents(f.db, authorization, {
        afterCursor: 0,
        throughCursor: accepted.high_water_cursor,
      }),
    ).toMatchObject([{ event_id: event.event_id, payload: {} }]);
    const row = (await f.db
      .prepare("SELECT payload_json FROM event_ledger WHERE event_id=?")
      .get(event.event_id)) as { payload_json: string };
    expect(JSON.parse(row.payload_json)).toEqual(event.payload);
    const receipts = await f.db
      .prepare(
        `SELECT payload_json FROM audit_events UNION ALL
      SELECT payload_json FROM semantic_events UNION ALL SELECT payload_json FROM outbox_records`,
      )
      .all();
    expect(JSON.stringify(receipts)).not.toContain("usage-1");
    expect(JSON.stringify(receipts)).not.toContain("synthetic-model");
  });

  it("does not truncate internal activity input and paginates public canonical sources explicitly", async () => {
    const f = await fixture();
    for (let offset = 0; offset < 105; offset += 25) {
      success(
        await f.ingest(
          Array.from({ length: Math.min(25, 105 - offset) }, (_, index) =>
            f.activity("turn_started", `turn-${offset + index}`),
          ),
        ),
      );
    }
    expect(
      await listRunMeasurementActivitySources(f.db, FIX.workspace, f.spec.run_id),
    ).toHaveLength(105);
    const first = await listRunMeasurementSources(f.db, FIX.workspace, f.spec.run_id);
    expect(first.sources).toHaveLength(100);
    expect(first.has_more).toBe(true);
    const second = await listRunMeasurementSources(f.db, FIX.workspace, f.spec.run_id, {
      afterCursor: first.next_cursor,
    });
    expect(second.sources).toHaveLength(5);
    expect(second.has_more).toBe(false);
    await expect(
      listRunMeasurementSources(f.db, FIX.workspace, f.spec.run_id, { limit: 101 }),
    ).rejects.toThrow();
  });

  it.each([
    /INSERT INTO measurement_event_sources/u,
    /INSERT INTO token_observations/u,
    /INSERT INTO outbox_records/u,
  ])("rolls back every staged D1 effect on late batch failure %s", async (failure) => {
    const f = await fixture(),
      staged = stagedD1(f.db),
      hub = new WorkspaceHub(staged.db),
      event = f.tokens();
    staged.fail(failure);
    const before = await counts(f.db);
    expect(
      await hub.execute(ingestRunnerEventsCommand, {
        workspaceId: FIX.workspace,
        actorRunnerId: f.runner,
        authorizationEpoch: 1,
        now: LAUNCH_NOW,
        idempotencyKey: randomUlid(),
        input: { principal: f.principal, events: [event] },
      }),
    ).toMatchObject({ ok: false, error: { code: "command_failed" } });
    expect(await counts(f.db)).toEqual(before);
  });

  it("co-commits canonical and alias usage in one actual staged D1 batch", async () => {
    const f = await fixture(),
      staged = stagedD1(f.db),
      hub = new WorkspaceHub(staged.db),
      event = f.tokens();
    expect(
      await hub.execute(ingestRunnerEventsCommand, {
        workspaceId: FIX.workspace,
        actorRunnerId: f.runner,
        authorizationEpoch: 1,
        now: LAUNCH_NOW,
        idempotencyKey: randomUlid(),
        input: { principal: f.principal, events: [event, f.tokens()] },
      }),
    ).toMatchObject({ ok: true });
    expect(await counts(f.db)).toMatchObject({ ledger: 2, sources: 1, aliases: 2, tokens: 1 });
  });
});
