// ABOUTME: Serves per-user notification preferences, push endpoints, and delivery reads.
// ABOUTME: Mutations run through WorkspaceHub commands under C01 abuse budgets; reads come from D1.

import { createHash, createHmac } from "node:crypto";

import { createAuthorizationContext } from "@bfb/db";
import {
  abuseBucketKey,
  consumeAbuseBudget,
  defaultPreference,
  DomainError,
  getPreferenceOverrides,
  listDeliveries,
  listPushEndpointSummaries,
  loadPrincipal,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_WORKSPACE_SCOPE,
  registerPushEndpointCommand,
  removePushEndpointCommand,
  setNotificationPreferenceCommand,
} from "@bfb/domain";

import { executeWorkspaceCommand } from "../hub-client.js";
import { readBoundedJson } from "./request.js";
import type { WorkApiDeps } from "./work.js";
import type { BrowserPrincipal } from "../auth/session.js";

const BODY_LIMIT = 32_768;

export type NotificationApiDeps = WorkApiDeps & {
  principal: BrowserPrincipal;
  workspaceId: string;
  abuseSecret: string;
};

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

function requestId(record: Record<string, unknown>): string {
  const value = requiredString(record, "request_id");
  if (value.length < 8 || value.length > 128) {
    throw new DomainError("invalid_argument", "request_id is invalid");
  }
  return value;
}

async function browserBudget(request: Request, deps: NotificationApiDeps): Promise<void> {
  if (deps.abuseSecret.length < 32) {
    throw new DomainError("request_rejected", "request rejected");
  }
  const policy = {
    attemptLimit: 20,
    pollLimit: 60,
    windowSeconds: 60,
    maxBodyBytes: BODY_LIMIT,
  };
  for (const [subject, source] of [
    ["all", `notification-ip:${request.headers.get("cf-connecting-ip") ?? "unknown"}`],
    [deps.principal.humanId, "notification-human"],
  ]) {
    const decision = await consumeAbuseBudget(
      deps.db,
      {
        bucketKey: abuseBucketKey({
          ipHashSeed: createHmac("sha256", deps.abuseSecret).update(source!).digest("hex"),
          subject: subject!,
          surface: "notification-browser",
        }),
        activity: request.method === "GET" ? "poll" : "attempt",
        bodyBytes: 0,
        now: deps.now,
        expiresAt: new Date(Date.parse(deps.now) + 60_000).toISOString(),
      },
      policy,
    );
    if (!decision.allowed) {
      throw new DomainError("request_rejected", "request rejected");
    }
  }
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

/** The mounted browser router has already checked the human session, origin and CSRF token. */
export async function handleNotificationApi(
  request: Request,
  deps: NotificationApiDeps,
): Promise<Response> {
  const url = new URL(request.url);
  const base = `/api/v1/workspaces/${deps.workspaceId}`;
  await browserBudget(request, deps);
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

  if (request.method === "GET" && url.pathname === `${base}/notifications/preferences`) {
    const defaults: Record<string, Record<string, boolean>> = {};
    for (const category of NOTIFICATION_CATEGORIES) {
      defaults[category] = {};
      for (const channel of NOTIFICATION_CHANNELS) {
        defaults[category]![channel] = defaultPreference(category);
      }
    }
    return json({
      overrides: await getPreferenceOverrides(deps.db, deps.workspaceId, deps.principal.humanId),
      defaults,
      workspace_scope: NOTIFICATION_WORKSPACE_SCOPE,
      endpoints: await listPushEndpointSummaries(deps.db, deps.workspaceId, deps.principal.humanId),
    });
  }

  if (request.method === "GET" && url.pathname === `${base}/notifications/deliveries`) {
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? 50 : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new DomainError("invalid_argument", "limit is invalid");
    }
    return json({
      deliveries: await listDeliveries(deps.db, deps.workspaceId, deps.principal.humanId, limit),
    });
  }

  if (request.method === "PUT" && url.pathname === `${base}/notifications/preferences`) {
    const body = objectBody(await readBoundedJson(request, BODY_LIMIT), [
      "request_id",
      "preferences",
    ]);
    const key = requestId(body);
    if (!Array.isArray(body.preferences) || body.preferences.length > 100) {
      throw new DomainError("invalid_argument", "preferences batch is invalid");
    }
    const results = [];
    let index = 0;
    for (const entry of body.preferences) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new DomainError("invalid_argument", "preference entry is invalid");
      }
      const item = entry as Record<string, unknown>;
      const itemKeys = new Set(["project_id", "channel", "category", "enabled"]);
      if (Object.keys(item).some((field) => !itemKeys.has(field))) {
        throw new DomainError("invalid_argument", "preference entry is invalid");
      }
      const itemKey = `${key}:${index}`;
      index += 1;
      results.push(
        await execute(
          setNotificationPreferenceCommand,
          createHash("sha256").update(itemKey, "utf8").digest("hex").slice(0, 32),
          {
            projectId:
              item.project_id === undefined || item.project_id === NOTIFICATION_WORKSPACE_SCOPE
                ? undefined
                : String(item.project_id),
            channel: item.channel as "browser_push" | "macos",
            category: item.category as (typeof NOTIFICATION_CATEGORIES)[number],
            enabled: item.enabled as boolean,
          },
        ),
      );
    }
    return json({ results });
  }

  if (request.method === "POST" && url.pathname === `${base}/notifications/push-endpoints`) {
    const body = objectBody(await readBoundedJson(request, BODY_LIMIT), [
      "request_id",
      "endpoint",
      "p256dh",
      "auth",
    ]);
    const key = requestId(body);
    return outcomeResponse(
      await execute(registerPushEndpointCommand, key, {
        endpoint: body.endpoint as string,
        p256dh: body.p256dh as string,
        auth: body.auth as string,
      }),
    );
  }

  const removeMatch = new RegExp(`^${base}/notifications/push-endpoints/([0-9a-f]{64})$`).exec(
    url.pathname,
  );
  if (request.method === "DELETE" && removeMatch?.[1]) {
    const body = objectBody(await readBoundedJson(request, BODY_LIMIT), ["request_id"]);
    const key = requestId(body);
    return outcomeResponse(
      await execute(removePushEndpointCommand, key, { endpointHash: removeMatch[1] }),
    );
  }

  return json({ error: "not_found", message: "unknown notification route" }, 404);
}
