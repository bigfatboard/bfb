// ABOUTME: Serves ranked cross-project attention reads and human answer/resolution APIs.
// ABOUTME: Mutations run through WorkspaceHub commands; reads come directly from committed D1 rows.

import { createAuthorizationContext } from "@bfb/db";
import {
  answerAttentionCommand,
  DomainError,
  getAttention,
  listAttention,
  listAttentionObservations,
  loadPrincipal,
  resolveAttentionCommand,
  type AttentionState,
} from "@bfb/domain";

import { executeWorkspaceCommand } from "../hub-client.js";
import { readBoundedJson } from "./request.js";
import type { WorkApiDeps } from "./work.js";

const BODY_LIMIT = 32_768;

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

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value) {
    throw new DomainError("invalid_argument", `${key} is required`);
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
        : code === "stale_version" || code === "already_exists" || code === "already_answered"
          ? 409
          : 400;
  return json(outcome, status);
}

export async function handleAttentionApi(request: Request, deps: WorkApiDeps): Promise<Response> {
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

  if (path === `${base}/attention` && request.method === "GET") {
    const rawState = url.searchParams.get("state");
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? undefined : Number(rawLimit);
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
      throw new DomainError("invalid_argument", "limit is invalid");
    }
    if (rawState !== null && !["open", "answered", "resolved"].includes(rawState)) {
      throw new DomainError("invalid_argument", "attention state filter is invalid");
    }
    return json({
      attention: await listAttention(deps.db, deps.workspaceId, principal.projectIds, {
        ...(rawState === null ? {} : { state: rawState as AttentionState }),
        ...(limit === undefined ? {} : { limit }),
      }),
    });
  }

  const match = path.match(new RegExp(`^${base}/attention/([^/]+)(.*)$`));
  if (!match) {
    return json({ error: "not_found" }, 404);
  }
  const attentionId = match[1] ?? "";
  const rest = match[2] ?? "";
  if (rest === "" && request.method === "GET") {
    const attention = await getAttention(
      deps.db,
      deps.workspaceId,
      principal.projectIds,
      attentionId,
    );
    if (!attention) {
      return json({ error: "not_found" }, 404);
    }
    return json({
      attention,
      observations: await listAttentionObservations(
        deps.db,
        deps.workspaceId,
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
    const outcome = await execute(answerAttentionCommand, requestId(record), {
      attentionId,
      expectedVersion: requiredVersion(record),
      answer: requiredString(record, "answer"),
    });
    if (!outcome.ok && outcome.error?.code === "already_answered") {
      const committed = await getAttention(
        deps.db,
        deps.workspaceId,
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
    return outcomeResponse(
      await execute(resolveAttentionCommand, requestId(record), {
        attentionId,
        expectedVersion: requiredVersion(record),
      }),
    );
  }
  return json({ error: "not_found" }, 404);
}
