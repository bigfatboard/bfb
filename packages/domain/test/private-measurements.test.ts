// ABOUTME: Exercises current parent-task ACLs for measurements, source pages and review observations.
// ABOUTME: Synthetic privacy policies distinguish telemetry read access from intentional contributions.

import { adaptD1, type D1Like, type D1StatementLike, type SqlDatabase } from "@bfb/db";
import type { RunnerTelemetrySubmission } from "@bfb/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ingestRunnerEventsCommand } from "../src/events.js";
import { FIX } from "../src/fixtures.js";
import { WorkspaceHub, type HubCommand } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import {
  listRunMeasurementActivitySources,
  listRunMeasurementSources,
} from "../src/measurement-sources.js";
import {
  aggregateMeasurements,
  getRunMeasurements,
  getTaskMeasurements,
  listBrowserActivity,
  listMeasurementIntervals,
  listReviewTimerObservations,
  listReviewTimers,
  listTokenObservations,
  recordBrowserActivityCommand,
  reportIntervalCommand,
  reportTokensCommand,
  startReviewTimerCommand,
  stopReviewTimerCommand,
} from "../src/measurements.js";
import type { TaskAccessContext } from "../src/task-access.js";
import { createTaskCommand } from "../src/work-commands.js";
import { captureFixture } from "./agent-capture-fixture.js";
import { openDomainDb } from "./helpers.js";
import { LAUNCH_NOW, launchFixture, success } from "./launch-fixture.js";

const NOW = "2026-10-06T12:00:00.000Z";
const END = "2026-10-06T12:00:01.000Z";
const context = (humanId = FIX.owner, authorizationEpoch = 1): TaskAccessContext => ({
  workspaceId: FIX.workspace,
  humanId,
  authorizationEpoch,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => vi.useRealTimers());

async function privacy(db: SqlDatabase, taskId: string, humanId: string) {
  await db
    .prepare(
      "INSERT INTO task_privacy (workspace_id, task_id, owner_human_id, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(FIX.workspace, taskId, humanId, NOW);
}
async function grant(
  db: SqlDatabase,
  taskId: string,
  humanId: string,
  permission: "read" | "contribute" | "edit",
) {
  const id = randomUlid();
  await db
    .prepare(
      `INSERT INTO task_human_grants
      (workspace_id, id, task_id, human_id, authorization_epoch, permission, created_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(FIX.workspace, id, taskId, humanId, permission, NOW);
  return id;
}
async function revoke(db: SqlDatabase, id: string) {
  await db
    .prepare("UPDATE task_human_grants SET revoked_at = ? WHERE workspace_id = ? AND id = ?")
    .run(NOW, FIX.workspace, id);
}
async function addRun(db: SqlDatabase, taskId: string, id = randomUlid()) {
  await db
    .prepare(
      `INSERT INTO runs
      (workspace_id, id, project_id, task_id, requested_by_human_id, agent_profile_id,
       result_state, activity, resource_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'open', 'unknown', 1, ?)`,
    )
    .run(FIX.workspace, id, FIX.projectA, taskId, FIX.member, FIX.profileCodex, NOW);
  return id;
}
async function fixture() {
  const db = await openDomainDb(),
    hub = new WorkspaceHub(db);
  const execute = <I, R>(
    command: HubCommand<I, R>,
    input: I,
    humanId = FIX.member,
    key = randomUlid(),
  ) =>
    hub.execute(command, {
      workspaceId: FIX.workspace,
      actorHumanId: humanId,
      authorizationEpoch: 1,
      idempotencyKey: key,
      input,
    });
  const task = success(
    await execute(createTaskCommand, {
      projectId: FIX.projectA,
      title: "SYNTHETIC_PRIVATE_MEASUREMENT_TITLE",
      priority: "P2",
    }),
  );
  const shared = success(
    await execute(createTaskCommand, {
      projectId: FIX.projectA,
      title: "Synthetic shared measurement task",
      priority: "P2",
    }),
  );
  const runId = await addRun(db, task.id);
  const sharedRunId = await addRun(db, shared.id);
  await privacy(db, task.id, FIX.member);
  const timer = success(await execute(startReviewTimerCommand, { taskId: task.id, runId }));
  success(
    await execute(recordBrowserActivityCommand, { taskId: task.id, startedAt: NOW, endedAt: END }),
  );
  await db
    .prepare(
      `INSERT INTO token_observations
      (workspace_id, observation_id, run_id, run_execution_id, provider, input_tokens, quality,
       provenance, occurred_at, committed_at)
      VALUES (?, ?, ?, ?, 'fake', 71, 'provider_reported', 'hook_inbox', ?, ?)`,
    )
    .run(FIX.workspace, randomUlid(), runId, randomUlid(), NOW, NOW);
  await db
    .prepare(
      `INSERT INTO measurement_intervals
      (workspace_id, observation_id, run_id, run_execution_id, interval_kind,
       started_at, ended_at, provenance, occurred_at, committed_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?, 'hook_inbox', ?, ?)`,
    )
    .run(FIX.workspace, randomUlid(), runId, randomUlid(), NOW, END, NOW, NOW);
  return { db, hub, execute, task, shared, runId, sharedRunId, timer };
}

/** Injects an authority change immediately before a real SQL read, not a mocked result. */
function beforeRead(db: SqlDatabase, match: RegExp, change: () => Promise<void>): SqlDatabase {
  let fired = false;
  const intercept = async () => {
    if (!fired) {
      fired = true;
      await change();
    }
  };
  return {
    ...db,
    prepare(sql) {
      const statement = db.prepare(sql);
      if (!match.test(sql)) return statement;
      return {
        ...statement,
        async get(...params) {
          await intercept();
          return statement.get(...params);
        },
        async all(...params) {
          await intercept();
          return statement.all(...params);
        },
      };
    },
  };
}

/** Uses the production staged adapter, including null first() and reads-before-writes enforcement. */
function stagedD1(db: SqlDatabase) {
  const entries = new Map<D1StatementLike, { sql: string; parameters: unknown[] }>();
  const binding: D1Like = {
    prepare(sql) {
      const entry = { sql, parameters: [] as unknown[] };
      const statement: D1StatementLike = {
        bind(...parameters) {
          entry.parameters = parameters;
          return statement;
        },
        first: async () => (await db.prepare(sql).get(...entry.parameters)) ?? null,
        all: async () => ({
          results: (await db.prepare(sql).all(...entry.parameters)) as unknown[],
        }),
        run: async () => ({
          meta: (await db.prepare(sql).run(...entry.parameters)) as { changes: number },
        }),
      };
      entries.set(statement, entry);
      return statement;
    },
    batch(statements) {
      return db.withTransaction(async (tx) => {
        const results = [];
        for (const statement of statements) {
          const entry = entries.get(statement)!;
          results.push({
            meta: (await tx.prepare(entry.sql).run(...entry.parameters)) as { changes: number },
          });
        }
        return results;
      });
    },
  };
  return adaptD1(binding);
}

describe("private measurement delivery", () => {
  for (const viewer of [undefined, FIX.owner, FIX.reviewer]) {
    it(`denies private detail and pages without current authority (${viewer ?? "internal"})`, async () => {
      const f = await fixture(),
        access = viewer ? context(viewer) : undefined;
      await expect(
        getTaskMeasurements(f.db, FIX.workspace, f.task.id, NOW, access),
      ).rejects.toMatchObject({ code: "not_found", message: "task not found" });
      await expect(
        getRunMeasurements(f.db, FIX.workspace, f.runId, NOW, access),
      ).rejects.toMatchObject({ code: "not_found", message: "run not found" });
      await expect(
        listRunMeasurementSources(f.db, FIX.workspace, f.runId, {}, access),
      ).rejects.toMatchObject({ code: "not_found", message: "run not found" });
      await expect(
        getTaskMeasurements(f.db, FIX.workspace, randomUlid(), NOW, access),
      ).rejects.toMatchObject({ code: "not_found", message: "task not found" });
      await expect(
        getRunMeasurements(f.db, FIX.workspace, randomUlid(), NOW, access),
      ).rejects.toMatchObject({ code: "not_found", message: "run not found" });
      await expect(
        listRunMeasurementSources(f.db, FIX.workspace, randomUlid(), {}, access),
      ).rejects.toMatchObject({ code: "not_found", message: "run not found" });
      expect(await listTokenObservations(f.db, FIX.workspace, f.runId, access)).toEqual([]);
      expect(await listMeasurementIntervals(f.db, FIX.workspace, f.runId, access)).toEqual([]);
      expect(await listReviewTimers(f.db, FIX.workspace, f.task.id, access)).toEqual([]);
      expect(await listReviewTimerObservations(f.db, FIX.workspace, f.timer.id, access)).toEqual(
        [],
      );
      expect(await listBrowserActivity(f.db, FIX.workspace, FIX.member, access)).toEqual([]);
      expect(await listRunMeasurementActivitySources(f.db, FIX.workspace, f.runId, access)).toEqual(
        [],
      );
      expect(
        (await getTaskMeasurements(f.db, FIX.workspace, f.shared.id, NOW, access)).task_id,
      ).toBe(f.shared.id);
    });
  }

  it.each([FIX.member, FIX.owner, FIX.reviewer])(
    "delivers creator or named-grantee totals (%s)",
    async (humanId) => {
      const f = await fixture();
      if (humanId !== FIX.member) await grant(f.db, f.task.id, humanId, "read");
      const access = context(humanId);
      const task = await getTaskMeasurements(f.db, FIX.workspace, f.task.id, NOW, access);
      expect(task).toMatchObject({
        task_id: f.task.id,
        totals: { exact_tokens: { input: 71 } },
        interventions: { runs: 1 },
        review: { timers: [{ id: f.timer.id }] },
        browser_activity: [{ human_id: FIX.member, observed_ms: 1000 }],
      });
      expect(await listTokenObservations(f.db, FIX.workspace, f.runId, access)).toHaveLength(1);
      expect(await listMeasurementIntervals(f.db, FIX.workspace, f.runId, access)).toHaveLength(1);
      expect(
        await listReviewTimerObservations(f.db, FIX.workspace, f.timer.id, access),
      ).toHaveLength(1);
      expect(await listBrowserActivity(f.db, FIX.workspace, FIX.member, access)).toHaveLength(1);
    },
  );

  it("excludes hidden runs before the aggregation cap and truncation flag", async () => {
    const f = await fixture();
    for (let index = 0; index < 201; index++) {
      await addRun(f.db, f.task.id, `00000000000000000000000${String(index).padStart(3, "0")}`);
    }
    for (const access of [undefined, context()]) {
      expect(
        await aggregateMeasurements(
          f.db,
          FIX.workspace,
          { projectId: FIX.projectA, priority: "P2" },
          NOW,
          access,
        ),
      ).toMatchObject({ cells: [{ runs: 1, exact_tokens: { input: null } }], truncated: false });
    }
  });

  it.each(["grant", "epoch", "project", "membership"] as const)(
    "rechecks %s revocation for totals and lower reads",
    async (kind) => {
      const f = await fixture(),
        id = await grant(f.db, f.task.id, FIX.owner, "read"),
        access = context();
      await getTaskMeasurements(f.db, FIX.workspace, f.task.id, NOW, access);
      if (kind === "grant") await revoke(f.db, id);
      if (kind === "epoch") {
        await f.db
          .prepare("UPDATE workspace_members SET authorization_epoch = 2 WHERE human_id = ?")
          .run(FIX.owner);
        await f.db
          .prepare(
            "UPDATE workspace_authorization_epochs SET authorization_epoch = 2 WHERE human_id = ?",
          )
          .run(FIX.owner);
      }
      if (kind === "project") {
        await f.db
          .prepare("UPDATE projects SET access_mode = 'restricted' WHERE id = ?")
          .run(FIX.projectA);
        await f.db.prepare("DELETE FROM project_access WHERE human_id = ?").run(FIX.owner);
      }
      if (kind === "membership") {
        await f.db
          .prepare("UPDATE workspace_authorization_epochs SET revoked_at = ? WHERE human_id = ?")
          .run(NOW, FIX.owner);
      }
      await expect(
        getTaskMeasurements(f.db, FIX.workspace, f.task.id, NOW, access),
      ).rejects.toMatchObject({ code: "not_found" });
      await expect(
        getRunMeasurements(f.db, FIX.workspace, f.runId, NOW, access),
      ).rejects.toMatchObject({ code: "not_found" });
      expect(await listTokenObservations(f.db, FIX.workspace, f.runId, access)).toEqual([]);
      expect(await listReviewTimerObservations(f.db, FIX.workspace, f.timer.id, access)).toEqual(
        [],
      );
      const aggregate = await aggregateMeasurements(f.db, FIX.workspace, {}, NOW, access);
      expect(aggregate.cells.flatMap((cell) => cell.exact_tokens.input ?? [])).not.toContain(71);
    },
  );

  it("cannot use a different workspace's authenticated context", async () => {
    const f = await fixture(),
      access = { ...context(FIX.member), workspaceId: randomUlid() };
    await expect(
      getTaskMeasurements(f.db, FIX.workspace, f.task.id, NOW, access),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      listRunMeasurementSources(f.db, FIX.workspace, f.runId, {}, access),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("checks private parent access at the token SELECT, not a prior route preflight", async () => {
    const f = await fixture(),
      id = await grant(f.db, f.task.id, FIX.owner, "read");
    const db = beforeRead(f.db, /FROM token_observations AS observation/, () => revoke(f.db, id));
    expect(await listTokenObservations(db, FIX.workspace, f.runId, context())).toEqual([]);
  });

  it.each(["task", "run"] as const)(
    "withholds a %s detail when authority changes during derivation",
    async (kind) => {
      const f = await fixture(),
        id = await grant(f.db, f.task.id, FIX.owner, "read");
      const pattern =
        kind === "task"
          ? /SELECT human_id, started_at, ended_at, capped/
          : /SELECT created_at FROM result_reviews/;
      const db = beforeRead(f.db, pattern, () => revoke(f.db, id));
      const read =
        kind === "task"
          ? getTaskMeasurements(db, FIX.workspace, f.task.id, NOW, context())
          : getRunMeasurements(db, FIX.workspace, f.runId, NOW, context());
      await expect(read).rejects.toMatchObject({ code: "not_found", message: `${kind} not found` });
    },
  );
});

describe("private review timer contributions", () => {
  it("keeps private timers and fresh cached authority valid through the staged D1 adapter", async () => {
    const f = await fixture(),
      id = await grant(f.db, f.task.id, FIX.owner, "contribute");
    const db = stagedD1(f.db),
      hub = new WorkspaceHub(db);
    const execute = <I, R>(command: HubCommand<I, R>, input: I, key = randomUlid()) =>
      hub.execute(command, {
        workspaceId: FIX.workspace,
        actorHumanId: FIX.owner,
        authorizationEpoch: 1,
        idempotencyKey: key,
        input,
      });
    const timer = success(
      await execute(startReviewTimerCommand, { taskId: f.task.id, runId: f.runId }),
    );
    const key = randomUlid(),
      input = { timerId: timer.id, expectedVersion: 1 };
    success(await execute(stopReviewTimerCommand, input, key));
    expect(await execute(stopReviewTimerCommand, input, key)).toMatchObject({
      ok: true,
      replayed: true,
    });
    expect(await listReviewTimerObservations(db, FIX.workspace, timer.id, context())).toHaveLength(
      2,
    );
    await revoke(f.db, id);
    expect(await execute(stopReviewTimerCommand, input, key)).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    await expect(
      getRunMeasurements(db, FIX.workspace, f.runId, NOW, context()),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      listRunMeasurementSources(db, FIX.workspace, randomUlid(), {}, context()),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it.each(["read", "contribute", "edit"] as const)(
    "intersects %s task permission with human contribution",
    async (permission) => {
      const f = await fixture();
      await grant(f.db, f.task.id, FIX.reviewer, permission);
      const result = await f.execute(
        startReviewTimerCommand,
        { taskId: f.task.id, runId: f.runId },
        FIX.reviewer,
      );
      if (permission === "read")
        expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
      else {
        const timer = success(result);
        expect(
          success(
            await f.execute(
              stopReviewTimerCommand,
              { timerId: timer.id, expectedVersion: 1 },
              FIX.reviewer,
            ),
          ),
        ).toMatchObject({ state: "stopped" });
      }
    },
  );

  for (const name of ["start", "stop", "browser"] as const) {
    it(`revocation blocks a cached ${name} contribution without effects`, async () => {
      const f = await fixture(),
        id = await grant(f.db, f.task.id, FIX.owner, "contribute");
      const command: HubCommand<unknown, unknown> =
        name === "start"
          ? (startReviewTimerCommand as HubCommand<unknown, unknown>)
          : name === "stop"
            ? (stopReviewTimerCommand as HubCommand<unknown, unknown>)
            : (recordBrowserActivityCommand as HubCommand<unknown, unknown>);
      const timer =
        name === "stop"
          ? success(await f.execute(startReviewTimerCommand, { taskId: f.task.id }, FIX.owner))
          : undefined;
      const input =
        name === "stop"
          ? { timerId: timer!.id, expectedVersion: 1 }
          : name === "browser"
            ? { taskId: f.task.id, startedAt: NOW, endedAt: END }
            : { taskId: f.task.id };
      const key = randomUlid();
      success(await f.execute(command, input, FIX.owner, key));
      await revoke(f.db, id);
      const count = () =>
        f.db
          .prepare(
            `SELECT
        (SELECT COUNT(*) FROM review_timers) AS timers,
        (SELECT COUNT(*) FROM review_timer_observations) AS observations,
        (SELECT COUNT(*) FROM browser_activity_observations) AS activity,
        (SELECT COUNT(*) FROM idempotency_records) AS receipts`,
          )
          .get();
      const before = await count();
      expect(await f.execute(command, input, FIX.owner, key)).toMatchObject({
        ok: false,
        error: { code: "not_found" },
      });
      expect(await count()).toEqual(before);
    });
  }

  it("a hidden timer and a missing timer return the same bounded denial", async () => {
    const f = await fixture();
    const denied = await f.execute(
      stopReviewTimerCommand,
      { timerId: f.timer.id, expectedVersion: 1 },
      FIX.owner,
    );
    const missing = await f.execute(
      stopReviewTimerCommand,
      { timerId: randomUlid(), expectedVersion: 1 },
      FIX.owner,
    );
    expect(denied).toEqual(missing);
  });

  it("private access does not bypass the starting-reviewer restriction", async () => {
    const f = await fixture();
    await grant(f.db, f.task.id, FIX.owner, "edit");
    expect(
      await f.execute(
        stopReviewTimerCommand,
        { timerId: f.timer.id, expectedVersion: 1 },
        FIX.owner,
      ),
    ).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("cannot associate a timer with another task's run", async () => {
    const f = await fixture();
    expect(
      await f.execute(startReviewTimerCommand, { taskId: f.task.id, runId: f.sharedRunId }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("withholds legacy timers whose optional run does not match the protected task", async () => {
    const f = await fixture();
    await f.db
      .prepare("UPDATE review_timers SET run_id = ? WHERE id = ?")
      .run(f.sharedRunId, f.timer.id);
    expect(await listReviewTimers(f.db, FIX.workspace, f.task.id, context(FIX.member))).toEqual([]);
    expect(
      await listReviewTimerObservations(f.db, FIX.workspace, f.timer.id, context(FIX.member)),
    ).toEqual([]);
    expect(
      await f.execute(stopReviewTimerCommand, { timerId: f.timer.id, expectedVersion: 1 }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("keeps task content and timer/activity bodies out of audit, semantic and outbox receipts", async () => {
    const f = await fixture();
    success(await f.execute(stopReviewTimerCommand, { timerId: f.timer.id, expectedVersion: 1 }));
    const rows = (await f.db
      .prepare(
        `SELECT payload_json FROM audit_events WHERE action IN
      ('review_timer.start', 'review_timer.stop', 'browser_activity.record')
      UNION ALL SELECT payload_json FROM semantic_events WHERE kind IN
      ('review_timer.start', 'review_timer.stop', 'browser_activity.record')
      UNION ALL SELECT payload_json FROM outbox_records WHERE kind IN
      ('review_timer.start', 'review_timer.stop', 'browser_activity.record')`,
      )
      .all()) as Array<{ payload_json: string }>;
    expect(rows).toHaveLength(9);
    for (const row of rows) {
      expect(row.payload_json).not.toContain("SYNTHETIC_PRIVATE_MEASUREMENT_TITLE");
      const result = JSON.parse(row.payload_json).result;
      expect(result).not.toHaveProperty("started_at");
      expect(result).not.toHaveProperty("ended_at");
      expect(result).not.toHaveProperty("started_by_human_id");
    }
  });
});

describe("private authenticated measurement capture and source pages", () => {
  it("read grants admit observations but never timers, and cached capture loses revoked access", async () => {
    vi.setSystemTime(new Date(LAUNCH_NOW));
    const f = await captureFixture();
    await privacy(f.db, f.task.id, FIX.owner);
    const id = await grant(f.db, f.task.id, FIX.member, "read"),
      ref = f.reference();
    const input = {
      principal: f.principal,
      runId: f.claimed.specification.run_id,
      executionId: ref.run_execution_id,
      assignmentGeneration: ref.assignment_generation,
      provider: "fake" as const,
      tokens: { input: 9 },
      quality: "provider_reported" as const,
    };
    const key = randomUlid();
    const execute = () =>
      f.hub.execute(reportTokensCommand, {
        workspaceId: FIX.workspace,
        actorRunnerId: f.runner,
        authorizationEpoch: 1,
        idempotencyKey: key,
        input,
      });
    expect(success(await execute()).tokens.input).toBe(9);
    expect(
      await f.human(startReviewTimerCommand, { taskId: f.task.id }, LAUNCH_NOW, FIX.member),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    success(
      await f.native(reportIntervalCommand, {
        principal: f.principal,
        runId: f.claimed.specification.run_id,
        executionId: ref.run_execution_id,
        assignmentGeneration: ref.assignment_generation,
        intervalKind: "active",
        startedAt: LAUNCH_NOW,
        endedAt: "2026-09-12T12:00:01.000Z",
      }),
    );
    await revoke(f.db, id);
    expect(await execute()).toMatchObject({ ok: false });
  });

  it("runner owner access never substitutes for the assigned requesting human", async () => {
    vi.setSystemTime(new Date(LAUNCH_NOW));
    const f = await captureFixture(),
      ref = f.reference();
    await privacy(f.db, f.task.id, FIX.owner);
    expect(
      await f.native(reportTokensCommand, {
        principal: f.principal,
        runId: f.claimed.specification.run_id,
        executionId: ref.run_execution_id,
        assignmentGeneration: ref.assignment_generation,
        provider: "fake",
        tokens: { input: 9 },
        quality: "provider_reported",
      }),
    ).toMatchObject({ ok: false });
    expect(
      await listTokenObservations(
        f.db,
        FIX.workspace,
        f.claimed.specification.run_id,
        context(FIX.owner),
      ),
    ).toEqual([]);
  });

  it("retains the credential-bound requesting epoch instead of adopting a new private grant", async () => {
    vi.setSystemTime(new Date(LAUNCH_NOW));
    const f = await captureFixture(),
      ref = f.reference();
    await privacy(f.db, f.task.id, FIX.owner);
    await f.db
      .prepare("UPDATE workspace_members SET authorization_epoch = 2 WHERE human_id = ?")
      .run(FIX.member);
    await f.db
      .prepare(
        "UPDATE workspace_authorization_epochs SET authorization_epoch = 2 WHERE human_id = ?",
      )
      .run(FIX.member);
    await f.db
      .prepare(
        `INSERT INTO task_human_grants
      (workspace_id, id, task_id, human_id, authorization_epoch, permission, created_at)
      VALUES (?, ?, ?, ?, 2, 'read', ?)`,
      )
      .run(FIX.workspace, randomUlid(), f.task.id, FIX.member, NOW);
    expect(
      await f.native(reportTokensCommand, {
        principal: f.principal,
        runId: f.claimed.specification.run_id,
        executionId: ref.run_execution_id,
        assignmentGeneration: ref.assignment_generation,
        provider: "fake",
        tokens: { input: 9 },
        quality: "provider_reported",
      }),
    ).toMatchObject({ ok: false });
  });

  it("filters source pages at the actual SELECT and rechecks before returning raw metadata", async () => {
    vi.setSystemTime(new Date(LAUNCH_NOW));
    const f = await launchFixture(),
      claimed = await f.claim(),
      spec = claimed.claimed.specification;
    const stream = randomUlid();
    const events = [1, 2].map((sequence): RunnerTelemetrySubmission => ({
      schema_version: 2,
      event_id: randomUlid(),
      source_stream_id: stream,
      source_sequence: sequence,
      run_execution_id: spec.run_execution_id,
      assignment_generation: spec.assignment_generation,
      kind: "turn_started",
      occurred_at: LAUNCH_NOW,
      capture_origin: "hook_inbox",
      payload: { activity_id: `synthetic-turn-${sequence}` },
    }));
    success(await f.native(ingestRunnerEventsCommand, { principal: f.principal, events }));
    await privacy(f.db, f.task.id, FIX.owner);
    const id = await grant(f.db, f.task.id, FIX.member, "read"),
      access = context(FIX.member);
    const first = await listRunMeasurementSources(
      f.db,
      FIX.workspace,
      spec.run_id,
      { limit: 1 },
      access,
    );
    expect(first).toMatchObject({ sources: [{ event_id: events[0]!.event_id }], has_more: true });
    const second = await listRunMeasurementSources(
      f.db,
      FIX.workspace,
      spec.run_id,
      { afterCursor: first.next_cursor, limit: 1 },
      access,
    );
    expect(second).toMatchObject({ sources: [{ event_id: events[1]!.event_id }], has_more: false });
    expect(
      await aggregateMeasurements(
        f.db,
        FIX.workspace,
        { projectId: FIX.projectA, priority: "P2", provider: "fake" },
        LAUNCH_NOW,
        access,
      ),
    ).toMatchObject({ cells: [{ provider: "fake", runs: 1 }], truncated: false });
    const db = beforeRead(f.db, /SELECT s\.\*, e\.workspace_cursor/, () => revoke(f.db, id));
    await expect(
      listRunMeasurementSources(db, FIX.workspace, spec.run_id, { limit: 1 }, access),
    ).rejects.toMatchObject({ code: "not_found", message: "run not found" });
  });
});
