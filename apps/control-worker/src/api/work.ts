// ABOUTME: Serves bounded project-scoped task, context, comment, run, and projection APIs.
// ABOUTME: Browser authority is translated into shared WorkspaceHub commands for every mutation.

import { createAuthorizationContext, type SqlDatabase } from "@bfb/db";
import {
  acceptResultCommand,
  addCommentCommand,
  addContextCommand,
  addTaskDependencyCommand,
  addTaskLinkCommand,
  assertProjectAccess,
  assertTaskChildAccess,
  buildNeedsNowDeck,
  buildProjectLanes,
  cancelRunCommand,
  createExecutionCommand,
  createProviderSessionCommand,
  createRunCommand,
  createTaskCommand,
  DomainError,
  failRunCommand,
  getAgentContext,
  getRunMeasurements,
  getTask,
  getTaskMeasurements,
  isUlid,
  listReviewTimers,
  listResultSubmissions,
  listTasksPage,
  loadPrincipal,
  recordBrowserActivityCommand,
  requestChangesCommand,
  startReviewTimerCommand,
  stopReviewTimerCommand,
  submitResultCommand,
  transitionExecutionCommand,
  updateRunActivityCommand,
  updateTaskCommand,
  type EvidenceRef,
  type TaskPriority,
  type TaskState,
} from "@bfb/domain";

import type { BrowserPrincipal } from "../auth/session.js";
import type { Jurisdiction } from "../env.js";
import { executeWorkspaceCommand } from "../hub-client.js";
import { readBoundedJson } from "./request.js";

const BODY_LIMIT = 32_768;

export interface WorkApiDeps {
  db: SqlDatabase;
  principal: BrowserPrincipal;
  workspaceId: string;
  now: string;
  jurisdiction: Jurisdiction;
  workspaceHubNs?: DurableObjectNamespace | undefined;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function objectBody(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("invalid_argument", "request body must be an object");
  }
  const body = value as Record<string, unknown>;
  const keys = new Set(allowed);
  if (Object.keys(body).some((key) => !keys.has(key))) {
    throw new DomainError("invalid_argument", "request body contains an unsupported field");
  }
  return body;
}

async function body(
  request: Request,
  allowed: readonly string[],
): Promise<Record<string, unknown>> {
  return objectBody(await readBoundedJson(request, BODY_LIMIT), allowed);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value) {
    throw new DomainError("invalid_argument", `${key} is required`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new DomainError("invalid_argument", `${key} must be a string`);
  }
  return value;
}

function nullableString(record: Record<string, unknown>, key: string): string | null | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof value !== "string") {
    throw new DomainError("invalid_argument", `${key} must be a string or null`);
  }
  return value;
}

function requiredVersion(record: Record<string, unknown>, key = "expected_version"): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new DomainError("invalid_argument", `${key} is required`);
  }
  return Number(value);
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new DomainError("invalid_argument", `${key} must be boolean`);
  }
  return value;
}

function requestId(record: Record<string, unknown>): string {
  const value = requiredString(record, "request_id");
  if (value.length < 8 || value.length > 128) {
    throw new DomainError("invalid_argument", "request_id is invalid");
  }
  return value;
}

function page(url: URL): { limit?: number; cursor?: string } {
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
    throw new DomainError("invalid_argument", "limit is invalid");
  }
  const cursor = url.searchParams.get("cursor") ?? undefined;
  if (cursor !== undefined && !isUlid(cursor)) {
    throw new DomainError("invalid_argument", "cursor is invalid");
  }
  return { ...(limit === undefined ? {} : { limit }), ...(cursor ? { cursor } : {}) };
}

function outcomeResponse(outcome: { ok: boolean; error?: { code: string } }): Response {
  if (outcome.ok) {
    return json(outcome);
  }
  const code = outcome.error?.code ?? "command_failed";
  const status =
    code === "forbidden" || code === "unauthenticated"
      ? 403
      : code === "not_found"
        ? 404
        : code === "stale_version" || code === "already_exists"
          ? 409
          : 400;
  return json(outcome, status);
}

function pagedBody<T extends { id: string }>(key: string, rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return {
    [key]: items,
    limit,
    has_more: hasMore,
    ...(hasMore ? { next_cursor: items[items.length - 1]!.id } : {}),
  };
}

async function canReadTask(
  db: SqlDatabase,
  principal: Awaited<ReturnType<typeof loadPrincipal>>,
  taskId: string,
): Promise<boolean> {
  try {
    await assertTaskChildAccess(db, principal, taskId);
    return true;
  } catch (error) {
    if (
      error instanceof DomainError &&
      (error.code === "forbidden" || error.code === "not_found")
    ) {
      return false;
    }
    throw error;
  }
}

export async function handleWorkApi(request: Request, deps: WorkApiDeps): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const base = `/api/v1/workspaces/${deps.workspaceId}`;
  const principal = await loadPrincipal(deps.db, deps.workspaceId, deps.principal.humanId);
  const hubDeps = {
    db: deps.db,
    authorization: createAuthorizationContext({
      workspaceId: deps.workspaceId,
      principalId: deps.principal.humanId,
      authorizationEpoch: principal.authorizationEpoch,
      jurisdiction: deps.jurisdiction,
    }),
    workspaceHubNs: deps.workspaceHubNs,
  };
  const execute = async <TInput, TResult>(
    command: Parameters<typeof executeWorkspaceCommand<TInput, TResult>>[1],
    idempotencyKey: string,
    input: TInput,
  ) =>
    executeWorkspaceCommand(hubDeps, command, {
      workspaceId: deps.workspaceId,
      idempotencyKey,
      authorizationEpoch: principal.authorizationEpoch,
      actorHumanId: deps.principal.humanId,
      now: deps.now,
      input,
    });

  if (path === `${base}/board` && request.method === "GET") {
    return json({
      human: { id: deps.principal.humanId, display_name: deps.principal.displayName },
      role: principal.role,
      authorization_epoch: principal.authorizationEpoch,
      lanes: await buildProjectLanes(deps.db, deps.workspaceId, principal.projectIds),
      needs_now: await buildNeedsNowDeck(
        deps.db,
        deps.workspaceId,
        deps.principal.humanId,
        principal.projectIds,
        deps.now,
      ),
      agent_work_available: false,
    });
  }

  if (path === `${base}/tasks` && request.method === "GET") {
    return json(await listTasksPage(deps.db, deps.workspaceId, principal.projectIds, page(url)));
  }
  if ((path === `${base}/tasks` || path === `${base}/tasks/propose`) && request.method === "POST") {
    const record = await body(request, [
      "project_id",
      "parent_task_id",
      "title",
      "priority",
      "due_at",
      "next_owner_type",
      "next_owner_id",
      "next_action_reason",
      "punchline",
      "request_id",
    ]);
    const parentTaskId = optionalString(record, "parent_task_id");
    const dueAt = optionalString(record, "due_at");
    const nextOwnerType = optionalString(record, "next_owner_type") as
      "human" | "agent_profile" | "unassigned" | undefined;
    const nextOwnerId = optionalString(record, "next_owner_id");
    const nextActionReason = optionalString(record, "next_action_reason");
    const punchline = optionalString(record, "punchline");
    const outcome = await execute(createTaskCommand, requestId(record), {
      projectId: requiredString(record, "project_id"),
      ...(parentTaskId === undefined ? {} : { parentTaskId }),
      title: requiredString(record, "title"),
      priority: (optionalString(record, "priority") ?? "P2") as TaskPriority,
      ...(path.endsWith("/propose") ? { state: "proposed" as const } : {}),
      ...(dueAt === undefined ? {} : { dueAt }),
      ...(nextOwnerType === undefined ? {} : { nextOwnerType }),
      ...(nextOwnerId === undefined ? {} : { nextOwnerId }),
      ...(nextActionReason === undefined ? {} : { nextActionReason }),
      ...(punchline === undefined ? {} : { punchline }),
    });
    return outcomeResponse(outcome);
  }

  if (path === `${base}/browser-activity` && request.method === "POST") {
    const record = await body(request, ["task_id", "started_at", "ended_at", "observation_id", "request_id"]);
    const taskId = optionalString(record, "task_id");
    const observationId = optionalString(record, "observation_id");
    return outcomeResponse(
      await execute(recordBrowserActivityCommand, requestId(record), {
        ...(taskId === undefined ? {} : { taskId }),
        startedAt: requiredString(record, "started_at"),
        endedAt: requiredString(record, "ended_at"),
        ...(observationId === undefined ? {} : { observationId }),
      }),
    );
  }

  const stopMatch = path.match(new RegExp(`^${base}/review-timers/([^/]+)/stop$`));
  if (stopMatch && request.method === "POST") {
    const record = await body(request, ["expected_version", "request_id"]);
    return outcomeResponse(
      await execute(stopReviewTimerCommand, requestId(record), {
        timerId: stopMatch[1] ?? "",
        expectedVersion: requiredVersion(record),
      }),
    );
  }

  const taskMatch = path.match(new RegExp(`^${base}/tasks/([^/]+)(.*)$`));
  if (taskMatch) {
    const taskId = taskMatch[1] ?? "";
    const rest = taskMatch[2] ?? "";
    if (rest === "" && request.method === "GET") {
      if (!(await canReadTask(deps.db, principal, taskId))) {
        return json({ error: "not_found" }, 404);
      }
      const task = await getTask(deps.db, deps.workspaceId, taskId);
      return task ? json({ task }) : json({ error: "not_found" }, 404);
    }
    if (rest === "/measurements" && request.method === "GET") {
      if (!(await canReadTask(deps.db, principal, taskId))) {
        return json({ error: "not_found" }, 404);
      }
      try {
        return json({
          measurements: await getTaskMeasurements(deps.db, deps.workspaceId, taskId, deps.now),
        });
      } catch (error) {
        if (error instanceof DomainError && error.code === "not_found") {
          return json({ error: "not_found" }, 404);
        }
        throw error;
      }
    }
    if (rest === "/review-timers" && request.method === "GET") {
      if (!(await canReadTask(deps.db, principal, taskId))) {
        return json({ error: "not_found" }, 404);
      }
      return json({ timers: await listReviewTimers(deps.db, deps.workspaceId, taskId) });
    }
    if (rest === "/review-timers" && request.method === "POST") {
      if (!(await canReadTask(deps.db, principal, taskId))) {
        return json({ error: "not_found" }, 404);
      }
      const record = await body(request, ["run_id", "request_id"]);
      const runId = optionalString(record, "run_id");
      return outcomeResponse(
        await execute(startReviewTimerCommand, requestId(record), {
          taskId,
          ...(runId === undefined ? {} : { runId }),
        }),
      );
    }
    if (rest === "" && request.method === "PATCH") {
      const record = await body(request, [
        "expected_version",
        "title",
        "state",
        "priority",
        "due_at",
        "next_owner_type",
        "next_owner_id",
        "next_action_reason",
        "punchline",
        "promote",
        "request_id",
      ]);
      const title = optionalString(record, "title");
      const state = optionalString(record, "state") as TaskState | undefined;
      const priority = optionalString(record, "priority") as TaskPriority | undefined;
      const dueAt = nullableString(record, "due_at");
      const nextOwnerType = optionalString(record, "next_owner_type") as
        "human" | "agent_profile" | "unassigned" | undefined;
      const nextOwnerId = nullableString(record, "next_owner_id");
      const nextActionReason = nullableString(record, "next_action_reason");
      const punchline = optionalString(record, "punchline");
      const promote = optionalBoolean(record, "promote");
      return outcomeResponse(
        await execute(updateTaskCommand, requestId(record), {
          taskId,
          expectedVersion: requiredVersion(record),
          ...(title === undefined ? {} : { title }),
          ...(state === undefined ? {} : { state }),
          ...(priority === undefined ? {} : { priority }),
          ...(dueAt === undefined ? {} : { dueAt }),
          ...(nextOwnerType === undefined ? {} : { nextOwnerType }),
          ...(nextOwnerId === undefined ? {} : { nextOwnerId }),
          ...(nextActionReason === undefined ? {} : { nextActionReason }),
          ...(punchline === undefined ? {} : { punchline }),
          ...(promote === undefined ? {} : { promote }),
        }),
      );
    }
    if (rest === "/comments" && request.method === "GET") {
      if (!(await canReadTask(deps.db, principal, taskId))) {
        return json({ error: "not_found" }, 404);
      }
      const pagination = page(url);
      const limit = pagination.limit ?? 50;
      const rows = (await deps.db
        .prepare(
          `SELECT id, author_human_id, author_delegation_id, body, kind, created_at
           FROM comments WHERE workspace_id = ? AND task_id = ?
             ${pagination.cursor ? "AND id > ?" : ""}
           ORDER BY id ASC LIMIT ?`,
        )
        .all(
          deps.workspaceId,
          taskId,
          ...(pagination.cursor ? [pagination.cursor] : []),
          limit + 1,
        )) as Array<{ id: string }>;
      const hasMore = rows.length > limit;
      const comments = hasMore ? rows.slice(0, limit) : rows;
      return json({
        comments,
        limit,
        has_more: hasMore,
        ...(hasMore ? { next_cursor: comments[comments.length - 1]?.id } : {}),
      });
    }
    if (rest === "/comments" && request.method === "POST") {
      const record = await body(request, ["body", "kind", "request_id"]);
      return outcomeResponse(
        await execute(addCommentCommand, requestId(record), {
          taskId,
          body: requiredString(record, "body"),
          kind: (optionalString(record, "kind") ?? "discussion") as "discussion" | "progress",
        }),
      );
    }
    if (rest === "/context" && request.method === "GET") {
      if (!(await canReadTask(deps.db, principal, taskId))) {
        return json({ error: "not_found" }, 404);
      }
      const audience = url.searchParams.get("audience") ?? "all";
      if (audience !== "all" && audience !== "agent") {
        throw new DomainError("invalid_argument", "context audience view is invalid");
      }
      if (audience === "agent") {
        return json({ context: await getAgentContext(deps.db, deps.workspaceId, taskId) });
      }
      return json({
        context: await deps.db
          .prepare(
            `SELECT id, kind, body, version, audience, content_hash, created_at
             FROM task_context_items WHERE workspace_id = ? AND task_id = ?
             ORDER BY version ASC`,
          )
          .all(deps.workspaceId, taskId),
      });
    }
    if (rest === "/context" && request.method === "POST") {
      const record = await body(request, ["kind", "audience", "body", "request_id"]);
      return outcomeResponse(
        await execute(addContextCommand, requestId(record), {
          taskId,
          kind: (optionalString(record, "kind") ?? "note") as
            "brief" | "acceptance" | "constraint" | "plan" | "decision" | "link" | "note",
          audience: requiredString(record, "audience") as "human" | "agent" | "both",
          body: requiredString(record, "body"),
        }),
      );
    }
    if (rest === "/dependencies" && request.method === "POST") {
      const record = await body(request, ["depends_on_task_id", "request_id"]);
      return outcomeResponse(
        await execute(addTaskDependencyCommand, requestId(record), {
          taskId,
          dependsOnTaskId: requiredString(record, "depends_on_task_id"),
        }),
      );
    }
    if (rest === "/dependencies" && request.method === "GET") {
      if (!(await canReadTask(deps.db, principal, taskId))) {
        return json({ error: "not_found" }, 404);
      }
      const pagination = page(url);
      const limit = pagination.limit ?? 50;
      const rows = (await deps.db
        .prepare(
          `SELECT dependency.depends_on_task_id, dependency.kind, dependency.created_at,
                  task.title, task.state, task.priority
           FROM task_dependencies AS dependency
           JOIN tasks AS task
             ON task.workspace_id = dependency.workspace_id
            AND task.id = dependency.depends_on_task_id
           WHERE dependency.workspace_id = ? AND dependency.task_id = ?
             ${pagination.cursor ? "AND dependency.depends_on_task_id > ?" : ""}
           ORDER BY dependency.depends_on_task_id ASC LIMIT ?`,
        )
        .all(
          deps.workspaceId,
          taskId,
          ...(pagination.cursor ? [pagination.cursor] : []),
          limit + 1,
        )) as Array<{ depends_on_task_id: string }>;
      const hasMore = rows.length > limit;
      const dependencies = hasMore ? rows.slice(0, limit) : rows;
      return json({
        dependencies,
        limit,
        has_more: hasMore,
        ...(hasMore
          ? { next_cursor: dependencies[dependencies.length - 1]!.depends_on_task_id }
          : {}),
      });
    }
    if (rest === "/links" && request.method === "POST") {
      const record = await body(request, ["kind", "url", "label", "request_id"]);
      return outcomeResponse(
        await execute(addTaskLinkCommand, requestId(record), {
          taskId,
          kind: requiredString(record, "kind") as "github" | "artifact" | "external",
          url: requiredString(record, "url"),
          label: requiredString(record, "label"),
        }),
      );
    }
    if (rest === "/links" && request.method === "GET") {
      if (!(await canReadTask(deps.db, principal, taskId))) {
        return json({ error: "not_found" }, 404);
      }
      const pagination = page(url);
      const limit = pagination.limit ?? 50;
      const rows = (await deps.db
        .prepare(
          `SELECT id, kind, url, label, created_at
           FROM task_links WHERE workspace_id = ? AND task_id = ?
             ${pagination.cursor ? "AND id > ?" : ""}
           ORDER BY id ASC LIMIT ?`,
        )
        .all(
          deps.workspaceId,
          taskId,
          ...(pagination.cursor ? [pagination.cursor] : []),
          limit + 1,
        )) as Array<{ id: string }>;
      return json(pagedBody("links", rows, limit));
    }
    if (rest === "/runs" && request.method === "POST") {
      const record = await body(request, [
        "expected_task_version",
        "agent_profile_id",
        "workspace_policy_version",
        "project_policy_version",
        "repository_config_version",
        "agent_profile_version",
        "request_id",
      ]);
      return outcomeResponse(
        await execute(createRunCommand, requestId(record), {
          taskId,
          expectedTaskVersion: requiredVersion(record, "expected_task_version"),
          agentProfileId: requiredString(record, "agent_profile_id"),
          workspacePolicyVersion: requiredVersion(record, "workspace_policy_version"),
          projectPolicyVersion: requiredVersion(record, "project_policy_version"),
          repositoryConfigVersion: requiredVersion(record, "repository_config_version"),
          agentProfileVersion: requiredVersion(record, "agent_profile_version"),
        }),
      );
    }
    if (rest === "/runs" && request.method === "GET") {
      if (!(await canReadTask(deps.db, principal, taskId))) {
        return json({ error: "not_found" }, 404);
      }
      const pagination = page(url);
      const limit = pagination.limit ?? 50;
      const rows = (await deps.db
        .prepare(
          `SELECT id, project_id, task_id, requested_by_human_id, agent_profile_id,
                  result_state, activity, resource_version, created_at
           FROM runs WHERE workspace_id = ? AND task_id = ? AND purpose = 'work'
             ${pagination.cursor ? "AND id > ?" : ""}
           ORDER BY id ASC LIMIT ?`,
        )
        .all(
          deps.workspaceId,
          taskId,
          ...(pagination.cursor ? [pagination.cursor] : []),
          limit + 1,
        )) as Array<{ id: string }>;
      return json(pagedBody("runs", rows, limit));
    }
  }

  const runMatch = path.match(new RegExp(`^${base}/runs/([^/]+)(.*)$`));
  if (runMatch) {
    const runId = runMatch[1] ?? "";
    const rest = runMatch[2] ?? "";
    const run = (await deps.db
      .prepare(
        `SELECT id, project_id, task_id, requested_by_human_id, agent_profile_id,
                result_state, activity, resource_version, created_at
         FROM runs WHERE workspace_id = ? AND id = ? AND purpose = 'work'`,
      )
      .get(deps.workspaceId, runId)) as { project_id: string } | undefined;
    if (!run) {
      return json({ error: "not_found" }, 404);
    }
    try {
      assertProjectAccess(principal, run.project_id);
    } catch {
      return json({ error: "not_found" }, 404);
    }
    if (rest === "" && request.method === "GET") {
      return json({ run });
    }
    if (rest === "/measurements" && request.method === "GET") {
      try {
        return json({
          measurements: await getRunMeasurements(deps.db, deps.workspaceId, runId, deps.now),
        });
      } catch (error) {
        if (error instanceof DomainError && error.code === "not_found") {
          return json({ error: "not_found" }, 404);
        }
        throw error;
      }
    }
    if (rest === "/activity" && request.method === "PATCH") {
      const record = await body(request, ["expected_version", "activity", "request_id"]);
      return outcomeResponse(
        await execute(updateRunActivityCommand, requestId(record), {
          runId,
          expectedVersion: requiredVersion(record),
          activity: requiredString(record, "activity") as
            | "working"
            | "needs_human"
            | "waiting_user_submit"
            | "waiting_external"
            | "idle"
            | "offline"
            | "unknown",
        }),
      );
    }
    if (rest === "/results" && request.method === "GET") {
      return json({
        submissions: await listResultSubmissions(deps.db, deps.workspaceId, runId),
      });
    }
    if (rest === "/results" && request.method === "POST") {
      const record = await body(request, [
        "summary",
        "limitations",
        "evidence_refs",
        "git_branch",
        "git_commit",
        "git_dirty",
        "request_id",
      ]);
      const limitations = optionalString(record, "limitations");
      const evidenceRefs = record["evidence_refs"] as EvidenceRef[] | undefined;
      const gitBranch = optionalString(record, "git_branch");
      const gitCommit = optionalString(record, "git_commit");
      const gitDirty = optionalBoolean(record, "git_dirty");
      return outcomeResponse(
        await execute(submitResultCommand, requestId(record), {
          runId,
          summary: requiredString(record, "summary"),
          ...(limitations === undefined ? {} : { limitations }),
          ...(evidenceRefs === undefined ? {} : { evidenceRefs }),
          ...(gitBranch === undefined ? {} : { gitBranch }),
          ...(gitCommit === undefined ? {} : { gitCommit }),
          ...(gitDirty === undefined ? {} : { gitDirty }),
        }),
      );
    }
    if (rest === "/review" && request.method === "POST") {
      const record = await body(request, [
        "decision",
        "submission_id",
        "expected_run_version",
        "expected_task_version",
        "comment",
        "request_id",
      ]);
      const decision = requiredString(record, "decision");
      if (decision !== "accept" && decision !== "request_changes") {
        throw new DomainError("invalid_argument", "review decision is invalid");
      }
      const comment = optionalString(record, "comment");
      const input = {
        runId,
        submissionId: requiredString(record, "submission_id"),
        expectedRunVersion: requiredVersion(record, "expected_run_version"),
        expectedTaskVersion: requiredVersion(record, "expected_task_version"),
        ...(comment === undefined ? {} : { comment }),
      };
      return outcomeResponse(
        await execute(
          decision === "accept" ? acceptResultCommand : requestChangesCommand,
          requestId(record),
          input,
        ),
      );
    }
    if (rest === "/failure" && request.method === "POST") {
      const record = await body(request, ["expected_run_version", "request_id"]);
      return outcomeResponse(
        await execute(failRunCommand, requestId(record), {
          runId,
          expectedRunVersion: requiredVersion(record, "expected_run_version"),
        }),
      );
    }
    if (rest === "/cancellation" && request.method === "POST") {
      const record = await body(request, ["expected_run_version", "request_id"]);
      return outcomeResponse(
        await execute(cancelRunCommand, requestId(record), {
          runId,
          expectedRunVersion: requiredVersion(record, "expected_run_version"),
        }),
      );
    }
    if (rest === "/snapshot" && request.method === "GET") {
      const snapshot = await deps.db
        .prepare(
          `SELECT id, project_id, run_id, workspace_policy_version,
                  project_policy_version, repository_config_version,
                  agent_profile_id, agent_profile_version, canonical_json,
                  content_hash, created_at
           FROM run_configuration_snapshots
           WHERE workspace_id = ? AND run_id = ?
           ORDER BY snapshot_generation DESC LIMIT 1`,
        )
        .get(deps.workspaceId, runId);
      return snapshot ? json({ snapshot }) : json({ error: "not_found" }, 404);
    }
    if (rest === "/executions" && request.method === "GET") {
      const pagination = page(url);
      const limit = pagination.limit ?? 50;
      const rows = (await deps.db
        .prepare(
          `SELECT id, run_id, state, end_reason, resource_version, created_at, ended_at
           FROM run_executions WHERE workspace_id = ? AND run_id = ?
             ${pagination.cursor ? "AND id > ?" : ""}
           ORDER BY id ASC LIMIT ?`,
        )
        .all(
          deps.workspaceId,
          runId,
          ...(pagination.cursor ? [pagination.cursor] : []),
          limit + 1,
        )) as Array<{ id: string }>;
      return json(pagedBody("executions", rows, limit));
    }
    if (rest === "/executions" && request.method === "POST") {
      const record = await body(request, ["request_id"]);
      return outcomeResponse(await execute(createExecutionCommand, requestId(record), { runId }));
    }
    if (rest === "/sessions" && request.method === "GET") {
      const pagination = page(url);
      const limit = pagination.limit ?? 50;
      const rows = (await deps.db
        .prepare(
          `SELECT id, run_id, execution_id, provider, requested_session_id,
                  observed_session_id, state, resource_version, started_at, ended_at
           FROM provider_sessions WHERE workspace_id = ? AND run_id = ?
             ${pagination.cursor ? "AND id > ?" : ""}
           ORDER BY id ASC LIMIT ?`,
        )
        .all(
          deps.workspaceId,
          runId,
          ...(pagination.cursor ? [pagination.cursor] : []),
          limit + 1,
        )) as Array<{ id: string }>;
      return json(pagedBody("sessions", rows, limit));
    }
    const executionMatch = rest.match(/^\/executions\/([^/]+)(.*)$/);
    if (executionMatch) {
      const executionId = executionMatch[1] ?? "";
      const executionRest = executionMatch[2] ?? "";
      if (executionRest === "" && request.method === "PATCH") {
        const record = await body(request, [
          "expected_version",
          "state",
          "end_reason",
          "request_id",
        ]);
        const endReason = optionalString(record, "end_reason") as
          "launch_blocked" | "launch_expired" | "process_exit" | "terminated" | "lost" | undefined;
        return outcomeResponse(
          await execute(transitionExecutionCommand, requestId(record), {
            runId,
            executionId,
            expectedVersion: requiredVersion(record),
            state: requiredString(record, "state") as
              "queued" | "launching" | "attached" | "detached" | "ended",
            ...(endReason === undefined ? {} : { endReason }),
          }),
        );
      }
      if (executionRest === "/sessions" && request.method === "POST") {
        const record = await body(request, ["provider", "requested_session_id", "request_id"]);
        const requestedSessionId = optionalString(record, "requested_session_id");
        return outcomeResponse(
          await execute(createProviderSessionCommand, requestId(record), {
            runId,
            executionId,
            provider: requiredString(record, "provider") as "claude" | "codex" | "grok" | "fake",
            ...(requestedSessionId === undefined ? {} : { requestedSessionId }),
          }),
        );
      }
    }
  }

  return json({ error: "not_found" }, 404);
}
