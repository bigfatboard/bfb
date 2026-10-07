// ABOUTME: Serves bounded project-scoped task, context, comment, run, and projection APIs.
// ABOUTME: Browser authority is translated into shared WorkspaceHub commands for every mutation.

import { createAuthorizationContext, type SqlDatabase } from "@bfb/db";
import { randomUUID } from "node:crypto";
import {
  acceptResultCommand,
  addCommentCommand,
  artifactEvidenceVersionMap,
  addContextCommand,
  addTaskDependencyCommand,
  addTaskLinkCommand,
  assertProjectAccess,
  assertTaskChildAccess,
  assertTaskSharingReceipt,
  cancelRunCommand,
  createExecutionCommand,
  createProviderSessionCommand,
  createRunCommand,
  createTaskCommand,
  DomainError,
  failRunCommand,
  getRunMeasurements,
  getTask,
  getTaskMeasurements,
  grantTaskSharingCommand,
  issueHumanTaskCollectionPositionCommand,
  isUlid,
  listReviewTimers,
  listResultSubmissions,
  listTasksPage,
  loadPrincipal,
  recordBrowserActivityCommand,
  readWorkBoard,
  readTaskSharing,
  readHumanTaskCollection,
  readHumanTaskCollectionPage,
  requestChangesCommand,
  revokeTaskSharingCommand,
  startReviewTimerCommand,
  stopReviewTimerCommand,
  submitResultCommand,
  taskAccessPredicate,
  transitionExecutionCommand,
  updateRunActivityCommand,
  updateTaskCommand,
  type EvidenceRef,
  type PagedHumanTaskCollection,
  type TaskPriority,
  type TaskState,
  type TaskSharingReceipt,
  type GrantTaskSharingInput,
  type RevokeTaskSharingInput,
} from "@bfb/domain";

import type { BrowserPrincipal } from "../auth/session.js";
import type { Jurisdiction } from "../env.js";
import {
  executePublicWorkspaceCommand as executeWorkspaceCommand,
  type PublicCommandOutcome,
} from "../public-command-outcome.js";
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

/** These four browser collections deliberately have no raw record-ID fallback. */
function taskCollectionPage(url: URL): { limit?: number; cursor?: string } {
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100))
    throw new DomainError("invalid_argument", "limit is invalid");
  const cursor = url.searchParams.get("cursor");
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === null ? {} : { cursor }),
  };
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
    publicAuthority: { ...principal, projectIds: [...principal.projectIds] },
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

  async function sharingOutcome(
    outcome: PublicCommandOutcome<TaskSharingReceipt>,
    input: GrantTaskSharingInput | RevokeTaskSharingInput,
  ) {
    // This follows the actual Hub RPC/body await. Historical receipts are not
    // assertions of current recipient access, but still require the creator now.
    if (outcome.ok) {
      if (
        outcome.result.task_id !== input.taskId ||
        outcome.result.access_version !== input.expectedAccessVersion + 1 ||
        ("grantId" in input && outcome.result.grant_id !== input.grantId)
      ) {
        throw new DomainError("not_found", "task sharing not found");
      }
      await assertTaskSharingReceipt(
        deps.db,
        principal,
        outcome.result,
        "humanId" in input ? input : undefined,
      );
    } else if (
      ["stale_version", "already_exists", "not_found", "command_failed"].includes(
        outcome.error.code,
      )
    ) {
      await readTaskSharing(deps.db, principal, input.taskId);
    }
    return outcomeResponse(outcome);
  }

  if (path === `${base}/board` && request.method === "GET") {
    const board = await readWorkBoard(
      deps.db,
      deps.workspaceId,
      principal.projectIds,
      deps.now,
      principal,
    );
    return json({
      human: { id: deps.principal.humanId, display_name: deps.principal.displayName },
      role: board.role,
      authorization_epoch: board.authorizationEpoch,
      lanes: board.lanes,
      needs_now: board.needsNow,
      agent_work_available: false,
      recent_events_available: board.recentEventsAvailable,
    });
  }

  if (path === `${base}/tasks` && request.method === "GET") {
    return json(
      await listTasksPage(deps.db, deps.workspaceId, principal.projectIds, {
        ...page(url),
        access: principal,
      }),
    );
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
    const record = await body(request, [
      "task_id",
      "started_at",
      "ended_at",
      "observation_id",
      "request_id",
    ]);
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
    if (rest === "/sharing" && request.method === "GET") {
      if (url.search) throw new DomainError("invalid_argument", "sharing query is invalid");
      return json({ sharing: await readTaskSharing(deps.db, principal, taskId) });
    }
    if (rest === "/sharing/grants" && request.method === "POST") {
      const record = await body(request, [
        "human_id",
        "permission",
        "expected_access_version",
        "request_id",
      ]);
      const input: GrantTaskSharingInput = {
        taskId,
        humanId: requiredString(record, "human_id"),
        permission: requiredString(record, "permission") as "read" | "contribute" | "edit",
        expectedAccessVersion: requiredVersion(record, "expected_access_version"),
      };
      return sharingOutcome(
        await execute(grantTaskSharingCommand, requestId(record), input),
        input,
      );
    }
    const sharingRevoke = rest.match(/^\/sharing\/grants\/([^/]+)\/revoke$/u);
    if (sharingRevoke && request.method === "POST") {
      const record = await body(request, ["expected_access_version", "request_id"]);
      const input: RevokeTaskSharingInput = {
        taskId,
        grantId: sharingRevoke[1] ?? "",
        expectedAccessVersion: requiredVersion(record, "expected_access_version"),
      };
      return sharingOutcome(
        await execute(revokeTaskSharingCommand, requestId(record), input),
        input,
      );
    }
    if (rest === "" && request.method === "GET") {
      if (!(await canReadTask(deps.db, principal, taskId))) {
        return json({ error: "not_found" }, 404);
      }
      const task = await getTask(deps.db, deps.workspaceId, taskId, principal);
      return task ? json({ task }) : json({ error: "not_found" }, 404);
    }
    if (rest === "/measurements" && request.method === "GET") {
      if (!(await canReadTask(deps.db, principal, taskId))) {
        return json({ error: "not_found" }, 404);
      }
      try {
        return json({
          measurements: await getTaskMeasurements(
            deps.db,
            deps.workspaceId,
            taskId,
            deps.now,
            principal,
          ),
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
      return json({ timers: await listReviewTimers(deps.db, deps.workspaceId, taskId, principal) });
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
    if (
      request.method === "GET" &&
      ["/comments", "/dependencies", "/links", "/runs"].includes(rest)
    ) {
      if (!(await canReadTask(deps.db, principal, taskId))) {
        return json({ error: "not_found" }, 404);
      }
      const collection = rest.slice(1) as PagedHumanTaskCollection;
      const result = await readHumanTaskCollectionPage(
        deps.db,
        principal,
        taskId,
        collection,
        taskCollectionPage(url),
        async (input) => {
          const outcome = await execute(
            issueHumanTaskCollectionPositionCommand,
            `task.collection-position.${randomUUID()}`,
            input,
          );
          if (!outcome.ok) throw new DomainError(outcome.error.code, outcome.error.message);
        },
      );
      if (!result) return json({ error: "not_found" }, 404);
      return json({
        [collection]: result.rows,
        limit: result.limit,
        has_more: result.has_more,
        next_cursor: result.next_cursor,
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
      const context = await readHumanTaskCollection(
        deps.db,
        principal,
        taskId,
        audience === "agent" ? "agent_context" : "context",
      );
      return context ? json({ context }) : json({ error: "not_found" }, 404);
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
  }

  const runMatch = path.match(new RegExp(`^${base}/runs/([^/]+)(.*)$`));
  if (runMatch) {
    const runId = runMatch[1] ?? "";
    const rest = runMatch[2] ?? "";
    if (rest === "/measurement-sources" && request.method === "GET") {
      if (!isUlid(runId)) throw new DomainError("invalid_argument", "run id is invalid");
      if ([...url.searchParams.keys()].some((name) => !["after_cursor", "limit"].includes(name))) {
        throw new DomainError("invalid_argument", "measurement source query is invalid");
      }
      const integer = (name: string, fallback: number): number => {
        const values = url.searchParams.getAll(name);
        if (values.length > 1 || (values.length && !/^[0-9]{1,16}$/.test(values[0]!))) {
          throw new DomainError("invalid_argument", "measurement source query is invalid");
        }
        return values.length ? Number(values[0]) : fallback;
      };
      const after = integer("after_cursor", 0),
        limit = integer("limit", 100);
      if (
        !Number.isSafeInteger(after) ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100
      ) {
        throw new DomainError("invalid_argument", "measurement source page is invalid");
      }
      return Response.json(
        { error: "request_rejected", message: "event feeds are unavailable" },
        { status: 409, headers: { "cache-control": "no-store" } },
      );
    }
    const predicate = taskAccessPredicate(principal, "read", "run_task");
    const run = (await deps.db
      .prepare(
        `SELECT run.id, run.project_id, run.task_id, run.requested_by_human_id, run.agent_profile_id,
                run.result_state, run.activity, run.resource_version, run.created_at
         FROM runs AS run JOIN tasks AS run_task
           ON run_task.workspace_id = run.workspace_id AND run_task.id = run.task_id
           AND run_task.project_id = run.project_id
         WHERE run.workspace_id = ? AND run.id = ? AND run.purpose = 'work' AND ${predicate.sql}`,
      )
      .get(deps.workspaceId, runId, ...predicate.parameters)) as { project_id: string } | undefined;
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
          measurements: await getRunMeasurements(
            deps.db,
            deps.workspaceId,
            runId,
            deps.now,
            principal,
          ),
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
      // V03 supplies current artifact versions so submissions bound to an
      // older artifact version read outdated without mutating history.
      const evidenceVersions = await artifactEvidenceVersionMap(
        deps.db,
        deps.workspaceId,
        principal,
      );
      return json({
        submissions: await listResultSubmissions(
          deps.db,
          deps.workspaceId,
          runId,
          evidenceVersions,
          principal,
        ),
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
          `SELECT snapshot.id, snapshot.project_id, snapshot.run_id, snapshot.workspace_policy_version,
                  snapshot.project_policy_version, snapshot.repository_config_version,
                  snapshot.agent_profile_id, snapshot.agent_profile_version, snapshot.canonical_json,
                  snapshot.content_hash, snapshot.created_at
           FROM run_configuration_snapshots AS snapshot
           JOIN runs AS run ON run.workspace_id = snapshot.workspace_id AND run.id = snapshot.run_id
             AND run.project_id = snapshot.project_id
           JOIN tasks AS run_task ON run_task.workspace_id = run.workspace_id
             AND run_task.id = run.task_id AND run_task.project_id = run.project_id
           WHERE snapshot.workspace_id = ? AND snapshot.run_id = ? AND ${predicate.sql}
           ORDER BY snapshot.snapshot_generation DESC LIMIT 1`,
        )
        .get(deps.workspaceId, runId, ...predicate.parameters);
      return snapshot ? json({ snapshot }) : json({ error: "not_found" }, 404);
    }
    if (rest === "/executions" && request.method === "GET") {
      const pagination = page(url);
      const limit = pagination.limit ?? 50;
      const rows = (await deps.db
        .prepare(
          `SELECT execution.id, execution.run_id, execution.state, execution.end_reason,
                  execution.resource_version, execution.created_at, execution.ended_at
           FROM run_executions AS execution
           JOIN runs AS run ON run.workspace_id = execution.workspace_id AND run.id = execution.run_id
           JOIN tasks AS run_task ON run_task.workspace_id = run.workspace_id
             AND run_task.id = run.task_id AND run_task.project_id = run.project_id
           WHERE execution.workspace_id = ? AND execution.run_id = ? AND ${predicate.sql}
             ${pagination.cursor ? "AND execution.id > ?" : ""}
           ORDER BY execution.id ASC LIMIT ?`,
        )
        .all(
          deps.workspaceId,
          runId,
          ...predicate.parameters,
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
          `SELECT session.id, session.run_id, session.execution_id, session.provider,
                  session.requested_session_id, session.observed_session_id, session.state,
                  session.resource_version, session.started_at, session.ended_at
           FROM provider_sessions AS session
           JOIN runs AS run ON run.workspace_id = session.workspace_id AND run.id = session.run_id
           JOIN tasks AS run_task ON run_task.workspace_id = run.workspace_id
             AND run_task.id = run.task_id AND run_task.project_id = run.project_id
           WHERE session.workspace_id = ? AND session.run_id = ? AND ${predicate.sql}
             ${pagination.cursor ? "AND session.id > ?" : ""}
           ORDER BY session.id ASC LIMIT ?`,
        )
        .all(
          deps.workspaceId,
          runId,
          ...predicate.parameters,
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
