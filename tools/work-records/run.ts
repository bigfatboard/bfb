// ABOUTME: Proves C08 task and run mutations serialize across real independent Workers.
// ABOUTME: D1 retains immutable snapshots and context deliveries without false result state.

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { adaptD1, type D1Like } from "@bfb/db";
import {
  randomUlid,
  type AgentContextItem,
  type AgentProfileRecord,
  type CommandOutcome,
  type CreateRunResult,
  type ExecutionRecord,
  type ProjectRecord,
  type TaskRecord,
} from "@bfb/domain";
import { createTestHarness } from "wrangler";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const origin = "https://bfb.work-records.test";
const now = "2026-08-12T08:00:00Z";
const server = createTestHarness({
  root: repoRoot,
  workers: [
    { configPath: "tools/work-records/wrangler-a.toml" },
    { configPath: "tools/work-records/wrangler-b.toml" },
    { configPath: "tools/work-records/wrangler-hub.toml" },
  ],
});

interface HubEnv {
  DB: D1Like;
}

function command(
  workspaceId: string,
  humanId: string,
  commandName: string,
  idempotencyKey: string,
  input: unknown,
) {
  return {
    commandName,
    request: {
      workspaceId,
      idempotencyKey,
      actorHumanId: humanId,
      authorizationEpoch: 1,
      now,
      input,
    },
  };
}

async function execute<TResult>(
  workerName: "bfb-work-records-a" | "bfb-work-records-b",
  workspaceId: string,
  value: unknown,
): Promise<CommandOutcome<TResult>> {
  const response = await server
    .getWorker(workerName)
    .fetch(`${origin}/workspaces/${workspaceId}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as CommandOutcome<TResult>;
}

async function main(): Promise<void> {
  try {
    await server.listen();
    const hubWorker = server.getWorker("bfb-work-records-hub");
    await hubWorker.applyD1Migrations("DB");
    const env = (await hubWorker.getEnv()) as unknown as HubEnv;
    const db = adaptD1(env.DB);
    const workspaceId = randomUlid();
    const humanId = randomUlid();
    await db
      .prepare(
        `INSERT INTO workspaces (id, slug, jurisdiction, created_at, resource_version)
         VALUES (?, 'c08-workerd', 'global', ?, 1)`,
      )
      .run(workspaceId, now);
    await db
      .prepare(`INSERT INTO humans (id, email, display_name, created_at) VALUES (?, ?, ?, ?) `)
      .run(humanId, "c08@synthetic.test", "C08 Owner", now);
    await db
      .prepare(
        `INSERT INTO workspace_members
         (workspace_id, human_id, role, authorization_epoch, created_at)
         VALUES (?, ?, 'owner', 1, ?)`,
      )
      .run(workspaceId, humanId, now);
    await db
      .prepare(
        `INSERT INTO workspace_authorization_epochs
         (workspace_id, human_id, authorization_epoch, revoked_at, updated_at)
         VALUES (?, ?, 1, NULL, ?)`,
      )
      .run(workspaceId, humanId, now);

    const project = await execute<ProjectRecord>(
      "bfb-work-records-a",
      workspaceId,
      command(workspaceId, humanId, "project.create", "c08-project-create", {
        name: "C08 Workerd",
        slug: "c08-workerd",
        tint: "#336699",
        accessMode: "restricted",
        repositoryHost: "github.com",
        hostedRepositoryId: "c08-workerd-repository",
        repositorySubpath: ".",
      }),
    );
    assert(project.ok);
    const profile = await execute<AgentProfileRecord>(
      "bfb-work-records-a",
      workspaceId,
      command(workspaceId, humanId, "agent_profile.create", "c08-profile-create", {
        name: "C08 Codex",
        provider: "codex",
        executionMode: "interactive",
        harnessMode: "restricted",
      }),
    );
    assert(profile.ok);
    const task = await execute<TaskRecord>(
      "bfb-work-records-a",
      workspaceId,
      command(workspaceId, humanId, "task.create", "c08-task-create", {
        projectId: project.result.id,
        title: "Race the work domain",
        priority: "P1",
        nextOwnerType: "agent_profile",
        nextOwnerId: profile.result.id,
      }),
    );
    assert(task.ok);

    const contextResults = await Promise.all([
      execute<{ version: number }>(
        "bfb-work-records-a",
        workspaceId,
        command(workspaceId, humanId, "context.add", "c08-context-a", {
          taskId: task.result.id,
          kind: "brief",
          audience: "both",
          body: "Build the compact work domain",
        }),
      ),
      execute<{ version: number }>(
        "bfb-work-records-b",
        workspaceId,
        command(workspaceId, humanId, "context.add", "c08-context-b", {
          taskId: task.result.id,
          kind: "constraint",
          audience: "agent",
          body: "Do not infer result state from process exit",
        }),
      ),
    ]);
    assert(contextResults.every((outcome) => outcome.ok));
    assert.deepEqual(
      contextResults.map((outcome) => (outcome.ok ? outcome.result.version : 0)).sort(),
      [1, 2],
    );

    const taskRacers = await Promise.all([
      execute<TaskRecord>(
        "bfb-work-records-a",
        workspaceId,
        command(workspaceId, humanId, "task.update", "c08-task-update-a", {
          taskId: task.result.id,
          expectedVersion: 1,
          punchline: "First contender",
        }),
      ),
      execute<TaskRecord>(
        "bfb-work-records-b",
        workspaceId,
        command(workspaceId, humanId, "task.update", "c08-task-update-b", {
          taskId: task.result.id,
          expectedVersion: 1,
          punchline: "Second contender",
        }),
      ),
    ]);
    assert.equal(taskRacers.filter((outcome) => outcome.ok).length, 1);
    assert.equal(
      taskRacers.filter((outcome) => !outcome.ok && outcome.error.code === "stale_version").length,
      1,
    );

    const runInput = {
      taskId: task.result.id,
      expectedTaskVersion: 2,
      agentProfileId: profile.result.id,
      workspacePolicyVersion: 1,
      projectPolicyVersion: 1,
      repositoryConfigVersion: 1,
      agentProfileVersion: 1,
    };
    const runRacers = await Promise.all([
      execute<CreateRunResult>(
        "bfb-work-records-a",
        workspaceId,
        command(workspaceId, humanId, "run.create", "c08-run-create-a", runInput),
      ),
      execute<CreateRunResult>(
        "bfb-work-records-b",
        workspaceId,
        command(workspaceId, humanId, "run.create", "c08-run-create-b", runInput),
      ),
    ]);
    assert.equal(runRacers.filter((outcome) => outcome.ok).length, 1);
    assert.equal(
      runRacers.filter((outcome) => !outcome.ok && outcome.error.code === "stale_version").length,
      1,
    );
    const committedRun = runRacers.find((outcome) => outcome.ok);
    assert(committedRun?.ok);
    const runDelivery = await execute<AgentContextItem[]>("bfb-work-records-a", workspaceId, {
      commandName: "context.deliver.run",
      request: {
        workspaceId,
        idempotencyKey: "c08-run-context-delivery",
        actorSystemId: committedRun.result.run.id,
        authorizationEpoch: 1,
        now,
        input: { taskId: task.result.id },
      },
    });
    assert(runDelivery.ok, JSON.stringify(runDelivery));
    assert.equal(runDelivery.result.length, 2);

    const execution = await execute<ExecutionRecord>(
      "bfb-work-records-a",
      workspaceId,
      command(workspaceId, humanId, "execution.create", "c08-execution-create", {
        runId: committedRun.result.run.id,
      }),
    );
    assert(execution.ok);
    for (const [key, expectedVersion, state] of [
      ["c08-execution-launching", 1, "launching"],
      ["c08-execution-attached", 2, "attached"],
    ] as const) {
      const transition = await execute<ExecutionRecord>(
        "bfb-work-records-a",
        workspaceId,
        command(workspaceId, humanId, "execution.transition", key, {
          runId: committedRun.result.run.id,
          executionId: execution.result.id,
          expectedVersion,
          state,
        }),
      );
      assert(transition.ok);
    }
    const session = await execute(
      "bfb-work-records-a",
      workspaceId,
      command(workspaceId, humanId, "provider_session.create", "c08-session-create", {
        runId: committedRun.result.run.id,
        executionId: execution.result.id,
        provider: "codex",
        requestedSessionId: "requested-c08-session",
      }),
    );
    assert(session.ok);
    const ended = await execute<ExecutionRecord>(
      "bfb-work-records-b",
      workspaceId,
      command(workspaceId, humanId, "execution.transition", "c08-execution-ended", {
        runId: committedRun.result.run.id,
        executionId: execution.result.id,
        expectedVersion: 3,
        state: "ended",
        endReason: "process_exit",
      }),
    );
    assert(ended.ok);

    const delegationId = randomUlid();
    await db
      .prepare(
        `INSERT INTO oauth_delegations
         (workspace_id, id, human_id, client_id, resource, project_id, task_id,
          scopes_json, authorization_epoch, expires_at, created_at)
         VALUES (?, ?, ?, 'c08-client', 'https://bfb.example.test/mcp', ?, ?,
                 '["bfb:read"]', 1, '2026-08-12T08:10:00Z', ?)`,
      )
      .run(workspaceId, delegationId, humanId, project.result.id, task.result.id, now);
    const delivered = await execute<AgentContextItem[]>("bfb-work-records-b", workspaceId, {
      commandName: "context.deliver.delegation",
      request: {
        workspaceId,
        idempotencyKey: "c08-delegated-context-delivery",
        actorHumanId: humanId,
        actorDelegationId: delegationId,
        authorizationEpoch: 1,
        now,
        input: { taskId: task.result.id },
      },
    });
    assert(delivered.ok, JSON.stringify(delivered));
    assert.equal(delivered.result.length, 2);

    const committed = (await db
      .prepare(
        `SELECT
           (SELECT state FROM tasks WHERE workspace_id = ? AND id = ?) AS task_state,
           (SELECT result_state FROM runs WHERE workspace_id = ? AND id = ?) AS result_state,
           (SELECT state FROM run_executions WHERE workspace_id = ? AND id = ?) AS execution_state,
           (SELECT COUNT(*) FROM run_configuration_snapshots WHERE workspace_id = ?) AS snapshots,
           (SELECT COUNT(*) FROM provider_sessions WHERE workspace_id = ?) AS sessions,
           (SELECT COUNT(*) FROM task_context_items WHERE workspace_id = ?) AS context_versions,
           (SELECT COUNT(*) FROM task_context_deliveries WHERE workspace_id = ?) AS deliveries,
           (SELECT COUNT(*) FROM semantic_events WHERE workspace_id = ?) AS events,
           (SELECT cursor FROM workspace_cursors WHERE workspace_id = ?) AS cursor,
           (SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1) AS migration_head`,
      )
      .get(
        workspaceId,
        task.result.id,
        workspaceId,
        committedRun.result.run.id,
        workspaceId,
        execution.result.id,
        workspaceId,
        workspaceId,
        workspaceId,
        workspaceId,
        workspaceId,
        workspaceId,
      )) as Record<string, unknown>;
    assert.deepEqual(committed, {
      task_state: "active",
      result_state: "open",
      execution_state: "ended",
      snapshots: 1,
      sessions: 1,
      context_versions: 2,
      deliveries: 4,
      events: 14,
      cursor: 14,
      migration_head: "0012_work_records.sql",
    });
    await assert.rejects(
      db
        .prepare(
          `UPDATE run_configuration_snapshots SET canonical_json = '{}'
           WHERE workspace_id = ? AND run_id = ?`,
        )
        .run(workspaceId, committedRun.result.run.id),
      /immutable/,
    );
    console.log(
      JSON.stringify({
        workers: ["bfb-work-records-a", "bfb-work-records-b", "bfb-work-records-hub"],
        taskRace: taskRacers.map((outcome) => (outcome.ok ? "committed" : outcome.error.code)),
        runRace: runRacers.map((outcome) => (outcome.ok ? "committed" : outcome.error.code)),
        committed,
      }),
    );
    console.log("C08_D1_OK");
  } catch (error) {
    server.debug();
    throw error;
  } finally {
    await server.close();
  }
}

await main();
