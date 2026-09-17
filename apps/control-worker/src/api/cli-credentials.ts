// ABOUTME: Serves browser-approved CLI device bootstrap and the single credential exchange.
// ABOUTME: Durable abuse counters use hashed codes; raw credentials never enter logs or D1.

import { createHmac } from "node:crypto";

import { createAuthorizationContext, type Jurisdiction, type SqlDatabase } from "@bfb/db";
import {
  authorizeDeviceCommand,
  CLI_BODY_LIMIT,
  CLI_CLIENT_ID,
  cliHash,
  cliKeyPrefix,
  CLI_EXCHANGE_ISSUER_ID,
  consumeCliBudget,
  DomainError,
  exchangeCredentialCommand,
  loadPrincipal,
  mintCliKey,
  randomUlid,
  resolveCliPrincipal,
  revokeBindingCommand,
  type CommandRequest,
  type HubCommand,
} from "@bfb/domain";

import type { HumanAuth } from "../auth/better-auth.js";
import type { BrowserPrincipal } from "../auth/session.js";
import { executeWorkspaceCommand } from "../hub-client.js";
import { readBoundedJson } from "./request.js";

export interface CliApiDeps {
  db: SqlDatabase;
  auth: HumanAuth;
  now: string;
  jurisdiction: Jurisdiction;
  appOrigin: string;
  abuseSecret: string;
  workspaceHubNs?: DurableObjectNamespace | undefined;
}

function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", pragma: "no-cache", "referrer-policy": "no-referrer" },
  });
}

function rejected(): Response {
  return response({ error: "request_rejected", message: "request rejected" }, 403);
}

function rejectUnauthenticated(): Response {
  return response({ error: "unauthenticated", message: "CLI credential required" }, 401);
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

async function consumeBudget(
  deps: CliApiDeps,
  request: Request,
  surface: string,
  subject: string,
  activity: "attempt" | "poll",
): Promise<boolean> {
  const seeds = cliSeeds(deps.abuseSecret, request);
  if (!seeds) return false;
  return consumeCliBudget(deps.db, { ...seeds, surface, subject, activity, now: deps.now });
}

async function executeCliCommand<TInput, TResult>(
  deps: CliApiDeps,
  command: HubCommand<TInput, TResult>,
  request: CommandRequest<TInput>,
): Promise<TResult> {
  const outcome = await executeWorkspaceCommand(
    {
      db: deps.db,
      workspaceHubNs: deps.workspaceHubNs,
      authorization: createAuthorizationContext({
        workspaceId: request.workspaceId,
        principalId:
          request.actorHumanId ?? request.actorRunnerId ?? request.actorSystemId ?? "missing",
        authorizationEpoch: request.authorizationEpoch,
        jurisdiction: deps.jurisdiction,
      }),
    },
    command,
    request,
  );
  if (!outcome.ok || outcome.replayed) throw new DomainError("request_rejected", "rejected");
  return outcome.result;
}

function pluginRequest(request: Request, appOrigin: string, path: string, body?: string): Request {
  const headers = new Headers();
  const cookie = request.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  if (body !== undefined) headers.set("content-type", "application/json");
  const init: RequestInit = {
    method: body === undefined && request.method === "GET" ? "GET" : "POST",
    headers,
    redirect: "manual",
  };
  if (body !== undefined) init.body = body;
  return new Request(new URL(path, appOrigin), init);
}

/** Forwards an approved browser decision to the device plugin after the binding commits. */
export async function approvePluginDeviceCode(
  deps: CliApiDeps,
  request: Request,
  userCode: string,
): Promise<boolean> {
  const approved = await deps.auth.handler(
    pluginRequest(request, deps.appOrigin, "/auth/device/approve", JSON.stringify({ userCode })),
  );
  return approved.ok;
}

/** Binds the device code to the browser session user without changing BFB state. */
export async function claimPluginDeviceCode(
  deps: CliApiDeps,
  request: Request,
  userCode: string,
): Promise<boolean> {
  const claimed = await deps.auth.handler(
    pluginRequest(
      request,
      deps.appOrigin,
      `/auth/device?user_code=${encodeURIComponent(userCode)}`,
    ),
  );
  return claimed.ok;
}

/** Called only after browser session and CSRF validation by the shared browser router. */
export async function handleCliBrowserApi(
  request: Request,
  deps: CliApiDeps & { principal: BrowserPrincipal; workspaceId: string },
): Promise<Response> {
  try {
    const path = new URL(request.url).pathname;
    const prefix = `/api/v1/workspaces/${deps.workspaceId}/cli`;
    if (!path.startsWith(prefix)) return rejected();
    const principal = await loadPrincipal(deps.db, deps.workspaceId, deps.principal.humanId);
    const common = {
      workspaceId: deps.workspaceId,
      actorHumanId: principal.humanId,
      authorizationEpoch: principal.authorizationEpoch,
      now: deps.now,
      idempotencyKey: randomUlid(),
    };
    if (request.method === "POST" && path === `${prefix}/authorize`) {
      const body = (await readBoundedJson(request, CLI_BODY_LIMIT)) as Record<string, unknown>;
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        typeof body.user_code !== "string" ||
        (body.project_ids !== undefined && !Array.isArray(body.project_ids))
      )
        return rejected();
      const userCode = body.user_code as string;
      if (
        !(await consumeBudget(
          deps,
          request,
          "cli:device-approve",
          `approve:${cliHash(userCode)}`,
          "attempt",
        ))
      )
        return rejected();
      if (!(await claimPluginDeviceCode(deps, request, userCode))) return rejected();
      let created;
      try {
        created = await executeCliCommand(deps, authorizeDeviceCommand, {
          ...common,
          input: {
            userCode,
            projectIds: (body.project_ids ?? []) as string[],
          },
        });
      } catch {
        return rejected();
      }
      if (!(await approvePluginDeviceCode(deps, request, userCode))) {
        try {
          await executeCliCommand(deps, revokeBindingCommand, {
            ...common,
            idempotencyKey: randomUlid(),
            input: { bindingId: created.binding_id },
          });
        } catch {
          // The binding remains pending without an approved device code, so no
          // credential can be exchanged for it; revocation is retried by the human.
        }
        return rejected();
      }
      return response(
        {
          binding: {
            binding_id: created.binding_id,
            workspace_id: deps.workspaceId,
            scopes: created.scopes,
            project_ids: created.project_ids,
            authorization_epoch: created.authorization_epoch,
            status: created.status,
            expires_at: created.expires_at,
          },
        },
        201,
      );
    }
    const revoke = /^\/api\/v1\/workspaces\/[^/]+\/cli\/bindings\/([^/]+)\/revoke$/.exec(path);
    if (request.method === "POST" && revoke?.[1]) {
      await readBoundedJson(request, CLI_BODY_LIMIT).catch(() => ({}));
      if (
        !(await consumeBudget(
          deps,
          request,
          "cli:binding-revoke",
          `revoke:${deps.principal.humanId}`,
          "attempt",
        ))
      )
        return rejected();
      const result = await executeCliCommand(deps, revokeBindingCommand, {
        ...common,
        input: { bindingId: revoke[1] },
      });
      return response({
        binding: {
          binding_id: result.binding_id,
          workspace_id: deps.workspaceId,
          status: result.status,
          revoked_at: result.revoked_at,
        },
      });
    }
    return rejected();
  } catch {
    return rejected();
  }
}

async function workspaceForDeviceCode(db: SqlDatabase, deviceCode: string): Promise<string | null> {
  const row = (await db
    .prepare(
      `SELECT workspace_id FROM api_key_bindings
       WHERE device_code_hash = ? AND revoked_at IS NULL AND key_hash IS NULL`,
    )
    .get(cliHash(deviceCode))) as { workspace_id: string } | undefined;
  return row?.workspace_id ?? null;
}

/** Public CLI surface: no cookies, no browser Origin; device codes are the only proof. */
export async function handleCliPublicApi(request: Request, deps: CliApiDeps): Promise<Response> {
  try {
    if (
      request.headers.has("cookie") ||
      request.headers.has("origin") ||
      new URL(request.url).search
    ) {
      return rejectUnauthenticated();
    }
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/api/v1/cli/exchange") {
      const body = (await readBoundedJson(request, CLI_BODY_LIMIT)) as Record<string, unknown>;
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => !["client_id", "device_code"].includes(key)) ||
        body.client_id !== CLI_CLIENT_ID ||
        typeof body.device_code !== "string"
      )
        return rejected();
      const deviceCode = body.device_code;
      if (
        !(await consumeBudget(
          deps,
          request,
          "cli:credential-exchange",
          `exchange:${cliHash(deviceCode)}`,
          "poll",
        ))
      )
        return rejected();
      const workspaceId = await workspaceForDeviceCode(deps.db, deviceCode);
      if (!workspaceId) return rejected();
      const minted = mintCliKey();
      const result = await executeCliCommand(deps, exchangeCredentialCommand, {
        workspaceId,
        actorSystemId: CLI_EXCHANGE_ISSUER_ID,
        authorizationEpoch: 1,
        now: deps.now,
        idempotencyKey: randomUlid(),
        input: {
          deviceCode,
          clientId: CLI_CLIENT_ID,
          keyHash: minted.keyHash,
          keyPrefix: minted.keyPrefix,
        },
      });
      return response({
        credential: minted.key,
        binding_id: result.binding_id,
        workspace_id: result.workspace_id,
        key_prefix: result.key_prefix,
        scopes: result.scopes,
        expires_at: result.expires_at,
      });
    }
    if (request.method === "GET" && path === "/api/v1/cli/session") {
      const authorization = request.headers.get("authorization") ?? "";
      const match = /^Bearer ([A-Za-z0-9._~-]{1,512})$/.exec(authorization);
      if (!match?.[1]) return rejectUnauthenticated();
      let principal;
      try {
        principal = await resolveCliPrincipal(deps.db, match[1], deps.now);
      } catch (error) {
        if (error instanceof DomainError && error.code === "forbidden") return rejected();
        return rejectUnauthenticated();
      }
      if (
        !(await consumeBudget(
          deps,
          request,
          "cli:credential-session",
          `session:${principal.bindingId}`,
          "poll",
        ))
      )
        return rejected();
      return response({
        human_id: principal.humanId,
        workspace_id: principal.workspaceId,
        binding_id: principal.bindingId,
        key_prefix: cliKeyPrefix(match[1]),
        scopes: principal.scopes,
        project_ids: principal.projectIds,
        authorization_epoch: principal.authorizationEpoch,
        expires_at: principal.expiresAt,
      });
    }
    return rejected();
  } catch {
    return rejected();
  }
}
