// ABOUTME: Exercises C08 task, context, comment, dependency, run, and execution commands.
// ABOUTME: Tests reject stale, cross-boundary, invalid-transition, and false-result mutations.

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { WorkspaceHub } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import { updateWorkspacePolicyCommand } from "../src/projects.js";
import {
  addCommentCommand,
  addContextCommand,
  addTaskDependencyCommand,
  addTaskLinkCommand,
  createTaskCommand,
  deliverDelegatedAgentContextCommand,
  deliverRunAgentContextCommand,
  getAgentContext,
  listTaskSubtreePage,
  listTasksPage,
  MAX_AGENT_READY_CHILDREN_PER_PARENT,
  MAX_CONTEXT_ITEMS_PER_TASK,
  reportProgressCommand,
  updateTaskCommand,
} from "../src/work-commands.js";
import {
  assertExecutionTransition,
  assertRunResultTransition,
  createExecutionCommand,
  createProviderSessionCommand,
  createRunCommand,
  transitionExecutionCommand,
} from "../src/work-records.js";
import { FIX } from "../src/fixtures.js";
import { openDomainDb } from "./helpers.js";

const NOW = "2026-08-12T08:00:00Z";
const LATER = "2026-08-12T09:00:00Z";

function humanRequest<T>(idempotencyKey: string, input: T) {
  return {
    workspaceId: FIX.workspace,
    idempotencyKey,
    authorizationEpoch: 1,
    actorHumanId: FIX.owner,
    now: NOW,
    input,
  };
}

async function delegation(
  db: Awaited<ReturnType<typeof openDomainDb>>,
  options: { humanId?: string; projectId?: string; taskId?: string; scopes?: string[] } = {},
): Promise<string> {
  const id = randomUlid();
  await db
    .prepare(
      `INSERT INTO oauth_delegations
       (workspace_id, id, human_id, client_id, resource, project_id, task_id,
        scopes_json, authorization_epoch, expires_at, created_at)
       VALUES (?, ?, ?, ?, 'https://bfb.example.test/mcp', ?, ?, ?, 1, ?, ?)`,
    )
    .run(
      FIX.workspace,
      id,
      options.humanId ?? FIX.owner,
      FIX.client,
      options.projectId ?? FIX.projectA,
      options.taskId ?? null,
      JSON.stringify(options.scopes ?? ["bfb:read", "bfb:task:write"]),
      LATER,
      NOW,
    );
  return id;
}

describe("work records", () => {
  it("enforces the compact task state machine, routing, and stale versions", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const created = await hub.execute(
      createTaskCommand,
      humanRequest("task-create", {
        projectId: FIX.projectA,
        title: "Ship board",
        priority: "P0",
        dueAt: "2026-08-12T08:30:00Z",
        nextOwnerType: "human",
        nextOwnerId: FIX.owner,
        nextActionReason: "Review board copy",
      }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    const active = await hub.execute(
      updateTaskCommand,
      humanRequest("task-active", {
        taskId: created.result.id,
        expectedVersion: 1,
        state: "active",
      }),
    );
    expect(active.ok && active.result.state).toBe("active");

    const stale = await hub.execute(
      updateTaskCommand,
      humanRequest("task-stale", {
        taskId: created.result.id,
        expectedVersion: 1,
        title: "Stale title",
      }),
    );
    expect(!stale.ok && stale.error.code).toBe("stale_version");

    const skippedReview = await hub.execute(
      updateTaskCommand,
      humanRequest("task-skip-review", {
        taskId: created.result.id,
        expectedVersion: 2,
        state: "done",
      }),
    );
    expect(!skippedReview.ok && skippedReview.error.code).toBe("invalid_transition");

    const reviewer = await hub.execute(createTaskCommand, {
      ...humanRequest("reviewer-create", {
        projectId: FIX.projectA,
        title: "Reviewer must not create",
        priority: "P3" as const,
      }),
      actorHumanId: FIX.reviewer,
    });
    expect(!reviewer.ok && reviewer.error.code).toBe("forbidden");
    const inaccessibleOwner = await hub.execute(
      createTaskCommand,
      humanRequest("task-inaccessible-owner", {
        projectId: FIX.projectB,
        title: "Invisible owner",
        priority: "P2" as const,
        nextOwnerType: "human" as const,
        nextOwnerId: FIX.reviewer,
      }),
    );
    expect(!inaccessibleOwner.ok && inaccessibleOwner.error.code).toBe("invalid_argument");
    await db
      .prepare(`UPDATE project_policies SET allow_pass_to_agent = 0 WHERE workspace_id = ?`)
      .run(FIX.workspace);
    const forbiddenProfile = await hub.execute(
      createTaskCommand,
      humanRequest("task-forbidden-profile", {
        projectId: FIX.projectA,
        title: "Forbidden agent owner",
        priority: "P2" as const,
        nextOwnerType: "agent_profile" as const,
        nextOwnerId: FIX.profileCodex,
      }),
    );
    expect(!forbiddenProfile.ok && forbiddenProfile.error.code).toBe("pass_to_agent_forbidden");
  });

  it("derives agent proposals from delegation authority and bounds child creation", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const projectDelegation = await delegation(db);
    const reviewerDelegation = await delegation(db, { humanId: FIX.reviewer });
    const deniedByRole = await hub.execute(createTaskCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "agent-root-role-denied",
      authorizationEpoch: 1,
      actorHumanId: FIX.reviewer,
      actorDelegationId: reviewerDelegation,
      now: NOW,
      input: {
        projectId: FIX.projectA,
        title: "Reviewer-sponsored delegation denial",
        priority: "P2",
      },
    });
    expect(!deniedByRole.ok && deniedByRole.error.code).toBe("forbidden");
    const readOnlyDelegation = await delegation(db, { scopes: ["bfb:read"] });
    const deniedByScope = await hub.execute(createTaskCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "agent-root-scope-denied",
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
      actorDelegationId: readOnlyDelegation,
      now: NOW,
      input: {
        projectId: FIX.projectA,
        title: "Read-only delegation denial",
        priority: "P2",
      },
    });
    expect(!deniedByScope.ok && deniedByScope.error.code).toBe("insufficient_scope");
    await db
      .prepare(
        `UPDATE workspace_policies SET allow_agent_root_propose = 0
         WHERE workspace_id = ?`,
      )
      .run(FIX.workspace);
    const deniedByWorkspace = await hub.execute(createTaskCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "agent-root-workspace-denied",
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
      actorDelegationId: projectDelegation,
      now: NOW,
      input: {
        projectId: FIX.projectA,
        title: "Workspace policy denial",
        priority: "P2",
      },
    });
    expect(!deniedByWorkspace.ok && deniedByWorkspace.error.code).toBe("forbidden");
    await db
      .prepare(
        `UPDATE workspace_policies SET allow_agent_root_propose = 1
         WHERE workspace_id = ?`,
      )
      .run(FIX.workspace);
    await db
      .prepare(
        `UPDATE repository_configs SET allow_agent_root_propose = 0
         WHERE workspace_id = ? AND project_id = ?`,
      )
      .run(FIX.workspace, FIX.projectA);
    const deniedByRepository = await hub.execute(createTaskCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "agent-root-repository-denied",
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
      actorDelegationId: projectDelegation,
      now: NOW,
      input: {
        projectId: FIX.projectA,
        title: "Repository policy denial",
        priority: "P2",
      },
    });
    expect(!deniedByRepository.ok && deniedByRepository.error.code).toBe("forbidden");
    await db
      .prepare(
        `UPDATE repository_configs SET allow_agent_root_propose = 1
         WHERE workspace_id = ? AND project_id = ?`,
      )
      .run(FIX.workspace, FIX.projectA);
    const proposed = await hub.execute(createTaskCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "agent-root",
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
      actorDelegationId: projectDelegation,
      now: NOW,
      input: {
        projectId: FIX.projectA,
        title: "Agent proposal",
        priority: "P2",
      },
    });
    expect(proposed.ok && proposed.result.state).toBe("proposed");
    if (!proposed.ok) {
      return;
    }

    const promote = await hub.execute(updateTaskCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "agent-promote",
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
      actorDelegationId: projectDelegation,
      now: NOW,
      input: { taskId: proposed.result.id, expectedVersion: 1, promote: true },
    });
    expect(!promote.ok && promote.error.code).toBe("forbidden");
    const reroute = await hub.execute(updateTaskCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "agent-reroute",
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
      actorDelegationId: projectDelegation,
      now: NOW,
      input: {
        taskId: proposed.result.id,
        expectedVersion: 1,
        nextActionReason: "Route this to a human",
      },
    });
    expect(!reroute.ok && reroute.error.code).toBe("forbidden");

    const root = await hub.execute(
      createTaskCommand,
      humanRequest("human-root", {
        projectId: FIX.projectA,
        title: "Human root",
        priority: "P1",
      }),
    );
    expect(root.ok).toBe(true);
    if (!root.ok) {
      return;
    }
    const taskDelegation = await delegation(db, { taskId: root.result.id });
    const child = await hub.execute(createTaskCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "agent-child",
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
      actorDelegationId: taskDelegation,
      now: NOW,
      input: {
        projectId: FIX.projectA,
        parentTaskId: root.result.id,
        title: "Bound child",
        priority: "P2",
      },
    });
    expect(child.ok && child.result).toMatchObject({
      parent_task_id: root.result.id,
      state: "ready",
    });
    if (!child.ok) {
      return;
    }
    const childComment = await hub.execute(addCommentCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "agent-child-comment",
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
      actorDelegationId: taskDelegation,
      now: NOW,
      input: { taskId: child.result.id, body: "Child progress", kind: "progress" },
    });
    expect(childComment.ok).toBe(true);
    const subtree = await listTaskSubtreePage(db, FIX.workspace, root.result.id, { limit: 10 });
    expect(subtree.tasks.map((task) => task.id).sort()).toEqual(
      [root.result.id, child.result.id].sort(),
    );
    for (let index = 1; index < MAX_AGENT_READY_CHILDREN_PER_PARENT; index++) {
      await db
        .prepare(
          `INSERT INTO tasks
           (workspace_id, id, project_id, parent_task_id, title, state, priority,
            next_owner_type, punchline, resource_version, created_by_human_id,
            created_by_delegation_id, created_at)
           VALUES (?, ?, ?, ?, ?, 'ready', 'P2', 'unassigned', ?, 1, ?, ?, ?)`,
        )
        .run(
          FIX.workspace,
          randomUlid(),
          FIX.projectA,
          root.result.id,
          `Bound child ${index}`,
          `Bound child ${index}`,
          FIX.owner,
          taskDelegation,
          NOW,
        );
    }
    const unboundedChild = await hub.execute(createTaskCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "agent-child-over-limit",
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
      actorDelegationId: taskDelegation,
      now: NOW,
      input: {
        projectId: FIX.projectA,
        parentTaskId: root.result.id,
        title: "Unbounded child",
        priority: "P2",
      },
    });
    expect(!unboundedChild.ok && unboundedChild.error.code).toBe("child_limit_reached");
    const escapedRoot = await hub.execute(createTaskCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "agent-escaped-root",
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
      actorDelegationId: taskDelegation,
      now: NOW,
      input: { projectId: FIX.projectA, title: "Escape", priority: "P2" },
    });
    expect(!escapedRoot.ok && escapedRoot.error.code).toBe("forbidden");
  });

  it("versions context, hides human items, records delivery, and rechecks revocation", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const created = await hub.execute(
      createTaskCommand,
      humanRequest("context-task", {
        projectId: FIX.projectA,
        title: "Context task",
        priority: "P2",
      }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    const human = await hub.execute(
      addContextCommand,
      humanRequest("context-human", {
        taskId: created.result.id,
        kind: "note",
        audience: "human",
        body: "Human-only internal note",
      }),
    );
    const agent = await hub.execute(
      addContextCommand,
      humanRequest("context-agent", {
        taskId: created.result.id,
        kind: "constraint",
        audience: "agent",
        body: "Use the public contract",
      }),
    );
    expect(human.ok && human.result.version).toBe(1);
    expect(agent.ok && agent.result.version).toBe(2);
    const view = await getAgentContext(db, FIX.workspace, created.result.id);
    expect(view.map((item) => item.body)).toEqual(["Use the public contract"]);
    expect(view[0]?.content_hash).toBe(
      `sha256:${createHash("sha256")
        .update(
          JSON.stringify({
            audience: "agent",
            body: "Use the public contract",
            kind: "constraint",
          }),
        )
        .digest("hex")}`,
    );

    const delegationId = await delegation(db, { taskId: created.result.id });
    const delivered = await hub.execute(deliverDelegatedAgentContextCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "context-delivery",
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
      actorDelegationId: delegationId,
      now: NOW,
      input: { taskId: created.result.id },
    });
    expect(delivered.ok && delivered.result).toHaveLength(1);
    const delivery = (await db
      .prepare(
        `SELECT delegation_id, client_id, context_version, content_hash
         FROM task_context_deliveries WHERE workspace_id = ?`,
      )
      .get(FIX.workspace)) as Record<string, unknown>;
    expect(delivery).toMatchObject({
      delegation_id: delegationId,
      client_id: FIX.client,
      context_version: 2,
      content_hash: view[0]?.content_hash,
    });
    await expect(
      db
        .prepare(`UPDATE task_context_deliveries SET delivered_at = ? WHERE workspace_id = ?`)
        .run(LATER, FIX.workspace),
    ).rejects.toThrow(/immutable/);
    await expect(
      db
        .prepare(`UPDATE task_context_items SET body = 'rewritten' WHERE workspace_id = ?`)
        .run(FIX.workspace),
    ).rejects.toThrow(/immutable/);
    await db
      .prepare(`UPDATE oauth_delegations SET revoked_at = ? WHERE workspace_id = ? AND id = ?`)
      .run(NOW, FIX.workspace, delegationId);
    await expect(
      hub.execute(deliverDelegatedAgentContextCommand, {
        workspaceId: FIX.workspace,
        idempotencyKey: "context-delivery-revoked",
        authorizationEpoch: 1,
        actorHumanId: FIX.owner,
        actorDelegationId: delegationId,
        now: NOW,
        input: { taskId: created.result.id },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "forbidden" } });
    for (let version = 3; version <= MAX_CONTEXT_ITEMS_PER_TASK; version++) {
      await db
        .prepare(
          `INSERT INTO task_context_items
           (workspace_id, id, task_id, kind, audience, body, version, content_hash, created_at)
           VALUES (?, ?, ?, 'note', 'human', 'bounded', ?, ?, ?)`,
        )
        .run(
          FIX.workspace,
          randomUlid(),
          created.result.id,
          version,
          `sha256:${String(version).padStart(64, "0")}`,
          NOW,
        );
    }
    const overLimit = await hub.execute(
      addContextCommand,
      humanRequest("context-over-limit", {
        taskId: created.result.id,
        kind: "note",
        audience: "human",
        body: "One context version too many",
      }),
    );
    expect(!overLimit.ok && overLimit.error.code).toBe("context_limit_reached");
  });

  it("stores bounded comments, progress, links, and acyclic same-project dependencies", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const first = await hub.execute(
      createTaskCommand,
      humanRequest("graph-first", {
        projectId: FIX.projectA,
        title: "First",
        priority: "P2",
      }),
    );
    const second = await hub.execute(
      createTaskCommand,
      humanRequest("graph-second", {
        projectId: FIX.projectA,
        title: "Second",
        priority: "P2",
      }),
    );
    const third = await hub.execute(
      createTaskCommand,
      humanRequest("graph-third", {
        projectId: FIX.projectA,
        title: "Third",
        priority: "P2",
      }),
    );
    expect(first.ok && second.ok && third.ok).toBe(true);
    if (!first.ok || !second.ok || !third.ok) {
      return;
    }
    expect(
      (
        await hub.execute(
          addTaskDependencyCommand,
          humanRequest("dependency", {
            taskId: first.result.id,
            dependsOnTaskId: second.result.id,
          }),
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await hub.execute(
          addTaskDependencyCommand,
          humanRequest("dependency-second-third", {
            taskId: second.result.id,
            dependsOnTaskId: third.result.id,
          }),
        )
      ).ok,
    ).toBe(true);
    const cycle = await hub.execute(
      addTaskDependencyCommand,
      humanRequest("dependency-cycle", {
        taskId: third.result.id,
        dependsOnTaskId: first.result.id,
      }),
    );
    expect(!cycle.ok && cycle.error.code).toBe("invalid_argument");
    expect(
      (
        await hub.execute(
          addTaskLinkCommand,
          humanRequest("task-link", {
            taskId: first.result.id,
            kind: "github",
            url: "https://github.com/qdis/bfb/pull/3",
            label: "PR 3",
          }),
        )
      ).ok,
    ).toBe(true);
    const unsafeLink = await hub.execute(
      addTaskLinkCommand,
      humanRequest("unsafe-link", {
        taskId: first.result.id,
        kind: "external",
        url: "http://user:secret@example.test/path",
        label: "unsafe",
      }),
    );
    expect(!unsafeLink.ok && unsafeLink.error.code).toBe("invalid_argument");
    expect(
      (
        await hub.execute(
          addCommentCommand,
          humanRequest("discussion", {
            taskId: first.result.id,
            body: "Review the dependency",
            kind: "discussion",
          }),
        )
      ).ok,
    ).toBe(true);
    const reviewerComment = await hub.execute(addCommentCommand, {
      ...humanRequest("reviewer-discussion", {
        taskId: first.result.id,
        body: "Reviewer feedback",
        kind: "discussion" as const,
      }),
      actorHumanId: FIX.reviewer,
    });
    expect(reviewerComment.ok).toBe(true);
    const delegationId = await delegation(db, { taskId: first.result.id });
    const progress = await hub.execute(reportProgressCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "delegated-progress",
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
      actorDelegationId: delegationId,
      now: NOW,
      input: { taskId: first.result.id, body: "Tests are green", kind: "progress" },
    });
    expect(progress.ok).toBe(true);
  });

  it("creates immutable run snapshots and keeps result, execution, and session state separate", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const task = await hub.execute(
      createTaskCommand,
      humanRequest("run-task", {
        projectId: FIX.projectA,
        title: "Run task",
        priority: "P1",
        nextOwnerType: "agent_profile",
        nextOwnerId: FIX.profileCodex,
      }),
    );
    expect(task.ok).toBe(true);
    if (!task.ok) {
      return;
    }
    const runContext = await hub.execute(
      addContextCommand,
      humanRequest("run-context", {
        taskId: task.result.id,
        kind: "brief",
        audience: "agent",
        body: "Run-scoped context",
      }),
    );
    expect(runContext.ok).toBe(true);
    const run = await hub.execute(
      createRunCommand,
      humanRequest("run-create", {
        taskId: task.result.id,
        expectedTaskVersion: 1,
        agentProfileId: FIX.profileCodex,
        workspacePolicyVersion: 1,
        projectPolicyVersion: 1,
        repositoryConfigVersion: 1,
        agentProfileVersion: 1,
      }),
    );
    expect(run.ok && run.result).toMatchObject({
      run: { result_state: "open", activity: "unknown" },
      task: { state: "active", resource_version: 2 },
    });
    if (!run.ok) {
      return;
    }
    const runDelivery = await hub.execute(deliverRunAgentContextCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "run-context-delivery",
      authorizationEpoch: 1,
      actorSystemId: run.result.run.id,
      now: NOW,
      input: { taskId: task.result.id },
    });
    expect(runDelivery.ok && runDelivery.result).toHaveLength(1);
    expect(run.result.snapshot.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const snapshotBefore = run.result.snapshot.canonicalJson;
    await db
      .prepare(
        `UPDATE project_policies SET allow_pass_to_agent = 0, resource_version = 2
         WHERE workspace_id = ? AND project_id = ?`,
      )
      .run(FIX.workspace, FIX.projectA);
    const snapshotAfter = (await db
      .prepare(
        `SELECT canonical_json FROM run_configuration_snapshots
         WHERE workspace_id = ? AND run_id = ?`,
      )
      .get(FIX.workspace, run.result.run.id)) as { canonical_json: string };
    expect(snapshotAfter.canonical_json).toBe(snapshotBefore);
    await db
      .prepare(
        `UPDATE project_policies SET allow_pass_to_agent = 1, resource_version = 1
         WHERE workspace_id = ? AND project_id = ?`,
      )
      .run(FIX.workspace, FIX.projectA);
    await expect(
      db
        .prepare(
          `UPDATE run_configuration_snapshots SET canonical_json = '{}'
           WHERE workspace_id = ? AND run_id = ?`,
        )
        .run(FIX.workspace, run.result.run.id),
    ).rejects.toThrow(/immutable/);

    const execution = await hub.execute(
      createExecutionCommand,
      humanRequest("execution-create", { runId: run.result.run.id }),
    );
    expect(execution.ok && execution.result.state).toBe("queued");
    if (!execution.ok) {
      return;
    }
    const launching = await hub.execute(
      transitionExecutionCommand,
      humanRequest("execution-launching", {
        runId: run.result.run.id,
        executionId: execution.result.id,
        expectedVersion: 1,
        state: "launching",
      }),
    );
    expect(launching.ok && launching.result.state).toBe("launching");
    const attached = await hub.execute(
      transitionExecutionCommand,
      humanRequest("execution-attached", {
        runId: run.result.run.id,
        executionId: execution.result.id,
        expectedVersion: 2,
        state: "attached",
      }),
    );
    expect(attached.ok && attached.result.state).toBe("attached");
    const session = await hub.execute(
      createProviderSessionCommand,
      humanRequest("provider-session", {
        runId: run.result.run.id,
        executionId: execution.result.id,
        provider: "codex",
        requestedSessionId: "requested-session-1",
      }),
    );
    expect(session.ok && session.result).toMatchObject({
      requestedSessionId: "requested-session-1",
      observedSessionId: null,
    });
    await db
      .prepare(`UPDATE runs SET result_state = 'accepted' WHERE workspace_id = ? AND id = ?`)
      .run(FIX.workspace, run.result.run.id);
    const terminalSession = await hub.execute(
      createProviderSessionCommand,
      humanRequest("provider-session-terminal-run", {
        runId: run.result.run.id,
        executionId: execution.result.id,
        provider: "codex",
      }),
    );
    expect(!terminalSession.ok && terminalSession.error.code).toBe("invalid_transition");
    await db
      .prepare(`UPDATE runs SET result_state = 'open' WHERE workspace_id = ? AND id = ?`)
      .run(FIX.workspace, run.result.run.id);
    const mismatchedSession = await hub.execute(
      createProviderSessionCommand,
      humanRequest("provider-session-mismatch", {
        runId: run.result.run.id,
        executionId: execution.result.id,
        provider: "claude",
      }),
    );
    expect(!mismatchedSession.ok && mismatchedSession.error.code).toBe("provider_forbidden");
    const mismatchedRun = await hub.execute(
      transitionExecutionCommand,
      humanRequest("execution-run-mismatch", {
        runId: randomUlid(),
        executionId: execution.result.id,
        expectedVersion: 3,
        state: "ended",
        endReason: "process_exit",
      }),
    );
    expect(!mismatchedRun.ok && mismatchedRun.error.code).toBe("not_found");
    const ended = await hub.execute(
      transitionExecutionCommand,
      humanRequest("execution-ended", {
        runId: run.result.run.id,
        executionId: execution.result.id,
        expectedVersion: 3,
        state: "ended",
        endReason: "process_exit",
      }),
    );
    expect(ended.ok && ended.result).toMatchObject({
      state: "ended",
      end_reason: "process_exit",
    });
    const persistedRun = (await db
      .prepare(`SELECT result_state FROM runs WHERE workspace_id = ? AND id = ?`)
      .get(FIX.workspace, run.result.run.id)) as { result_state: string };
    const persistedTask = (await db
      .prepare(`SELECT state FROM tasks WHERE workspace_id = ? AND id = ?`)
      .get(FIX.workspace, task.result.id)) as { state: string };
    expect(persistedRun.result_state).toBe("open");
    expect(persistedTask.state).toBe("active");
    const secondAttempt = await hub.execute(
      createExecutionCommand,
      humanRequest("execution-after-session", { runId: run.result.run.id }),
    );
    expect(!secondAttempt.ok && secondAttempt.error.code).toBe("invalid_transition");
    expect(() => assertExecutionTransition("ended", "attached")).toThrow(/cannot move/);
    expect(() => assertRunResultTransition("open", "accepted")).toThrow(/cannot move/);

    const tightenedTask = await hub.execute(
      createTaskCommand,
      humanRequest("tightened-run-task", {
        projectId: FIX.projectA,
        title: "Respect current policy versions",
        priority: "P2",
      }),
    );
    expect(tightenedTask.ok).toBe(true);
    if (!tightenedTask.ok) {
      return;
    }
    const tightened = await hub.execute(
      updateWorkspacePolicyCommand,
      humanRequest("tighten-workspace-policy", {
        expectedVersion: 1,
        allowedProviders: ["codex" as const],
        allowAgentRootPropose: true,
        allowPassToAgent: false,
        allowRunOverrides: false,
      }),
    );
    expect(tightened.ok && tightened.result.resourceVersion).toBe(2);
    const historicalPolicyRun = await hub.execute(
      createRunCommand,
      humanRequest("historical-policy-run", {
        taskId: tightenedTask.result.id,
        expectedTaskVersion: 1,
        agentProfileId: FIX.profileCodex,
        workspacePolicyVersion: 1,
        projectPolicyVersion: 1,
        repositoryConfigVersion: 1,
        agentProfileVersion: 1,
      }),
    );
    expect(!historicalPolicyRun.ok && historicalPolicyRun.error.code).toBe("stale_version");
    const forbiddenPolicyRun = await hub.execute(
      createRunCommand,
      humanRequest("forbidden-policy-run", {
        taskId: tightenedTask.result.id,
        expectedTaskVersion: 1,
        agentProfileId: FIX.profileCodex,
        workspacePolicyVersion: 2,
        projectPolicyVersion: 1,
        repositoryConfigVersion: 1,
        agentProfileVersion: 1,
      }),
    );
    expect(!forbiddenPolicyRun.ok && forbiddenPolicyRun.error.code).toBe("pass_to_agent_forbidden");
  });

  it("paginates task records deterministically", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    for (let index = 0; index < 3; index++) {
      const outcome = await hub.execute(
        createTaskCommand,
        humanRequest(`page-task-${index}`, {
          projectId: FIX.projectA,
          title: `Task ${index}`,
          priority: "P2",
        }),
      );
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    }
    const first = await listTasksPage(db, FIX.workspace, [FIX.projectA], { limit: 2 });
    const second = await listTasksPage(db, FIX.workspace, [FIX.projectA], {
      limit: 2,
      cursor: first.next_cursor,
    });
    expect(first.tasks).toHaveLength(2);
    expect(first.has_more).toBe(true);
    expect(second.tasks).toHaveLength(1);
    expect(new Set([...first.tasks, ...second.tasks].map((task) => task.id)).size).toBe(3);
  });
});
