// ABOUTME: Serves bounded first-owner bootstrap, invitation, role, and revocation routes.
// ABOUTME: Public capabilities are rate-limited before authentication and never stored in plaintext.

import { createHmac } from "node:crypto";

import { createAuthorizationContext, type Jurisdiction, type SqlDatabase } from "@bfb/db";
import {
  abuseBucketKey,
  acceptInvitation,
  changeMemberRoleCommand,
  completeWorkspaceBootstrapReauthentication,
  consumeAbuseBudget,
  createFirstWorkspace,
  createInvitationCommand,
  loadPrincipal,
  normalizeInvitationEmail,
  randomUlid,
  removeMemberCommand,
  startWorkspaceBootstrap,
  workspaceCapability,
  type WorkspaceIdentity,
} from "@bfb/domain";

import type { AuthKey, HumanAuth } from "../auth/better-auth.js";
import {
  assertBrowserMutation,
  resolveBrowserPrincipal,
  type BrowserPrincipal,
} from "../auth/session.js";
import { executeWorkspaceCommand } from "../hub-client.js";

const BODY_LIMIT = 16_384;
const WINDOW_SECONDS = 300;
const INVITATION_TTL_MS = 72 * 60 * 60 * 1000;
const FLOW_COOKIE = "__Host-bfb_workspace_bootstrap";
const POLICY = {
  attemptLimit: 10,
  pollLimit: 30,
  windowSeconds: WINDOW_SECONDS,
  maxBodyBytes: BODY_LIMIT,
} as const;

export interface WorkspaceAuthorizationDeps {
  db: SqlDatabase;
  auth: HumanAuth;
  authKeys: readonly AuthKey[];
  abuseSecret: string;
  appOrigin: string;
  jurisdiction: Jurisdiction;
  now: string;
  workspaceHubNs?: DurableObjectNamespace | undefined;
}

interface BoundedRequest {
  request: Request;
  bodyBytes: number;
}

function rejected(status = 403): Response {
  return Response.json({ error: "request_rejected", message: "request rejected" }, { status });
}

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

async function boundedRequest(request: Request): Promise<BoundedRequest | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > BODY_LIMIT) {
      return null;
    }
  }
  if (request.method === "GET" || request.method === "HEAD") {
    return { request, bodyBytes: 0 };
  }
  const chunks: Uint8Array[] = [];
  let bodyBytes = 0;
  const reader = request.body?.getReader();
  if (reader) {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      if (chunk.value.byteLength === 0) {
        continue;
      }
      bodyBytes += chunk.value.byteLength;
      if (bodyBytes > BODY_LIMIT) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk.value);
    }
  }
  const init: RequestInit = { method: request.method, headers: request.headers };
  if (bodyBytes > 0) {
    const body = new Uint8Array(bodyBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    init.body = body;
  }
  return { request: new Request(request.url, init), bodyBytes };
}

function routeSurface(path: string, method: string): string | null {
  if (method === "POST" && path === "/api/v1/workspace-access/bootstrap/start") {
    return "bootstrap-start";
  }
  if (method === "GET" && path === "/api/v1/workspace-access/bootstrap/reauth") {
    return "bootstrap-reauth";
  }
  if (method === "POST" && path === "/api/v1/workspace-access/bootstrap/complete") {
    return "bootstrap-complete";
  }
  if (
    method === "POST" &&
    /^\/api\/v1\/workspace-access\/workspaces\/[^/]+\/invitations$/.test(path)
  ) {
    return "invitation-create";
  }
  if (
    method === "POST" &&
    /^\/api\/v1\/workspace-access\/workspaces\/[^/]+\/invitations\/[^/]+\/accept$/.test(path)
  ) {
    return "invitation-accept";
  }
  if (
    method === "POST" &&
    /^\/api\/v1\/workspace-access\/workspaces\/[^/]+\/members\/[^/]+\/role$/.test(path)
  ) {
    return "member-role";
  }
  if (
    method === "DELETE" &&
    /^\/api\/v1\/workspace-access\/workspaces\/[^/]+\/members\/[^/]+$/.test(path)
  ) {
    return "member-remove";
  }
  return null;
}

function clientSeed(request: Request, secret: string): string {
  const ip = request.headers.get("cf-connecting-ip") ?? "unavailable";
  return createHmac("sha256", secret)
    .update(`bfb-workspace-auth-ip:${ip.slice(0, 64)}`)
    .digest("hex");
}

async function consumeBudget(
  deps: WorkspaceAuthorizationDeps,
  request: Request,
  surface: string,
  bodyBytes: number,
): Promise<boolean> {
  const now = Date.parse(deps.now);
  if (!Number.isFinite(now)) {
    return false;
  }
  const decision = await consumeAbuseBudget(
    deps.db,
    {
      bucketKey: abuseBucketKey({
        ipHashSeed: clientSeed(request, deps.abuseSecret),
        subject: surface,
        surface: "workspace-authorization",
        client: "browser",
      }),
      activity: "attempt",
      bodyBytes,
      now: deps.now,
      expiresAt: new Date(now + WINDOW_SECONDS * 1000).toISOString(),
    },
    POLICY,
  );
  return decision.allowed;
}

function capabilityHash(value: string, secret: string): string {
  return createHmac("sha256", secret).update(`bfb-workspace-capability:${value}`).digest("hex");
}

function identity(principal: BrowserPrincipal): WorkspaceIdentity {
  return {
    humanId: principal.humanId,
    authUserId: principal.authUserId,
    sessionId: principal.sessionId,
    email: principal.email,
    emailVerified: principal.emailVerified,
  };
}

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  if (!match?.[1]) {
    return null;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function flowCookie(flowId: string, capability: string): string {
  return `${FLOW_COOKIE}=${encodeURIComponent(`${flowId}.${capability}`)}; Path=/; Max-Age=600; Secure; HttpOnly; SameSite=Lax`;
}

function clearFlowCookie(): string {
  return `${FLOW_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
}

function internalAuthRequest(request: Request, appOrigin: string, body: string): Request {
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  return new Request(new URL("/auth/sign-in/social", appOrigin), {
    method: "POST",
    headers,
    redirect: "manual",
    body,
  });
}

function requireMutation(
  request: Request,
  deps: WorkspaceAuthorizationDeps,
  principal: BrowserPrincipal,
): void {
  assertBrowserMutation(request, deps.appOrigin, {
    sessionId: principal.sessionId,
    authKeys: deps.authKeys,
  });
}

function requestId(value: unknown): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 128) {
    throw new Error("request id is invalid");
  }
  return value;
}

function invitationCapability(
  deps: WorkspaceAuthorizationDeps,
  workspaceId: string,
  humanId: string,
  idempotencyKey: string,
): string {
  return createHmac("sha256", deps.abuseSecret)
    .update(`bfb-invitation:${workspaceId}:${humanId}:${idempotencyKey}`)
    .digest("base64url");
}

async function resolvePrincipal(
  request: Request,
  deps: WorkspaceAuthorizationDeps,
): Promise<BrowserPrincipal | null> {
  return resolveBrowserPrincipal(deps.db, deps.auth, request, deps.now);
}

export async function handleWorkspaceAuthorization(
  originalRequest: Request,
  deps: WorkspaceAuthorizationDeps,
): Promise<Response> {
  const url = new URL(originalRequest.url);
  const surface = routeSurface(url.pathname, originalRequest.method);
  if (!surface) {
    return json({ error: "not_found" }, 404);
  }
  const bounded = await boundedRequest(originalRequest);
  if (!bounded) {
    return rejected(429);
  }
  if (!(await consumeBudget(deps, bounded.request, surface, bounded.bodyBytes))) {
    return rejected(429);
  }

  try {
    const principal = await resolvePrincipal(bounded.request, deps);
    if (!principal) {
      return rejected();
    }

    if (surface === "bootstrap-start") {
      requireMutation(bounded.request, deps, principal);
      const completion = workspaceCapability();
      const flow = await startWorkspaceBootstrap(
        deps.db,
        identity(principal),
        deps.appOrigin,
        capabilityHash(completion, deps.abuseSecret),
        deps.now,
      );
      const upstream = await deps.auth.handler(
        internalAuthRequest(
          bounded.request,
          deps.appOrigin,
          JSON.stringify({ provider: "github", callbackURL: flow.callbackUrl }),
        ),
      );
      const payload = (await upstream.clone().json()) as { url?: string };
      if (!upstream.ok || !payload.url || payload.url.includes(completion)) {
        throw new Error("fresh GitHub reauthentication did not start");
      }
      const headers = new Headers();
      for (const cookie of upstream.headers.getSetCookie()) {
        headers.append("set-cookie", cookie);
      }
      headers.append("set-cookie", flowCookie(flow.flowId, completion));
      return json(
        { flow_id: flow.flowId, requires_reauthentication: true, url: payload.url },
        upstream.status,
        headers,
      );
    }

    if (surface === "bootstrap-reauth") {
      const flowId = url.searchParams.get("flow_id") ?? "";
      const stored = cookieValue(bounded.request, FLOW_COOKIE);
      const separator = stored?.indexOf(".") ?? -1;
      if (!stored || separator < 1 || stored.slice(0, separator) !== flowId) {
        return rejected();
      }
      await completeWorkspaceBootstrapReauthentication(
        deps.db,
        identity(principal),
        flowId,
        capabilityHash(stored.slice(separator + 1), deps.abuseSecret),
        deps.now,
      );
      return new Response(null, {
        status: 302,
        headers: {
          location: `/onboarding?workspace_bootstrap=${encodeURIComponent(flowId)}`,
          "set-cookie": clearFlowCookie(),
        },
      });
    }

    requireMutation(bounded.request, deps, principal);
    const body = (await bounded.request.json()) as Record<string, unknown>;

    if (surface === "bootstrap-complete") {
      const result = await createFirstWorkspace(
        deps.db,
        identity(principal),
        {
          flowId: typeof body.flow_id === "string" ? body.flow_id : "",
          bootstrapSecretHash: capabilityHash(
            typeof body.bootstrap_secret === "string" ? body.bootstrap_secret : "",
            deps.abuseSecret,
          ),
          slug: typeof body.slug === "string" ? body.slug : "",
          jurisdiction: deps.jurisdiction,
        },
        deps.now,
      );
      return json(result);
    }

    const invitationCreate = url.pathname.match(
      /^\/api\/v1\/workspace-access\/workspaces\/([^/]+)\/invitations$/,
    );
    if (surface === "invitation-create" && invitationCreate?.[1]) {
      const workspaceId = invitationCreate[1];
      const authz = await loadPrincipal(deps.db, workspaceId, principal.humanId);
      const idempotencyKey = requestId(body.request_id);
      const rawSecret = invitationCapability(deps, workspaceId, principal.humanId, idempotencyKey);
      if (body.role !== "member" && body.role !== "reviewer") {
        return rejected();
      }
      const outcome = await executeWorkspaceCommand(
        {
          db: deps.db,
          authorization: createAuthorizationContext({
            workspaceId,
            principalId: principal.humanId,
            authorizationEpoch: authz.authorizationEpoch,
            jurisdiction: deps.jurisdiction,
          }),
          workspaceHubNs: deps.workspaceHubNs,
        },
        createInvitationCommand,
        {
          workspaceId,
          idempotencyKey,
          authorizationEpoch: authz.authorizationEpoch,
          actorHumanId: principal.humanId,
          now: deps.now,
          input: {
            invitationId: randomUlid(),
            normalizedEmail: normalizeInvitationEmail(
              typeof body.email === "string" ? body.email : "",
            ),
            role: body.role,
            secretHash: capabilityHash(rawSecret, deps.abuseSecret),
            expiresAt: new Date(Date.parse(deps.now) + INVITATION_TTL_MS).toISOString(),
          },
        },
      );
      if (!outcome.ok) {
        return rejected();
      }
      const invitationUrl = new URL(`/join/${workspaceId}/${outcome.result.id}`, deps.appOrigin);
      invitationUrl.hash = rawSecret;
      return json({ invitation: outcome.result, invitation_url: invitationUrl.toString() });
    }

    const invitationAccept = url.pathname.match(
      /^\/api\/v1\/workspace-access\/workspaces\/([^/]+)\/invitations\/([^/]+)\/accept$/,
    );
    if (surface === "invitation-accept" && invitationAccept?.[1] && invitationAccept[2]) {
      const result = await acceptInvitation(
        deps.db,
        identity(principal),
        {
          workspaceId: invitationAccept[1],
          invitationId: invitationAccept[2],
          secretHash: capabilityHash(
            typeof body.secret === "string" ? body.secret : "",
            deps.abuseSecret,
          ),
        },
        deps.now,
      );
      return json(result);
    }

    const roleChange = url.pathname.match(
      /^\/api\/v1\/workspace-access\/workspaces\/([^/]+)\/members\/([^/]+)\/role$/,
    );
    const memberRemove = url.pathname.match(
      /^\/api\/v1\/workspace-access\/workspaces\/([^/]+)\/members\/([^/]+)$/,
    );
    const membershipMatch = roleChange ?? memberRemove;
    if (membershipMatch?.[1] && membershipMatch[2]) {
      const workspaceId = membershipMatch[1];
      const authz = await loadPrincipal(deps.db, workspaceId, principal.humanId);
      const hub = {
        db: deps.db,
        authorization: createAuthorizationContext({
          workspaceId,
          principalId: principal.humanId,
          authorizationEpoch: authz.authorizationEpoch,
          jurisdiction: deps.jurisdiction,
        }),
        workspaceHubNs: deps.workspaceHubNs,
      };
      const common = {
        workspaceId,
        idempotencyKey: requestId(body.request_id),
        authorizationEpoch: authz.authorizationEpoch,
        actorHumanId: principal.humanId,
        now: deps.now,
      };
      let outcome;
      if (surface === "member-role") {
        if (body.role !== "member" && body.role !== "reviewer") {
          return rejected();
        }
        outcome = await executeWorkspaceCommand(hub, changeMemberRoleCommand, {
          ...common,
          input: { humanId: membershipMatch[2], role: body.role },
        });
      } else {
        outcome = await executeWorkspaceCommand(hub, removeMemberCommand, {
          ...common,
          input: { humanId: membershipMatch[2] },
        });
      }
      return outcome.ok ? json(outcome) : rejected();
    }
  } catch {
    return rejected();
  }

  return json({ error: "not_found" }, 404);
}
