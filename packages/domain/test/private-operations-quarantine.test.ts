// ABOUTME: Proves unsupported audit families are unavailable before pagination and cursor selection.
// ABOUTME: Held legacy recoveries reject before target hashing, stored outcomes or business effects.

import type { SqlDatabase } from "@bfb/db";
import { describe, expect, it } from "vitest";
import { ARTIFACT_RECOVERY_SYSTEM_ID } from "../src/artifacts.js";
import { FIX } from "../src/fixtures.js";
import { randomUlid } from "../src/ids.js";
import {
  applyOpsRecovery,
  readSecurityAudit,
  recoveryActionId,
  type OpsRecoveryKind,
} from "../src/operations.js";
import { issueStepUpProof } from "../src/step-up.js";
import { openDomainDb } from "./helpers.js";

const NOW = "2026-10-07T12:00:00.000Z";
const OLD = "2026-10-07T10:00:00.000Z";
const ACCESS = { workspaceId: FIX.workspace, humanId: FIX.owner, authorizationEpoch: 1 };
const DENIAL = { code: "request_rejected", message: "recovery kind is unavailable" };
const HELD = [
  "retry_notification_dispatch",
  "requeue_github_outbox",
  "clear_recovery_state",
] as const;

async function snapshot(db: SqlDatabase) {
  const rows: Record<string, unknown> = {};
  for (const table of [
    "artifact_versions",
    "artifact_audit_outbox",
    "notification_dispatch_state",
    "github_webhook_deliveries",
    "github_integration_outbox",
    "ops_recovery_ledger",
    "passkey_step_up_proofs",
    "audit_events",
    "semantic_events",
    "idempotency_records",
    "outbox_records",
    "workspace_cursors",
  ])
    rows[table] = await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  return rows;
}

async function canonicalReceipt(db: SqlDatabase) {
  const artifactId = randomUlid(),
    versionId = randomUlid(),
    auditId = randomUlid();
  await db
    .prepare(
      "INSERT INTO artifacts (workspace_id,id,run_id,format,role,created_by_human_id,created_at) VALUES (?,?,NULL,'log','log',?,?)",
    )
    .run(FIX.workspace, artifactId, FIX.owner, OLD);
  await db
    .prepare(
      "INSERT INTO artifact_versions (workspace_id,id,artifact_id,state,format,declared_size,expected_digest,created_at) VALUES (?,?,?,'failed','log',64,?,?)",
    )
    .run(FIX.workspace, versionId, artifactId, "a".repeat(64), OLD);
  await db
    .prepare(
      "INSERT INTO artifact_audit_outbox (workspace_id,id,version_id,grant_id,action,payload_json,created_at,dispatched_at) VALUES (?,?,?,NULL,'artifact.abandoned','{}',?,?)",
    )
    .run(FIX.workspace, auditId, versionId, OLD, NOW);
  await db
    .prepare(
      "INSERT INTO audit_events (workspace_id,audit_id,actor_principal_id,action,payload_json,created_at) VALUES (?,?,?,'artifact.abandoned','{}',?)",
    )
    .run(FIX.workspace, auditId, ARTIFACT_RECOVERY_SYSTEM_ID, NOW);
  return auditId;
}

async function unsupportedReceipt(db: SqlDatabase, action: string, payload: string) {
  const id = randomUlid();
  await db
    .prepare(
      "INSERT INTO audit_events (workspace_id,audit_id,actor_principal_id,action,payload_json,created_at) VALUES (?,?,?,?,?,?)",
    )
    .run(FIX.workspace, id, FIX.owner, action, payload, OLD);
  return id;
}

async function recoveryFixture(kind: (typeof HELD)[number]) {
  const db = await openDomainDb();
  const existingId = "ops:historical:retained-ledger";
  await db
    .prepare(
      "INSERT INTO ops_recovery_ledger (workspace_id,action_id,kind,target_json,state,attempt_count,result_json,created_by_human_id,created_at,updated_at) VALUES (?,?,'resolve_stuck_upload','{}','applied',1,'{\"resolved\":1}',?,?,?)",
    )
    .run(FIX.workspace, existingId, FIX.owner, OLD, OLD);
  await db
    .prepare(
      "INSERT INTO semantic_events (workspace_id,event_id,workspace_cursor,kind,payload_json,created_at) VALUES (?,?,7,'attention.request','{}',?)",
    )
    .run(FIX.workspace, randomUlid(), OLD);
  await db
    .prepare(
      "INSERT INTO notification_dispatch_state (workspace_id,last_cursor,updated_at) VALUES (?,20,?)",
    )
    .run(FIX.workspace, OLD);
  const deliveryId = randomUlid(),
    outboxId = randomUlid();
  await db
    .prepare(
      "INSERT INTO github_webhook_deliveries (workspace_id,delivery_id,event,effect_json,state,received_at) VALUES (?,?,'push','{}','received',?)",
    )
    .run(FIX.workspace, deliveryId, OLD);
  await db
    .prepare(
      "INSERT INTO github_integration_outbox (workspace_id,outbox_id,delivery_id,kind,state,attempts,next_attempt_at,created_at,updated_at) VALUES (?,?,?,'github.reconcile','dlq',5,?,?,?)",
    )
    .run(FIX.workspace, outboxId, deliveryId, OLD, OLD, OLD);
  await issueStepUpProof(
    db,
    FIX.owner,
    {
      action: "ops.recover",
      workspaceId: FIX.workspace,
      targetId: `ops-recover:${kind}:${FIX.workspace}`,
      scopes: [],
      authorizationEpoch: 1,
      expiresAt: "2026-10-07T12:05:00.000Z",
    },
    NOW,
  );
  const target: Record<string, unknown> =
    kind === "retry_notification_dispatch"
      ? { cursors: [7] }
      : kind === "requeue_github_outbox"
        ? { outbox_ids: [outboxId] }
        : { action_ids: [existingId] };
  return { db, target };
}

function recover(db: SqlDatabase, kind: OpsRecoveryKind, target: Record<string, unknown>) {
  return applyOpsRecovery({
    db,
    workspaceId: FIX.workspace,
    kind,
    target,
    actorHumanId: FIX.owner,
    now: NOW,
  });
}

describe("unsupported operations quarantine", () => {
  it("omits unrelated identifiers before page slots and has_more, preserving canonical history", async () => {
    const db = await openDomainDb();
    const hidden = await unsupportedReceipt(
      db,
      "attention.answer",
      JSON.stringify({ task_id: "SYNTHETIC-PRIVATE-TASK-ID", attention_id: randomUlid() }),
    );
    await unsupportedReceipt(db, "workspace.policy", '{"project_id":"SYNTHETIC-PROJECT-ID"}');
    const visible = await canonicalReceipt(db),
      before = await snapshot(db);
    const result = await readSecurityAudit(db, FIX.workspace, { access: ACCESS, limit: 1 });
    expect(result.entries.map((entry) => entry.audit_id)).toEqual([visible]);
    expect(result.has_more).toBe(false);
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC-PRIVATE-TASK-ID");
    for (const after of [hidden, randomUlid()])
      await expect(
        readSecurityAudit(db, FIX.workspace, { access: ACCESS, after }),
      ).rejects.toMatchObject({ code: "invalid_argument", message: "unknown audit cursor" });
    expect(await snapshot(db)).toEqual(before);
  });

  it("holds unsupported spelling and payload shapes without parsing or presence-dependent gates", async () => {
    const db = await openDomainDb();
    const ids = [];
    for (const [action, payload] of [
      ["ops.recover", "not JSON"],
      ["legacy.audit", '{"task_id":"first","task_id":"second"}'],
      ["security.audit", JSON.stringify('{"task_id":"serialized"}')],
      ["ARTIFACT.future", '{"task_id":"unsupported"}'],
      ["attention.answer\u0000artifact.finalized", '{"task_id":"nul"}'],
    ])
      ids.push(await unsupportedReceipt(db, action!, payload!));
    const before = await snapshot(db);
    expect(await readSecurityAudit(db, FIX.workspace, { access: ACCESS, limit: 1 })).toEqual({
      entries: [],
      has_more: false,
      next_cursor: null,
    });
    for (const after of ids)
      await expect(
        readSecurityAudit(db, FIX.workspace, { access: ACCESS, after }),
      ).rejects.toMatchObject({ code: "invalid_argument", message: "unknown audit cursor" });
    expect(await snapshot(db)).toEqual(before);
  });

  it("checks explicit current Owner and retained epoch before unsupported or missing anchors", async () => {
    const db = await openDomainDb(),
      hidden = await unsupportedReceipt(db, "task.update", "{}");
    for (const access of [
      { ...ACCESS, humanId: FIX.member },
      { ...ACCESS, authorizationEpoch: 2 },
    ])
      for (const after of [undefined, hidden, randomUlid()])
        await expect(readSecurityAudit(db, FIX.workspace, { access, after })).rejects.toMatchObject(
          { code: "not_found", message: "operations scope not found" },
        );
    await expect(readSecurityAudit(db, FIX.workspace, undefined as never)).rejects.toMatchObject({
      code: "invalid_argument",
    });
  });

  it.each(HELD)(
    "rejects fresh %s without effects on valid historical targets or proofs",
    async (kind) => {
      const f = await recoveryFixture(kind),
        before = await snapshot(f.db);
      await expect(recover(f.db, kind, f.target)).rejects.toMatchObject(DENIAL);
      expect(await snapshot(f.db)).toEqual(before);
    },
  );

  it.each(HELD)("rejects stored %s before delivering its retained result", async (kind) => {
    const f = await recoveryFixture(kind);
    await f.db
      .prepare(
        "INSERT INTO ops_recovery_ledger (workspace_id,action_id,kind,target_json,state,attempt_count,result_json,created_by_human_id,created_at,updated_at) VALUES (?,?,?,?,'applied',1,?,?,?,?)",
      )
      .run(
        FIX.workspace,
        recoveryActionId(kind, f.target),
        kind,
        JSON.stringify(f.target),
        '{"resource_id":"SYNTHETIC-STORED-RESULT-ID","count":1}',
        FIX.owner,
        OLD,
        OLD,
      );
    const before = await snapshot(f.db);
    await expect(recover(f.db, kind, f.target)).rejects.toMatchObject(DENIAL);
    expect(await snapshot(f.db)).toEqual(before);
  });

  it.each(HELD)("rejects %s without database access or target serialization", async (kind) => {
    const db = await openDomainDb(),
      tracked = recordSql(db);
    let serialized = 0;
    const target = {
      toJSON() {
        serialized += 1;
        return {};
      },
    };
    await expect(recover(tracked.db, kind, target)).rejects.toMatchObject(DENIAL);
    expect(tracked.sql).toEqual([]);
    expect(serialized).toBe(0);
  });

  it("preserves unknown-kind and explicit Hub-only upload denial without database access", async () => {
    const db = await openDomainDb(),
      tracked = recordSql(db);
    await expect(recover(tracked.db, "unknown_recovery" as never, {})).rejects.toMatchObject({
      code: "invalid_argument",
      message: "unknown recovery kind unknown_recovery",
    });
    await expect(recover(tracked.db, "resolve_stuck_upload", {})).rejects.toMatchObject({
      code: "request_rejected",
      message: "upload recovery requires WorkspaceHub",
    });
    expect(tracked.sql).toEqual([]);
  });
});

function recordSql(db: SqlDatabase) {
  const sql: string[] = [];
  return {
    sql,
    db: {
      ...db,
      prepare(statement: string) {
        sql.push(statement);
        return db.prepare(statement);
      },
    },
  };
}
