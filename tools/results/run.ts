// ABOUTME: Proves A03 result submission serializes across real independent Workers.
// ABOUTME: Duplicate retries, stale versions, the revocation race, and lease retention run on D1.

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { adaptD1, loadMigrationManifest, type D1Like, type SqlDatabase } from "@bfb/db";
import {
  listResultSubmissions,
  randomUlid,
  type CommandOutcome,
  type CreateRunResult,
  type ExecutionRecord,
  type ProjectRecord,
  type ReviewResultResult,
  type SubmitResultResult,
  type TaskRecord,
} from "@bfb/domain";
import { createTestHarness } from "wrangler";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const migrationManifest = loadMigrationManifest(resolve(repoRoot, "migrations/d1"));
const migrationHeadFile = `${migrationManifest.migration_head}.sql`;
const origin = "https://bfb.results.test";
const now = "2026-08-12T08:00:00Z";
const later = "2026-08-12T09:00:00Z";
const commit = "a".repeat(40);
const treeHash = `sha256:${"c".repeat(64)}`;
const server = createTestHarness({
  root: repoRoot,
  workers: [
    { configPath: "tools/results/wrangler-a.toml" },
    { configPath: "tools/results/wrangler-b.toml" },
    { configPath: "tools/results/wrangler-hub.toml" },
  ],
});

interface HubEnv {
  DB: D1Like;
}

type WorkerName = "bfb-results-a" | "bfb-results-b";

function humanCommand(
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

function runnerCommand(
  workspaceId: string,
  runnerId: string,
  commandName: string,
  idempotencyKey: string,
  input: unknown,
) {
  return {
    commandName,
    request: {
      workspaceId,
      idempotencyKey,
      actorRunnerId: runnerId,
      authorizationEpoch: 1,
      now,
      input,
    },
  };
}

async function execute<TResult>(
  workerName: WorkerName,
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

function ok<TResult>(outcome: CommandOutcome<TResult>, label: string): TResult {
  if (!outcome.ok) {
    throw new Error(`${label}: ${JSON.stringify(outcome)}`);
  }
  return outcome.result;
}

function code(outcome: CommandOutcome<never>, label: string): string {
  if (outcome.ok) {
    throw new Error(`${label}: expected failure`);
  }
  return outcome.error.code;
}

async function seedHuman(
  db: SqlDatabase,
  workspaceId: string,
  humanId: string,
  email: string,
  name: string,
  role: "owner" | "member" | "reviewer",
): Promise<void> {
  await db
    .prepare(`INSERT INTO humans (id, email, display_name, created_at) VALUES (?, ?, ?, ?)`)
    .run(humanId, email, name, now);
  await db
    .prepare(
      `INSERT INTO workspace_members
       (workspace_id, human_id, role, authorization_epoch, created_at)
       VALUES (?, ?, ?, 1, ?)`,
    )
    .run(workspaceId, humanId, role, now);
  await db
    .prepare(
      `INSERT INTO workspace_authorization_epochs
       (workspace_id, human_id, authorization_epoch, revoked_at, updated_at)
       VALUES (?, ?, 1, NULL, ?)`,
    )
    .run(workspaceId, humanId, now);
}

async function main(): Promise<void> {
  const checks: string[] = [];
  try {
    await server.listen();
    const hubWorker = server.getWorker("bfb-results-hub");
    await hubWorker.applyD1Migrations("DB");
    // Append-only D1 heads move forward as later packages land; A03 requires
    // its own migration to be present, never that it is still the head.
    assert.ok(
      migrationManifest.migrations.some((entry) => entry.file === "0024_result_submissions.sql"),
      `A03 migration is missing from ${migrationHeadFile}`,
    );
    const env = (await hubWorker.getEnv()) as unknown as HubEnv;
    const db = adaptD1(env.DB);
    const workspaceId = randomUlid();
    const owner = randomUlid();
    const member = randomUlid();
    const reviewer = randomUlid();
    await db
      .prepare(
        `INSERT INTO workspaces (id, slug, jurisdiction, created_at, resource_version)
         VALUES (?, 'a03-workerd', 'global', ?, 1)`,
      )
      .run(workspaceId, now);
    await seedHuman(db, workspaceId, owner, "a03-owner@synthetic.test", "A03 Owner", "owner");
    await seedHuman(db, workspaceId, member, "a03-member@synthetic.test", "A03 Member", "member");
    await seedHuman(
      db,
      workspaceId,
      reviewer,
      "a03-reviewer@synthetic.test",
      "A03 Reviewer",
      "reviewer",
    );

    const project = ok(
      await execute<ProjectRecord>(
        "bfb-results-a",
        workspaceId,
        humanCommand(workspaceId, owner, "project.create", "a03-project-create", {
          name: "A03 Workerd",
          slug: "a03-workerd",
          tint: "#336699",
          accessMode: "workspace",
          repositoryHost: "github.com",
          hostedRepositoryId: "a03-workerd-repository",
          repositorySubpath: ".",
        }),
      ),
      "project.create",
    );
    checks.push("project workspace access provisions member and reviewer reads");
    const profile = ok(
      await execute<{ id: string }>(
        "bfb-results-a",
        workspaceId,
        humanCommand(workspaceId, owner, "agent_profile.create", "a03-profile-create", {
          name: "A03 Codex",
          provider: "codex",
          executionMode: "interactive",
          harnessMode: "restricted",
        }),
      ),
      "agent_profile.create",
    );
    const task = ok(
      await execute<TaskRecord>(
        "bfb-results-a",
        workspaceId,
        humanCommand(workspaceId, owner, "task.create", "a03-task-create", {
          projectId: project.id,
          title: "Race the result domain",
          priority: "P1",
          nextOwnerType: "agent_profile",
          nextOwnerId: profile.id,
        }),
      ),
      "task.create",
    );
    const run = ok(
      await execute<CreateRunResult>(
        "bfb-results-a",
        workspaceId,
        humanCommand(workspaceId, owner, "run.create", "a03-run-create", {
          taskId: task.id,
          expectedTaskVersion: 1,
          agentProfileId: profile.id,
          workspacePolicyVersion: 1,
          projectPolicyVersion: 1,
          repositoryConfigVersion: 1,
          agentProfileVersion: 1,
        }),
      ),
      "run.create",
    );
    const runId = run.run.id;
    const execution = ok(
      await execute<ExecutionRecord>(
        "bfb-results-a",
        workspaceId,
        humanCommand(workspaceId, owner, "execution.create", "a03-execution-create", {
          runId,
        }),
      ),
      "execution.create",
    );
    void execution;

    const first = ok(
      await execute<SubmitResultResult>(
        "bfb-results-a",
        workspaceId,
        humanCommand(workspaceId, owner, "result.submit", "a03-submit-1", {
          runId,
          summary: "Synthetic workerd first result",
          limitations: "Synthetic workerd limitation",
          evidenceRefs: [{ kind: "comment", ref: "synthetic-workerd-comment" }],
          gitBranch: "main",
          gitCommit: commit,
          gitDirty: false,
        }),
      ),
      "result.submit v1",
    );
    assert.equal(first.submission.version, 1);
    assert.equal(first.runResultState, "submitted");
    assert.equal(first.taskState, "review");
    checks.push("human submission moves run to submitted and task to review");

    const retry = await execute<SubmitResultResult>(
      "bfb-results-b",
      workspaceId,
      humanCommand(workspaceId, owner, "result.submit", "a03-submit-1", {
        runId,
        summary: "Synthetic workerd first result",
      }),
    );
    assert.equal(retry.ok && retry.replayed, true);
    assert(retry.ok && retry.result.submission.id === first.submission.id);
    checks.push("idempotent retry across workers creates one submission");

    const duplicate = await execute<SubmitResultResult>(
      "bfb-results-a",
      workspaceId,
      humanCommand(workspaceId, owner, "result.submit", "a03-submit-duplicate", {
        runId,
        summary: "Synthetic duplicate evidence",
        evidenceRefs: [
          { kind: "comment", ref: "same" },
          { kind: "comment", ref: "same" },
        ],
      }),
    );
    assert.equal(
      code(duplicate as CommandOutcome<never>, "duplicate evidence"),
      "invalid_argument",
    );
    const reviewerSubmit = await execute<SubmitResultResult>(
      "bfb-results-a",
      workspaceId,
      humanCommand(workspaceId, reviewer, "result.submit", "a03-reviewer-submit", {
        runId,
        summary: "Reviewer submission",
      }),
    );
    assert.equal(code(reviewerSubmit as CommandOutcome<never>, "reviewer submit"), "forbidden");
    const staleAccept = await execute<ReviewResultResult>(
      "bfb-results-a",
      workspaceId,
      humanCommand(workspaceId, owner, "result.accept", "a03-stale-accept", {
        runId,
        submissionId: first.submission.id,
        expectedRunVersion: first.runVersion - 1,
        expectedTaskVersion: first.taskVersion,
      }),
    );
    assert.equal(code(staleAccept as CommandOutcome<never>, "stale accept"), "stale_version");
    checks.push("duplicate evidence, reviewer submit, and stale accept fail closed");

    const changed = ok(
      await execute<ReviewResultResult>(
        "bfb-results-a",
        workspaceId,
        humanCommand(workspaceId, reviewer, "result.request_changes", "a03-changes-1", {
          runId,
          submissionId: first.submission.id,
          expectedRunVersion: first.runVersion,
          expectedTaskVersion: first.taskVersion,
          comment: "Synthetic workerd change request",
        }),
      ),
      "result.request_changes",
    );
    assert.equal(changed.runResultState, "changes_requested");
    const second = ok(
      await execute<SubmitResultResult>(
        "bfb-results-b",
        workspaceId,
        humanCommand(workspaceId, member, "result.submit", "a03-submit-2", {
          runId,
          summary: "Synthetic workerd second result",
        }),
      ),
      "result.submit v2",
    );
    assert.equal(second.submission.version, 2);
    const views = await listResultSubmissions(db, workspaceId, runId);
    assert.deepEqual(
      views.map((view) => [view.version, view.superseded, view.outdated]),
      [
        [2, false, false],
        [1, true, true],
      ],
    );
    checks.push("changes-requested cycle creates a new immutable version with outdated history");

    const accepted = ok(
      await execute<ReviewResultResult>(
        "bfb-results-a",
        workspaceId,
        humanCommand(workspaceId, owner, "result.accept", "a03-accept-1", {
          runId,
          submissionId: second.submission.id,
          expectedRunVersion: second.runVersion,
          expectedTaskVersion: second.taskVersion,
        }),
      ),
      "result.accept",
    );
    assert.equal(accepted.runResultState, "accepted");
    assert.equal(accepted.taskState, "done");
    checks.push("owner acceptance completes the run and task");

    const taskTwo = ok(
      await execute<TaskRecord>(
        "bfb-results-a",
        workspaceId,
        humanCommand(workspaceId, owner, "task.create", "a03-task-two", {
          projectId: project.id,
          title: "Race the agent submission",
          priority: "P1",
          nextOwnerType: "agent_profile",
          nextOwnerId: profile.id,
        }),
      ),
      "task.create two",
    );
    const runTwo = ok(
      await execute<CreateRunResult>(
        "bfb-results-a",
        workspaceId,
        humanCommand(workspaceId, owner, "run.create", "a03-run-two", {
          taskId: taskTwo.id,
          expectedTaskVersion: 1,
          agentProfileId: profile.id,
          workspacePolicyVersion: 1,
          projectPolicyVersion: 1,
          repositoryConfigVersion: 1,
          agentProfileVersion: 1,
        }),
      ),
      "run.create two",
    );
    const runTwoId = runTwo.run.id;
    const executionTwo = ok(
      await execute<ExecutionRecord>(
        "bfb-results-a",
        workspaceId,
        humanCommand(workspaceId, owner, "execution.create", "a03-execution-two", {
          runId: runTwoId,
        }),
      ),
      "execution.create two",
    );
    const runnerId = randomUlid();
    const checkoutId = randomUlid();
    await db
      .prepare(
        `INSERT INTO runners
         (workspace_id, id, owner_human_id, device_label, public_key_json,
          key_thumbprint, authorization_epoch, grant_epoch, token_epoch, enrolled_at, revoked_at)
         VALUES (?, ?, ?, 'Synthetic workerd Mac', '{}', 'synthetic-workerd-key', 1, 1, 1, ?, NULL)`,
      )
      .run(workspaceId, runnerId, owner, now);
    await db
      .prepare(
        `INSERT INTO runner_project_grants (workspace_id, runner_id, project_id)
         VALUES (?, ?, ?)`,
      )
      .run(workspaceId, runnerId, project.id);
    await db
      .prepare(
        `INSERT INTO execution_assignments
         (workspace_id, execution_id, assignment_generation, run_id, task_id, project_id,
          runner_id, checkout_id, physical_worktree_hash, requesting_human_id,
          requesting_human_epoch, runner_authorization_epoch, runner_grant_epoch,
          runner_key_thumbprint, created_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, 'synthetic-workerd-key', ?)`,
      )
      .run(
        workspaceId,
        executionTwo.id,
        runTwoId,
        taskTwo.id,
        project.id,
        runnerId,
        checkoutId,
        treeHash,
        owner,
        now,
      );
    const leaseBefore = (await db
      .prepare(`SELECT * FROM checkout_leases WHERE workspace_id = ? AND runner_id = ?`)
      .get(workspaceId, runnerId)) as unknown;
    await db
      .prepare(
        `INSERT INTO checkout_leases
         (workspace_id, runner_id, physical_worktree_hash, execution_id,
          assignment_generation, fencing_generation, state, expires_at,
          observation_sequence, observed_at, identity_json, containment_reason, released_at)
         VALUES (?, ?, ?, ?, 1, 1, 'live', ?, 3, ?, NULL, NULL, NULL)`,
      )
      .run(workspaceId, runnerId, treeHash, executionTwo.id, later, now);
    const leaseSeeded = (await db
      .prepare(`SELECT * FROM checkout_leases WHERE workspace_id = ? AND runner_id = ?`)
      .get(workspaceId, runnerId)) as Record<string, unknown>;
    assert.notEqual(JSON.stringify(leaseSeeded), JSON.stringify(leaseBefore ?? null));

    const agentSubmit = ok(
      await execute<SubmitResultResult>(
        "bfb-results-a",
        workspaceId,
        runnerCommand(workspaceId, runnerId, "result.submit", "a03-agent-submit", {
          runId: runTwoId,
          summary: "Synthetic workerd agent result",
          gitCommit: commit,
        }),
      ),
      "agent result.submit",
    );
    assert.equal(agentSubmit.submission.submitted_by_kind, "agent_run");
    assert.equal(agentSubmit.submission.version, 1);
    checks.push("bound runner agent submits with agent attribution");

    const agentAccept = await execute<ReviewResultResult>(
      "bfb-results-b",
      workspaceId,
      runnerCommand(workspaceId, runnerId, "result.accept", "a03-agent-accept", {
        runId: runTwoId,
        submissionId: agentSubmit.submission.id,
        expectedRunVersion: agentSubmit.runVersion,
        expectedTaskVersion: agentSubmit.taskVersion,
      }),
    );
    assert.equal(code(agentAccept as CommandOutcome<never>, "agent accept"), "forbidden");
    checks.push("agent self-acceptance is forbidden");

    const racers = await Promise.all([
      execute<ReviewResultResult>(
        "bfb-results-a",
        workspaceId,
        humanCommand(workspaceId, owner, "result.accept", "a03-race-accept", {
          runId: runTwoId,
          submissionId: agentSubmit.submission.id,
          expectedRunVersion: agentSubmit.runVersion,
          expectedTaskVersion: agentSubmit.taskVersion,
        }),
      ),
      execute<ReviewResultResult>(
        "bfb-results-b",
        workspaceId,
        humanCommand(workspaceId, reviewer, "result.request_changes", "a03-race-changes", {
          runId: runTwoId,
          submissionId: agentSubmit.submission.id,
          expectedRunVersion: agentSubmit.runVersion,
          expectedTaskVersion: agentSubmit.taskVersion,
        }),
      ),
    ]);
    assert.equal(racers.filter((outcome) => outcome.ok).length, 1, JSON.stringify(racers));
    const loser = racers.find((outcome) => !outcome.ok) as CommandOutcome<never>;
    assert.equal(loser.ok, false);
    if (!loser.ok) {
      assert.equal(loser.error.code, "invalid_transition");
    }
    const reviews = (await db
      .prepare(`SELECT decision FROM result_reviews WHERE workspace_id = ? AND run_id = ?`)
      .all(workspaceId, runTwoId)) as Array<{ decision: string }>;
    assert.equal(reviews.length, 1);
    const winner = racers.find((outcome) => outcome.ok);
    assert(winner?.ok);
    if (winner?.ok) {
      const finalRun = (await db
        .prepare(`SELECT result_state FROM runs WHERE workspace_id = ? AND id = ?`)
        .get(workspaceId, runTwoId)) as { result_state: string };
      const finalTask = (await db
        .prepare(`SELECT state FROM tasks WHERE workspace_id = ? AND id = ?`)
        .get(workspaceId, taskTwo.id)) as { state: string };
      if (winner.result.decision === "accept") {
        assert.equal(finalRun.result_state, "accepted");
        assert.equal(finalTask.state, "done");
      } else {
        assert.equal(finalRun.result_state, "changes_requested");
        assert.equal(finalTask.state, "active");
      }
    }
    const submissions = (await db
      .prepare(
        `SELECT version FROM result_submissions WHERE workspace_id = ? AND run_id = ? ORDER BY version`,
      )
      .all(workspaceId, runTwoId)) as Array<{ version: number }>;
    assert.deepEqual(
      submissions.map((row) => row.version),
      [1],
    );
    const leaseAfter = (await db
      .prepare(`SELECT * FROM checkout_leases WHERE workspace_id = ? AND runner_id = ?`)
      .get(workspaceId, runnerId)) as Record<string, unknown>;
    assert.deepEqual(leaseAfter, leaseSeeded);
    checks.push("accept/changes race commits exactly one review and retains the checkout lock");

    const taskThree = ok(
      await execute<TaskRecord>(
        "bfb-results-a",
        workspaceId,
        humanCommand(workspaceId, owner, "task.create", "a03-task-three", {
          projectId: project.id,
          title: "Close the result domain",
          priority: "P1",
          nextOwnerType: "agent_profile",
          nextOwnerId: profile.id,
        }),
      ),
      "task.create three",
    );
    const runThree = ok(
      await execute<CreateRunResult>(
        "bfb-results-a",
        workspaceId,
        humanCommand(workspaceId, owner, "run.create", "a03-run-three", {
          taskId: taskThree.id,
          expectedTaskVersion: 1,
          agentProfileId: profile.id,
          workspacePolicyVersion: 1,
          projectPolicyVersion: 1,
          repositoryConfigVersion: 1,
          agentProfileVersion: 1,
        }),
      ),
      "run.create three",
    );
    const failed = ok(
      await execute<{ runResultState: string }>(
        "bfb-results-a",
        workspaceId,
        humanCommand(workspaceId, member, "result.fail", "a03-fail-three", {
          runId: runThree.run.id,
          expectedRunVersion: 1,
        }),
      ),
      "result.fail",
    );
    assert.equal(failed.runResultState, "failed");
    const taskThreeState = (await db
      .prepare(`SELECT state FROM tasks WHERE workspace_id = ? AND id = ?`)
      .get(workspaceId, taskThree.id)) as { state: string };
    assert.equal(taskThreeState.state, "active");
    checks.push("failure closes the run without moving the task");

    console.log(`A03 worker results: passed (${checks.length} checks)`);
    for (const check of checks) {
      console.log(`- ${check}`);
    }
  } catch (error) {
    server.debug();
    throw error;
  } finally {
    await server.close();
  }
}

await main();
