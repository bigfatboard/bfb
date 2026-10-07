// ABOUTME: Certifies opaque audit positions and atomic issuance guards against disposable real D1.
// ABOUTME: Independent Workers use the production Hub while synthetic races preserve business history.

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adaptD1, type D1Like, type SqlDatabase } from "@bfb/db";
import {
  ARTIFACT_RECOVERY_SYSTEM_ID,
  createSecurityAuditPosition,
  FIX,
  hashSecurityAuditPosition,
  issueSecurityAuditPositionCommand,
  randomUlid,
  readSecurityAudit,
  seedSyntheticWorkspace,
  WorkspaceHub,
  type CommandOutcome,
  type IssueSecurityAuditPosition,
  type IssueSecurityAuditPositionInput,
} from "@bfb/domain";
import { createTestHarness } from "wrangler";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const now = new Date().toISOString();
const access = { workspaceId: FIX.workspace, humanId: FIX.owner, authorizationEpoch: 1 };
const denied = { code: "invalid_argument", message: "unknown audit cursor" };
const checks: string[] = [];
let maximumBindings = 0;
let maximumStatementBytes = 0;

/** Observe production SQL without replacing D1 statements or atomic batch behavior. */
function observeDatabase(source: SqlDatabase): SqlDatabase {
  return {
    prepare(sql) {
      maximumStatementBytes = Math.max(maximumStatementBytes, Buffer.byteLength(sql));
      assert(Buffer.byteLength(sql) <= 100_000, "audit statement must fit D1's statement bound");
      const statement = source.prepare(sql);
      const validate = (parameters: unknown[]) => {
        maximumBindings = Math.max(maximumBindings, parameters.length);
        assert(parameters.length <= 100, "audit statement must fit D1's parameter bound");
      };
      return {
        async get(...parameters) {
          validate(parameters);
          return statement.get(...parameters);
        },
        async all(...parameters) {
          validate(parameters);
          return statement.all(...parameters);
        },
        async run(...parameters) {
          validate(parameters);
          return statement.run(...parameters);
        },
      };
    },
    withTransaction(fn) {
      return source.withTransaction((tx) => fn(observeDatabase(tx)));
    },
  };
}
const server = createTestHarness({
  root,
  workers: [
    { configPath: "tools/work-records/wrangler-a.toml" },
    { configPath: "tools/work-records/wrangler-b.toml" },
    { configPath: "tools/work-records/wrangler-hub.toml" },
  ],
});

async function command(
  lane: "a" | "b",
  input: IssueSecurityAuditPositionInput,
  key = randomUlid(),
): Promise<CommandOutcome<{ issued: true }>> {
  const response = await server
    .getWorker(`bfb-work-records-${lane}`)
    .fetch(`https://bfb.audit-positions.test/workspaces/${FIX.workspace}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandName: issueSecurityAuditPositionCommand.name,
        request: {
          workspaceId: FIX.workspace,
          actorHumanId: FIX.owner,
          authorizationEpoch: 1,
          idempotencyKey: key,
          input,
        },
      }),
    });
  assert.equal(response.status, 200);
  return (await response.json()) as CommandOutcome<{ issued: true }>;
}

async function receipt(
  db: SqlDatabase,
  at: string,
  workspaceId = FIX.workspace,
  runId: string | null = null,
) {
  const artifactId = randomUlid(),
    versionId = randomUlid(),
    id = randomUlid();
  const digest = "a".repeat(64);
  await db
    .prepare(
      `INSERT INTO artifacts
    (workspace_id,id,run_id,format,role,created_by_human_id,created_at)
    VALUES (?,?,?,'log','log',?,?)`,
    )
    .run(workspaceId, artifactId, runId, FIX.owner, at);
  await db
    .prepare(
      `INSERT INTO artifact_versions
    (workspace_id,id,artifact_id,state,format,declared_size,expected_digest,content_hash,r2_key,created_at,available_at)
    VALUES (?,?,?,'available','log',64,?,?,?,?,?)`,
    )
    .run(workspaceId, versionId, artifactId, digest, digest, `synthetic/${versionId}`, at, at);
  await db
    .prepare(
      `INSERT INTO artifact_audit_outbox
    (workspace_id,id,version_id,grant_id,action,payload_json,created_at,dispatched_at)
    VALUES (?,?,?,NULL,'artifact.finalized','{}',?,?)`,
    )
    .run(workspaceId, id, versionId, at, at);
  await db
    .prepare(
      `INSERT INTO audit_events
    (workspace_id,audit_id,actor_principal_id,action,payload_json,created_at)
    VALUES (?,?,?,'artifact.finalized','{}',?)`,
    )
    .run(workspaceId, id, ARTIFACT_RECOVERY_SYSTEM_ID, at);
  return id;
}

/** Synthetic historical parents only; no execution, provider session or launch is created. */
async function parent(db: SqlDatabase, workspaceId = FIX.workspace) {
  if (workspaceId !== FIX.workspace) {
    await db
      .prepare(
        "INSERT INTO projects (workspace_id,id,name,slug,tint,resource_version,created_at) VALUES (?,?,'Audit fixture','audit-fixture','#336699',1,?)",
      )
      .run(workspaceId, FIX.projectA, now);
    await db
      .prepare("INSERT INTO project_access (workspace_id,project_id,human_id) VALUES (?,?,?)")
      .run(workspaceId, FIX.projectA, FIX.owner);
    await db
      .prepare(
        "INSERT INTO agent_profiles (workspace_id,id,name,provider) VALUES (?,?,'Synthetic audit profile','codex')",
      )
      .run(workspaceId, FIX.profileCodex);
  }
  const taskId = randomUlid(),
    runId = randomUlid();
  await db
    .prepare(
      `INSERT INTO tasks
    (workspace_id,id,project_id,title,state,priority,next_owner_type,next_owner_id,punchline,created_by_human_id,created_at)
    VALUES (?,?,?,'Synthetic audit parent','active','P2','human',?,'Synthetic audit parent',?,?)`,
    )
    .run(workspaceId, taskId, FIX.projectA, FIX.owner, FIX.owner, now);
  await db
    .prepare(
      `INSERT INTO runs
    (workspace_id,id,project_id,task_id,requested_by_human_id,agent_profile_id,result_state,activity,created_at)
    VALUES (?,?,?,?,?,?,'open','unknown',?)`,
    )
    .run(workspaceId, runId, FIX.projectA, taskId, FIX.owner, FIX.profileCodex, now);
  return { taskId, runId };
}

try {
  await server.listen();
  const worker = server.getWorker("bfb-work-records-hub");
  await worker.applyD1Migrations("DB");
  const binding = ((await worker.getEnv()) as unknown as { DB: D1Like }).DB;
  const db = observeDatabase(adaptD1(binding)),
    independent = adaptD1(binding);
  await seedSyntheticWorkspace(db, now);
  // B starts outside this Owner's exact restricted-project audience.
  await db
    .prepare("DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?")
    .run(FIX.workspace, FIX.projectB, FIX.owner);
  const ids: string[] = [];
  for (const second of [0, 1, 2, 3])
    ids.push(await receipt(db, `2025-01-01T00:00:0${second}.000Z`));
  const inputs: IssueSecurityAuditPositionInput[] = [];
  const issue: IssueSecurityAuditPosition = async (input) => {
    inputs.push(input);
    const result = await command("a", input);
    assert(result.ok, JSON.stringify(result));
    assert.deepEqual(result.result, { issued: true });
  };
  const page = await readSecurityAudit(db, FIX.workspace, { access, limit: 1 }, issue);
  assert.deepEqual(
    page.entries.map((entry) => entry.audit_id),
    [ids[0]],
  );
  assert(page.has_more && page.next_cursor);
  assert.equal(Buffer.from(page.next_cursor, "base64url").length, 32);
  assert.equal(Buffer.from(page.next_cursor, "base64url").toString("base64url"), page.next_cursor);
  await assert.rejects(
    readSecurityAudit(db, FIX.workspace, { access, limit: 1, after: ids[0]! }, issue),
    denied,
  );
  checks.push("real_d1_registered_hub_issues_canonical_opaque_cursor_and_retires_raw_audit_ids");

  const continuations = await Promise.all(
    ["a", "b"].map((lane) => {
      const handle = createSecurityAuditPosition();
      return command(lane as "a" | "b", {
        positionHash: hashSecurityAuditPosition(handle),
        afterHash: null,
        limit: 1,
      });
    }),
  );
  for (const result of continuations) {
    assert(result.ok, JSON.stringify(result));
    assert.deepEqual(result.result, { issued: true });
  }
  checks.push("two_independent_workers_dispatch_registered_position_issuance_to_production_hub");

  // A backdated insertion after capture cannot enter this chain, but a fresh root sees it.
  const newerBackdated = await receipt(db, "2025-01-01T00:00:00.500Z");
  const second = await readSecurityAudit(
    db,
    FIX.workspace,
    { access, limit: 1, after: page.next_cursor },
    issue,
  );
  assert.deepEqual(
    second.entries.map((entry) => entry.audit_id),
    [ids[1]],
  );
  const reused = await readSecurityAudit(
    db,
    FIX.workspace,
    { access, limit: 1, after: page.next_cursor },
    issue,
  );
  assert.deepEqual(reused.entries, second.entries);
  const fresh = await readSecurityAudit(db, FIX.workspace, { access, limit: 100 }, issue);
  assert.deepEqual(
    fresh.entries.map((entry) => entry.audit_id),
    [ids[0], newerBackdated, ...ids.slice(1)],
  );
  assert.equal(fresh.next_cursor, null);
  checks.push(
    "real_d1_reusable_positions_keep_fixed_capture_ceiling_while_fresh_root_sees_backdated_insert",
  );

  const parentMetadata = await db
    .prepare(
      "SELECT capture_ceiling,expires_at FROM security_audit_positions WHERE position_hash=?",
    )
    .get(hashSecurityAuditPosition(page.next_cursor));
  assert(second.next_cursor);
  assert.deepEqual(
    await db
      .prepare(
        "SELECT capture_ceiling,expires_at FROM security_audit_positions WHERE position_hash=?",
      )
      .get(hashSecurityAuditPosition(second.next_cursor)),
    parentMetadata,
  );
  await assert.rejects(
    db
      .prepare(
        "UPDATE security_audit_positions SET capture_ceiling=capture_ceiling+1 WHERE position_hash=?",
      )
      .run(hashSecurityAuditPosition(page.next_cursor)),
    /immutable/i,
  );
  checks.push("real_d1_descendants_inherit_exact_ceiling_and_expiry_and_positions_are_immutable");

  await independent
    .prepare("INSERT INTO project_access (workspace_id,project_id,human_id) VALUES (?,?,?)")
    .run(FIX.workspace, FIX.projectB, FIX.owner);
  await assert.rejects(
    readSecurityAudit(db, FIX.workspace, { access, limit: 1, after: page.next_cursor }, issue),
    denied,
  );
  await independent
    .prepare("DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?")
    .run(FIX.workspace, FIX.projectB, FIX.owner);
  checks.push("real_d1_same_epoch_audience_expansion_invalidates_a_genuine_position");

  // Retained expired metadata is fixture-only; expiry denial must not require deleting history.
  const expiredHandle = createSecurityAuditPosition();
  await db
    .prepare(
      `INSERT INTO security_audit_positions
    (position_hash,workspace_id,human_id,authorization_epoch,projection_version,page_limit,audience_json,after_hash,
     capture_ceiling,expires_at,anchor_audit_id,anchor_sort_key,anchor_rowid,created_at)
    SELECT ?,workspace_id,human_id,authorization_epoch,projection_version,page_limit,audience_json,after_hash,
      capture_ceiling,'2000-01-01T00:10:00.000Z',anchor_audit_id,anchor_sort_key,anchor_rowid,'2000-01-01T00:00:00.000Z'
    FROM security_audit_positions WHERE position_hash=?`,
    )
    .run(hashSecurityAuditPosition(expiredHandle), hashSecurityAuditPosition(page.next_cursor));
  await assert.rejects(
    readSecurityAudit(db, FIX.workspace, { access, limit: 1, after: expiredHandle }, issue),
    denied,
  );
  await db
    .prepare("UPDATE workspace_members SET role='owner' WHERE workspace_id=? AND human_id=?")
    .run(FIX.workspace, FIX.member);
  await assert.rejects(
    readSecurityAudit(
      db,
      FIX.workspace,
      { access: { ...access, humanId: FIX.member }, limit: 1, after: page.next_cursor },
      issue,
    ),
    denied,
  );
  await db
    .prepare("UPDATE workspace_members SET role='member' WHERE workspace_id=? AND human_id=?")
    .run(FIX.workspace, FIX.member);
  checks.push("real_d1_retained_expired_and_foreign_owner_positions_have_uniform_denial");

  const retryInput = {
    positionHash: hashSecurityAuditPosition(createSecurityAuditPosition()),
    afterHash: null,
    limit: 1,
  };
  const retryKey = randomUlid();
  const initial = await command("a", retryInput, retryKey);
  assert(initial.ok);
  const retry = await command("b", retryInput, retryKey);
  assert(!retry.ok && retry.error.code === "request_rejected");
  checks.push("real_hub_cross_isolate_issuance_retry_never_replays_cached_success");

  await assert.rejects(
    readSecurityAudit(db, FIX.workspace, { access, limit: 2, after: page.next_cursor }, issue),
    denied,
  );
  await assert.rejects(
    readSecurityAudit(
      db,
      FIX.workspace,
      { access, limit: 1, after: createSecurityAuditPosition() },
      issue,
    ),
    denied,
  );
  for (const table of [
    "audit_events",
    "semantic_events",
    "outbox_records",
    "idempotency_records",
  ]) {
    const rows = JSON.stringify(
      await db.prepare(`SELECT * FROM ${table} WHERE workspace_id=?`).all(FIX.workspace),
    );
    for (const plaintext of [page.next_cursor, second.next_cursor, reused.next_cursor])
      if (plaintext)
        assert(!rows.includes(plaintext), `${table} must not retain a plaintext position`);
  }
  assert(!JSON.stringify(inputs).includes(page.next_cursor));
  checks.push("real_d1_limit_unknown_position_denial_and_hash_only_hub_persistence");

  const snapshot = async (workspaceId = FIX.workspace) => {
    const result: Record<string, unknown> = {};
    for (const table of [
      "security_audit_positions",
      "workspace_cursors",
      "audit_events",
      "semantic_events",
      "outbox_records",
      "idempotency_records",
    ])
      result[table] = await db
        .prepare(`SELECT * FROM ${table} WHERE workspace_id=? ORDER BY rowid`)
        .all(workspaceId);
    result.security_audit_position_guards = await db
      .prepare("SELECT * FROM security_audit_position_guards ORDER BY id")
      .all();
    return result;
  };
  // Real D1 evaluates queued writes after this independent mutation, not at preflight time.
  for (const race of ["audience", "epoch"] as const) {
    const before = await snapshot();
    let fired = false;
    const raced = adaptD1({
      prepare: (query) => binding.prepare(query),
      async batch(statements) {
        fired = true;
        if (race === "audience")
          await independent
            .prepare("INSERT INTO project_access (workspace_id,project_id,human_id) VALUES (?,?,?)")
            .run(FIX.workspace, FIX.projectB, FIX.owner);
        if (race === "epoch")
          await independent
            .prepare(
              "UPDATE workspace_authorization_epochs SET revoked_at=? WHERE workspace_id=? AND human_id=?",
            )
            .run(now, FIX.workspace, FIX.owner);
        return binding.batch(statements);
      },
    });
    const outcome = await new WorkspaceHub(observeDatabase(raced)).execute(
      issueSecurityAuditPositionCommand,
      {
        workspaceId: FIX.workspace,
        actorHumanId: FIX.owner,
        authorizationEpoch: 1,
        idempotencyKey: randomUlid(),
        input: {
          positionHash: hashSecurityAuditPosition(createSecurityAuditPosition()),
          afterHash: null,
          limit: 1,
        },
      },
    );
    assert(fired && !outcome.ok, `${race} race must reach and abort the real D1 batch`);
    if (race === "audience")
      await independent
        .prepare("DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?")
        .run(FIX.workspace, FIX.projectB, FIX.owner);
    if (race === "epoch")
      await independent
        .prepare(
          "UPDATE workspace_authorization_epochs SET revoked_at=NULL WHERE workspace_id=? AND human_id=?",
        )
        .run(FIX.workspace, FIX.owner);
    assert.deepEqual(
      await snapshot(),
      before,
      `${race} must roll back position and all Hub bookkeeping`,
    );
    checks.push(`real_d1_${race}_prebatch_loss_rolls_back_position_and_hub_bookkeeping`);
  }

  // Only the non-anchor A and lookahead C disappear; the final delivered cut stays B.
  const isolatedWorkspace = randomUlid();
  await db
    .prepare(
      "INSERT INTO workspaces (id,slug,jurisdiction,created_at) VALUES (?,'audit-cut-fixture','eu',?)",
    )
    .run(isolatedWorkspace, now);
  await db
    .prepare(
      "INSERT INTO workspace_members (workspace_id,human_id,role,authorization_epoch,created_at) VALUES (?,?,'owner',1,?)",
    )
    .run(isolatedWorkspace, FIX.owner, now);
  await db
    .prepare(
      "INSERT INTO workspace_authorization_epochs (workspace_id,human_id,authorization_epoch,revoked_at,updated_at) VALUES (?,?,1,NULL,?)",
    )
    .run(isolatedWorkspace, FIX.owner, now);
  const cutIds: string[] = [];
  const cutParent = await parent(db, isolatedWorkspace);
  for (const second of [0, 1, 2])
    cutIds.push(
      await receipt(
        db,
        `2025-01-01T00:00:0${second}.000Z`,
        isolatedWorkspace,
        second === 1 ? null : cutParent.runId,
      ),
    );
  const beforeNonAnchor = await snapshot(isolatedWorkspace);
  let nonAnchorChanged = false;
  const nonAnchorDb = adaptD1({
    prepare: (query) => binding.prepare(query),
    async batch(statements) {
      nonAnchorChanged = true;
      await independent
        .prepare(
          "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
        )
        .run(isolatedWorkspace, cutParent.taskId, FIX.owner, now);
      return binding.batch(statements);
    },
  });
  const nonAnchorResult = await new WorkspaceHub(observeDatabase(nonAnchorDb)).execute(
    issueSecurityAuditPositionCommand,
    {
      workspaceId: isolatedWorkspace,
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      input: {
        positionHash: hashSecurityAuditPosition(createSecurityAuditPosition()),
        afterHash: null,
        limit: 2,
      },
    },
  );
  assert(nonAnchorChanged && !nonAnchorResult.ok);
  const unchangedCut = await readSecurityAudit(db, isolatedWorkspace, {
    access: { ...access, workspaceId: isolatedWorkspace },
    limit: 2,
  });
  assert.deepEqual(
    unchangedCut.entries.map((entry) => entry.audit_id),
    [cutIds[1]],
  );
  assert.equal(unchangedCut.next_cursor, null);
  assert.deepEqual(await snapshot(isolatedWorkspace), beforeNonAnchor);
  checks.push(
    "real_d1_nonanchor_and_lookahead_parent_privatization_aborts_issuance_even_when_delivered_cut_is_unchanged",
  );

  const finalParent = await parent(db);
  await receipt(db, "1999-01-01T00:00:00.000Z", FIX.workspace, finalParent.runId);
  const historyBefore = await db
    .prepare(
      "SELECT * FROM audit_events WHERE workspace_id=? AND action='artifact.finalized' ORDER BY rowid",
    )
    .all(FIX.workspace);
  let finalCutChanged = false;
  await assert.rejects(
    readSecurityAudit(db, FIX.workspace, { access, limit: 1 }, async (input) => {
      await issue(input);
      await independent
        .prepare(
          "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
        )
        .run(FIX.workspace, finalParent.taskId, FIX.owner, now);
      finalCutChanged = true;
    }),
    denied,
  );
  assert(finalCutChanged);
  assert.deepEqual(
    await db
      .prepare(
        "SELECT * FROM audit_events WHERE workspace_id=? AND action='artifact.finalized' ORDER BY rowid",
      )
      .all(FIX.workspace),
    historyBefore,
  );
  checks.push(
    "real_d1_final_page_cut_mismatch_denies_without_delivering_the_issued_handle_or_rewriting_history",
  );

  console.log(
    JSON.stringify({
      schema_version: 1,
      checks,
      maximum_bindings: maximumBindings,
      maximum_statement_bytes: maximumStatementBytes,
      outcome: "passed",
      limits: [
        "synthetic D1/Hub acceptance only",
        "no live pilot, provider, deployment or private activation",
        "security audit positions only; broader event/realtime and natural credential expiry remain open",
      ],
    }),
  );
  console.log("C11_SECURITY_AUDIT_POSITIONS_D1_OK");
} finally {
  await server.close();
}
