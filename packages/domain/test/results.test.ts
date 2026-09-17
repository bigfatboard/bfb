// ABOUTME: Proves A03 result submission, review, outdated, and authority rules over the hub.
// ABOUTME: All fixtures are synthetic; fault rows never touch real runner or provider state.

import type { SqlDatabase } from "@bfb/db";
import { describe, expect, it } from "vitest";

import { ingestRunnerEventsCommand } from "../src/events.js";
import { FIX } from "../src/fixtures.js";
import { WorkspaceHub, type CommandOutcome } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import { runnerHash } from "../src/runner-crypto.js";
import type { RunnerPrincipal } from "../src/runners.js";
import {
  acceptResultCommand,
  cancelRunCommand,
  failRunCommand,
  isUnambiguousHeadlessSuccess,
  listResultSubmissions,
  requestChangesCommand,
  submitResultCommand,
} from "../src/results.js";
import { resolveCommand } from "../src/command-catalog.js";
import { updateTaskCommand, createTaskCommand } from "../src/work-commands.js";
import {
  createExecutionCommand,
  createRunCommand,
  transitionExecutionCommand,
  updateRunActivityCommand,
} from "../src/work-records.js";
import { openDomainDb } from "./helpers.js";

const NOW = "2026-08-12T08:00:00Z";
const LATER = "2026-08-12T09:00:00Z";
const COMMIT = "a".repeat(40);
const OTHER_COMMIT = "b".repeat(40);
const TREE_HASH = `sha256:${"c".repeat(64)}`;

function human<T>(idempotencyKey: string, input: T, humanId = FIX.owner, now = NOW) {
  return {
    workspaceId: FIX.workspace,
    idempotencyKey,
    authorizationEpoch: 1,
    actorHumanId: humanId,
    now,
    input,
  };
}

function runnerRequest<T>(idempotencyKey: string, runnerId: string, input: T, now = NOW) {
  return {
    workspaceId: FIX.workspace,
    idempotencyKey,
    authorizationEpoch: 1,
    actorRunnerId: runnerId,
    now,
    input,
  };
}

function ok<T>(outcome: CommandOutcome<T>): T {
  expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true });
  if (!outcome.ok) {
    throw new Error(outcome.error.code);
  }
  return outcome.result;
}

function err<T>(outcome: CommandOutcome<T>): string {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) {
    throw new Error("expected failure");
  }
  return outcome.error.code;
}

async function createTaskAndRun(
  db: SqlDatabase,
  hub: WorkspaceHub,
  key: string,
  projectId = FIX.projectA,
): Promise<{ taskId: string; runId: string }> {
  const task = ok(
    await hub.execute(
      createTaskCommand,
      human(`${key}-task`, {
        projectId,
        title: `Synthetic result task ${key}`,
        priority: "P1" as const,
      }),
    ),
  );
  const run = ok(
    await hub.execute(
      createRunCommand,
      human(`${key}-run`, {
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
  return { taskId: task.id, runId: run.run.id };
}

async function readRun(db: SqlDatabase, runId: string) {
  return (await db
    .prepare(`SELECT result_state, resource_version FROM runs WHERE workspace_id = ? AND id = ?`)
    .get(FIX.workspace, runId)) as { result_state: string; resource_version: number };
}

async function readTask(db: SqlDatabase, taskId: string) {
  return (await db
    .prepare(`SELECT state, resource_version FROM tasks WHERE workspace_id = ? AND id = ?`)
    .get(FIX.workspace, taskId)) as { state: string; resource_version: number };
}

async function seedRunnerAgent(
  db: SqlDatabase,
  hub: WorkspaceHub,
  key: string,
  runId: string,
  taskId: string,
): Promise<{ runnerId: string; executionId: string; checkoutId: string }> {
  const runnerId = randomUlid();
  const checkoutId = randomUlid();
  await db
    .prepare(
      `INSERT INTO runners
       (workspace_id, id, owner_human_id, device_label, public_key_json,
        key_thumbprint, authorization_epoch, grant_epoch, token_epoch, enrolled_at, revoked_at)
       VALUES (?, ?, ?, 'Synthetic result Mac', '{}', ?, 1, 1, 1, ?, NULL)`,
    )
    .run(FIX.workspace, runnerId, FIX.owner, `synthetic-result-key-${key}`, NOW);
  await db
    .prepare(
      `INSERT INTO runner_project_grants (workspace_id, runner_id, project_id) VALUES (?, ?, ?)`,
    )
    .run(FIX.workspace, runnerId, FIX.projectA);
  const execution = ok(
    await hub.execute(createExecutionCommand, human(`${key}-execution`, { runId })),
  );
  await db
    .prepare(
      `INSERT INTO execution_assignments
       (workspace_id, execution_id, assignment_generation, run_id, task_id, project_id,
        runner_id, checkout_id, physical_worktree_hash, requesting_human_id,
        requesting_human_epoch, runner_authorization_epoch, runner_grant_epoch,
        runner_key_thumbprint, created_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, ?, ?)`,
    )
    .run(
      FIX.workspace,
      execution.id,
      runId,
      taskId,
      FIX.projectA,
      runnerId,
      checkoutId,
      TREE_HASH,
      FIX.owner,
      `synthetic-result-key-${key}`,
      NOW,
    );
  return { runnerId, executionId: execution.id, checkoutId };
}

async function seedRunnerToken(
  db: SqlDatabase,
  runnerId: string,
  thumbprint: string,
): Promise<RunnerPrincipal> {
  const tokenId = randomUlid();
  const authExpiresAt = "2026-08-12T10:00:00Z";
  await db
    .prepare(
      `INSERT INTO runner_tokens
       (workspace_id, runner_id, id, token_hash, claims_json, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      FIX.workspace,
      runnerId,
      tokenId,
      runnerHash(`synthetic-result-token-${runnerId}`),
      JSON.stringify({
        v: 1,
        sub: runnerId,
        workspace_id: FIX.workspace,
        aud: "bfb-runner",
        iss: "https://bfb.example.test",
        jti: tokenId,
        iat: Date.parse(NOW) / 1000,
        exp: Date.parse(authExpiresAt) / 1000,
        authorization_epoch: 1,
        owner_authorization_epoch: 1,
        grant_epoch: 1,
        token_epoch: 1,
        cnf: { jkt: thumbprint },
      }),
      authExpiresAt,
    );
  return {
    kind: "runner",
    workspaceId: FIX.workspace,
    runnerId,
    ownerHumanId: FIX.owner,
    authorizationEpoch: 1,
    ownerAuthorizationEpoch: 1,
    grantEpoch: 1,
    tokenEpoch: 1,
    tokenId,
    keyThumbprint: thumbprint,
    authExpiresAt,
    projectIds: [FIX.projectA],
  };
}

describe("result submission commands", () => {
  it("registers the five result commands on the hub catalog", () => {
    for (const name of [
      "result.submit",
      "result.request_changes",
      "result.accept",
      "result.fail",
      "result.cancel",
    ]) {
      expect(resolveCommand(name)?.name).toBe(name);
    }
  });

  it("submits an immutable result and moves the task to review", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const { taskId, runId } = await createTaskAndRun(db, hub, "submit");
    const submitted = ok(
      await hub.execute(
        submitResultCommand,
        human("submit-once", {
          runId,
          summary: "Synthetic result summary",
          limitations: "Synthetic limitation",
          evidenceRefs: [{ kind: "comment", ref: "synthetic-comment" }],
          gitBranch: "main",
          gitCommit: COMMIT,
          gitDirty: false,
        }),
      ),
    );
    expect(submitted.runResultState).toBe("submitted");
    expect(submitted.taskState).toBe("review");
    expect(submitted.submission).toMatchObject({
      run_id: runId,
      version: 1,
      summary: "Synthetic result summary",
      submitted_by_kind: "human",
      submitted_by_id: FIX.owner,
    });
    expect(submitted.submission.config_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await readRun(db, runId)).toMatchObject({
      result_state: "submitted",
      resource_version: 2,
    });
    expect(await readTask(db, taskId)).toMatchObject({ state: "review", resource_version: 3 });
    await expect(
      db
        .prepare(
          `UPDATE result_submissions SET summary = 'rewritten' WHERE workspace_id = ? AND id = ?`,
        )
        .run(FIX.workspace, submitted.submission.id),
    ).rejects.toThrow(/immutable/);
    await expect(
      db
        .prepare(`DELETE FROM result_submissions WHERE workspace_id = ? AND id = ?`)
        .run(FIX.workspace, submitted.submission.id),
    ).rejects.toThrow(/delete/);
  });

  it("creates one submission for idempotent retries", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const { runId } = await createTaskAndRun(db, hub, "idem");
    const first = await hub.execute(
      submitResultCommand,
      human("idem-key", { runId, summary: "Synthetic idempotent result" }),
    );
    expect(first.ok && first.replayed).toBe(false);
    const second = await hub.execute(
      submitResultCommand,
      human("idem-key", { runId, summary: "Synthetic idempotent result" }),
    );
    expect(second.ok && second.replayed).toBe(true);
    const rows = (await db
      .prepare(`SELECT id FROM result_submissions WHERE workspace_id = ? AND run_id = ?`)
      .all(FIX.workspace, runId)) as unknown[];
    expect(rows).toHaveLength(1);
  });

  it("rejects duplicate and malformed evidence", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const { runId } = await createTaskAndRun(db, hub, "evidence");
    const duplicate = await hub.execute(
      submitResultCommand,
      human("evidence-duplicate", {
        runId,
        summary: "Synthetic duplicate evidence",
        evidenceRefs: [
          { kind: "comment", ref: "same", version: "1" },
          { kind: "comment", ref: "same", version: "1" },
        ],
      }),
    );
    expect(err(duplicate)).toBe("invalid_argument");
    const badCommit = await hub.execute(
      submitResultCommand,
      human("evidence-commit", {
        runId,
        summary: "Synthetic bad commit",
        gitCommit: "not-a-sha",
      }),
    );
    expect(err(badCommit)).toBe("invalid_argument");
    const smuggled = await hub.execute(
      submitResultCommand,
      human("evidence-smuggled", {
        runId,
        summary: "Synthetic smuggled field",
        evidenceRefs: [{ kind: "comment", ref: "x", workspace_id: FIX.workspace } as never],
      }),
    );
    expect(err(smuggled)).toBe("invalid_argument");
    const oversized = await hub.execute(
      submitResultCommand,
      human("evidence-oversized", { runId, summary: `x${"y".repeat(2048)}` }),
    );
    expect(err(oversized)).toBe("invalid_argument");
    expect(await readRun(db, runId)).toMatchObject({ result_state: "open" });
  });

  it("runs the changes-requested cycle with new immutable versions", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const { taskId, runId } = await createTaskAndRun(db, hub, "cycle");
    const first = ok(
      await hub.execute(
        submitResultCommand,
        human("cycle-submit-1", {
          runId,
          summary: "Synthetic first attempt",
          gitBranch: "main",
          gitCommit: COMMIT,
          gitDirty: true,
        }),
      ),
    );
    const runAfterSubmit = await readRun(db, runId);
    const taskAfterSubmit = await readTask(db, taskId);
    const changed = ok(
      await hub.execute(
        requestChangesCommand,
        human(
          "cycle-changes",
          {
            runId,
            submissionId: first.submission.id,
            expectedRunVersion: runAfterSubmit.resource_version,
            expectedTaskVersion: taskAfterSubmit.resource_version,
            comment: "Synthetic change request",
          },
          FIX.reviewer,
        ),
      ),
    );
    expect(changed).toMatchObject({
      decision: "request_changes",
      runResultState: "changes_requested",
      taskState: "active",
    });
    expect(await readTask(db, taskId)).toMatchObject({ state: "active" });
    const second = ok(
      await hub.execute(
        submitResultCommand,
        human("cycle-submit-2", {
          runId,
          summary: "Synthetic second attempt",
          gitBranch: "main",
          gitCommit: OTHER_COMMIT,
          gitDirty: false,
        }),
      ),
    );
    expect(second.submission.version).toBe(2);
    const views = await listResultSubmissions(db, FIX.workspace, runId);
    expect(views.map((view) => view.version)).toEqual([2, 1]);
    expect(views[1]).toMatchObject({ superseded: true, outdated: true });
    expect(views[1]?.outdated_reasons).toContain("superseded");
    expect(views[0]).toMatchObject({ superseded: false, outdated: false });
    const staleReview = await hub.execute(
      requestChangesCommand,
      human("cycle-stale-review", {
        runId,
        submissionId: first.submission.id,
        expectedRunVersion: second.runVersion,
        expectedTaskVersion: second.taskVersion,
      }),
    );
    expect(err(staleReview)).toBe("invalid_argument");
    const runBeforeAccept = await readRun(db, runId);
    const taskBeforeAccept = await readTask(db, taskId);
    const accepted = ok(
      await hub.execute(
        acceptResultCommand,
        human("cycle-accept", {
          runId,
          submissionId: second.submission.id,
          expectedRunVersion: runBeforeAccept.resource_version,
          expectedTaskVersion: taskBeforeAccept.resource_version,
        }),
      ),
    );
    expect(accepted).toMatchObject({
      decision: "accept",
      runResultState: "accepted",
      taskState: "done",
    });
    expect(await readTask(db, taskId)).toMatchObject({ state: "done" });
    const afterAccept = await hub.execute(
      submitResultCommand,
      human("cycle-submit-3", { runId, summary: "Synthetic late attempt" }),
    );
    expect(err(afterAccept)).toBe("invalid_transition");
  });

  it("enforces the reviewer, member, and owner matrix", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const { taskId, runId } = await createTaskAndRun(db, hub, "matrix");
    const reviewerSubmit = await hub.execute(
      submitResultCommand,
      human("matrix-reviewer-submit", { runId, summary: "Reviewer submission" }, FIX.reviewer),
    );
    expect(err(reviewerSubmit)).toBe("forbidden");
    const memberSubmit = ok(
      await hub.execute(
        submitResultCommand,
        human("matrix-member-submit", { runId, summary: "Member submission" }, FIX.member),
      ),
    );
    const runAfterSubmit = await readRun(db, runId);
    const taskAfterSubmit = await readTask(db, taskId);
    const reviewerAccept = await hub.execute(
      acceptResultCommand,
      human(
        "matrix-reviewer-accept",
        {
          runId,
          submissionId: memberSubmit.submission.id,
          expectedRunVersion: runAfterSubmit.resource_version,
          expectedTaskVersion: taskAfterSubmit.resource_version,
        },
        FIX.reviewer,
      ),
    );
    expect(err(reviewerAccept)).toBe("forbidden");
    const reviewerChanges = ok(
      await hub.execute(
        requestChangesCommand,
        human(
          "matrix-reviewer-changes",
          {
            runId,
            submissionId: memberSubmit.submission.id,
            expectedRunVersion: runAfterSubmit.resource_version,
            expectedTaskVersion: taskAfterSubmit.resource_version,
          },
          FIX.reviewer,
        ),
      ),
    );
    expect(reviewerChanges.runResultState).toBe("changes_requested");
    const reviewerFail = await hub.execute(
      failRunCommand,
      human(
        "matrix-reviewer-fail",
        { runId, expectedRunVersion: reviewerChanges.runVersion },
        FIX.reviewer,
      ),
    );
    expect(err(reviewerFail)).toBe("forbidden");
  });

  it("rejects delegated remote submission and stale review versions", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const { taskId, runId } = await createTaskAndRun(db, hub, "stale");
    const delegationId = randomUlid();
    await db
      .prepare(
        `INSERT INTO oauth_delegations
         (workspace_id, id, human_id, client_id, resource, project_id, task_id,
          scopes_json, authorization_epoch, expires_at, created_at)
         VALUES (?, ?, ?, ?, 'https://bfb.example.test/mcp', ?, NULL, ?, 1, ?, ?)`,
      )
      .run(
        FIX.workspace,
        delegationId,
        FIX.owner,
        FIX.client,
        FIX.projectA,
        JSON.stringify(["bfb:read", "bfb:task:write"]),
        LATER,
        NOW,
      );
    const delegated = await hub.execute(submitResultCommand, {
      ...human("stale-delegated", { runId, summary: "Delegated submission" }),
      actorDelegationId: delegationId,
    });
    expect(err(delegated)).toBe("forbidden");
    const submitted = ok(
      await hub.execute(
        submitResultCommand,
        human("stale-submit", { runId, summary: "Synthetic stale target" }),
      ),
    );
    const runVersion = (await readRun(db, runId)).resource_version;
    const taskVersion = (await readTask(db, taskId)).resource_version;
    const staleRun = await hub.execute(
      acceptResultCommand,
      human("stale-run-version", {
        runId,
        submissionId: submitted.submission.id,
        expectedRunVersion: runVersion - 1,
        expectedTaskVersion: taskVersion,
      }),
    );
    expect(err(staleRun)).toBe("stale_version");
    const staleTask = await hub.execute(
      acceptResultCommand,
      human("stale-task-version", {
        runId,
        submissionId: submitted.submission.id,
        expectedRunVersion: runVersion,
        expectedTaskVersion: taskVersion - 1,
      }),
    );
    expect(err(staleTask)).toBe("stale_version");
    expect(await readRun(db, runId)).toMatchObject({ result_state: "submitted" });
  });

  it("closes runs as failed or cancelled without moving the task", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const first = await createTaskAndRun(db, hub, "fail");
    const failed = ok(
      await hub.execute(
        failRunCommand,
        human("fail-once", { runId: first.runId, expectedRunVersion: 1 }),
      ),
    );
    expect(failed.runResultState).toBe("failed");
    expect(await readTask(db, first.taskId)).toMatchObject({ state: "active" });
    const second = await createTaskAndRun(db, hub, "cancel");
    const submitted = ok(
      await hub.execute(
        submitResultCommand,
        human("cancel-submit", { runId: second.runId, summary: "Synthetic doomed result" }),
      ),
    );
    const failSubmitted = await hub.execute(
      failRunCommand,
      human("cancel-fail-submitted", {
        runId: second.runId,
        expectedRunVersion: submitted.runVersion,
      }),
    );
    expect(err(failSubmitted)).toBe("invalid_transition");
    const runVersion = (await readRun(db, second.runId)).resource_version;
    const taskVersion = (await readTask(db, second.taskId)).resource_version;
    const changed = ok(
      await hub.execute(
        requestChangesCommand,
        human("cancel-changes", {
          runId: second.runId,
          submissionId: submitted.submission.id,
          expectedRunVersion: runVersion,
          expectedTaskVersion: taskVersion,
        }),
      ),
    );
    const cancelled = ok(
      await hub.execute(
        cancelRunCommand,
        human("cancel-once", { runId: second.runId, expectedRunVersion: changed.runVersion }),
      ),
    );
    expect(cancelled.runResultState).toBe("cancelled");
    expect(await readTask(db, second.taskId)).toMatchObject({ state: "active" });
    const activity = await hub.execute(
      updateRunActivityCommand,
      human("cancel-activity", {
        runId: second.runId,
        expectedVersion: changed.runVersion + 1,
        activity: "working" as const,
      }),
    );
    expect(err(activity)).toBe("invalid_transition");
  });

  it("requires an active task for submission", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const { taskId, runId } = await createTaskAndRun(db, hub, "blocked");
    const blocked = ok(
      await hub.execute(
        updateTaskCommand,
        human("blocked-move", { taskId, expectedVersion: 2, state: "blocked" as const }),
      ),
    );
    expect(blocked.state).toBe("blocked");
    const submitted = await hub.execute(
      submitResultCommand,
      human("blocked-attempt", { runId, summary: "Synthetic blocked submission" }),
    );
    expect(err(submitted)).toBe("invalid_transition");
  });
});

describe("agent result submission", () => {
  it("accepts the bound runner agent and records agent attribution", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const { taskId, runId } = await createTaskAndRun(db, hub, "agent");
    const agent = await seedRunnerAgent(db, hub, "agent", runId, taskId);
    const submitted = ok(
      await hub.execute(
        submitResultCommand,
        runnerRequest("agent-submit", agent.runnerId, {
          runId,
          summary: "Synthetic agent result",
          gitCommit: COMMIT,
        }),
      ),
    );
    expect(submitted.submission).toMatchObject({
      version: 1,
      submitted_by_kind: "agent_run",
      submitted_by_id: runId,
    });
    expect(await readRun(db, runId)).toMatchObject({ result_state: "submitted" });
  });

  it("forbids agents without an assignment, with ended executions, or after revocation", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const { taskId, runId } = await createTaskAndRun(db, hub, "agentneg");
    const agent = await seedRunnerAgent(db, hub, "agentneg", runId, taskId);
    const other = await createTaskAndRun(db, hub, "agentneg-other");
    const foreign = await hub.execute(
      submitResultCommand,
      runnerRequest("agentneg-foreign", agent.runnerId, {
        runId: other.runId,
        summary: "Synthetic foreign submission",
      }),
    );
    expect(err(foreign)).toBe("forbidden");
    const ended = ok(
      await hub.execute(
        transitionExecutionCommand,
        human("agentneg-end", {
          runId,
          executionId: agent.executionId,
          expectedVersion: 1,
          state: "ended" as const,
          endReason: "process_exit" as const,
        }),
      ),
    );
    expect(ended.state).toBe("ended");
    const afterEnd = await hub.execute(
      submitResultCommand,
      runnerRequest("agentneg-after-end", agent.runnerId, {
        runId,
        summary: "Synthetic post-exit submission",
      }),
    );
    expect(err(afterEnd)).toBe("invalid_transition");
    await db
      .prepare(`UPDATE runners SET revoked_at = ? WHERE workspace_id = ? AND id = ?`)
      .run(LATER, FIX.workspace, agent.runnerId);
    const revoked = await hub.execute(
      submitResultCommand,
      runnerRequest("agentneg-revoked", agent.runnerId, {
        runId: other.runId,
        summary: "Synthetic revoked submission",
      }),
    );
    expect(err(revoked)).toBe("forbidden");
  });

  it("forbids the agent from reviewing, failing, or cancelling", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const { taskId, runId } = await createTaskAndRun(db, hub, "selfaccept");
    const agent = await seedRunnerAgent(db, hub, "selfaccept", runId, taskId);
    const submitted = ok(
      await hub.execute(
        submitResultCommand,
        human("selfaccept-submit", { runId, summary: "Synthetic self-review target" }),
      ),
    );
    const runVersion = (await readRun(db, runId)).resource_version;
    const taskVersion = (await readTask(db, taskId)).resource_version;
    const accept = await hub.execute(
      acceptResultCommand,
      runnerRequest("selfaccept-accept", agent.runnerId, {
        runId,
        submissionId: submitted.submission.id,
        expectedRunVersion: runVersion,
        expectedTaskVersion: taskVersion,
      }),
    );
    expect(err(accept)).toBe("forbidden");
    const changes = await hub.execute(
      requestChangesCommand,
      runnerRequest("selfaccept-changes", agent.runnerId, {
        runId,
        submissionId: submitted.submission.id,
        expectedRunVersion: runVersion,
        expectedTaskVersion: taskVersion,
      }),
    );
    expect(err(changes)).toBe("forbidden");
    const failed = await hub.execute(
      failRunCommand,
      runnerRequest("selfaccept-fail", agent.runnerId, { runId, expectedRunVersion: 1 }),
    );
    expect(err(failed)).toBe("forbidden");
    expect(await readRun(db, runId)).toMatchObject({ result_state: "submitted" });
  });
});

describe("result outdated detection", () => {
  it("marks submissions outdated on config change without mutating history", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const { runId } = await createTaskAndRun(db, hub, "outdated");
    const submitted = ok(
      await hub.execute(
        submitResultCommand,
        human("outdated-submit", { runId, summary: "Synthetic outdated target" }),
      ),
    );
    const before = await listResultSubmissions(db, FIX.workspace, runId);
    expect(before[0]).toMatchObject({ outdated: false });
    const snapshot = (await db
      .prepare(
        `SELECT project_id, agent_profile_id, canonical_json FROM run_configuration_snapshots
         WHERE workspace_id = ? AND run_id = ?`,
      )
      .get(FIX.workspace, runId)) as {
      project_id: string;
      agent_profile_id: string;
      canonical_json: string;
    };
    const nextHash = `sha256:${"d".repeat(64)}`;
    await db
      .prepare(
        `INSERT INTO run_configuration_snapshots
         (workspace_id, id, project_id, run_id, workspace_policy_version,
          project_policy_version, repository_config_version, agent_profile_id,
          agent_profile_version, canonical_json, content_hash, created_at, snapshot_generation)
         VALUES (?, ?, ?, ?, 1, 1, 1, ?, 1, ?, ?, ?, 2)`,
      )
      .run(
        FIX.workspace,
        randomUlid(),
        snapshot.project_id,
        runId,
        snapshot.agent_profile_id,
        snapshot.canonical_json,
        nextHash,
        LATER,
      );
    const after = await listResultSubmissions(db, FIX.workspace, runId);
    expect(after[0]).toMatchObject({ outdated: true });
    expect(after[0]?.outdated_reasons).toEqual(["config_changed"]);
    const stored = (await db
      .prepare(
        `SELECT summary, config_hash FROM result_submissions WHERE workspace_id = ? AND id = ?`,
      )
      .get(FIX.workspace, submitted.submission.id)) as {
      summary: string;
      config_hash: string;
    };
    expect(stored.summary).toBe("Synthetic outdated target");
    expect(stored.config_hash).toBe(submitted.submission.config_hash);
  });

  it("marks evidence outdated through the generic version map", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const { runId } = await createTaskAndRun(db, hub, "evmap");
    ok(
      await hub.execute(
        submitResultCommand,
        human("evmap-submit", {
          runId,
          summary: "Synthetic evidence map target",
          evidenceRefs: [{ kind: "artifact_version", ref: "synthetic-artifact", version: "1" }],
        }),
      ),
    );
    const current = await listResultSubmissions(db, FIX.workspace, runId);
    expect(current[0]).toMatchObject({ outdated: false });
    const changed = await listResultSubmissions(
      db,
      FIX.workspace,
      runId,
      new Map([["artifact_version\nsynthetic-artifact", "2"]]),
    );
    expect(changed[0]).toMatchObject({ outdated: true });
    expect(changed[0]?.outdated_reasons).toEqual(["evidence_changed"]);
    const opaque = await listResultSubmissions(
      db,
      FIX.workspace,
      runId,
      new Map([["other_kind\nsynthetic-artifact", "2"]]),
    );
    expect(opaque[0]).toMatchObject({ outdated: false });
  });
});

describe("headless success rule", () => {
  it("permits only unambiguous headless success", () => {
    expect(
      isUnambiguousHeadlessSuccess({
        executionMode: "headless",
        endReason: "process_exit",
        exitCode: 0,
        successAttested: true,
      }),
    ).toBe(true);
    const negatives = [
      {
        executionMode: "interactive",
        endReason: "process_exit",
        exitCode: 0,
        successAttested: true,
      },
      { executionMode: "headless", endReason: "terminated", exitCode: 0, successAttested: true },
      { executionMode: "headless", endReason: "process_exit", exitCode: 1, successAttested: true },
      { executionMode: "headless", endReason: "process_exit", exitCode: 0, successAttested: false },
      { executionMode: "headless", endReason: null, exitCode: 0, successAttested: true },
      {
        executionMode: "headless",
        endReason: "process_exit",
        exitCode: null,
        successAttested: true,
      },
      { executionMode: "headless", endReason: "lost", exitCode: 0, successAttested: true },
    ] as const;
    for (const facts of negatives) {
      expect(isUnambiguousHeadlessSuccess({ ...facts })).toBe(false);
    }
  });

  it("never moves result state on stop, failure, or exit telemetry", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const { taskId, runId } = await createTaskAndRun(db, hub, "noinfer");
    const agent = await seedRunnerAgent(db, hub, "noinfer", runId, taskId);
    const principal = await seedRunnerToken(db, agent.runnerId, `synthetic-result-key-noinfer`);
    const stream = randomUlid();
    const kinds = [
      "turn_failed",
      "tool_failed",
      "session_ended",
      "execution_ended",
      "result_submitted",
      "run_failed",
      "run_cancelled",
      "heartbeat",
    ];
    const outcome = await hub.execute(ingestRunnerEventsCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorRunnerId: principal.runnerId,
      authorizationEpoch: 1,
      now: NOW,
      input: {
        principal,
        events: kinds.map((kind, index) => ({
          schema_version: 1,
          event_id: randomUlid(),
          source_stream_id: stream,
          source_sequence: index + 1,
          run_execution_id: agent.executionId,
          assignment_generation: 1,
          kind,
          occurred_at: NOW,
          capture_origin: "runner_observed",
          payload: {},
        })),
      },
    });
    expect(outcome.ok).toBe(true);
    expect(await readRun(db, runId)).toMatchObject({ result_state: "open" });
    expect(await readTask(db, taskId)).toMatchObject({ state: "active" });
    const submissions = (await db
      .prepare(`SELECT id FROM result_submissions WHERE workspace_id = ? AND run_id = ?`)
      .all(FIX.workspace, runId)) as unknown[];
    expect(submissions).toHaveLength(0);
  });
});

describe("acceptance revocation and lease retention", () => {
  it("accepts without touching the checkout lease", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const { taskId, runId } = await createTaskAndRun(db, hub, "lease");
    const agent = await seedRunnerAgent(db, hub, "lease", runId, taskId);
    await db
      .prepare(
        `INSERT INTO checkout_leases
         (workspace_id, runner_id, physical_worktree_hash, execution_id,
          assignment_generation, fencing_generation, state, expires_at,
          observation_sequence, observed_at, identity_json, containment_reason, released_at)
         VALUES (?, ?, ?, ?, 1, 1, 'live', ?, 3, ?, NULL, NULL, NULL)`,
      )
      .run(FIX.workspace, agent.runnerId, TREE_HASH, agent.executionId, LATER, NOW);
    const leaseBefore = await db
      .prepare(`SELECT * FROM checkout_leases WHERE workspace_id = ? AND runner_id = ?`)
      .get(FIX.workspace, agent.runnerId);
    const submitted = ok(
      await hub.execute(
        submitResultCommand,
        human("lease-submit", { runId, summary: "Synthetic lease target" }),
      ),
    );
    const runVersion = (await readRun(db, runId)).resource_version;
    const taskVersion = (await readTask(db, taskId)).resource_version;
    ok(
      await hub.execute(
        acceptResultCommand,
        human("lease-accept", {
          runId,
          submissionId: submitted.submission.id,
          expectedRunVersion: runVersion,
          expectedTaskVersion: taskVersion,
        }),
      ),
    );
    const leaseAfter = await db
      .prepare(`SELECT * FROM checkout_leases WHERE workspace_id = ? AND runner_id = ?`)
      .get(FIX.workspace, agent.runnerId);
    expect(leaseAfter).toEqual(leaseBefore);
    expect(await readRun(db, runId)).toMatchObject({ result_state: "accepted" });
  });
});
