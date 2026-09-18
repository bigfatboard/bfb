// ABOUTME: Proves X05 retention, redaction, audit/activity, recovery, and health behavior.
// ABOUTME: Stale, replayed, missing, and action-mismatched step-up proofs fail privileged operations.

import { describe, expect, it } from "vitest";

import type { SqlDatabase } from "@bfb/db";

import { FIX } from "../src/fixtures.js";
import { DomainError, WorkspaceHub } from "../src/hub.js";
import { startLaunchCommand } from "../src/launches.js";
import {
  applyOpsRecovery,
  buildDiagnosticInventory,
  checkOperationsTables,
  collectWorkspaceHealth,
  consentDiagnosticUploadCommand,
  createDiagnosticBundleCommand,
  listRetentionEligibleChunks,
  listStuckLaunches,
  listStuckUploads,
  OPS_MIGRATION_ID,
  OPS_STEP_UP_ACTIONS,
  readActivityFeed,
  readQueueState,
  readSecurityAudit,
  renderDiagnosticInventory,
  sanitizeDiagnosticValue,
  scanDiagnosticText,
  setRetentionPolicyCommand,
} from "../src/operations.js";
import { issueStepUpProof } from "../src/step-up.js";
import { randomUlid } from "../src/ids.js";
import { openDomainDb } from "./helpers.js";
import { launchFixture, success } from "./launch-fixture.js";
import { loadMigrationManifest } from "@bfb/db";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NOW = "2026-09-18T12:00:00.000Z";
const LATER = "2026-09-18T12:20:00.000Z";

function hub(db: SqlDatabase): WorkspaceHub {
  return new WorkspaceHub(db);
}

async function stepUp(
  db: SqlDatabase,
  humanId: string,
  action: string,
  targetId: string,
  now: string = NOW,
  expiresInMs = 5 * 60_000,
): Promise<string> {
  return issueStepUpProof(
    db,
    humanId,
    {
      action,
      workspaceId: FIX.workspace,
      targetId,
      scopes: [],
      authorizationEpoch: 1,
      expiresAt: new Date(Date.parse(now) + expiresInMs).toISOString(),
    },
    now,
  );
}

async function setRetention(
  db: SqlDatabase,
  days: number,
  proof: string,
  humanId: string = FIX.owner,
  now: string = NOW,
) {
  return hub(db).execute(setRetentionPolicyCommand, {
    workspaceId: FIX.workspace,
    idempotencyKey: randomUlid(),
    actorHumanId: humanId,
    authorizationEpoch: 1,
    now,
    input: { rawLogRetentionDays: days, stepUpProofId: proof },
  });
}

describe("x05 operations migration", () => {
  it("is registered and applied without claiming newest head", async () => {
    const db = await openDomainDb();
    const manifest = loadMigrationManifest(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../migrations/d1"),
    );
    expect(manifest.migrations.some((entry) => entry.id === OPS_MIGRATION_ID)).toBe(true);
    expect(await checkOperationsTables(db)).toEqual({ ok: true, missing: [] });
  });
});

describe("retention policy", () => {
  it("sets the window for an Owner with a fresh bound proof", async () => {
    const db = await openDomainDb();
    const proof = await stepUp(db, FIX.owner, OPS_STEP_UP_ACTIONS.retention, `ops-retention:${FIX.workspace}`);
    const outcome = await setRetention(db, 7, proof);
    expect(outcome.ok).toBe(true);
    expect(success(outcome)).toMatchObject({ raw_log_retention_days: 7, version: 1 });
  });

  it("rejects members, missing, stale, replayed, and action-mismatched proofs", async () => {
    const db = await openDomainDb();
    const memberProof = await stepUp(db, FIX.member, OPS_STEP_UP_ACTIONS.retention, `ops-retention:${FIX.workspace}`);
    expect((await setRetention(db, 7, memberProof, FIX.member)).ok).toBe(false);

    const ownerProof = await stepUp(db, FIX.owner, OPS_STEP_UP_ACTIONS.retention, `ops-retention:${FIX.workspace}`);
    expect((await setRetention(db, 7, ownerProof, FIX.owner, "2026-09-18T13:00:00.000Z")).ok).toBe(false);

    const replay = await stepUp(db, FIX.owner, OPS_STEP_UP_ACTIONS.retention, `ops-retention:${FIX.workspace}`);
    expect((await setRetention(db, 7, replay)).ok).toBe(true);
    expect((await setRetention(db, 9, replay)).ok).toBe(false);

    const wrong = await stepUp(db, FIX.owner, OPS_STEP_UP_ACTIONS.recover, `ops-retention:${FIX.workspace}`);
    expect((await setRetention(db, 11, wrong)).ok).toBe(false);

    const missing = await setRetention(db, 7, "01JAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(missing.ok).toBe(false);

    const badWindow = await stepUp(db, FIX.owner, OPS_STEP_UP_ACTIONS.retention, `ops-retention:${FIX.workspace}`);
    expect((await setRetention(db, 400, badWindow)).ok).toBe(false);
  });
});

describe("retention eligibility", () => {
  async function seedArtifacts(db: SqlDatabase) {
    const old = "2026-07-01T12:00:00.000Z";
    const fresh = "2026-09-17T12:00:00.000Z";
    const rows = [
      { id: randomUlid(), role: "log", format: "log", key: `workspaces/${FIX.workspace}/runs/01JRUN00000000000000000001/logs/v1.jsonl.zst`, at: old, eligible: true },
      { id: randomUlid(), role: "log", format: "log", key: `workspaces/${FIX.workspace}/runs/01JRUN00000000000000000001/logs/v2.jsonl.zst`, at: fresh, eligible: false },
      { id: randomUlid(), role: "review", format: "markdown", key: `workspaces/${FIX.workspace}/artifacts/sha256/${"b".repeat(64)}`, at: old, eligible: false },
      { id: randomUlid(), role: "log", format: "log", key: `workspaces/${FIX.workspace}/artifacts/sha256/${"c".repeat(64)}`, at: old, eligible: false },
    ];
    for (const row of rows) {
      const artifact = randomUlid();
      await db
        .prepare(
          `INSERT INTO artifacts (workspace_id, id, run_id, format, role, created_by_human_id, created_at)
           VALUES (?, ?, NULL, ?, ?, ?, ?)`,
        )
        .run(FIX.workspace, artifact, row.format, row.role, FIX.owner, row.at);
      await db
        .prepare(
          `INSERT INTO artifact_versions (workspace_id, id, artifact_id, state, format, declared_size, expected_digest, content_hash, r2_key, created_at, available_at)
           VALUES (?, ?, ?, 'available', ?, 128, ?, ?, ?, ?, ?)`,
        )
        .run(
          FIX.workspace,
          row.id,
          artifact,
          row.format,
          "d".repeat(64),
          "e".repeat(64),
          row.key,
          row.at,
          row.at,
        );
    }
    return rows;
  }

  it("selects only eligible raw log chunks and never shared hashes", async () => {
    const db = await openDomainDb();
    const rows = await seedArtifacts(db);
    const proof = await stepUp(db, FIX.owner, OPS_STEP_UP_ACTIONS.retention, `ops-retention:${FIX.workspace}`);
    expect((await setRetention(db, 30, proof)).ok).toBe(true);
    const found = await listRetentionEligibleChunks(db, FIX.workspace, NOW);
    expect(found.days).toBe(30);
    expect(found.examined).toBe(2);
    expect(found.eligible.map((entry) => entry.version_id)).toEqual([
      rows.find((row) => row.eligible)!.id,
    ]);
  });

  it("keeps every D1 row, hash, and metadata intact after the sweep window", async () => {
    const db = await openDomainDb();
    await seedArtifacts(db);
    const found = await listRetentionEligibleChunks(db, FIX.workspace, NOW);
    expect(found.eligible.length).toBe(1);
    const versions = (await db.prepare(`SELECT COUNT(*) AS count FROM artifact_versions`).get()) as {
      count: number;
    };
    expect(versions.count).toBe(4);
  });
});

describe("redaction", () => {
  it("catches prohibited classes and planted canaries", () => {
    expect(scanDiagnosticText("session cookie=abc; Bearer [REDACTED]")).toContain("cookie");
    expect(scanDiagnosticText("-----BEGIN PRIVATE KEY-----\nx")).toContain("private_key");
    expect(scanDiagnosticText("token ghs_abc123 rest")).toContain("github_token");
    expect(scanDiagnosticText("path /Users/timo/secret")).toContain("local_path");
    expect(scanDiagnosticText("run bfb __launch abc")).toContain("launch_command");
    expect(scanDiagnosticText("clean counts only", ["CANARY-TASK-BODY-1"])).toEqual([]);
    expect(scanDiagnosticText("leaked CANARY-TASK-BODY-1 here", ["CANARY-TASK-BODY-1"]).length).toBe(1);
  });

  it("sanitizes unknown audit payloads without leaking secrets or paths", () => {
    const clean = sanitizeDiagnosticValue({
      action: "runner.enrolled",
      bearer: "should-drop",
      nested: { hook_payload: "drop me", count: 3 },
      long: "x".repeat(300),
      title: "task body must not survive",
      body: "prompt text must not survive",
      content_hash: "a".repeat(64),
      task_id: "01JAAAAAAAAAAAAAAAAAAAAAAAAA",
      cookie: "session=secret",
      path: "/Users/someone/secret",
    }) as Record<string, unknown>;
    expect(clean.action).toBe("runner.enrolled");
    expect(clean).not.toHaveProperty("bearer");
    expect((clean.nested as Record<string, unknown>).count).toBe(3);
    expect((clean.nested as Record<string, unknown>)).not.toHaveProperty("hook_payload");
    expect(clean.long).toBe("[redacted]");
    expect(clean).not.toHaveProperty("title");
    expect(clean).not.toHaveProperty("body");
    expect(clean.content_hash).toBe("a".repeat(64));
    expect(clean.task_id).toBe("01JAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(clean).not.toHaveProperty("cookie");
    expect(clean).not.toHaveProperty("path");
  });

  it("builds an inventory that passes the secret scan", async () => {
    const db = await openDomainDb();
    const inventory = await buildDiagnosticInventory(db, FIX.workspace, FIX.owner, NOW);
    expect(inventory.sections.map((section) => section.name)).toEqual([
      "identity",
      "work",
      "delivery",
      "execution",
      "integrations",
    ]);
    expect(scanDiagnosticText(renderDiagnosticInventory(inventory))).toEqual([]);
  });
});

describe("audit versus activity", () => {
  it("keeps security audit and activity distinct and attributable", async () => {
    const db = await openDomainDb();
    const proof = await stepUp(db, FIX.owner, OPS_STEP_UP_ACTIONS.retention, `ops-retention:${FIX.workspace}`);
    expect((await setRetention(db, 14, proof)).ok).toBe(true);
    const audit = await readSecurityAudit(db, FIX.workspace);
    const retentionRows = audit.entries.filter((entry) => entry.action === "ops.retention.set");
    expect(retentionRows.length).toBe(1);
    expect(retentionRows[0]!.actor_principal_id).toBe(FIX.owner);
    const activity = await readActivityFeed(db, FIX.workspace);
    expect(activity.entries.find((entry) => entry.kind === "ops.retention.set")).toBeUndefined();
  });
});

describe("diagnostic bundles", () => {
  async function generate(db: SqlDatabase, now = NOW) {
    const proof = await stepUp(
      db,
      FIX.owner,
      OPS_STEP_UP_ACTIONS.diagnosticGenerate,
      `diagnostic:generate:${FIX.workspace}`,
      now,
    );
    return hub(db).execute(createDiagnosticBundleCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      now,
      input: { stepUpProofId: proof },
    });
  }

  it("generates with Owner step-up and consents with an explicit second proof", async () => {
    const db = await openDomainDb();
    const created = success(await generate(db));
    expect(created.state).toBe("pending_consent");
    expect(created.redaction_status).toBe("passed");
    const consentProof = await stepUp(db, FIX.owner, OPS_STEP_UP_ACTIONS.diagnosticUpload, `diagnostic:${created.id}`);
    const consented = await hub(db).execute(consentDiagnosticUploadCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      now: NOW,
      input: { bundleId: created.id, stepUpProofId: consentProof },
    });
    expect(success(consented).state).toBe("consented");
    const consumed = await hub(db).execute(consentDiagnosticUploadCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      now: NOW,
      input: { bundleId: created.id, stepUpProofId: consentProof },
    });
    expect(consumed.ok).toBe(false);
    const freshProof = await stepUp(db, FIX.owner, OPS_STEP_UP_ACTIONS.diagnosticUpload, `diagnostic:${created.id}`);
    const idempotent = await hub(db).execute(consentDiagnosticUploadCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      now: NOW,
      input: { bundleId: created.id, stepUpProofId: freshProof },
    });
    expect(success(idempotent).state).toBe("consented");
  });

  it("rejects member generation, mismatched actions, and expired bundles", async () => {
    const db = await openDomainDb();
    const memberProof = await stepUp(
      db,
      FIX.member,
      OPS_STEP_UP_ACTIONS.diagnosticGenerate,
      `diagnostic:generate:${FIX.workspace}`,
    );
    const denied = await hub(db).execute(createDiagnosticBundleCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorHumanId: FIX.member,
      authorizationEpoch: 1,
      now: NOW,
      input: { stepUpProofId: memberProof },
    });
    expect(denied.ok).toBe(false);

    const wrong = await stepUp(
      db,
      FIX.owner,
      OPS_STEP_UP_ACTIONS.diagnosticUpload,
      `diagnostic:generate:${FIX.workspace}`,
    );
    const mismatched = await hub(db).execute(createDiagnosticBundleCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      now: NOW,
      input: { stepUpProofId: wrong },
    });
    expect(mismatched.ok).toBe(false);

    const created = success(await generate(db));
    const late = await hub(db).execute(consentDiagnosticUploadCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      now: "2026-09-20T12:00:00.000Z",
      input: {
        bundleId: created.id,
        stepUpProofId: await stepUp(
          db,
          FIX.owner,
          OPS_STEP_UP_ACTIONS.diagnosticUpload,
          `diagnostic:${created.id}`,
          "2026-09-20T12:00:00.000Z",
        ),
      },
    });
    expect(late.ok).toBe(false);
  });
});

describe("privileged recovery", () => {
  it("rewinds notification dispatch idempotently", async () => {
    const db = await openDomainDb();
    await db
      .prepare(
        `INSERT INTO semantic_events (workspace_id, event_id, workspace_cursor, kind, payload_json, created_at)
         VALUES (?, ?, 7, 'attention.request', '{}', ?)`,
      )
      .run(FIX.workspace, randomUlid(), NOW);
    const target = { cursors: [7] };
    const first = await applyOpsRecovery({
      db,
      workspaceId: FIX.workspace,
      kind: "retry_notification_dispatch",
      target,
      actorHumanId: FIX.owner,
      now: NOW,
    });
    expect(first.replayed).toBe(false);
    expect(first.detail.redispatched_from).toBe(6);
    const second = await applyOpsRecovery({
      db,
      workspaceId: FIX.workspace,
      kind: "retry_notification_dispatch",
      target,
      actorHumanId: FIX.owner,
      now: NOW,
    });
    expect(second.replayed).toBe(true);
    expect(second.detail).toEqual(first.detail);
    await expect(
      applyOpsRecovery({
        db,
        workspaceId: FIX.workspace,
        kind: "retry_notification_dispatch",
        target: { cursors: [4242] },
        actorHumanId: FIX.owner,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("requeues only dlq or stale dispatched github rows", async () => {
    const db = await openDomainDb();
    const delivery = randomUlid();
    await db
      .prepare(
        `INSERT INTO github_webhook_deliveries (workspace_id, delivery_id, event, effect_json, state, received_at)
         VALUES (?, ?, 'push', '{}', 'received', ?)`,
      )
      .run(FIX.workspace, delivery, NOW);
    await db
      .prepare(
        `INSERT INTO github_integration_outbox (workspace_id, outbox_id, delivery_id, kind, state, attempts, next_attempt_at, created_at, updated_at)
         VALUES (?, 'outbox-dlq-1', ?, 'github.reconcile', 'dlq', 5, ?, ?, ?), (?, 'outbox-pending-1', ?, 'github.reconcile', 'pending', 0, ?, ?, ?)`,
      )
      .run(FIX.workspace, delivery, NOW, NOW, NOW, FIX.workspace, delivery, NOW, NOW, NOW);
    const first = await applyOpsRecovery({
      db,
      workspaceId: FIX.workspace,
      kind: "requeue_github_outbox",
      target: { outbox_ids: ["outbox-dlq-1"] },
      actorHumanId: FIX.owner,
      now: NOW,
    });
    expect(first.detail).toEqual({ requeued: 1 });
    const row = (await db
      .prepare(`SELECT state, attempts FROM github_integration_outbox WHERE workspace_id = ? AND outbox_id = ?`)
      .get(FIX.workspace, "outbox-dlq-1")) as { state: string; attempts: number };
    expect(row).toEqual({ state: "pending", attempts: 0 });
    const replay = await applyOpsRecovery({
      db,
      workspaceId: FIX.workspace,
      kind: "requeue_github_outbox",
      target: { outbox_ids: ["outbox-dlq-1"] },
      actorHumanId: FIX.owner,
      now: NOW,
    });
    expect(replay.replayed).toBe(true);
    await expect(
      applyOpsRecovery({
        db,
        workspaceId: FIX.workspace,
        kind: "requeue_github_outbox",
        target: { outbox_ids: ["outbox-pending-1"] },
        actorHumanId: FIX.owner,
        now: LATER,
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("resolves only genuinely stuck uploads and clears ledger state", async () => {
    const db = await openDomainDb();
    const artifact = randomUlid();
    const version = randomUlid();
    await db
      .prepare(
        `INSERT INTO artifacts (workspace_id, id, run_id, format, role, created_by_human_id, created_at)
         VALUES (?, ?, NULL, 'log', 'log', ?, ?)`,
      )
      .run(FIX.workspace, artifact, FIX.owner, "2026-09-18T10:00:00.000Z");
    await db
      .prepare(
        `INSERT INTO artifact_versions (workspace_id, id, artifact_id, state, format, declared_size, expected_digest, created_at)
         VALUES (?, ?, ?, 'uploading', 'log', 64, ?, ?)`,
      )
      .run(FIX.workspace, version, artifact, "f".repeat(64), "2026-09-18T10:00:00.000Z");
    const stuck = await listStuckUploads(db, FIX.workspace, NOW);
    expect(stuck.map((entry) => entry.version_id)).toEqual([version]);
    const resolved = await applyOpsRecovery({
      db,
      workspaceId: FIX.workspace,
      kind: "resolve_stuck_upload",
      target: { version_ids: [version] },
      actorHumanId: FIX.owner,
      now: NOW,
    });
    expect(resolved.detail).toEqual({ resolved: 1 });
    const state = (await db
      .prepare(`SELECT state FROM artifact_versions WHERE workspace_id = ? AND id = ?`)
      .get(FIX.workspace, version)) as { state: string };
    expect(state.state).toBe("failed");
    const replay = await applyOpsRecovery({
      db,
      workspaceId: FIX.workspace,
      kind: "resolve_stuck_upload",
      target: { version_ids: [version] },
      actorHumanId: FIX.owner,
      now: NOW,
    });
    expect(replay.replayed).toBe(true);
    const cleared = await applyOpsRecovery({
      db,
      workspaceId: FIX.workspace,
      kind: "clear_recovery_state",
      target: { action_ids: [resolved.action_id] },
      actorHumanId: FIX.owner,
      now: NOW,
    });
    expect(cleared.detail).toEqual({ cleared: 1 });
  });

  it("rejects unknown kinds and live versions", async () => {
    const db = await openDomainDb();
    await expect(
      applyOpsRecovery({
        db,
        workspaceId: FIX.workspace,
        kind: "launch_missiles" as never,
        target: {},
        actorHumanId: FIX.owner,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(DomainError);
    await expect(
      applyOpsRecovery({
        db,
        workspaceId: FIX.workspace,
        kind: "resolve_stuck_upload",
        target: { version_ids: [randomUlid()] },
        actorHumanId: FIX.owner,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });
});

describe("stuck launches and queue health", () => {
  it("surfaces expired pending launches without touching live claims", async () => {
    const f = await launchFixture();
    const launch = success(await f.human(startLaunchCommand, f.start));
    expect(await listStuckLaunches(f.db, FIX.workspace, "2026-09-12T12:01:00.000Z")).toEqual([]);
    const stuck = await listStuckLaunches(f.db, FIX.workspace, "2026-09-12T12:10:00.000Z");
    expect(stuck.map((entry) => entry.command_id)).toEqual([launch.launch_id]);
    const queues = await readQueueState(f.db, FIX.workspace, NOW);
    expect(queues.ops_recovery).toEqual({ applied: 0, failed: 0 });
    const health = await collectWorkspaceHealth(f.db, FIX.workspace, "2026-09-12T12:10:00.000Z");
    expect(health.launches.stuck.map((entry) => entry.command_id)).toEqual([launch.launch_id]);
    expect(health.retention.configured).toBe(false);
    expect(health.providers.length).toBeGreaterThan(0);
  });
});
