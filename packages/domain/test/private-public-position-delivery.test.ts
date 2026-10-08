// ABOUTME: Proves public raw-position readers reject before persistence while retaining pure query admission.
// ABOUTME: Runner ingest and complete measurement arithmetic retain their source facts and current parent authority.

import { createAuthorizationContext, type SqlDatabase } from "@bfb/db";
import type { RunnerEventSubmission, RunnerTelemetrySubmission } from "@bfb/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ingestRunnerEventsCommand, listLedgerEvents, readLedgerHighWater } from "../src/events.js";
import { FIX } from "../src/fixtures.js";
import { listWorkspaceEvents, readEventHighWater } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import {
  listRunMeasurementActivitySources,
  listRunMeasurementSources,
} from "../src/measurement-sources.js";
import { getRunMeasurements, getTaskMeasurements } from "../src/measurements.js";
import { readActivityFeed } from "../src/operations.js";
import { openDomainDb } from "./helpers.js";
import { LAUNCH_NOW, launchFixture, success } from "./launch-fixture.js";

const HELD = { code: "request_rejected", message: "event feeds are unavailable" };
const ACCESS = { workspaceId: FIX.workspace, humanId: FIX.owner, authorizationEpoch: 1 };
const AUTHORIZATION = createAuthorizationContext({
  workspaceId: FIX.workspace,
  principalId: FIX.owner,
  authorizationEpoch: 1,
  jurisdiction: "eu",
});
const at = (seconds: number) => new Date(Date.parse(LAUNCH_NOW) + seconds * 1000).toISOString();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(LAUNCH_NOW));
});
afterEach(() => vi.useRealTimers());

function tracked(db: SqlDatabase) {
  const reads: string[] = [];
  return {
    reads,
    db: {
      ...db,
      prepare(sql: string) {
        reads.push(sql);
        return db.prepare(sql);
      },
      async withTransaction<T>(fn: (tx: SqlDatabase) => Promise<T>): Promise<T> {
        reads.push("transaction");
        return db.withTransaction(fn);
      },
    },
  };
}

async function retained(db: SqlDatabase) {
  const rows: Record<string, unknown> = {};
  for (const table of [
    "event_ledger",
    "measurement_sources",
    "measurement_event_sources",
    "measurement_observations",
    "token_observations",
    "run_event_projections",
    "execution_event_projections",
    "runs",
    "run_executions",
    "audit_events",
    "semantic_events",
    "outbox_records",
    "idempotency_records",
    "workspace_cursors",
  ])
    rows[table] = await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  return rows;
}

async function fixture() {
  const f = await launchFixture(),
    { claimed } = await f.claim(),
    spec = claimed.specification,
    stream = randomUlid();
  const base = {
    source_stream_id: stream,
    run_execution_id: spec.run_execution_id,
    assignment_generation: spec.assignment_generation,
    capture_origin: "hook_inbox" as const,
  };
  const events: Array<RunnerEventSubmission | RunnerTelemetrySubmission> = [
    {
      ...base,
      schema_version: 1,
      event_id: randomUlid(),
      source_sequence: 1,
      kind: "execution_attached",
      occurred_at: at(0),
      payload: {},
    },
    ...(["turn_started", "turn_stopped"] as const).map((kind, index) => ({
      ...base,
      schema_version: 2 as const,
      event_id: randomUlid(),
      source_sequence: index + 2,
      kind,
      occurred_at: at(index === 0 ? 1 : 3),
      payload: { activity_id: "synthetic-retained-turn" },
    })),
    {
      ...base,
      schema_version: 2,
      event_id: randomUlid(),
      source_sequence: 4,
      kind: "progress_reported",
      occurred_at: at(3),
      payload: {
        measurement: "tokens",
        usage_id: "synthetic-retained-usage",
        basis: "turn_delta",
        model: "synthetic-model",
        quality: "provider_reported",
        tokens: { input: 7, output: 3, cache_read: null, cache_write: null, reasoning: null },
      },
    },
  ];
  const accepted = success(
    await f.native(ingestRunnerEventsCommand, { principal: f.principal, events }),
  );
  expect(accepted.dispositions.map((row) => row.disposition)).toEqual(events.map(() => "accepted"));
  const duplicate = success(
    await f.native(ingestRunnerEventsCommand, { principal: f.principal, events }),
  );
  expect(duplicate.dispositions.map((row) => row.disposition)).toEqual(
    events.map(() => "already_committed"),
  );
  return { ...f, spec, events };
}

const READERS: Array<[string, (db: SqlDatabase, runId: string) => Promise<unknown>]> = [
  ["semantic high-water", (db) => readEventHighWater(db, AUTHORIZATION)],
  [
    "semantic replay",
    (db) =>
      listWorkspaceEvents(db, AUTHORIZATION, { afterCursor: 0, throughCursor: 100, limit: 1 }),
  ],
  ["ledger high-water", (db) => readLedgerHighWater(db, AUTHORIZATION)],
  [
    "ledger replay",
    (db) => listLedgerEvents(db, AUTHORIZATION, { afterCursor: 0, throughCursor: 100, limit: 1 }),
  ],
  [
    "measurement source page",
    (db, id) => listRunMeasurementSources(db, FIX.workspace, id, {}, ACCESS),
  ],
  [
    "operations activity",
    (db) => readActivityFeed(db, FIX.workspace, { access: ACCESS, limit: 1 }),
  ],
];

describe("public raw-position quarantine", () => {
  it.each(READERS)(
    "holds %s before any database access without changing genuine source records",
    async (_name, read) => {
      const f = await fixture(),
        before = await retained(f.db),
        checked = tracked(f.db);
      await expect(read(checked.db, f.spec.run_id)).rejects.toMatchObject(HELD);
      expect(checked.reads).toEqual([]);
      expect(await retained(f.db)).toEqual(before);
    },
  );

  it("holds empty, missing and private source sets uniformly, including omitted human access", async () => {
    const empty = tracked(await openDomainDb());
    for (const [, read] of READERS)
      await expect(read(empty.db, randomUlid())).rejects.toMatchObject(HELD);
    expect(empty.reads).toEqual([]);
    const f = await fixture();
    await f.db
      .prepare(
        "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
      )
      .run(FIX.workspace, f.task.id, FIX.owner, LAUNCH_NOW);
    const before = await retained(f.db),
      checked = tracked(f.db);
    for (const [, read] of READERS)
      await expect(read(checked.db, f.spec.run_id)).rejects.toMatchObject(HELD);
    await expect(
      listRunMeasurementSources(checked.db, FIX.workspace, randomUlid()),
    ).rejects.toMatchObject(HELD);
    await expect(
      readActivityFeed(checked.db, FIX.workspace, { projectIds: [] }),
    ).rejects.toMatchObject(HELD);
    expect(checked.reads).toEqual([]);
    expect(await retained(f.db)).toEqual(before);
  });

  it("retains semantic and ledger range rejection without consulting default high-water or authority", async () => {
    const checked = tracked(await openDomainDb());
    for (const read of [listWorkspaceEvents, listLedgerEvents])
      for (const options of [
        { afterCursor: -1, throughCursor: 0 },
        { afterCursor: 2, throughCursor: 1 },
        { afterCursor: 0, throughCursor: Number.MAX_SAFE_INTEGER + 1 },
        { afterCursor: 0, throughCursor: 0, limit: 101 },
        { afterCursor: 0, throughCursor: 0, limit: 0 },
      ])
        await expect(read(checked.db, AUTHORIZATION, options)).rejects.toMatchObject({
          code: "invalid_event_range",
        });
    expect(checked.reads).toEqual([]);
  });

  it("retains pure source-page and context argument errors before database access", async () => {
    const checked = tracked(await openDomainDb());
    for (const options of [{ afterCursor: -1 }, { afterCursor: 0.5 }, { limit: 0 }, { limit: 101 }])
      await expect(
        listRunMeasurementSources(checked.db, FIX.workspace, randomUlid(), options),
      ).rejects.toMatchObject({
        code: "invalid_argument",
        message: "measurement source page is invalid",
      });
    await expect(
      listRunMeasurementSources(
        checked.db,
        FIX.workspace,
        randomUlid(),
        {},
        { ...ACCESS, workspaceId: randomUlid() },
      ),
    ).rejects.toMatchObject({ code: "not_found", message: "run not found" });
    await expect(
      readActivityFeed(checked.db, FIX.workspace, { access: { ...ACCESS, authorizationEpoch: 0 } }),
    ).rejects.toMatchObject({ code: "invalid_argument", message: "invalid task access query" });
    expect(checked.reads).toEqual([]);
  });

  it("retains complete canonical arithmetic and duplicate dispositions with unavailable run/task source pages", async () => {
    const f = await fixture(),
      before = await retained(f.db);
    expect(
      await listRunMeasurementActivitySources(f.db, FIX.workspace, f.spec.run_id, ACCESS),
    ).toHaveLength(2);
    const run = await getRunMeasurements(f.db, FIX.workspace, f.spec.run_id, at(5), ACCESS);
    expect(run).toMatchObject({
      sources: null,
      times: { active_ms: 2000, active_quality: "observed", process_alive_ms: 5000 },
      tokens: { exact: { input: 7, output: 3 } },
      provenance: { ledger_events: 4, token_observations: 1 },
    });
    const task = await getTaskMeasurements(f.db, FIX.workspace, f.task.id, at(5), ACCESS);
    expect(task.runs).toHaveLength(1);
    expect(task.runs[0]?.sources).toBeNull();
    expect(task.totals).toMatchObject({ active_ms: 2000, exact_tokens: { input: 7, output: 3 } });
    expect(await retained(f.db)).toEqual(before);
  });

  it("keeps current parent authority on arithmetic when raw source pages are held", async () => {
    const f = await fixture();
    await f.db
      .prepare(
        "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
      )
      .run(FIX.workspace, f.task.id, FIX.owner, LAUNCH_NOW);
    const member = { ...ACCESS, humanId: FIX.member },
      before = await retained(f.db);
    await expect(
      getRunMeasurements(f.db, FIX.workspace, f.spec.run_id, at(5), member),
    ).rejects.toMatchObject({ code: "not_found", message: "run not found" });
    await expect(
      getTaskMeasurements(f.db, FIX.workspace, f.task.id, at(5), member),
    ).rejects.toMatchObject({ code: "not_found", message: "task not found" });
    expect(await retained(f.db)).toEqual(before);
  });
});
