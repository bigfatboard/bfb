// ABOUTME: Verifies populated 0040-to-0041 upgrades retain immutable telemetry and launch bytes.
// ABOUTME: Checks source provenance, semantic uniqueness and append-only constraints against real SQLite.

import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { adaptBetterSqlite3, listMigrationFiles, schemaSnapshot } from "@bfb/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ingestRunnerEventsCommand } from "../src/events.js";
import { FIX } from "../src/fixtures.js";
import { randomUlid } from "../src/ids.js";
import { reportTokensCommand } from "../src/measurements.js";
import { LAUNCH_NOW, launchFixture, success } from "./launch-fixture.js";

const directory = fileURLToPath(new URL("../../../migrations/d1", import.meta.url));
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(LAUNCH_NOW));
});
afterEach(() => vi.useRealTimers());
function open() {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  return raw;
}

describe("measurement source migration", () => {
  it("upgrades the populated immediate previous head without rewriting legacy identities or snapshots", async () => {
    const raw = open(),
      migrations = listMigrationFiles(directory);
    for (const migration of migrations.slice(0, -1)) raw.exec(migration.sql);
    expect(migrations.at(-2)?.id).toBe("0040_offline_result_policy");
    const f = await launchFixture(adaptBetterSqlite3(raw)),
      { claimed } = await f.claim(),
      spec = claimed.specification;
    success(
      await f.native(reportTokensCommand, {
        principal: f.principal,
        observationId: randomUlid(),
        runId: spec.run_id,
        executionId: spec.run_execution_id,
        assignmentGeneration: spec.assignment_generation,
        provider: "fake",
        tokens: { input: 7 },
        quality: "estimated",
      }),
    );
    const event = randomUlid();
    raw
      .prepare(
        `INSERT INTO event_ledger
      (workspace_id,event_id,workspace_cursor,source_stream_id,source_sequence,run_execution_id,
       assignment_generation,project_id,task_id,run_id,actor_type,actor_id,source_type,source_id,
       source_provider,capture_origin,kind,occurred_at,received_at,payload_json)
      VALUES (?,?,1000,?,1,?,?,?,?,?,'agent_run',?,'runner',?,'fake','hook_inbox','turn_started',?,?,'{}')`,
      )
      .run(
        FIX.workspace,
        event,
        randomUlid(),
        spec.run_execution_id,
        spec.assignment_generation,
        FIX.projectA,
        spec.task_id,
        spec.run_id,
        spec.run_execution_id,
        f.runner,
        LAUNCH_NOW,
        LAUNCH_NOW,
      );
    raw
      .prepare(
        `INSERT INTO measurement_observations
      (workspace_id,observation_id,run_execution_id,run_id,measure_kind,capture_origin,actor_type,actor_id,occurred_at,committed_cursor)
      VALUES (?,?,?,?,'turn_started','hook_inbox','agent_run',?,?,1000)`,
      )
      .run(
        FIX.workspace,
        event,
        spec.run_execution_id,
        spec.run_id,
        spec.run_execution_id,
        LAUNCH_NOW,
      );
    const tables = [
      "event_ledger",
      "measurement_observations",
      "token_observations",
      "execution_assignments",
      "run_configuration_snapshots",
      "launch_commands",
    ];
    const before = tables.map((table) =>
      raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    );
    raw.exec(migrations.at(-1)!.sql);
    expect(
      tables.map((table) => raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
    ).toEqual(before);
    expect(raw.prepare("SELECT COUNT(*) AS total FROM measurement_sources").get()).toEqual({
      total: 0,
    });
    expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const fresh = open();
    for (const migration of migrations) fresh.exec(migration.sql);
    expect(schemaSnapshot(raw)).toEqual(schemaSnapshot(fresh));
  });

  it("enforces immutable sources, exact fingerprints and one canonical semantic phase", async () => {
    const raw = open();
    for (const migration of listMigrationFiles(directory)) raw.exec(migration.sql);
    const f = await launchFixture(adaptBetterSqlite3(raw)),
      { claimed } = await f.claim(),
      spec = claimed.specification;
    const event = {
      schema_version: 2,
      event_id: randomUlid(),
      source_stream_id: randomUlid(),
      source_sequence: 1,
      run_execution_id: spec.run_execution_id,
      assignment_generation: spec.assignment_generation,
      provider_session_id: "session-1",
      kind: "turn_started",
      occurred_at: LAUNCH_NOW,
      capture_origin: "hook_inbox",
      payload: { activity_id: "turn-1" },
    };
    const alias = { ...event, event_id: randomUlid(), source_stream_id: randomUlid() };
    success(
      await f.native(ingestRunnerEventsCommand, { principal: f.principal, events: [event, alias] }),
    );
    expect(() =>
      raw.prepare("UPDATE measurement_sources SET identity='replacement'").run(),
    ).toThrow(/immutable/);
    expect(() => raw.prepare("DELETE FROM measurement_sources").run()).toThrow(/deleted/);
    expect(() =>
      raw.prepare("UPDATE measurement_event_sources SET input_fingerprint=?").run("a".repeat(64)),
    ).toThrow(/immutable/);
    const clone = raw.prepare(`INSERT INTO measurement_sources SELECT workspace_id, ?, ?, run_id,
      run_execution_id, assignment_generation, runner_id, provider, provider_session_id,
      family, identity, phase, parent_turn_id, semantic_fingerprint FROM measurement_sources`);
    expect(() => clone.run("a".repeat(64), alias.event_id)).toThrow(/UNIQUE/);
    expect(() => clone.run("a".repeat(63) + "z", alias.event_id)).toThrow(/CHECK/);
    expect(() =>
      raw
        .prepare(
          `INSERT INTO measurement_event_sources
      (workspace_id,event_id,canonical_event_id,input_fingerprint) VALUES (?,?,?,?)`,
        )
        .run(FIX.workspace, randomUlid(), event.event_id, "a".repeat(64)),
    ).toThrow(/scope/);
    const foreignSession = {
      ...event,
      schema_version: 1,
      event_id: randomUlid(),
      source_stream_id: randomUlid(),
      provider_session_id: "session-2",
      payload: {},
    };
    success(
      await f.native(ingestRunnerEventsCommand, {
        principal: f.principal,
        events: [foreignSession],
      }),
    );
    expect(() =>
      raw
        .prepare(
          `INSERT INTO measurement_event_sources
      (workspace_id,event_id,canonical_event_id,input_fingerprint) VALUES (?,?,?,?)`,
        )
        .run(FIX.workspace, foreignSession.event_id, event.event_id, "a".repeat(64)),
    ).toThrow(/scope/);
    expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
