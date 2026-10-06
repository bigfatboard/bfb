// ABOUTME: Proves diagnostic quarantine admission and historical-copy omission on disposable real D1.
// ABOUTME: Synthetic retained snapshots are preserved without queue, provider or live-pilot operation.

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adaptD1, createAuthorizationContext, loadMigrationManifest, type D1Like } from "@bfb/db";
import {
  FIX,
  issueStepUpProof,
  listWorkspaceEvents,
  randomUlid,
  readSecurityAudit,
  seedSyntheticWorkspace,
  type CommandOutcome,
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
const denied = { code: "request_rejected", message: "diagnostic bundles are unavailable" };
const checks: string[] = [];

async function command(name: string, input: unknown, key: string, epoch = 1) {
  const response = await server
    .getWorker("bfb-work-records-a")
    .fetch(`https://bfb.diagnostics.test/workspaces/${FIX.workspace}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandName: name,
        request: {
          workspaceId: FIX.workspace,
          actorHumanId: FIX.owner,
          authorizationEpoch: epoch,
          idempotencyKey: key,
          now,
          input,
        },
      }),
    });
  assert.equal(response.status, 200);
  return (await response.json()) as CommandOutcome<unknown>;
}

try {
  await server.listen();
  const worker = server.getWorker("bfb-work-records-hub");
  await worker.applyD1Migrations("DB");
  const db = adaptD1(((await worker.getEnv()) as unknown as { DB: D1Like }).DB);
  await seedSyntheticWorkspace(db, now);
  const access = { workspaceId: FIX.workspace, humanId: FIX.owner, authorizationEpoch: 1 };
  const snapshot = async () => {
    const rows = {} as Record<string, unknown>;
    for (const table of [
      "diagnostic_bundles",
      "semantic_events",
      "audit_events",
      "outbox_records",
      "idempotency_records",
      "workspace_cursors",
    ]) {
      rows[table] = await db
        .prepare(`SELECT * FROM ${table} WHERE workspace_id=?`)
        .all(FIX.workspace);
    }
    return rows;
  };
  const proof = await issueStepUpProof(
    db,
    FIX.owner,
    {
      action: "diagnostic.generate",
      workspaceId: FIX.workspace,
      targetId: `diagnostic:generate:${FIX.workspace}`,
      scopes: [],
      authorizationEpoch: 1,
      expiresAt: new Date(Date.parse(now) + 5 * 60_000).toISOString(),
    },
    now,
  );
  const beforeEmpty = await snapshot();
  const emptyOutcome = await command("diagnostic.generate", { stepUpProofId: proof }, randomUlid());
  assert(!emptyOutcome.ok);
  assert.deepEqual(emptyOutcome.error, denied);
  assert.deepEqual(await snapshot(), beforeEmpty);
  assert.equal(
    (
      (await db
        .prepare("SELECT consumed_at FROM passkey_step_up_proofs WHERE proof_id=?")
        .get(proof)) as { consumed_at: string | null }
    ).consumed_at,
    null,
  );
  checks.push("real_hub_diagnostic_empty_generation_denies_before_proof_or_business_effects");

  const bundleId = randomUlid();
  const inventoryJson = JSON.stringify({
    schema_version: 1,
    sections: [{ name: "work", fields: { tasks: 17 } }],
  });
  await db
    .prepare(
      `INSERT INTO diagnostic_bundles
    (workspace_id,id,created_by_human_id,state,inventory_json,bundle_hash,redaction_status,created_at,consented_at,expires_at)
    VALUES (?,?,?,'consented',?,?,'passed',?,?,?)`,
    )
    .run(
      FIX.workspace,
      bundleId,
      FIX.owner,
      inventoryJson,
      "a".repeat(64),
      now,
      now,
      new Date(Date.parse(now) + 24 * 60 * 60_000).toISOString(),
    );
  const cacheKey = "diagnostic-cached-history";
  const cached = JSON.stringify({
    result: { id: bundleId, inventory_json: inventoryJson },
    cursor: 1,
    actorHumanId: FIX.owner,
    authorizationEpoch: 1,
  });
  await db
    .prepare(
      `INSERT INTO idempotency_records
    (workspace_id,idempotency_key,command_name,result_json,created_at) VALUES (?,?,'diagnostic.generate',?,?)`,
    )
    .run(FIX.workspace, cacheKey, cached, now);
  const beforeHistory = await snapshot();
  for (const [name, input, key] of [
    ["diagnostic.generate", { stepUpProofId: proof }, cacheKey],
    [
      "diagnostic.upload_consent",
      { bundleId, stepUpProofId: "synthetic-unissued-proof" },
      randomUlid(),
    ],
    [
      "diagnostic.upload_consent",
      { bundleId: randomUlid(), stepUpProofId: "synthetic-unissued-proof" },
      randomUlid(),
    ],
  ] as const) {
    const outcome = await command(name, input, key);
    assert(!outcome.ok);
    assert.deepEqual(outcome.error, denied);
  }
  assert.deepEqual(await snapshot(), beforeHistory);
  checks.push(
    "real_hub_diagnostic_cache_and_known_missing_consent_are_uniform_without_history_rewrite",
  );

  const controlId = randomUlid();
  const diagnosticAnchor = randomUlid();
  for (const [cursor, kind, id] of [
    [1000, "diagnostic.generate", diagnosticAnchor],
    [1001, "DIAGNOSTIC.unknown", randomUlid()],
    [1002, "task.legacy_control", controlId],
  ] as const) {
    const payload = JSON.stringify(
      kind.toLowerCase().startsWith("diagnostic.")
        ? { result: { inventory_json: inventoryJson } }
        : { revision: 1 },
    );
    await db
      .prepare(
        `INSERT INTO semantic_events
      (workspace_id,event_id,workspace_cursor,kind,payload_json,created_at) VALUES (?,?,?,?,?,?)`,
      )
      .run(FIX.workspace, id, cursor, kind, payload, now);
    await db
      .prepare(
        `INSERT INTO audit_events
      (workspace_id,audit_id,actor_principal_id,action,payload_json,created_at) VALUES (?,?,?,?,?,?)`,
      )
      .run(FIX.workspace, id, FIX.owner, kind, payload, now);
  }
  const beforeCopies = await snapshot();
  const audit = await readSecurityAudit(db, FIX.workspace, { access, limit: 1 });
  assert.deepEqual(
    audit.entries.map((row) => row.audit_id),
    [controlId],
  );
  assert.equal(audit.has_more, false);
  for (const anchor of [diagnosticAnchor, randomUlid()]) {
    await assert.rejects(
      readSecurityAudit(db, FIX.workspace, { access, limit: 1, after: anchor }),
      {
        code: "invalid_argument",
        message: "unknown audit cursor",
      },
    );
  }
  const events = await listWorkspaceEvents(
    db,
    createAuthorizationContext({
      workspaceId: FIX.workspace,
      principalId: FIX.owner,
      authorizationEpoch: 1,
      jurisdiction: "eu",
    }),
    { afterCursor: 999, throughCursor: 1002, limit: 1 },
  );
  assert.deepEqual(
    events.map((row) => row.eventId),
    [controlId],
  );
  assert.deepEqual(await snapshot(), beforeCopies);
  checks.push(
    "real_d1_diagnostic_audit_anchor_and_semantic_copy_omission_precedes_limits_without_rewrite",
  );

  await db
    .prepare(
      "UPDATE workspace_authorization_epochs SET authorization_epoch=2 WHERE workspace_id=? AND human_id=?",
    )
    .run(FIX.workspace, FIX.owner);
  await db
    .prepare(
      "UPDATE workspace_members SET authorization_epoch=2 WHERE workspace_id=? AND human_id=?",
    )
    .run(FIX.workspace, FIX.owner);
  const stale = await command("diagnostic.generate", { stepUpProofId: proof }, cacheKey);
  assert(!stale.ok);
  assert.equal(stale.error.code, "stale_authorization");
  await assert.rejects(readSecurityAudit(db, FIX.workspace, { access, after: diagnosticAnchor }), {
    code: "not_found",
    message: "operations scope not found",
  });
  checks.push("real_hub_diagnostic_cache_requires_current_epoch_and_audit_scope_precedes_anchor");
  console.log(
    JSON.stringify({
      schema_version: 1,
      stage: "diagnostic_snapshot_quarantine",
      migration_head: loadMigrationManifest(resolve(root, "migrations/d1")).migration_head,
      checks,
      outcome: "passed",
      limits: [
        "synthetic retained history only; no historical source attestation",
        "no opaque-position or complete C11 certificate",
        "no queue, provider, live pilot, private R2 byte delivery or deployment",
      ],
    }),
  );
  console.log("C11_DIAGNOSTIC_QUARANTINE_D1_OK");
} finally {
  await server.close();
}
