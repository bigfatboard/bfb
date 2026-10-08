// ABOUTME: Serves the X02 human CLI mirror over bearer CLI credentials only.
// ABOUTME: Reads and guarded writes reuse domain commands; this file owns no domain mutation.

import { createHmac } from "node:crypto";

import { createAuthorizationContext, type SqlDatabase } from "@bfb/db";
import {
  answerAttentionCommand,
  cancelRunCommand,
  cliHash,
  cliPublicAuthority,
  readCliProjects,
  readCliProject,
  readCliTasks,
  readCliTask,
  readCliRuns,
  readCliRun,
  readCliAttention,
  readCliAttentionDetail,
  readCliArtifacts,
  readCliArtifact,
  consumeCliBudget,
  consumeStepUpProof,
  createTaskCommand,
  DomainError,
  getAttention,
  isUlid,
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
import { executePublicWorkspaceCommand as executeWorkspaceCommand } from "../public-command-outcome.js";
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
  abuseSecret: string;
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

function cliSeeds(
  abuseSecret: string,
  request: Request,
): { ipSeed: string; subjectSeed: string } | null {
  if (typeof abuseSecret !== "string" || abuseSecret.length < 32) return null;
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  return {
    ipSeed: createHmac("sha256", abuseSecret)
      .update(`cli-ip:${ip.slice(0, 64)}`)
      .digest("hex"),
    subjectSeed: createHmac("sha256", abuseSecret).update("cli-subject").digest("hex"),
  };
}

/**
 * Consumes the bearer-auth budget for one presented credential before it
 * costs a D1 lookup. The subject carries only the credential hash, so failed
 * probes consume the same per-IP and per-credential budgets as successful
 * resolutions; exhaustion rejects uniformly without an oracle.
 */
async function consumeBearerBudget(
  deps: Pick<CliHumanDeps, "db" | "now" | "abuseSecret">,
  request: Request,
  bearer: string,
): Promise<boolean> {
  const seeds = cliSeeds(deps.abuseSecret, request);
  if (!seeds) return false;
  return consumeCliBudget(deps.db, {
    ...seeds,
    surface: "cli:bearer-auth",
    subject: `bearer-auth:${cliHash(bearer)}`,
    activity: "poll",
    now: deps.now,
  });
}

/** Resolves the bearer human credential; cookies and browser origins never authenticate here. */
async function authenticate(
  request: Request,
  deps: Pick<CliHumanDeps, "db" | "now" | "abuseSecret">,
): Promise<CliPrincipal> {
  if (request.headers.has("cookie") || request.headers.has("origin")) {
    throw new DomainError("credential_confusion", "CLI routes accept bearer CLI credentials only");
  }
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9._~-]{1,512})$/.exec(authorization);
  if (!match?.[1]) {
    throw new DomainError("unauthenticated", "CLI credential required");
  }
  if (!(await consumeBearerBudget(deps, request, match[1]))) {
    throw new DomainError("forbidden", "request rejected");
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

export async function handleCliHumanApi(request: Request, deps: CliHumanDeps): Promise<Response> {
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
    const publicAuthority = cliPublicAuthority(cli);
    const current = await loadPrincipal(deps.db, workspaceId, cli.humanId);
    // The binding narrows project scope: every downstream read and command
    // observes the intersection, never the member's full grant.
    const principal = {
      ...current,
      authorizationEpoch: cli.authorizationEpoch,
      projectIds: current.projectIds.filter((id) => cli.projectIds.includes(id)),
    };
    const hubDeps = {
      db: deps.db,
      publicAuthority,
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

    if (request.method === "GET") {
      if (path === "/api/v1/cli/projects")
        return json(await readCliProjects(deps.db, publicAuthority, page(url)));
      if (path === "/api/v1/cli/tasks")
        return json(await readCliTasks(deps.db, publicAuthority, page(url)));
      if (path === "/api/v1/cli/runs") {
        const taskId = url.searchParams.get("task_id");
        if (!taskId) throw new DomainError("invalid_argument", "task_id is required");
        return json(await readCliRuns(deps.db, publicAuthority, taskId, page(url)));
      }
      if (path === "/api/v1/cli/attention") {
        const state = url.searchParams.get("state");
        if (state !== null && !["open", "answered", "resolved"].includes(state))
          throw new DomainError("invalid_argument", "attention state filter is invalid");
        return json(
          await readCliAttention(deps.db, publicAuthority, {
            ...page(url),
            ...(state === null ? {} : { state: state as AttentionState }),
          }),
        );
      }
      if (path === "/api/v1/cli/artifacts") {
        const runId = url.searchParams.get("run_id");
        if (!runId) throw new DomainError("invalid_argument", "run_id is required");
        return json(await readCliArtifacts(deps.db, publicAuthority, runId));
      }
      const detail = /^\/api\/v1\/cli\/(projects|tasks|runs|attention|artifacts)\/([^/]+)$/.exec(
        path,
      );
      if (detail) {
        const readers = {
          projects: readCliProject,
          tasks: readCliTask,
          runs: readCliRun,
          attention: readCliAttentionDetail,
          artifacts: readCliArtifact,
        };
        return json(
          await readers[detail[1] as keyof typeof readers](deps.db, publicAuthority, detail[2]!),
        );
      }
    }

    if (request.method === "POST" && path === "/api/v1/cli/session/revoke") {
      const outcome = await execute(revokeBindingCommand, `cli-revoke-${cli.bindingId}`, {
        bindingId: cli.bindingId,
      });
      return outcomeResponse(outcome);
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
    const runMatch = /^\/api\/v1\/cli\/runs\/([^/]+)(\/.*)?$/.exec(path);
    if (runMatch) {
      const runId = runMatch[1] ?? "";
      const rest = runMatch[2] ?? "";
      await readCliRun(deps.db, publicAuthority, runId);
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

    const attentionMatch = /^\/api\/v1\/cli\/attention\/([^/]+)(\/.*)?$/.exec(path);
    if (attentionMatch) {
      const attentionId = attentionMatch[1] ?? "";
      const rest = attentionMatch[2] ?? "";
      if (rest === "/answer" && request.method === "POST") {
        const record = objectBody(await readBoundedJson(request, BODY_LIMIT), [
          "expected_version",
          "answer",
          "request_id",
        ]);
        // The answer command re-resolves the full member grant; the binding
        // subset is enforced with a scoped read before dispatch.
        if (
          !(await getAttention(deps.db, workspaceId, principal.projectIds, attentionId, principal))
        ) {
          return json({ error: "not_found" }, 404);
        }
        const outcome = await execute(answerAttentionCommand, requestId(record), {
          attentionId,
          expectedVersion: requiredVersion(record),
          answer: requiredString(record, "answer"),
        });
        if (!outcome.ok && outcome.error?.code === "already_answered") {
          const committed = await readCliAttentionDetail(deps.db, publicAuthority, attentionId);
          return json({ ...outcome, attention: committed.attention }, 409);
        }
        return outcomeResponse(outcome);
      }
      if (rest === "/resolve" && request.method === "POST") {
        const record = objectBody(await readBoundedJson(request, BODY_LIMIT), [
          "expected_version",
          "request_id",
        ]);
        if (
          !(await getAttention(deps.db, workspaceId, principal.projectIds, attentionId, principal))
        ) {
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

    return json({ error: "not_found" }, 404);
  } catch (error) {
    if (error instanceof DomainError) {
      if (error.code === "not_found") return json({ error: "not_found" }, 404);
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
