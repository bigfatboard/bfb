// ABOUTME: Proves unsupported audit and legacy recovery holds on disposable real D1.
// ABOUTME: Synthetic retained records remain unchanged without proofs, queues or provider effects.

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adaptD1, type D1Like, type SqlDatabase } from "@bfb/db";
import {
  FIX,
  applyOpsRecovery,
  randomUlid,
  readSecurityAudit,
  recoveryActionId,
  seedSyntheticWorkspace,
  type OpsRecoveryKind,
} from "@bfb/domain";
import { createTestHarness } from "wrangler";

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
const checks: string[] = [];
const access = { workspaceId: FIX.workspace, humanId: FIX.owner, authorizationEpoch: 1 };

try {
  await server.listen();
  const worker = server.getWorker("bfb-work-records-hub");
  await worker.applyD1Migrations("DB");
  const binding = ((await worker.getEnv()) as unknown as { DB: D1Like }).DB;
  const db = adaptD1(binding);
  const independent = adaptD1(binding);
  await seedSyntheticWorkspace(db, now);
  const ids: string[] = [];
  for (const [action, payload] of [
    ["task.create", JSON.stringify({ task_id: randomUlid(), title: "SYNTHETIC_UNPROVEN_AUDIT" })],
    ["attention.answer", "not-json"],
    ["ops.recover", '{"kind":"clear_recovery_state","action_id":"synthetic-legacy"}'],
    ["workspace.policy.update", '{"version":1,"version":2}'],
    ["unknown.family", JSON.stringify({ source_id: randomUlid() + "\u0000SYNTHETIC_SOURCE" })],
  ]) {
    const id = randomUlid();
    ids.push(id);
    await db
      .prepare(
        `INSERT INTO audit_events
        (workspace_id,audit_id,actor_principal_id,action,payload_json,created_at)
        VALUES (?,?,?,?,?,?)`,
      )
      .run(FIX.workspace, id, FIX.member, action, payload, now);
  }
  const beforeAudit = await db
    .prepare("SELECT * FROM audit_events WHERE workspace_id=? ORDER BY rowid")
    .all(FIX.workspace);
  assert.deepEqual(await readSecurityAudit(db, FIX.workspace, { limit: 1, access }), {
    entries: [],
    has_more: false,
    next_cursor: null,
  });
  for (const after of [...ids, randomUlid()]) {
    await assert.rejects(readSecurityAudit(db, FIX.workspace, { after, limit: 1, access }), {
      code: "invalid_argument",
      message: "unknown audit cursor",
    });
  }
  assert.deepEqual(
    await db
      .prepare("SELECT * FROM audit_events WHERE workspace_id=? ORDER BY rowid")
      .all(FIX.workspace),
    beforeAudit,
  );
  checks.push(
    "real_d1_unsupported_audit_families_are_omitted_before_limit_has_more_and_anchor_without_rewrite",
  );

  const targets: Array<[OpsRecoveryKind, Record<string, unknown>]> = [
    ["retry_notification_dispatch", { cursors: [1] }],
    ["requeue_github_outbox", { outbox_ids: ["synthetic-held-outbox"] }],
    ["clear_recovery_state", { action_ids: ["synthetic-held-ledger"] }],
  ];
  for (const [kind, target] of targets) {
    await db
      .prepare(
        `INSERT INTO ops_recovery_ledger
        (workspace_id,action_id,kind,target_json,state,attempt_count,result_json,
         created_by_human_id,created_at,updated_at)
        VALUES (?,?,?,?,'applied',1,?, ?,?,?)`,
      )
      .run(
        FIX.workspace,
        recoveryActionId(kind, target),
        kind,
        JSON.stringify(target),
        JSON.stringify({ source_id: "SYNTHETIC_UNPROVEN_LEGACY_RESULT" }),
        FIX.owner,
        now,
        now,
      );
  }
  const beforeLedger = await db
    .prepare("SELECT * FROM ops_recovery_ledger WHERE workspace_id=? ORDER BY rowid")
    .all(FIX.workspace);
  let reads = 0;
  const observed: SqlDatabase = {
    ...db,
    prepare(sql) {
      reads++;
      return db.prepare(sql);
    },
  };
  for (const [kind, target] of targets) {
    await assert.rejects(
      applyOpsRecovery({
        db: observed,
        workspaceId: FIX.workspace,
        actorHumanId: FIX.owner,
        kind,
        target,
        now,
      }),
      { code: "request_rejected", message: "recovery kind is unavailable" },
    );
  }
  assert.equal(reads, 0);
  assert.deepEqual(
    await db
      .prepare("SELECT * FROM ops_recovery_ledger WHERE workspace_id=? ORDER BY rowid")
      .all(FIX.workspace),
    beforeLedger,
  );
  assert.deepEqual(
    await db
      .prepare("SELECT * FROM audit_events WHERE workspace_id=? ORDER BY rowid")
      .all(FIX.workspace),
    beforeAudit,
  );
  checks.push(
    "real_d1_retained_legacy_recovery_outcomes_stay_unread_and_unchanged_under_direct_helper_hold",
  );

  let changed = false;
  const raced: SqlDatabase = {
    ...db,
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        ...statement,
        async get(...parameters: unknown[]) {
          if (!changed) {
            changed = true;
            await independent
              .prepare(
                "UPDATE workspace_authorization_epochs SET revoked_at=? WHERE workspace_id=? AND human_id=?",
              )
              .run(now, FIX.workspace, FIX.owner);
          }
          return statement.get(...parameters);
        },
      };
    },
  };
  const unsupportedAnchor = ids[0];
  assert(unsupportedAnchor);
  await assert.rejects(
    readSecurityAudit(raced, FIX.workspace, { after: unsupportedAnchor, access }),
    {
      code: "not_found",
      message: "operations scope not found",
    },
  );
  assert.equal(changed, true);
  checks.push(
    "real_d1_empty_quarantined_audit_rechecks_current_epoch_before_unsupported_anchor_denial",
  );
  console.log(JSON.stringify({ schema_version: 1, checks, outcome: "passed" }));
  console.log("C11_UNSUPPORTED_QUARANTINE_D1_OK");
} finally {
  await server.close();
}
