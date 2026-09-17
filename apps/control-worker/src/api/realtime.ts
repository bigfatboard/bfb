// ABOUTME: Authenticates browser realtime upgrades with cookie sessions and forwards them to the hub.
// ABOUTME: Only IDs, epochs, and expiry cross into the socket handshake; cookies and tokens never do.

import { createAuthorizationContext, WorkspaceRepository } from "@bfb/db";
import {
  assertLedgerBrowserAccess,
  loadPrincipal,
  runnerId,
} from "@bfb/domain";

import type { HumanAuth } from "../auth/better-auth.js";
import { resolveBrowserPrincipal, type BrowserPrincipal } from "../auth/session.js";
import { workspaceNamespaceForJurisdiction } from "../env.js";
import { BROWSER_REALTIME_PROTOCOL } from "../realtime/browser-sockets.js";
import type { RunnerApiDeps } from "./runners.js";

export interface BrowserRealtimeDeps extends RunnerApiDeps {
  principal: BrowserPrincipal;
  workspaceId: string;
  auth: HumanAuth;
}

const subscribePattern = /^\/realtime\/workspaces\/([^/]+)\/subscribe$/;

export function isBrowserRealtimePath(path: string): boolean {
  return subscribePattern.test(path);
}

function failure(status: number, error: string): Response {
  return Response.json(
    { error, message: error.replaceAll("_", " ") },
    { status, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } },
  );
}

async function hubStub(
  deps: BrowserRealtimeDeps,
  workspaceId: string,
  authorizationEpoch: number,
): Promise<DurableObjectStub> {
  if (!deps.workspaceHubNs) throw new Error("hub binding unavailable");
  const workspace = await WorkspaceRepository.forAuthorization(
    deps.db,
    createAuthorizationContext({
      workspaceId,
      principalId: deps.principal.humanId,
      authorizationEpoch,
      jurisdiction: deps.jurisdiction,
    }),
  ).getWorkspace();
  if (!workspace || workspace.jurisdiction !== deps.jurisdiction) throw new Error("unknown workspace");
  const namespace = workspaceNamespaceForJurisdiction(deps.workspaceHubNs, workspace.jurisdiction);
  return namespace.get(namespace.idFromName(workspace.id));
}

export async function handleBrowserRealtimeApi(
  request: Request,
  deps: BrowserRealtimeDeps,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const match = subscribePattern.exec(url.pathname);
    if (!match?.[1] || url.search) return failure(400, "request_rejected");
    if (request.headers.get("authorization")) {
      return failure(401, "credential_confusion");
    }
    const workspaceId = runnerId(match[1]);
    if (workspaceId !== runnerId(deps.workspaceId)) return failure(404, "not_found");
    if (request.method !== "GET") return failure(400, "request_rejected");
    if (
      request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
      request.headers.get("sec-websocket-protocol") !== BROWSER_REALTIME_PROTOCOL
    ) {
      return failure(400, "request_rejected");
    }
    const resolved = await resolveBrowserPrincipal(deps.db, deps.auth, request, deps.now);
    if (!resolved || resolved.humanId !== deps.principal.humanId) {
      return failure(401, "unauthenticated");
    }
    const session = (await deps.db
      .prepare(
        `SELECT session.expires_at AS expires_at
         FROM better_auth_sessions AS session
         JOIN humans AS human ON human.better_auth_user_id = session.user_id
         WHERE session.id = ? AND human.id = ?`,
      )
      .get(resolved.sessionId, resolved.humanId)) as { expires_at: string } | undefined;
    if (!session || !Number.isFinite(Date.parse(session.expires_at))) {
      return failure(401, "unauthenticated");
    }
    if (Date.parse(session.expires_at) <= Date.parse(deps.now)) {
      return failure(401, "session_expired");
    }
    const principal = await loadPrincipal(deps.db, workspaceId, resolved.humanId);
    await assertLedgerBrowserAccess(deps.db, workspaceId, resolved.humanId, principal.authorizationEpoch);
    const stub = await hubStub(deps, workspaceId, principal.authorizationEpoch);
    return stub.fetch("https://bfb-hub.internal/browser/connect", {
      method: "GET",
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": BROWSER_REALTIME_PROTOCOL,
        "x-bfb-browser-principal": JSON.stringify({
          schema_version: 1,
          workspaceId,
          humanId: resolved.humanId,
          authorizationEpoch: principal.authorizationEpoch,
          role: principal.role,
          sessionId: resolved.sessionId,
          sessionExpiresAt: session.expires_at,
        }),
      },
    });
  } catch {
    return failure(403, "request_rejected");
  }
}
