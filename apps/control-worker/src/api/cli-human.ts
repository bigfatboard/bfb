// ABOUTME: Serves the X02 human CLI mirror over bearer CLI credentials only.
// ABOUTME: Reads and guarded writes reuse domain commands; this file owns no domain mutation.

import { createAuthorizationContext, type SqlDatabase } from "@bfb/db";
import {
  answerAttentionCommand,
  assertTaskChildAccess,
  cancelRunCommand,
  consumeStepUpProof,
  createTaskCommand,
  DomainError,
  getAttention,
  getProject,
  getTask,
  isUlid,
  listAttention,
  listAttentionObservations,
  listProjectsPage,
  listTasksPage,
  loadPrincipal,
  resolveAttentionCommand,
  resolveCliPrincipal,
  revokeBindingCommand,
  type AttentionState,
  type CliPrincipal,
  type HubCommand,
  type TaskPriority,
} from "@bfb/domain";

import type { Jurisdiction } from "../env.js";
import { executeWorkspaceCommand } from "../hub-client.js";
import { readBoundedJson } from "./request.js";

const BODY_LIMIT = 32_768;

/** Frozen human CLI surface version served to `bfb version` and compat checks. */
export const CLI_API_VERSION = "1";
export const CLI_WIRE_PROTOCOL = "bfb-wire/1";
export const CLI_MIN_VERSION = "0.1.0";

export const CLI_RUN_CANCEL_ACTION = "cli:run:cancel";

export interface CliHumanDeps {
  db: SqlDatabase;
  now: string;
  jurisdiction: Jurisdiction;
  workspaceHubNs?: DurableObjectNamespace | undefined;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

function unauthenticated(): Response {
  return json({ error: "unauthenticated", message: "CLI credential required" }, 401);
}

function confused(): Response {
  return json(
    { error: "credential_confusion", message: "CLI routes accept bearer CLI credentials only" },
    401,
  );
}

function rejected(): Response {
  return json({ error: "request_rejected", message: "request rejected" }, 403);
}

function fail(error: unknown): Response {
  if (error instanceof DomainError) {
    const status =
      error.code === "not_found"
        ? 404
        : error.code === "forbidden" || error.code === "unauthenticated"
          ? 403
          : error.code.startsWith("step_up_")
            ? 403
            : error.code === "body_too_large"
              ? 413
              : error.code === "invalid_argument" || error.code === "invalid_json"
                ? 400
                : 409;
    return json({ error: error.code, message: error.message }, status);
  }
  return json({ error: "request_failed", message: "request failed" }, 500);
}

/** Resolves the bearer human credential; cookies and browser origins never authenticate here. */
async function authenticate(
  request: Request,
  deps: Pick<CliHumanDeps, "db" | "now">,
): Promise<CliPrincipal> {
  if (request.headers.has("cookie") || request.headers.has("origin")) {
    throw new DomainError("credential_confusion", "CLI routes accept bearer CLI credentials only");
  }
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9._~-]{1,512})$/.exec(authorization);
  if (!match?.[1]) {
    throw new DomainError("unauthenticated", "CLI credential required");
  }
  return resolveCliPrincipal(deps.db, match[1], deps.now);
}

function objectBody(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("invalid_argument", "request body must be an object");
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new DomainError("invalid_argument", "request body contains an unsupported field");
  }
  return body;
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
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new DomainError("invalid_argument", `${key} must be a string`);
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

/**
 * Mirrors the browser project boundary: out-of-scope projects read as
 * not_found so the CLI discloses no more existence than the web API.
 */
function assertCliProject(projectIds: readonly string[], projectId: string): void {
  if (!projectIds.includes(projectId)) {
    throw new DomainError("not_found", "project not found");
  }
}

function outcomeResponse(outcome: { ok: boolean; error?: { code: string } }): Response {
  if (outcome.ok) return json(outcome);
  const code = outcome.error?.code ?? "command_failed";
  const status =
    code === "forbidden" || code === "unauthenticated"
      ? 403
      : code === "not_found"
        ? 404
        : code === "stale_version" || code === "already_exists" || code === "already_answered"
          ? 409
          : 400;
  return json(outcome, status);
}

/** Action-bound fresh-proof target for destructive run cancellation through the CLI. */
export function cliRunCancelTarget(runId: string, expectedRunVersion: number): string {
  return `cli:run:cancel:${runId}:${expectedRunVersion}`;
}

export async function handleCliHumanApi(
  request: Request,
  deps: CliHumanDeps,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  try {
    if (request.method === "GET" && path === "/api/v1/cli/version") {
      return json({
        api_version: CLI_API_VERSION,
        wire_protocol: CLI_WIRE_PROTOCOL,
        cli_min_version: CLI_MIN_VERSION,
        now: deps.now,
      });
    }
    const cli = await authenticate(request, deps);
    const workspaceId = cli.workspaceId;
    const current = await loadPrincipal(deps.db, workspaceId, cli.humanId);
    // The binding narrows project scope: every downstream read and command
    // observes the intersection, never the member's full grant.
    const principal = {
      ...current,
      projectIds: current.projectIds.filter((id) => cli.projectIds.includes(id)),
    };
    const hubDeps = {
      db: deps.db,
      authorization: createAuthorizationContext({
        workspaceId,
        principalId: cli.humanId,
        authorizationEpoch: principal.authorizationEpoch,
        jurisdiction: deps.jurisdiction,
      }),
      workspaceHubNs: deps.workspaceHubNs,
    };
    const execute = async <TInput, TResult>(
      command: HubCommand<TInput, TResult>,
      idempotencyKey: string,
      input: TInput,
    ) =>
      executeWorkspaceCommand(hubDeps, command, {
        workspaceId,
        idempotencyKey,
        authorizationEpoch: principal.authorizationEpoch,
        actorHumanId: cli.humanId,
        now: deps.now,
        input,
      });

    if (request.method === "POST" && path === "/api/v1/cli/session/revoke") {
      const outcome = await execute(revokeBindingCommand, `cli-revoke-${cli.bindingId}`, {
        bindingId: cli.bindingId,
      });
      return outcomeResponse(outcome);
    }

    if (request.method === "GET" && path === "/api/v1/cli/projects") {
      return json(await listProjectsPage(deps.db, principal, page(url)));
    }
    const projectMatch = /^\/api\/v1\/cli\/projects\/([^/]+)$/.exec(path);
    if (projectMatch && request.method === "GET") {
      const projectId = projectMatch[1] ?? "";
      assertCliProject(principal.projectIds, projectId);
      const record = await getProject(deps.db, workspaceId, projectId);
      return record ? json({ project: record }) : json({ error: "not_found" }, 404);
    }

    if (request.method === "GET" && path === "/api/v1/cli/tasks") {
      return json(await listTasksPage(deps.db, workspaceId, principal.projectIds, page(url)));
    }
    if (request.method === "POST" && path === "/api/v1/cli/tasks") {
      const record = objectBody(await readBoundedJson(request, BODY_LIMIT), [
        "project_id",
        "title",
        "priority",
        "request_id",
      ]);
      // Hub commands re-resolve the member's full grant from the human ID,
      // so the binding subset is enforced here before dispatch.
      const projectId = requiredString(record, "project_id");
      assertCliProject(principal.projectIds, projectId);
      const outcome = await execute(createTaskCommand, requestId(record), {
        projectId,
        title: requiredString(record, "title"),
        priority: (optionalString(record, "priority") ?? "P2") as TaskPriority,
      });
      return outcomeResponse(outcome);
    }
    const taskMatch = /^\/api\/v1\/cli\/tasks\/([^/]+)$/.exec(path);
    if (taskMatch && request.method === "GET") {
      const taskId = taskMatch[1] ?? "";
      try {
        await assertTaskChildAccess(deps.db, principal, taskId);
      } catch (error) {
        if (
          error instanceof DomainError &&
          (error.code === "forbidden" || error.code === "not_found")
        ) {
          return json({ error: "not_found" }, 404);
        }
        throw error;
      }
      const task = await getTask(deps.db, workspaceId, taskId);
      return task ? json({ task }) : json({ error: "not_found" }, 404);
    }

    if (request.method === "GET" && path === "/api/v1/cli/runs") {
      const taskId = url.searchParams.get("task_id") ?? "";
      if (!taskId) throw new DomainError("invalid_argument", "task_id is required");
      try {
        await assertTaskChildAccess(deps.db, principal, taskId);
      } catch (error) {
        if (
          error instanceof DomainError &&
          (error.code === "forbidden" || error.code === "not_found")
        ) {
          return json({ error: "not_found" }, 404);
        }
        throw error;
      }
      // Mirrors the browser task-runs read column for column so one human
      // observes identical run state on both surfaces.
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
          workspaceId,
          taskId,
          ...(pagination.cursor ? [pagination.cursor] : []),
          limit + 1,
        )) as Array<{ id: string }>;
      const hasMore = rows.length > limit;
      const runs = hasMore ? rows.slice(0, limit) : rows;
      return json({
        runs,
        limit,
        has_more: hasMore,
        ...(hasMore ? { next_cursor: runs[runs.length - 1]!.id } : {}),
      });
    }
    const runMatch = /^\/api\/v1\/cli\/runs\/([^/]+)(\/.*)?$/.exec(path);
    if (runMatch) {
      const runId = runMatch[1] ?? "";
      const rest = runMatch[2] ?? "";
      const run = (await deps.db
        .prepare(
          `SELECT id, project_id, task_id, requested_by_human_id, agent_profile_id,
                  result_state, activity, resource_version, created_at
           FROM runs WHERE workspace_id = ? AND id = ? AND purpose = 'work'`,
        )
        .get(workspaceId, runId)) as
        | { id: string; task_id: string; project_id: string }
        | undefined;
      if (!run || !principal.projectIds.includes(run.project_id)) {
        return json({ error: "not_found" }, 404);
      }
      if (rest === "" && request.method === "GET") {
        return json({ run });
      }
      if (rest === "/cancellation" && request.method === "POST") {
        const record = objectBody(await readBoundedJson(request, BODY_LIMIT), [
          "expected_run_version",
          "confirm",
          "step_up_proof_id",
          "request_id",
        ]);
        const expectedRunVersion = requiredVersion(record, "expected_run_version");
        if (requiredString(record, "confirm") !== `run:${runId}`) {
          throw new DomainError("invalid_argument", "confirm must name the run");
        }
        const proofId = requiredString(record, "step_up_proof_id");
        const proof = (await deps.db
          .prepare(`SELECT expires_at FROM passkey_step_up_proofs WHERE proof_id = ?`)
          .get(proofId)) as { expires_at: string } | undefined;
        if (!proof) throw new DomainError("step_up_invalid", "step-up proof not found");
        await consumeStepUpProof(
          deps.db,
          proofId,
          {
            action: CLI_RUN_CANCEL_ACTION,
            workspaceId,
            targetId: cliRunCancelTarget(runId, expectedRunVersion),
            scopes: [...cli.scopes].sort(),
            authorizationEpoch: principal.authorizationEpoch,
            expiresAt: proof.expires_at,
          },
          deps.now,
          cli.humanId,
        );
        return outcomeResponse(
          await execute(cancelRunCommand, requestId(record), { runId, expectedRunVersion }),
        );
      }
    }

    if (request.method === "GET" && path === "/api/v1/cli/attention") {
      const rawState = url.searchParams.get("state");
      const pagination = page(url);
      if (rawState !== null && !["open", "answered", "resolved"].includes(rawState)) {
        throw new DomainError("invalid_argument", "attention state filter is invalid");
      }
      return json({
        attention: await listAttention(deps.db, workspaceId, principal.projectIds, {
          ...(rawState === null ? {} : { state: rawState as AttentionState }),
          ...(pagination.limit === undefined ? {} : { limit: pagination.limit }),
        }),
      });
    }
    const attentionMatch = /^\/api\/v1\/cli\/attention\/([^/]+)(\/.*)?$/.exec(path);
    if (attentionMatch) {
      const attentionId = attentionMatch[1] ?? "";
      const rest = attentionMatch[2] ?? "";
      if (rest === "" && request.method === "GET") {
        const attention = await getAttention(
          deps.db,
          workspaceId,
          principal.projectIds,
          attentionId,
        );
        if (!attention) return json({ error: "not_found" }, 404);
        return json({
          attention,
          observations: await listAttentionObservations(
            deps.db,
            workspaceId,
            principal.projectIds,
            attentionId,
          ),
        });
      }
      if (rest === "/answer" && request.method === "POST") {
        const record = objectBody(await readBoundedJson(request, BODY_LIMIT), [
          "expected_version",
          "answer",
          "request_id",
        ]);
        // The answer command re-resolves the full member grant; the binding
        // subset is enforced with a scoped read before dispatch.
        if (!(await getAttention(deps.db, workspaceId, principal.projectIds, attentionId))) {
          return json({ error: "not_found" }, 404);
        }
        const outcome = await execute(answerAttentionCommand, requestId(record), {
          attentionId,
          expectedVersion: requiredVersion(record),
          answer: requiredString(record, "answer"),
        });
        if (!outcome.ok && outcome.error?.code === "already_answered") {
          const committed = await getAttention(
            deps.db,
            workspaceId,
            principal.projectIds,
            attentionId,
          );
          return json({ ...outcome, ...(committed ? { attention: committed } : {}) }, 409);
        }
        return outcomeResponse(outcome);
      }
      if (rest === "/resolve" && request.method === "POST") {
        const record = objectBody(await readBoundedJson(request, BODY_LIMIT), [
          "expected_version",
          "request_id",
        ]);
        if (!(await getAttention(deps.db, workspaceId, principal.projectIds, attentionId))) {
          return json({ error: "not_found" }, 404);
        }
        return outcomeResponse(
          await execute(resolveAttentionCommand, requestId(record), {
            attentionId,
            expectedVersion: requiredVersion(record),
          }),
        );
      }
    }

    if (request.method === "GET" && path === "/api/v1/cli/artifacts") {
      const runId = url.searchParams.get("run_id") ?? "";
      if (!runId) throw new DomainError("invalid_argument", "run_id is required");
      const run = (await deps.db
        .prepare(`SELECT id, project_id FROM runs WHERE workspace_id = ? AND id = ?`)
        .get(workspaceId, runId)) as { id: string; project_id: string } | undefined;
      if (!run || !principal.projectIds.includes(run.project_id)) {
        return json({ error: "not_found" }, 404);
      }
      const artifacts = (await deps.db
        .prepare(
          `SELECT id, run_id, format, role, created_at FROM artifacts
           WHERE workspace_id = ? AND run_id = ? ORDER BY created_at DESC, id DESC LIMIT 50`,
        )
        .all(workspaceId, runId)) as Array<Record<string, unknown>>;
      const versions = (await deps.db
        .prepare(
          `SELECT id, artifact_id, state, format, declared_size, content_hash, created_at, available_at
           FROM artifact_versions WHERE workspace_id = ? AND artifact_id IN (
             SELECT id FROM artifacts WHERE workspace_id = ? AND run_id = ?
           ) ORDER BY created_at DESC, id DESC LIMIT 100`,
        )
        .all(workspaceId, workspaceId, runId)) as Array<Record<string, unknown>>;
      return json({ artifacts, versions });
    }
    const artifactMatch = /^\/api\/v1\/cli\/artifacts\/([^/]+)$/.exec(path);
    if (artifactMatch && request.method === "GET") {
      const artifactId = artifactMatch[1] ?? "";
      const artifact = (await deps.db
        .prepare(
          `SELECT artifact.id, artifact.run_id, artifact.format, artifact.role, artifact.created_at,
                  run.project_id AS project_id
           FROM artifacts AS artifact LEFT JOIN runs AS run
             ON run.workspace_id = artifact.workspace_id AND run.id = artifact.run_id
           WHERE artifact.workspace_id = ? AND artifact.id = ?`,
        )
        .get(workspaceId, artifactId)) as
        | { project_id: string | null }
        | undefined;
      if (!artifact || !artifact.project_id || !principal.projectIds.includes(artifact.project_id)) {
        return json({ error: "not_found" }, 404);
      }
      const versions = (await deps.db
        .prepare(
          `SELECT id, artifact_id, state, format, declared_size, content_hash, created_at, available_at
           FROM artifact_versions WHERE workspace_id = ? AND artifact_id = ?
           ORDER BY created_at DESC, id DESC`,
        )
        .all(workspaceId, artifactId)) as Array<Record<string, unknown>>;
      const { project_id: _dropped, ...artifactView } = artifact as Record<string, unknown>;
      return json({ artifact: artifactView, versions });
    }

    return json({ error: "not_found" }, 404);
  } catch (error) {
    if (error instanceof DomainError) {
      if (error.code === "unauthenticated") return unauthenticated();
      if (error.code === "credential_confusion") return confused();
      if (error.code === "forbidden") return rejected();
      return fail(error);
    }
    return fail(error);
  }
}

/** True for paths owned by the human CLI mirror (before the public device surface). */
export function isCliHumanPath(path: string): boolean {
  return (
    path === "/api/v1/cli/version" ||
    path === "/api/v1/cli/session/revoke" ||
    path === "/api/v1/cli/projects" ||
    path.startsWith("/api/v1/cli/projects/") ||
    path === "/api/v1/cli/tasks" ||
    path.startsWith("/api/v1/cli/tasks/") ||
    path === "/api/v1/cli/runs" ||
    path.startsWith("/api/v1/cli/runs/") ||
    path === "/api/v1/cli/attention" ||
    path.startsWith("/api/v1/cli/attention/") ||
    path === "/api/v1/cli/artifacts" ||
    path.startsWith("/api/v1/cli/artifacts/")
  );
}
