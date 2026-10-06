// ABOUTME: Proves X05 retention, redaction, audit/activity, recovery, and health behavior.
// ABOUTME: Stale, replayed, missing, and action-mismatched step-up proofs fail privileged operations.

import { describe, expect, it, vi } from "vitest";

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
  markVersionRetained,
  OPS_MIGRATION_ID,
  OPS_STEP_UP_ACTIONS,
  readActivityFeed,
  readQueueState,
  readSecurityAudit,
  resolveStuckUploadCommand,
  renderDiagnosticInventory,
  sanitizeDiagnosticValue,
  scanDiagnosticText,
  setRetentionPolicyCommand,
} from "../src/operations.js";
import { issueStepUpProof } from "../src/step-up.js";
import { createTaskCommand } from "../src/work-commands.js";
import { createRunCommand } from "../src/work-records.js";
import { randomUlid } from "../src/ids.js";
import { openDomainDb } from "./helpers.js";
import { launchFixture, success } from "./launch-fixture.js";
import { loadMigrationManifest } from "@bfb/db";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NOW = "2026-09-18T12:00:00.000Z";
const LATER = "2026-09-18T12:20:00.000Z";
const ACCESS = { workspaceId: FIX.workspace, humanId: FIX.owner, authorizationEpoch: 1 };

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
    const proof = await stepUp(
      db,
      FIX.owner,
      OPS_STEP_UP_ACTIONS.retention,
      `ops-retention:${FIX.workspace}`,
    );
    const outcome = await setRetention(db, 7, proof);
    expect(outcome.ok).toBe(true);
    expect(success(outcome)).toMatchObject({ raw_log_retention_days: 7, version: 1 });
  });

  it("rejects members, missing, stale, replayed, and action-mismatched proofs", async () => {
    const db = await openDomainDb();
    const memberProof = await stepUp(
      db,
      FIX.member,
      OPS_STEP_UP_ACTIONS.retention,
      `ops-retention:${FIX.workspace}`,
    );
    expect((await setRetention(db, 7, memberProof, FIX.member)).ok).toBe(false);

    const ownerProof = await stepUp(
      db,
      FIX.owner,
      OPS_STEP_UP_ACTIONS.retention,
      `ops-retention:${FIX.workspace}`,
    );
    expect((await setRetention(db, 7, ownerProof, FIX.owner, "2026-09-18T13:00:00.000Z")).ok).toBe(
      false,
    );

    const replay = await stepUp(
      db,
      FIX.owner,
      OPS_STEP_UP_ACTIONS.retention,
      `ops-retention:${FIX.workspace}`,
    );
    expect((await setRetention(db, 7, replay)).ok).toBe(true);
    expect((await setRetention(db, 9, replay)).ok).toBe(false);

    const wrong = await stepUp(
      db,
      FIX.owner,
      OPS_STEP_UP_ACTIONS.recover,
      `ops-retention:${FIX.workspace}`,
    );
    expect((await setRetention(db, 11, wrong)).ok).toBe(false);

    const missing = await setRetention(db, 7, "01JAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(missing.ok).toBe(false);

    const badWindow = await stepUp(
      db,
      FIX.owner,
      OPS_STEP_UP_ACTIONS.retention,
      `ops-retention:${FIX.workspace}`,
    );
    expect((await setRetention(db, 400, badWindow)).ok).toBe(false);
  });

  it("rejects delegated envelopes before step-up without changing the policy", async () => {
    const db = await openDomainDb();
    const proof = await stepUp(
      db,
      FIX.owner,
      OPS_STEP_UP_ACTIONS.retention,
      `ops-retention:${FIX.workspace}`,
    );
    const delegated = await hub(db).execute(setRetentionPolicyCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorHumanId: FIX.owner,
      actorDelegationId: randomUlid(),
      authorizationEpoch: 1,
      now: NOW,
      input: { rawLogRetentionDays: 7, stepUpProofId: proof },
    });
    expect(delegated).toMatchObject({ ok: false, error: { code: "forbidden" } });
    const policies = (await db
      .prepare(`SELECT COUNT(*) AS count FROM retention_policies WHERE workspace_id = ?`)
      .get(FIX.workspace)) as { count: number };
    expect(policies).toEqual({ count: 0 });
  });
});

describe("retention eligibility", () => {
  async function seedArtifacts(db: SqlDatabase) {
    const old = "2026-07-01T12:00:00.000Z";
    const fresh = "2026-09-17T12:00:00.000Z";
    const task = success(
      await hub(db).execute(createTaskCommand, {
        workspaceId: FIX.workspace,
        actorHumanId: FIX.member,
        authorizationEpoch: 1,
        idempotencyKey: randomUlid(),
        now: NOW,
        input: { projectId: FIX.projectA, title: "Synthetic retention parent", priority: "P2" },
      }),
    );
    const run = success(
      await hub(db).execute(createRunCommand, {
        workspaceId: FIX.workspace,
        actorHumanId: FIX.owner,
        authorizationEpoch: 1,
        idempotencyKey: randomUlid(),
        now: NOW,
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
    const oldVersion = randomUlid();
    const freshVersion = randomUlid();
    const rows = [
      {
        id: oldVersion,
        role: "log",
        format: "log",
        key: `workspaces/${FIX.workspace}/runs/${run.run.id}/logs/${oldVersion}.jsonl.zst`,
        at: old,
        eligible: true,
      },
      {
        id: freshVersion,
        role: "log",
        format: "log",
        key: `workspaces/${FIX.workspace}/runs/${run.run.id}/logs/${freshVersion}.jsonl.zst`,
        at: fresh,
        eligible: false,
      },
      {
        id: randomUlid(),
        role: "review",
        format: "markdown",
        key: `workspaces/${FIX.workspace}/artifacts/sha256/${"b".repeat(64)}`,
        at: old,
        eligible: false,
      },
      {
        id: randomUlid(),
        role: "log",
        format: "log",
        key: `workspaces/${FIX.workspace}/artifacts/sha256/${"c".repeat(64)}`,
        at: old,
        eligible: false,
      },
    ];
    for (const row of rows) {
      const artifact = randomUlid();
      await db
        .prepare(
          `INSERT INTO artifacts (workspace_id, id, run_id, format, role, created_by_human_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(FIX.workspace, artifact, run.run.id, row.format, row.role, FIX.owner, row.at);
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
    const proof = await stepUp(
      db,
      FIX.owner,
      OPS_STEP_UP_ACTIONS.retention,
      `ops-retention:${FIX.workspace}`,
    );
    expect((await setRetention(db, 30, proof)).ok).toBe(true);
    const found = await listRetentionEligibleChunks(db, FIX.workspace, NOW, ACCESS);
    expect(found.days).toBe(30);
    expect(found.examined).toBe(2);
    expect(found.eligible.map((entry) => entry.version_id)).toEqual([
      rows.find((row) => row.eligible)!.id,
    ]);
  });

  it("keeps every D1 row, hash, and metadata intact after the sweep window", async () => {
    const db = await openDomainDb();
    await seedArtifacts(db);
    const found = await listRetentionEligibleChunks(db, FIX.workspace, NOW, ACCESS);
    expect(found.eligible.length).toBe(1);
    const versions = (await db
      .prepare(`SELECT COUNT(*) AS count FROM artifact_versions`)
      .get()) as {
      count: number;
    };
    expect(versions.count).toBe(4);
  });

  it("stops listing purged chunks once they are retained", async () => {
    const db = await openDomainDb();
    const rows = await seedArtifacts(db);
    const target = rows.find((row) => row.eligible)!.id;
    expect(await markVersionRetained(db, { workspaceId: FIX.workspace, versionId: target })).toBe(
      true,
    );
    expect(await markVersionRetained(db, { workspaceId: FIX.workspace, versionId: target })).toBe(
      false,
    );
    expect(
      await markVersionRetained(db, { workspaceId: FIX.workspace, versionId: randomUlid() }),
    ).toBe(false);
    const found = await listRetentionEligibleChunks(db, FIX.workspace, NOW, ACCESS);
    expect(found.eligible).toEqual([]);
    expect(found.examined).toBe(1);
    const row = (await db
      .prepare(
        `SELECT state, content_hash, r2_key FROM artifact_versions WHERE workspace_id = ? AND id = ?`,
      )
      .get(FIX.workspace, target)) as { state: string; content_hash: string; r2_key: string };
    expect(row.state).toBe("retained");
    expect(row.content_hash).toBe("e".repeat(64));
    expect(row.r2_key).toContain("/logs/");
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
    expect(
      scanDiagnosticText("leaked CANARY-TASK-BODY-1 here", ["CANARY-TASK-BODY-1"]).length,
    ).toBe(1);
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
    expect(clean.nested as Record<string, unknown>).not.toHaveProperty("hook_payload");
    expect(clean.long).toBe("[redacted]");
    expect(clean).not.toHaveProperty("title");
    expect(clean).not.toHaveProperty("body");
    expect(clean.content_hash).toBe("a".repeat(64));
    expect(clean.task_id).toBe("01JAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(clean).not.toHaveProperty("cookie");
    expect(clean).not.toHaveProperty("path");
  });

  it("quarantines inventory construction and body rendering", async () => {
    const db = await openDomainDb();
    await expect(buildDiagnosticInventory(db, FIX.workspace, FIX.owner, NOW)).rejects.toMatchObject(
      {
        code: "request_rejected",
        message: "diagnostic bundles are unavailable",
      },
    );
    expect(() =>
      renderDiagnosticInventory({
        schema_version: 1,
        workspace_id: FIX.workspace,
        generated_at: NOW,
        generated_by: FIX.owner,
        sections: [],
      }),
    ).toThrow("diagnostic bundles are unavailable");
  });
});

describe("audit versus activity", () => {
  it("keeps security audit and activity distinct and attributable", async () => {
    const db = await openDomainDb();
    const proof = await stepUp(
      db,
      FIX.owner,
      OPS_STEP_UP_ACTIONS.retention,
      `ops-retention:${FIX.workspace}`,
    );
    expect((await setRetention(db, 14, proof)).ok).toBe(true);
    const audit = await readSecurityAudit(db, FIX.workspace, { access: ACCESS });
    const retentionRows = audit.entries.filter((entry) => entry.action === "ops.retention.set");
    expect(retentionRows.length).toBe(1);
    expect(retentionRows[0]!.actor_principal_id).toBe(FIX.owner);
    const activity = await readActivityFeed(db, FIX.workspace);
    expect(activity.entries.find((entry) => entry.kind === "ops.retention.set")).toBeUndefined();
  });
});

describe("security audit ordering", () => {
  const T1 = "2026-09-18T12:00:00.000Z";
  const T2 = "2026-09-18T12:10:00.000Z";
  const T3 = "2026-09-18T12:20:00.000Z";

  async function seedChronology(db: SqlDatabase): Promise<string[]> {
    await db.prepare(`DELETE FROM audit_events WHERE workspace_id = ?`).run(FIX.workspace);
    // Inserted oldest-first, but the ids sort in the opposite order on
    // purpose (including the non-ULID recovery-row shape), so an id-ordered
    // read model returns them scrambled.
    const rows = [
      { audit_id: "01ZZZZZZZZZZZZZZZZZZZZZZZZ", created_at: T1 },
      { audit_id: "audit-recovery-shape", created_at: T2 },
      { audit_id: "01000000000000000000000000", created_at: T2 },
      { audit_id: "01MMMMMMMMMMMMMMMMMMMMMMMM", created_at: T3 },
    ];
    for (const row of rows) {
      await db
        .prepare(
          `INSERT INTO audit_events
             (workspace_id, audit_id, actor_principal_id, action, payload_json, created_at)
           VALUES (?, ?, ?, 'ops.audit.order.probe', ?, ?)`,
        )
        .run(
          FIX.workspace,
          row.audit_id,
          FIX.owner,
          JSON.stringify({ action: "probe" }),
          row.created_at,
        );
    }
    return rows.map((row) => row.audit_id);
  }

  it("returns rows oldest-first regardless of id shape", async () => {
    const db = await openDomainDb();
    const ids = await seedChronology(db);
    const audit = await readSecurityAudit(db, FIX.workspace, { access: ACCESS });
    expect(audit.entries.map((entry) => entry.audit_id)).toEqual(ids);
    expect(audit.has_more).toBe(false);
  });

  it("pages forward in time through the after cursor", async () => {
    const db = await openDomainDb();
    const ids = await seedChronology(db);
    const first = await readSecurityAudit(db, FIX.workspace, { limit: 2, access: ACCESS });
    expect(first.entries.map((entry) => entry.audit_id)).toEqual(ids.slice(0, 2));
    expect(first.has_more).toBe(true);
    const second = await readSecurityAudit(db, FIX.workspace, {
      limit: 2,
      after: ids[1],
      access: ACCESS,
    });
    expect(second.entries.map((entry) => entry.audit_id)).toEqual(ids.slice(2));
    expect(second.has_more).toBe(false);
    const empty = await readSecurityAudit(db, FIX.workspace, { after: ids[3], access: ACCESS });
    expect(empty.entries).toEqual([]);
    expect(empty.has_more).toBe(false);
  });

  it("rejects an unknown after cursor instead of skipping in id space", async () => {
    const db = await openDomainDb();
    await seedChronology(db);
    await expect(
      readSecurityAudit(db, FIX.workspace, {
        after: "01AAAAAAAAAAAAAAAAAAAAAAAAA",
        access: ACCESS,
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
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

  it("rejects Owner generation and consent without consuming valid proofs", async () => {
    const db = await openDomainDb();
    const denial = {
      ok: false,
      error: { code: "request_rejected", message: "diagnostic bundles are unavailable" },
    };
    expect(await generate(db)).toEqual(denial);
    const bundleId = randomUlid();
    const consentProof = await stepUp(
      db,
      FIX.owner,
      OPS_STEP_UP_ACTIONS.diagnosticUpload,
      `diagnostic:${bundleId}`,
    );
    const consented = await hub(db).execute(consentDiagnosticUploadCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      now: NOW,
      input: { bundleId, stepUpProofId: consentProof },
    });
    expect(consented).toEqual(denial);
    expect(
      await db
        .prepare("SELECT consumed_at FROM passkey_step_up_proofs WHERE proof_id = ?")
        .get(consentProof),
    ).toEqual({ consumed_at: null });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM diagnostic_bundles").get()).toEqual({
      count: 0,
    });
  });

  it("preserves Member denial and rejects before mismatched proof lookup", async () => {
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
    expect(denied).toMatchObject({ ok: false, error: { code: "forbidden" } });

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
    expect(mismatched).toEqual({
      ok: false,
      error: { code: "request_rejected", message: "diagnostic bundles are unavailable" },
    });
    expect(
      await db
        .prepare("SELECT consumed_at FROM passkey_step_up_proofs WHERE proof_id = ?")
        .get(wrong),
    ).toEqual({ consumed_at: null });
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
      .prepare(
        `SELECT state, attempts FROM github_integration_outbox WHERE workspace_id = ? AND outbox_id = ?`,
      )
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

  it("rejects a mixed github requeue target without touching any row", async () => {
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
         VALUES (?, 'outbox-mixed-dlq', ?, 'github.reconcile', 'dlq', 5, ?, ?, ?), (?, 'outbox-mixed-pending', ?, 'github.reconcile', 'pending', 0, ?, ?, ?)`,
      )
      .run(FIX.workspace, delivery, NOW, NOW, NOW, FIX.workspace, delivery, NOW, NOW, NOW);
    await expect(
      applyOpsRecovery({
        db,
        workspaceId: FIX.workspace,
        kind: "requeue_github_outbox",
        target: { outbox_ids: ["outbox-mixed-dlq", "outbox-mixed-pending"] },
        actorHumanId: FIX.owner,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(DomainError);
    await expect(
      applyOpsRecovery({
        db,
        workspaceId: FIX.workspace,
        kind: "requeue_github_outbox",
        target: { outbox_ids: ["outbox-mixed-pending", "outbox-mixed-dlq"] },
        actorHumanId: FIX.owner,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(DomainError);
    const dlq = (await db
      .prepare(
        `SELECT state, attempts FROM github_integration_outbox WHERE workspace_id = ? AND outbox_id = ?`,
      )
      .get(FIX.workspace, "outbox-mixed-dlq")) as { state: string; attempts: number };
    expect(dlq).toEqual({ state: "dlq", attempts: 5 });
    const ledger = (await db
      .prepare(`SELECT COUNT(*) AS n FROM ops_recovery_ledger WHERE workspace_id = ?`)
      .get(FIX.workspace)) as { n: number };
    expect(ledger.n).toBe(0);
    const done = await applyOpsRecovery({
      db,
      workspaceId: FIX.workspace,
      kind: "requeue_github_outbox",
      target: { outbox_ids: ["outbox-mixed-dlq"] },
      actorHumanId: FIX.owner,
      now: LATER,
    });
    expect(done.detail).toEqual({ requeued: 1 });
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
    // Authorization observes server Date, independent of the command's observed time.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    const resolve = async () =>
      success(
        await hub(db).execute(resolveStuckUploadCommand, {
          workspaceId: FIX.workspace,
          actorHumanId: FIX.owner,
          authorizationEpoch: 1,
          idempotencyKey: randomUlid(),
          now: NOW,
          input: {
            versionIds: [version],
            stepUpProofId: await stepUp(
              db,
              FIX.owner,
              OPS_STEP_UP_ACTIONS.recover,
              `ops-recover:resolve_stuck_upload:${FIX.workspace}`,
            ),
          },
        }),
      );
    let resolved;
    let replay;
    try {
      resolved = await resolve();
      replay = await resolve();
    } finally {
      vi.useRealTimers();
    }
    expect(resolved.detail).toEqual({ resolved: 1 });
    const state = (await db
      .prepare(`SELECT state FROM artifact_versions WHERE workspace_id = ? AND id = ?`)
      .get(FIX.workspace, version)) as { state: string };
    expect(state.state).toBe("failed");
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
    const queues = await readQueueState(f.db, FIX.workspace, NOW, ACCESS);
    expect(queues.ops_recovery).toEqual({ applied: 0, failed: 0 });
    const health = await collectWorkspaceHealth(
      f.db,
      FIX.workspace,
      "2026-09-12T12:10:00.000Z",
      ACCESS,
    );
    expect(health.launches.stuck.map((entry) => entry.command_id)).toEqual([launch.launch_id]);
    expect(health.retention.configured).toBe(false);
    expect(health.providers.length).toBeGreaterThan(0);
  });
});
