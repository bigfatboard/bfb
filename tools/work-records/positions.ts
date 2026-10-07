// ABOUTME: Proves uniform public-position holds and cursor-free receipts against disposable D1 and Hub.
// ABOUTME: Preserves internal committed ordering and synthetic private rows without activating private controls.

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adaptD1, createAuthorizationContext, type D1Like, type SqlDatabase } from "@bfb/db";
import {
  FIX,
  getRunMeasurements,
  getTaskMeasurements,
  listLedgerEvents,
  listRunMeasurementSources,
  listWorkspaceEvents,
  loadPrincipal,
  randomUlid,
  readActivityFeed,
  readEventHighWater,
  readLedgerHighWater,
  seedSyntheticWorkspace,
  type CommandOutcome,
  type CreateRunResult,
  type TaskRecord,
} from "@bfb/domain";
import { createTestHarness } from "wrangler";
import { publicCommandOutcome } from "../../apps/control-worker/src/public-command-outcome.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const now = new Date().toISOString();
const server = createTestHarness({
  root,
  workers: [
    { configPath: "tools/work-records/wrangler-a.toml" },
    { configPath: "tools/work-records/wrangler-b.toml" },
    { configPath: "tools/work-records/wrangler-hub.toml" },
  ],
});
const held = { code: "request_rejected", message: "event feeds are unavailable" };
const checks: string[] = [];

async function command<T>(name: string, input: unknown, key = randomUlid()) {
  const response = await server
    .getWorker("bfb-work-records-a")
    .fetch(`https://bfb.positions.test/workspaces/${FIX.workspace}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandName: name,
        request: {
          workspaceId: FIX.workspace,
          actorHumanId: FIX.owner,
          authorizationEpoch: 1,
          idempotencyKey: key,
          now,
          input,
        },
      }),
    });
  assert.equal(response.status, 200);
  const outcome = (await response.json()) as CommandOutcome<T>;
  assert(outcome.ok, outcome.ok ? undefined : outcome.error.code);
  return outcome;
}

try {
  await server.listen();
  const worker = server.getWorker("bfb-work-records-hub");
  await worker.applyD1Migrations("DB");
  const db = adaptD1(((await worker.getEnv()) as unknown as { DB: D1Like }).DB);
  await seedSyntheticWorkspace(db, now);
  const access = await loadPrincipal(db, FIX.workspace, FIX.owner);
  const authorization = createAuthorizationContext({
    workspaceId: FIX.workspace,
    principalId: FIX.owner,
    authorizationEpoch: 1,
    jurisdiction: "eu",
  });
  let touches = 0;
  const noSourceDb = {
    ...db,
    prepare() {
      touches += 1;
      throw new Error("held public reader attempted database access");
    },
  } satisfies SqlDatabase;
  async function assertHeldReaders(runId: string) {
    await assert.rejects(readEventHighWater(noSourceDb, authorization), held);
    await assert.rejects(readLedgerHighWater(noSourceDb, authorization), held);
    await assert.rejects(
      listWorkspaceEvents(noSourceDb, authorization, { afterCursor: 0, throughCursor: 100 }),
      held,
    );
    await assert.rejects(
      listLedgerEvents(noSourceDb, authorization, { afterCursor: 0, throughCursor: 100 }),
      held,
    );
    await assert.rejects(
      listRunMeasurementSources(noSourceDb, FIX.workspace, runId, {}, access),
      held,
    );
    await assert.rejects(readActivityFeed(noSourceDb, FIX.workspace, { access }), held);
    assert.equal(touches, 0);
  }
  await assertHeldReaders(randomUlid());
  checks.push("real_d1_empty_workspace_public_readers_hold_without_source_queries");
  const input = {
    projectId: FIX.projectA,
    title: "Synthetic position hold task",
    priority: "P2",
  };
  const key = randomUlid();
  const created = await command<TaskRecord>("task.create", input, key);
  const retried = await command<TaskRecord>("task.create", input, key);
  assert.equal(created.replayed, false);
  assert.equal(retried.replayed, true);
  assert.equal(created.cursor, retried.cursor);
  assert(Number.isSafeInteger(created.cursor) && created.cursor > 0);
  assert.deepEqual(publicCommandOutcome(created), {
    ok: true,
    result: created.result,
    replayed: false,
  });
  assert.deepEqual(publicCommandOutcome(retried), {
    ok: true,
    result: retried.result,
    replayed: true,
  });
  checks.push("real_hub_internal_fresh_cached_cursor_is_retained_while_public_projection_omits_it");
  const run = await command<CreateRunResult>("run.create", {
    taskId: created.result.id,
    expectedTaskVersion: created.result.resource_version,
    agentProfileId: FIX.profileCodex,
    workspacePolicyVersion: 1,
    projectPolicyVersion: 1,
    repositoryConfigVersion: 1,
    agentProfileVersion: 1,
  });
  await assertHeldReaders(run.result.run.id);
  await db
    .prepare(
      "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
    )
    .run(FIX.workspace, created.result.id, FIX.owner, now);
  const tables = [
    "tasks",
    "task_privacy",
    "semantic_events",
    "event_ledger",
    "workspace_cursors",
    "idempotency_records",
  ];
  const snapshot = () =>
    Promise.all(tables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()));
  const before = await snapshot();
  await assertHeldReaders(run.result.run.id);
  assert.deepEqual(await snapshot(), before);
  checks.push("real_d1_shared_private_readers_hold_identically_without_rewriting_history");
  const measured = await getRunMeasurements(db, FIX.workspace, run.result.run.id, now, access);
  const taskMeasured = await getTaskMeasurements(db, FIX.workspace, created.result.id, now, access);
  assert.equal(measured.sources, null);
  assert.equal(taskMeasured.runs.length, 1);
  assert(taskMeasured.runs.every((item) => item.sources === null));
  assert.deepEqual(await snapshot(), before);
  checks.push("real_d1_authorized_private_measurements_and_nested_runs_have_null_public_sources");
  console.log(
    JSON.stringify({
      schema_version: 1,
      checks,
      outcome: "passed",
      limits: [
        "Synthetic dormant privacy policies and zero-observation measurement shape, not a live arithmetic or byte certificate",
        "Domain and public-adapter proof; mounted authentication and UI are separate tests",
        "No opaque replacement stream, private activation, runner acknowledgement change or provider operation",
      ],
    }),
  );
  console.log("C11_PUBLIC_POSITION_HOLD_D1_OK");
} finally {
  await server.close();
}
