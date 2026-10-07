// ABOUTME: Exercises delegated list selection through mounted OAuth MCP and disposable native D1.
// ABOUTME: Witnessed authority changes retain canonical pages and business history without execution fixtures.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
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
  type ProjectRecord,
  type TaskRecord,
} from "@bfb/domain";
import { createTestHarness } from "wrangler";
import { handleMcpRequest } from "../../apps/control-worker/dist/mcp/handler.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const origin = "https://bfb.example.test";
const canary = "SYNTHETIC-C11-DELEGATED-LIST";
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
type Tool = "bfb_list_projects" | "bfb_list_tasks";
interface ProjectPage {
  projects: ProjectRecord[];
  hasMore: boolean;
  nextCursor?: string;
}
interface TaskPage {
  tasks: TaskRecord[];
  limit: number;
  has_more: boolean;
  next_cursor?: string;
}

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
        : first?.includes("mcp_")
          ? "synthetic credential omitted"
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
function afterProjectCapture(
  binding: D1Like,
  after: () => Promise<void>,
  hooks: {
    afterAdvisory?: () => Promise<void>;
    beforeFinal?: () => Promise<void>;
  } = {},
) {
  const state = {
    reached: false,
    advisoryReached: false,
    finalPrepared: false,
    capturedProjectIds: [] as string[],
  };
  const nativeDb = adaptD1({
    prepare(sql) {
      const bytes = Buffer.byteLength(sql);
      bounds.maximum_statement_bytes = Math.max(bounds.maximum_statement_bytes, bytes);
      assert(bytes <= 100_000, "delegated list SQL must retain its checked statement bound");
      const native = binding.prepare(sql);
      const statement: D1StatementLike = {
        bind(...parameters) {
          bounds.maximum_bindings = Math.max(bounds.maximum_bindings, parameters.length);
          assert(
            parameters.length <= 100,
            "delegated list SQL must retain its checked binding bound",
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
        const collection =
          sql.includes("repository_subpath") ||
          (sql.includes("task.title") && sql.includes("task.resource_version"));
        return {
          run: (...parameters) => statement.run(...parameters),
          async get(...parameters) {
            const row = await statement.get(...parameters);
            if (
              state.reached &&
              !state.advisoryReached &&
              hooks.afterAdvisory &&
              sql.includes("task.id AS taskId") &&
              row !== null &&
              row !== undefined
            ) {
              state.advisoryReached = true;
              await hooks.afterAdvisory();
            }
            return row;
          },
          async all(...parameters) {
            if (state.reached && collection && hooks.beforeFinal && !state.finalPrepared) {
              // SQL and arguments are retained before the await and actual native binding/execution.
              state.finalPrepared = true;
              await hooks.beforeFinal();
            }
            const rows = await statement.all(...parameters);
            if (
              !state.reached &&
              sql.includes("SELECT projects.id") &&
              sql.includes("LEFT JOIN project_access")
            ) {
              state.reached = true;
              state.capturedProjectIds = (rows as Array<{ id: string }>).map((row) => row.id);
              await after();
            }
            return rows;
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
  async function createTask(parentTaskId?: string, projectId = FIX.projectA, humanId = FIX.member) {
    return success(
      await execute<TaskRecord>(
        "task.create",
        await human(
          {
            projectId,
            title: `${canary}-TASK`,
            priority: "P2",
            ...(parentTaskId === undefined ? {} : { parentTaskId }),
          },
          humanId,
        ),
      ),
    );
  }
  async function createProject(accessMode: "workspace" | "restricted" = "workspace") {
    const identity = randomUlid().toLowerCase();
    return success(
      await execute<ProjectRecord>(
        "project.create",
        await human(
          {
            name: `${canary}-PROJECT`,
            slug: `list-${identity}`,
            tint: "#84CC16",
            accessMode,
            repositoryHost: "synthetic",
            hostedRepositoryId: identity,
            repositorySubpath: ".",
          },
          FIX.owner,
        ),
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
    return {
      accessToken,
      delegationId,
      humanId,
      epoch: principal.authorizationEpoch,
      projectBoundary: projectId,
      taskBoundary: taskId,
      ...clock,
    };
  }

  async function fixture(
    humanId = FIX.owner,
    options: {
      projectBoundary?: string | null;
      taskBoundary?: string | null;
      expiryModifier?: string;
      projectId?: string;
      parent?: TaskRecord;
      rooted?: boolean;
      state?: "done" | "cancelled";
    } = {},
  ) {
    let task = await createTask(options.parent?.id, options.projectId ?? FIX.projectA);
    for (const state of options.state === "done"
      ? ["active", "review", "done"]
      : options.state === "cancelled"
        ? ["cancelled"]
        : [])
      task = success(
        await execute<TaskRecord>(
          "task.update",
          await human({ taskId: task.id, expectedVersion: task.resource_version, state }),
        ),
      );
    const access = await issueAccess(
      humanId,
      options.projectBoundary === undefined ? task.project_id : options.projectBoundary,
      options.taskBoundary === undefined ? (options.rooted ? task.id : null) : options.taskBoundary,
      options.expiryModifier,
    );
    return { task, ...access };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function call(
    f: Fixture,
    queryDb: SqlDatabase,
    tool: Tool,
    args: Record<string, unknown> = {},
  ) {
    const response = await handleMcpRequest(
      new Request(`${origin}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/call",
          "Mcp-Name": tool,
          Host: "bfb.example.test",
          authorization: `Bearer ${f.accessToken}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: tool,
            arguments: args,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": {
                name: "bfb-synthetic-list-delivery",
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
        abuseSecret: "c11-synthetic-list-delivery-abuse-secret-b4913c",
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
    let body: ProjectPage | TaskPage | undefined;
    try {
      body = JSON.parse(text!) as typeof body;
    } catch {
      /* Canonical SDK domain errors are plain text. */
    }
    return { body, text: text!, isError: reply.result?.isError };
  }
  function denied(f: Fixture, reply: Awaited<ReturnType<typeof call>>) {
    assert.equal(reply.isError, true);
    assert.equal(reply.text, "delegated list not available");
    assert.equal(reply.body, undefined);
    for (const prohibited of [canary, f.task.id, f.task.project_id])
      assert(
        !reply.text.includes(prohibited),
        "denied reply must contain no collection identity or body",
      );
  }
  function projectPage(reply: Awaited<ReturnType<typeof call>>): ProjectPage {
    assert.notEqual(reply.isError, true);
    assert(reply.body && "projects" in reply.body);
    return reply.body;
  }
  function taskPage(reply: Awaited<ReturnType<typeof call>>): TaskPage {
    assert.notEqual(reply.isError, true);
    assert(reply.body && "tasks" in reply.body);
    return reply.body;
  }
  async function credential(f: Fixture) {
    return db
      .prepare("SELECT * FROM oauth_delegations WHERE workspace_id=? AND id=?")
      .get(FIX.workspace, f.delegationId);
  }
  async function databaseNow() {
    return (
      (await db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now").get()) as {
        now: string;
      }
    ).now;
  }
  async function makePrivate(taskId: string, humanId: string) {
    const principal = await loadPrincipal(db, FIX.workspace, humanId),
      grantId = randomUlid(),
      now = new Date().toISOString();
    // Dormant policies and named read grants are synthetic fixtures, not new ACL commands.
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
    tool: Tool,
    mutate: () => Promise<void>,
    args: Record<string, unknown> = {},
    cut: "capture" | "advisory" = "capture",
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
    const guarded = afterProjectCapture(
      binding,
      cut === "capture" ? witness : async () => {},
      cut === "advisory" ? { afterAdvisory: witness } : {},
    );
    const reply = await call(f, guarded.db, tool, args);
    assert(guarded.state.reached && mutationApplied);
    if (cut === "advisory") assert(guarded.state.advisoryReached);
    denied(f, reply);
    assert.deepEqual(await effects(), before);
  }

  await check(
    "real_d1_mounted_read_only_reviewer_reads_canonical_project_and_task_pages_without_effects",
    async () => {
      const f = await fixture(FIX.reviewer),
        before = await effects();
      const expectedProject = (await db
        .prepare(
          `SELECT id,name,slug,tint,access_mode,repository_host,
      hosted_repository_id,repository_subpath,resource_version FROM projects WHERE workspace_id=? AND id=?`,
        )
        .get(FIX.workspace, FIX.projectA)) as ProjectRecord;
      const projects = afterProjectCapture(binding, async () => {});
      const projectReply = await call(f, projects.db, "bfb_list_projects");
      assert(projects.state.reached);
      assert.notEqual(projectReply.isError, true);
      assert.deepEqual(projectReply.body, { projects: [expectedProject], hasMore: false });
      const tasks = afterProjectCapture(binding, async () => {});
      const taskReply = await call(f, tasks.db, "bfb_list_tasks");
      assert(tasks.state.reached);
      assert.notEqual(taskReply.isError, true);
      assert.deepEqual(taskReply.body, { tasks: [f.task], limit: 50, has_more: false });
      assert.deepEqual(await effects(), before);
    },
  );

  await check(
    "real_d1_mounted_production_revocation_after_project_capture_withholds_project_metadata",
    async () => {
      const f = await fixture(),
        originalCursor = await cursor();
      let before: Effects | undefined,
        mutationApplied = false;
      const guarded = afterProjectCapture(binding, async () => {
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
      const reply = await call(f, guarded.db, "bfb_list_projects");
      assert(guarded.state.reached && mutationApplied);
      denied(f, reply);
      assert.deepEqual(await effects(), before);
    },
  );

  await check(
    "real_d1_mounted_authorized_empty_capture_is_not_revoked_empty_authority",
    async () => {
      const originalGrants = (await db
        .prepare("SELECT project_id FROM project_access WHERE workspace_id=? AND human_id=?")
        .all(FIX.workspace, FIX.reviewer)) as Array<{ project_id: string }>;
      await db
        .prepare("DELETE FROM project_access WHERE workspace_id=? AND human_id=?")
        .run(FIX.workspace, FIX.reviewer);
      try {
        const f = await fixture(FIX.reviewer, { projectBoundary: null }),
          before = await effects();
        const projects = afterProjectCapture(binding, async () => {});
        assert.deepEqual(projectPage(await call(f, projects.db, "bfb_list_projects")), {
          projects: [],
          hasMore: false,
        });
        assert(projects.state.reached && projects.state.capturedProjectIds.length === 0);
        const tasks = afterProjectCapture(binding, async () => {});
        assert.deepEqual(taskPage(await call(f, tasks.db, "bfb_list_tasks")), {
          tasks: [],
          limit: 50,
          has_more: false,
        });
        assert(tasks.state.reached && tasks.state.capturedProjectIds.length === 0);
        assert.deepEqual(await effects(), before);
        await denyAfter(f, "bfb_list_projects", async () => {
          const now = await databaseNow();
          await revokeDelegation(independent, FIX.workspace, f.delegationId, now);
          assert.deepEqual(
            await independent
              .prepare("SELECT revoked_at FROM oauth_delegations WHERE workspace_id=? AND id=?")
              .get(FIX.workspace, f.delegationId),
            { revoked_at: now },
          );
        });
        const second = { ...f, ...(await issueAccess(FIX.reviewer, null, null)) };
        await denyAfter(second, "bfb_list_tasks", async () => {
          const now = await databaseNow();
          await revokeDelegation(independent, FIX.workspace, second.delegationId, now);
          assert.deepEqual(
            await independent
              .prepare("SELECT revoked_at FROM oauth_delegations WHERE workspace_id=? AND id=?")
              .get(FIX.workspace, second.delegationId),
            { revoked_at: now },
          );
        });
      } finally {
        for (const row of originalGrants)
          await db
            .prepare("INSERT INTO project_access (workspace_id,project_id,human_id) VALUES (?,?,?)")
            .run(FIX.workspace, row.project_id, FIX.reviewer);
      }
    },
  );

  await check(
    "real_d1_mounted_current_project_grant_and_policy_filter_before_lookahead",
    async () => {
      for (const variant of ["grant", "policy"] as const) {
        const project = await createProject(variant === "grant" ? "restricted" : "workspace");
        if (variant === "grant")
          for (const humanId of [FIX.member, FIX.reviewer])
            await db
              .prepare(
                "INSERT INTO project_access (workspace_id,project_id,human_id) VALUES (?,?,?)",
              )
              .run(FIX.workspace, project.id, humanId);
        const f = await fixture(FIX.reviewer, { projectId: project.id }),
          originalCursor = await cursor();
        let before: Effects | undefined;
        const guarded = afterProjectCapture(binding, async () => {
          if (variant === "grant")
            await independent
              .prepare(
                "DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?",
              )
              .run(FIX.workspace, project.id, f.humanId);
          else
            await independent
              .prepare("UPDATE projects SET access_mode='restricted' WHERE workspace_id=? AND id=?")
              .run(FIX.workspace, project.id);
          assert(
            !(await loadPrincipal(independent, FIX.workspace, f.humanId)).projectIds.includes(
              project.id,
            ),
          );
          assert.deepEqual(await cursor(), originalCursor);
          before = await effects();
        });
        const reply = await call(f, guarded.db, "bfb_list_projects", { limit: 1 });
        assert(guarded.state.reached && guarded.state.capturedProjectIds.includes(project.id));
        assert.deepEqual(projectPage(reply), { projects: [], hasMore: false });
        assert(!reply.text.includes(project.id) && !reply.text.includes(project.name));
        assert.deepEqual(await effects(), before);
      }
    },
  );

  await check("real_d1_mounted_captured_project_subset_does_not_adopt_a_new_grant", async () => {
    const project = await createProject("restricted");
    await db
      .prepare("DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?")
      .run(FIX.workspace, project.id, FIX.owner);
    const f = await fixture(FIX.owner, { projectBoundary: null }),
      originalCursor = await cursor();
    let before: Effects | undefined;
    const guarded = afterProjectCapture(binding, async () => {
      await independent
        .prepare("INSERT INTO project_access (workspace_id,project_id,human_id) VALUES (?,?,?)")
        .run(FIX.workspace, project.id, f.humanId);
      assert(
        (await loadPrincipal(independent, FIX.workspace, f.humanId)).projectIds.includes(
          project.id,
        ),
      );
      assert.deepEqual(await cursor(), originalCursor);
      before = await effects();
    });
    const reply = await call(f, guarded.db, "bfb_list_projects", { limit: 100 }),
      page = projectPage(reply);
    assert(guarded.state.reached && !guarded.state.capturedProjectIds.includes(project.id));
    assert.deepEqual(
      page.projects.map((row) => row.id),
      guarded.state.capturedProjectIds,
    );
    assert.equal(page.hasMore, false);
    assert.equal(page.nextCursor, undefined);
    assert(!reply.text.includes(project.id));
    assert.deepEqual(await effects(), before);
  });

  await check("real_d1_mounted_current_task_read_scope_loss_withholds_page", async () => {
    const f = await fixture(),
      scopes = JSON.stringify(["bfb:task:write", "offline_access"]);
    await denyAfter(f, "bfb_list_tasks", async () => {
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

  await check("real_d1_mounted_current_task_client_mismatch_withholds_page", async () => {
    const f = await fixture(),
      clientId = `synthetic-list-alternate-${randomUlid()}`;
    await db
      .prepare(
        "INSERT INTO better_auth_oauth_clients (id,client_id,redirect_uris,disabled) VALUES (?,?,?,0)",
      )
      .run(randomUlid(), clientId, JSON.stringify(["http://127.0.0.1:9999/callback"]));
    await denyAfter(f, "bfb_list_tasks", async () => {
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
    "project_to_null",
    "null_task_to_task",
    "task_to_null",
  ] as const)
    await check(
      `real_d1_mounted_${variant.includes("task") ? "already_body_denied_" : ""}original_nullable_ceiling_${variant}_withholds_task_page`,
      async () => {
        const f = await fixture(FIX.owner, {
          projectBoundary: variant === "null_project_to_project" ? null : FIX.projectA,
          rooted: variant === "task_to_null",
        });
        const projectId = variant === "project_to_null" ? null : FIX.projectA,
          taskId = variant === "null_task_to_task" ? f.task.id : null;
        // Task-ceiling changes were already body-denied by the old kernel; the fixed error wire is new.
        await denyAfter(
          f,
          "bfb_list_tasks",
          async () => {
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
          },
          {},
          variant === "task_to_null" ? "advisory" : "capture",
        );
      },
    );

  await check(
    "real_d1_mounted_rooted_scope_loss_after_successful_advisory_withholds_page",
    async () => {
      const f = await fixture(FIX.owner, { rooted: true }),
        scopes = JSON.stringify(["bfb:task:write", "offline_access"]);
      await denyAfter(
        f,
        "bfb_list_tasks",
        async () => {
          await independent
            .prepare("UPDATE oauth_delegations SET scopes_json=? WHERE workspace_id=? AND id=?")
            .run(scopes, FIX.workspace, f.delegationId);
          assert.deepEqual(
            await independent
              .prepare("SELECT scopes_json FROM oauth_delegations WHERE workspace_id=? AND id=?")
              .get(FIX.workspace, f.delegationId),
            { scopes_json: scopes },
          );
        },
        {},
        "advisory",
      );
    },
  );

  await check(
    "real_d1_mounted_already_body_denied_epoch_loss_uses_collection_error_wire",
    async () => {
      const f = await fixture(FIX.member);
      await denyAfter(f, "bfb_list_tasks", async () => {
        assert.equal(await bumpMemberEpoch(independent, FIX.workspace, f.humanId), f.epoch + 1);
        assert.equal(
          (await loadPrincipal(independent, FIX.workspace, f.humanId)).authorizationEpoch,
          f.epoch + 1,
        );
        assert.deepEqual(
          await independent
            .prepare(
              "SELECT authorization_epoch FROM oauth_delegations WHERE workspace_id=? AND id=?",
            )
            .get(FIX.workspace, f.delegationId),
          { authorization_epoch: f.epoch },
        );
      });
    },
  );

  await check("real_d1_mounted_current_membership_loss_withholds_project_page", async () => {
    const f = await fixture(FIX.reviewer),
      membership = (await db
        .prepare(
          "SELECT role,authorization_epoch,created_at FROM workspace_members WHERE workspace_id=? AND human_id=?",
        )
        .get(FIX.workspace, f.humanId)) as {
        role: string;
        authorization_epoch: number;
        created_at: string;
      },
      projectGrants = (await db
        .prepare("SELECT project_id FROM project_access WHERE workspace_id=? AND human_id=?")
        .all(FIX.workspace, f.humanId)) as Array<{ project_id: string }>;
    try {
      await denyAfter(f, "bfb_list_projects", async () => {
        await independent
          .prepare("DELETE FROM project_access WHERE workspace_id=? AND human_id=?")
          .run(FIX.workspace, f.humanId);
        await independent
          .prepare("DELETE FROM workspace_members WHERE workspace_id=? AND human_id=?")
          .run(FIX.workspace, f.humanId);
        assert.equal(
          await independent
            .prepare("SELECT human_id FROM workspace_members WHERE workspace_id=? AND human_id=?")
            .get(FIX.workspace, f.humanId),
          null,
        );
      });
    } finally {
      await db
        .prepare(
          "INSERT INTO workspace_members (workspace_id,human_id,role,authorization_epoch,created_at) VALUES (?,?,?,?,?)",
        )
        .run(
          FIX.workspace,
          f.humanId,
          membership.role,
          membership.authorization_epoch,
          membership.created_at,
        );
      for (const row of projectGrants)
        await db
          .prepare("INSERT INTO project_access (workspace_id,project_id,human_id) VALUES (?,?,?)")
          .run(FIX.workspace, row.project_id, f.humanId);
    }
  });

  await check(
    "real_d1_mounted_cursor_terminal_pages_are_positive_but_revoked_terminal_is_not",
    async () => {
      const f = await fixture(),
        args = { limit: 1, cursor: "7ZZZZZZZZZZZZZZZZZZZZZZZZZ" },
        before = await effects();
      assert.deepEqual(
        projectPage(
          await call(f, afterProjectCapture(binding, async () => {}).db, "bfb_list_projects", args),
        ),
        { projects: [], hasMore: false },
      );
      assert.deepEqual(
        taskPage(
          await call(f, afterProjectCapture(binding, async () => {}).db, "bfb_list_tasks", args),
        ),
        { tasks: [], limit: 1, has_more: false },
      );
      assert.deepEqual(await effects(), before);
      await denyAfter(
        f,
        "bfb_list_tasks",
        async () => {
          const now = await databaseNow();
          await revokeDelegation(independent, FIX.workspace, f.delegationId, now);
          assert.deepEqual(
            await independent
              .prepare("SELECT revoked_at FROM oauth_delegations WHERE workspace_id=? AND id=?")
              .get(FIX.workspace, f.delegationId),
            { revoked_at: now },
          );
        },
        args,
      );
    },
  );

  await check(
    "real_d1_mounted_already_pruned_private_root_loss_denies_before_terminal_cursor",
    async () => {
      const f = await fixture(FIX.owner, { rooted: true }),
        grantId = await makePrivate(f.task.id, f.humanId);
      await denyAfter(
        f,
        "bfb_list_tasks",
        () => revokeGrant(grantId),
        { limit: 1, cursor: "7ZZZZZZZZZZZZZZZZZZZZZZZZZ" },
        "advisory",
      );
    },
  );

  await check(
    "real_d1_mounted_unchanged_credentials_expire_after_prepared_project_and_task_sql",
    async () => {
      for (const tool of ["bfb_list_projects", "bfb_list_tasks"] as const) {
        const f = await fixture(FIX.owner, { expiryModifier: "+4 seconds" }),
          original = await credential(f),
          before = await effects();
        let arrival: string | undefined, flush: string | undefined;
        const guarded = afterProjectCapture(binding, async () => {}, {
          beforeFinal: async () => {
            arrival = await databaseNow();
            assert(
              arrival < f.expires_at,
              "credential must be live after final SQL and arguments are prepared",
            );
            const deadline = Date.now() + 6_000;
            do {
              await delay(50);
              flush = await databaseNow();
              assert(Date.now() < deadline, "natural expiry wait must remain bounded");
            } while (flush < f.expires_at);
            assert.deepEqual(await credential(f), original);
          },
        });
        const reply = await call(f, guarded.db, tool);
        assert(guarded.state.reached && guarded.state.finalPrepared && arrival && flush);
        assert(arrival < f.expires_at && flush >= f.expires_at);
        denied(f, reply);
        assert.deepEqual(await effects(), before);
        assert.deepEqual(await credential(f), original);
      }
    },
  );

  await check(
    "real_d1_mounted_read_only_roles_current_role_and_delayed_completed_history_remain_readable",
    async () => {
      for (const humanId of [FIX.owner, FIX.member, FIX.reviewer]) {
        const project = await createProject(),
          f = await fixture(humanId, {
            projectId: project.id,
            state: humanId === FIX.member ? "cancelled" : "done",
          }),
          original = await credential(f),
          originalCursor = await cursor();
        let before = await effects();
        const guarded = afterProjectCapture(
          binding,
          async () => {
            if (humanId === FIX.member) {
              await independent
                .prepare(
                  "UPDATE workspace_members SET role='reviewer' WHERE workspace_id=? AND human_id=?",
                )
                .run(FIX.workspace, humanId);
              assert.equal(
                (await loadPrincipal(independent, FIX.workspace, humanId)).role,
                "reviewer",
              );
              assert.deepEqual(await cursor(), originalCursor);
              before = await effects();
            }
          },
          {
            beforeFinal: async () => {
              await delay(250);
              assert((await databaseNow()) < f.expires_at);
              assert.deepEqual(await credential(f), original);
            },
          },
        );
        try {
          const reply = await call(f, guarded.db, "bfb_list_tasks");
          assert(guarded.state.reached && guarded.state.finalPrepared);
          assert.deepEqual(taskPage(reply), { tasks: [f.task], limit: 50, has_more: false });
          assert.deepEqual(await effects(), before);
        } finally {
          if (humanId === FIX.member)
            await db
              .prepare(
                "UPDATE workspace_members SET role='member' WHERE workspace_id=? AND human_id=?",
              )
              .run(FIX.workspace, humanId);
        }
      }
    },
  );

  await check(
    "real_d1_mounted_canonical_hub_edit_after_project_capture_returns_current_task",
    async () => {
      const project = await createProject(),
        f = await fixture(FIX.reviewer, { projectId: project.id }),
        originalCursor = await cursor();
      let current: TaskRecord | undefined, before: Effects | undefined;
      const guarded = afterProjectCapture(binding, async () => {
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
        assert.notDeepEqual(await cursor(), originalCursor);
        before = await effects();
      });
      const reply = await call(f, guarded.db, "bfb_list_tasks");
      assert(guarded.state.reached && current);
      assert.deepEqual(taskPage(reply), { tasks: [current], limit: 50, has_more: false });
      assert.deepEqual(await effects(), before);
    },
  );

  await check(
    "real_d1_mounted_retained_private_before_limit_and_readable_branch_parent_masks",
    async () => {
      const project = await createProject(),
        rows: TaskRecord[] = [];
      for (let i = 0; i < 3; i++) rows.push(await createTask(undefined, project.id));
      rows.sort((a, b) => (a.id < b.id ? -1 : 1));
      const [hidden, named, shared] = rows as [TaskRecord, TaskRecord, TaskRecord],
        hiddenGrant = await makePrivate(hidden.id, FIX.owner);
      await makePrivate(named.id, FIX.owner);
      const f = { task: named, ...(await issueAccess(FIX.owner, project.id, null)) },
        originalCursor = await cursor();
      let before: Effects | undefined;
      const guarded = afterProjectCapture(binding, async () => {
        await revokeGrant(hiddenGrant);
        assert.deepEqual(await cursor(), originalCursor);
        before = await effects();
      });
      const first = await call(f, guarded.db, "bfb_list_tasks", { limit: 1 });
      assert(guarded.state.reached);
      assert.deepEqual(taskPage(first), {
        tasks: [named],
        limit: 1,
        has_more: true,
        next_cursor: named.id,
      });
      assert(!first.text.includes(hidden.id));
      assert.deepEqual(await effects(), before);
      const next = await call(
        f,
        afterProjectCapture(binding, async () => {}).db,
        "bfb_list_tasks",
        { limit: 1, cursor: named.id },
      );
      assert.deepEqual(taskPage(next), { tasks: [shared], limit: 1, has_more: false });
      assert.deepEqual(await effects(), before);

      const rootedProject = await createProject(),
        external = await createTask(undefined, rootedProject.id),
        rooted = await fixture(FIX.owner, {
          projectId: rootedProject.id,
          parent: external,
          rooted: true,
        }),
        readableChild = await createTask(rooted.task.id, rootedProject.id),
        privateBranch = await createTask(rooted.task.id, rootedProject.id),
        grandchild = await createTask(privateBranch.id, rootedProject.id),
        branchGrant = await makePrivate(privateBranch.id, rooted.humanId),
        rootedCursor = await cursor();
      const pruned = afterProjectCapture(binding, async () => {}, {
        afterAdvisory: async () => {
          await revokeGrant(branchGrant);
          assert.deepEqual(await cursor(), rootedCursor);
          before = await effects();
        },
      });
      const reply = await call(rooted, pruned.db, "bfb_list_tasks"),
        expected = [{ ...rooted.task, parent_task_id: null }, readableChild].sort((a, b) =>
          a.id < b.id ? -1 : 1,
        );
      assert(pruned.state.reached && pruned.state.advisoryReached);
      assert.deepEqual(taskPage(reply), { tasks: expected, limit: 50, has_more: false });
      for (const prohibited of [external.id, privateBranch.id, grandchild.id])
        assert(!reply.text.includes(prohibited));
      assert.deepEqual(await effects(), before);
    },
  );

  await check(
    "real_d1_mounted_large_captured_project_sets_keep_native_statement_bounds",
    async () => {
      const now = await databaseNow();
      // Capacity-only synthetic project/grant rows avoid unrelated business commands; no tasks are fabricated.
      for (let i = 0; i < 120; i++) {
        const id = randomUlid();
        await db
          .prepare(
            `INSERT INTO projects
        (workspace_id,id,name,slug,tint,resource_version,created_at,access_mode,repository_host,hosted_repository_id,repository_subpath)
        VALUES (?,?,?,?,?,1,?,'restricted','synthetic',?,'.')`,
          )
          .run(
            FIX.workspace,
            id,
            `${canary}-CAPACITY`,
            `capacity-${id.toLowerCase()}`,
            "#84CC16",
            now,
            id,
          );
        await db
          .prepare("INSERT INTO project_access (workspace_id,project_id,human_id) VALUES (?,?,?)")
          .run(FIX.workspace, id, FIX.reviewer);
      }
      const f = await fixture(FIX.reviewer, { projectBoundary: null }),
        before = await effects(),
        guarded = afterProjectCapture(binding, async () => {});
      const page = projectPage(await call(f, guarded.db, "bfb_list_projects", { limit: 100 }));
      assert(guarded.state.reached && guarded.state.capturedProjectIds.length > 100);
      assert.deepEqual(
        page.projects.map((row) => row.id),
        guarded.state.capturedProjectIds.slice(0, 100),
      );
      assert.equal(page.hasMore, true);
      assert.equal(page.nextCursor, page.projects.at(-1)?.id);
      const second = projectPage(
        await call(f, afterProjectCapture(binding, async () => {}).db, "bfb_list_projects", {
          limit: 100,
          cursor: page.nextCursor,
        }),
      );
      assert.deepEqual(
        second.projects.map((row) => row.id),
        guarded.state.capturedProjectIds.slice(100),
      );
      assert.equal(second.hasMore, false);
      assert.equal(second.nextCursor, undefined);
      const tasks = taskPage(
        await call(f, afterProjectCapture(binding, async () => {}).db, "bfb_list_tasks", {
          limit: 100,
        }),
      );
      assert(tasks.tasks.some((row) => row.id === f.task.id));
      assert(bounds.maximum_bindings <= 100 && bounds.maximum_statement_bytes <= 100_000);
      assert.deepEqual(await effects(), before);
    },
  );

  console.log(
    JSON.stringify({
      schema_version: 1,
      stage: "delegated_list_selection",
      migration_head: manifest.migration_head,
      checks,
      failures,
      ...bounds,
      outcome: failures.length ? "failed" : "passed",
      limits: [
        "compiled genuine OAuth handler mounted in the test process; not real HTTP OAuth ingress",
        "disposable native D1 and genuine Hub task setup; no run, runner or provider operation",
        "final delegated collection statements only; no opaque task cursor or private activation claim",
      ],
    }),
  );
  assert.equal(failures.length, 0, "delegated list D1 checks failed");
  console.log("C11_DELEGATED_LIST_SELECTION_D1_OK");
} finally {
  await server.close();
}
