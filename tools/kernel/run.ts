// ABOUTME: Exercises the C01 hub and abuse counter through real Workerd isolates and D1.
// ABOUTME: Applies checked-in migrations and verifies atomic effects in one shared database.

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { adaptD1, type D1Like } from "@bfb/db";
import {
  abuseBucketKey,
  FIX,
  hashIp,
  seedSyntheticWorkspace,
  type AbuseDecision,
  type CommandOutcome,
  type TaskRecord,
} from "@bfb/domain";
import { createTestHarness } from "wrangler";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const server = createTestHarness({
  root: repoRoot,
  workers: [
    { configPath: "tools/kernel/wrangler-a.toml" },
    { configPath: "tools/kernel/wrangler-b.toml" },
    { configPath: "tools/kernel/wrangler-hub.toml" },
  ],
});

interface KernelEnv {
  DB: D1Like;
}

interface TestNamespace {
  jurisdiction(name: "eu" | "us"): TestNamespace;
  idFromName(name: string): unknown;
  get(id: unknown): {
    fetch(input: string, init: RequestInit): Promise<Response>;
  };
}

interface HubEnv extends KernelEnv {
  WORKSPACE_HUB: TestNamespace;
}

async function consume(workerName: string, bucketKey: string, index: number) {
  const response = await server.getWorker(workerName).fetch("https://kernel.test/consume", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bucketKey,
      now: `2026-08-07T12:00:${String(index).padStart(2, "0")}Z`,
      limit: 3,
      windowSeconds: 60,
    }),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as AbuseDecision;
}

async function executeHubCommands(hubEnv: HubEnv): Promise<void> {
  await seedSyntheticWorkspace(adaptD1(hubEnv.DB));
  // Workerd does not implement jurisdiction selection; hub-client tests cover
  // persisted jurisdiction routing before this binding is addressed.
  const namespace = hubEnv.WORKSPACE_HUB;
  const stub = namespace.get(namespace.idFromName(FIX.workspace));
  const oversized = await stub.fetch("https://bfb-hub.internal/execute", {
    method: "POST",
    body: "x".repeat(65_537),
  });
  assert.equal(oversized.status, 413);
  const outcomes = await Promise.all(
    Array.from({ length: 5 }, async (_, index) => {
      const response = await stub.fetch("https://bfb-hub.internal/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandName: "task.create",
          request: {
            workspaceId: FIX.workspace,
            idempotencyKey: `workerd-command-${index}`,
            authorizationEpoch: 1,
            actorHumanId: FIX.owner,
            now: "2026-08-07T12:00:00Z",
            input: {
              projectId: FIX.projectA,
              title: `Workerd task ${index}`,
              priority: "P2",
            },
          },
        }),
      });
      assert.equal(response.status, 200);
      return (await response.json()) as CommandOutcome<TaskRecord>;
    }),
  );
  assert(outcomes.every((outcome) => outcome.ok));
  assert.deepEqual(
    outcomes.map((outcome) => (outcome.ok ? outcome.cursor : -1)).sort((a, b) => a - b),
    [1, 2, 3, 4, 5],
  );
}

async function main(): Promise<void> {
  try {
    await server.listen();
    const workerA = server.getWorker("bfb-kernel-a");
    const workerB = server.getWorker("bfb-kernel-b");
    const hubWorker = server.getWorker("bfb-kernel-hub");
    await workerA.applyD1Migrations("DB");
    const hubEnv = (await hubWorker.getEnv()) as unknown as HubEnv;
    await executeHubCommands(hubEnv);

    const bucketKey = abuseBucketKey({
      ipHashSeed: hashIp("203.0.113.10"),
      subject: "shared-isolate-budget",
      surface: "c01-runtime",
    });
    const decisions = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        consume(index % 2 === 0 ? "bfb-kernel-a" : "bfb-kernel-b", bucketKey, index),
      ),
    );
    assert.equal(decisions.filter((decision) => decision.allowed).length, 3);
    assert.equal(decisions.filter((decision) => !decision.allowed).length, 9);
    assert(decisions.some((decision) => decision.escalateTurnstile));

    const envA = (await workerA.getEnv()) as unknown as KernelEnv;
    const envB = (await workerB.getEnv()) as unknown as KernelEnv;
    const rowA = (await envA.DB.prepare(`SELECT count FROM rate_limit_buckets WHERE bucket_key = ?`)
      .bind(bucketKey)
      .first()) as { count: number } | null;
    const rowB = (await envB.DB.prepare(`SELECT count FROM rate_limit_buckets WHERE bucket_key = ?`)
      .bind(bucketKey)
      .first()) as { count: number } | null;
    assert.deepEqual(rowA, { count: 6 });
    assert.deepEqual(rowB, { count: 6 });

    const committed = (await hubEnv.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM tasks) AS tasks,
         (SELECT COUNT(*) FROM semantic_events) AS events,
         (SELECT COUNT(*) FROM audit_events) AS audits,
         (SELECT COUNT(*) FROM outbox_records) AS outbox,
         (SELECT COUNT(*) FROM idempotency_records) AS idempotency,
         (SELECT cursor FROM workspace_cursors WHERE workspace_id = ?) AS cursor`,
    )
      .bind(FIX.workspace)
      .first()) as {
      tasks: number;
      events: number;
      audits: number;
      outbox: number;
      idempotency: number;
      cursor: number;
    } | null;
    assert.deepEqual(committed, {
      tasks: 5,
      events: 5,
      audits: 5,
      outbox: 5,
      idempotency: 5,
      cursor: 5,
    });
    assert(rowA);
    console.log(
      JSON.stringify({
        workers: ["bfb-kernel-a", "bfb-kernel-b", "bfb-kernel-hub"],
        hub: committed,
        requests: decisions.length,
        allowed: decisions.filter((decision) => decision.allowed).length,
        storedCount: rowA.count,
      }),
    );
    console.log("C01_D1_OK");
  } catch (error) {
    server.debug();
    throw error;
  } finally {
    await server.close();
  }
}

await main();
