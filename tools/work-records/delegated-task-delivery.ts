// ABOUTME: Exercises delegated task read delivery through mounted OAuth MCP and disposable native D1.
// ABOUTME: Witnessed authority changes retain canonical business history without running providers or runners.

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
  type CommandOutcome,
  type CommandRequest,
  type TaskRecord,
} from "@bfb/domain";
import { createTestHarness } from "wrangler";
import { handleMcpRequest } from "../../apps/control-worker/dist/mcp/handler.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const origin = "https://bfb.example.test";
const canary = "SYNTHETIC-C11-TASK-DELIVERY";
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
function afterTaskRead(
  binding: D1Like,
  after: () => Promise<void>,
  hooks: {
    afterInitial?: () => Promise<void>;
    afterAdvisory?: () => Promise<void>;
    beforeFinal?: () => Promise<void>;
  } = {},
) {
  const state = {
    reached: false,
    initialReached: false,
    advisoryReached: false,
    finalPrepared: false,
  };
  const nativeDb = adaptD1({
    prepare(sql) {
      const bytes = Buffer.byteLength(sql);
      bounds.maximum_statement_bytes = Math.max(bounds.maximum_statement_bytes, bytes);
      assert(bytes <= 100_000, "task read SQL must retain its checked statement bound");
      const native = binding.prepare(sql);
      const statement: D1StatementLike = {
        bind(...parameters) {
          bounds.maximum_bindings = Math.max(bounds.maximum_bindings, parameters.length);
          assert(parameters.length <= 100, "task read SQL must retain its checked binding bound");
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
        const taskBody =
          sql.includes("task.title") &&
          sql.includes("task.resource_version") &&
          sql.includes("FROM tasks AS task");
        return {
          run: (...parameters) => statement.run(...parameters),
          all: (...parameters) => statement.all(...parameters),
          async get(...parameters) {
            if (state.reached && taskBody && hooks.beforeFinal && !state.finalPrepared) {
              // The SQL and caller's arguments are fixed before this await and native execution.
              state.finalPrepared = true;
              await hooks.beforeFinal();
            }
            const result = await statement.get(...parameters);
            if (
              !state.reached &&
              !state.initialReached &&
              hooks.afterInitial &&
              sql.includes("task.id AS taskId") &&
              result !== null &&
              result !== undefined
            ) {
              state.initialReached = true;
              await hooks.afterInitial();
            }
            if (!state.reached && taskBody && result !== null && result !== undefined) {
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
  const tables = (await db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table'
    AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'
    AND name NOT IN ('d1_migrations','rate_limit_buckets') ORDER BY name`,
    )
    .all()) as Array<{ name: string }>;
  for (const { name } of tables) assert(/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name));
  async function effects() {
    const rows: Record<string, unknown[]> = {};
    for (const { name } of tables)
      rows[name] = await db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all();
    // All canonical business/OAuth tables are retained; only HTTP abuse buckets and engine metadata are excluded.
    return rows;
  }
  type Effects = Awaited<ReturnType<typeof effects>>;
  async function cursor() {
    return db
      .prepare("SELECT cursor FROM workspace_cursors WHERE workspace_id=?")
      .get(FIX.workspace);
  }
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
  async function createTask(parentTaskId?: string) {
    return success(
      await execute<TaskRecord>(
        "task.create",
        await human({
          projectId: FIX.projectA,
          title: `${canary}-TASK`,
          priority: "P2",
          ...(parentTaskId === undefined ? {} : { parentTaskId }),
        }),
      ),
    );
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
  async function makePrivate(taskId: string, humanId: string) {
    const principal = await loadPrincipal(db, FIX.workspace, humanId),
      grantId = randomUlid();
    const now = new Date().toISOString();
    // Dormant private policy and named read grant are synthetic fixtures, not new ACL commands.
    await db
      .prepare(
        "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
      )
      .run(FIX.workspace, taskId, FIX.member, now);
    await db
      .prepare(
        `INSERT INTO task_human_grants (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at)
      VALUES (?,?,?,?,?,'read',?)`,
      )
      .run(FIX.workspace, grantId, taskId, humanId, principal.authorizationEpoch, now);
    return grantId;
  }
  async function fixture(
    humanId = FIX.owner,
    options: {
      state?: "ready" | "done" | "cancelled";
      shared?: boolean;
      parent?: TaskRecord;
      projectBoundary?: string | null;
      taskBoundary?: string | null;
      expiryModifier?: string;
    } = {},
  ) {
    let task = await createTask(options.parent?.id);
    const states =
      options.state === "done"
        ? ["active", "review", "done"]
        : options.state === "cancelled"
          ? ["cancelled"]
          : [];
    for (const state of states)
      task = success(
        await execute<TaskRecord>(
          "task.update",
          await human({
            taskId: task.id,
            expectedVersion: task.resource_version,
            state,
          }),
        ),
      );
    const grantId = options.shared ? null : await makePrivate(task.id, humanId);
    const access = await issueAccess(
      humanId,
      options.projectBoundary === undefined ? FIX.projectA : options.projectBoundary,
      options.taskBoundary === undefined ? task.id : options.taskBoundary,
      options.expiryModifier,
    );
    return { task, grantId, ...access };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function call(f: Fixture, queryDb: SqlDatabase, taskId = f.task.id) {
    const response = await handleMcpRequest(
      new Request(`${origin}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/call",
          "Mcp-Name": "bfb_get_task",
          Host: "bfb.example.test",
          authorization: `Bearer ${f.accessToken}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "bfb_get_task",
            arguments: { task_id: taskId },
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": {
                name: "bfb-synthetic-task-delivery",
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
        abuseSecret: "c11-synthetic-task-delivery-abuse-secret-b4913c",
        jurisdiction: "eu",
        now: new Date().toISOString(),
      },
    );
    assert.equal(response.status, 200);
    const reply = (await response.json()) as {
      error?: unknown;
      result?: {
        isError?: boolean;
        content?: Array<{ type?: string; text?: string }>;
      };
    };
    assert.equal(reply.error, undefined);
    const text = reply.result?.content?.[0]?.text;
    assert.equal(reply.result?.content?.[0]?.type, "text");
    assert.equal(typeof text, "string");
    let body: { task?: TaskRecord } | undefined;
    try {
      body = JSON.parse(text!) as typeof body;
    } catch {
      /* Canonical SDK domain errors are plain text. */
    }
    return { body, text: text!, isError: reply.result?.isError };
  }
  function denied(f: Fixture, reply: Awaited<ReturnType<typeof call>>) {
    assert.equal(reply.isError, true);
    assert.equal(reply.text, "task not found");
    assert.equal(reply.body, undefined);
    for (const prohibited of [canary, f.task.id, f.task.project_id])
      assert(
        !reply.text.includes(prohibited),
        "denied reply must contain no task identity or body",
      );
  }
  async function credential(f: Fixture) {
    return db
      .prepare("SELECT * FROM oauth_delegations WHERE workspace_id=? AND id=?")
      .get(FIX.workspace, f.delegationId);
  }
  async function revokeGrant(grantId: string) {
    const now = new Date().toISOString();
    await independent
      .prepare("UPDATE task_human_grants SET revoked_at=? WHERE workspace_id=? AND id=?")
      .run(now, FIX.workspace, grantId);
    assert.deepEqual(
      await independent
        .prepare("SELECT revoked_at FROM task_human_grants WHERE workspace_id=? AND id=?")
        .get(FIX.workspace, grantId),
      { revoked_at: now },
    );
  }
  async function denyAfter(
    f: Fixture,
    cut: "preliminary" | "advisory",
    mutate: () => Promise<void>,
  ) {
    const originalCursor = await cursor();
    let before: Effects | undefined,
      mutationApplied = false;
    const witness = async () => {
      await mutate();
      assert.deepEqual(await cursor(), originalCursor);
      mutationApplied = true;
      before = await effects();
    };
    const guarded = afterTaskRead(
      binding,
      cut === "preliminary" ? witness : async () => {},
      cut === "advisory" ? { afterAdvisory: witness } : {},
    );
    const reply = await call(f, guarded.db);
    assert(guarded.state.reached && mutationApplied);
    if (cut === "advisory") assert(guarded.state.advisoryReached);
    denied(f, reply);
    assert.deepEqual(await effects(), before);
  }

  await check(
    "real_d1_mounted_read_only_reviewer_reads_done_private_history_without_effects",
    async () => {
      const f = await fixture(FIX.reviewer, { state: "done" }),
        before = await effects();
      const guarded = afterTaskRead(binding, async () => {
        await delay(250);
      });
      const reply = await call(f, guarded.db);
      assert(guarded.state.reached);
      assert.notEqual(reply.isError, true);
      assert.deepEqual(reply.body, { task: f.task });
      assert.equal(f.task.state, "done");
      assert.deepEqual(await effects(), before);
    },
  );

  await check(
    "real_d1_mounted_production_revocation_after_preliminary_task_withholds_body",
    async () => {
      const f = await fixture(),
        originalCursor = await cursor();
      let before: Effects | undefined,
        mutationApplied = false;
      const guarded = afterTaskRead(binding, async () => {
        const now = new Date().toISOString();
        await revokeDelegation(independent, FIX.workspace, f.delegationId, now);
        assert.deepEqual(
          await independent
            .prepare("SELECT revoked_at FROM oauth_delegations WHERE workspace_id=? AND id=?")
            .get(FIX.workspace, f.delegationId),
          { revoked_at: now },
        );
        assert.deepEqual(await cursor(), originalCursor);
        mutationApplied = true;
        before = await effects();
      });
      const reply = await call(f, guarded.db);
      assert(guarded.state.reached && mutationApplied);
      denied(f, reply);
      assert.deepEqual(await effects(), before);
    },
  );

  await check(
    "real_d1_mounted_read_only_owner_member_preserve_ready_cancelled_history",
    async () => {
      for (const [humanId, state] of [
        [FIX.owner, "ready"],
        [FIX.member, "cancelled"],
      ] as const) {
        const f = await fixture(humanId, { state }),
          before = await effects();
        const guarded = afterTaskRead(binding, async () => {});
        const reply = await call(f, guarded.db);
        assert(guarded.state.reached);
        assert.notEqual(reply.isError, true);
        assert.deepEqual(reply.body, { task: f.task });
        assert.deepEqual(await effects(), before);
      }
    },
  );

  await check(
    "real_d1_mounted_reads_new_canonical_hub_task_edit_after_preliminary_selection",
    async () => {
      const f = await fixture();
      let current: TaskRecord | undefined, before: Effects | undefined;
      const guarded = afterTaskRead(binding, async () => {
        current = success(
          await execute<TaskRecord>(
            "task.update",
            await human({
              taskId: f.task.id,
              expectedVersion: f.task.resource_version,
              title: `${canary}-EDITED`,
              punchline: `${canary}-PUNCHLINE`,
              priority: "P1",
            }),
          ),
        );
        assert.equal(current.resource_version, f.task.resource_version + 1);
        assert.notEqual(current.title, f.task.title);
        // The independent private-owner edit has its own canonical effects and cursor advance.
        before = await effects();
      });
      const reply = await call(f, guarded.db);
      assert(guarded.state.reached && current);
      assert.notEqual(reply.isError, true);
      assert.deepEqual(reply.body, { task: current });
      assert.deepEqual(await effects(), before);
    },
  );

  await check("real_d1_mounted_current_read_scope_loss_withholds_task_body", async () => {
    const f = await fixture(),
      scopes = JSON.stringify(["bfb:task:write", "offline_access"]);
    await denyAfter(f, "preliminary", async () => {
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

  await check("real_d1_mounted_current_client_mismatch_withholds_task_body", async () => {
    const f = await fixture(),
      clientId = `synthetic-alternate-${randomUlid()}`;
    await db
      .prepare(
        "INSERT INTO better_auth_oauth_clients (id,client_id,redirect_uris,disabled) VALUES (?,?,?,0)",
      )
      .run(randomUlid(), clientId, JSON.stringify(["http://127.0.0.1:9999/callback"]));
    await denyAfter(f, "preliminary", async () => {
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

  for (const variant of [
    "null_project_to_project",
    "null_task_to_unrelated",
    "project_to_null",
    "task_to_null",
  ] as const) {
    await check(
      `real_d1_mounted_original_nullable_boundary_${variant}_withholds_task_body`,
      async () => {
        const f = await fixture(
          FIX.owner,
          variant === "null_project_to_project"
            ? { projectBoundary: null, taskBoundary: null }
            : variant === "null_task_to_unrelated"
              ? { taskBoundary: null }
              : {},
        );
        const unrelated = variant === "null_task_to_unrelated" ? await createTask() : undefined;
        if (unrelated) assert.notEqual(unrelated.id, f.task.id);
        const projectId = variant === "project_to_null" ? null : FIX.projectA;
        const taskId = variant === "null_task_to_unrelated" ? unrelated!.id : null;
        await denyAfter(f, "preliminary", async () => {
          await independent
            .prepare(
              "UPDATE oauth_delegations SET project_id=?,task_id=? WHERE workspace_id=? AND id=?",
            )
            .run(projectId, taskId, FIX.workspace, f.delegationId);
          assert.deepEqual(
            await independent
              .prepare(
                "SELECT project_id,task_id FROM oauth_delegations WHERE workspace_id=? AND id=?",
              )
              .get(FIX.workspace, f.delegationId),
            { project_id: projectId, task_id: taskId },
          );
        });
      },
    );
  }

  await check(
    "real_d1_mounted_private_target_read_grant_revoked_after_successful_advisory_withholds_task_body",
    async () => {
      const f = await fixture();
      assert(f.grantId);
      await denyAfter(f, "advisory", () => revokeGrant(f.grantId!));
    },
  );

  await check(
    "real_d1_mounted_production_epoch_bump_after_successful_advisory_withholds_task_body",
    async () => {
      const f = await fixture();
      await denyAfter(f, "advisory", async () => {
        assert.equal(await bumpMemberEpoch(independent, FIX.workspace, f.humanId), f.epoch + 1);
        assert.equal(
          (await loadPrincipal(independent, FIX.workspace, f.humanId)).authorizationEpoch,
          f.epoch + 1,
        );
      });
    },
  );

  await check(
    "real_d1_mounted_current_project_loss_after_successful_advisory_withholds_task_body",
    async () => {
      const f = await fixture();
      const originalProject = (await db
        .prepare("SELECT access_mode FROM projects WHERE workspace_id=? AND id=?")
        .get(FIX.workspace, FIX.projectA)) as { access_mode: string };
      const originalGrant = await db
        .prepare(
          "SELECT * FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?",
        )
        .get(FIX.workspace, FIX.projectA, f.humanId);
      try {
        await denyAfter(f, "advisory", async () => {
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
    },
  );

  await check(
    "real_d1_mounted_unchanged_credential_expires_after_final_task_sql_is_prepared",
    async () => {
      const f = await fixture(FIX.owner, { expiryModifier: "+4 seconds" }),
        original = await credential(f),
        before = await effects();
      let arrival: string | undefined, flush: string | undefined;
      const guarded = afterTaskRead(binding, async () => {}, {
        beforeFinal: async () => {
          arrival = (
            (await db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now").get()) as {
              now: string;
            }
          ).now;
          assert(arrival < f.expires_at, "credential must remain live after final SQL preparation");
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
    "real_d1_mounted_delayed_prepared_final_task_selection_preserves_live_history",
    async () => {
      const f = await fixture(FIX.reviewer, { state: "cancelled" }),
        original = await credential(f),
        before = await effects();
      const guarded = afterTaskRead(binding, async () => {}, {
        beforeFinal: async () => {
          await delay(250);
          const now = (
            (await db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now").get()) as {
              now: string;
            }
          ).now;
          assert(now < f.expires_at);
          assert.deepEqual(await credential(f), original);
        },
      });
      const reply = await call(f, guarded.db);
      assert(guarded.state.reached && guarded.state.finalPrepared);
      assert.notEqual(reply.isError, true);
      assert.deepEqual(reply.body, { task: f.task });
      assert.deepEqual(await effects(), before);
    },
  );

  await check(
    "real_d1_mounted_parent_only_grant_loss_after_advisory_remasks_shared_child",
    async () => {
      const parent = await createTask(),
        f = await fixture(FIX.owner, { parent, shared: true, taskBoundary: null });
      const parentGrant = await makePrivate(parent.id, f.humanId),
        originalCursor = await cursor();
      let before: Effects | undefined,
        mutationApplied = false;
      const guarded = afterTaskRead(binding, async () => {}, {
        afterAdvisory: async () => {
          await revokeGrant(parentGrant);
          assert.deepEqual(await cursor(), originalCursor);
          mutationApplied = true;
          before = await effects();
        },
      });
      const reply = await call(f, guarded.db);
      assert(guarded.state.reached && guarded.state.advisoryReached && mutationApplied);
      assert.notEqual(reply.isError, true);
      assert.deepEqual(reply.body, { task: { ...f.task, parent_task_id: null } });
      assert(!reply.text.includes(parent.id), "unreadable parent identity must not be delivered");
      assert.deepEqual(await effects(), before);
    },
  );

  await check(
    "real_d1_mounted_healthy_task_root_boundary_redacts_its_out_of_subtree_parent",
    async () => {
      const parent = await createTask(),
        f = await fixture(FIX.owner, { parent, shared: true }),
        before = await effects();
      const guarded = afterTaskRead(binding, async () => {});
      const reply = await call(f, guarded.db);
      assert(guarded.state.reached);
      assert.notEqual(reply.isError, true);
      assert.deepEqual(reply.body, { task: { ...f.task, parent_task_id: null } });
      assert(!reply.text.includes(parent.id));
      assert.deepEqual(await effects(), before);
    },
  );

  await check(
    "real_d1_mounted_missing_and_current_private_denial_have_identical_task_delivery",
    async () => {
      const f = await fixture();
      assert(f.grantId);
      await revokeGrant(f.grantId);
      const before = await effects(),
        missing = await call(f, db, randomUlid()),
        hidden = await call(f, db);
      denied(f, missing);
      denied(f, hidden);
      assert.deepEqual(hidden, missing);
      assert.deepEqual(await effects(), before);
    },
  );

  await check(
    "real_d1_mounted_already_denied_preliminary_null_uses_canonical_task_error_wire",
    async () => {
      const f = await fixture(),
        originalCursor = await cursor();
      assert(f.grantId);
      let before: Effects | undefined,
        mutationApplied = false;
      const guarded = afterTaskRead(binding, async () => {}, {
        afterInitial: async () => {
          await revokeGrant(f.grantId!);
          assert.deepEqual(await cursor(), originalCursor);
          mutationApplied = true;
          before = await effects();
        },
      });
      const reply = await call(f, guarded.db);
      assert(guarded.state.initialReached && !guarded.state.reached && mutationApplied);
      // Old code already withheld this body but used a different JSON error than initial absence.
      denied(f, reply);
      assert.deepEqual(await effects(), before);
    },
  );

  await check(
    "real_d1_mounted_already_denied_pre_advisory_epoch_loss_uses_canonical_task_error_wire",
    async () => {
      const f = await fixture();
      await denyAfter(f, "preliminary", async () => {
        assert.equal(await bumpMemberEpoch(independent, FIX.workspace, f.humanId), f.epoch + 1);
        assert.equal(
          (await loadPrincipal(independent, FIX.workspace, f.humanId)).authorizationEpoch,
          f.epoch + 1,
        );
      });
      // Advisory authority already denies this old path; this is uniform-wire proof, not a new exposure.
    },
  );

  console.log(
    JSON.stringify({
      schema_version: 1,
      stage: "delegated_task_read_delivery",
      migration_head: manifest.migration_head,
      checks,
      failures,
      ...bounds,
      outcome: failures.length ? "failed" : "passed",
      limits: [
        "compiled genuine OAuth handler mounted in the test process; not real HTTP OAuth ingress",
        "disposable native D1, synthetic dormant privacy/grants; no run, runner or provider operation",
        "final task read boundary only; no private activation or other OAuth response certification",
      ],
    }),
  );
  assert.equal(failures.length, 0, "delegated task read D1 checks failed");
  console.log("C11_DELEGATED_TASK_DELIVERY_D1_OK");
} finally {
  await server.close();
}
