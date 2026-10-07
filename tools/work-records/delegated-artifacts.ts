// ABOUTME: Proves delegated artifact commit guards against disposable real D1 and the production Hub.
// ABOUTME: Genuine upload bookkeeping and independent authority changes never operate providers or artifact bytes.

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  adaptD1,
  loadMigrationManifest,
  type D1Like,
  type D1StatementLike,
  type SqlDatabase,
} from "@bfb/db";
import {
  FIX,
  WorkspaceHub,
  artifactHash,
  artifactObjectKey,
  bumpMemberEpoch,
  createDelegatedArtifactCommand,
  finalizeDelegatedArtifactCommand,
  loadPrincipal,
  mintUploadGrantSecret,
  randomUlid,
  recordVerifiedUpload,
  redeemUploadGrant,
  seedSyntheticWorkspace,
  type CommandOutcome,
  type CommandRequest,
  type CreateDelegatedArtifactInput,
  type CreateDelegatedArtifactResult,
  type FinalizeDelegatedArtifactResult,
  type TaskRecord,
} from "@bfb/domain";
import { createTestHarness } from "wrangler";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const origin = "https://bfb.delegated-artifacts.test";
const body = "SYNTHETIC-C11-DELEGATED-ARTIFACT-BYTES";
const taskCanary = "SYNTHETIC-C11-DELEGATED-ARTIFACT-TASK";
const digest = artifactHash(body);
const size = Buffer.byteLength(body);
const historicalRequestTime = "2025-01-01T00:00:00.000Z";
const server = createTestHarness({
  root,
  workers: [
    { configPath: "tools/work-records/wrangler-a.toml" },
    { configPath: "tools/work-records/wrangler-b.toml" },
    { configPath: "tools/work-records/wrangler-hub.toml" },
  ],
});
const checks: string[] = [];
const failures: Array<{ check: string; message: string }> = [];
const bounds = { maximum_bindings: 0, maximum_statement_bytes: 0, maximum_batch_statements: 0 };

function success<T>(outcome: CommandOutcome<T>): T {
  assert(outcome.ok, outcome.ok ? undefined : outcome.error.code);
  return outcome.result;
}

async function check(name: string, run: () => Promise<void>) {
  try {
    await run();
    checks.push(name);
    console.log(JSON.stringify({ check: name, outcome: "passed" }));
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : "assertion failed";
    failures.push({ check: name, message: (message ?? "assertion failed").slice(0, 160) });
    console.log(JSON.stringify({ check: name, outcome: "failed" }));
  }
}

async function execute<T>(name: string, request: CommandRequest<unknown>, worker = "a") {
  const response = await server
    .getWorker(`bfb-work-records-${worker}`)
    .fetch(`${origin}/workspaces/${FIX.workspace}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandName: name, request }),
    });
  assert.equal(response.status, 200);
  return (await response.json()) as CommandOutcome<T>;
}

function atBatch(
  binding: D1Like,
  before: () => Promise<void>,
): { db: SqlDatabase; reached: () => boolean; observedAt: () => string } {
  let reached = false,
    observedAt = "";
  const db = adaptD1({
    prepare(sql) {
      const bytes = Buffer.byteLength(sql);
      bounds.maximum_statement_bytes = Math.max(bounds.maximum_statement_bytes, bytes);
      assert(bytes <= 100_000, "artifact SQL must fit D1's statement bound");
      const native = binding.prepare(sql);
      const statement: D1StatementLike = {
        bind(...parameters) {
          bounds.maximum_bindings = Math.max(bounds.maximum_bindings, parameters.length);
          assert(parameters.length <= 100, "artifact SQL must fit D1's parameter bound");
          if (sql.includes("UPDATE artifact_versions") && sql.includes("available_at")) {
            assert.equal(typeof parameters[2], "string");
            observedAt = parameters[2] as string;
          }
          // D1 batch must receive native bound statements, not adapter wrappers.
          return native.bind(...parameters);
        },
        first: (column) => native.first(column),
        all: () => native.all(),
        run: () => native.run(),
      };
      return statement;
    },
    async batch(statements) {
      assert.equal(reached, false, "one command must flush one atomic batch");
      reached = true;
      bounds.maximum_batch_statements = Math.max(
        bounds.maximum_batch_statements,
        statements.length,
      );
      assert(statements.length <= 32, "artifact command must retain a bounded batch");
      await before();
      return binding.batch(statements);
    },
  });
  return { db, reached: () => reached, observedAt: () => observedAt };
}

try {
  await server.listen();
  const worker = server.getWorker("bfb-work-records-hub");
  await worker.applyD1Migrations("DB");
  const binding = ((await worker.getEnv()) as unknown as { DB: D1Like }).DB;
  const db = adaptD1(binding),
    independent = adaptD1(binding);
  const manifest = loadMigrationManifest(resolve(root, "migrations/d1"));
  await seedSyntheticWorkspace(db, new Date().toISOString());

  async function effects() {
    const rows: Record<string, unknown[]> = {};
    for (const table of [
      "artifacts",
      "artifact_versions",
      "artifact_upload_grants",
      "artifact_upload_consumptions",
      "artifact_upload_receipts",
      "artifact_upload_receipt_sources",
      "artifact_objects",
      "artifact_audit_outbox",
      "idempotency_records",
      "semantic_events",
      "audit_events",
      "outbox_records",
      "workspace_cursors",
      "tasks",
      "runs",
    ])
      rows[table] = await db
        .prepare(`SELECT * FROM ${table} WHERE workspace_id=? ORDER BY rowid`)
        .all(FIX.workspace);
    for (const table of ["artifact_mutation_guards", "runner_mutation_guards"])
      rows[table] = await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
    return rows;
  }

  async function fixture(expiryModifier = "+1 hour") {
    const request = {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.member,
      authorizationEpoch: 1,
    };
    const task = success(
      await execute<TaskRecord>("task.create", {
        ...request,
        idempotencyKey: randomUlid(),
        input: { projectId: FIX.projectA, title: taskCanary, priority: "P2" },
      }),
    );
    const otherTask = success(
      await execute<TaskRecord>("task.create", {
        ...request,
        idempotencyKey: randomUlid(),
        input: {
          projectId: FIX.projectA,
          title: "Synthetic unrelated artifact task",
          priority: "P2",
        },
      }),
    );
    const run = success(
      await execute<{ run: { id: string } }>("run.create", {
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
    const principal = await loadPrincipal(db, FIX.workspace, FIX.owner);
    const clock = (await db
      .prepare(
        `SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS observed_at,
          strftime('%Y-%m-%dT%H:%M:%fZ','now',?) AS expires_at`,
      )
      .get(expiryModifier)) as { observed_at: string; expires_at: string };
    const delegationId = randomUlid(),
      grantId = randomUlid();
    // Synthetic dormant privacy policy: creation/sharing APIs remain disabled.
    await db
      .prepare(
        "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
      )
      .run(FIX.workspace, task.id, FIX.member, clock.observed_at);
    await db
      .prepare(
        `INSERT INTO task_human_grants
        (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at)
        VALUES (?,?,?,?,?,'contribute',?)`,
      )
      .run(
        FIX.workspace,
        grantId,
        task.id,
        FIX.owner,
        principal.authorizationEpoch,
        clock.observed_at,
      );
    await db
      .prepare(
        `INSERT INTO oauth_delegations
        (workspace_id,id,human_id,client_id,resource,project_id,task_id,scopes_json,
         authorization_epoch,expires_at,created_at)
        VALUES (?,?,?,?,'https://bfb.delegated-artifacts.test/mcp',?,?,?,?,?,?)`,
      )
      .run(
        FIX.workspace,
        delegationId,
        FIX.owner,
        FIX.client,
        FIX.projectA,
        task.id,
        JSON.stringify(["bfb:task:write"]),
        principal.authorizationEpoch,
        clock.expires_at,
        clock.observed_at,
      );
    return {
      taskId: task.id,
      otherTaskId: otherTask.id,
      runId: run.run.id,
      delegationId,
      grantId,
      epoch: principal.authorizationEpoch,
      ...clock,
    };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  function request<I>(f: Fixture, input: I, key = randomUlid()): CommandRequest<I> {
    return {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.owner,
      actorDelegationId: f.delegationId,
      authorizationEpoch: f.epoch,
      idempotencyKey: key,
      now: historicalRequestTime,
      input,
    };
  }

  function publication(f: Fixture, artifactId?: string) {
    const secret = mintUploadGrantSecret();
    const input: CreateDelegatedArtifactInput = {
      runId: f.runId,
      format: "markdown",
      role: "review",
      declaredSize: size,
      expectedDigest: digest,
      grantSecretHash: secret.secretHash,
      ...(artifactId ? { artifactId } : {}),
    };
    return { secret, input };
  }

  async function createUpload(f: Fixture, artifactId?: string) {
    const p = publication(f, artifactId),
      operation = request(f, p.input);
    const created = success(
      await execute<CreateDelegatedArtifactResult>(createDelegatedArtifactCommand.name, operation),
    );
    assert.equal(created.state, "uploading");
    assert.equal(created.format, "markdown");
    assert.equal(created.role, "review");
    assert.equal(created.expected_digest, digest);
    assert.equal(created.declared_size, size);
    assert.equal(created.upload_grant.grant_hash, p.secret.secretHash);
    return { ...p, created, operation };
  }

  async function metadataOnly(secret: string) {
    for (const [table, column] of [
      ["semantic_events", "kind"],
      ["audit_events", "action"],
      ["outbox_records", "kind"],
    ] as const) {
      const rows = await db
        .prepare(`SELECT payload_json FROM ${table} WHERE workspace_id=? AND ${column} IN (?,?)`)
        .all(
          FIX.workspace,
          createDelegatedArtifactCommand.name,
          finalizeDelegatedArtifactCommand.name,
        );
      const json = JSON.stringify(rows);
      assert(!json.includes(secret));
      assert(!json.includes(body));
      assert(!json.includes(taskCanary));
      for (const row of rows as Array<{ payload_json: string }>) {
        const payload = JSON.parse(row.payload_json) as { input: { action: string } };
        assert.deepEqual(Object.keys(payload.input), ["action"]);
      }
    }
    for (const table of ["artifact_audit_outbox", "idempotency_records"]) {
      const json = JSON.stringify(
        await db.prepare(`SELECT * FROM ${table} WHERE workspace_id=?`).all(FIX.workspace),
      );
      assert(!json.includes(secret));
      assert(!json.includes(body));
    }
  }

  async function verifiedUpload(f: Fixture) {
    const upload = await createUpload(f);
    const now = new Date().toISOString();
    const consumed = await db.withTransaction((tx) =>
      redeemUploadGrant(tx, {
        grantId: upload.created.upload_grant.grant_id,
        secret: upload.secret.secret,
        now,
      }),
    );
    const verified = await db.withTransaction((tx) =>
      recordVerifiedUpload(tx, {
        grantId: consumed.grantId,
        consumeAttemptId: consumed.consumeAttemptId,
        contentHash: digest,
        size,
        now,
      }),
    );
    assert.equal(
      verified.r2Key,
      artifactObjectKey({
        workspaceId: FIX.workspace,
        role: "review",
        runId: f.runId,
        versionId: upload.created.version_id,
        contentHash: digest,
      }),
    );
    const lineage = await db
      .prepare(
        `SELECT g.run_id,g.format,g.human_id,g.authorization_epoch,
          version.artifact_id,version.state,version.format AS version_format,
          version.expected_digest,version.declared_size,artifact.role,
          artifact.run_id AS artifact_run_id,
          c.attempt_id,receipt.content_hash,receipt.size,object.r2_key,
          object.content_hash AS object_hash,object.size AS object_size,
          source.grant_id,source.outbox_id,outbox.action
        FROM artifact_upload_receipts AS receipt
        JOIN artifact_versions AS version
          ON version.workspace_id=receipt.workspace_id AND version.id=receipt.version_id
        JOIN artifacts AS artifact
          ON artifact.workspace_id=version.workspace_id AND artifact.id=version.artifact_id
        JOIN artifact_upload_receipt_sources AS source
          ON source.workspace_id=receipt.workspace_id AND source.version_id=receipt.version_id
        JOIN artifact_upload_grants AS g
          ON g.workspace_id=source.workspace_id AND g.id=source.grant_id AND g.version_id=receipt.version_id
        JOIN artifact_upload_consumptions AS c
          ON c.workspace_id=g.workspace_id AND c.grant_id=g.id AND c.attempt_id=source.attempt_id
            AND c.consumed_at=g.consumed_at
        JOIN artifact_objects AS object
          ON object.workspace_id=receipt.workspace_id AND object.r2_key=?
        JOIN artifact_audit_outbox AS outbox
          ON outbox.workspace_id=source.workspace_id AND outbox.id=source.outbox_id
            AND outbox.version_id=receipt.version_id AND outbox.grant_id=g.id
        WHERE receipt.workspace_id=? AND receipt.version_id=?`,
      )
      .get(verified.r2Key, FIX.workspace, upload.created.version_id);
    assert.deepEqual(lineage, {
      run_id: f.runId,
      format: "markdown",
      human_id: FIX.owner,
      authorization_epoch: f.epoch,
      artifact_id: upload.created.artifact_id,
      state: "uploading",
      version_format: "markdown",
      expected_digest: digest,
      declared_size: size,
      role: "review",
      artifact_run_id: f.runId,
      attempt_id: consumed.consumeAttemptId,
      content_hash: digest,
      size,
      r2_key: verified.r2Key,
      object_hash: digest,
      object_size: size,
      grant_id: consumed.grantId,
      outbox_id: (lineage as { outbox_id: string }).outbox_id,
      action: "artifact.upload_verified",
    });
    await metadataOnly(upload.secret.secret);
    return { ...upload, verified };
  }

  function finalization(upload: Awaited<ReturnType<typeof verifiedUpload>>) {
    return { versionId: upload.created.version_id, contentHash: digest, size };
  }

  await check("real_d1_new_delegated_artifact_write_only_scope_and_replay_rejection", async () => {
    const f = await fixture(),
      before = await effects(),
      upload = await createUpload(f),
      after = await effects();
    assert.equal(after.artifacts!.length, before.artifacts!.length + 1);
    assert.equal(after.artifact_versions!.length, before.artifact_versions!.length + 1);
    assert.equal(after.artifact_upload_grants!.length, before.artifact_upload_grants!.length + 1);
    assert.deepEqual(await execute(createDelegatedArtifactCommand.name, upload.operation), {
      ok: false,
      error: { code: "request_rejected", message: "request rejected" },
    });
    assert.deepEqual(await effects(), after);
    await metadataOnly(upload.secret.secret);
  });

  await check("real_d1_existing_logical_artifact_gets_one_exact_new_version", async () => {
    const f = await fixture(),
      first = await createUpload(f),
      before = await effects(),
      second = await createUpload(f, first.created.artifact_id),
      after = await effects();
    assert.equal(second.created.artifact_id, first.created.artifact_id);
    assert.notEqual(second.created.version_id, first.created.version_id);
    assert.deepEqual(after.artifacts, before.artifacts);
    assert.equal(after.artifact_versions!.length, before.artifact_versions!.length + 1);
    assert.deepEqual(
      await db
        .prepare("SELECT run_id,format,role FROM artifacts WHERE workspace_id=? AND id=?")
        .get(FIX.workspace, first.created.artifact_id),
      { run_id: f.runId, format: "markdown", role: "review" },
    );
    await metadataOnly(second.secret.secret);
  });

  await check(
    "real_d1_genuine_receipt_object_backed_finalization_rejects_completed_key",
    async () => {
      const f = await fixture(),
        upload = await verifiedUpload(f),
        operation = request(f, finalization(upload));
      const result = success(
        await execute<FinalizeDelegatedArtifactResult>(
          finalizeDelegatedArtifactCommand.name,
          operation,
        ),
      );
      assert.equal(result.state, "available");
      assert.equal(result.r2_key, upload.verified.r2Key);
      assert.equal(result.content_hash, digest);
      const after = await effects();
      assert.deepEqual(await execute(finalizeDelegatedArtifactCommand.name, operation), {
        ok: false,
        error: { code: "request_rejected", message: "request rejected" },
      });
      assert.deepEqual(await effects(), after);
      await metadataOnly(upload.secret.secret);
    },
  );

  async function replaceContribution(f: Fixture, permission: "read" | "contribute", oldId: string) {
    const now = new Date().toISOString(),
      id = randomUlid();
    await independent
      .prepare("UPDATE task_human_grants SET revoked_at=? WHERE workspace_id=? AND id=?")
      .run(now, FIX.workspace, oldId);
    await independent
      .prepare(
        `INSERT INTO task_human_grants
      (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at)
      VALUES (?,?,?,?,?,?,?)`,
      )
      .run(FIX.workspace, id, f.taskId, FIX.owner, f.epoch, permission, now);
    return id;
  }

  const losses = [
    "revocation",
    "epoch",
    "contribution",
    "project",
    "write_scope",
    "boundary",
  ] as const;
  type Loss = (typeof losses)[number];
  async function loseAuthority(f: Fixture, loss: Loss) {
    const now = new Date().toISOString();
    if (loss === "revocation")
      await independent
        .prepare("UPDATE oauth_delegations SET revoked_at=? WHERE workspace_id=? AND id=?")
        .run(now, FIX.workspace, f.delegationId);
    if (loss === "epoch") await bumpMemberEpoch(independent, FIX.workspace, FIX.owner);
    if (loss === "contribution") await replaceContribution(f, "read", f.grantId);
    if (loss === "project") {
      await independent
        .prepare("UPDATE projects SET access_mode='restricted' WHERE workspace_id=? AND id=?")
        .run(FIX.workspace, FIX.projectA);
      await independent
        .prepare("DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?")
        .run(FIX.workspace, FIX.projectA, FIX.owner);
    }
    if (loss === "write_scope")
      await independent
        .prepare("UPDATE oauth_delegations SET scopes_json=? WHERE workspace_id=? AND id=?")
        .run(JSON.stringify(["bfb:read"]), FIX.workspace, f.delegationId);
    if (loss === "boundary")
      await independent
        .prepare("UPDATE oauth_delegations SET task_id=? WHERE workspace_id=? AND id=?")
        .run(f.otherTaskId, FIX.workspace, f.delegationId);
  }

  for (const loss of losses) {
    await check(`real_d1_create_${loss}_before_batch_rolls_back_all_effects`, async () => {
      const f = await fixture(),
        p = publication(f),
        operation = request(f, p.input);
      let before: Awaited<ReturnType<typeof effects>> | undefined;
      const guarded = atBatch(binding, async () => {
        await loseAuthority(f, loss);
        before = await effects();
      });
      try {
        const outcome = await new WorkspaceHub(guarded.db).execute(
          createDelegatedArtifactCommand,
          operation,
        );
        assert(guarded.reached(), "valid admitted creation must reach the real batch");
        assert.deepEqual(outcome, {
          ok: false,
          error: { code: "command_failed", message: "command failed" },
        });
        assert.deepEqual(await effects(), before);
      } finally {
        if (loss === "project")
          await independent
            .prepare("UPDATE projects SET access_mode='workspace' WHERE workspace_id=? AND id=?")
            .run(FIX.workspace, FIX.projectA);
      }
    });
  }

  for (const loss of ["revocation", "contribution"] as const) {
    await check(`real_d1_finalize_${loss}_before_batch_rolls_back_all_effects`, async () => {
      const f = await fixture(),
        upload = await verifiedUpload(f);
      let before: Awaited<ReturnType<typeof effects>> | undefined;
      const guarded = atBatch(binding, async () => {
        await loseAuthority(f, loss);
        before = await effects();
      });
      const outcome = await new WorkspaceHub(guarded.db).execute(
        finalizeDelegatedArtifactCommand,
        request(f, finalization(upload)),
      );
      assert(guarded.reached(), "valid admitted finalization must reach the real batch");
      assert.deepEqual(outcome, {
        ok: false,
        error: { code: "command_failed", message: "command failed" },
      });
      assert.deepEqual(await effects(), before);
    });
  }

  await check("real_d1_competing_hub_finalization_cannot_commit_a_second_receipt", async () => {
    const f = await fixture(),
      upload = await verifiedUpload(f);
    let winner: Awaited<ReturnType<typeof effects>> | undefined;
    const guarded = atBatch(binding, async () => {
      const result = success(
        await execute<FinalizeDelegatedArtifactResult>(
          finalizeDelegatedArtifactCommand.name,
          request(f, finalization(upload)),
          "b",
        ),
      );
      assert.equal(result.state, "available");
      assert.equal(result.r2_key, upload.verified.r2Key);
      winner = await effects();
    });
    const loser = await new WorkspaceHub(guarded.db).execute(
      finalizeDelegatedArtifactCommand,
      request(f, finalization(upload)),
    );
    assert(guarded.reached());
    assert.deepEqual(loser, {
      ok: false,
      error: { code: "command_failed", message: "command failed" },
    });
    assert.deepEqual(await effects(), winner);
    assert.deepEqual(
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM artifact_audit_outbox WHERE workspace_id=? AND version_id=? AND action='artifact.finalized'",
        )
        .get(FIX.workspace, upload.created.version_id),
      { n: 1 },
    );
    await metadataOnly(upload.secret.secret);
  });

  await check(
    "real_d1_failed_creation_key_retries_after_valid_new_contribution_grant",
    async () => {
      const f = await fixture(),
        p = publication(f),
        operation = request(f, p.input);
      let readGrant = "",
        before: Awaited<ReturnType<typeof effects>> | undefined;
      const guarded = atBatch(binding, async () => {
        readGrant = await replaceContribution(f, "read", f.grantId);
        before = await effects();
      });
      const failure = await new WorkspaceHub(guarded.db).execute(
        createDelegatedArtifactCommand,
        operation,
      );
      assert(guarded.reached());
      assert.deepEqual(failure, {
        ok: false,
        error: { code: "command_failed", message: "command failed" },
      });
      assert.deepEqual(await effects(), before);
      await replaceContribution(f, "contribute", readGrant);
      const retried = await execute<CreateDelegatedArtifactResult>(
        createDelegatedArtifactCommand.name,
        operation,
      );
      assert(retried.ok, retried.ok ? undefined : retried.error.code);
      assert.equal(retried.replayed, false);
      assert.deepEqual(
        await db
          .prepare(
            "SELECT COUNT(*) AS n FROM idempotency_records WHERE workspace_id=? AND idempotency_key=?",
          )
          .get(FIX.workspace, operation.idempotencyKey),
        { n: 1 },
      );
      await metadataOnly(p.secret.secret);
    },
  );

  for (const mode of ["unexpired", "natural_expiry"] as const) {
    await check(`real_d1_unchanged_delegation_${mode}_at_finalization_batch`, async () => {
      const f = await fixture(mode === "natural_expiry" ? "+15 seconds" : "+1 hour"),
        upload = await verifiedUpload(f),
        operation = request(f, finalization(upload)),
        before = await effects();
      const readCredential = () =>
        db
          .prepare("SELECT * FROM oauth_delegations WHERE workspace_id=? AND id=?")
          .get(FIX.workspace, f.delegationId);
      const original = await readCredential();
      const witness = async () =>
        (await db
          .prepare(
            `SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS database_now,
          julianday(expires_at)>julianday('now') AS live
        FROM oauth_delegations WHERE workspace_id=? AND id=?`,
          )
          .get(FIX.workspace, f.delegationId)) as { database_now: string; live: number };
      let arrivalLive = false,
        flushLive = false,
        flushAt = "";
      const guarded = atBatch(binding, async () => {
        arrivalLive = (await witness()).live === 1;
        assert(arrivalLive, "unchanged credential must reach the batch while valid");
        assert(Date.parse(guarded.observedAt()) < Date.parse(f.expires_at));
        if (mode === "natural_expiry") {
          const deadline = performance.now() + 20_000;
          while ((await witness()).live === 1) {
            assert(
              performance.now() < deadline,
              "unchanged credential must expire in bounded time",
            );
            await delay(100);
          }
        } else await delay(250);
        const flush = await witness();
        flushLive = flush.live === 1;
        flushAt = flush.database_now;
        assert.equal(flushLive, mode === "unexpired");
        assert.deepEqual(await readCredential(), original);
      });
      const started = Date.now();
      const outcome = await new WorkspaceHub(guarded.db).execute(
        finalizeDelegatedArtifactCommand,
        operation,
      );
      assert(guarded.reached());
      assert(arrivalLive);
      assert(Date.parse(guarded.observedAt()) >= started);
      assert.deepEqual(await readCredential(), original);
      if (mode === "natural_expiry") {
        assert(Date.parse(flushAt) >= Date.parse(f.expires_at));
        assert.deepEqual(outcome, {
          ok: false,
          error: { code: "command_failed", message: "command failed" },
        });
        assert.deepEqual(await effects(), before);
      } else {
        const result = success(outcome);
        assert.equal(outcome.ok && outcome.replayed, false);
        assert.equal(result.available_at, guarded.observedAt());
        assert.equal(result.r2_key, upload.verified.r2Key);
        assert(Date.parse(flushAt) - Date.parse(guarded.observedAt()) >= 200);
        assert.deepEqual(
          await db
            .prepare("SELECT available_at FROM artifact_versions WHERE workspace_id=? AND id=?")
            .get(FIX.workspace, upload.created.version_id),
          { available_at: guarded.observedAt() },
        );
        for (const [table, field] of [
          ["semantic_events", "kind"],
          ["audit_events", "action"],
          ["outbox_records", "kind"],
        ] as const)
          assert.deepEqual(
            await db
              .prepare(
                `SELECT created_at FROM ${table} WHERE workspace_id=? AND ${field}=? ORDER BY rowid DESC LIMIT 1`,
              )
              .get(FIX.workspace, finalizeDelegatedArtifactCommand.name),
            { created_at: guarded.observedAt() },
          );
        assert.deepEqual(
          await db
            .prepare(
              "SELECT created_at FROM idempotency_records WHERE workspace_id=? AND idempotency_key=?",
            )
            .get(FIX.workspace, operation.idempotencyKey),
          { created_at: guarded.observedAt() },
        );
        await metadataOnly(upload.secret.secret);
      }
    });
  }

  console.log(
    JSON.stringify({
      schema_version: 1,
      stage: "delegated_artifact_commit_authority",
      migration_head: manifest.migration_head,
      checks,
      failures,
      ...bounds,
      outcome: failures.length ? "failed" : "passed",
      limits: [
        "synthetic dormant policies only; private creation remains disabled",
        "real D1/domain/Hub proof, not authenticated HTTP OAuth or live R2 bytes",
        "command-local commit guards, not every later statement or response delivery",
        "no runner/lease/provider execution or complete C11 activation proof",
      ],
    }),
  );
  assert.equal(failures.length, 0, "delegated artifact D1 checks failed");
  console.log("C11_DELEGATED_ARTIFACT_D1_OK");
} finally {
  await server.close();
}
