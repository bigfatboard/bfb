// ABOUTME: Exercises delegated attention read delivery through genuine OAuth MCP and disposable real D1.
// ABOUTME: Witnessed post-selection changes preserve business history without running providers or runners.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  activateDelegationGrant,
  bindProviderAccessToken,
  bumpMemberEpoch,
  decideDelegationGrant,
  issueStepUpProof,
  loadPrincipal,
  mcpResource,
  prepareDelegationGrant,
  randomUlid,
  revokeDelegation,
  seedSyntheticWorkspace,
  type AttentionRecord,
  type CommandOutcome,
  type CommandRequest,
  type TaskRecord,
} from "@bfb/domain";
import { createTestHarness } from "wrangler";
import { handleMcpRequest } from "../../apps/control-worker/dist/mcp/handler.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const origin = "https://bfb.example.test";
const canary = "SYNTHETIC-C11-ATTENTION-DELIVERY";
const question = `${canary}-QUESTION`,
  answer = `${canary}-ANSWER`;
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
const bounds = { maximum_bindings: 0, maximum_statement_bytes: 0 };

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
    const first = error instanceof Error ? error.message.split("\n")[0] : "assertion failed";
    failures.push({
      check: name,
      message: first?.includes(canary)
        ? "synthetic content omitted"
        : (first ?? "assertion failed").slice(0, 160),
    });
    console.log(JSON.stringify({ check: name, outcome: "failed" }));
  }
}
async function execute<T>(name: string, request: CommandRequest<unknown>) {
  const response = await server
    .getWorker("bfb-work-records-a")
    .fetch(`${origin}/workspaces/${FIX.workspace}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandName: name, request }),
    });
  assert.equal(response.status, 200);
  return (await response.json()) as CommandOutcome<T>;
}
function afterAttentionRead(
  binding: D1Like,
  after: () => Promise<void>,
  hooks: { afterAdvisory?: () => Promise<void>; beforeFinal?: () => Promise<void> } = {},
) {
  const state = { reached: false, advisoryReached: false, finalPrepared: false };
  const nativeDb = adaptD1({
    prepare(sql) {
      const bytes = Buffer.byteLength(sql);
      bounds.maximum_statement_bytes = Math.max(bounds.maximum_statement_bytes, bytes);
      assert(bytes <= 100_000, "attention read SQL must retain its checked statement bound");
      const native = binding.prepare(sql);
      const statement: D1StatementLike = {
        bind(...parameters) {
          bounds.maximum_bindings = Math.max(bounds.maximum_bindings, parameters.length);
          assert(
            parameters.length <= 100,
            "attention read SQL must retain its checked binding bound",
          );
          return native.bind(...parameters);
        },
        first: (column) => native.first(column),
        all: () => native.all(),
        run: () => native.run(),
      };
      return statement;
    },
    batch: (statements) => binding.batch(statements),
  });
  function wrap(db: SqlDatabase): SqlDatabase {
    return {
      prepare(sql) {
        const statement = db.prepare(sql);
        return {
          run: (...parameters) => statement.run(...parameters),
          all: (...parameters) => statement.all(...parameters),
          async get(...parameters) {
            if (
              state.reached &&
              sql.includes("attention_requests") &&
              hooks.beforeFinal &&
              !state.finalPrepared
            ) {
              // SQL is prepared and the caller's parameters are fixed before this await.
              state.finalPrepared = true;
              await hooks.beforeFinal();
            }
            const result = await statement.get(...parameters);
            if (
              !state.reached &&
              sql.includes("attention_requests") &&
              result !== null &&
              result !== undefined
            ) {
              state.reached = true;
              await after();
            }
            if (
              state.reached &&
              !state.advisoryReached &&
              hooks.afterAdvisory &&
              sql.includes("task.id AS taskId") &&
              result !== null &&
              result !== undefined
            ) {
              state.advisoryReached = true;
              await hooks.afterAdvisory();
            }
            return result;
          },
        };
      },
      withTransaction: (run) => db.withTransaction((tx) => run(wrap(tx))),
    };
  }
  return { db: wrap(nativeDb), state };
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
      "attention_requests",
      "attention_observations",
      "task_context_deliveries",
      "semantic_events",
      "audit_events",
      "outbox_records",
      "idempotency_records",
      "workspace_cursors",
      "tasks",
      "runs",
      "run_executions",
      "execution_assignments",
      "runners",
      "runner_project_grants",
      "checkout_leases",
      "task_privacy",
      "task_human_grants",
      "oauth_delegations",
      "workspace_members",
      "workspace_authorization_epochs",
      "projects",
      "project_access",
      "oauth_delegation_tokens",
    ])
      rows[table] = await db
        .prepare(`SELECT * FROM ${table} WHERE workspace_id=? ORDER BY rowid`)
        .all(FIX.workspace);
    for (const table of [
      "passkey_step_up_proofs",
      "oauth_delegation_grants",
      "better_auth_users",
      "better_auth_sessions",
      "better_auth_oauth_access_tokens",
      "better_auth_oauth_clients",
      "artifact_mutation_guards",
      "runner_mutation_guards",
      "cli_mutation_guards",
      "security_audit_position_guards",
    ])
      rows[table] = await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    // The handler's HTTP abuse bucket is deliberately separate from business/read effects.
    return rows;
  }
  type Effects = Awaited<ReturnType<typeof effects>>;
  async function human<I>(input: I, humanId = FIX.member): Promise<CommandRequest<I>> {
    const principal = await loadPrincipal(db, FIX.workspace, humanId);
    return {
      workspaceId: FIX.workspace,
      actorHumanId: humanId,
      authorizationEpoch: principal.authorizationEpoch,
      idempotencyKey: randomUlid(),
      now: historicalRequestTime,
      input,
    };
  }

  async function issueAccess(
    humanId: string,
    projectId: string | null,
    taskId: string | null,
    expiryModifier = "+10 minutes",
  ) {
    const principal = await loadPrincipal(db, FIX.workspace, humanId);
    const clock = (await db
      .prepare(
        `SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now,
      strftime('%Y-%m-%dT%H:%M:%fZ','now',?) AS expires_at,
      strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour') AS session_expires_at`,
      )
      .get(expiryModifier)) as { now: string; expires_at: string; session_expires_at: string };
    const existing = (await db
      .prepare("SELECT better_auth_user_id FROM humans WHERE id=?")
      .get(humanId)) as { better_auth_user_id: string | null };
    const authUserId = existing.better_auth_user_id ?? randomUlid(),
      sessionId = randomUlid();
    if (!existing.better_auth_user_id) {
      await db
        .prepare(
          `INSERT INTO better_auth_users (id,name,email,email_verified,image,created_at,updated_at)
        SELECT ?,display_name,email,1,NULL,?,? FROM humans WHERE id=?`,
        )
        .run(authUserId, clock.now, clock.now, humanId);
      await db
        .prepare("UPDATE humans SET better_auth_user_id=? WHERE id=?")
        .run(authUserId, humanId);
    }
    await db
      .prepare(
        `INSERT INTO better_auth_sessions (id,expires_at,token,created_at,updated_at,ip_address,user_agent,user_id)
      VALUES (?,?,?,?,?,NULL,NULL,?)`,
      )
      .run(
        sessionId,
        clock.session_expires_at,
        `synthetic-session-${sessionId}`,
        clock.now,
        clock.now,
        authUserId,
      );
    const scopes = ["bfb:read", "offline_access"],
      resource = mcpResource(origin);
    const boundary = {
      ...(projectId === null ? {} : { projectId }),
      ...(taskId === null ? {} : { taskId }),
    };
    const proofId = await issueStepUpProof(
      db,
      humanId,
      {
        action: "oauth.delegation.create",
        clientId: FIX.client,
        resource,
        workspaceId: FIX.workspace,
        ...boundary,
        scopes,
        authorizationEpoch: principal.authorizationEpoch,
        expiresAt: clock.expires_at,
      },
      clock.now,
    );
    const grantId = await prepareDelegationGrant(db, {
      humanId,
      authUserId,
      sessionId,
      clientId: FIX.client,
      state: randomUlid(),
      resource,
      workspaceId: FIX.workspace,
      ...boundary,
      scopes,
      authorizationEpoch: principal.authorizationEpoch,
      stepUpProofId: proofId,
      providerLabel: "Synthetic read-only client",
      now: clock.now,
    });
    await decideDelegationGrant(db, {
      grantId,
      authUserId,
      sessionId,
      decision: "accepted",
      now: clock.now,
    });
    const delegationId = await activateDelegationGrant(db, grantId, authUserId, scopes, clock.now);
    const accessToken = `mcp_${randomUlid()}${randomUlid()}`,
      providerTokenId = randomUlid();
    await db
      .prepare(
        `INSERT INTO better_auth_oauth_access_tokens
      (id,token,client_id,session_id,user_id,reference_id,refresh_id,expires_at,created_at,scopes)
      VALUES (?,?,?,?,?,?,NULL,?,?,?)`,
      )
      .run(
        providerTokenId,
        createHash("sha256").update(accessToken.slice(4)).digest("base64url"),
        FIX.client,
        sessionId,
        authUserId,
        grantId,
        clock.expires_at,
        clock.now,
        JSON.stringify(scopes),
      );
    assert.equal(await bindProviderAccessToken(db, accessToken, clock.now), delegationId);
    return { accessToken, delegationId, humanId, epoch: principal.authorizationEpoch, ...clock };
  }

  async function fixture(
    humanId = FIX.owner,
    options: {
      state?: "open" | "answered" | "resolved";
      ended?: boolean;
      kind?: "credential" | "clarification";
      projectBoundary?: string | null;
      taskBoundary?: string | null;
      expiryModifier?: string;
    } = {},
  ) {
    const task = success(
      await execute<TaskRecord>(
        "task.create",
        await human({ projectId: FIX.projectA, title: `${canary}-TASK`, priority: "P2" }),
      ),
    );
    const run = success(
      await execute<{ run: { id: string } }>(
        "run.create",
        await human({
          taskId: task.id,
          expectedTaskVersion: 1,
          agentProfileId: FIX.profileCodex,
          workspacePolicyVersion: 1,
          projectPolicyVersion: 1,
          repositoryConfigVersion: 1,
          agentProfileVersion: 1,
        }),
      ),
    );
    const execution = success(
      await execute<{ id: string }>("execution.create", await human({ runId: run.run.id })),
    );
    const requester = await loadPrincipal(db, FIX.workspace, FIX.member),
      runnerId = randomUlid(),
      assignedAt = new Date().toISOString(),
      thumbprint = `synthetic-attention-read-${runnerId}`;
    await db
      .prepare(
        `INSERT INTO runners (workspace_id,id,owner_human_id,device_label,public_key_json,key_thumbprint,authorization_epoch,grant_epoch,token_epoch,enrolled_at,revoked_at)
      VALUES (?,?,?,'Synthetic read fixture Mac','{}',?,1,1,1,?,NULL)`,
      )
      .run(FIX.workspace, runnerId, FIX.member, thumbprint, assignedAt);
    await db
      .prepare(
        "INSERT INTO runner_project_grants (workspace_id,runner_id,project_id) VALUES (?,?,?)",
      )
      .run(FIX.workspace, runnerId, FIX.projectA);
    // Synthetic immutable waiter context is dormant: no launch, lease, acknowledgement or process.
    await db
      .prepare(
        `INSERT INTO execution_assignments
      (workspace_id,execution_id,assignment_generation,run_id,task_id,project_id,runner_id,checkout_id,physical_worktree_hash,requesting_human_id,requesting_human_epoch,runner_authorization_epoch,runner_grant_epoch,runner_key_thumbprint,created_at)
      VALUES (?,?,1,?,?,?,?,?,?,?,?,1,1,?,?)`,
      )
      .run(
        FIX.workspace,
        execution.id,
        run.run.id,
        task.id,
        FIX.projectA,
        runnerId,
        randomUlid(),
        `sha256:${"a".repeat(64)}`,
        FIX.member,
        requester.authorizationEpoch,
        thumbprint,
        assignedAt,
      );
    const writerId = randomUlid(),
      window = (await db
        .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes') AS expires_at")
        .get()) as { expires_at: string };
    await db
      .prepare(
        `INSERT INTO oauth_delegations (workspace_id,id,human_id,client_id,resource,project_id,task_id,scopes_json,authorization_epoch,expires_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        FIX.workspace,
        writerId,
        FIX.member,
        FIX.client,
        mcpResource(origin),
        FIX.projectA,
        task.id,
        JSON.stringify(["bfb:task:write"]),
        requester.authorizationEpoch,
        window.expires_at,
        assignedAt,
      );
    let attention = success(
      await execute<AttentionRecord>("attention.request.delegation", {
        workspaceId: FIX.workspace,
        actorHumanId: FIX.member,
        actorDelegationId: writerId,
        authorizationEpoch: requester.authorizationEpoch,
        idempotencyKey: randomUlid(),
        now: historicalRequestTime,
        input: { runId: run.run.id, kind: options.kind ?? "credential", question, blocking: true },
      }),
    );
    if ((options.state ?? "resolved") !== "open")
      attention = success(
        await execute<AttentionRecord>(
          "attention.answer",
          await human(
            { attentionId: attention.id, expectedVersion: attention.resource_version, answer },
            FIX.owner,
          ),
        ),
      );
    if ((options.state ?? "resolved") === "resolved")
      attention = success(
        await execute<AttentionRecord>(
          "attention.resolve",
          await human(
            { attentionId: attention.id, expectedVersion: attention.resource_version },
            FIX.owner,
          ),
        ),
      );
    if (options.ended ?? true) {
      success(
        await execute(
          "execution.transition",
          await human({
            runId: run.run.id,
            executionId: execution.id,
            expectedVersion: 1,
            state: "ended",
            endReason: "process_exit",
          }),
        ),
      );
      const currentRun = (await db
        .prepare("SELECT resource_version FROM runs WHERE workspace_id=? AND id=?")
        .get(FIX.workspace, run.run.id)) as { resource_version: number };
      success(
        await execute(
          "result.cancel",
          await human({ runId: run.run.id, expectedRunVersion: currentRun.resource_version }),
        ),
      );
    }
    const principal = await loadPrincipal(db, FIX.workspace, humanId),
      grantId = randomUlid();
    await db
      .prepare(
        "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
      )
      .run(FIX.workspace, task.id, FIX.member, assignedAt);
    await db
      .prepare(
        `INSERT INTO task_human_grants (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at)
      VALUES (?,?,?,?,?,'read',?)`,
      )
      .run(FIX.workspace, grantId, task.id, humanId, principal.authorizationEpoch, assignedAt);
    const credential = await issueAccess(
      humanId,
      options.projectBoundary === undefined ? FIX.projectA : options.projectBoundary,
      options.taskBoundary === undefined ? task.id : options.taskBoundary,
      options.expiryModifier,
    );
    return {
      taskId: task.id,
      runId: run.run.id,
      executionId: execution.id,
      grantId,
      attention,
      ...credential,
    };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  async function call(f: Fixture, queryDb: SqlDatabase, attentionId = f.attention.id) {
    const response = await handleMcpRequest(
      new Request(`${origin}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/call",
          "Mcp-Name": "bfb_get_attention",
          Host: "bfb.example.test",
          authorization: `Bearer ${f.accessToken}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "bfb_get_attention",
            arguments: { attention_id: attentionId },
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": {
                name: "bfb-synthetic-attention-delivery",
                version: "1.0.0",
              },
            },
          },
        }),
      }),
      {
        db: queryDb,
        allowedHostnames: ["bfb.example.test"],
        appOrigin: origin,
        abuseSecret: "c11-synthetic-attention-delivery-abuse-secret-b4913c",
        jurisdiction: "eu",
        now: new Date().toISOString(),
      },
    );
    assert.equal(response.status, 200);
    const reply = (await response.json()) as {
      error?: unknown;
      result?: { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
    };
    assert.equal(reply.error, undefined);
    const text = reply.result?.content?.[0]?.text;
    assert.equal(reply.result?.content?.[0]?.type, "text");
    assert.equal(typeof text, "string");
    let body: { error?: string; attention?: AttentionRecord } | undefined;
    try {
      body = JSON.parse(text!) as typeof body;
    } catch {
      /* The unchanged SDK may return a plain advisory error. */
    }
    return { body, text: text!, isError: reply.result?.isError };
  }
  function denied(f: Fixture, reply: Awaited<ReturnType<typeof call>>) {
    assert.equal(reply.isError, true);
    assert.deepEqual(reply.body, { error: "not_found" });
    for (const prohibited of [canary, f.attention.id, f.taskId, f.runId, f.executionId])
      assert(
        !reply.text.includes(prohibited),
        "denied reply must contain no attention identity or body",
      );
  }
  async function cursor() {
    return db
      .prepare("SELECT cursor FROM workspace_cursors WHERE workspace_id=?")
      .get(FIX.workspace);
  }
  async function credential(f: Fixture) {
    return db
      .prepare("SELECT * FROM oauth_delegations WHERE workspace_id=? AND id=?")
      .get(FIX.workspace, f.delegationId);
  }
  async function revokeReadGrant(f: Fixture) {
    const now = new Date().toISOString();
    await independent
      .prepare("UPDATE task_human_grants SET revoked_at=? WHERE workspace_id=? AND id=?")
      .run(now, FIX.workspace, f.grantId);
    assert.deepEqual(
      await independent
        .prepare("SELECT revoked_at FROM task_human_grants WHERE workspace_id=? AND id=?")
        .get(FIX.workspace, f.grantId),
      { revoked_at: now },
    );
  }
  async function denyAfterPreliminary(f: Fixture, mutate: () => Promise<void>) {
    const originalCursor = await cursor();
    let before: Effects | undefined,
      mutationApplied = false;
    const guarded = afterAttentionRead(binding, async () => {
      await mutate();
      assert.deepEqual(await cursor(), originalCursor);
      mutationApplied = true;
      before = await effects();
    });
    const reply = await call(f, guarded.db);
    assert(guarded.state.reached && mutationApplied, "the independent mutation must finish");
    denied(f, reply);
    assert.deepEqual(await effects(), before);
  }

  await check(
    "real_d1_mounted_read_only_reviewer_reads_resolved_ended_history_without_effects",
    async () => {
      const f = await fixture(FIX.reviewer),
        before = await effects();
      const credential = await db
        .prepare("SELECT * FROM oauth_delegations WHERE workspace_id=? AND id=?")
        .get(FIX.workspace, f.delegationId);
      const guarded = afterAttentionRead(binding, async () => {
        await delay(250);
        assert.deepEqual(
          await db
            .prepare("SELECT * FROM oauth_delegations WHERE workspace_id=? AND id=?")
            .get(FIX.workspace, f.delegationId),
          credential,
        );
      });
      const reply = await call(f, guarded.db);
      assert(guarded.state.reached);
      assert.notEqual(reply.isError, true);
      assert.deepEqual(reply.body, { attention: f.attention });
      assert.equal(f.attention.required_role, "owner");
      assert.equal(f.attention.state, "resolved");
      assert.deepEqual(
        await db
          .prepare("SELECT state FROM run_executions WHERE workspace_id=? AND id=?")
          .get(FIX.workspace, f.executionId),
        { state: "ended" },
      );
      assert.deepEqual(
        await db
          .prepare("SELECT result_state FROM runs WHERE workspace_id=? AND id=?")
          .get(FIX.workspace, f.runId),
        { result_state: "cancelled" },
      );
      assert.deepEqual(await effects(), before);
    },
  );

  await check(
    "real_d1_mounted_production_revocation_after_preliminary_attention_withholds_body",
    async () => {
      const f = await fixture(),
        originalCursor = await db
          .prepare("SELECT cursor FROM workspace_cursors WHERE workspace_id=?")
          .get(FIX.workspace);
      let before: Effects | undefined,
        mutationApplied = false;
      const guarded = afterAttentionRead(binding, async () => {
        const now = new Date().toISOString();
        await revokeDelegation(independent, FIX.workspace, f.delegationId, now);
        assert.deepEqual(
          await independent
            .prepare("SELECT revoked_at FROM oauth_delegations WHERE workspace_id=? AND id=?")
            .get(FIX.workspace, f.delegationId),
          { revoked_at: now },
        );
        assert.deepEqual(
          await db
            .prepare("SELECT cursor FROM workspace_cursors WHERE workspace_id=?")
            .get(FIX.workspace),
          originalCursor,
        );
        mutationApplied = true;
        before = await effects();
      });
      const reply = await call(f, guarded.db);
      assert(guarded.state.reached && mutationApplied);
      denied(f, reply);
      assert.deepEqual(await effects(), before);
    },
  );

  await check("real_d1_mounted_read_only_owner_member_preserve_open_answered_history", async () => {
    for (const [humanId, state] of [
      [FIX.owner, "open"],
      [FIX.member, "answered"],
    ] as const) {
      const f = await fixture(humanId, { state, ended: false }),
        before = await effects();
      const guarded = afterAttentionRead(binding, async () => {});
      const reply = await call(f, guarded.db);
      assert(guarded.state.reached);
      assert.notEqual(reply.isError, true);
      assert.deepEqual(reply.body, { attention: f.attention });
      assert.equal(f.attention.required_role, "owner");
      assert.deepEqual(await effects(), before);
    }
  });

  await check(
    "real_d1_mounted_reads_new_canonical_answer_after_preliminary_selection",
    async () => {
      const f = await fixture(FIX.owner, { state: "open", ended: false, kind: "clarification" });
      let current: AttentionRecord | undefined, before: Effects | undefined;
      const guarded = afterAttentionRead(binding, async () => {
        current = success(
          await execute<AttentionRecord>(
            "attention.answer",
            await human(
              {
                attentionId: f.attention.id,
                expectedVersion: f.attention.resource_version,
                answer,
              },
              FIX.member,
            ),
          ),
        );
        assert.equal(current.state, "answered");
        assert.equal(current.resource_version, f.attention.resource_version + 1);
        // This valid independent answer has its own canonical receipt and cursor advance.
        before = await effects();
      });
      const reply = await call(f, guarded.db);
      assert(guarded.state.reached && current);
      assert.notEqual(reply.isError, true);
      assert.deepEqual(reply.body, { attention: current });
      assert.deepEqual(await effects(), before);
    },
  );

  await check("real_d1_mounted_current_read_scope_loss_withholds_body", async () => {
    const f = await fixture(),
      scopes = JSON.stringify(["bfb:task:write", "offline_access"]);
    await denyAfterPreliminary(f, async () => {
      await independent
        .prepare("UPDATE oauth_delegations SET scopes_json=? WHERE workspace_id=? AND id=?")
        .run(scopes, FIX.workspace, f.delegationId);
      assert.deepEqual(
        await independent
          .prepare("SELECT scopes_json FROM oauth_delegations WHERE workspace_id=? AND id=?")
          .get(FIX.workspace, f.delegationId),
        { scopes_json: scopes },
      );
    });
  });

  await check("real_d1_mounted_current_client_mismatch_withholds_body", async () => {
    const f = await fixture(),
      clientId = `synthetic-alternate-${randomUlid()}`;
    await db
      .prepare(
        `INSERT INTO better_auth_oauth_clients (id,client_id,redirect_uris,disabled)
      VALUES (?,?,?,0)`,
      )
      .run(randomUlid(), clientId, JSON.stringify(["http://127.0.0.1:9999/callback"]));
    await denyAfterPreliminary(f, async () => {
      await independent
        .prepare("UPDATE oauth_delegations SET client_id=? WHERE workspace_id=? AND id=?")
        .run(clientId, FIX.workspace, f.delegationId);
      assert.deepEqual(
        await independent
          .prepare("SELECT client_id FROM oauth_delegations WHERE workspace_id=? AND id=?")
          .get(FIX.workspace, f.delegationId),
        { client_id: clientId },
      );
    });
  });

  await check("real_d1_mounted_original_null_project_boundary_cannot_be_adopted", async () => {
    const f = await fixture(FIX.owner, { projectBoundary: null, taskBoundary: null });
    await denyAfterPreliminary(f, async () => {
      await independent
        .prepare("UPDATE oauth_delegations SET project_id=? WHERE workspace_id=? AND id=?")
        .run(FIX.projectA, FIX.workspace, f.delegationId);
      assert.deepEqual(
        await independent
          .prepare("SELECT project_id,task_id FROM oauth_delegations WHERE workspace_id=? AND id=?")
          .get(FIX.workspace, f.delegationId),
        { project_id: FIX.projectA, task_id: null },
      );
    });
  });

  await check(
    "real_d1_mounted_original_null_task_boundary_cannot_adopt_unrelated_task",
    async () => {
      const f = await fixture(FIX.owner, { taskBoundary: null });
      const unrelated = success(
        await execute<TaskRecord>(
          "task.create",
          await human({
            projectId: FIX.projectA,
            title: "Synthetic unrelated boundary",
            priority: "P2",
          }),
        ),
      );
      assert.notEqual(unrelated.id, f.taskId);
      await denyAfterPreliminary(f, async () => {
        await independent
          .prepare("UPDATE oauth_delegations SET task_id=? WHERE workspace_id=? AND id=?")
          .run(unrelated.id, FIX.workspace, f.delegationId);
        assert.deepEqual(
          await independent
            .prepare(
              "SELECT project_id,task_id FROM oauth_delegations WHERE workspace_id=? AND id=?",
            )
            .get(FIX.workspace, f.delegationId),
          { project_id: FIX.projectA, task_id: unrelated.id },
        );
      });
    },
  );

  await check("real_d1_mounted_original_project_boundary_cannot_be_widened_to_null", async () => {
    const f = await fixture();
    await denyAfterPreliminary(f, async () => {
      await independent
        .prepare(
          "UPDATE oauth_delegations SET project_id=NULL,task_id=NULL WHERE workspace_id=? AND id=?",
        )
        .run(FIX.workspace, f.delegationId);
      assert.deepEqual(
        await independent
          .prepare("SELECT project_id,task_id FROM oauth_delegations WHERE workspace_id=? AND id=?")
          .get(FIX.workspace, f.delegationId),
        { project_id: null, task_id: null },
      );
    });
  });

  await check("real_d1_mounted_original_task_boundary_cannot_be_widened_to_null", async () => {
    const f = await fixture();
    await denyAfterPreliminary(f, async () => {
      await independent
        .prepare("UPDATE oauth_delegations SET task_id=NULL WHERE workspace_id=? AND id=?")
        .run(FIX.workspace, f.delegationId);
      assert.deepEqual(
        await independent
          .prepare("SELECT project_id,task_id FROM oauth_delegations WHERE workspace_id=? AND id=?")
          .get(FIX.workspace, f.delegationId),
        { project_id: FIX.projectA, task_id: null },
      );
    });
  });

  await check("real_d1_mounted_production_epoch_bump_withholds_retained_credential", async () => {
    const f = await fixture();
    await denyAfterPreliminary(f, async () => {
      assert.equal(await bumpMemberEpoch(independent, FIX.workspace, f.humanId), f.epoch + 1);
      assert.equal(
        (await loadPrincipal(independent, FIX.workspace, f.humanId)).authorizationEpoch,
        f.epoch + 1,
      );
    });
  });

  await check("real_d1_mounted_current_project_access_loss_withholds_body", async () => {
    const f = await fixture(),
      originalProject = (await db
        .prepare("SELECT access_mode FROM projects WHERE workspace_id=? AND id=?")
        .get(FIX.workspace, FIX.projectA)) as { access_mode: string };
    const originalGrant = await db
      .prepare("SELECT * FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?")
      .get(FIX.workspace, FIX.projectA, f.humanId);
    try {
      await denyAfterPreliminary(f, async () => {
        await independent
          .prepare("UPDATE projects SET access_mode='restricted' WHERE workspace_id=? AND id=?")
          .run(FIX.workspace, FIX.projectA);
        await independent
          .prepare(
            "DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?",
          )
          .run(FIX.workspace, FIX.projectA, f.humanId);
        assert(
          !(await loadPrincipal(independent, FIX.workspace, f.humanId)).projectIds.includes(
            FIX.projectA,
          ),
        );
      });
    } finally {
      await db
        .prepare("UPDATE projects SET access_mode=? WHERE workspace_id=? AND id=?")
        .run(originalProject.access_mode, FIX.workspace, FIX.projectA);
      if (originalGrant)
        await db
          .prepare("INSERT INTO project_access (workspace_id,project_id,human_id) VALUES (?,?,?)")
          .run(FIX.workspace, FIX.projectA, f.humanId);
    }
  });

  await check("real_d1_mounted_private_read_grant_loss_has_uniform_missing_reply", async () => {
    const f = await fixture();
    await denyAfterPreliminary(f, () => revokeReadGrant(f));
  });

  await check(
    "real_d1_mounted_private_read_grant_revoked_after_successful_advisory_withholds_body",
    async () => {
      const f = await fixture(),
        originalCursor = await cursor();
      let before: Effects | undefined,
        mutationApplied = false;
      const guarded = afterAttentionRead(binding, async () => {}, {
        afterAdvisory: async () => {
          await revokeReadGrant(f);
          assert.deepEqual(await cursor(), originalCursor);
          mutationApplied = true;
          before = await effects();
        },
      });
      const reply = await call(f, guarded.db);
      assert(guarded.state.reached && guarded.state.advisoryReached && mutationApplied);
      denied(f, reply);
      assert.deepEqual(await effects(), before);
    },
  );

  await check(
    "real_d1_mounted_unchanged_credential_expires_after_final_sql_is_prepared",
    async () => {
      const f = await fixture(FIX.owner, { expiryModifier: "+4 seconds" }),
        original = await credential(f),
        before = await effects();
      let arrival: string | undefined, flush: string | undefined;
      const guarded = afterAttentionRead(binding, async () => {}, {
        beforeFinal: async () => {
          const clock = (await db
            .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now")
            .get()) as { now: string };
          arrival = clock.now;
          assert(
            arrival < f.expires_at,
            "credential must still be live after the final SQL is prepared",
          );
          const deadline = Date.now() + 6_000;
          do {
            await delay(50);
            flush = (
              (await db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now").get()) as {
                now: string;
              }
            ).now;
            assert(Date.now() < deadline, "natural expiry wait must remain bounded");
          } while (flush < f.expires_at);
          assert.deepEqual(await credential(f), original);
        },
      });
      const reply = await call(f, guarded.db);
      assert(guarded.state.reached && guarded.state.finalPrepared && arrival && flush);
      assert(arrival < f.expires_at && flush >= f.expires_at);
      denied(f, reply);
      assert.deepEqual(await effects(), before);
      assert.deepEqual(await credential(f), original);
    },
  );

  await check(
    "real_d1_mounted_delayed_prepared_final_selection_preserves_live_history",
    async () => {
      const f = await fixture(FIX.reviewer),
        original = await credential(f),
        before = await effects();
      const guarded = afterAttentionRead(binding, async () => {}, {
        beforeFinal: async () => {
          await delay(250);
          const clock = (await db
            .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now")
            .get()) as { now: string };
          assert(clock.now < f.expires_at);
          assert.deepEqual(await credential(f), original);
        },
      });
      const reply = await call(f, guarded.db);
      assert(guarded.state.reached && guarded.state.finalPrepared);
      assert.notEqual(reply.isError, true);
      assert.deepEqual(reply.body, { attention: f.attention });
      assert.deepEqual(await effects(), before);
    },
  );

  await check(
    "real_d1_mounted_missing_and_current_private_denial_have_identical_delivery",
    async () => {
      const f = await fixture();
      await revokeReadGrant(f);
      const before = await effects(),
        missing = await call(f, db, randomUlid()),
        hidden = await call(f, db);
      denied(f, missing);
      denied(f, hidden);
      assert.deepEqual(hidden, missing);
      assert.deepEqual(await effects(), before);
    },
  );

  await check("real_d1_mounted_synthetic_mutable_attention_parent_rebind_is_rejected", async () => {
    const f = await fixture(),
      other = await fixture();
    await denyAfterPreliminary(f, async () => {
      // Robustness fixture: no production command rebinds attention parents or immutable assignments.
      await independent
        .prepare(
          `UPDATE attention_requests SET task_id=?,project_id=?,run_id=?,
        run_execution_id=?,assignment_generation=? WHERE workspace_id=? AND id=?`,
        )
        .run(
          other.taskId,
          FIX.projectA,
          other.runId,
          other.executionId,
          other.attention.assignment_generation,
          FIX.workspace,
          f.attention.id,
        );
      assert.deepEqual(
        await independent
          .prepare(
            `SELECT task_id,project_id,run_id,run_execution_id,assignment_generation
        FROM attention_requests WHERE workspace_id=? AND id=?`,
          )
          .get(FIX.workspace, f.attention.id),
        {
          task_id: other.taskId,
          project_id: FIX.projectA,
          run_id: other.runId,
          run_execution_id: other.executionId,
          assignment_generation: other.attention.assignment_generation,
        },
      );
    });
  });

  console.log(
    JSON.stringify({
      schema_version: 1,
      stage: "delegated_attention_read_delivery",
      migration_head: manifest.migration_head,
      checks,
      failures,
      ...bounds,
      outcome: failures.length ? "failed" : "passed",
      limits: [
        "genuine OAuth MCP handler and disposable native D1 only",
        "synthetic dormant private policy and immutable waiter context; no provider or runner operation",
        "final read statement proof, not other OAuth tools or authority after serialization",
        "mutable attention parent rebind is synthetic robustness, not a reachable production mutation",
      ],
    }),
  );
  assert.equal(failures.length, 0, "delegated attention read D1 checks failed");
  console.log("C11_DELEGATED_ATTENTION_DELIVERY_D1_OK");
} finally {
  await server.close();
}
