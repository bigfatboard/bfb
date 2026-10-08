// ABOUTME: Proves unchanged delegated credentials expire at the staged result batch boundary.
// ABOUTME: Real database clocks verify rollback and retained observation times without runner or provider work.

import { setTimeout as delay } from "node:timers/promises";

import type { SqlDatabase } from "@bfb/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FIX } from "../src/fixtures.js";
import { WorkspaceHub } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import { submitDelegatedResultCommand } from "../src/remote-parity.js";
import { createTaskCommand } from "../src/work-commands.js";
import { createRunCommand } from "../src/work-records.js";
import { openDomainDb } from "./helpers.js";
import { success } from "./launch-fixture.js";
import { resultStagedD1 } from "./result-fixture.js";

const SUMMARY = "SYNTHETIC-C11-DELEGATED-RESULT-COMMIT-EXPIRY";
const RECEIPTS = ["semantic_events", "audit_events", "outbox_records", "idempotency_records"];

beforeEach(() => {
  vi.useRealTimers();
});

async function fixture(modifier: "+3 seconds" | "+1 hour") {
  const db = await openDomainDb(),
    hub = new WorkspaceHub(db);
  const request = {
    workspaceId: FIX.workspace,
    actorHumanId: FIX.member,
    authorizationEpoch: 1,
  };
  const task = success(
    await hub.execute(createTaskCommand, {
      ...request,
      idempotencyKey: randomUlid(),
      input: { projectId: FIX.projectA, title: "Synthetic commit-expiry task", priority: "P2" },
    }),
  );
  const run = success(
    await hub.execute(createRunCommand, {
      ...request,
      idempotencyKey: randomUlid(),
      input: {
        taskId: task.id,
        expectedTaskVersion: 1,
        agentProfileId: FIX.profileCodex,
        workspacePolicyVersion: 1,
        projectPolicyVersion: 1,
        repositoryConfigVersion: 1,
        agentProfileVersion: 1,
      },
    }),
  );
  const clock = (await db
    .prepare(
      "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS observed_at, strftime('%Y-%m-%dT%H:%M:%fZ','now',?) AS expires_at",
    )
    .get(modifier)) as { observed_at: string; expires_at: string };
  const delegationId = randomUlid();
  await db
    .prepare(
      `INSERT INTO oauth_delegations
       (workspace_id,id,human_id,client_id,resource,project_id,task_id,scopes_json,
        authorization_epoch,expires_at,created_at)
       VALUES (?,?,?,?,'https://bfb.example.test/mcp',?,?,?,1,?,?)`,
    )
    .run(
      FIX.workspace,
      delegationId,
      FIX.member,
      FIX.client,
      FIX.projectA,
      task.id,
      JSON.stringify(["bfb:read", "bfb:task:write"]),
      clock.expires_at,
      clock.observed_at,
    );
  return { db, taskId: task.id, runId: run.run.id, delegationId, ...clock, request };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function credential(f: Fixture) {
  return f.db
    .prepare("SELECT * FROM oauth_delegations WHERE workspace_id=? AND id=?")
    .get(FIX.workspace, f.delegationId);
}

async function clockWitness(f: Fixture) {
  return (await f.db
    .prepare(
      `SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS database_now,
        julianday(expires_at)>julianday('now') AS live
       FROM oauth_delegations WHERE workspace_id=? AND id=?`,
    )
    .get(FIX.workspace, f.delegationId)) as { database_now: string; live: number };
}

async function waitForExpiry(f: Fixture) {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const witness = await clockWitness(f);
    if (witness.live === 0) return witness;
    await delay(50);
  }
  throw new Error("Synthetic credential did not naturally expire before the bounded deadline");
}

function observeSubmission(db: SqlDatabase, observe: (at: string) => void): SqlDatabase {
  return {
    ...db,
    withTransaction(work) {
      return db.withTransaction((tx) =>
        work({
          ...tx,
          prepare(sql) {
            const statement = tx.prepare(sql);
            return {
              ...statement,
              run(...parameters) {
                if (sql.includes("INSERT INTO result_submissions")) {
                  const at = parameters.at(-1);
                  expect(typeof at).toBe("string");
                  observe(at as string);
                }
                return statement.run(...parameters);
              },
            };
          },
        }),
      );
    },
  };
}

async function effects(f: Fixture) {
  const receipts: Record<string, number> = {};
  for (const table of [...RECEIPTS, "result_submissions"]) {
    const row = (await f.db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id=?`)
      .get(FIX.workspace)) as { n: number };
    receipts[table] = row.n;
  }
  return {
    receipts,
    run: (await f.db
      .prepare("SELECT result_state,resource_version FROM runs WHERE workspace_id=? AND id=?")
      .get(FIX.workspace, f.runId)) as { result_state: string; resource_version: number },
    task: (await f.db
      .prepare("SELECT state,resource_version FROM tasks WHERE workspace_id=? AND id=?")
      .get(FIX.workspace, f.taskId)) as { state: string; resource_version: number },
    cursor: (await f.db
      .prepare("SELECT cursor FROM workspace_cursors WHERE workspace_id=?")
      .get(FIX.workspace)) as { cursor: number },
    artifactGuards: await f.db.prepare("SELECT id FROM artifact_mutation_guards").all(),
    runnerGuards: await f.db.prepare("SELECT id FROM runner_mutation_guards").all(),
  };
}

function operation(f: Fixture, key: string) {
  return {
    ...f.request,
    actorDelegationId: f.delegationId,
    idempotencyKey: key,
    // The Hub must retain its own observed time, not this caller's historical preference.
    now: "2025-01-01T00:00:00.000Z",
    input: { runId: f.runId, summary: SUMMARY, evidenceRefs: [] },
  };
}

describe("delegated result commit expiry", () => {
  it("rolls back when an unchanged credential naturally expires after reaching the batch while valid", async () => {
    const f = await fixture("+3 seconds"),
      before = await effects(f),
      originalCredential = await credential(f);
    let reachedWhileLive = false,
      expiredBeforeFlush = false,
      observedAt = "";
    const staged = resultStagedD1(f.db, async () => {
      const reached = await clockWitness(f);
      reachedWhileLive = reached.live === 1;
      expect(reachedWhileLive).toBe(true);
      expect(Date.parse(observedAt)).toBeLessThan(Date.parse(f.expires_at));
      const expired = await waitForExpiry(f);
      expiredBeforeFlush = expired.live === 0;
      expect(Date.parse(expired.database_now)).toBeGreaterThanOrEqual(Date.parse(f.expires_at));
      expect(await credential(f)).toEqual(originalCredential);
    });
    const started = Date.now(),
      hub = new WorkspaceHub(observeSubmission(staged.db, (at) => (observedAt = at)));
    const outcome = await hub.execute(submitDelegatedResultCommand, operation(f, randomUlid()));
    expect(reachedWhileLive).toBe(true);
    expect(expiredBeforeFlush).toBe(true);
    expect(Date.parse(observedAt)).toBeGreaterThanOrEqual(started);
    expect(await credential(f)).toEqual(originalCredential);
    expect(outcome).toEqual({
      ok: false,
      error: { code: "command_failed", message: "command failed" },
    });
    expect(JSON.stringify(outcome)).not.toContain(SUMMARY);
    expect(await effects(f)).toEqual(before);
  });

  it("commits delayed empty evidence while comfortably unexpired and preserves observed timestamps", async () => {
    const f = await fixture("+1 hour"),
      before = await effects(f),
      originalCredential = await credential(f),
      key = randomUlid();
    let reachedWhileLive = false,
      liveAtFlush = false,
      observedAt = "",
      flushAt = "";
    const staged = resultStagedD1(f.db, async () => {
      reachedWhileLive = (await clockWitness(f)).live === 1;
      expect(reachedWhileLive).toBe(true);
      await delay(250);
      const flush = await clockWitness(f);
      liveAtFlush = flush.live === 1;
      flushAt = flush.database_now;
      expect(liveAtFlush).toBe(true);
      expect(await credential(f)).toEqual(originalCredential);
    });
    const started = Date.now(),
      hub = new WorkspaceHub(observeSubmission(staged.db, (at) => (observedAt = at)));
    const outcome = await hub.execute(submitDelegatedResultCommand, operation(f, key));
    expect(reachedWhileLive).toBe(true);
    expect(liveAtFlush).toBe(true);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.error.code);
    expect(outcome.replayed).toBe(false);
    expect(outcome.result.submission.evidence_refs).toEqual([]);
    expect(outcome.result.submission.submitted_at).toBe(observedAt);
    expect(Date.parse(observedAt)).toBeGreaterThanOrEqual(started);
    expect(Date.parse(flushAt) - Date.parse(observedAt)).toBeGreaterThanOrEqual(200);
    expect(await credential(f)).toEqual(originalCredential);
    expect(await effects(f)).toEqual({
      ...before,
      receipts: Object.fromEntries(
        Object.entries(before.receipts).map(([table, n]) => [table, n + 1]),
      ),
      run: { result_state: "submitted", resource_version: before.run.resource_version + 1 },
      task: { state: "review", resource_version: before.task.resource_version + 1 },
      cursor: { cursor: before.cursor.cursor + 1 },
    });
    for (const [table, field] of [
      ["semantic_events", "kind"],
      ["audit_events", "action"],
      ["outbox_records", "kind"],
    ]) {
      expect(
        await f.db
          .prepare(`SELECT created_at FROM ${table} WHERE workspace_id=? AND ${field}=?`)
          .all(FIX.workspace, submitDelegatedResultCommand.name),
      ).toEqual([{ created_at: observedAt }]);
    }
    expect(
      await f.db
        .prepare(
          "SELECT created_at FROM idempotency_records WHERE workspace_id=? AND idempotency_key=?",
        )
        .get(FIX.workspace, key),
    ).toEqual({ created_at: observedAt });
  });
});
